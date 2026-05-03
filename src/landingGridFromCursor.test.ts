// RED test for Bug B (column drift on promote/demote).
//
// Background (DEBUG_PLAN.md, Phase 4 outcome): the mouseup branch in
// DemoV2.tsx that calls applyReparentFrame computes
//   aRow = round(upPy / ch); aCol = round(upPx / cw)
// — that is, *cursor* coords, not *frame-left-edge* coords. When the
// user grabs a frame at its center and drags vertically, upPx ends up
// at frame-left + w/2 → aCol is half a frame-width to the right of
// where the frame should land. The frame model writes a phantom claim
// at the wrong column → ghost glyph in the saved markdown.
//
// Fix: translate the cursor-at-mouseup back to the frame's left edge
// using the grab offset captured at mousedown
// (grabOffsetPx = startX - startFrameX). The dragRef in DemoV2.tsx
// already stores both startX and startFrameX, so the offset is free.
//
// This test exercises a tiny pure helper `landingGridFromCursor` that
// performs the translation. It also clamps row to [0, docLines-1] to
// preserve the doc-bound guard already enforced at the call site.

import { describe, it, expect } from "vitest";
import { landingGridFromCursor } from "./editorState";

const cw = 8;
const ch = 18;

describe("landingGridFromCursor — translate cursor-at-mouseup to frame landing position", () => {
  it("vertical-only drag: frame col equals original col regardless of grab offset", () => {
    // Frame originally at gridCol=0, gridRow=2, w=16cw (center grab at col 8).
    // User grabbed center: startFrameX=0, startX=8*cw → grabOffsetPx = 8*cw.
    // Cursor moves straight down 100px (no horizontal motion).
    // upPx is still at column 8 (cursor center).
    const startFrameX = 0;
    const startFrameY = 2 * ch;
    const startX = 8 * cw; // grab at horizontal center
    const startY = startFrameY + ch * 2; // grab at vertical center (h=4ch)
    const upPx = startX; // no horizontal motion
    const upPy = startY + 100;

    const grabOffsetPx = startX - startFrameX;
    const grabOffsetPy = startY - startFrameY;
    const docLines = 20;

    const { aRow, aCol } = landingGridFromCursor(
      upPx, upPy,
      grabOffsetPx, grabOffsetPy,
      cw, ch, docLines,
    );

    // Frame should land at the SAME col it started at (col 0), shifted
    // down by 100/ch ≈ 5.5 → 6 rows (rounded). Row 2 + 6 = 8.
    expect(aCol).toBe(0);
    expect(aRow).toBe(Math.round((startFrameY + 100) / ch));
  });

  it("edge-grab drag: aCol tracks frame-left, not cursor X", () => {
    // Frame at gridCol=4, gridRow=1, w=10cw. User grabbed near LEFT edge
    // (col 5, just inside the frame). Drags 50px to the right (no vertical).
    const startFrameX = 4 * cw;
    const startFrameY = 1 * ch;
    const startX = 5 * cw; // grab at col 5 (1 cell inside left edge)
    const startY = startFrameY + ch; // some vertical offset
    const upPx = startX + 50; // drag 50px right
    const upPy = startY;

    const grabOffsetPx = startX - startFrameX; // = 1*cw
    const grabOffsetPy = startY - startFrameY;
    const docLines = 20;

    const { aRow, aCol } = landingGridFromCursor(
      upPx, upPy,
      grabOffsetPx, grabOffsetPy,
      cw, ch, docLines,
    );

    // Frame-left at mouseup = upPx - grabOffsetPx = 5*cw + 50 - 1*cw = 4*cw + 50.
    // aCol = round((4*cw + 50) / cw) = 4 + round(50/8) = 4 + 6 = 10.
    expect(aCol).toBe(10);
    // No vertical motion, so aRow stays at row 1.
    expect(aRow).toBe(1);
  });

  it("clamps aRow to [0, docLines-1]", () => {
    // Cursor lands well past doc end; should clamp to docLines-1.
    const docLines = 8;
    const { aRow } = landingGridFromCursor(
      100, 1000,
      0, 0,
      cw, ch, docLines,
    );
    expect(aRow).toBe(docLines - 1);
  });

  it("clamps aRow to 0 for negative landing", () => {
    const docLines = 8;
    const { aRow } = landingGridFromCursor(
      100, -50,
      0, 0,
      cw, ch, docLines,
    );
    expect(aRow).toBe(0);
  });

  it("clamps aCol to 0 (no negative columns)", () => {
    const docLines = 20;
    // Frame at col 2, grab at col 4 (2 cells in), drag 80px left
    // → frame-left at mouseup = 4*cw + (-80) - 2*cw = 2*cw - 80 < 0.
    const startFrameX = 2 * cw;
    const startX = 4 * cw;
    const upPx = startX - 80;
    const grabOffsetPx = startX - startFrameX;
    const { aCol } = landingGridFromCursor(
      upPx, 0,
      grabOffsetPx, 0,
      cw, ch, docLines,
    );
    expect(aCol).toBe(0);
  });
});
