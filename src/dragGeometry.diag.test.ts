// Pin Bug B's geometry invariant: when a user grabs a frame at
// position P_grab inside the frame and drags so that the cursor at
// mouseup is at P_drop, the frame's TOP-LEFT must land at
// P_drop - (P_grab - frameTopLeft). Equivalently, the point on the
// frame the user grabbed must end up at the cursor.
//
// Before the fix, the code computed `aRow/aCol` from the cursor
// position alone (`round(upPx/cw)`, `round(upPy/ch)`), placing the
// FRAME's top-left at the cursor — i.e., for a center-grab drag,
// the frame shifted by w/2 columns and h/2 rows.
//
// This file tests the helper directly with realistic
// (frame, grab, cursor) tuples and asserts the post-mouseup
// landing position matches the grab invariant.

import { describe, it, expect } from "vitest";
import { landingGridFromCursor } from "./editorState";

const cw = 9.6;
const ch = 18.4;

interface Frame { gridCol: number; gridRow: number; gridW: number; gridH: number; }

// Compute the landing position when the user grabs a frame at
// (grabColInFrame, grabRowInFrame) cells from its top-left and
// releases so the cursor is at (cursorPx, cursorPy).
function landingFor(
  frame: Frame,
  grabColInFrame: number,
  grabRowInFrame: number,
  cursorPx: number,
  cursorPy: number,
  docLines: number,
) {
  // Cursor at mousedown was AT the grab cell, in canvas coords.
  const startX = (frame.gridCol + grabColInFrame) * cw;
  const startY = (frame.gridRow + grabRowInFrame) * ch;
  const startFrameX = frame.gridCol * cw;
  const startFrameY = frame.gridRow * ch;
  return landingGridFromCursor(
    cursorPx, cursorPy,
    startX - startFrameX, startY - startFrameY,
    cw, ch, docLines,
  );
}

describe("drag geometry invariant — grabbed point follows cursor", () => {
  it("center grab: frame center lands at cursor", () => {
    const frame: Frame = { gridCol: 4, gridRow: 2, gridW: 16, gridH: 6 };
    // Drop cursor at column 30, row 14 (well into the doc body).
    const cursorPx = 30 * cw;
    const cursorPy = 14 * ch;
    const { aRow, aCol } = landingFor(
      frame, frame.gridW / 2, frame.gridH / 2, cursorPx, cursorPy, 30,
    );
    // Frame center should land at (30, 14) ⇒ frame top-left at
    // (30 - 8, 14 - 3) = (22, 11).
    expect(aCol).toBe(22);
    expect(aRow).toBe(11);
  });

  it("top-left grab: frame top-left lands at cursor", () => {
    const frame: Frame = { gridCol: 4, gridRow: 2, gridW: 16, gridH: 6 };
    const cursorPx = 30 * cw;
    const cursorPy = 14 * ch;
    const { aRow, aCol } = landingFor(frame, 0, 0, cursorPx, cursorPy, 30);
    expect(aCol).toBe(30);
    expect(aRow).toBe(14);
  });

  it("bottom-right grab: frame top-left = cursor - (w-1, h-1)", () => {
    const frame: Frame = { gridCol: 4, gridRow: 2, gridW: 16, gridH: 6 };
    const cursorPx = 30 * cw;
    const cursorPy = 14 * ch;
    const { aRow, aCol } = landingFor(
      frame, frame.gridW - 1, frame.gridH - 1, cursorPx, cursorPy, 30,
    );
    expect(aCol).toBe(30 - (frame.gridW - 1));
    expect(aRow).toBe(14 - (frame.gridH - 1));
  });

  it("vertical-only drag: column unchanged regardless of grab offset", () => {
    const frame: Frame = { gridCol: 4, gridRow: 2, gridW: 16, gridH: 6 };
    // Cursor stays at the original grab X, drops 7 rows down.
    const grabColInFrame = frame.gridW / 2;
    const startX = (frame.gridCol + grabColInFrame) * cw;
    const startY = (frame.gridRow + frame.gridH / 2) * ch;
    const cursorPx = startX;            // pure vertical drag
    const cursorPy = startY + 7 * ch;
    const { aRow, aCol } = landingFor(
      frame, grabColInFrame, frame.gridH / 2, cursorPx, cursorPy, 30,
    );
    // Frame col MUST equal original (no horizontal motion).
    expect(aCol).toBe(frame.gridCol);
    // Frame row should be original + 7.
    expect(aRow).toBe(frame.gridRow + 7);
  });

  it("horizontal-only drag: row unchanged regardless of grab offset", () => {
    const frame: Frame = { gridCol: 4, gridRow: 2, gridW: 16, gridH: 6 };
    const startX = (frame.gridCol + 3) * cw;     // grabbed at col 7 (3 in)
    const startY = (frame.gridRow + 4) * ch;     // grabbed at row 6 (4 in)
    const cursorPx = startX + 11 * cw;            // 11 cols right
    const cursorPy = startY;
    const { aRow, aCol } = landingFor(frame, 3, 4, cursorPx, cursorPy, 30);
    expect(aRow).toBe(frame.gridRow);
    expect(aCol).toBe(frame.gridCol + 11);
  });
});
