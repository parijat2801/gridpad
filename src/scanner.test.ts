import { describe, it, expect } from "vitest";
import { scan, extractRectStyle } from "./scanner";
import type { ScannedRect } from "./scanner";

describe("scanner", () => {
  describe("empty input", () => {
    it("returns empty result for empty string", () => {
      const result = scan("");
      expect(result.rects).toEqual([]);
      expect(result.lines).toEqual([]);
      expect(result.texts).toEqual([]);
      expect(result.unclaimedCells.size).toBe(0);
    });

    it("returns empty result for whitespace-only", () => {
      const result = scan("   \n   \n");
      expect(result.rects).toEqual([]);
      expect(result.lines).toEqual([]);
      expect(result.texts).toEqual([]);
      expect(result.unclaimedCells.size).toBe(0);
    });
  });

  describe("single rectangle", () => {
    it("detects a 3x3 box", () => {
      const text = ["┌─┐", "│ │", "└─┘"].join("\n");
      const result = scan(text);
      expect(result.rects).toEqual([{ row: 0, col: 0, w: 3, h: 3 }]);
      expect(result.lines).toEqual([]);
    });

    it("detects a larger rectangle", () => {
      const text = [
        "┌────┐",
        "│    │",
        "│    │",
        "└────┘",
      ].join("\n");
      const result = scan(text);
      expect(result.rects).toEqual([{ row: 0, col: 0, w: 6, h: 4 }]);
    });

    it("detects rectangle with offset from origin", () => {
      const text = [
        "        ",
        "   ┌──┐ ",
        "   │  │ ",
        "   └──┘ ",
      ].join("\n");
      const result = scan(text);
      expect(result.rects).toEqual([{ row: 1, col: 3, w: 4, h: 3 }]);
    });
  });

  describe("two rectangles", () => {
    it("detects two separate side-by-side rectangles", () => {
      const text = ["┌─┐ ┌─┐", "│ │ │ │", "└─┘ └─┘"].join("\n");
      const result = scan(text);
      expect(result.rects).toHaveLength(2);
      expect(result.rects).toContainEqual({ row: 0, col: 0, w: 3, h: 3 });
      expect(result.rects).toContainEqual({ row: 0, col: 4, w: 3, h: 3 });
    });

    it("detects two rectangles sharing a wall", () => {
      // Adjacent boxes: left box ┌─┬─┐ becomes right box's top edge
      const text = [
        "┌─┬─┐",
        "│ │ │",
        "└─┴─┘",
      ].join("\n");
      const result = scan(text);
      expect(result.rects).toHaveLength(2);
      expect(result.rects).toContainEqual({ row: 0, col: 0, w: 3, h: 3 });
      expect(result.rects).toContainEqual({ row: 0, col: 2, w: 3, h: 3 });
    });
  });

  describe("lines", () => {
    it("detects a standalone horizontal line", () => {
      const text = "─────";
      const result = scan(text);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toEqual({ r1: 0, c1: 0, r2: 0, c2: 4 });
    });

    it("detects a standalone vertical line", () => {
      const text = ["│", "│", "│"].join("\n");
      const result = scan(text);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toEqual({ r1: 0, c1: 0, r2: 2, c2: 0 });
    });

    it("does not classify rectangle edges as standalone lines", () => {
      const text = ["┌─┐", "│ │", "└─┘"].join("\n");
      const result = scan(text);
      expect(result.rects).toHaveLength(1);
      expect(result.lines).toHaveLength(0);
    });
  });

  describe("text labels", () => {
    it("detects a standalone text label", () => {
      const text = "Hello";
      const result = scan(text);
      expect(result.texts).toHaveLength(1);
      expect(result.texts[0]).toEqual({ row: 0, col: 0, content: "Hello" });
    });

    it("detects text inside a rectangle as a label", () => {
      const text = [
        "┌─────┐",
        "│ hi  │",
        "└─────┘",
      ].join("\n");
      const result = scan(text);
      expect(result.rects).toHaveLength(1);
      expect(result.texts).toHaveLength(1);
      expect(result.texts[0].content).toBe("hi");
      expect(result.texts[0].row).toBe(1);
      expect(result.texts[0].col).toBe(2);
    });

    it("detects multiple text labels on separate rows", () => {
      const text = ["foo", "bar"].join("\n");
      const result = scan(text);
      expect(result.texts).toHaveLength(2);
      expect(result.texts).toContainEqual({ row: 0, col: 0, content: "foo" });
      expect(result.texts).toContainEqual({ row: 1, col: 0, content: "bar" });
    });
  });

  describe("non-closing corners", () => {
    it("does not emit a rect when corners don't close", () => {
      // Top-left corner but missing bottom-right
      const text = ["┌──", "│  ", "   "].join("\n");
      const result = scan(text);
      expect(result.rects).toEqual([]);
      // The characters should end up as unclaimed or lines
      expect(result.unclaimedCells.size + result.lines.length).toBeGreaterThan(0);
    });
  });

  describe("nested rectangles", () => {
    it("detects a box-inside-a-box with both shapes", () => {
      const text = [
        "┌──────┐",
        "│┌────┐│",
        "││    ││",
        "│└────┘│",
        "└──────┘",
      ].join("\n");
      const result = scan(text);
      expect(result.rects).toHaveLength(2);
      expect(result.rects).toContainEqual({ row: 0, col: 0, w: 8, h: 5 });
      expect(result.rects).toContainEqual({ row: 1, col: 1, w: 6, h: 3 });
    });

    it("detects three nested boxes", () => {
      const text = [
        "┌──────────┐",
        "│┌────────┐│",
        "││┌──────┐││",
        "│││      │││",
        "││└──────┘││",
        "│└────────┘│",
        "└──────────┘",
      ].join("\n");
      const result = scan(text);
      expect(result.rects).toHaveLength(3);
    });
  });

  describe("rectangle with interior divider", () => {
    it("detects outer box plus interior divider via T-junctions", () => {
      // Table-like: one outer rect with a horizontal divider
      // ├─────┤ splits the box into two
      const text = [
        "┌─────┐",
        "│     │",
        "├─────┤",
        "│     │",
        "└─────┘",
      ].join("\n");
      const result = scan(text);
      // Should detect two stacked rectangles (upper and lower halves)
      // plus possibly the outer — depends on policy, but definitely ≥ 2
      expect(result.rects.length).toBeGreaterThanOrEqual(2);
      expect(result.rects).toContainEqual({ row: 0, col: 0, w: 7, h: 3 });
      expect(result.rects).toContainEqual({ row: 2, col: 0, w: 7, h: 3 });
    });

    it("detects table with interior row and column dividers", () => {
      const text = [
        "┌───┬───┐",
        "│   │   │",
        "├───┼───┤",
        "│   │   │",
        "└───┴───┘",
      ].join("\n");
      const result = scan(text);
      // Four interior cells, potentially outer rect too
      expect(result.rects.length).toBeGreaterThanOrEqual(4);
      expect(result.rects).toContainEqual({ row: 0, col: 0, w: 5, h: 3 });
      expect(result.rects).toContainEqual({ row: 0, col: 4, w: 5, h: 3 });
      expect(result.rects).toContainEqual({ row: 2, col: 0, w: 5, h: 3 });
      expect(result.rects).toContainEqual({ row: 2, col: 4, w: 5, h: 3 });
    });
  });

  describe("realistic wireframe", () => {
    it("parses a simple header + body wireframe", () => {
      const text = [
        "┌──────────────┐",
        "│    Header    │",
        "├──────────────┤",
        "│              │",
        "│     Body     │",
        "│              │",
        "└──────────────┘",
      ].join("\n");
      const result = scan(text);
      // Should find outer rect (7x7 equivalent) plus two sub-boxes split by ├─┤
      expect(result.rects.length).toBeGreaterThanOrEqual(2);
      // Should find both text labels
      const contents = result.texts.map((t: { content: string }) => t.content.trim());
      expect(contents).toContain("Header");
      expect(contents).toContain("Body");
    });
  });

  describe("non-structural characters", () => {
    it("puts truly unknown characters into unclaimedCells", () => {
      const text = "★ ☆";
      const result = scan(text);
      // These should become text runs (they're non-space printable)
      expect(result.texts.length).toBeGreaterThan(0);
    });
  });

  describe("trailing whitespace", () => {
    it("handles rows of different lengths", () => {
      const text = ["┌──┐", "│  │", "└──┘"].join("\n");
      const result = scan(text);
      expect(result.rects).toHaveLength(1);
      expect(result.rects[0]).toEqual({ row: 0, col: 0, w: 4, h: 3 });
    });
  });
});

describe("extractRectStyle", () => {
  // ---------------------------------------------------------------------------
  // Happy path — canonical boxes
  // ---------------------------------------------------------------------------

  it("canonical 3x3 light box", () => {
    const text = ["┌─┐", "│ │", "└─┘"].join("\n");
    const { grid, rects } = scan(text);
    expect(rects).toHaveLength(1);
    expect(extractRectStyle(grid, rects[0])).toEqual({
      tl: "┌",
      tr: "┐",
      bl: "└",
      br: "┘",
      h: "─",
      v: "│",
    });
  });

  it("canonical 5x4 light box", () => {
    const text = ["┌───┐", "│   │", "│   │", "└───┘"].join("\n");
    const { grid, rects } = scan(text);
    expect(rects).toHaveLength(1);
    expect(extractRectStyle(grid, rects[0])).toEqual({
      tl: "┌",
      tr: "┐",
      bl: "└",
      br: "┘",
      h: "─",
      v: "│",
    });
  });

  // ---------------------------------------------------------------------------
  // T-junction corner matrix — horizontal divider (┬ / ┴)
  // ---------------------------------------------------------------------------

  it("shared-wall table: ┬ at TR canonicalizes to ┐, ┴ at BR canonicalizes to ┘", () => {
    // Left rect: TL=┌ TR=┬ BL=└ BR=┴
    const text = ["┌─┬─┐", "│ │ │", "└─┴─┘"].join("\n");
    const { grid, rects } = scan(text);
    // Left rect is col 0 w=3
    const leftRect = rects.find((r) => r.col === 0 && r.w === 3)!;
    expect(leftRect).toBeDefined();
    const style = extractRectStyle(grid, leftRect);
    expect(style.tl).toBe("┌");
    expect(style.tr).toBe("┐"); // ┬ → ┐ when in TR position
    expect(style.bl).toBe("└");
    expect(style.br).toBe("┘"); // ┴ → ┘ when in BR position
  });

  it("shared-wall table: ┬ at TL canonicalizes to ┌, ┴ at BL canonicalizes to └", () => {
    // Right rect: TL=┬ TR=┐ BL=┴ BR=┘
    const text = ["┌─┬─┐", "│ │ │", "└─┴─┘"].join("\n");
    const { grid, rects } = scan(text);
    // Right rect is col 2 w=3
    const rightRect = rects.find((r) => r.col === 2 && r.w === 3)!;
    expect(rightRect).toBeDefined();
    const style = extractRectStyle(grid, rightRect);
    expect(style.tl).toBe("┌"); // ┬ → ┌ when in TL position
    expect(style.tr).toBe("┐");
    expect(style.bl).toBe("└"); // ┴ → └ when in BL position
    expect(style.br).toBe("┘");
  });

  // ---------------------------------------------------------------------------
  // T-junction corner matrix — vertical divider (├ / ┤)
  // ---------------------------------------------------------------------------

  it("stacked table: ├ at BL of top rect canonicalizes to └, ┤ at BR canonicalizes to ┘", () => {
    // Top rect: TL=┌ TR=┐ BL=├ BR=┤
    const text = [
      "┌─────┐",
      "│     │",
      "├─────┤",
      "│     │",
      "└─────┘",
    ].join("\n");
    const { grid, rects } = scan(text);
    // Top rect starts at row 0 h=3
    const topRect = rects.find((r) => r.row === 0 && r.h === 3)!;
    expect(topRect).toBeDefined();
    const style = extractRectStyle(grid, topRect);
    expect(style.tl).toBe("┌");
    expect(style.tr).toBe("┐");
    expect(style.bl).toBe("└"); // ├ → └ when in BL position
    expect(style.br).toBe("┘"); // ┤ → ┘ when in BR position
  });

  it("stacked table: ├ at TL of bottom rect canonicalizes to ┌, ┤ at TR canonicalizes to ┐", () => {
    // Bottom rect: TL=├ TR=┤ BL=└ BR=┘
    const text = [
      "┌─────┐",
      "│     │",
      "├─────┤",
      "│     │",
      "└─────┘",
    ].join("\n");
    const { grid, rects } = scan(text);
    // Bottom rect starts at row 2 h=3
    const bottomRect = rects.find((r) => r.row === 2 && r.h === 3)!;
    expect(bottomRect).toBeDefined();
    const style = extractRectStyle(grid, bottomRect);
    expect(style.tl).toBe("┌"); // ├ → ┌ when in TL position
    expect(style.tr).toBe("┐"); // ┤ → ┐ when in TR position
    expect(style.bl).toBe("└");
    expect(style.br).toBe("┘");
  });

  // ---------------------------------------------------------------------------
  // T-junction corner matrix — ┼ cross at all four corners
  // ---------------------------------------------------------------------------

  it("2x2 table: ┼ at BR of TL rect canonicalizes to ┘", () => {
    // In a 2x2 table, the TL cell has ┼ at BR, ┬ at TR, ├ at BL, ┌ at TL
    const text = [
      "┌───┬───┐",
      "│   │   │",
      "├───┼───┤",
      "│   │   │",
      "└───┴───┘",
    ].join("\n");
    const { grid, rects } = scan(text);
    // TL rect: row=0 col=0 w=5 h=3
    const tlRect = rects.find((r) => r.row === 0 && r.col === 0 && r.w === 5 && r.h === 3)!;
    expect(tlRect).toBeDefined();
    const style = extractRectStyle(grid, tlRect);
    expect(style.tl).toBe("┌");
    expect(style.tr).toBe("┐"); // ┬ → ┐
    expect(style.bl).toBe("└"); // ├ → └
    expect(style.br).toBe("┘"); // ┼ → ┘ when in BR position
  });

  it("2x2 table: ┼ at BL of TR rect canonicalizes to └", () => {
    const text = [
      "┌───┬───┐",
      "│   │   │",
      "├───┼───┤",
      "│   │   │",
      "└───┴───┘",
    ].join("\n");
    const { grid, rects } = scan(text);
    // TR rect: row=0 col=4 w=5 h=3
    const trRect = rects.find((r) => r.row === 0 && r.col === 4 && r.w === 5 && r.h === 3)!;
    expect(trRect).toBeDefined();
    const style = extractRectStyle(grid, trRect);
    expect(style.tl).toBe("┌"); // ┬ → ┌
    expect(style.tr).toBe("┐");
    expect(style.bl).toBe("└"); // ┼ → └ when in BL position
    expect(style.br).toBe("┘"); // ┤ → ┘
  });

  it("2x2 table: ┼ at TR of BL rect canonicalizes to ┐", () => {
    const text = [
      "┌───┬───┐",
      "│   │   │",
      "├───┼───┤",
      "│   │   │",
      "└───┴───┘",
    ].join("\n");
    const { grid, rects } = scan(text);
    // BL rect: row=2 col=0 w=5 h=3
    const blRect = rects.find((r) => r.row === 2 && r.col === 0 && r.w === 5 && r.h === 3)!;
    expect(blRect).toBeDefined();
    const style = extractRectStyle(grid, blRect);
    expect(style.tl).toBe("┌"); // ├ → ┌
    expect(style.tr).toBe("┐"); // ┼ → ┐ when in TR position
    expect(style.bl).toBe("└");
    expect(style.br).toBe("┘"); // ┴ → ┘
  });

  it("2x2 table: ┼ at TL of BR rect canonicalizes to ┌", () => {
    const text = [
      "┌───┬───┐",
      "│   │   │",
      "├───┼───┤",
      "│   │   │",
      "└───┴───┘",
    ].join("\n");
    const { grid, rects } = scan(text);
    // BR rect: row=2 col=4 w=5 h=3
    const brRect = rects.find((r) => r.row === 2 && r.col === 4 && r.w === 5 && r.h === 3)!;
    expect(brRect).toBeDefined();
    const style = extractRectStyle(grid, brRect);
    expect(style.tl).toBe("┌"); // ┼ → ┌ when in TL position
    expect(style.tr).toBe("┐"); // ┤ → ┐
    expect(style.bl).toBe("└"); // ┴ → └
    expect(style.br).toBe("┘");
  });

  // ---------------------------------------------------------------------------
  // Plus-corner preservation and ASCII special case
  // ---------------------------------------------------------------------------

  it("ASCII box: + corners preserved, h='-', v='|'", () => {
    const text = ["+---+", "|   |", "+---+"].join("\n");
    const { grid, rects } = scan(text);
    expect(rects).toHaveLength(1);
    expect(extractRectStyle(grid, rects[0])).toEqual({
      tl: "+",
      tr: "+",
      bl: "+",
      br: "+",
      h: "-",
      v: "|",
    });
  });

  // ---------------------------------------------------------------------------
  // Edge-role canonicalization
  // ---------------------------------------------------------------------------

  it("outer rect of horizontal-divider table: ┬ in top edge interior canonicalizes to ─", () => {
    // Outer rect of "┌───┬───┐\n│   │   │\n└───┴───┘"
    // Top interior: ───┬─── — ┬ canonicalizes to ─; majority ─ → h="─"
    const text = ["┌───┬───┐", "│   │   │", "└───┴───┘"].join("\n");
    const { grid, rects } = scan(text);
    // Outer rect is w=9 h=3 covering the full width
    const outerRect = rects.find((r) => r.w === 9 && r.h === 3);
    // The scanner may or may not detect the outer rect as a single entity;
    // if it does, verify h="─"
    if (outerRect) {
      const style = extractRectStyle(grid, outerRect);
      expect(style.h).toBe("─");
    }
    // For the sub-rects: each has a clean ─ top edge, so also h="─"
    const leftRect = rects.find((r) => r.col === 0 && r.w === 5 && r.h === 3)!;
    expect(leftRect).toBeDefined();
    expect(extractRectStyle(grid, leftRect).h).toBe("─");
  });

  it("top edge with mixed ─ and ┬ interior chars all collapse to ─ (hand-constructed)", () => {
    // Hand-constructed: top edge interior is "─┬─┬─" — 3×"─" + 2×"┬" → all → "─"
    const grid = [
      ["┌", "─", "┬", "─", "┬", "─", "┐"],
      ["│", " ", " ", " ", " ", " ", "│"],
      ["└", "─", "─", "─", "─", "─", "┘"],
    ];
    const rect: ScannedRect = { row: 0, col: 0, w: 7, h: 3 };
    expect(extractRectStyle(grid, rect).h).toBe("─");
  });

  it("all-┼ top edge interior canonicalizes to ─ (hand-constructed)", () => {
    const grid = [
      ["┌", "┼", "┼", "┼", "┐"],
      ["│", " ", " ", " ", "│"],
      ["└", "─", "─", "─", "┘"],
    ];
    const rect: ScannedRect = { row: 0, col: 0, w: 5, h: 3 };
    expect(extractRectStyle(grid, rect).h).toBe("─");
  });

  it("all-├ left edge and all-┤ right edge interior canonicalize to │ (hand-constructed)", () => {
    const grid = [
      ["┌", "─", "─", "─", "┐"],
      ["├", " ", " ", " ", "┤"],
      ["├", " ", " ", " ", "┤"],
      ["└", "─", "─", "─", "┘"],
    ];
    const rect: ScannedRect = { row: 0, col: 0, w: 5, h: 4 };
    expect(extractRectStyle(grid, rect).v).toBe("│");
  });

  // ---------------------------------------------------------------------------
  // Degenerate rects
  // ---------------------------------------------------------------------------

  it("1x1 degenerate rect falls back to h='─' and v='│' (hand-constructed)", () => {
    const grid = [["┌"]];
    const rect: ScannedRect = { row: 0, col: 0, w: 1, h: 1 };
    const style = extractRectStyle(grid, rect);
    expect(style.tl).toBe("┌");
    expect(style.h).toBe("─");
    expect(style.v).toBe("│");
  });

  it("1-wide rect (w=1, h=3) falls back to h='─' and v='│' (hand-constructed)", () => {
    const grid = [["┌"], ["│"], ["└"]];
    const rect: ScannedRect = { row: 0, col: 0, w: 1, h: 3 };
    const style = extractRectStyle(grid, rect);
    expect(style.tl).toBe("┌");
    expect(style.h).toBe("─");
    expect(style.v).toBe("│");
  });

  it("1-tall rect (w=5, h=1) falls back to h='─' and v='│' (hand-constructed)", () => {
    const grid = [["┌", "─", "─", "─", "┐"]];
    const rect: ScannedRect = { row: 0, col: 0, w: 5, h: 1 };
    const style = extractRectStyle(grid, rect);
    expect(style.tl).toBe("┌");
    expect(style.tr).toBe("┐");
    // No vertical edge interior — v falls back to "│"
    expect(style.v).toBe("│");
  });
});
