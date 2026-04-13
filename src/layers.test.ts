import { describe, it, expect } from "vitest";
import {
  buildLayersFromScan,
  compositeLayers,
  deleteLayer,
  isEffectivelyVisible,
  layerToText,
  moveLayer,
  moveLayerCascading,
  regenerateCells,
  toggleVisible,
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

  describe("layerToText", () => {
    it("returns empty string for empty layers", () => {
      expect(layerToText([])).toBe("");
    });

    it("round-trips a simple box", () => {
      const result = scan(["┌─┐", "│ │", "└─┘"].join("\n"));
      const layers = buildLayersFromScan(result);
      const text = layerToText(layers);
      expect(text).toBe(["┌─┐", "│ │", "└─┘"].join("\n"));
    });

    it("round-trips a box at an offset", () => {
      const input = ["   ┌─┐", "   │ │", "   └─┘"].join("\n");
      const result = scan(input);
      const layers = buildLayersFromScan(result);
      const text = layerToText(layers);
      // Reparse what we wrote back, verify same shape
      const reparsed = scan(text);
      expect(reparsed.rects).toHaveLength(1);
      expect(reparsed.rects[0].w).toBe(3);
      expect(reparsed.rects[0].h).toBe(3);
    });

    it("trims trailing whitespace on each row", () => {
      const layer: Layer = {
        id: "t",
        type: "text",
        z: 1,
        visible: true,
        bbox: { row: 0, col: 0, w: 5, h: 1 },
        cells: new Map([
          ["0,0", "H"],
          ["0,1", "i"],
        ]),
      };
      const text = layerToText([layer]);
      expect(text).toBe("Hi");
    });
  });

  describe("moveLayer", () => {
    it("updates bbox row/col by delta", () => {
      const layer: Layer = {
        id: "t",
        type: "rect",
        z: 1,
        visible: true,
        bbox: { row: 0, col: 0, w: 3, h: 3 },
        cells: new Map([["0,0", "A"]]),
      };
      const moved = moveLayer(layer, 2, 3);
      expect(moved.bbox.row).toBe(2);
      expect(moved.bbox.col).toBe(3);
      expect(moved.bbox.w).toBe(3);
      expect(moved.bbox.h).toBe(3);
    });

    it("shifts cell coordinates by delta", () => {
      const layer: Layer = {
        id: "t",
        type: "rect",
        z: 1,
        visible: true,
        bbox: { row: 0, col: 0, w: 3, h: 3 },
        cells: new Map([
          ["0,0", "A"],
          ["1,2", "B"],
        ]),
      };
      const moved = moveLayer(layer, 2, 3);
      expect(moved.cells.get("2,3")).toBe("A");
      expect(moved.cells.get("3,5")).toBe("B");
      expect(moved.cells.has("0,0")).toBe(false);
    });

    it("preserves immutability of the original layer", () => {
      const layer: Layer = {
        id: "t",
        type: "rect",
        z: 1,
        visible: true,
        bbox: { row: 0, col: 0, w: 3, h: 3 },
        cells: new Map([["0,0", "A"]]),
      };
      moveLayer(layer, 5, 5);
      // Original unchanged
      expect(layer.bbox.row).toBe(0);
      expect(layer.cells.get("0,0")).toBe("A");
    });
  });

  describe("non-destructive layering", () => {
    it("moving one layer does not affect another layer sharing a cell", () => {
      // Two layers that both paint something at (0,0)
      const layerA: Layer = {
        id: "a",
        type: "rect",
        z: 1,
        visible: true,
        bbox: { row: 0, col: 0, w: 1, h: 1 },
        cells: new Map([["0,0", "A"]]),
      };
      const layerB: Layer = {
        id: "b",
        type: "rect",
        z: 2,
        visible: true,
        bbox: { row: 0, col: 0, w: 1, h: 1 },
        cells: new Map([["0,0", "B"]]),
      };

      // Before move, composite shows B (higher z)
      expect(compositeLayers([layerA, layerB]).get("0,0")).toBe("B");

      // Move B away
      const movedB = moveLayer(layerB, 5, 5);
      // Composite now shows A at (0,0) and B at (5,5)
      const composite = compositeLayers([layerA, movedB]);
      expect(composite.get("0,0")).toBe("A");
      expect(composite.get("5,5")).toBe("B");
      // A is still intact
      expect(layerA.cells.get("0,0")).toBe("A");
    });

    it("two shared-wall rectangles: moving one preserves the other's wall", () => {
      // Parse a two-box shared-wall table
      const text = ["┌─┬─┐", "│ │ │", "└─┴─┘"].join("\n");
      const result = scan(text);
      const layers = buildLayersFromScan(result);
      expect(layers.filter((l) => l.type === "rect")).toHaveLength(2);

      const rects: Layer[] = layers.filter((l: Layer) => l.type === "rect");
      const [left, right] = rects.sort((a: Layer, b: Layer) => a.bbox.col - b.bbox.col);

      // Move the left box down by 5 rows. The right box's wall should
      // remain intact at its original position.
      const movedLeft = moveLayer(left, 5, 0);
      const composite = compositeLayers([movedLeft, right]);

      // Right box's original left wall (shared col 2) should still be there
      expect(composite.get("0,2")).toBeTruthy();
      expect(composite.get("1,2")).toBeTruthy();
      expect(composite.get("2,2")).toBeTruthy();

      // Left box should have moved to rows 5-7
      expect(composite.get("5,0")).toBeTruthy();
      expect(composite.get("7,0")).toBeTruthy();
    });
  });

  describe("verbatim character preservation", () => {
    it("preserves ASCII corner/edge characters exactly", () => {
      // User used plain ASCII, not Unicode box-drawing
      const input = ["+---+", "|   |", "+---+"].join("\n");
      const layers = buildLayersFromScan(scan(input));
      const rectLayers = layers.filter((l: Layer) => l.type === "rect");
      expect(rectLayers).toHaveLength(1);
      const layer = rectLayers[0];
      // Every cell should be the literal character the user typed
      expect(layer.cells.get("0,0")).toBe("+");
      expect(layer.cells.get("0,1")).toBe("-");
      expect(layer.cells.get("0,4")).toBe("+");
      expect(layer.cells.get("1,0")).toBe("|");
      expect(layer.cells.get("2,4")).toBe("+");
    });

    it("preserves heavy Unicode box-drawing", () => {
      const input = ["┏━┓", "┃ ┃", "┗━┛"].join("\n");
      const layers = buildLayersFromScan(scan(input));
      // Heavy corners aren't in our corner set, so this falls through to
      // unclaimed base layer. The characters MUST still be exactly what the
      // user typed.
      const text = layerToText(layers);
      expect(text).toBe(input);
    });

    it("never converts | to - even for orphaned characters", () => {
      // The space-bug repro: user has a box, presses space inside it,
      // breaking the right wall alignment. The scanner can't find the
      // rectangle. The orphaned │ characters must NOT be rewritten as ─.
      const input = "┌───┐\n│    │\n└───┘";
      const layers = buildLayersFromScan(scan(input));
      const text = layerToText(layers);
      // Every character in the input should survive unchanged
      expect(text).toBe(input);
    });
  });

  // After 2026-04-11-resize-design.md: rect perimeter cells are
  // regenerated from extracted style. Canonical Unicode light and
  // all-`+` ASCII inputs round-trip unchanged. Heavy/double edge
  // families canonicalize to light (v1 limitation; v2 family
  // preservation). Shared-wall junctions canonicalize to the top-z
  // rect's standalone corner (v1 limitation; v2 junction recomposition).
  describe("round-trip invariant: no character is ever rewritten", () => {
    const cases: Array<{ input: string; skip?: boolean; reason?: string }> = [
      { input: "┌─┐\n│ │\n└─┘" },                                // perfect box
      { input: "┌───┐\n│    │\n└───┘" },                          // broken box (mid-edit)
      {
        input: "┌─┬─┐\n│ │ │\n└─┴─┘",
        skip: true,
        reason:
          "TODO: v2 junction recomposition — after extractRectStyle/regenerateCells, shared ┬ canonicalizes to ┐ for the left rect and ┌ for the right rect, and the top-z right rect wins at the shared cell.",
      },
      { input: "+-+|X|+-+" },                                     // plain ASCII with weird layout
      { input: "│ │" },                                           // two orphan verticals
      { input: "──────" },                                        // standalone horizontal
      { input: "Hello, World" },                                  // plain text
      { input: "┌─┐ ┌─┐\n│A│ │B│\n└─┘ └─┘" },                    // two side-by-side boxes
      { input: "│" },                                             // single vertical bar
      { input: "+" },                                             // single plus sign
    ];
    for (const c of cases) {
      const test = c.skip ? it.skip : it;
      test(
        `round-trips unchanged: ${JSON.stringify(c.input)}${c.reason ? " (" + c.reason + ")" : ""}`,
        () => {
          const layers = buildLayersFromScan(scan(c.input));
          const out = layerToText(layers);
          expect(out).toBe(c.input);
        },
      );
    }
  });
});

// ── DFS composite + hierarchical actions ─────────────────────────

describe("compositeLayers DFS with groups", () => {
  it("compose flat layers matches old flat-sort behavior", () => {
    const layers = buildLayersFromScan(scan("┌─┐\n│ │\n└─┘"));
    const composited = compositeLayers(layers);
    // Every rect perimeter cell must be present
    expect(composited.get("0,0")).toBe("┌");
    expect(composited.get("0,1")).toBe("─");
    expect(composited.get("0,2")).toBe("┐");
    expect(composited.get("1,0")).toBe("│");
    expect(composited.get("1,2")).toBe("│");
    expect(composited.get("2,0")).toBe("└");
    expect(composited.get("2,1")).toBe("─");
    expect(composited.get("2,2")).toBe("┘");
  });

  it("hidden group hides all descendants in composite", () => {
    const group = makeLayer("g1", { type: "group", parentId: null, visible: false, z: 0, cells: new Map() });
    const child = makeLayer("r1", {
      type: "rect",
      parentId: "g1",
      z: 0,
      cells: new Map([["5,5", "X"]]),
      bbox: { row: 5, col: 5, w: 1, h: 1 },
    });
    const composited = compositeLayers([group, child]);
    expect(composited.get("5,5")).toBeUndefined();
  });

  it("visible group with visible children composites descendants", () => {
    const group = makeLayer("g1", { type: "group", parentId: null, visible: true, z: 0, cells: new Map() });
    const child = makeLayer("r1", {
      type: "rect",
      parentId: "g1",
      z: 0,
      cells: new Map([["5,5", "X"]]),
      bbox: { row: 5, col: 5, w: 1, h: 1 },
    });
    const composited = compositeLayers([group, child]);
    expect(composited.get("5,5")).toBe("X");
  });

  it("nested groups: walking top-down respects z within each level", () => {
    // Two roots at z=0, z=1. Lower z paints first, higher overwrites.
    const a = makeLayer("a", { z: 0, parentId: null, cells: new Map([["0,0", "A"]]) });
    const b = makeLayer("b", { z: 1, parentId: null, cells: new Map([["0,0", "B"]]) });
    const composited = compositeLayers([a, b]);
    expect(composited.get("0,0")).toBe("B"); // b has higher z, wins
  });
});

describe("isEffectivelyVisible", () => {
  it("returns true for top-level visible layer", () => {
    const l = makeLayer("r1", { parentId: null, visible: true });
    const byId = new Map([[l.id, l]]);
    expect(isEffectivelyVisible(l, byId)).toBe(true);
  });

  it("returns false if the layer itself is hidden", () => {
    const l = makeLayer("r1", { parentId: null, visible: false });
    const byId = new Map([[l.id, l]]);
    expect(isEffectivelyVisible(l, byId)).toBe(false);
  });

  it("returns false if an ancestor group is hidden", () => {
    const g = makeLayer("g1", { type: "group", parentId: null, visible: false });
    const child = makeLayer("r1", { parentId: "g1", visible: true });
    const byId = new Map<string, Layer>([[g.id, g], [child.id, child]]);
    expect(isEffectivelyVisible(child, byId)).toBe(false);
  });

  it("returns true if layer and all ancestors are visible", () => {
    const g = makeLayer("g1", { type: "group", parentId: null, visible: true });
    const child = makeLayer("r1", { parentId: "g1", visible: true });
    const byId = new Map<string, Layer>([[g.id, g], [child.id, child]]);
    expect(isEffectivelyVisible(child, byId)).toBe(true);
  });
});

describe("moveLayerCascading", () => {
  it("moving a group cascades to all descendants", () => {
    const g = makeLayer("g1", { type: "group", parentId: null, bbox: { row: 0, col: 0, w: 5, h: 5 } });
    const child = makeLayer("r1", {
      parentId: "g1",
      bbox: { row: 1, col: 1, w: 3, h: 3 },
      cells: new Map([["1,1", "x"]]),
    });
    const out = moveLayerCascading([g, child], "g1", 2, 3);
    const movedGroup = out.find((l) => l.id === "g1")!;
    const movedChild = out.find((l) => l.id === "r1")!;
    expect(movedGroup.bbox).toEqual({ row: 2, col: 3, w: 5, h: 5 });
    expect(movedChild.bbox).toEqual({ row: 3, col: 4, w: 3, h: 3 });
    expect(movedChild.cells.get("3,4")).toBe("x");
  });

  it("moving a leaf rect does not affect siblings", () => {
    const r1 = makeLayer("r1", { bbox: { row: 0, col: 0, w: 3, h: 3 }, cells: new Map([["0,0", "a"]]) });
    const r2 = makeLayer("r2", { bbox: { row: 10, col: 10, w: 3, h: 3 }, cells: new Map([["10,10", "b"]]) });
    const out = moveLayerCascading([r1, r2], "r1", 1, 1);
    const moved = out.find((l) => l.id === "r1")!;
    const unchanged = out.find((l) => l.id === "r2")!;
    expect(moved.bbox.row).toBe(1);
    expect(unchanged.bbox.row).toBe(10);
  });
});

describe("deleteLayer", () => {
  it("removes target and all descendants", () => {
    const g = makeLayer("g1", { type: "group" });
    const c1 = makeLayer("c1", { parentId: "g1" });
    const c2 = makeLayer("c2", { parentId: "g1" });
    const unrelated = makeLayer("u1");
    const out = deleteLayer([g, c1, c2, unrelated], "g1");
    expect(out.find((l) => l.id === "g1")).toBeUndefined();
    expect(out.find((l) => l.id === "c1")).toBeUndefined();
    expect(out.find((l) => l.id === "c2")).toBeUndefined();
    expect(out.find((l) => l.id === "u1")).toBeDefined();
  });

  it("deleting a rect does NOT remove unrelated text inside it (no implicit containment)", () => {
    // A rect and a text layer that is geometrically inside the rect but has
    // no parentId relationship. Deleting the rect must leave the text.
    const rect = makeLayer("r1", { bbox: { row: 0, col: 0, w: 10, h: 5 } });
    const text = makeLayer("t1", {
      type: "text",
      parentId: null, // explicitly top-level, NOT parented to rect
      bbox: { row: 2, col: 2, w: 5, h: 1 },
      content: "label",
    });
    const out = deleteLayer([rect, text], "r1");
    expect(out.find((l) => l.id === "r1")).toBeUndefined();
    expect(out.find((l) => l.id === "t1")).toBeDefined();
  });
});

describe("toggleVisible", () => {
  it("toggles target's own visible field only (no descendant cascade)", () => {
    const g = makeLayer("g1", { type: "group", visible: true });
    const child = makeLayer("c1", { parentId: "g1", visible: true });
    const out = toggleVisible([g, child], "g1");
    const outG = out.find((l) => l.id === "g1")!;
    const outC = out.find((l) => l.id === "c1")!;
    expect(outG.visible).toBe(false);
    expect(outC.visible).toBe(true); // unchanged — cascade is effective-only
  });

  it("no-op on nonexistent id", () => {
    const r1 = makeLayer("r1", { visible: true });
    const out = toggleVisible([r1], "does-not-exist");
    expect(out.find((l) => l.id === "r1")!.visible).toBe(true);
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
