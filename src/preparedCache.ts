import { prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext";
import { PROSE_FONT_MEASURE } from "./textFont";

const PREPARE_OPTS = { whiteSpace: "pre-wrap" as const };

export type PreparedCache = (PreparedTextWithSegments | null)[];

/** Prepare each line of text independently. Called on loadDocument and undo/redo. */
export function buildPreparedCache(text: string): PreparedCache {
  const lines = text.split("\n");
  return lines.map(line =>
    line.length > 0 ? prepareWithSegments(line, PROSE_FONT_MEASURE, PREPARE_OPTS) : null
  );
}

/** Re-prepare a single line. Called on character insert/delete keystrokes. */
export function invalidateLine(
  cache: PreparedCache,
  lineNum: number,
  newLineText: string,
): void {
  if (lineNum < 0 || lineNum >= cache.length) {
    throw new RangeError(`invalidateLine: lineNum ${lineNum} out of bounds [0, ${cache.length - 1}]`);
  }
  cache[lineNum] = newLineText.length > 0
    ? prepareWithSegments(newLineText, PROSE_FONT_MEASURE, PREPARE_OPTS)
    : null;
}

/** Split one line into two (Enter key). Re-prepares both halves. */
export function splitLine(
  cache: PreparedCache,
  row: number,
  firstLineText: string,
  secondLineText: string,
): void {
  if (row < 0 || row >= cache.length) {
    throw new RangeError(`splitLine: row ${row} out of bounds [0, ${cache.length - 1}]`);
  }
  cache[row] = firstLineText.length > 0
    ? prepareWithSegments(firstLineText, PROSE_FONT_MEASURE, PREPARE_OPTS)
    : null;
  cache.splice(row + 1, 0,
    secondLineText.length > 0
      ? prepareWithSegments(secondLineText, PROSE_FONT_MEASURE, PREPARE_OPTS)
      : null
  );
}

/** Merge two lines into one (Backspace at col 0). Removes current line, re-prepares the one above. */
export function mergeLines(
  cache: PreparedCache,
  row: number,
  mergedLineText: string,
): void {
  if (row < 1 || row >= cache.length) {
    throw new RangeError(`mergeLines: row ${row} out of bounds [1, ${cache.length - 1}]`);
  }
  cache.splice(row, 1);
  cache[row - 1] = mergedLineText.length > 0
    ? prepareWithSegments(mergedLineText, PROSE_FONT_MEASURE, PREPARE_OPTS)
    : null;
}
