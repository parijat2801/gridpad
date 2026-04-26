// src/proseSegments.test.ts
import { describe, it, expect } from "vitest";
import { extractProseSegments } from "./proseSegments";

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

  it("filters wire chars inside frame bboxes", () => {
    // Simulates the nested box case: │ at col 25 is inside the outer rect bbox
    const unclaimed = new Map([
      ["0,0", "T"], ["0,1", "o"], ["0,2", "p"],
      ["3,25", "│"],  // wire char inside frame bbox — should be filtered
      ["5,0", "E"], ["5,1", "n"], ["5,2", "d"],
    ]);
    const grid = [
      [..."Top"],
      [..."┌" + "─".repeat(24) + "┐"],
      [..."│  Inner            │  │"],
      [..."│" + " ".repeat(24) + "│"],  // row 3 — │ at col 25
      [..."└" + "─".repeat(24) + "┘"],
      [..."End"],
    ];
    const frameBboxes = [{ row: 1, col: 0, w: 26, h: 4 }]; // covers cols 0-25
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    // │ at (3,25) should NOT appear as prose
    const hasWireChar = result.some(s => s.text.includes("│"));
    expect(hasWireChar).toBe(false);
    expect(result).toContainEqual({ row: 0, col: 0, text: "Top" });
    expect(result).toContainEqual({ row: 5, col: 0, text: "End" });
  });

  it("nested box: no wire chars in prose segments (integration)", async () => {
    // Use the actual scanToFrames pipeline with the nested fixture
    const { extractProseSegments: _ } = await import("./proseSegments");
    const { scanToFrames } = await import("./scanToFrames");
    const text = [
      "Top", "",
      "┌────────────────────────┐",
      "│  Outer                 │",
      "│  ┌──────────────────┐  │",
      "│  │  Inner           │  │",
      "│  └──────────────────┘  │",
      "└────────────────────────┘",
      "", "Bottom",
    ].join("\n");
    const { proseSegments } = scanToFrames(text, 9.6, 18.4);
    // No prose segment should contain wire chars
    const WIRE = new Set([..."┌┐└┘│─├┤┬┴┼"]);
    for (const seg of proseSegments) {
      for (const ch of seg.text) {
        if (WIRE.has(ch)) {
          throw new Error(`Wire char '${ch}' found in prose segment at row=${seg.row} col=${seg.col}: "${seg.text}"`);
        }
      }
    }
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
