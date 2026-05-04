// Investigation pin for harness "drag independence › promote then drag the
// promoted frame: old parent stays put" — DEBUG_PLAN.md row 4 of Current open
// failures.
//
// FINDING (2026-05-04): same root cause as DEBUG_PLAN row 3
// (groupB-promoteThenDragOldParent.diag.test.ts). The harness test fails at
// line 3925 `expect(afterPromote.length).toBe(2)`, NOT at the
// "old-parent-stays-put" assertion at 3949. The promote in step 1 never
// produces a second top-level frame because the harness drops at
// `outer.y + outer.h + 60px` which lands on the "Bottom prose" row. Bug C's
// proseRows guard (added in commit 8fb4593) correctly refuses promote when
// the target rows overlap prose.
//
// This is NOT an apply-layer atomicity bug. The fixture for this test (e2e/
// harness.spec.ts:3887-3898) has 13 lines with "Bottom prose" at row 12 and
// 3 blank rows (8-10) between Outer and Bottom prose. Outer is at rows 2-7
// (gridH=6). dropY = outer.y + outer.h + 60 = 36.8 + 110.4 + 60 = 207.2px.
// docExtentPy = 13 * 18.4 = 239.2px → drop is in-bounds. Drop row =
// round(207.2 / 18.4) = 11. After landingGridFromCursor's grab-offset
// computation (Bug B fix), the dragged frame's top-left lands at row
// round((207.2 - 27.6) / 18.4) = round(9.76) = 10. With dragged.gridH = 3,
// the promote target range is [10, 13). Row 12 is "Bottom prose" → in
// proseRows → Bug C refuses.
//
// This test was written at commit 69434ed (2026-04-28) before Bug C landed.
// Same shape as Fix 14 ("Test outdated post-Bug-D").
//
// DECISION: do not write a "Bug G" production fix. The harness test should
// either be (a) updated so the drop lands well clear of any prose row (e.g.,
// add MORE blank rows below Outer in the fixture), or (b) deleted because
// the scenario tests behavior that the kept-guards design no longer permits.
//
// Once Bug E is shipped (the only real apply-layer bug in Group B), the
// harness should reach 140/5 with:
//   - Bug E cleared (undo a drag-into-frame reparent)
//   - Two outdated tests (this one + groupB-promoteThenDragOldParent) still
//     in the failure list, awaiting test rewrites or deletion.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { StateEffect, type EditorState } from "@codemirror/state";
import {
  createEditorStateUnified,
  getFrames,
  getDoc,
  applyReparentFrame,
  decideReparent,
  landingGridFromCursor,
  moveFrameEffect,
  selectFrameEffect,
  findContainingBandDeep,
  getBandRelativeRow,
  getBandRelativeCol,
  findFrameInList,
  shouldEscalateResidual,
} from "./editorState";
import type { Frame } from "./frame";
import { serializeUnified } from "./serializeUnified";

const CW = 9.6;
const CH = 18.4;

// Exact fixture from e2e/harness.spec.ts:3887-3898.
const FIXTURE = `Top prose

┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘



Bottom prose`;

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

type AbsRect = { x: number; y: number; w: number; h: number; gridRow: number; gridCol: number };
function absRect(frames: Frame[], leafId: string): AbsRect | null {
  const walk = (fs: Frame[], offX: number, offY: number, offGridRow: number, offGridCol: number): AbsRect | null => {
    for (const f of fs) {
      if (f.id === leafId) {
        return { x: f.x + offX, y: f.y + offY, w: f.w, h: f.h, gridRow: f.gridRow + offGridRow, gridCol: f.gridCol + offGridCol };
      }
      const r = walk(f.children, offX + f.x, offY + f.y, offGridRow + f.gridRow, offGridCol + f.gridCol);
      if (r) return r;
    }
    return null;
  };
  return walk(frames, 0, 0, 0, 0);
}

function simulateDragSelectedToCoord(
  state0: EditorState,
  leafId: string,
  startPx: number,
  startPy: number,
  dropPx: number,
  dropPy: number,
): EditorState {
  let state = state0.update({ effects: selectFrameEffect.of(leafId) }).state;

  const frames0 = getFrames(state);
  const leaf0 = findFrameInList(frames0, leafId);
  if (!leaf0) throw new Error(`leaf ${leafId} not found`);
  const abs0 = absRect(frames0, leafId)!;
  const startFrameX = abs0.x;
  const startFrameY = abs0.y;
  const dx = dropPx - startPx;
  const dy = dropPy - startPy;

  const targetCol = Math.round(Math.max(0, startFrameX + dx) / CW);
  const targetRow = Math.round(Math.max(0, startFrameY + dy) / CH);
  const currentCol = Math.round(abs0.x / CW);
  const currentRow = Math.round(abs0.y / CH);
  const dCol = targetCol - currentCol;
  const dRow = targetRow - currentRow;

  if (dCol !== 0 || dRow !== 0) {
    const containingBand = findContainingBandDeep(getFrames(state), leafId);
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
      if (clampedDRow !== 0 || clampedDCol !== 0) {
        effects.push(moveFrameEffect.of({ id: leafId, dCol: clampedDCol, dRow: clampedDRow, charWidth: CW, charHeight: CH }));
      }
      const bandSlackRows = containingBand.gridH - child.gridH;
      const bandSiblings = containingBand.children.filter(c => c.content?.type !== "text").length;
      const gestureHadClampedMotion = clampedDRow !== 0;
      if (shouldEscalateResidual(clampedDRow, residualDRow, gestureHadClampedMotion, bandSlackRows, bandSiblings)) {
        effects.push(moveFrameEffect.of({ id: containingBand.id, dCol: 0, dRow: residualDRow, charWidth: CW, charHeight: CH }));
      }
    } else {
      effects.push(moveFrameEffect.of({ id: leafId, dCol, dRow, charWidth: CW, charHeight: CH }));
    }
    if (effects.length > 0) {
      state = state.update({ effects }).state;
    }
  }

  const docExtentPy = state.doc.lines * CH;
  const grabOffsetPx = startPx - startFrameX;
  const grabOffsetPy = startPy - startFrameY;
  const { aRow, aCol } = landingGridFromCursor(
    dropPx, dropPy, grabOffsetPx, grabOffsetPy, CW, CH, state.doc.lines,
  );
  const draggedFrame = findFrameInList(getFrames(state), leafId);
  const draggedGridH = draggedFrame?.gridH ?? 0;
  const proseRows = new Set<number>();
  for (let i = 1; i <= state.doc.lines; i++) {
    const ln = state.doc.line(i);
    if (ln.length > 0) proseRows.add(i - 1);
  }
  const decision = decideReparent(
    getFrames(state), leafId, dropPx, dropPy, docExtentPy,
    { aRow, gridH: draggedGridH, proseRows },
    { aRow, gridH: draggedGridH },
  );
  if (decision.kind === "demote") {
    state = applyReparentFrame(state, leafId, decision.targetTopLevelId, aRow, aCol, CW, CH);
  } else if (decision.kind === "promote") {
    state = applyReparentFrame(state, leafId, null, aRow, aCol, CW, CH);
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
      console.log(`    └ ${c.id} isBand=${c.isBand} gridRow=${c.gridRow} gridH=${c.gridH} content=${c.content?.type ?? "wireframe"}`);
      for (const cc of c.children) {
        console.log(`        └ ${cc.id} isBand=${cc.isBand} gridRow=${cc.gridRow} gridH=${cc.gridH} content=${cc.content?.type ?? "wireframe"}`);
      }
    }
  }
}

describe("promote then drag promoted frame — investigation pin (DEBUG_PLAN row 4)", () => {
  it("input fixture: outer with inner child + 3 blank rows + Bottom prose, 12 lines total", () => {
    const state = createEditorStateUnified(FIXTURE, CW, CH);
    expect(state.doc.lines).toBe(12);
    const rects = findAllLeafRects(getFrames(state));
    expect(rects.length).toBe(2);
  });

  it("the harness drop point lands on the 'Bottom prose' row → Bug C guard correctly refuses promote", () => {
    const state0 = createEditorStateUnified(FIXTURE, CW, CH);
    const rectsAll = findAllLeafRects(getFrames(state0));
    const absRects = rectsAll.map(r => ({ id: r.id, abs: absRect(getFrames(state0), r.id)! }));
    absRects.sort((a, b) => a.abs.gridRow - b.abs.gridRow);
    const outer = absRects[0];
    const inner = absRects[1];

    // Harness drop position (e2e/harness.spec.ts:3914):
    //   dropY = canvas.y + outer.y + outer.h + 60
    const startPx = inner.abs.x + inner.abs.w / 2;
    const startPy = inner.abs.y + inner.abs.h / 2;
    const dropPx = startPx;
    const dropPy = outer.abs.y + outer.abs.h + 60;

    // Drop is in-bounds (Bug A passes).
    const docExtentPy = state0.doc.lines * CH;
    expect(dropPy, "drop is in-bounds").toBeLessThan(docExtentPy);

    const state1 = simulateDragSelectedToCoord(state0, inner.id, startPx, startPy, dropPx, dropPy);

    // Confirm: no promote happened. Tree still has exactly one top-level
    // (Outer's band). The Inner is still nested inside.
    const tree1 = getFrames(state1);
    expect(tree1.length, "Bug C correctly refused promote into prose row").toBe(1);

    // The harness test (e2e/harness.spec.ts:3925) asserts
    //   expect(afterPromote.length).toBe(2)
    // which is the legacy expectation from before Bug C landed. Update or
    // delete the harness test.
  });

  it("DIAG: trace the no-op promote attempt", () => {
    const state0 = createEditorStateUnified(FIXTURE, CW, CH);
    const rectsAll = findAllLeafRects(getFrames(state0));
    const absRects = rectsAll.map(r => ({ id: r.id, abs: absRect(getFrames(state0), r.id)! }));
    absRects.sort((a, b) => a.abs.gridRow - b.abs.gridRow);
    const outer = absRects[0];
    const inner = absRects[1];

    console.log("=== BEFORE drag ===");
    dumpDoc(state0, "init");
    dumpFrames(state0, "init");

    const startPx = inner.abs.x + inner.abs.w / 2;
    const startPy = inner.abs.y + inner.abs.h / 2;
    const dropPx = startPx;
    const dropPy = outer.abs.y + outer.abs.h + 60;
    const docExtentPy = state0.doc.lines * CH;

    // Manual computation of what aRow Bug C is checking.
    const grabOffsetPy = inner.abs.h / 2;
    const framePy = dropPy - grabOffsetPy;
    const aRow = Math.max(0, Math.min(state0.doc.lines - 1, Math.round(framePy / CH)));
    const proseRows = new Set<number>();
    for (let i = 1; i <= state0.doc.lines; i++) {
      const ln = state0.doc.line(i);
      if (ln.length > 0) proseRows.add(i - 1);
    }
    console.log(`\ndropPy=${dropPy.toFixed(1)} (docExtentPy=${docExtentPy})`);
    console.log(`landingGridFromCursor → aRow=${aRow}`);
    console.log(`dragged inner gridH=${rectsAll[1].gridH}, target row range [${aRow}, ${aRow + rectsAll[1].gridH})`);
    console.log(`proseRows: ${[...proseRows].join(",")}`);
    const collidingProse: number[] = [];
    for (let r = aRow; r < aRow + rectsAll[1].gridH; r++) {
      if (proseRows.has(r)) collidingProse.push(r);
    }
    console.log(`prose rows in target range: ${collidingProse.join(",")}`);
    console.log(`→ Bug C refuses if any prose row is in target range.`);

    const state1 = simulateDragSelectedToCoord(state0, inner.id, startPx, startPy, dropPx, dropPy);
    console.log("\n=== AFTER drag attempt ===");
    dumpDoc(state1, "post-attempt");
    dumpFrames(state1, "post-attempt");
    const saved = serializeUnified(getDoc(state1), getFrames(state1));
    console.log("\n=== SERIALIZED ===");
    saved.split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
  });
});
