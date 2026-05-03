// Reproducer for harness "equal-size frames passed through each other do not nest".
//
// Scenario: TWO_SEPARATE input has prose lines surrounding two same-sized
// boxes A (rows 2-4) and B (rows 8-10). The harness drags A's center past
// B's bottom edge + 30px and drops in the empty space below B but ABOVE
// the doc end ("Bottom" is at row 12). Bug A's doc-bound guard does NOT
// fire because the drop is in bounds; decideReparent still returns
// `promote` for an in-bounds empty-space drop. The promote application:
//
//   1. removes A's rect from its band (band becomes empty)
//   2. wraps the rect in a fresh band at the drop row
//   3. unifiedDocSync inserts blank rows at the drop row to claim
//   4. unifiedDocSync's deleteFrameEffect for the source band removes
//      A's old claim rows
//
// Observed harness output: the new claim's blank rows AND the promote
// row's wireframe glyphs OVERWRITE the "Bottom" prose line, leaving a
// phantom "┌────┐" with no closing "└" in the saved markdown.
//
// This test exercises the model layer to bisect: does the bug live in
// decideReparent (spurious promote in empty-space-between-bands) or in
// unifiedDocSync's reparent transaction (insert overwrites prose)?

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  createEditorStateUnified,
  getFrames,
  getDoc,
  applyReparentFrame,
  decideReparent,
} from "./editorState";
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

type FrameLike = ReturnType<typeof getFrames>[number];

function findAllLeafRects(frames: FrameLike[]): FrameLike[] {
  const out: FrameLike[] = [];
  const walk = (fs: FrameLike[]) => {
    for (const f of fs) {
      if (!f.isBand && f.content !== null && f.content.type === "rect") out.push(f);
      walk(f.children);
    }
  };
  walk(frames);
  return out;
}

// Compute a leaf rect's ABSOLUTE pixel position by summing band ancestors.
function absRect(frames: FrameLike[], leafId: string): { x: number; y: number; w: number; h: number; gridRow: number } | null {
  const walk = (fs: FrameLike[], offX: number, offY: number, offGridRow: number): { x: number; y: number; w: number; h: number; gridRow: number } | null => {
    for (const f of fs) {
      if (f.id === leafId) {
        return { x: f.x + offX, y: f.y + offY, w: f.w, h: f.h, gridRow: f.gridRow + offGridRow };
      }
      const childOffX = offX + f.x;
      const childOffY = offY + f.y;
      const childOffGridRow = offGridRow + f.gridRow;
      const r = walk(f.children, childOffX, childOffY, childOffGridRow);
      if (r) return r;
    }
    return null;
  };
  return walk(frames, 0, 0, 0);
}

describe("ghost on equal-size promote-into-empty-space — model layer reproducer", () => {
  it("input fixture: doc has 13 lines, two band-wrapped rects (A, B)", () => {
    const state = createEditorStateUnified(TWO_SEPARATE, CW, CH);
    expect(state.doc.lines).toBe(13);
    const rects = findAllLeafRects(getFrames(state));
    expect(rects.length).toBe(2);
    // A at rows 2-4; B at rows 8-10 (both rect leaves).
    expect(rects[0].gridH).toBe(rects[1].gridH);
  });

  it("decideReparent without promoteLanding: returns promote (legacy callers)", () => {
    const state = createEditorStateUnified(TWO_SEPARATE, CW, CH);
    const frames = getFrames(state);
    const rects = findAllLeafRects(frames);
    const A_abs = absRect(frames, rects[0].id)!;
    const B_abs = absRect(frames, rects[1].id)!;

    const dropPx = A_abs.x + A_abs.w / 2;
    const dropPy = B_abs.y + B_abs.h + 30;
    const docExtentPy = state.doc.lines * CH;

    expect(dropPy).toBeLessThan(docExtentPy);
    expect(dropPy).toBeGreaterThan(B_abs.y + B_abs.h);

    const decision = decideReparent(frames, rects[0].id, dropPx, dropPy, docExtentPy);

    // Without promoteLanding, prose-row guard is skipped. Today's behavior is
    // `promote` for an in-bounds drop in empty space — this pins that.
    expect(decision.kind).toBe("promote");
  });

  it("decideReparent with promoteLanding: refuses promote when target row is prose", () => {
    const state = createEditorStateUnified(TWO_SEPARATE, CW, CH);
    const frames = getFrames(state);
    const rects = findAllLeafRects(frames);
    const A_abs = absRect(frames, rects[0].id)!;
    const B_abs = absRect(frames, rects[1].id)!;
    const A = rects[0];

    const dropPx = A_abs.x + A_abs.w / 2;
    const dropPy = B_abs.y + B_abs.h + 30;
    const docExtentPy = state.doc.lines * CH;

    // Compute aRow the same way the live call site does.
    const grabOffsetPx = A_abs.w / 2;
    const grabOffsetPy = A_abs.h / 2;
    const framePy = dropPy - grabOffsetPy;
    const framePx = dropPx - grabOffsetPx;
    const aRow = Math.max(0, Math.min(state.doc.lines - 1, Math.round(framePy / CH)));

    // Build proseRows from the doc text (rows 0, 6, 12 in TWO_SEPARATE).
    const proseRows = new Set<number>();
    for (let i = 1; i <= state.doc.lines; i++) {
      const ln = state.doc.line(i);
      if (ln.length > 0) proseRows.add(i - 1);
    }

    // aRow=11 with gridH=3 → claims rows 11, 12, 13. Row 12 is "Bottom" prose.
    expect(proseRows.has(12)).toBe(true);

    const decision = decideReparent(
      frames, A.id, dropPx, dropPy, docExtentPy,
      { aRow, gridH: A.gridH, proseRows },
    );

    expect(decision.kind).toBe("none");
    void framePx; // referenced for parity with apply-side computation
  });

  it("applyReparentFrame promote-into-row-12 destroys 'Bottom' prose and leaves orphan ┌", () => {
    const state0 = createEditorStateUnified(TWO_SEPARATE, CW, CH);
    const frames0 = getFrames(state0);
    const rects0 = findAllLeafRects(frames0);
    const A_abs = absRect(frames0, rects0[0].id)!;
    const B_abs = absRect(frames0, rects0[1].id)!;

    // Mirror DemoV2.tsx onMouseUp call to landingGridFromCursor(...)
    // For a center-grab drag landing at (dropPx, dropPy), the helper
    // computes aRow = round((dropPy - grabOffsetPy) / ch) clamped to
    // docLines-1, and aCol = max(0, round((dropPx - grabOffsetPx) / cw)).
    const dropPx = A_abs.x + A_abs.w / 2;
    const dropPy = B_abs.y + B_abs.h + 30;
    const grabOffsetPx = A_abs.w / 2;
    const grabOffsetPy = A_abs.h / 2;
    const framePx = dropPx - grabOffsetPx;
    const framePy = dropPy - grabOffsetPy;
    const aRow = Math.max(0, Math.min(state0.doc.lines - 1, Math.round(framePy / CH)));
    const aCol = Math.max(0, Math.round(framePx / CW));

    console.log("computed promote target:", { aRow, aCol, framePy, framePx, A_abs, B_abs });

    const state1 = applyReparentFrame(state0, rects0[0].id, null, aRow, aCol, CW, CH);
    const frames1 = getFrames(state1);
    const doc1 = getDoc(state1);
    const saved = serializeUnified(doc1, frames1);

    console.log("post-promote saved doc:\n" + saved);
    console.log("post-promote frame tree top-level count:", frames1.length);
    const rects1 = findAllLeafRects(frames1);
    console.log("post-promote rect count:", rects1.length, "rects:", rects1.map(r => {
      const a = absRect(frames1, r.id);
      return { id: r.id, gridRow: r.gridRow, abs: a };
    }));

    // Expectation 1: "Bottom" prose must survive.
    expect(saved, `"Bottom" prose lost. Saved:\n${saved}`).toContain("Bottom");

    // Expectation 2: no orphan wireframe glyphs (rows containing wire chars
    // but no claiming frame).
    const claimingFrames = frames1.filter(f => f.lineCount > 0);
    const savedLines = saved.split("\n");
    const WIRE_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼"]);
    const orphans: string[] = [];
    for (let r = 0; r < savedLines.length; r++) {
      for (const ch of [...savedLines[r]]) {
        if (WIRE_CHARS.has(ch)) {
          const inside = claimingFrames.some(f => r >= f.gridRow && r < f.gridRow + f.lineCount);
          if (!inside) {
            orphans.push(`L${r}: "${savedLines[r]}"`);
          }
        }
      }
    }
    expect(
      orphans,
      `orphan wireframe glyphs (no claiming frame on that row):\n${orphans.join("\n")}\n\nSaved:\n${saved}\n\nClaiming frames: ${JSON.stringify(claimingFrames.map(f => ({ id: f.id, gridRow: f.gridRow, lineCount: f.lineCount })))}`,
    ).toEqual([]);

    // Expectation 3: both rect leaves still exist (A promoted, B unchanged).
    expect(rects1.length, "lost a rect leaf during promote").toBe(2);
  });

  // Diagnostic: dump pre/post-transaction state for the promote case.
  it("DIAG: trace doc + frames before/after promote", () => {
    const state0 = createEditorStateUnified(TWO_SEPARATE, CW, CH);
    const frames0 = getFrames(state0);
    const rects0 = findAllLeafRects(frames0);
    const A_abs = absRect(frames0, rects0[0].id)!;
    const B_abs = absRect(frames0, rects0[1].id)!;

    const dropPx = A_abs.x + A_abs.w / 2;
    const dropPy = B_abs.y + B_abs.h + 30;
    const aRow = Math.max(0, Math.min(state0.doc.lines - 1, Math.round((dropPy - A_abs.h / 2) / CH)));
    const aCol = Math.max(0, Math.round((dropPx - A_abs.w / 2) / CW));

    console.log("=== BEFORE promote ===");
    console.log("doc:");
    state0.doc.toString().split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
    console.log("top-level frames:");
    for (const f of frames0) {
      console.log(`  ${f.id} isBand=${f.isBand} gridRow=${f.gridRow} gridH=${f.gridH} lineCount=${f.lineCount} docOffset=${f.docOffset}`);
    }
    console.log("calling applyReparentFrame(state, A.id, null,", aRow, ",", aCol, ", CW, CH)");

    const state1 = applyReparentFrame(state0, rects0[0].id, null, aRow, aCol, CW, CH);
    const frames1 = getFrames(state1);

    console.log("=== AFTER promote ===");
    console.log("doc:");
    state1.doc.toString().split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
    console.log("top-level frames:");
    for (const f of frames1) {
      console.log(`  ${f.id} isBand=${f.isBand} gridRow=${f.gridRow} gridH=${f.gridH} lineCount=${f.lineCount} docOffset=${f.docOffset} children=${f.children.length}`);
    }

    const saved = serializeUnified(getDoc(state1), frames1);
    console.log("=== SERIALIZED ===");
    saved.split("\n").forEach((l, i) => console.log(`  L${i}: "${l}"`));
  });
});
