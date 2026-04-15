// Grid constants and runtime cell-size measurement.

export const FONT_SIZE = 16;
export const FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace';
export const FG_COLOR = "#e0e0e0";

let _charWidth = 0;
let _charHeight = 0;
let _measured = false;

const FALLBACK_CHAR_WIDTH = 9.6;
const FALLBACK_CHAR_HEIGHT = 18.4;

export async function measureCellSize(): Promise<{
  charWidth: number;
  charHeight: number;
}> {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  const sample = "M┌─┐│└─┘ABCDEFGHIJ";
  _charWidth = ctx.measureText(sample).width / sample.length;
  const metrics = ctx.measureText("M");
  _charHeight =
    metrics.actualBoundingBoxAscent !== undefined
      ? (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) * 1.15
      : FONT_SIZE * 1.25;
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
