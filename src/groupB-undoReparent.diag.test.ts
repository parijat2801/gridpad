// Reproducer for harness "reparent › undo a drag-into-frame reparent restores
// original tree" — Bug E candidate (DEBUG_PLAN.md row 2 of Current open failures).
//
// Scenario: TWO_BOXES has a big empty box (rows 2-7) and a small box (rows 10-12)
// separated by prose. The harness clicks the small box, drags it to the big
// box's center → demote-into-big. Then dispatches undo (Cmd+Z) and saves.
// Expected post-undo: 2 top-level frames, neither contains a nested rect.
// Today: undo doesn't fully restore the original tree.
//
// This file reproduces the failure at the model layer so the bug can be
// bisected without Playwright. The test:
//   1. Pins the input fixture (TWO_BOXES → 16 lines, 2 top-level rect bands).
//   2. Replays the drag-into-big demote at the model layer.
//   3. Invokes CodeMirror's history undo command.
//   4. Asserts the post-undo tree has 2 top-level frames and neither contains
//      a nested rect.
//   5. DIAG: dumps doc + frames at each step (before drag, after demote, after
//      undo) so the implementer can identify where the desync lives.
//
// Likely failure modes (verify, don't anchor):
//   a. The frameInversion snapshot (editorState.ts:563-586) captures the
//      pre-transaction state correctly, but undo's restoreFramesEffect doesn't
//      cleanly reverse the cascade-prune that emptied the source band.
//   b. unifiedDocSync's demote+deleteFrameEffect dispatch produces a doc edit
//      whose inverse (CM history's auto-inverted ChangeSet) doesn't restore
//      the source band's claim lines correctly.
//   c. The post-undo frames have stale docOffsets that mapPos didn't shift
//      back through the inverted ChangeSet.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { StateEffect, type EditorState } from "@codemirror/state";
import { undo } from "@codemirror/commands";
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

// Exact input from e2e/harness.spec.ts TWO_BOXES constant.
const TWO_BOXES = "Above\n\n┌────────────────────────────┐\n│                            │\n│                            │\n│                            │\n│                            │\n└────────────────────────────┘\n\nbetween\n\n┌────┐\n│ S  │\n└────┘\n\nBelow";

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

/** Replay one harness `dragSelected(dx, dy)` at the model layer. Same shape as
 *  src/ghostOnConvergeDemote.diag.test.ts:simulateDragSelected. Mirrors
 *  DemoV2.tsx onMouseDown → per-tick onMouseMove → onMouseUp. */
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
  const startX = abs0.x + abs0.w / 2;
  const startY = abs0.y + abs0.h / 2;
  const cursorPx = startX + dx;
  const cursorPy = startY + dy;

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
  const grabOffsetPx = startX - startFrameX;
  const grabOffsetPy = startY - startFrameY;
  const { aRow, aCol } = landingGridFromCursor(
    cursorPx, cursorPy, grabOffsetPx, grabOffsetPy, CW, CH, state.doc.lines,
  );
  const draggedFrame = findFrameInList(getFrames(state), leafId);
  const draggedGridH = draggedFrame?.gridH ?? 0;
  const proseRows = new Set<number>();
  for (let i = 1; i <= state.doc.lines; i++) {
    const ln = state.doc.line(i);
    if (ln.length > 0) proseRows.add(i - 1);
  }
  const decision = decideReparent(
    getFrames(state), leafId, cursorPx, cursorPy, docExtentPy,
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

/** Returns true when no top-level frame contains a nested rect (modulo bands).
 *  Mirrors the harness assertion at e2e/harness.spec.ts:3721-3724. */
function noNestedRect(node: Frame): boolean {
  return node.children.every(c => c.content?.type !== "rect" && noNestedRect(c));
}

describe("undo a drag-into-frame reparent — model layer reproducer (Bug E candidate)", () => {
  it("input fixture: 16-line doc, two band-wrapped rects (big, small)", () => {
    const state = createEditorStateUnified(TWO_BOXES, CW, CH);
    expect(state.doc.lines).toBe(16);
    const rects = findAllLeafRects(getFrames(state));
    expect(rects.length).toBe(2);
    // big at rows 2-7 (gridH=6), small at rows 11-13 (gridH=3).
    const big_abs = absRect(getFrames(state), rects[0].id)!;
    const small_abs = absRect(getFrames(state), rects[1].id)!;
    expect(big_abs.gridRow).toBe(2);
    expect(small_abs.gridRow).toBe(11);
    expect(big_abs.w).toBeGreaterThan(small_abs.w);
  });

  it("step 1: demote small into big → tree has 1 top-level (big) with small as nested child", () => {
    const state0 = createEditorStateUnified(TWO_BOXES, CW, CH);
    const rects = findAllLeafRects(getFrames(state0));
    const big_id = rects[0].id;
    const small_id = rects[1].id;

    const big_abs = absRect(getFrames(state0), big_id)!;
    const small_abs = absRect(getFrames(state0), small_id)!;
    // Drag small's center to big's center (matches harness:3701-3703).
    const dx = (big_abs.x + big_abs.w / 2) - (small_abs.x + small_abs.w / 2);
    const dy = (big_abs.y + big_abs.h / 2) - (small_abs.y + small_abs.h / 2);

    const state1 = simulateDragSelected(state0, small_id, dx, dy);

    const tree1 = getFrames(state1);
    // After demote: small is now a child of big's band; total top-level
    // frames may be 1 (only big's band) since small's source band cascade-pruned.
    const rectsAfter = findAllLeafRects(tree1);
    expect(rectsAfter.length).toBe(2);  // both rects still exist somewhere in tree
    // big is still top-level; small is nested inside big.
    expect(tree1.some(f => f.id === big_id || f.children.some(c => c.id === big_id))).toBe(true);
    expect(noNestedRect(tree1[0])).toBe(false);  // big now contains small
  });

  it("step 1 + step 2 (undo): post-undo tree has 2 top-level frames, neither contains a nested rect", () => {
    const state0 = createEditorStateUnified(TWO_BOXES, CW, CH);
    const rects = findAllLeafRects(getFrames(state0));
    const small_id = rects[1].id;

    const big_abs = absRect(getFrames(state0), rects[0].id)!;
    const small_abs = absRect(getFrames(state0), small_id)!;
    const dx = (big_abs.x + big_abs.w / 2) - (small_abs.x + small_abs.w / 2);
    const dy = (big_abs.y + big_abs.h / 2) - (small_abs.y + small_abs.h / 2);

    const state1 = simulateDragSelected(state0, small_id, dx, dy);

    // Step 2: undo. CodeMirror's `undo` command takes (target: { state, dispatch }).
    // Since we're operating on a bare EditorState (no view), invoke it via the
    // history transaction directly: dispatch a transaction with the userEvent
    // "undo" annotation, OR call the `undo` command's logic by constructing
    // the appropriate transaction. Easiest: use the `undo` command which takes
    // a target with state and dispatch fields.
    let state2 = state1;
    const target = {
      state: state1,
      dispatch: (tr: { state: EditorState }) => { state2 = tr.state; },
    };
    const ok = undo(target as Parameters<typeof undo>[0]);
    expect(ok, "undo command should return true (history had something to undo)").toBe(true);

    const tree2 = getFrames(state2);
    const rects2 = findAllLeafRects(tree2);
    expect(rects2.length, "after undo: both rects still exist").toBe(2);
    expect(tree2.length, `after undo: should be 2 top-level frames, got ${tree2.length}`).toBe(2);
    expect(noNestedRect(tree2[0]), "after undo: tree[0] should have no nested rect").toBe(true);
    expect(noNestedRect(tree2[1]), "after undo: tree[1] should have no nested rect").toBe(true);

    // Saved markdown should be restorable to a 2-top-level-rect shape.
    const saved = serializeUnified(getDoc(state2), tree2);
    expect(saved).toContain("Above");
    expect(saved).toContain("between");
    expect(saved).toContain("Below");
  });

  it("DIAG: trace doc + frames at each step", () => {
    const state0 = createEditorStateUnified(TWO_BOXES, CW, CH);
    const rects = findAllLeafRects(getFrames(state0));
    const small_id = rects[1].id;
    const big_abs = absRect(getFrames(state0), rects[0].id)!;
    const small_abs = absRect(getFrames(state0), small_id)!;

    console.log("=== BEFORE drag ===");
    dumpDoc(state0, "init");
    dumpFrames(state0, "init");

    const dx = (big_abs.x + big_abs.w / 2) - (small_abs.x + small_abs.w / 2);
    const dy = (big_abs.y + big_abs.h / 2) - (small_abs.y + small_abs.h / 2);
    const state1 = simulateDragSelected(state0, small_id, dx, dy);

    console.log("\n=== AFTER demote (small into big) ===");
    dumpDoc(state1, "post-demote");
    dumpFrames(state1, "post-demote");

    // Undo
    let state2 = state1;
    const target = {
      state: state1,
      dispatch: (tr: { state: EditorState }) => { state2 = tr.state; },
    };
    const ok = undo(target as Parameters<typeof undo>[0]);
    console.log(`\nundo returned: ${ok}`);

    console.log("\n=== AFTER undo ===");
    dumpDoc(state2, "post-undo");
    dumpFrames(state2, "post-undo");

    const saved = serializeUnified(getDoc(state2), getFrames(state2));
    console.log("\n=== POST-UNDO SERIALIZED ===");
    saved.split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
  });
});
