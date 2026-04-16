import { describe, it, expect } from "vitest";
import type { PositionedLine } from "./reflowLayout";
import { findCursorLine } from "./cursorFind";

function makeLine(
  sourceLine: number,
  sourceCol: number,
  x: number,
  y: number,
  text: string = "",
): PositionedLine {
  return {
    x,
    y,
    text,
    width: text.length * 8,
    // startCursor kept for backward compat — not used by findCursorLine anymore
    startCursor: { segmentIndex: 0, graphemeIndex: 0 },
    sourceLine,
    sourceCol,
  };
}

describe("findCursorLine", () => {
  it("finds cursor on a simple single line", () => {
    const lines: PositionedLine[] = [makeLine(0, 0, 0, 0, "Hello world")];
    const result = findCursorLine({ row: 0, col: 3 }, lines, 8, 20);
    expect(result).toEqual({ x: 24, y: 0 });
  });

  it("finds cursor on second source line", () => {
    const lines: PositionedLine[] = [
      makeLine(0, 0, 0, 0, "First line"),
      makeLine(1, 0, 0, 20, "Second line"),
    ];
    const result = findCursorLine({ row: 1, col: 5 }, lines, 8, 20);
    expect(result).toEqual({ x: 40, y: 20 });
  });

  it("handles wrapped line — cursor on second visual line", () => {
    // Two visual lines from source line 0: first has sourceCol=0, second has sourceCol=40
    const lines: PositionedLine[] = [
      makeLine(0, 0, 0, 0, "A".repeat(40)),
      makeLine(0, 40, 0, 20, "B".repeat(20)),
    ];
    const result = findCursorLine({ row: 0, col: 45 }, lines, 8, 20);
    // col 45 - sourceCol 40 = 5 chars in, so x = 5 * 8 = 40
    expect(result).toEqual({ x: 40, y: 20 });
  });

  it("empty line fallback via lastLineBefore", () => {
    const lines: PositionedLine[] = [makeLine(0, 0, 0, 0, "First line")];
    const result = findCursorLine({ row: 2, col: 0 }, lines, 8, 20);
    // lastLineBefore is line 0 at y=0, cursor.row - sourceLine = 2, so y = 0 + 20*2 = 40
    expect(result).toEqual({ x: 0, y: 40 });
  });

  it("empty document returns origin", () => {
    const result = findCursorLine({ row: 0, col: 0 }, [], 8, 20);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it("empty document with cursor past row 0", () => {
    const result = findCursorLine({ row: 2, col: 0 }, [], 8, 20);
    expect(result).toEqual({ x: 0, y: 40 });
  });

  it("cursor at end of line", () => {
    const lines: PositionedLine[] = [makeLine(0, 0, 0, 0, "Hello")];
    const result = findCursorLine({ row: 0, col: 5 }, lines, 8, 20);
    expect(result).toEqual({ x: 40, y: 0 });
  });

  // New: wrapped line picks correct visual segment
  it("wrapped line — cursor col between two wrap segments picks second", () => {
    const lines: PositionedLine[] = [
      makeLine(0, 0, 0, 0, "A".repeat(30)),
      makeLine(0, 30, 0, 20, "B".repeat(30)),
      makeLine(0, 60, 0, 40, "C".repeat(10)),
    ];
    // col 35 falls in second segment (sourceCol 30, so 35 >= 30)
    const result = findCursorLine({ row: 0, col: 35 }, lines, 8, 20);
    expect(result).toEqual({ x: 40, y: 20 }); // (35-30)*8 = 40
  });

  // New: multi-line with gaps (empty source lines)
  it("empty source lines between text — fallback works", () => {
    const lines: PositionedLine[] = [
      makeLine(0, 0, 0, 0, "Line zero"),
      makeLine(3, 0, 0, 20, "Line three"),
    ];
    // Cursor on source line 1 (empty) — uses lastLineBefore (line 0 at y=0)
    const result = findCursorLine({ row: 1, col: 0 }, lines, 8, 20);
    expect(result).toEqual({ x: 0, y: 20 }); // y=0 + 20*(1-0) = 20
  });

  // New: continuation line with sourceCol > 0
  it("sourceCol > 0 on continuation — x uses sourceCol offset", () => {
    // Visual line starts at sourceCol 15 into source line 2
    const lines: PositionedLine[] = [
      makeLine(2, 15, 0, 40, "continuation text"),
    ];
    // Cursor at row=2, col=20 → x = (20-15)*8 = 40
    const result = findCursorLine({ row: 2, col: 20 }, lines, 8, 20);
    expect(result).toEqual({ x: 40, y: 40 });
  });

  // New: offset visual line (x > 0) from obstacle carving
  it("visual line with x-offset from obstacle", () => {
    const lines: PositionedLine[] = [
      makeLine(0, 0, 100, 0, "After obstacle"),
    ];
    const result = findCursorLine({ row: 0, col: 3 }, lines, 8, 20);
    // x = 100 (line offset) + 3*8 = 124
    expect(result).toEqual({ x: 124, y: 0 });
  });
});
