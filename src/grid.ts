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

export const CANVAS_PADDING = 5; // cells of empty space beyond content

const FALLBACK_CHAR_WIDTH = 9.6;  // typical 16px Menlo
const FALLBACK_CHAR_HEIGHT = 18.4;

// ── Glyph atlas ─────────────────────────────────────────

export interface GlyphAtlas {
  canvas: HTMLCanvasElement;
  glyphs: Map<string, { sx: number; sy: number }>;
  cellWidth: number;
  cellHeight: number;
}

export function buildGlyphAtlas(charWidth: number, charHeight: number): GlyphAtlas {
  const chars: string[] = [];
  // Printable ASCII: 32 (space) through 126 (~) = 95 chars
  for (let code = 32; code <= 126; code++) chars.push(String.fromCharCode(code));
  // Box-drawing: U+2500 through U+257F = 128 chars
  for (let code = 0x2500; code <= 0x257f; code++) chars.push(String.fromCharCode(code));

  const cols = 16;
  const rows = Math.ceil(chars.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(cols * charWidth);
  canvas.height = Math.ceil(rows * charHeight);
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";

  const glyphs = new Map<string, { sx: number; sy: number }>();
  for (let i = 0; i < chars.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const sx = Math.round(col * charWidth);
    const sy = Math.round(row * charHeight);
    glyphs.set(chars[i], { sx, sy });
    ctx.fillText(chars[i], sx, sy);
  }

  return { canvas, glyphs, cellWidth: charWidth, cellHeight: charHeight };
}

let _glyphAtlas: GlyphAtlas | null = null;

export function getGlyphAtlas(): GlyphAtlas | null {
  return _glyphAtlas;
}

// ── Cell measurement ────────────────────────────────────

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
  // Fix 9: fallback for failed font load
  if (_charWidth < 4 || _charWidth > 40) _charWidth = FALLBACK_CHAR_WIDTH;
  if (_charHeight < 4 || _charHeight > 40) _charHeight = FALLBACK_CHAR_HEIGHT;
  _measured = true;
  _glyphAtlas = buildGlyphAtlas(_charWidth, _charHeight);
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

export function snapToGrid(
  px: number, py: number,
): { x: number; y: number } {
  return {
    x: Math.round(px / _charWidth) * _charWidth,
    y: Math.round(py / _charHeight) * _charHeight,
  };
}
