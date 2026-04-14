import { describe, it, expect } from "vitest";
import { buildSparseRows, InteractiveShape } from "./KonvaCanvas";

describe("buildSparseRows", () => {
  it("groups cells by row, fills gaps with spaces", () => {
    const composite = new Map([
      ["0,0", "A"],
      ["0,2", "B"],
      ["2,1", "C"],
    ]);
    expect(buildSparseRows(composite)).toEqual([
      { row: 0, startCol: 0, text: "A B" },
      { row: 2, startCol: 1, text: "C" },
    ]);
  });

  it("returns empty array for empty composite", () => {
    expect(buildSparseRows(new Map())).toEqual([]);
  });

  it("handles single cell", () => {
    const composite = new Map([["5,10", "X"]]);
    expect(buildSparseRows(composite)).toEqual([
      { row: 5, startCol: 10, text: "X" },
    ]);
  });

  it("handles contiguous row without gaps", () => {
    const composite = new Map([
      ["0,0", "A"], ["0,1", "B"], ["0,2", "C"],
    ]);
    expect(buildSparseRows(composite)).toEqual([
      { row: 0, startCol: 0, text: "ABC" },
    ]);
  });
});

describe("InteractiveShape memoization contract", () => {
  it("InteractiveShape is exported and wrapped in React.memo", () => {
    expect(InteractiveShape).toBeDefined();
    expect(InteractiveShape.$$typeof).toBe(Symbol.for("react.memo"));
  });
});
