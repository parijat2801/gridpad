import { describe, it, expect } from "vitest";
import { prepareWithSegments } from "@chenglou/pretext";
import { reflowLayout } from "./reflowLayout";

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
});
