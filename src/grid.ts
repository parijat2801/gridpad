// Grid constants and runtime cell-size measurement.
//
// Cell size derives from theme: monospace font + width/height multipliers.
// The 1.4 factor that used to be hardcoded in the line-height calc now lives
// in theme.charHeightMultiplier so the panel can tune row spacing live.
// Call sites that need raw font/color reads should import from ./theme.

import { theme, wireframeFont } from "./theme";

let _charWidth = 0;
let _charHeight = 0;
let _measured = false;

const FALLBACK_CHAR_WIDTH = 9.6;
const FALLBACK_CHAR_HEIGHT = 22.4;

export async function measureCellSize(): Promise<{
  charWidth: number;
  charHeight: number;
}> {
  // Wait specifically for the wireframe font we're about to measure with.
  // `document.fonts.ready` covers initial load only; on theme changes we may
  // be measuring a font that was added to the document after first paint.
  try {
    await document.fonts.load(wireframeFont());
  } catch {
    // Font load can fail in environments without the requested font; the
    // canvas measurement below will fall back to the system monospace and
    // the clamps at the bottom will sanity-check the result.
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { charWidth: FALLBACK_CHAR_WIDTH, charHeight: FALLBACK_CHAR_HEIGHT };

  const fontSize = theme.wireframeFontSize;
  ctx.font = wireframeFont();

  const sample = "M┌─┐│└─┘ABCDEFGHIJ";
  const measuredWidth = ctx.measureText(sample).width / sample.length;
  _charWidth = measuredWidth * theme.charWidthMultiplier;

  const metrics = ctx.measureText("M");
  const baseHeight =
    metrics.actualBoundingBoxAscent !== undefined
      ? (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)
      : fontSize * 1.07; // approx ascent+descent ratio when bbox unavailable
  _charHeight = baseHeight * theme.charHeightMultiplier;

  // Sanity clamps guard against pathological multipliers AND measurement bugs.
  if (_charWidth < 4 || _charWidth > 40) _charWidth = FALLBACK_CHAR_WIDTH;
  if (_charHeight < 4 || _charHeight > 40) _charHeight = FALLBACK_CHAR_HEIGHT;
  _measured = true;
  return { charWidth: _charWidth, charHeight: _charHeight };
}

export function getCharWidth(): number {
  if (!_measured) throw new Error("measureCellSize not called yet");
  return _charWidth;
}

export function getCharHeight(): number {
  if (!_measured) throw new Error("measureCellSize not called yet");
  return _charHeight;
}
