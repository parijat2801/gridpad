/**
 * spatialTextEdit.ts — pure text-grid edit logic for drag and resize operations.
 *
 * applyDragToText and applyResizeToText take the region text and layer data,
 * apply the transformation, and return the new text. No refs, no React, no state.
 *
 * applyLiveDrag and applyLiveResize compute updated layer cells/bbox for the
 * live preview during a mouse drag (before mouseUp commits to text).
 */

import type { Layer } from "./layers";
import type { Bbox } from "./types";
import { compositeLayers, regenerateCells, buildTextCells } from "./layers";
import type { ResizeEdge } from "./spatialHitTest";

export interface LiveDragResult {
  cells: Map<string, string>;
  newRow: number;
  newCol: number;
}

/**
 * Compute the updated cells and position for a live drag preview.
 * Returns null if nothing changed.
 */
export function applyLiveDrag(
  layer: Layer,
  startBbox: Bbox,
  dRow: number,
  dCol: number,
): LiveDragResult | null {
  const newRow = startBbox.row + dRow;
  const newCol = startBbox.col + dCol;
  if (layer.bbox.row === newRow && layer.bbox.col === newCol) return null;

  const rowDelta = newRow - layer.bbox.row;
  const colDelta = newCol - layer.bbox.col;
  const newCells = new Map<string, string>();
  for (const [key, val] of layer.cells) {
    const ci = key.indexOf(",");
    const r = Number(key.slice(0, ci)) + rowDelta;
    const c = Number(key.slice(ci + 1)) + colDelta;
    newCells.set(`${r},${c}`, val);
  }
  return { cells: newCells, newRow, newCol };
}

export interface WireframeTextEditResult {
  /** Updated layer cells */
  cells: Map<string, string>;
  /** Updated layer content string */
  content: string;
  /** Updated layer bbox */
  bbox: Bbox;
  /** Updated region text */
  regionText: string;
}

/**
 * Apply an in-place text edit to a wireframe text layer.
 * Returns updated layer state and region text. Pure — no mutations.
 */
export function applyWireframeTextEdit(
  regionText: string,
  layerBbox: Bbox,
  oldContent: string,
  newContent: string,
): WireframeTextEditResult {
  const oldWidth = [...oldContent].length;
  const { col, row } = layerBbox;
  const { cells, content: fc, bbox } = buildTextCells(row, col, newContent);
  const newBbox: Bbox = { ...bbox, w: Math.max(1, fc.length) };

  const lines = regionText.split("\n");
  if (row < lines.length) {
    const chars = [...lines[row]];
    const maxNeeded = col + Math.max(fc.length, oldWidth);
    while (chars.length < maxNeeded) chars.push(" ");
    for (let i = col; i < col + Math.max(fc.length, oldWidth); i++) chars[i] = " ";
    for (let i = 0; i < [...fc].length; i++) chars[col + i] = [...fc][i];
    lines[row] = chars.join("").trimEnd();
  }
  return { cells, content: fc, bbox: newBbox, regionText: lines.join("\n") };
}

export interface LiveResizeResult {
  bbox: Bbox;
  cells: Map<string, string>;
}

/**
 * Compute the updated bbox and cells for a live resize preview.
 * Returns null if nothing changed.
 */
export function applyLiveResize(
  layer: Layer,
  startBbox: Bbox,
  dRow: number,
  dCol: number,
  edges: ResizeEdge,
): LiveResizeResult | null {
  let newRow = startBbox.row, newCol = startBbox.col, newW = startBbox.w, newH = startBbox.h;
  if (edges.top) { newRow = startBbox.row + dRow; newH = startBbox.h - dRow; }
  if (edges.bottom) { newH = startBbox.h + dRow; }
  if (edges.left) { newCol = startBbox.col + dCol; newW = startBbox.w - dCol; }
  if (edges.right) { newW = startBbox.w + dCol; }
  if (newW < 2) newW = 2;
  if (newH < 2) newH = 2;
  const newBbox: Bbox = { row: newRow, col: newCol, w: newW, h: newH };
  if (layer.bbox.row === newBbox.row && layer.bbox.col === newBbox.col &&
      layer.bbox.w === newBbox.w && layer.bbox.h === newBbox.h) return null;
  const cells = layer.type === "rect" && layer.style
    ? regenerateCells(newBbox, layer.style)
    : layer.cells;
  return { bbox: newBbox, cells };
}

/**
 * Apply a completed drag (move) to the wireframe region's source text.
 *
 * Erases the layer's old cells from the text grid, then writes the new
 * cells. Other layers' characters are restored at the erased positions.
 *
 * @param regionText  - the region's current text (will not be mutated)
 * @param layers      - all layers in the region (current state, after move)
 * @param layerId     - id of the layer that was dragged
 * @param startBbox   - the layer's bbox before the drag started
 * @param totalRows   - number of rows in the region (endRow - startRow + 1)
 * @returns           - new region text with the drag applied
 */
export function applyDragToText(
  regionText: string,
  layers: Layer[],
  layerId: string,
  startBbox: Bbox,
  totalRows: number,
): string {
  const textLines = regionText.split("\n");
  const grid = buildGrid(textLines, totalRows);

  const movedLayer = layers.find(l => l.id === layerId);
  if (!movedLayer) return regionText;

  const dRow = movedLayer.bbox.row - startBbox.row;
  const dCol = movedLayer.bbox.col - startBbox.col;

  const otherComposite = compositeLayers(layers.filter(l => l.id !== layerId));

  // Erase old cells — restore the character from other layers if present
  for (const [key] of movedLayer.cells) {
    const [r, c] = parseKey(key);
    const origR = r - dRow;
    const origC = c - dCol;
    if (origR >= 0 && origR < grid.length && origC >= 0 && origC < (grid[origR]?.length ?? 0)) {
      grid[origR][origC] = otherComposite.get(`${origR},${origC}`) ?? " ";
    }
  }

  // Write new cells
  for (const [key, ch] of movedLayer.cells) {
    const [r, c] = parseKey(key);
    expandGrid(grid, r, c);
    grid[r][c] = ch;
  }

  return gridToText(grid);
}

/**
 * Apply a completed resize to the wireframe region's source text.
 *
 * Erases the old bbox cells from the text grid, then writes the
 * regenerated cells. Other layers' characters are restored.
 *
 * @param regionText  - the region's current text
 * @param layers      - all layers in the region (current state, after resize)
 * @param layerId     - id of the layer that was resized
 * @param startBbox   - the layer's bbox before the resize started
 * @param totalRows   - number of rows in the region
 * @returns           - new region text with the resize applied
 */
export function applyResizeToText(
  regionText: string,
  layers: Layer[],
  layerId: string,
  startBbox: Bbox,
  totalRows: number,
): string {
  const textLines = regionText.split("\n");
  const grid = buildGrid(textLines, totalRows);

  const resizedLayer = layers.find(l => l.id === layerId);
  if (!resizedLayer) return regionText;

  const otherComposite = compositeLayers(layers.filter(l => l.id !== layerId));

  // Erase old bbox area (using start bbox)
  eraseOldCells(grid, startBbox, otherComposite);

  // Write new cells
  for (const [key, ch] of resizedLayer.cells) {
    const [r, c] = parseKey(key);
    expandGrid(grid, r, c);
    grid[r][c] = ch;
  }

  return gridToText(grid);
}

// ── Private helpers ──────────────────────────────────────────────────────────

function parseKey(key: string): [number, number] {
  const ci = key.indexOf(",");
  return [Number(key.slice(0, ci)), Number(key.slice(ci + 1))];
}

function buildGrid(textLines: string[], totalRows: number): string[][] {
  const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
  const grid: string[][] = textLines.map(l => {
    const chars = [...l];
    while (chars.length < maxCols) chars.push(" ");
    return chars;
  });
  while (grid.length < totalRows) grid.push(new Array(maxCols).fill(" "));
  return grid;
}

function expandGrid(grid: string[][], r: number, c: number): void {
  while (grid.length <= r) grid.push([]);
  if (!grid[r]) grid[r] = [];
  while (grid[r].length <= c) grid[r].push(" ");
}

function eraseOldCells(
  grid: string[][],
  oldBbox: Bbox,
  otherComposite: Map<string, string>,
): void {
  const { row, col, w, h } = oldBbox;
  // Erase full bounding box perimeter rows/cols
  for (let r = row; r < row + h; r++) {
    for (let c = col; c < col + w; c++) {
      if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
        grid[r][c] = otherComposite.get(`${r},${c}`) ?? " ";
      }
    }
  }
}

function gridToText(grid: string[][]): string {
  return grid.map(row => row.join("").trimEnd()).join("\n");
}
