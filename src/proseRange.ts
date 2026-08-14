// Prose selection ranges: ordering, text extraction, band-aware range
// deletion, highlight geometry, and word expansion. Pure logic — DemoV2
// owns the anchor/head refs and mouse/keyboard wiring.
//
// Invariant: range ENDPOINTS must sit on non-band rows. Bands claim whole
// contiguous row spans, so a range whose endpoints are outside every claim
// contains each overlapped band entirely — deletion can remove the band via
// applyDeleteFrame (which releases its claim lines through the unified
// pipeline) and then delete the remaining pure-prose span in one change.

import type { EditorState } from "@codemirror/state";
import { Transaction } from "@codemirror/state";
import type { CursorPos } from "./proseCursor";
import type { PositionedLine } from "./reflowLayout";
import type { Frame } from "./frame";
import { applyDeleteFrame, getFrames, rowColToPos } from "./editorState";

export interface RangeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return [...graphemeSegmenter.segment(text)].map(s => s.segment);
}

export function cmpPos(a: CursorPos, b: CursorPos): number {
  return a.row !== b.row ? a.row - b.row : a.col - b.col;
}

/** Order two positions into { from, to }. */
export function orderRange(anchor: CursorPos, head: CursorPos): { from: CursorPos; to: CursorPos } {
  return cmpPos(anchor, head) <= 0 ? { from: anchor, to: head } : { from: head, to: anchor };
}

/** The doc text covered by [from, to). */
export function rangeText(state: EditorState, anchor: CursorPos, head: CursorPos): string {
  const { from, to } = orderRange(anchor, head);
  return state.doc.sliceString(rowColToPos(state, from.row, from.col), rowColToPos(state, to.row, to.col));
}

/**
 * The SERIALIZED text covered by [from, to) — for the clipboard. The raw CM
 * doc keeps band rows blank (wireframe glyphs exist only at serialize time),
 * so copying from it would hand the user empty holes where their boxes are.
 * `serialized` is the serializeUnified output; its rows align 1:1 with doc
 * rows, and edge rows are sliced by grapheme column.
 */
export function rangeTextSerialized(
  serialized: string,
  anchor: CursorPos,
  head: CursorPos,
  claimed?: ReadonlySet<number>,
): string {
  const { from, to } = orderRange(anchor, head);
  const lines = serialized.split("\n");
  const sliceCols = (line: string, start: number, end: number): string =>
    graphemes(line).slice(start, end).join("");
  // Band-claimed rows are blank in the raw doc, so endpoint columns there
  // carry no information (Cmd+A's end lands at col 0 of a blank claim row).
  // Snap to whole rows so wireframe glyphs aren't clipped.
  const fromCol = claimed?.has(from.row) ? 0 : from.col;
  const toCol = claimed?.has(to.row) ? Infinity : to.col;
  if (from.row === to.row) {
    return sliceCols(lines[from.row] ?? "", fromCol, toCol);
  }
  const out: string[] = [sliceCols(lines[from.row] ?? "", fromCol, Infinity)];
  for (let r = from.row + 1; r < to.row; r++) out.push(lines[r] ?? "");
  out.push(sliceCols(lines[to.row] ?? "", 0, toCol));
  return out.join("\n");
}

/** Rows claimed by top-level frames (bands / claiming wireframes). */
export function claimedRows(frames: Frame[]): Set<number> {
  const rows = new Set<number>();
  for (const f of frames) {
    for (let r = f.gridRow; r < f.gridRow + f.lineCount; r++) rows.add(r);
  }
  return rows;
}

/**
 * Delete the range [anchor, head): claiming frames wholly inside the range
 * are deleted first (bottom-up, so row indices above stay stable), then the
 * remaining prose span is removed in a single change. No-op for collapsed
 * ranges or when an endpoint sits on a band-claimed row (the invariant the
 * caller maintains; refusing beats corrupting a band claim).
 */
export function applyDeleteRange(state: EditorState, anchor: CursorPos, head: CursorPos): EditorState {
  if (cmpPos(anchor, head) === 0) return state;
  const { from, to } = orderRange(anchor, head);
  const claimed = claimedRows(getFrames(state));
  if (claimed.has(from.row) || claimed.has(to.row)) return state;

  let s = state;
  let toRow = to.row;
  const contained = getFrames(s).filter(
    f => f.lineCount > 0 && f.gridRow > from.row && f.gridRow + f.lineCount - 1 < to.row,
  );
  for (const f of contained.sort((a, b) => b.gridRow - a.gridRow)) {
    const linesBefore = s.doc.lines;
    s = applyDeleteFrame(s, f.id);
    toRow -= linesBefore - s.doc.lines;
  }

  const fromPos = rowColToPos(s, from.row, from.col);
  const toPos = rowColToPos(s, toRow, to.col);
  if (fromPos >= toPos) return s;
  return s.update({
    changes: { from: fromPos, to: toPos },
    selection: { anchor: fromPos },
    userEvent: "delete.selection",
    annotations: Transaction.addToHistory.of(true),
  }).state;
}

/**
 * Highlight rectangles for [anchor, head) over the reflowed visual lines.
 * Blank lines and band rows have no PositionedLine and get no rect — there
 * is nothing visible to highlight there.
 */
export function selectionRects(
  anchor: CursorPos,
  head: CursorPos,
  lines: PositionedLine[],
  measureWidth: (text: string) => number,
  lineHeight: number,
): RangeRect[] {
  if (cmpPos(anchor, head) === 0) return [];
  const { from, to } = orderRange(anchor, head);
  const rects: RangeRect[] = [];
  for (const pl of lines) {
    if (pl.sourceLine < from.row || pl.sourceLine > to.row) continue;
    const gs = graphemes(pl.text);
    const lineStart = pl.sourceCol;
    const lineEnd = pl.sourceCol + gs.length;
    const selStart = pl.sourceLine === from.row ? Math.max(from.col, lineStart) : lineStart;
    const selEnd = pl.sourceLine === to.row ? Math.min(to.col, lineEnd) : lineEnd;
    if (selEnd <= selStart) continue;
    const prefix = gs.slice(0, selStart - lineStart).join("");
    const body = gs.slice(selStart - lineStart, selEnd - lineStart).join("");
    rects.push({
      x: pl.x + measureWidth(prefix),
      y: pl.y,
      w: Math.max(measureWidth(body), 2),
      h: lineHeight,
    });
  }
  return rects;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * The word range around `pos` in `lineText` (grapheme columns). Expands over
 * letters/digits/underscore; on a non-word character, selects just that
 * grapheme. Returns null for an empty line or out-of-range col.
 */
export function wordRangeAt(lineText: string, row: number, col: number): { from: CursorPos; to: CursorPos } | null {
  const gs = graphemes(lineText);
  if (gs.length === 0) return null;
  const at = Math.max(0, Math.min(col, gs.length - 1));
  if (!WORD_CHAR.test(gs[at])) {
    return { from: { row, col: at }, to: { row, col: at + 1 } };
  }
  let start = at;
  while (start > 0 && WORD_CHAR.test(gs[start - 1])) start--;
  let end = at + 1;
  while (end < gs.length && WORD_CHAR.test(gs[end])) end++;
  return { from: { row, col: start }, to: { row, col: end } };
}
