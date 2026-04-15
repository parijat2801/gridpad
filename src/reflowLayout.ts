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
  /** Pretext cursor at the start of this line — segmentIndex maps to source line */
  startCursor: { segmentIndex: number; graphemeIndex: number };
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
      lines.push({
        x: Math.round(slot.left),
        y: Math.round(lineTop),
        text: line.text,
        width: line.width,
        startCursor,
      });
      cursor = line.end;
    }

    lineTop += lineHeight;
  }

  return { lines, totalHeight: lineTop };
}
