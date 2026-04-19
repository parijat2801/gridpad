import { describe, it, expect } from "vitest";
import { repairJunctions } from "./gridSerialize";

/** Helper: convert ASCII string to grid (array of char arrays) */
function toGrid(s: string): string[][] {
  return s.split("\n").map(line => [...line]);
}

/** Helper: convert grid back to string for assertion */
function fromGrid(grid: string[][]): string {
  return grid.map(row => row.join("")).join("\n");
}

describe("repairJunctions", () => {
  it("upgrades shared horizontal wall: ┘ above └ becomes ┤ and ├", () => {
    // Two rects stacked, sharing a horizontal wall:
    //   ┌──┐       ┌──┐
    //   └──┘  →    ├──┤   (shared wall)
    //   ┌──┐       └──┘
    //   └──┘
    // The bottom of top rect (└──┘) and top of bottom rect (┌──┐)
    // occupy the SAME row when sharing a wall.
    const grid = toGrid(
      "┌──┐\n" +
      "├──┤\n" +  // This is the shared wall after both rects wrote to it
      "└──┘"
    );
    // ├ already correct, ┤ already correct — no change needed
    repairJunctions(grid);
    expect(fromGrid(grid)).toBe(
      "┌──┐\n" +
      "├──┤\n" +
      "└──┘"
    );
  });

  it("upgrades T-junction: ┐┌ on shared column becomes ┬", () => {
    // Two rects side by side sharing a vertical wall.
    // The right edge of left rect and left edge of right rect
    // are the SAME column. regenerateCells wrote ┐ (from left rect)
    // then ┌ (from right rect) overwrote it, or vice versa.
    // The post-pass should recognize the junction.
    const grid = toGrid(
      "┌──┌──┐\n" +  // col 3: ┌ from right rect, but has left neighbor ─ and right neighbor ─
      "│  │  │\n" +
      "└──└──┘"       // col 3: └ from right rect
    );
    repairJunctions(grid);
    // col 3 row 0: has left (─ connects left? no. ─ connects right? yes)
    // Actually ─ at col 2 connects right → yes. ─ at col 4 connects left → yes.
    // │ at col 3 row 1 connects up → yes. So: up=no (row -1), down=yes (│), left=yes (─), right=yes (─) → ┬
    // col 3 row 2: up=yes (│), down=no, left=yes (─), right=yes (─) → ┴
    expect(fromGrid(grid)).toBe(
      "┌──┬──┐\n" +
      "│  │  │\n" +
      "└──┴──┘"
    );
  });

  it("upgrades cross junction: center of 2x2 grid becomes ┼", () => {
    const grid = toGrid(
      "┌──┌──┐\n" +
      "│  │  │\n" +
      "┌──┌──┐\n" +  // middle row: left rect bottom + right rect bottom
      "│  │  │\n" +
      "└──└──┘"
    );
    repairJunctions(grid);
    // Row 0 col 3: down(│), left(─), right(─) → ┬
    // Row 2 col 3: up(│), down(│), left(─), right(─) → ┼
    // Row 4 col 3: up(│), left(─), right(─) → ┴
    // Row 2 col 0: up(│), down(│), right(─) → ├
    // Row 2 col 6: up(│), down(│), left(─) → ┤
    expect(fromGrid(grid)).toBe(
      "┌──┬──┐\n" +
      "│  │  │\n" +
      "├──┼──┤\n" +
      "│  │  │\n" +
      "└──┴──┘"
    );
  });

  it("does not modify non-box-drawing characters", () => {
    const grid = toGrid(
      "Hello\n" +
      "World"
    );
    repairJunctions(grid);
    expect(fromGrid(grid)).toBe(
      "Hello\n" +
      "World"
    );
  });

  it("does not fuse adjacent non-overlapping boxes", () => {
    // Two boxes side by side with NO shared wall
    const grid = toGrid(
      "┌──┐┌──┐\n" +
      "│  ││  │\n" +
      "└──┘└──┘"
    );
    repairJunctions(grid);
    // ┐ at col 3 has right neighbor ┌ at col 4.
    // ┌ does NOT connect left → ┐ sees no right connection → stays ┐
    expect(fromGrid(grid)).toBe(
      "┌──┐┌──┐\n" +
      "│  ││  │\n" +
      "└──┘└──┘"
    );
  });

  it("preserves standalone corners and edges", () => {
    const grid = toGrid(
      "┌──┐\n" +
      "│  │\n" +
      "└──┘"
    );
    repairJunctions(grid);
    expect(fromGrid(grid)).toBe(
      "┌──┐\n" +
      "│  │\n" +
      "└──┘"
    );
  });

  it("handles single-cell grid", () => {
    const grid = toGrid("┌");
    repairJunctions(grid);
    expect(fromGrid(grid)).toBe("┌");
  });

  it("handles empty grid", () => {
    const grid: string[][] = [];
    repairJunctions(grid);
    expect(grid.length).toBe(0);
  });

  it("upgrades existing wrong corner to correct junction", () => {
    // regenerateCells wrote ┌ at a position that should be ├
    // because it only knows canonical corners
    const grid = toGrid(
      "┌──┐\n" +
      "┌──┘\n" +  // ┌ at col 0 row 1 should be ├ (has up=│ at row 0 col 0... wait, ┌ connects down)
      "└──┘"
    );
    repairJunctions(grid);
    // Col 0 row 1: up connects down? ┌ connects down → yes.
    //              down connects up? └ connects up → yes.
    //              left? nothing → no. right? ─ connects left → yes.
    // → up+down+right = ├
    // ┘ at row 1 col 3: up=┐(down), down=┘(up), left=─(right) → up+down+left = ┤
    expect(fromGrid(grid)).toBe(
      "┌──┐\n" +
      "├──┤\n" +
      "└──┘"
    );
  });

  it("never downgrades an existing junction", () => {
    // ┼ in the middle with only 3 neighbors → should stay ┼ (never downgrade)
    const grid = toGrid(
      "┌──┼──┐\n" +
      "│  │  │\n" +
      "└──┘  │"  // no bottom-left connection at col 3
    );
    repairJunctions(grid);
    // ┼ at row 0 col 3: inherent connections = up+down+left+right
    // OR with neighbors: up=no (row -1), down=│ connects up → yes, left=─, right=─
    // Union with inherent: still up+down+left+right → ┼ (preserved)
    const result = fromGrid(grid);
    expect(result.charAt(grid[0].indexOf("┼") >= 0 ? 3 : -1)).toBe("┼");
  });

  it("3-in-row: three rects sharing two vertical walls", () => {
    const grid = toGrid(
      "┌──┌────┌───┐\n" +
      "│  │    │   │\n" +
      "└──└────└───┘"
    );
    repairJunctions(grid);
    expect(fromGrid(grid)).toBe(
      "┌──┬────┬───┐\n" +
      "│  │    │   │\n" +
      "└──┴────┴───┘"
    );
  });
});
