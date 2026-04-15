import type { ScanResult } from "./scanner";
import { buildLayersFromScan } from "./layers";
import type { Layer } from "./layers";

export interface Region {
  type: "prose" | "wireframe";
  startRow: number;
  endRow: number;
  /** Original text lines joined with \n */
  text: string;
  /** For wireframe regions: layers with row-rebased coordinates */
  layers?: Layer[];
}

// Unicode box-drawing characters used to identify wireframe lines.
// Excludes ASCII - | + which are markdown/prose characters.
const BOX_CHARS = new Set([
  "─", "━", "═", "│", "║",
  "┌", "┐", "└", "┘",
  "├", "┤", "┬", "┴", "┼",
  "╔", "╗", "╚", "╝", "╠", "╣", "╦", "╩", "╬",
  "╤", "╧", "╟", "╢", "╪", "╫",
]);

/**
 * Split a scan result into alternating prose/wireframe regions.
 *
 * 1. Collect row ranges from detected rects (always wireframe).
 * 2. For detected lines, check if the line's actual cells contain
 *    Unicode box-drawing chars (not ASCII dashes). Only include those.
 * 3. Expand each range by 1 row margin, merge overlapping/adjacent
 *    ranges (gap ≤ 2).
 * 4. Everything outside wireframe ranges is prose.
 */
export function detectRegions(scanResult: ScanResult): Region[] {
  const { rects, lines, grid } = scanResult;
  if (grid.length === 0) return [];

  const shapeRanges: { start: number; end: number }[] = [];

  // Rects are always wireframe
  for (const r of rects) {
    shapeRanges.push({
      start: Math.max(0, r.row - 1),
      end: Math.min(grid.length - 1, r.row + r.h),
    });
  }

  // Lines: only include if they contain actual box-drawing chars
  for (const l of lines) {
    const minR = Math.min(l.r1, l.r2);
    const maxR = Math.max(l.r1, l.r2);
    const minC = Math.min(l.c1, l.c2);
    const maxC = Math.max(l.c1, l.c2);

    let hasBoxChar = false;
    for (let r = minR; r <= maxR && !hasBoxChar; r++) {
      const row = grid[r];
      if (!row) continue;
      for (let c = minC; c <= maxC && !hasBoxChar; c++) {
        if (BOX_CHARS.has(row[c] ?? "")) hasBoxChar = true;
      }
    }
    if (!hasBoxChar) continue;

    shapeRanges.push({
      start: Math.max(0, minR - 1),
      end: Math.min(grid.length - 1, maxR + 1),
    });
  }

  if (shapeRanges.length === 0) {
    // Pure prose
    const text = gridSliceToText(grid, 0, grid.length - 1);
    if (text.length === 0) return [];
    return [{ type: "prose", startRow: 0, endRow: grid.length - 1, text }];
  }

  // Sort and merge overlapping/close ranges (gap ≤ 2)
  shapeRanges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [{ ...shapeRanges[0] }];
  for (let i = 1; i < shapeRanges.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = shapeRanges[i];
    if (cur.start <= prev.end + 2) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }

  // Build regions
  const regions: Region[] = [];
  let currentRow = 0;

  for (const wf of merged) {
    // Prose before wireframe
    if (currentRow < wf.start) {
      const text = gridSliceToText(grid, currentRow, wf.start - 1);
      if (text.length > 0) {
        regions.push({
          type: "prose",
          startRow: currentRow,
          endRow: wf.start - 1,
          text,
        });
      }
    }

    // Wireframe region
    const layers = buildLayersForRegion(scanResult, wf.start, wf.end);
    regions.push({
      type: "wireframe",
      startRow: wf.start,
      endRow: wf.end,
      text: gridSliceToText(grid, wf.start, wf.end),
      layers,
    });

    currentRow = wf.end + 1;
  }

  // Trailing prose
  if (currentRow < grid.length) {
    const text = gridSliceToText(grid, currentRow, grid.length - 1);
    if (text.length > 0) {
      regions.push({
        type: "prose",
        startRow: currentRow,
        endRow: grid.length - 1,
        text,
      });
    }
  }

  return regions;
}

function gridSliceToText(grid: string[][], startRow: number, endRow: number): string {
  const lines: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    lines.push((grid[r] ?? []).join("").trimEnd());
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * Build layers for shapes overlapping [startRow, endRow].
 * Rebases both bbox.row and cell keys to be relative to startRow.
 */
function buildLayersForRegion(
  scanResult: ScanResult,
  startRow: number,
  endRow: number,
): Layer[] {
  const layers = buildLayersFromScan(scanResult);
  return layers
    .filter((l) => {
      const layerEnd = l.bbox.row + l.bbox.h - 1;
      return layerEnd >= startRow && l.bbox.row <= endRow;
    })
    .map((l) => ({
      ...l,
      bbox: { ...l.bbox, row: l.bbox.row - startRow },
      cells: rebaseCellRows(l.cells, startRow),
    }));
}

function rebaseCellRows(
  cells: Map<string, string>,
  startRow: number,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, ch] of cells) {
    const i = key.indexOf(",");
    const r = Number(key.slice(0, i)) - startRow;
    const c = key.slice(i + 1);
    result.set(`${r},${c}`, ch);
  }
  return result;
}
