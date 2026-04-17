import { describe, it, expect } from "vitest";
import { prepareWithSegments } from "@chenglou/pretext";
import { reflowLayout, type Obstacle } from "./reflowLayout";
import { findCursorLine } from "./cursorFind";

// Use a monospace-like font string for Pretext — exact widths don't matter,
// we're testing sourceLine/sourceCol mapping, not pixel positions.
const FONT = "16px monospace";
const LH = 20;

function prepareLines(text: string): (ReturnType<typeof prepareWithSegments> | null)[] {
  return text.split("\n").map(line =>
    line.length > 0 ? prepareWithSegments(line, FONT, { whiteSpace: "pre-wrap" }) : null
  );
}

describe("reflowLayout sourceLine/sourceCol", () => {
  it("single line has sourceLine=0, sourceCol=0", () => {
    const prepared = prepareWithSegments("Hello world", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout([prepared], 9999, LH, []);
    expect(result.lines.length).toBeGreaterThanOrEqual(1);
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
  });

  it("two lines separated by newline get sourceLine 0 and 1", () => {
    const result = reflowLayout(prepareLines("Hello\nWorld"), 9999, LH, []);
    expect(result.lines.length).toBeGreaterThanOrEqual(2);
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
    expect(result.lines[1].sourceLine).toBe(1);
    expect(result.lines[1].sourceCol).toBe(0);
  });

  it("consecutive empty lines increment sourceLine", () => {
    const result = reflowLayout(prepareLines("A\n\n\nB"), 9999, LH, []);
    // Lines: "A" (line 0), "" (line 1), "" (line 2), "B" (line 3)
    // The last visual line must be sourceLine=3
    const lastLine = result.lines[result.lines.length - 1];
    expect(lastLine.sourceLine).toBe(3);
  });

  it("wrapped line has same sourceLine but increasing sourceCol", () => {
    // Force wrapping by using a narrow width
    const longLine = "word ".repeat(50); // 250 chars, will wrap
    const result = reflowLayout(prepareLines(longLine), 200, LH, []);
    expect(result.lines.length).toBeGreaterThan(1);
    // All visual lines from the single source line should have sourceLine=0
    for (const line of result.lines) {
      expect(line.sourceLine).toBe(0);
    }
    // sourceCol should be increasing across wrap segments
    for (let i = 1; i < result.lines.length; i++) {
      expect(result.lines[i].sourceCol).toBeGreaterThan(result.lines[i - 1].sourceCol);
    }
  });

  it("empty string produces no lines", () => {
    const result = reflowLayout([], 9999, LH, []);
    expect(result.lines).toEqual([]);
  });

  it("last line without trailing newline gets correct sourceLine", () => {
    const result = reflowLayout(prepareLines("First\nSecond"), 9999, LH, []);
    const lastLine = result.lines[result.lines.length - 1];
    expect(lastLine.sourceLine).toBe(1);
    expect(lastLine.sourceCol).toBe(0);
  });

  it("emoji text uses grapheme count for sourceCol, not UTF-16 length", () => {
    // "🎉 hello\nworld" — 🎉 is 1 grapheme but 2 UTF-16 code units
    const result = reflowLayout(prepareLines("🎉 hello\nworld"), 9999, LH, []);
    // Line 0: "🎉 hello" — 7 graphemes (🎉, space, h, e, l, l, o)
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
    // Line 1: "world" — sourceLine=1, sourceCol=0
    expect(result.lines[1].sourceLine).toBe(1);
    expect(result.lines[1].sourceCol).toBe(0);
  });

  it("trailing newline increments sourceLine for empty last line", () => {
    const result = reflowLayout(prepareLines("A\n"), 9999, LH, []);
    expect(result.lines[0].sourceLine).toBe(0);
  });

  it("second source line wrapping into multiple visual lines", () => {
    const longSecond = "word ".repeat(50);
    const result = reflowLayout(prepareLines("Short\n" + longSecond), 200, LH, []);
    expect(result.lines[0].sourceLine).toBe(0);
    const line1Visuals = result.lines.filter(l => l.sourceLine === 1);
    expect(line1Visuals.length).toBeGreaterThan(1);
    for (let i = 1; i < line1Visuals.length; i++) {
      expect(line1Visuals[i].sourceCol).toBeGreaterThan(line1Visuals[i - 1].sourceCol);
    }
  });
});

// Obstacle regression tests (restored from pre-refactor)
const CANVAS_WIDTH = 600;
const SAMPLE_TEXT =
  "The quick brown fox jumps over the lazy dog. " +
  "Pack my box with five dozen liquor jugs. " +
  "How valiantly did brave Xerxes display his fondness for jam. " +
  "The five boxing wizards jump quickly. ";

describe("reflowLayout obstacle handling", () => {
  it("text with no obstacles fills full width", () => {
    const prepared = prepareWithSegments(SAMPLE_TEXT, FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout([prepared], CANVAS_WIDTH, LH, []);
    expect(result.lines.length).toBeGreaterThan(0);
    for (const line of result.lines) {
      expect(line.x).toBe(0);
    }
  });

  it("text flows around a rect obstacle", () => {
    const obstacle: Obstacle = { x: 100, y: 20, w: 200, h: 40 };
    const prepared = prepareWithSegments(SAMPLE_TEXT, FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout([prepared], CANVAS_WIDTH, LH, [obstacle]);
    expect(result.lines.length).toBeGreaterThan(0);
    const affectedLines = result.lines.filter((line) => {
      const bandBottom = line.y + LH;
      return bandBottom > obstacle.y && line.y < obstacle.y + obstacle.h;
    });
    expect(affectedLines.length).toBeGreaterThan(0);
    const hasNarrowedSlot = affectedLines.some(
      (line) => line.x !== 0 || line.width < CANVAS_WIDTH - 1,
    );
    expect(hasNarrowedSlot).toBe(true);
  });
});

// Integration: reflowLayout → findCursorLine round-trip
describe("reflowLayout + findCursorLine integration", () => {
  it("cursor on wrapped second line maps to correct y", () => {
    const text = "First line\n" + "word ".repeat(40);
    const result = reflowLayout(prepareLines(text), 300, LH, []);
    const pos = findCursorLine({ row: 1, col: 10 }, result.lines, (s) => s.length * 9.6, LH);
    expect(pos.y).toBeGreaterThanOrEqual(LH);
    expect(pos.x).toBeGreaterThan(0);
  });
});

describe("reflowLayout per-line cache equivalence", () => {
  it("per-line cache produces same sourceLine/sourceCol as full rebuild", () => {
    const text = "First line\nSecond line\nThird line";
    const perLine = prepareLines(text);
    const result = reflowLayout(perLine, 9999, LH, []);
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
    expect(result.lines[1].sourceLine).toBe(1);
    expect(result.lines[1].sourceCol).toBe(0);
    expect(result.lines[2].sourceLine).toBe(2);
    expect(result.lines[2].sourceCol).toBe(0);
  });

  it("invalidating one line produces same layout as full rebuild", () => {
    const original = "Hello\nWorld\nEnd";
    const modified = "Hello\nChanged\nEnd";
    const fullRebuild = prepareLines(modified);
    const incremental = prepareLines(original);
    // Simulate invalidateLine for line 1
    incremental[1] = prepareWithSegments("Changed", FONT, { whiteSpace: "pre-wrap" });
    const resultFull = reflowLayout(fullRebuild, 9999, LH, []);
    const resultIncr = reflowLayout(incremental, 9999, LH, []);
    expect(resultIncr.lines.length).toBe(resultFull.lines.length);
    for (let j = 0; j < resultFull.lines.length; j++) {
      expect(resultIncr.lines[j].sourceLine).toBe(resultFull.lines[j].sourceLine);
      expect(resultIncr.lines[j].sourceCol).toBe(resultFull.lines[j].sourceCol);
      expect(resultIncr.lines[j].text).toBe(resultFull.lines[j].text);
    }
  });

  it("empty lines in cache advance vertical position", () => {
    const result = reflowLayout(prepareLines("A\n\n\nB"), 9999, LH, []);
    const lineA = result.lines.find(l => l.text.includes("A"));
    const lineB = result.lines.find(l => l.text.includes("B"));
    expect(lineA).toBeDefined();
    expect(lineB).toBeDefined();
    // B should be 3 line-heights below A (A at line 0, empty at 1, empty at 2, B at 3)
    expect(lineB!.y - lineA!.y).toBe(3 * LH);
  });

  it("wrapped line with per-line cache has correct sourceCol progression", () => {
    const longLine = "word ".repeat(50);
    const result = reflowLayout(prepareLines(longLine), 200, LH, []);
    expect(result.lines.length).toBeGreaterThan(1);
    for (const line of result.lines) {
      expect(line.sourceLine).toBe(0);
    }
    for (let j = 1; j < result.lines.length; j++) {
      expect(result.lines[j].sourceCol).toBeGreaterThan(result.lines[j - 1].sourceCol);
    }
  });

  it("per-line cache with obstacles produces correct layout", () => {
    const text = "The quick brown fox jumps over the lazy dog. Pack my box.";
    const obstacle = { x: 100, y: 0, w: 200, h: 40 };
    const result = reflowLayout(prepareLines(text), 600, LH, [obstacle]);
    expect(result.lines.length).toBeGreaterThan(0);
    const affected = result.lines.filter(l => {
      const bandBot = l.y + LH;
      return bandBot > obstacle.y && l.y < obstacle.y + obstacle.h;
    });
    expect(affected.length).toBeGreaterThan(0);
    const hasNarrowed = affected.some(l => l.x !== 0 || l.width < 599);
    expect(hasNarrowed).toBe(true);
  });
});

describe("reflowLayout PositionedLine metadata", () => {
  it("each line has endCursor and slotWidth", () => {
    const result = reflowLayout(prepareLines("Hello\nWorld"), 9999, LH, []);
    for (const line of result.lines) {
      expect(line.endCursor).toBeDefined();
      expect(line.endCursor.segmentIndex).toBeGreaterThanOrEqual(0);
      expect(line.endCursor.graphemeIndex).toBeGreaterThanOrEqual(0);
      expect(line.slotWidth).toBeGreaterThan(0);
    }
  });

  it("slotWidth matches canvas width when no obstacles", () => {
    const result = reflowLayout(prepareLines("Hello"), 500, LH, []);
    expect(result.lines[0].slotWidth).toBe(500);
  });

  it("slotWidth reflects narrowed slot from obstacle", () => {
    const obstacle = { x: 0, y: 0, w: 200, h: 40 };
    const text = "The quick brown fox jumps over the lazy dog";
    const result = reflowLayout(prepareLines(text), 600, LH, [obstacle]);
    const affected = result.lines.filter(l => l.y < 40);
    // Lines in the obstacle band should have narrower slotWidth
    for (const line of affected) {
      expect(line.slotWidth).toBeLessThan(600);
    }
  });

  it("endCursor advances past startCursor", () => {
    const result = reflowLayout(prepareLines("Hello world"), 9999, LH, []);
    const line = result.lines[0];
    const startPos = line.startCursor.segmentIndex * 1000 + line.startCursor.graphemeIndex;
    const endPos = line.endCursor.segmentIndex * 1000 + line.endCursor.graphemeIndex;
    expect(endPos).toBeGreaterThan(startPos);
  });
});
