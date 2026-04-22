import { describe, it, expect } from "vitest";
import { repairJunctions, gridSerialize } from "./gridSerialize";
import type { Frame } from "./frame";

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

// ── Fix 3: anyDirty and frameRows must recurse into children ──────────────────

describe("Fix 3: recursive dirty detection", () => {
  /**
   * Bug: `anyDirty = frames.some(f => f.dirty)` — only top-level frame.dirty.
   *
   * Setup: a dirty child has moved from its original grid position
   * (row 0 relative, abs row 2) UP to a new position (abs row 0).
   * The proseSegmentMap says prose is at row 0 — which is where the
   * wireframe NOW is. The original prose position was row 3 (before the move).
   *
   * Bug path (anyDirty=false): prose is written at proseSegmentMap[0] = row 0,
   * clobbering the wireframe characters on row 0 with prose text.
   *
   * Fixed path (anyDirty=true): prose is reflowed into rows not in frameRows,
   * so it avoids row 0 (occupied by the moved wireframe).
   *
   * Observable difference: with the bug, lines[0] contains prose text mixed
   * with "┌──┐"; with the fix, lines[0] is purely the wireframe "┌──┐".
   */
  it("dirty child triggers prose reflow — prose must not overwrite wireframe row", () => {
    // Original grid: wireframe was at rows 0-2 but has been deleted from the grid,
    // child has moved to row 0. The grid now just has spaces everywhere.
    // proseSegmentMap says prose was at row 0 (stale — wrong after child moved there).
    const grid: string[][] = [
      [" ", " ", " ", " "],
      [" ", " ", " ", " "],
      [" ", " ", " ", " "],
      [..."Hello"],
    ];

    // Child rect that moved to absolute row 0 (dirty because it moved)
    const childRect: Frame = {
      id: "child-moved",
      x: 0, y: 0, w: 32, h: 48, z: 0,
      children: [],
      clip: true,
      dirty: true, // child is dirty — it moved
      gridRow: 0, gridCol: 0, gridW: 4, gridH: 3, // now at absolute row 0
      content: {
        type: "rect",
        cells: new Map([
          ["0,0", "┌"], ["0,1", "─"], ["0,2", "─"], ["0,3", "┐"],
          ["1,0", "│"], ["1,1", " "], ["1,2", " "], ["1,3", "│"],
          ["2,0", "└"], ["2,1", "─"], ["2,2", "─"], ["2,3", "┘"],
        ]),
      },
    };

    // Container wrapping the dirty child — container itself is NOT dirty
    const container: Frame = {
      id: "container-clean",
      x: 0, y: 0, w: 32, h: 48, z: 0,
      children: [childRect],
      clip: true,
      dirty: false, // container is clean — only the child moved
      gridRow: 0, gridCol: 0, gridW: 4, gridH: 3,
      content: null,
    };

    // proseSegmentMap says row 0 — this was correct BEFORE the child moved to row 0,
    // but is now stale. After fix, prose reflows to avoid frame rows.
    const result = gridSerialize(
      [container],
      "Hello",
      [{ row: 0, col: 0 }], // stale prose position — points at wireframe row
      grid,
      8, 16,
      [{ row: 3, col: 0, text: "Hello" }],
      [],
    );

    const lines = result.split("\n");

    // With the bug: anyDirty is false → no-edit path → prose written at row 0
    //   lines[0] becomes "Hello" or "Hell┐" — the wireframe corners are clobbered.
    // After fix: anyDirty is true → reflow path → prose placed at a non-frame row.

    // Row 0 must be a wireframe row — prose must NOT appear there
    expect(lines[0]).toBe("┌──┐");

    // Prose "Hello" must appear somewhere in the output (just not on frame rows)
    expect(result).toContain("Hello");
  });

  /**
   * Bug in frameRows: even when anyDirty is true, the dirty path computes
   * frameRows only from top-level frames. A container at gridRow=5 with a
   * dirty child at relative gridRow=0 (absolute row 5) is accounted for by
   * the container, BUT the container's gridH covers all its children.
   *
   * However if the container has gridH=3 but the dirty child sits at a
   * different absolute position because the container was moved (gridRow changed)
   * and the container is NOT dirty, the frameRows computation uses the container's
   * OLD gridRow... wait — the container's gridRow IS updated when the child moves.
   *
   * The real frameRows bug: when only a child is dirty (not the container),
   * `anyDirty` is false so `frameRows` is never computed at all.
   * This is covered by the test above. Let's also test that frameRows
   * correctly reserves the child's absolute rows (via container gridRow + child
   * relative gridRow) after the anyDirty fix unlocks the dirty path.
   *
   * Setup: two prose lines, wireframe at rows 1-3. Prose must land at rows 0 and 4.
   */
  it("frameRows reserves all child absolute rows so prose avoids wireframe rows", () => {
    // Grid: rows 0-4 exist; wireframe currently at rows 1-3
    const grid: string[][] = [
      [..."First prose"],
      [..."┌──┐"],
      [..."│  │"],
      [..."└──┘"],
      [..."Second prose"],
    ];

    // Dirty child at relative row 0, absolute row 1 (container at gridRow=1)
    const childRect: Frame = {
      id: "child-framerows",
      x: 0, y: 16, w: 32, h: 48, z: 0,
      children: [],
      clip: true,
      dirty: true, // child dirty — triggers reflow
      gridRow: 0, gridCol: 0, gridW: 4, gridH: 3,
      content: {
        type: "rect",
        cells: new Map([
          ["0,0", "┌"], ["0,1", "─"], ["0,2", "─"], ["0,3", "┐"],
          ["1,0", "│"], ["1,1", " "], ["1,2", " "], ["1,3", "│"],
          ["2,0", "└"], ["2,1", "─"], ["2,2", "─"], ["2,3", "┘"],
        ]),
      },
    };

    const container: Frame = {
      id: "container-framerows",
      x: 0, y: 16, w: 32, h: 48, z: 0,
      children: [childRect],
      clip: true,
      dirty: false, // container is NOT dirty
      gridRow: 1, gridCol: 0, gridW: 4, gridH: 3,
      content: null,
    };

    const result = gridSerialize(
      [container],
      "First prose\nSecond prose",
      [{ row: 0, col: 0 }, { row: 4, col: 0 }],
      grid,
      8, 16,
      [{ row: 0, col: 0, text: "First prose" }, { row: 4, col: 0, text: "Second prose" }],
      [],
    );

    const lines = result.split("\n");

    // Bug (anyDirty=false): prose written at stale proseSegmentMap positions (rows 0 and 4)
    // which happen to be correct here — so this test works regardless of reflow.
    // Key assertion: wireframe rows (1-3) must contain box chars, not prose.
    expect(lines[1]).toContain("┌");
    expect(lines[2]).toContain("│");
    expect(lines[3]).toContain("└");

    // Neither prose line should appear on a wireframe row
    expect(lines[1] ?? "").not.toContain("First prose");
    expect(lines[1] ?? "").not.toContain("Second prose");
    expect(lines[2] ?? "").not.toContain("First prose");
    expect(lines[2] ?? "").not.toContain("Second prose");
    expect(lines[3] ?? "").not.toContain("First prose");
    expect(lines[3] ?? "").not.toContain("Second prose");

    // Prose must appear somewhere
    expect(result).toContain("First prose");
    expect(result).toContain("Second prose");
  });
});

// ── Fix 4: per-cell clipping instead of skip-entire-frame ────────────────────

describe("Fix 4: per-cell clipping in collectFrameCells", () => {
  /**
   * Bug: `if (clipRect && (... || r2 > clipRect.r2 || c2 > clipRect.c2)) return;`
   * skips the entire child frame when ANY dimension overflows the clip rect,
   * even when most of its cells are inside bounds.
   *
   * Setup:
   *   Parent rect 6 cols wide at gridRow=0, gridCol=0, gridW=6, gridH=3
   *   Child text "ABCD" at gridRow=1 (relative), gridCol=3 (relative), gridW=4
   *   Child absolute col range: 3..6, parent col range: 0..6
   *   Cells at relative col 0 (abs 3), 1 (abs 4) are inside parent (< 6)
   *   Cells at relative col 2 (abs 5) is the last inside col (5 < 6 → inside)
   *   Cell at relative col 3 (abs 6) overflows (6 >= 6)
   *   → ABC should be written; D should be clipped.
   *   Bug behaviour: entire child "ABCD" is skipped → nothing written.
   */
  it("partially-overflowing child writes in-bounds cells, clips out-of-bounds ones", () => {
    const parentRect: Frame = {
      id: "parent1",
      x: 0, y: 0, w: 48, h: 48, z: 0,
      children: [],
      clip: true,
      dirty: true,
      gridRow: 0, gridCol: 0, gridW: 6, gridH: 3,
      content: {
        type: "rect",
        cells: new Map([
          ["0,0", "┌"], ["0,1", "─"], ["0,2", "─"], ["0,3", "─"], ["0,4", "─"], ["0,5", "┐"],
          ["1,0", "│"], ["1,1", " "], ["1,2", " "], ["1,3", " "], ["1,4", " "], ["1,5", "│"],
          ["2,0", "└"], ["2,1", "─"], ["2,2", "─"], ["2,3", "─"], ["2,4", "─"], ["2,5", "┘"],
        ]),
      },
    };

    // Child text "ABCD" starts at parent-relative col 3, width 4
    // Absolute col range: 3, 4, 5, 6  — col 6 overflows (parent width is 6 → cols 0..5)
    const childText: Frame = {
      id: "text1",
      x: 24, y: 16, w: 32, h: 16, z: 0,
      children: [],
      clip: true,
      dirty: true,
      gridRow: 1, gridCol: 3, gridW: 4, gridH: 1,
      content: {
        type: "text",
        cells: new Map([
          ["0,0", "A"], ["0,1", "B"], ["0,2", "C"], ["0,3", "D"],
        ]),
        text: "ABCD",
      },
    };

    parentRect.children = [childText];

    // 3-row × 6-col grid of spaces
    const grid: string[][] = [
      [" ", " ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " ", " "],
      [" ", " ", " ", " ", " ", " "],
    ];

    const result = gridSerialize(
      [parentRect],
      "",
      [],
      grid,
      8, 16,
      [],
      [],
    );

    const lines = result.split("\n");

    // Row 1 (middle of parent): should contain "AB" and "C" (cols 3, 4, 5 are inside)
    // D at col 6 should be clipped (parent only goes to col 5 inclusive)
    // Currently the entire child is skipped by the bug — this assertion will FAIL before fix
    expect(lines[1]).toContain("AB");

    // D must NOT appear — it overflows the clip rect
    expect(lines[1] ?? "").not.toContain("D");
  });

  /**
   * A child that overflows by exactly 1 row on the bottom.
   * In-bounds rows should still be written.
   */
  it("child overflowing by 1 row on bottom writes its in-bounds rows", () => {
    const parentRect: Frame = {
      id: "parent2",
      x: 0, y: 0, w: 32, h: 32, z: 0,
      children: [],
      clip: true,
      dirty: true,
      gridRow: 0, gridCol: 0, gridW: 4, gridH: 2,
      content: {
        type: "rect",
        cells: new Map([
          ["0,0", "┌"], ["0,1", "─"], ["0,2", "─"], ["0,3", "┐"],
          ["1,0", "└"], ["1,1", "─"], ["1,2", "─"], ["1,3", "┘"],
        ]),
      },
    };

    // Child text 2 rows tall starting at row 1 (relative) — row 1 is inside,
    // row 2 (absolute) overflows (parent gridH=2 → rows 0..1 only)
    const childMultiRow: Frame = {
      id: "multirow1",
      x: 8, y: 8, w: 8, h: 32, z: 0,
      children: [],
      clip: true,
      dirty: true,
      gridRow: 1, gridCol: 1, gridW: 1, gridH: 2,
      content: {
        type: "text",
        cells: new Map([
          ["0,0", "X"],
          ["1,0", "Y"],
        ]),
        text: "XY",
      },
    };

    parentRect.children = [childMultiRow];

    const grid: string[][] = [
      [" ", " ", " ", " "],
      [" ", " ", " ", " "],
    ];

    const result = gridSerialize(
      [parentRect],
      "",
      [],
      grid,
      8, 16,
      [],
      [],
    );

    const lines = result.split("\n");

    // Row 1, col 1 is inside parent bounds — X should be written there
    // Row 2, col 1 overflows parent — Y should NOT appear in row 2
    // Bug: entire child is skipped → X doesn't appear. This FAILS before fix.
    expect(lines[1] ?? "").toContain("X");
  });
});
