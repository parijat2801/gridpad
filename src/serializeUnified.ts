// src/serializeUnified.ts
// Single-pass serialization for the unified document model.

import type { Frame } from "./frame";
import { repairJunctions } from "./gridSerialize";

/**
 * Serialize the unified CM doc back to a .md file.
 *
 * @param doc - The CM doc text (prose lines preserved; wireframe lines are "")
 * @param frames - Top-level frames with gridRow + lineCount set
 * @returns The reconstructed .md text
 */
export function serializeUnified(doc: string, frames: Frame[]): string {
  if (!doc) return "";

  const docLines = doc.split("\n");

  // Map: source line index → frames claiming that line.
  // Use gridRow directly — it is the absolute line number, invariant across
  // doc content changes (wireframe lines being replaced with " ").
  const lineToFrames = buildLineToFrames(frames);

  // Walk doc lines and build output.
  const outputLines = buildOutputLines(docLines, lineToFrames);

  // Repair junctions where frame borders meet.
  const grid = outputLines.map(line => [...line]);
  repairJunctions(grid);

  const result = grid.map(row => row.join("").trimEnd());
  while (result.length > 0 && result[result.length - 1] === "") result.pop();
  return result.join("\n");
}

/** Build a map from absolute line index → frames that claim that line.
 * Uses gridRow directly — the absolute line number in the document. */
function buildLineToFrames(frames: Frame[]): Map<number, Frame[]> {
  const map = new Map<number, Frame[]>();
  for (const f of frames) {
    if (f.lineCount === 0) continue;
    for (let i = 0; i < f.lineCount; i++) {
      const ln = f.gridRow + i;
      if (!map.has(ln)) map.set(ln, []);
      map.get(ln)!.push(f);
    }
  }
  return map;
}

/** Build output lines by walking doc lines and rendering claimed ones. */
function buildOutputLines(
  docLines: string[],
  lineToFrames: Map<number, Frame[]>,
): string[] {
  const output: string[] = [];
  for (let i = 0; i < docLines.length; i++) {
    const claimingFrames = lineToFrames.get(i);
    if (!claimingFrames || claimingFrames.length === 0) {
      output.push(docLines[i]);
      continue;
    }
    // Wireframe line — render frame cells at this row.
    const rowChars: string[] = [];
    for (const f of claimingFrames) {
      const localRow = i - f.gridRow;
      renderFrameRow(f, localRow, f.gridCol, rowChars);
    }
    output.push(rowChars.join("").trimEnd());
  }
  return output;
}

/**
 * Render one row of a frame (and its children) into the rowChars array.
 * localRow is relative to the frame's own top (0 = first row of the frame).
 * colOffset is the absolute column where this frame starts.
 */
function renderFrameRow(
  frame: Frame,
  localRow: number,
  colOffset: number,
  rowChars: string[],
): void {
  if (localRow < 0 || localRow >= frame.gridH) return;

  if (frame.content) {
    for (const [key, ch] of frame.content.cells) {
      const ci = key.indexOf(",");
      const cellRow = Number(key.slice(0, ci));
      const cellCol = Number(key.slice(ci + 1));
      if (cellRow === localRow) {
        const absCol = colOffset + cellCol;
        while (rowChars.length <= absCol) rowChars.push(" ");
        if (ch !== " " || rowChars[absCol] === " ") {
          rowChars[absCol] = ch;
        }
      }
    }
  }

  for (const child of frame.children) {
    const childLocalRow = localRow - child.gridRow;
    renderFrameRow(child, childLocalRow, colOffset + child.gridCol, rowChars);
  }
}
