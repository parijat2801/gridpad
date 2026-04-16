import { describe, it, expect } from "vitest";
import type { PositionedLine } from "./reflowLayout";
import { findCursorLine } from "./cursorFind";

function makeLine(
  segmentIndex: number,
  graphemeIndex: number,
  x: number,
  y: number,
  text: string = "",
): PositionedLine {
  return {
    x,
    y,
    text,
    width: text.length * 8,
    startCursor: { segmentIndex, graphemeIndex },
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
    const lines: PositionedLine[] = [
      makeLine(0, 0, 0, 0, "A".repeat(40)),
      makeLine(0, 40, 0, 20, "B".repeat(20)),
    ];
    const result = findCursorLine({ row: 0, col: 45 }, lines, 8, 20);
    expect(result).toEqual({ x: 40, y: 20 });
  });

  it("empty line fallback via lastLineBefore", () => {
    const lines: PositionedLine[] = [makeLine(0, 0, 0, 0, "First line")];
    const result = findCursorLine({ row: 2, col: 0 }, lines, 8, 20);
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
});
