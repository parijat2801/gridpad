/**
 * reflowLayout.ts — obstacle-based text reflow.
 *
 * All prose text is one continuous stream. Wireframes are rectangular
 * obstacles at absolute pixel positions. For each line of text, we:
 * 1. Compute which wireframes overlap this line's vertical band
 * 2. Subtract their horizontal intervals from the full canvas width
 * 3. layoutNextLine fills the remaining slots with text
 */

import {
  layoutNextLine,
  type PreparedTextWithSegments,
  type LayoutCursor,
} from "@chenglou/pretext";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function countGraphemes(text: string): number {
  let count = 0;
  for (const _ of graphemeSegmenter.segment(text)) count++;
  return count;
}

export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PositionedLine {
  x: number;
  y: number;
  text: string;
  width: number;
  /** Pretext word-segment cursor — use sourceLine/sourceCol for EditorState coordinates */
  startCursor: { segmentIndex: number; graphemeIndex: number };
  /** 0-indexed source line number (\n-delimited) — EditorState-compatible */
  sourceLine: number;
  /** Grapheme offset from start of source line to this visual line's start — grapheme clusters, not UTF-16 code units */
  sourceCol: number;
}

export interface ReflowResult {
  lines: PositionedLine[];
  totalHeight: number;
}

interface Interval {
  left: number;
  right: number;
}

// From editorial-engine.ts — carve available slots from blocked intervals
function carveSlots(base: Interval, blocked: Interval[]): Interval[] {
  let slots = [base];
  for (const interval of blocked) {
    const next: Interval[] = [];
    for (const slot of slots) {
      if (interval.right <= slot.left || interval.left >= slot.right) {
        next.push(slot);
        continue;
      }
      if (interval.left > slot.left) next.push({ left: slot.left, right: interval.left });
      if (interval.right < slot.right) next.push({ left: interval.right, right: slot.right });
    }
    slots = next;
  }
  return slots.filter(s => s.right - s.left >= 20); // min slot width
}

export function reflowLayout(
  prepared: PreparedTextWithSegments,
  canvasWidth: number,
  lineHeight: number,
  obstacles: Obstacle[],
): ReflowResult {
  const lines: PositionedLine[] = [];
  let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
  let lineTop = 0;
  let exhausted = false;

  // Access PreparedCore fields via the base type (unstable Pretext escape hatch).
  // If Pretext changes the segment taxonomy, these maps will drift — the
  // runtime guards below will catch it.
  const kinds: string[] | undefined = (prepared as any).kinds;
  const segments: string[] = prepared.segments;

  let segToLine: number[] = [];
  let segToCol: number[] = [];

  if (kinds && Array.isArray(kinds) && kinds.length === segments.length) {
    let currentLine = 0;
    let currentColGraphemes = 0;

    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === "hard-break") {
        // The hard-break segment itself belongs to the current line
        segToLine.push(currentLine);
        segToCol.push(currentColGraphemes);
        // Advance to next source line
        currentLine++;
        currentColGraphemes = 0;
      } else {
        segToLine.push(currentLine);
        segToCol.push(currentColGraphemes);
        currentColGraphemes += countGraphemes(segments[i]);
      }
    }

    // Guard (d-ii): for multi-line text, verify at least one hard-break exists
    if (!currentLine && segments.join("").includes("\n")) {
      console.error("[reflowLayout] text contains newlines but no 'hard-break' found in kinds — prefix map may be wrong");
    }
  } else if (segments.length > 0) {
    // Guard (d): kinds missing or mismatched — fall back to zeros
    console.error("[reflowLayout] prepared.kinds missing or length mismatch — sourceLine/sourceCol will be 0");
    segToLine = new Array(segments.length).fill(0);
    segToCol = new Array(segments.length).fill(0);
  }

  while (!exhausted) {
    const bandTop = lineTop;
    const bandBottom = lineTop + lineHeight;

    // Find obstacles overlapping this line band
    const blocked: Interval[] = [];
    for (const obs of obstacles) {
      if (bandBottom <= obs.y || bandTop >= obs.y + obs.h) continue;
      blocked.push({ left: obs.x, right: obs.x + obs.w });
    }

    const slots = carveSlots({ left: 0, right: canvasWidth }, blocked);

    if (slots.length === 0) {
      // No space for text on this line — skip it
      lineTop += lineHeight;
      // Safety: if we're way past all obstacles, break
      if (lineTop > 50000) break;
      continue;
    }

    // Sort slots left to right
    slots.sort((a, b) => a.left - b.left);

    for (const slot of slots) {
      const slotWidth = slot.right - slot.left;
      const startCursor = { segmentIndex: cursor.segmentIndex, graphemeIndex: cursor.graphemeIndex };
      const line = layoutNextLine(prepared, cursor, slotWidth);
      if (line === null) {
        exhausted = true;
        break;
      }

      let sourceLine = 0;
      let sourceCol = 0;
      if (segToLine.length > 0 && startCursor.segmentIndex < segToLine.length) {
        sourceLine = segToLine[startCursor.segmentIndex];
        sourceCol = segToCol[startCursor.segmentIndex] + startCursor.graphemeIndex;
        // Guard (b): clamp sourceLine
        const maxLine = segToLine[segToLine.length - 1];
        if (sourceLine > maxLine) {
          console.warn(`[reflowLayout] sourceLine ${sourceLine} exceeds max ${maxLine}, clamping`);
          sourceLine = maxLine;
        }
      }

      lines.push({
        x: Math.round(slot.left),
        y: Math.round(lineTop),
        text: line.text,
        width: line.width,
        startCursor,
        sourceLine,
        sourceCol,
      });
      cursor = line.end;
    }

    lineTop += lineHeight;
  }

  return { lines, totalHeight: lineTop };
}
