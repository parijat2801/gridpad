// Grid constants and runtime cell-size measurement.
//
// Cell size derives from theme: monospace font + width/height multipliers.
// `charHeight` is the unified row height for the whole document — both prose
// lines and wireframe rows advance by it. Because prose and wireframes use
// different fonts at potentially different sizes, the row must accommodate
// the taller of the two; otherwise prose glyphs spill into the next row.

import { theme, wireframeFont, proseFontMeasure } from "./theme";

let _charWidth = 0;
let _charHeight = 0;
let _measured = false;

const FALLBACK_CHAR_WIDTH = 9.6;
const FALLBACK_CHAR_HEIGHT = 22.4;

/** Measure (ascent + descent) for `font` using a sample glyph. Falls back
 * to `fontSize * 1.07` if the canvas API doesn't expose actualBoundingBox. */
function measureGlyphHeight(ctx: CanvasRenderingContext2D, font: string, fontSize: number): number {
  ctx.font = font;
  const metrics = ctx.measureText("M");
  return metrics.actualBoundingBoxAscent !== undefined
    ? (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent)
    : fontSize * 1.07;
}

export async function measureCellSize(): Promise<{
  charWidth: number;
  charHeight: number;
}> {
  // Wait for both fonts before measuring so we don't pick up the system
  // fallback. document.fonts.load is idempotent — already-loaded fonts
  // resolve immediately.
  try {
    await Promise.all([
      document.fonts.load(wireframeFont()),
      document.fonts.load(proseFontMeasure()),
    ]);
  } catch {
    // Font load can fail in environments without the requested font; the
    // canvas measurement below will fall back to the system monospace and
    // the clamps at the bottom will sanity-check the result.
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { charWidth: FALLBACK_CHAR_WIDTH, charHeight: FALLBACK_CHAR_HEIGHT };

  ctx.font = wireframeFont();
  const sample = "M┌─┐│└─┘ABCDEFGHIJ";
  const measuredWidth = ctx.measureText(sample).width / sample.length;
  _charWidth = measuredWidth * theme.charWidthMultiplier;

  // The unified row must fit the tallest glyph from either font. Pick the
  // larger of (wireframe ascent+descent, prose ascent+descent) as the
  // base, then apply the row-height multiplier on top.
  const wireBase = measureGlyphHeight(ctx, wireframeFont(), theme.wireframeFontSize);
  const proseBase = measureGlyphHeight(ctx, proseFontMeasure(), theme.proseFontSize);
  const baseHeight = Math.max(wireBase, proseBase);
  _charHeight = baseHeight * theme.charHeightMultiplier;

  // Sanity clamps. Width: a monospace cell narrower than 4px or wider than
  // 60px is almost certainly broken. Height: 96px ceiling accommodates
  // 32px font × 2.0 row multiplier with descender slack and still flags
  // pathological readings.
  if (_charWidth < 4 || _charWidth > 60) _charWidth = FALLBACK_CHAR_WIDTH;
  if (_charHeight < 4 || _charHeight > 96) _charHeight = FALLBACK_CHAR_HEIGHT;
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
