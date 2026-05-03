// Reproducer for harness "shared walls › move two separate boxes toward each
// other, save" — Bug D, the demote-side sibling of Bug C (DEBUG_PLAN.md row 1).
//
// Scenario: TWO_SEPARATE input has prose lines around two same-sized boxes A
// (rows 2-4) and B (rows 8-10). The harness drags A's center DOWN 80px, then
// drags B's center UP 80px, then saves. Pre-Bug-C, A's drag-down created a
// silent ghost (overwrote "Bottom"); the test asserted only `toContain("A")`
// so the false-pass was hidden. Post-Bug-C the promote on A's drag-down is
// refused, so A correctly stays inside its band. THEN B's drag-up triggers
// a NEW reparent decision whose target row overlaps A (now sitting where B
// used to be) → demote-into-A's-band. The apply layer doesn't keep doc text
// and frame claims in sync for this demote, leaving a ghost in the saved md.
//
// Test goals (mirroring src/ghostOnEqualSizePromote.diag.test.ts):
//   1. Pin the input shape (13-line doc, two band-wrapped rects).
//   2. Replay A's drag-down at the model layer, asserting Bug C still fires
//      (no ghost after step 1).
//   3. Replay B's drag-up at the model layer, capture the resulting saved
//      markdown, and assert it contains both "A" and "B" prose-labels and
//      no orphan wireframe glyphs.
//   4. Run a DIAG trace dumping doc + frames before/after each gesture to
//      identify the exact branch (decision oracle vs apply layer) that
//      produces the ghost.

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

// Exact input from e2e/harness.spec.ts TWO_SEPARATE constant.
const TWO_SEPARATE = "Top\n\n┌────┐\n│ A  │\n└────┘\n\nMiddle\n\n┌────┐\n│ B  │\n└────┘\n\nBottom";

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

// Compute a leaf rect's ABSOLUTE pixel + grid position by summing band ancestors.
function absRect(frames: Frame[], leafId: string): { x: number; y: number; w: number; h: number; gridRow: number; gridCol: number } | null {
  const walk = (fs: Frame[], offX: number, offY: number, offGridRow: number, offGridCol: number): { x: number; y: number; w: number; h: number; gridRow: number; gridCol: number } | null => {
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

/** Replay one harness `dragSelected(dx, dy)` at the model layer. Mirrors
 *  DemoV2.tsx onMouseDown → per-tick onMouseMove (lines 651-715) →
 *  onMouseUp (lines 791-839). One step (full delta in one tick) is enough
 *  because the per-tick math is linear in (dx, dy) — multi-tick interpolation
 *  doesn't change the final cumulative effect. Returns the new state. */
function simulateDragSelected(
  state0: EditorState,
  leafId: string,
  dx: number,
  dy: number,
): EditorState {
  // 1. Click-select the leaf (resolveSelectionTarget on first click selects
  //    the leaf directly for non-grouped wireframes, which TWO_SEPARATE has).
  let state = state0.update({ effects: selectFrameEffect.of(leafId) }).state;

  // 2. Capture mousedown geometry (startX, startY at frame center).
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

  // 3. Per-tick move math (mirrors DemoV2.tsx:652-715). Single tick: targetCol
  //    and targetRow computed from drag start + total delta. Then clamp inside
  //    band, escalate residual to band rotation if applicable.
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
      // For these rect-in-band fixtures, parent === band (no wireframe wrapper),
      // so bandSiblings = number of rect siblings under the band.
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

  // 4. Mouseup → reparent decision (DemoV2.tsx:791-839).
  const docExtentPy = state.doc.lines * CH;
  const grabOffsetPx = startX - startFrameX; // = abs0.w/2
  const grabOffsetPy = startY - startFrameY; // = abs0.h/2
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
    }
  }
}

function findOrphans(saved: string, frames: Frame[]): string[] {
  // Top-level claiming frames define which rows legitimately contain
  // wireframe glyphs. Anything outside is an orphan ghost.
  const claiming = frames.filter(f => f.lineCount > 0);
  const lines = saved.split("\n");
  const WIRE_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼"]);
  const orphans: string[] = [];
  for (let r = 0; r < lines.length; r++) {
    for (const c of [...lines[r]]) {
      if (WIRE_CHARS.has(c)) {
        const inside = claiming.some(f => r >= f.gridRow && r < f.gridRow + f.lineCount);
        if (!inside) {
          orphans.push(`L${r}: "${lines[r]}"`);
          break;
        }
      }
    }
  }
  return orphans;
}

describe("ghost on convergent demote — model layer reproducer (Bug D)", () => {
  it("input fixture: 13-line doc, two same-sized rects A (rows 2-4) and B (rows 8-10)", () => {
    const state = createEditorStateUnified(TWO_SEPARATE, CW, CH);
    expect(state.doc.lines).toBe(13);
    const rects = findAllLeafRects(getFrames(state));
    expect(rects.length).toBe(2);
    expect(rects[0].gridH).toBe(rects[1].gridH);
    const A = absRect(getFrames(state), rects[0].id)!;
    const B = absRect(getFrames(state), rects[1].id)!;
    expect(A.gridRow).toBe(2);
    expect(B.gridRow).toBe(8);
  });

  it("step 1 alone: A drags down 80px → no ghost, A stays inside its band (Bug C guard)", () => {
    const state0 = createEditorStateUnified(TWO_SEPARATE, CW, CH);
    const rects = findAllLeafRects(getFrames(state0));
    const A_id = rects[0].id;

    const state1 = simulateDragSelected(state0, A_id, 0, 80);
    const saved1 = serializeUnified(getDoc(state1), getFrames(state1));
    expect(saved1, `after step 1, ghosts in saved:\n${saved1}`).toContain("A");
    expect(saved1).toContain("B");
    expect(saved1).toContain("Bottom");
    expect(findOrphans(saved1, getFrames(state1)), `step 1 orphans:\n${saved1}`).toEqual([]);
  });

  it("step 1 + step 2: A drags down 80px, B drags up 80px → no ghost", () => {
    const state0 = createEditorStateUnified(TWO_SEPARATE, CW, CH);
    const rects0 = findAllLeafRects(getFrames(state0));
    const A_id = rects0[0].id;
    const B_id = rects0[1].id;

    // Step 1: A down 80px.
    const state1 = simulateDragSelected(state0, A_id, 0, 80);

    // Step 2: B up 80px. B's id is preserved through framesField updates.
    const state2 = simulateDragSelected(state1, B_id, 0, -80);
    const saved2 = serializeUnified(getDoc(state2), getFrames(state2));

    console.log("=== AFTER step 1 + step 2 ===");
    dumpDoc(state2, "post");
    dumpFrames(state2, "post");
    console.log("=== SERIALIZED ===");
    saved2.split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));

    // Goal: matching harness assertion plus an explicit no-orphans check.
    expect(saved2, "step 2 saved: lost A").toContain("A");
    expect(saved2, "step 2 saved: lost B").toContain("B");
    const orphans = findOrphans(saved2, getFrames(state2));
    expect(orphans, `Bug D ghost — orphan wireframe rows after convergent drag:\n${orphans.join("\n")}\n\nSaved:\n${saved2}`).toEqual([]);
  });

  it("DIAG: trace doc + frames after step 1 and after step 2 + dump decisions", () => {
    const state0 = createEditorStateUnified(TWO_SEPARATE, CW, CH);
    const rects0 = findAllLeafRects(getFrames(state0));
    const A_id = rects0[0].id;
    const B_id = rects0[1].id;

    console.log("=== BEFORE any drag ===");
    dumpDoc(state0, "init");
    dumpFrames(state0, "init");

    // Step 1: A down 80px.
    const state1 = simulateDragSelected(state0, A_id, 0, 80);
    console.log("\n=== AFTER step 1 (A down 80px) ===");
    dumpDoc(state1, "step1");
    dumpFrames(state1, "step1");

    // Manually compute what step 2 will see.
    const frames1 = getFrames(state1);
    const B_abs1 = absRect(frames1, B_id)!;
    console.log(`\nstep 2 setup: B abs=${JSON.stringify(B_abs1)}`);
    const startX = B_abs1.x + B_abs1.w / 2;
    const startY = B_abs1.y + B_abs1.h / 2;
    const cursorPx = startX;
    const cursorPy = startY - 80;
    const grabOffsetPx = B_abs1.w / 2;
    const grabOffsetPy = B_abs1.h / 2;
    const { aRow: aRow2, aCol: aCol2 } = landingGridFromCursor(
      cursorPx, cursorPy, grabOffsetPx, grabOffsetPy, CW, CH, state1.doc.lines,
    );
    const docExtentPy = state1.doc.lines * CH;
    const draggedFrame = findFrameInList(frames1, B_id);
    const draggedGridH = draggedFrame?.gridH ?? 0;
    const proseRows = new Set<number>();
    for (let i = 1; i <= state1.doc.lines; i++) {
      const ln = state1.doc.line(i);
      if (ln.length > 0) proseRows.add(i - 1);
    }
    const decision2 = decideReparent(
      frames1, B_id, cursorPx, cursorPy, docExtentPy,
      { aRow: aRow2, gridH: draggedGridH, proseRows },
      { aRow: aRow2, gridH: draggedGridH },
    );
    console.log(`step 2 decision: ${JSON.stringify(decision2)}, aRow=${aRow2} aCol=${aCol2}, proseRows=${[...proseRows]}`);

    const state2 = simulateDragSelected(state1, B_id, 0, -80);
    console.log("\n=== AFTER step 2 (B up 80px) ===");
    dumpDoc(state2, "step2");
    dumpFrames(state2, "step2");
    const saved2 = serializeUnified(getDoc(state2), getFrames(state2));
    console.log("\n=== SERIALIZED ===");
    saved2.split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
    console.log(`\norphans: ${JSON.stringify(findOrphans(saved2, getFrames(state2)))}`);
  });
});
