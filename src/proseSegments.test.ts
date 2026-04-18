// src/proseSegments.test.ts
import { describe, it, expect } from "vitest";
import { extractProseSegments, type ProseSegment } from "./proseSegments";

describe("extractProseSegments", () => {
  it("extracts a single full-row prose segment", () => {
    const unclaimed = new Map([
      ["0,0", "H"], ["0,1", "e"], ["0,2", "l"], ["0,3", "l"], ["0,4", "o"],
    ]);
    const grid = [["H", "e", "l", "l", "o"]];
    const frameBboxes: { row: number; col: number; w: number; h: number }[] = [];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    expect(result).toEqual([{ row: 0, col: 0, text: "Hello" }]);
  });

  it("extracts multiple segments on different rows", () => {
    const unclaimed = new Map([
      ["0,0", "A"], ["0,1", "B"],
      ["2,0", "C"], ["2,1", "D"],
    ]);
    const grid = [["A", "B"], [], ["C", "D"]];
    const frameBboxes: { row: number; col: number; w: number; h: number }[] = [];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    expect(result).toEqual([
      { row: 0, col: 0, text: "AB" },
      { row: 1, col: 0, text: "" },
      { row: 2, col: 0, text: "CD" },
    ]);
  });

  it("extracts inline annotation next to wireframe", () => {
    const unclaimed = new Map([
      ["0,12", "N"], ["0,13", "o"], ["0,14", "t"], ["0,15", "e"],
    ]);
    const grid = [["└", "─", "─", "─", "─", "┘", " ", " ", " ", " ", " ", " ", "N", "o", "t", "e"]];
    const frameBboxes = [{ row: 0, col: 0, w: 6, h: 1 }];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    expect(result).toEqual([{ row: 0, col: 12, text: "Note" }]);
  });

  it("skips rows entirely covered by a frame bbox", () => {
    const unclaimed = new Map([
      ["0,0", "T"], ["0,1", "o"], ["0,2", "p"],
      ["3,0", "B"], ["3,1", "o"], ["3,2", "t"],
    ]);
    const grid = [["T", "o", "p"], ["┌", "─", "┐"], ["└", "─", "┘"], ["B", "o", "t"]];
    const frameBboxes = [{ row: 1, col: 0, w: 3, h: 2 }];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    expect(result).toEqual([
      { row: 0, col: 0, text: "Top" },
      { row: 3, col: 0, text: "Bot" },
    ]);
  });

  it("handles empty grid", () => {
    const result = extractProseSegments(new Map(), [], []);
    expect(result).toEqual([]);
  });

  it("handles multiple runs on same row (gap between unclaimed cells)", () => {
    const unclaimed = new Map([
      ["0,0", "A"], ["0,1", "B"],
      ["0,5", "C"], ["0,6", "D"],
    ]);
    const grid = [["A", "B", "│", " ", "│", "C", "D"]];
    const frameBboxes = [{ row: 0, col: 2, w: 3, h: 1 }];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    expect(result).toEqual([
      { row: 0, col: 0, text: "AB" },
      { row: 0, col: 5, text: "CD" },
    ]);
  });

  it("preserves trailing spaces within a run", () => {
    const unclaimed = new Map([
      ["0,0", "H"], ["0,1", "i"], ["0,2", " "], ["0,3", " "],
    ]);
    const grid = [["H", "i", " ", " "]];
    const result = extractProseSegments(unclaimed, grid, []);
    expect(result).toEqual([{ row: 0, col: 0, text: "Hi  " }]);
  });
});
