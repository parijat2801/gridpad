// Grid constants and runtime cell-size measurement.

export const GRID_WIDTH = 100;
export const GRID_HEIGHT = 40;
export const FONT_SIZE = 16;
export const FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace';
export const BG_COLOR = "#1a1a1a";
export const FG_COLOR = "#e0e0e0";
export const SELECTION_BG = "#2d4a66";

let _charWidth = 0;
let _charHeight = 0;
let _measured = false;

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

export function pixelToCell(px: number, py: number): { row: number; col: number } {
  return {
    row: Math.floor(py / _charHeight),
    col: Math.floor(px / _charWidth),
  };
}

export function cellToPixel(row: number, col: number): { x: number; y: number } {
  return {
    x: col * _charWidth,
    y: row * _charHeight,
  };
}
