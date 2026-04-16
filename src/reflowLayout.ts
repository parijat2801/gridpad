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

function buildSegToCol(prepared: PreparedTextWithSegments): number[] {
  const result: number[] = [];
  let col = 0;
  for (const seg of prepared.segments) {
    result.push(col);
    col += countGraphemes(seg);
  }
  return result;
}

export function reflowLayout(
  preparedLines: (PreparedTextWithSegments | null)[],
  canvasWidth: number,
  lineHeight: number,
  obstacles: Obstacle[],
): ReflowResult {
  const lines: PositionedLine[] = [];
  let lineTop = 0;

  for (let i = 0; i < preparedLines.length; i++) {
    const prepared = preparedLines[i];
    if (prepared === null) {
      // Empty source line — advance vertical position, no visual output
      lineTop += lineHeight;
      continue;
    }

    const segToCol = buildSegToCol(prepared);
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
    let exhausted = false;

    while (!exhausted) {
      const bandTop = lineTop;
      const bandBottom = lineTop + lineHeight;

      const blocked: Interval[] = [];
      for (const obs of obstacles) {
        if (bandBottom <= obs.y || bandTop >= obs.y + obs.h) continue;
        blocked.push({ left: obs.x, right: obs.x + obs.w });
      }

      const slots = carveSlots({ left: 0, right: canvasWidth }, blocked);

      if (slots.length === 0) {
        lineTop += lineHeight;
        if (lineTop > 50000) break;
        continue;
      }

      slots.sort((a, b) => a.left - b.left);

      for (const slot of slots) {
        const slotWidth = slot.right - slot.left;
        const startCursor = { segmentIndex: cursor.segmentIndex, graphemeIndex: cursor.graphemeIndex };
        const line = layoutNextLine(prepared, cursor, slotWidth);
        if (line === null) {
          exhausted = true;
          break;
        }

        let sourceCol = 0;
        if (segToCol.length > 0 && startCursor.segmentIndex < segToCol.length) {
          sourceCol = segToCol[startCursor.segmentIndex] + startCursor.graphemeIndex;
        }

        lines.push({
          x: Math.round(slot.left),
          y: Math.round(lineTop),
          text: line.text,
          width: line.width,
          startCursor,
          sourceLine: i,
          sourceCol,
        });
        cursor = line.end;
      }

      if (!exhausted) {
        lineTop += lineHeight;
      }
    }
  }

  return { lines, totalHeight: lineTop };
}
