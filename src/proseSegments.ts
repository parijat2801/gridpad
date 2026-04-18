// src/proseSegments.ts

export interface ProseSegment {
  row: number;
  col: number;
  text: string;
}

/**
 * Extract prose segments from scanner's unclaimed cells.
 * Groups consecutive unclaimed cells on the same row into runs.
 * Rows with no unclaimed cells and not covered by any frame bbox
 * emit { row, col: 0, text: "" } to preserve paragraph spacing.
 */
export function extractProseSegments(
  unclaimedCells: Map<string, string>,
  grid: string[][],
  frameBboxes: { row: number; col: number; w: number; h: number }[],
): ProseSegment[] {
  if (grid.length === 0) return [];

  // Build set of rows covered by frame bboxes
  const frameCoveredRows = new Set<number>();
  for (const bbox of frameBboxes) {
    for (let r = bbox.row; r < bbox.row + bbox.h; r++) {
      frameCoveredRows.add(r);
    }
  }

  // Group unclaimed cells by row, then sort by col within each row
  const rowMap = new Map<number, { col: number; ch: string }[]>();
  for (const [key, ch] of unclaimedCells) {
    const ci = key.indexOf(",");
    const r = Number(key.slice(0, ci));
    const c = Number(key.slice(ci + 1));
    let arr = rowMap.get(r);
    if (!arr) { arr = []; rowMap.set(r, arr); }
    arr.push({ col: c, ch });
  }

  const segments: ProseSegment[] = [];

  for (let r = 0; r < grid.length; r++) {
    const cells = rowMap.get(r);
    if (!cells || cells.length === 0) {
      // No unclaimed cells on this row
      if (!frameCoveredRows.has(r)) {
        // Not covered by frame → blank separator
        segments.push({ row: r, col: 0, text: "" });
      }
      continue;
    }

    // Sort by column
    cells.sort((a, b) => a.col - b.col);

    // Group into contiguous runs
    let runStart = cells[0].col;
    let runChars: string[] = [cells[0].ch];
    let prevCol = cells[0].col;

    for (let i = 1; i < cells.length; i++) {
      if (cells[i].col === prevCol + 1) {
        runChars.push(cells[i].ch);
        prevCol = cells[i].col;
      } else {
        segments.push({ row: r, col: runStart, text: runChars.join("") });
        runStart = cells[i].col;
        runChars = [cells[i].ch];
        prevCol = cells[i].col;
      }
    }
    segments.push({ row: r, col: runStart, text: runChars.join("") });
  }

  return segments;
}
