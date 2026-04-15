import { describe, it, expect } from "vitest";
import {
  buildLayersFromScan,
  compositeLayers,
  regenerateCells,
  buildLineCells,
  LIGHT_RECT_STYLE,
  type Layer,
} from "./layers";
import { scan, type RectStyle } from "./scanner";

function makeLayer(id: string, extras: Partial<Layer> = {}): Layer {
  return {
    id,
    type: "rect",
    z: 0,
    visible: true,
    bbox: { row: 0, col: 0, w: 3, h: 3 },
    cells: new Map(),
    ...extras,
  } as Layer;
}

describe("layers", () => {
  describe("buildLayersFromScan", () => {
    it("returns no layers for empty scan", () => {
      const result = scan("");
      const layers = buildLayersFromScan(result);
      expect(layers).toEqual([]);
    });

    it("creates one rect layer with canonical corners", () => {
      const result = scan(["┌─┐", "│ │", "└─┘"].join("\n"));
      const layers = buildLayersFromScan(result);
      const rectLayers = layers.filter((l) => l.type === "rect");
      expect(rectLayers).toHaveLength(1);
      const layer = rectLayers[0];
      // Should paint the 4 corners and edges only (not the interior)
      expect(layer.cells.get("0,0")).toBe("┌");
      expect(layer.cells.get("0,1")).toBe("─");
      expect(layer.cells.get("0,2")).toBe("┐");
      expect(layer.cells.get("1,0")).toBe("│");
      expect(layer.cells.get("1,2")).toBe("│");
      expect(layer.cells.get("2,0")).toBe("└");
      expect(layer.cells.get("2,1")).toBe("─");
      expect(layer.cells.get("2,2")).toBe("┘");
      // Interior cell (1,1) should not be claimed
      expect(layer.cells.has("1,1")).toBe(false);
    });

    it("creates one text layer per detected text", () => {
      const result = scan("Hello");
      const layers = buildLayersFromScan(result);
      const textLayers = layers.filter((l) => l.type === "text");
      expect(textLayers).toHaveLength(1);
      const layer = textLayers[0];
      expect(layer.cells.get("0,0")).toBe("H");
      expect(layer.cells.get("0,1")).toBe("e");
      expect(layer.cells.get("0,2")).toBe("l");
      expect(layer.cells.get("0,3")).toBe("l");
      expect(layer.cells.get("0,4")).toBe("o");
    });

    it("creates a line layer for standalone horizontal line", () => {
      const result = scan("────");
      const layers = buildLayersFromScan(result);
      const lineLayers = layers.filter((l) => l.type === "line");
      expect(lineLayers).toHaveLength(1);
      expect(lineLayers[0].cells.get("0,0")).toBe("─");
      expect(lineLayers[0].cells.get("0,3")).toBe("─");
    });

    it("creates a base layer for unclaimed cells only when non-empty", () => {
      const result = scan(["┌─┐", "│ │", "└─┘"].join("\n"));
      const layers = buildLayersFromScan(result);
      const baseLayers = layers.filter((l) => l.type === "base");
      expect(baseLayers).toHaveLength(0);
    });

    it("assigns stable IDs based on shape position and size", () => {
      const result = scan(["┌─┐", "│ │", "└─┘"].join("\n"));
      const layers1 = buildLayersFromScan(result);
      const layers2 = buildLayersFromScan(result);
      expect(layers1[0].id).toBe(layers2[0].id);
    });

    it("orders layers with base (z=0) below shapes", () => {
      const result = scan(["┌─┐", "│X│", "└─┘"].join("\n"));
      const layers = buildLayersFromScan(result);
      // Sort by z and verify base is below text which is below rect — or at
      // least that base has z < shapes
      const base = layers.find((l) => l.type === "base");
      const rect = layers.find((l) => l.type === "rect");
      if (base && rect) {
        expect(base.z).toBeLessThan(rect.z);
      }
    });
  });

  describe("compositeLayers", () => {
    it("returns an empty map when no layers", () => {
      const composite = compositeLayers([]);
      expect(composite.size).toBe(0);
    });

    it("composites a single layer unchanged", () => {
      const layer: Layer = {
        id: "test",
        type: "rect",
        z: 1,
        visible: true,
        bbox: { row: 0, col: 0, w: 3, h: 3 },
        cells: new Map([
          ["0,0", "A"],
          ["1,1", "B"],
        ]),
      };
      const composite = compositeLayers([layer]);
      expect(composite.get("0,0")).toBe("A");
      expect(composite.get("1,1")).toBe("B");
    });

    it("higher z-layer wins per cell", () => {
      const lower: Layer = {
        id: "low",
        type: "rect",
        z: 1,
        visible: true,
        bbox: { row: 0, col: 0, w: 1, h: 1 },
        cells: new Map([["0,0", "A"]]),
      };
      const upper: Layer = {
        id: "hi",
        type: "rect",
        z: 2,
        visible: true,
        bbox: { row: 0, col: 0, w: 1, h: 1 },
        cells: new Map([["0,0", "B"]]),
      };
      const composite = compositeLayers([lower, upper]);
      expect(composite.get("0,0")).toBe("B");
    });

    it("skips invisible layers", () => {
      const hidden: Layer = {
        id: "hidden",
        type: "rect",
        z: 1,
        visible: false,
        bbox: { row: 0, col: 0, w: 1, h: 1 },
        cells: new Map([["0,0", "X"]]),
      };
      const composite = compositeLayers([hidden]);
      expect(composite.size).toBe(0);
    });
  });
});


describe("LIGHT_RECT_STYLE", () => {
  it("has correct Unicode light box-drawing characters", () => {
    expect(LIGHT_RECT_STYLE).toEqual({
      tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│",
    });
  });
});


describe("buildLineCells", () => {
  it("horizontal line left-to-right", () => {
    const result = buildLineCells(0, 0, 0, 4);
    expect(result.bbox).toEqual({ row: 0, col: 0, w: 5, h: 1 });
    expect(result.cells.size).toBe(5);
    for (let c = 0; c <= 4; c++) {
      expect(result.cells.get(`0,${c}`)).toBe("─");
    }
  });

  it("vertical line top-to-bottom", () => {
    const result = buildLineCells(0, 0, 4, 0);
    expect(result.bbox).toEqual({ row: 0, col: 0, w: 1, h: 5 });
    expect(result.cells.size).toBe(5);
    for (let r = 0; r <= 4; r++) {
      expect(result.cells.get(`${r},0`)).toBe("│");
    }
  });

  it("constrains to dominant axis — diagonal biased horizontal", () => {
    const result = buildLineCells(0, 0, 1, 5);
    expect(result.bbox).toEqual({ row: 0, col: 0, w: 6, h: 1 });
    expect(result.cells.get("0,0")).toBe("─");
    expect(result.cells.get("0,5")).toBe("─");
  });

  it("constrains to dominant axis — diagonal biased vertical", () => {
    const result = buildLineCells(0, 0, 5, 1);
    expect(result.bbox).toEqual({ row: 0, col: 0, w: 1, h: 6 });
    expect(result.cells.get("0,0")).toBe("│");
    expect(result.cells.get("5,0")).toBe("│");
  });

  it("reversed coordinates work (right-to-left)", () => {
    const result = buildLineCells(3, 7, 3, 2);
    expect(result.bbox).toEqual({ row: 3, col: 2, w: 6, h: 1 });
    expect(result.cells.size).toBe(6);
  });

  it("degenerate single-point (r1===r2, c1===c2) returns one horizontal cell", () => {
    const result = buildLineCells(3, 5, 3, 5);
    expect(result.bbox).toEqual({ row: 3, col: 5, w: 1, h: 1 });
    expect(result.cells.size).toBe(1);
    expect(result.cells.get("3,5")).toBe("─");
  });
});



describe("regenerateCells", () => {
  const lightStyle: RectStyle = {
    tl: "┌",
    tr: "┐",
    bl: "└",
    br: "┘",
    h: "─",
    v: "│",
  };

  it("3×3 box at origin — all 8 perimeter cells, interior absent", () => {
    const cells = regenerateCells({ row: 0, col: 0, w: 3, h: 3 }, lightStyle);
    expect(cells.get("0,0")).toBe("┌");
    expect(cells.get("0,1")).toBe("─");
    expect(cells.get("0,2")).toBe("┐");
    expect(cells.get("1,0")).toBe("│");
    expect(cells.get("1,1")).toBeUndefined(); // interior not written
    expect(cells.get("1,2")).toBe("│");
    expect(cells.get("2,0")).toBe("└");
    expect(cells.get("2,1")).toBe("─");
    expect(cells.get("2,2")).toBe("┘");
    expect(cells.size).toBe(8);
  });

  it("5×4 box at offset — corners, edges, interior absent, correct size", () => {
    const cells = regenerateCells(
      { row: 10, col: 20, w: 5, h: 4 },
      lightStyle,
    );
    // Corners
    expect(cells.get("10,20")).toBe("┌");
    expect(cells.get("10,24")).toBe("┐");
    expect(cells.get("13,20")).toBe("└");
    expect(cells.get("13,24")).toBe("┘");
    // Top edge interior (cols 21-23)
    expect(cells.get("10,21")).toBe("─");
    expect(cells.get("10,22")).toBe("─");
    expect(cells.get("10,23")).toBe("─");
    // Bottom edge interior (cols 21-23)
    expect(cells.get("13,21")).toBe("─");
    expect(cells.get("13,22")).toBe("─");
    expect(cells.get("13,23")).toBe("─");
    // Left edge (rows 11-12)
    expect(cells.get("11,20")).toBe("│");
    expect(cells.get("12,20")).toBe("│");
    // Right edge (rows 11-12)
    expect(cells.get("11,24")).toBe("│");
    expect(cells.get("12,24")).toBe("│");
    // Interior cells absent
    expect(cells.get("11,22")).toBeUndefined();
    expect(cells.get("12,22")).toBeUndefined();
    // size = 2*w + 2*(h-2) = 2*5 + 2*2 = 14
    expect(cells.size).toBe(14);
  });

  it("10×2 degenerate wide (h=2) — two full rows, no interior", () => {
    const cells = regenerateCells({ row: 0, col: 0, w: 10, h: 2 }, lightStyle);
    // Top row: tl + h*8 + tr
    expect(cells.get("0,0")).toBe("┌");
    expect(cells.get("0,1")).toBe("─");
    expect(cells.get("0,8")).toBe("─");
    expect(cells.get("0,9")).toBe("┐");
    // Bottom row: bl + h*8 + br
    expect(cells.get("1,0")).toBe("└");
    expect(cells.get("1,1")).toBe("─");
    expect(cells.get("1,8")).toBe("─");
    expect(cells.get("1,9")).toBe("┘");
    expect(cells.size).toBe(20);
  });

  it("1×1 box — single cell equals style.tl", () => {
    const cells = regenerateCells({ row: 5, col: 7, w: 1, h: 1 }, lightStyle);
    expect(cells.get("5,7")).toBe("┌");
    expect(cells.size).toBe(1);
  });

  it("1×5 degenerate (w=1, h=5) — vertical strip", () => {
    const cells = regenerateCells({ row: 0, col: 0, w: 1, h: 5 }, lightStyle);
    expect(cells.get("0,0")).toBe("┌"); // tl
    expect(cells.get("4,0")).toBe("└"); // bl
    expect(cells.get("1,0")).toBe("│"); // v
    expect(cells.get("2,0")).toBe("│"); // v
    expect(cells.get("3,0")).toBe("│"); // v
    expect(cells.size).toBe(5);
  });

  it("5×1 degenerate (h=1, w=5) — horizontal strip", () => {
    const cells = regenerateCells({ row: 0, col: 0, w: 5, h: 1 }, lightStyle);
    expect(cells.get("0,0")).toBe("┌"); // tl
    expect(cells.get("0,4")).toBe("┐"); // tr
    expect(cells.get("0,1")).toBe("─"); // h
    expect(cells.get("0,2")).toBe("─"); // h
    expect(cells.get("0,3")).toBe("─"); // h
    expect(cells.size).toBe(5);
  });

  it("ASCII style 3×3 — produces + and - and | characters", () => {
    const asciiStyle: RectStyle = {
      tl: "+",
      tr: "+",
      bl: "+",
      br: "+",
      h: "-",
      v: "|",
    };
    const cells = regenerateCells({ row: 0, col: 0, w: 3, h: 3 }, asciiStyle);
    expect(cells.get("0,0")).toBe("+");
    expect(cells.get("0,1")).toBe("-");
    expect(cells.get("0,2")).toBe("+");
    expect(cells.get("1,0")).toBe("|");
    expect(cells.get("1,1")).toBeUndefined(); // interior
    expect(cells.get("1,2")).toBe("|");
    expect(cells.get("2,0")).toBe("+");
    expect(cells.get("2,1")).toBe("-");
    expect(cells.get("2,2")).toBe("+");
    expect(cells.size).toBe(8);
  });
});

