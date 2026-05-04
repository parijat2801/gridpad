// Investigation pin for harness "drag independence › promote then drag old
// parent: promoted frame stays put" — DEBUG_PLAN.md row 3 of Current open
// failures.
//
// FINDING (2026-05-04): the harness test fails at line 3867
// `expect(afterPromote.length).toBe(2)`, NOT at the "promoted-frame-stays-put"
// assertion at 3881. The promote in step 1+2 never produces a second top-level
// frame because the harness drops at `outer.y + outer.h + 80px` which lands
// past doc end (10-line doc, drop at row 12). Bug A's docExtentPy guard
// (added in commit 537ee5e) correctly refuses this as a no-op promote.
//
// This is NOT an apply-layer atomicity bug. The test was written at commit
// 69434ed (2026-04-28) before Bug A landed; it pins behavior that the
// kept-guards design (per the user's grid-pinned-model constraint) now
// correctly refuses. Same shape as Fix 14 ("Test outdated post-Bug-D").
//
// DECISION: do not write a "Bug F" production fix. The harness test should
// either be (a) updated so its drop coordinates land inside the doc bounds
// (e.g., add blank rows below Outer in the fixture and drop in those blanks),
// or (b) deleted because the scenario it tests is no longer reachable under
// the kept-guards design.
//
// This file is kept as a model-layer pin of the finding: "the promote refused
// at the oracle is the actual failure mode; no apply-layer trace required."
// The DIAG test dumps the pre-drop state and the (no-op) post-drop state so
// future readers can see the geometry without running Playwright.

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

// Exact fixture from e2e/harness.spec.ts:3832-3841.
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

/** Replay one harness drag at the model layer, with explicit drop coordinates
 *  (px, py) instead of a relative (dx, dy). Used for the promote step where
 *  the harness drops at outerBefore.y + outerBefore.h + 80px. */
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

/** Drag a frame using a relative (dx, dy) — same shape as harness's dragSelected. */
function simulateDragSelected(state0: EditorState, leafId: string, dx: number, dy: number): EditorState {
  const abs0 = absRect(getFrames(state0), leafId);
  if (!abs0) throw new Error(`leaf ${leafId} not found`);
  const startPx = abs0.x + abs0.w / 2;
  const startPy = abs0.y + abs0.h / 2;
  return simulateDragSelectedToCoord(state0, leafId, startPx, startPy, startPx + dx, startPy + dy);
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

describe("promote then drag old parent — investigation pin (DEBUG_PLAN row 3)", () => {
  it("input fixture: outer with inner child, 10 lines total", () => {
    const state = createEditorStateUnified(FIXTURE, CW, CH);
    expect(state.doc.lines).toBe(10);
    const rects = findAllLeafRects(getFrames(state));
    expect(rects.length).toBe(2);
  });

  it("the harness drop point is past doc end → Bug A guard correctly refuses promote", () => {
    const state0 = createEditorStateUnified(FIXTURE, CW, CH);
    const rectsAll = findAllLeafRects(getFrames(state0));
    const absRects = rectsAll.map(r => ({ id: r.id, abs: absRect(getFrames(state0), r.id)! }));
    absRects.sort((a, b) => a.abs.gridRow - b.abs.gridRow);
    const outer = absRects[0];
    const inner = absRects[1];

    // Harness drop position (e2e/harness.spec.ts:3856):
    //   dropY = canvas.y + outer.y + outer.h + 80
    // Canvas-local Y = outer.y + outer.h + 80 = 36.8 + 110.4 + 80 = 227.2px
    // doc has 10 lines, docExtentPy = 10 * CH = 184px.
    // 227.2 > 184 → Bug A guard refuses (returns { kind: "none" }).
    const startPx = inner.abs.x + inner.abs.w / 2;
    const startPy = inner.abs.y + inner.abs.h / 2;
    const dropPx = startPx;
    const dropPy = outer.abs.y + outer.abs.h + 80;

    const docExtentPy = state0.doc.lines * CH;
    expect(dropPy, "drop is past doc end").toBeGreaterThan(docExtentPy);

    const state1 = simulateDragSelectedToCoord(state0, inner.id, startPx, startPy, dropPx, dropPy);

    // Confirm: no promote happened. Tree still has exactly one top-level
    // (the original Outer band). The Inner rect is still nested inside.
    const tree1 = getFrames(state1);
    expect(tree1.length, "Bug A correctly refused promote past doc end").toBe(1);

    // The harness test (e2e/harness.spec.ts:3867) asserts
    //   expect(afterPromote.length).toBe(2)
    // which is the legacy expectation from before Bug A landed. Update or
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
    const dropPy = outer.abs.y + outer.abs.h + 80;
    console.log(`\nstep 1+2: promote inner, drop at (${dropPx.toFixed(1)}, ${dropPy.toFixed(1)})`);

    const state1 = simulateDragSelectedToCoord(state0, inner.id, startPx, startPy, dropPx, dropPy);
    console.log("\n=== AFTER promote ===");
    dumpDoc(state1, "post-promote");
    dumpFrames(state1, "post-promote");

    const innerAfterPromote = absRect(getFrames(state1), inner.id);
    console.log(`\npromoted-inner abs: ${JSON.stringify(innerAfterPromote)}`);

    console.log("\nstep 3: drag outer down 20px");
    const state2 = simulateDragSelected(state1, outer.id, 0, 20);
    console.log("\n=== AFTER outer drag ===");
    dumpDoc(state2, "post-outer-drag");
    dumpFrames(state2, "post-outer-drag");

    const innerAfterOuterDrag = absRect(getFrames(state2), inner.id);
    console.log(`\npromoted-inner abs after outer drag: ${JSON.stringify(innerAfterOuterDrag)}`);

    const saved = serializeUnified(getDoc(state2), getFrames(state2));
    console.log("\n=== SERIALIZED ===");
    saved.split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
  });
});
