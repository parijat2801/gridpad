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
import { StateEffect, Transaction, type EditorState } from "@codemirror/state";
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

/** Replay one harness `dragSelected(dx, dy)` at the model layer, mirroring
 *  DemoV2.tsx's drag flow including Bug E's fix: per-tick effects use
 *  addToHistory(false); at mouseup, the cumulative-drag delta is folded INTO
 *  the reparent transaction (one history entry total). Without this folding,
 *  drag and reparent are two transactions and a single undo only reverses
 *  the second. */
function simulateDragSelected(
  state0: EditorState,
  leafId: string,
  dx: number,
  dy: number,
): EditorState {
  const mouseDownState = state0.update({ effects: selectFrameEffect.of(leafId) }).state;
  let workingState = mouseDownState;

  const frames0 = getFrames(workingState);
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
    const containingBand = findContainingBandDeep(getFrames(workingState), leafId);
    const effects: StateEffect<unknown>[] = [];
    if (containingBand) {
      const child = leaf0;
      const bandRow = getBandRelativeRow(leafId, containingBand.id, getFrames(workingState));
      const bandCol = getBandRelativeCol(leafId, containingBand.id, getFrames(workingState));
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
      // Per-tick: NOT recorded to history (mirrors DemoV2.tsx:712).
      workingState = workingState.update({
        effects,
        annotations: [Transaction.addToHistory.of(false)],
      }).state;
    }
  }

  // Mouseup decision: against post-tick workingState (matches DemoV2.tsx).
  const docExtentPy = workingState.doc.lines * CH;
  const grabOffsetPx = startX - startFrameX;
  const grabOffsetPy = startY - startFrameY;
  const { aRow, aCol } = landingGridFromCursor(
    cursorPx, cursorPy, grabOffsetPx, grabOffsetPy, CW, CH, workingState.doc.lines,
  );
  const draggedFrame = findFrameInList(getFrames(workingState), leafId);
  const draggedGridH = draggedFrame?.gridH ?? 0;
  const proseRows = new Set<number>();
  for (let i = 1; i <= workingState.doc.lines; i++) {
    const ln = workingState.doc.line(i);
    if (ln.length > 0) proseRows.add(i - 1);
  }
  const decision = decideReparent(
    getFrames(workingState), leafId, cursorPx, cursorPy, docExtentPy,
    { aRow, gridH: draggedGridH, proseRows },
    { aRow, gridH: draggedGridH },
  );

  // Compute cumulative-drag delta: workingState - mouseDownState.
  const mdFrame = findFrameInList(getFrames(mouseDownState), leafId);
  const wsFrame = findFrameInList(getFrames(workingState), leafId);
  const dragDCol = mdFrame && wsFrame ? wsFrame.gridCol - mdFrame.gridCol : 0;
  const dragDRow = mdFrame && wsFrame ? wsFrame.gridRow - mdFrame.gridRow : 0;
  const dragEffects: StateEffect<unknown>[] = [];
  if (dragDCol !== 0 || dragDRow !== 0) {
    dragEffects.push(moveFrameEffect.of({ id: leafId, dCol: dragDCol, dRow: dragDRow, charWidth: CW, charHeight: CH }));
  }

  // Mouseup commit. If reparent fires, fold drag effects into the reparent
  // transaction via extraEffects. If not, commit drag alone against
  // mouseDownState.
  if (decision.kind === "demote") {
    return applyReparentFrame(mouseDownState, leafId, decision.targetTopLevelId, aRow, aCol, CW, CH, dragEffects);
  }
  if (decision.kind === "promote") {
    return applyReparentFrame(mouseDownState, leafId, null, aRow, aCol, CW, CH, dragEffects);
  }
  if (dragEffects.length > 0) {
    return mouseDownState.update({
      effects: dragEffects,
      annotations: [Transaction.addToHistory.of(true)],
    }).state;
  }
  return workingState;
}

function dumpDoc(state: EditorState, label: string): void {
  console.log(`${label} doc (${state.doc.lines} lines):`);
  state.doc.toString().split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
}

function dumpFrames(state: EditorState, label: string): void {
  console.log(`${label} top-level frames:`);
  for (const f of getFrames(state)) {
    console.log(`  ${f.id} isBand=${f.isBand} gridRow=${f.gridRow} gridCol=${f.gridCol} gridH=${f.gridH} gridW=${f.gridW} lineCount=${f.lineCount} docOffset=${f.docOffset} children=${f.children.length}`);
    for (const c of f.children) {
      console.log(`    └ ${c.id} isBand=${c.isBand} gridRow=${c.gridRow} gridCol=${c.gridCol} gridH=${c.gridH} gridW=${c.gridW} content=${c.content?.type ?? "wireframe"}`);
      for (const cc of c.children) {
        console.log(`        └ ${cc.id} isBand=${cc.isBand} gridRow=${cc.gridRow} gridCol=${cc.gridCol} gridH=${cc.gridH} gridW=${cc.gridW} content=${cc.content?.type ?? "wireframe"}`);
      }
    }
  }
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
    const small_id = rects[1].id;

    const big_abs = absRect(getFrames(state0), rects[0].id)!;
    const small_abs = absRect(getFrames(state0), small_id)!;
    // Drag small's center to big's center (matches harness:3701-3703).
    const dx = (big_abs.x + big_abs.w / 2) - (small_abs.x + small_abs.w / 2);
    const dy = (big_abs.y + big_abs.h / 2) - (small_abs.y + small_abs.h / 2);

    const state1 = simulateDragSelected(state0, small_id, dx, dy);

    const tree1 = getFrames(state1);
    const rectsAfter = findAllLeafRects(tree1);
    expect(rectsAfter.length).toBe(2);  // both rects still exist somewhere in tree
    // After demote: source band cascade-pruned, so only big's band remains
    // top-level. The small rect is now a sibling of big's rect inside big's
    // band.
    expect(tree1.length, "after demote: source band pruned, only big's band remains").toBe(1);
    expect(tree1[0].children.length, "big band now contains both rects").toBe(2);
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

    // The real Bug E assertion: saved markdown round-trips to the original.
    // Pre-fix, `restoreFramesEffect`'s snapshot is taken AFTER the per-tick
    // moveFrameEffect already moved the small rect to gridCol=12 inside its
    // source band (and shifted the band's gridRow). Undo restores to that
    // intermediate state instead of the original. The saved markdown then has
    // the small box at column 12 instead of column 0.
    const saved = serializeUnified(getDoc(state2), tree2);
    expect(saved, `Bug E: post-undo saved markdown should match original input.\n\nGot:\n${saved}`).toBe(TWO_BOXES);
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
      dispatch: (tr: unknown) => { state2 = (tr as { state: EditorState }).state; },
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
