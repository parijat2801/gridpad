// Reproducer for harness "eager-band interactive UX regressions ›
// dragging a rect up inside its band clamps at band top edge"
// (e2e/harness.spec.ts:4207, the last open Group C failure).
//
// Fixture: SIDE_BY_SIDE_C — two rects (A, B) sitting side-by-side in a
// single band. The harness clicks A, drags it UP by ~200px, then asserts:
//   1. A's absolute y must NOT have moved above the band's top edge
//      (aAfter.y >= before.y - 1).
//   2. The doc text is unchanged (no claim-line changes from in-band motion).
//
// Hypothesis (DEBUG_PLAN.md:55-58):
//   - clampBandMoveDelta clamps the BAND, not the rect — rect motion uses
//     bandRow/bandCol math in DemoV2.tsx:680-689.
//   - At gridRow=0 inside the band, minDRow = -bandRow = 0, so clampedDRow
//     for an upward dRow becomes 0 — no rect motion.
//   - residualDRow = dRow - 0 = full upward delta.
//   - shouldEscalateResidual with bandSiblings === 2 returns false (Bug C
//     guard already exists for multi-child bands), so residual is silently
//     dropped.
//
// Therefore: if my model matches reality, a single-tick model-layer replay
// should produce zero motion. If the test fails for a different reason
// (missing immediate-parent counting, escalation when it shouldn't),
// the diag dump will reveal it.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { StateEffect, type EditorState } from "@codemirror/state";
import {
  createEditorStateUnified,
  getFrames,
  getDoc,
  moveFrameEffect,
  selectFrameEffect,
  findContainingBandDeep,
  getBandRelativeRow,
  getBandRelativeCol,
  findFrameInList,
  findImmediateParent,
  shouldEscalateResidual,
  resolveSelectionTarget,
} from "./editorState";
import type { Frame } from "./frame";
import { serializeUnified } from "./serializeUnified";

const CW = 9.6;
const CH = 18.4;

// Exact input from e2e/harness.spec.ts:4211.
const SIDE_BY_SIDE_C =
  "Above\n\n┌──┐  ┌──┐\n│A │  │B │\n└──┘  └──┘\n\nBelow";

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "", fillStyle: "", textBaseline: "", fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * CW,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      })) as unknown as HTMLCanvasElement["getContext"];
    }
    return el;
  });
});

function findAllLeafRects(frames: Frame[]): Frame[] {
  const out: Frame[] = [];
  const walk = (fs: Frame[]) => {
    for (const f of fs) {
      if (!f.isBand && f.content !== null && f.content.type === "rect") out.push(f);
      walk(f.children);
    }
  };
  walk(frames);
  return out;
}

function absRect(frames: Frame[], leafId: string):
  { x: number; y: number; w: number; h: number; gridRow: number; gridCol: number } | null {
  const walk = (fs: Frame[], offX: number, offY: number, offGridRow: number, offGridCol: number):
    { x: number; y: number; w: number; h: number; gridRow: number; gridCol: number } | null => {
    for (const f of fs) {
      if (f.id === leafId) {
        return {
          x: f.x + offX, y: f.y + offY, w: f.w, h: f.h,
          gridRow: f.gridRow + offGridRow, gridCol: f.gridCol + offGridCol,
        };
      }
      const r = walk(f.children, offX + f.x, offY + f.y, offGridRow + f.gridRow, offGridCol + f.gridCol);
      if (r) return r;
    }
    return null;
  };
  return walk(frames, 0, 0, 0, 0);
}

/** One-tick model-layer replay of dragSelected(dx, dy). Mirrors DemoV2.tsx
 *  per-tick onMouseMove (lines 652-718). One tick is enough; the per-tick
 *  math is linear in delta. Skips the mouseup reparent decision because
 *  the test asserts in-band motion only. */
function simulateDragSelected(
  state0: EditorState,
  leafId: string,
  dx: number,
  dy: number,
): EditorState {
  let state = state0.update({ effects: selectFrameEffect.of(leafId) }).state;
  const frames0 = getFrames(state);
  const leaf0 = findFrameInList(frames0, leafId);
  if (!leaf0) throw new Error(`leaf ${leafId} not found`);
  const abs0 = absRect(frames0, leafId)!;
  const startFrameX = abs0.x;
  const startFrameY = abs0.y;

  const targetCol = Math.round(Math.max(0, startFrameX + dx) / CW);
  const targetRow = Math.round(Math.max(0, startFrameY + dy) / CH);
  const currentCol = Math.round(abs0.x / CW);
  const currentRow = Math.round(abs0.y / CH);
  const dCol = targetCol - currentCol;
  const dRow = targetRow - currentRow;

  console.log(`[DIAG] dx=${dx} dy=${dy} startX=${startFrameX} startY=${startFrameY} dCol=${dCol} dRow=${dRow}`);

  if (dCol === 0 && dRow === 0) return state;
  const containingBand = findContainingBandDeep(getFrames(state), leafId);
  console.log(`[DIAG] containingBand: ${containingBand?.id ?? "<null>"} gridRow=${containingBand?.gridRow} gridH=${containingBand?.gridH}`);

  const effects: StateEffect<unknown>[] = [];
  if (containingBand) {
    const child = leaf0;
    const bandRow = getBandRelativeRow(leafId, containingBand.id, getFrames(state));
    const bandCol = getBandRelativeCol(leafId, containingBand.id, getFrames(state));
    const minDRow = -bandRow;
    const maxDRow = containingBand.gridH - child.gridH - bandRow;
    const minDCol = -bandCol;
    const maxDCol = containingBand.gridW - child.gridW - bandCol;
    const clampedDRow = Math.max(minDRow, Math.min(maxDRow, dRow));
    const clampedDCol = Math.max(minDCol, Math.min(maxDCol, dCol));
    const residualDRow = dRow - clampedDRow;
    console.log(`[DIAG] bandRow=${bandRow} bandCol=${bandCol} minDRow=${minDRow} maxDRow=${maxDRow}`);
    console.log(`[DIAG] clampedDRow=${clampedDRow} clampedDCol=${clampedDCol} residualDRow=${residualDRow}`);
    if (clampedDRow !== 0 || clampedDCol !== 0) {
      effects.push(moveFrameEffect.of({ id: leafId, dCol: clampedDCol, dRow: clampedDRow, charWidth: CW, charHeight: CH }));
    }
    const bandSlackRows = containingBand.gridH - child.gridH;
    const dragParent = findImmediateParent(getFrames(state), leafId);
    const bandSiblings = dragParent
      ? dragParent.children.filter(c => c.content?.type !== "text").length
      : 1;
    const gestureHadClampedMotion = clampedDRow !== 0;
    const escalate = shouldEscalateResidual(clampedDRow, residualDRow, gestureHadClampedMotion, bandSlackRows, bandSiblings);
    console.log(`[DIAG] bandSlackRows=${bandSlackRows} bandSiblings=${bandSiblings} dragParent=${dragParent?.id} dragParent.isBand=${dragParent?.isBand} dragParent.content=${dragParent?.content?.type ?? "null"} escalate=${escalate}`);
    if (escalate) {
      effects.push(moveFrameEffect.of({ id: containingBand.id, dCol: 0, dRow: residualDRow, charWidth: CW, charHeight: CH }));
    }
  } else {
    console.log(`[DIAG] no containing band — fallback move`);
    effects.push(moveFrameEffect.of({ id: leafId, dCol, dRow, charWidth: CW, charHeight: CH }));
  }
  if (effects.length > 0) {
    state = state.update({ effects }).state;
  }
  return state;
}

function dumpDoc(state: EditorState, label: string): void {
  console.log(`${label} doc (${state.doc.lines} lines):`);
  state.doc.toString().split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
}

function dumpFrames(state: EditorState, label: string): void {
  console.log(`${label} top-level frames:`);
  for (const f of getFrames(state)) {
    console.log(`  ${f.id} isBand=${f.isBand} gridRow=${f.gridRow} gridH=${f.gridH} lineCount=${f.lineCount} docOffset=${f.docOffset} children=${f.children.length}`);
    for (const c of f.children) {
      console.log(`    └ ${c.id} isBand=${c.isBand} gridRow=${c.gridRow} gridH=${c.gridH} content=${c.content?.type ?? "wireframe"} children=${c.children.length}`);
      for (const gc of c.children) {
        console.log(`        └ ${gc.id} isBand=${gc.isBand} gridRow=${gc.gridRow} gridH=${gc.gridH} content=${gc.content?.type ?? "wireframe"}`);
      }
    }
  }
}

describe("Group C — in-band rect drag must clamp at band top (model layer)", () => {
  it("input fixture: 7-line doc, 2 rects A and B in a single band", () => {
    const state = createEditorStateUnified(SIDE_BY_SIDE_C, CW, CH);
    expect(state.doc.lines).toBe(7);
    const rects = findAllLeafRects(getFrames(state));
    expect(rects.length).toBe(2);
    const A = absRect(getFrames(state), rects[0].id)!;
    const B = absRect(getFrames(state), rects[1].id)!;
    expect(A.gridRow).toBe(2); // After "Above\n\n"
    expect(B.gridRow).toBe(2);
    expect(A.gridCol).toBeLessThan(B.gridCol);
  });

  it("DIAG: dragging A up by -200px — dump per-tick decisions and final state", () => {
    const state0 = createEditorStateUnified(SIDE_BY_SIDE_C, CW, CH);
    const rects = findAllLeafRects(getFrames(state0));
    const A_id = rects[0].id;

    console.log("=== BEFORE drag ===");
    dumpDoc(state0, "init");
    dumpFrames(state0, "init");
    const A_before = absRect(getFrames(state0), A_id)!;
    console.log(`A initial: ${JSON.stringify(A_before)}`);

    const state1 = simulateDragSelected(state0, A_id, 0, -200);

    console.log("\n=== AFTER drag ===");
    dumpDoc(state1, "post");
    dumpFrames(state1, "post");
    const A_after = absRect(getFrames(state1), A_id)!;
    console.log(`A after: ${JSON.stringify(A_after)}`);
    const saved = serializeUnified(getDoc(state1), getFrames(state1));
    console.log("=== SERIALIZED ===");
    saved.split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
  });

  it("rect A's absolute y stays at or below the original (within 1px tolerance)", () => {
    const state0 = createEditorStateUnified(SIDE_BY_SIDE_C, CW, CH);
    const rects = findAllLeafRects(getFrames(state0));
    const A_id = rects[0].id;
    const A_before = absRect(getFrames(state0), A_id)!;
    const docBefore = state0.doc.toString();

    const state1 = simulateDragSelected(state0, A_id, 0, -200);

    const A_after = absRect(getFrames(state1), A_id)!;
    expect(
      A_after.y,
      `A moved above its starting y. before=${A_before.y} after=${A_after.y}`,
    ).toBeGreaterThanOrEqual(A_before.y - 1);

    const docAfter = state1.doc.toString();
    expect(docAfter, `doc changed during in-band drag:\nbefore:\n${docBefore}\nafter:\n${docAfter}`).toBe(docBefore);
  });

  // SINGLE-rect band: drag up should ALSO clamp at band top (per user
  // observation 2026-05-04). If this also fails, the bug is broader than
  // "multi-child wrapper" and the fix surface must change.
  it("DIAG (single rect in band): drag up -200px must NOT push above starting y", () => {
    const SINGLE = "Above\n\n┌──┐\n│A │\n└──┘\n\nBelow";
    const state0 = createEditorStateUnified(SINGLE, CW, CH);
    const rects = findAllLeafRects(getFrames(state0));
    expect(rects.length).toBe(1);
    const A_id = rects[0].id;
    const A_frame = findFrameInList(getFrames(state0), A_id);
    if (!A_frame) throw new Error("A not found");
    const wrapper_id = resolveSelectionTarget(A_frame, null, getFrames(state0), false);
    if (!wrapper_id) throw new Error("wrapper_id null");
    console.log(`[SINGLE] resolveSelectionTarget(A) → ${wrapper_id} (A_id=${A_id})`);

    const docBefore = state0.doc.toString();
    const wrapper_before = absRect(getFrames(state0), wrapper_id)!;
    console.log(`[SINGLE] wrapper before: ${JSON.stringify(wrapper_before)}`);

    const state1 = simulateDragSelected(state0, wrapper_id, 0, -200);

    console.log("\n=== AFTER drag (single-rect band) ===");
    dumpDoc(state1, "post");
    dumpFrames(state1, "post");
    const wrapper_after = absRect(getFrames(state1), wrapper_id)!;
    console.log(`[SINGLE] wrapper after: ${JSON.stringify(wrapper_after)}`);
    const saved = serializeUnified(getDoc(state1), getFrames(state1));
    console.log("=== SERIALIZED (single-rect band) ===");
    saved.split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));

    expect(
      wrapper_after.y,
      `[SINGLE] wrapper moved above starting y: before=${wrapper_before.y} after=${wrapper_after.y}`,
    ).toBeGreaterThanOrEqual(wrapper_before.y - 1);
    expect(state1.doc.toString(), `[SINGLE] doc changed during in-band drag`).toBe(docBefore);
  });

  // === REAL HARNESS PATH: clickFrame selects the WIREFRAME WRAPPER, not the leaf rect.
  //
  // resolveSelectionTarget on first click (currentSelectedId=null) returns
  // chain[0] — the OUTERMOST non-band ancestor. For SIDE_BY_SIDE_C the
  // chain is [wireframe-wrapper, rect], so the wrapper gets selected.
  //
  // Then dragSelected drags the wrapper, NOT the rect. Different bandSiblings
  // count → different escalation behavior.
  it("DIAG (real harness path): clickFrame selects WIREFRAME WRAPPER and drags it up -200px", () => {
    const state0 = createEditorStateUnified(SIDE_BY_SIDE_C, CW, CH);
    // Mimic what clickFrame at A's center would actually select.
    const rects = findAllLeafRects(getFrames(state0));
    const A_id = rects[0].id;
    const A_frame = findFrameInList(getFrames(state0), A_id);
    if (!A_frame) throw new Error("A not found");
    const wrapper_id = resolveSelectionTarget(A_frame, null, getFrames(state0), false);
    if (!wrapper_id) throw new Error("wrapper_id null");
    console.log(`[DIAG] resolveSelectionTarget(A) returned wrapper_id=${wrapper_id} (A_id=${A_id})`);
    expect(wrapper_id, "first click should select the wireframe wrapper, not the leaf").not.toBe(A_id);

    const docBefore = state0.doc.toString();
    const wrapper_before = absRect(getFrames(state0), wrapper_id)!;
    console.log(`wrapper before: ${JSON.stringify(wrapper_before)}`);

    const state1 = simulateDragSelected(state0, wrapper_id, 0, -200);

    console.log("\n=== AFTER drag (wrapper path) ===");
    dumpDoc(state1, "post");
    dumpFrames(state1, "post");
    const wrapper_after = absRect(getFrames(state1), wrapper_id)!;
    console.log(`wrapper after: ${JSON.stringify(wrapper_after)}`);
    const saved = serializeUnified(getDoc(state1), getFrames(state1));
    console.log("=== SERIALIZED (wrapper path) ===");
    saved.split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));

    expect(
      wrapper_after.y,
      `wrapper moved above its starting y. before=${wrapper_before.y} after=${wrapper_after.y}`,
    ).toBeGreaterThanOrEqual(wrapper_before.y - 1);
    expect(state1.doc.toString(), `doc changed during in-band drag (wrapper path)`).toBe(docBefore);
  });
});
