import type { PositionedLine } from "./reflowLayout";

export interface CursorLineResult {
  x: number;
  y: number;
}

/**
 * Find the pixel position for a prose cursor given reflowed lines.
 * Uses last-matching-line algorithm: walks all lines to find the best match
 * for wrapped text, with fallbacks for empty lines and empty documents.
 */
export function findCursorLine(
  cursor: { row: number; col: number },
  lines: PositionedLine[],
  charWidth: number,
  lineHeight: number,
): CursorLineResult {
  let targetLine: PositionedLine | null = null;
  let lastLineBefore: PositionedLine | null = null;
  for (const pl of lines) {
    if (pl.sourceLine === cursor.row &&
        pl.sourceCol <= cursor.col) {
      targetLine = pl;
    }
    if (pl.sourceLine < cursor.row) {
      lastLineBefore = pl;
    }
  }
  if (targetLine) {
    return {
      x: targetLine.x + (cursor.col - targetLine.sourceCol) * charWidth,
      y: targetLine.y,
    };
  } else if (lastLineBefore) {
    // Empty line fallback (e.g., \n\n separator navigated via arrow keys)
    return {
      x: 0,
      y: lastLineBefore.y + lineHeight * (cursor.row - lastLineBefore.sourceLine),
    };
  }
  // Empty document fallback — position cursor at correct row
  return { x: 0, y: cursor.row * lineHeight };
}
