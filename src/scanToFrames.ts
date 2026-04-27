// src/scanToFrames.ts
import { scan } from "./scanner";
import { framesFromScan, type Frame } from "./frame";
import { extractProseSegments, type ProseSegment } from "./proseSegments";

/**
 * Build a map of prose character positions from scanner texts.
 * The scanner's unclaimedCells excludes text characters (they are "textClaimed").
 * For prose extraction we treat scanner texts as prose character source, and
 * include intervening spaces between text runs on the same row so that
 * "Hello world" (two ScannedText entries) becomes one contiguous run.
 */
function buildProseCells(
  texts: { row: number; col: number; content: string }[],
  grid: string[][],
): Map<string, string> {
  // Group texts by row, find min/max col span per row
  const rowSpans = new Map<number, { minCol: number; maxCol: number }>();
  for (const t of texts) {
    const end = t.col + t.content.length - 1;
    const existing = rowSpans.get(t.row);
    if (!existing) {
      rowSpans.set(t.row, { minCol: t.col, maxCol: end });
    } else {
      existing.minCol = Math.min(existing.minCol, t.col);
      existing.maxCol = Math.max(existing.maxCol, end);
    }
  }

  const proseCells = new Map<string, string>();
  for (const [row, { minCol, maxCol }] of rowSpans) {
    // Include all grid chars in the span [minCol, maxCol], including spaces
    for (let col = minCol; col <= maxCol; col++) {
      const ch = grid[row]?.[col];
      if (ch !== undefined) {
        proseCells.set(`${row},${col}`, ch !== "" ? ch : " ");
      }
    }
  }
  return proseCells;
}

export function scanToFrames(
  text: string,
  charWidth: number,
  charHeight: number,
): {
  frames: Frame[];
  proseSegments: ProseSegment[];
  originalGrid: string[][];
} {
  const scanResult = scan(text);
  const frames = framesFromScan(scanResult, charWidth, charHeight);

  // Compute docOffset + lineCount from source text line offsets.
  // A top-level frame's gridRow is its 0-indexed source line number.
  const sourceLines = text.split("\n");
  const lineOffsets: number[] = [];
  {
    let offset = 0;
    for (let i = 0; i < sourceLines.length; i++) {
      lineOffsets.push(offset);
      offset += sourceLines[i].length + 1; // +1 for \n
    }
  }
  for (const f of frames) {
    const startLine = f.gridRow;
    if (startLine >= 0 && startLine < lineOffsets.length) {
      f.docOffset = lineOffsets[startLine];
      f.lineCount = f.gridH;
    }
  }

  // Collect frame bboxes for prose extraction
  const frameBboxes = scanResult.rects.map(r => ({
    row: r.row, col: r.col, w: r.w, h: r.h,
  }));
  for (const line of scanResult.lines) {
    const minR = Math.min(line.r1, line.r2);
    const maxR = Math.max(line.r1, line.r2);
    const minC = Math.min(line.c1, line.c2);
    const maxC = Math.max(line.c1, line.c2);
    frameBboxes.push({ row: minR, col: minC, w: maxC - minC + 1, h: maxR - minR + 1 });
  }

  // Build prose cells from scanner texts — but EXCLUDE text labels inside rects.
  // Text inside a rect is wireframe content (rendered by frame cells), not prose.
  const proseTexts = scanResult.texts.filter(t => {
    for (const bbox of frameBboxes) {
      if (
        t.row >= bbox.row && t.row < bbox.row + bbox.h &&
        t.col >= bbox.col && t.col + t.content.length <= bbox.col + bbox.w
      ) return false; // inside a frame bbox — not prose
    }
    return true;
  });
  const proseCells = buildProseCells(proseTexts, scanResult.grid);

  const proseSegments = extractProseSegments(
    proseCells,
    scanResult.grid,
    frameBboxes,
  );

  return { frames, proseSegments, originalGrid: scanResult.grid };
}
