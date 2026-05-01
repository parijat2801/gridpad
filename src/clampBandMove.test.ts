// TDD red tests for Fix 2 — clamp band gridRow past doc end.
//
// Bug: framesField.update's moveFrameEffect handler unconditionally
// adds dRow to a band's gridRow. For a 4-line band on an 8-line doc,
// dragging down 6 rows lands the band at gridRow=7 → its claim spans
// rows 7,8,9,10 → only row 7 exists → serializer drops rows 8-10.
// Net effect: silent data loss when dragging past doc end.
//
// Fix: a pure helper that clamps `dRow` so the band's claim stays
// within doc bounds: `0 ≤ newGridRow ≤ docLines - lineCount`.
//
//   clampBandMoveDelta(gridRow, lineCount, dRow, docLines): clamped dRow

import { describe, it, expect } from "vitest";
import { clampBandMoveDelta } from "./editorState";

describe("clampBandMoveDelta — Fix 2", () => {
  it("non-band move (lineCount=0) is unaffected", () => {
    expect(clampBandMoveDelta(2, 0, 100, 8)).toBe(100);
    expect(clampBandMoveDelta(0, 0, -50, 8)).toBe(-50);
  });

  it("4-line band on 8-line doc dragged down 6 rows clamps so claim ends at last line", () => {
    // gridRow=2, lineCount=4 → claim ends at row 5 (rows 2,3,4,5).
    // Doc lines = 8 (rows 0..7). Max valid gridRow = 8 - 4 = 4.
    // dRow=6 would land gridRow=8; clamp to gridRow=4 → clamped dRow=2.
    expect(clampBandMoveDelta(2, 4, 6, 8)).toBe(2);
  });

  it("clamps upward to gridRow >= 0", () => {
    // gridRow=2, dRow=-5 would land at gridRow=-3. Clamp to 0 → clamped dRow=-2.
    expect(clampBandMoveDelta(2, 4, -5, 8)).toBe(-2);
  });

  it("returns 0 when already at clamp boundary and trying to push further", () => {
    // At gridRow=4 (the max for a 4-line band on 8-line doc), pushing down
    // by 1 should clamp to 0.
    expect(clampBandMoveDelta(4, 4, 1, 8)).toBe(0);
    // At gridRow=0, pushing up by 1 should clamp to 0.
    expect(clampBandMoveDelta(0, 4, -1, 8)).toBe(0);
  });

  it("preserves valid (non-overflowing) deltas exactly", () => {
    expect(clampBandMoveDelta(2, 4, 1, 8)).toBe(1);
    expect(clampBandMoveDelta(3, 4, -1, 8)).toBe(-1);
    expect(clampBandMoveDelta(0, 4, 4, 8)).toBe(4); // 0 → 4, max valid
  });
});
