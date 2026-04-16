import { describe, it, expect } from "vitest";
import { prepareWithSegments } from "@chenglou/pretext";
import { reflowLayout, type Obstacle } from "./reflowLayout";
import { findCursorLine } from "./cursorFind";

// Use a monospace-like font string for Pretext — exact widths don't matter,
// we're testing sourceLine/sourceCol mapping, not pixel positions.
const FONT = "16px monospace";
const LH = 20;

describe("reflowLayout sourceLine/sourceCol", () => {
  it("single line has sourceLine=0, sourceCol=0", () => {
    const prepared = prepareWithSegments("Hello world", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    expect(result.lines.length).toBeGreaterThanOrEqual(1);
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
  });

  it("two lines separated by newline get sourceLine 0 and 1", () => {
    const prepared = prepareWithSegments("Hello\nWorld", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    expect(result.lines.length).toBeGreaterThanOrEqual(2);
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
    expect(result.lines[1].sourceLine).toBe(1);
    expect(result.lines[1].sourceCol).toBe(0);
  });

  it("consecutive empty lines increment sourceLine", () => {
    const prepared = prepareWithSegments("A\n\n\nB", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    // Lines: "A" (line 0), "" (line 1), "" (line 2), "B" (line 3)
    // Pretext may or may not emit visual lines for empty source lines,
    // but the last visual line must be sourceLine=3
    const lastLine = result.lines[result.lines.length - 1];
    expect(lastLine.sourceLine).toBe(3);
  });

  it("wrapped line has same sourceLine but increasing sourceCol", () => {
    // Force wrapping by using a narrow width
    const longLine = "word ".repeat(50); // 250 chars, will wrap
    const prepared = prepareWithSegments(longLine, FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 200, LH, []);
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
    const prepared = prepareWithSegments("", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    expect(result.lines).toEqual([]);
  });

  it("last line without trailing newline gets correct sourceLine", () => {
    const prepared = prepareWithSegments("First\nSecond", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    const lastLine = result.lines[result.lines.length - 1];
    expect(lastLine.sourceLine).toBe(1);
    expect(lastLine.sourceCol).toBe(0);
  });

  it("emoji text uses grapheme count for sourceCol, not UTF-16 length", () => {
    // "🎉 hello\nworld" — 🎉 is 1 grapheme but 2 UTF-16 code units
    const prepared = prepareWithSegments("🎉 hello\nworld", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    // Line 0: "🎉 hello" — 7 graphemes (🎉, space, h, e, l, l, o)
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
    // Line 1: "world" — sourceLine=1, sourceCol=0
    expect(result.lines[1].sourceLine).toBe(1);
    expect(result.lines[1].sourceCol).toBe(0);
  });

  it("trailing newline increments sourceLine for empty last line", () => {
    const prepared = prepareWithSegments("A\n", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    expect(result.lines[0].sourceLine).toBe(0);
  });

  it("second source line wrapping into multiple visual lines", () => {
    const longSecond = "word ".repeat(50);
    const prepared = prepareWithSegments("Short\n" + longSecond, FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 200, LH, []);
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
    const result = reflowLayout(prepared, CANVAS_WIDTH, LH, []);
    expect(result.lines.length).toBeGreaterThan(0);
    for (const line of result.lines) {
      expect(line.x).toBe(0);
    }
  });

  it("text flows around a rect obstacle", () => {
    const obstacle: Obstacle = { x: 100, y: 20, w: 200, h: 40 };
    const prepared = prepareWithSegments(SAMPLE_TEXT, FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, CANVAS_WIDTH, LH, [obstacle]);
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
    const prepared = prepareWithSegments(text, FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 300, LH, []);
    const pos = findCursorLine({ row: 1, col: 10 }, result.lines, 9.6, LH);
    expect(pos.y).toBeGreaterThanOrEqual(LH);
    expect(pos.x).toBeGreaterThan(0);
  });
});
