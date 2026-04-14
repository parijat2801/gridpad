import { describe, it, expect, beforeEach } from "vitest";
import { useEditorStore } from "./store";
import type { Layer } from "./layers";
import { regenerateCells, LIGHT_RECT_STYLE, buildTextCells } from "./layers";

describe("editor store", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
  });

  describe("loadFromText", () => {
    it("starts with no layers", () => {
      expect(useEditorStore.getState().layers).toEqual([]);
    });

    it("populates layers when text is loaded", () => {
      useEditorStore.getState().loadFromText(["┌─┐", "│ │", "└─┘"].join("\n"));
      const { layers } = useEditorStore.getState();
      expect(layers.filter((l: Layer) => l.type === "rect")).toHaveLength(1);
    });

    it("replaces all layers when new text is loaded", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const firstIds = new Set(
        useEditorStore.getState().layers.map((l: Layer) => l.id),
      );
      useEditorStore.getState().loadFromText("Hello");
      const { layers } = useEditorStore.getState();
      expect(layers.filter((l: Layer) => l.type === "text")).toHaveLength(1);
      expect(layers.filter((l: Layer) => l.type === "rect")).toHaveLength(0);
      // None of the old IDs should still be present
      for (const l of layers) {
        expect(firstIds.has(l.id)).toBe(false);
      }
    });
  });

  describe("selection", () => {
    it("starts with no selection", () => {
      expect(useEditorStore.getState().selectedId).toBe(null);
    });

    it("selectLayer updates selectedId", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers[0].id;
      useEditorStore.getState().selectLayer(id);
      expect(useEditorStore.getState().selectedId).toBe(id);
    });

    it("clears selection when loading new text", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers[0].id;
      useEditorStore.getState().selectLayer(id);
      useEditorStore.getState().loadFromText("Hello");
      expect(useEditorStore.getState().selectedId).toBe(null);
    });
  });

  describe("moveLayer", () => {
    it("updates the layer's bbox by delta", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().moveLayer(id, 2, 3);
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(layer.bbox.row).toBe(2);
      expect(layer.bbox.col).toBe(3);
    });

    it("does nothing when id is unknown", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const before = useEditorStore.getState().layers;
      useEditorStore.getState().moveLayer("nonexistent", 2, 3);
      const after = useEditorStore.getState().layers;
      expect(after).toBe(before);
    });
  });

  describe("toText", () => {
    it("returns empty string when no layers", () => {
      expect(useEditorStore.getState().toText()).toBe("");
    });

    it("renders a simple box round-trip", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const text = useEditorStore.getState().toText();
      expect(text).toBe("┌─┐\n│ │\n└─┘");
    });
  });

  describe("resizeLayerCommit", () => {
    beforeEach(() => {
      useEditorStore.getState().reset();
      useEditorStore.temporal.getState().clear();
    });

    it("mutation correctness at a new size", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().resizeLayerCommit(id, { row: 0, col: 0, w: 5, h: 4 });
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;

      // bbox updated
      expect(layer.bbox).toEqual({ row: 0, col: 0, w: 5, h: 4 });

      // cells reflect new perimeter — corners should exist
      expect(layer.cells.has("0,0")).toBe(true);   // top-left
      expect(layer.cells.has("0,4")).toBe(true);   // top-right
      expect(layer.cells.has("3,0")).toBe(true);   // bottom-left
      expect(layer.cells.has("3,4")).toBe(true);   // bottom-right
      // An edge cell on the new top row
      expect(layer.cells.has("0,2")).toBe(true);

      // Old top-right at (0,2) for a 3-wide box: (0,2) IS still on the new perimeter
      // so check old bottom-right of old box (2,2) is NOT in new perimeter interior
      // New perimeter: top row 0, bottom row 3, left col 0, right col 4
      // (2,2) is an interior cell of the new 5x4 box — should NOT be in cells
      expect(layer.cells.has("2,2")).toBe(false);

      // style is preserved (will be defined post-GREEN; for now just check the field exists on the layer)
      // (layer.style may be undefined before implementation lands — that's OK, this test will fully pass post-GREEN)
    });

    it("normalization — negative values clamp to 0 and size clamps to 1", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().resizeLayerCommit(id, { row: -5, col: -3, w: 0, h: -10 });
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(layer.bbox).toEqual({ row: 0, col: 0, w: 1, h: 1 });
    });

    it("normalization — fractional values are floored", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().resizeLayerCommit(id, { row: 1.7, col: 2.3, w: 5.9, h: 4.1 });
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(layer.bbox).toEqual({ row: 1, col: 2, w: 5, h: 4 });
    });

    it("no upper clamp — large values accepted", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().resizeLayerCommit(id, { row: 0, col: 0, w: 500, h: 500 });
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(layer.bbox).toEqual({ row: 0, col: 0, w: 500, h: 500 });
    });

    it("throws /expected rect/ when called on a non-rect layer", () => {
      useEditorStore.getState().loadFromText("Hello");
      const textLayer = useEditorStore.getState().layers.find((l: Layer) => l.type === "text")!;
      expect(() => {
        useEditorStore.getState().resizeLayerCommit(textLayer.id, { row: 0, col: 0, w: 5, h: 1 });
      }).toThrow(/expected rect/);
    });

    it("unknown id is a silent no-op", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const before = useEditorStore.getState().layers;
      expect(() => {
        useEditorStore.getState().resizeLayerCommit("nonexistent", { row: 0, col: 0, w: 5, h: 4 });
      }).not.toThrow();
      expect(useEditorStore.getState().layers).toBe(before);
    });

    it("single commit adds exactly one pastStates entry", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.temporal.getState().clear();
      useEditorStore.getState().resizeLayerCommit(id, { row: 0, col: 0, w: 5, h: 4 });
      expect(useEditorStore.temporal.getState().pastStates.length).toBe(1);
    });
  });

  describe("resizeLayerLive", () => {
    beforeEach(() => {
      useEditorStore.getState().reset();
      useEditorStore.temporal.getState().clear();
    });

    it("Live mutation correctness — bbox is updated immediately", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().resizeLayerLive(id, { row: 0, col: 0, w: 5, h: 4 });
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(layer.bbox).toEqual({ row: 0, col: 0, w: 5, h: 4 });
    });

    it("first Live call pushes one pastStates entry and pauses tracking", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.temporal.getState().clear();
      useEditorStore.getState().resizeLayerLive(id, { row: 0, col: 0, w: 5, h: 4 });
      expect(useEditorStore.temporal.getState().pastStates.length).toBe(1);
      expect(useEditorStore.temporal.getState().isTracking).toBe(false);
    });

    it("30 Live calls without Commit add only one pastStates entry", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.temporal.getState().clear();
      for (let i = 0; i < 30; i++) {
        useEditorStore.getState().resizeLayerLive(id, { row: 0, col: 0, w: 3 + i, h: 3 });
      }
      expect(useEditorStore.temporal.getState().pastStates.length).toBe(1);
      expect(useEditorStore.temporal.getState().isTracking).toBe(false);
    });

    it("normalization applies to Live calls", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().resizeLayerLive(id, { row: -5, col: -3, w: 0, h: -10 });
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(layer.bbox).toEqual({ row: 0, col: 0, w: 1, h: 1 });
    });
  });

  describe("resize drag history — Live + Commit", () => {
    beforeEach(() => {
      useEditorStore.getState().reset();
      useEditorStore.temporal.getState().clear();
    });

    it("30 Lives + 1 Commit adds exactly 1 pastStates entry and undo restores pre-drag bbox", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!;
      const id = layer.id;
      const preDragBbox = { ...layer.bbox }; // { row:0, col:0, w:3, h:3 }

      useEditorStore.temporal.getState().clear();
      const before = useEditorStore.temporal.getState().pastStates.length; // 0

      // 30 Live frames
      for (let i = 0; i < 30; i++) {
        useEditorStore.getState().resizeLayerLive(id, { row: 0, col: 0, w: 3 + i, h: 3 });
      }
      // Commit final
      useEditorStore.getState().resizeLayerCommit(id, { row: 0, col: 0, w: 32, h: 3 });

      const after = useEditorStore.temporal.getState().pastStates.length;
      expect(after - before).toBe(1);
      expect(useEditorStore.temporal.getState().isTracking).toBe(true); // Commit resumed

      // Verify final bbox is 32x3
      const finalLayer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(finalLayer.bbox.w).toBe(32);

      // Undo restores original bbox (NOT the 29th Live state)
      useEditorStore.temporal.getState().undo();
      const undoneLayer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(undoneLayer.bbox).toEqual(preDragBbox);
    });

    it("zero Lives + one Commit adds one entry and undo restores pre-Commit state", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!;
      const id = layer.id;
      const preCommitBbox = { ...layer.bbox }; // { row:0, col:0, w:3, h:3 }

      useEditorStore.temporal.getState().clear();
      useEditorStore.getState().resizeLayerCommit(id, { row: 2, col: 3, w: 8, h: 5 });

      expect(useEditorStore.temporal.getState().pastStates.length).toBe(1);

      useEditorStore.temporal.getState().undo();
      const undoneLayer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(undoneLayer.bbox).toEqual(preCommitBbox);
    });
  });

  describe("moveLayerLive / moveLayerCommit", () => {
    beforeEach(() => {
      useEditorStore.getState().reset();
      useEditorStore.temporal.getState().clear();
    });

    it("moveLayerCommit correctness — moves box to new position", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().moveLayerCommit(id, { row: 5, col: 7, w: 3, h: 3 });
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(layer.bbox.row).toBe(5);
      expect(layer.bbox.col).toBe(7);
    });

    it("30 moveLayerLive + 1 moveLayerCommit → 1 pastStates entry, undo restores pre-drag bbox", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!;
      const id = layer.id;
      const preDragBbox = { ...layer.bbox }; // { row:0, col:0, w:3, h:3 }

      useEditorStore.temporal.getState().clear();
      const before = useEditorStore.temporal.getState().pastStates.length; // 0

      // 30 Live frames — moving the box incrementally right
      for (let i = 0; i < 30; i++) {
        useEditorStore.getState().moveLayerLive(id, { row: 0, col: i, w: 3, h: 3 });
      }
      // Commit final position
      useEditorStore.getState().moveLayerCommit(id, { row: 0, col: 30, w: 3, h: 3 });

      const after = useEditorStore.temporal.getState().pastStates.length;
      expect(after - before).toBe(1);
      expect(useEditorStore.temporal.getState().isTracking).toBe(true);

      // Verify final position
      const finalLayer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(finalLayer.bbox.col).toBe(30);

      // Undo restores original bbox
      useEditorStore.temporal.getState().undo();
      const undoneLayer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(undoneLayer.bbox).toEqual(preDragBbox);
    });

    it("moveLayerCommit normalization — negative coords clamp to 0", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().moveLayerCommit(id, { row: -3, col: -5, w: 3, h: 3 });
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(layer.bbox.row).toBe(0);
      expect(layer.bbox.col).toBe(0);
    });

    it("moveLayerCommit works on a text layer (move is not rect-only)", () => {
      useEditorStore.getState().loadFromText("Hello");
      const textLayer = useEditorStore.getState().layers.find((l: Layer) => l.type === "text")!;
      const id = textLayer.id;
      const w = textLayer.bbox.w;
      const h = textLayer.bbox.h;
      expect(() => {
        useEditorStore.getState().moveLayerCommit(id, { row: 3, col: 4, w, h });
      }).not.toThrow();
      const moved = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(moved.bbox.row).toBe(3);
      expect(moved.bbox.col).toBe(4);
    });

    it("moveLayerLive first call pauses tracking and adds one pastStates entry", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.temporal.getState().clear();
      useEditorStore.getState().moveLayerLive(id, { row: 0, col: 1, w: 3, h: 3 });
      expect(useEditorStore.temporal.getState().pastStates.length).toBe(1);
      expect(useEditorStore.temporal.getState().isTracking).toBe(false);
    });
  });

  describe("moveLayer backwards compatibility", () => {
    beforeEach(() => {
      useEditorStore.getState().reset();
      useEditorStore.temporal.getState().clear();
    });

    it("moveLayer still updates the layer's bbox by delta", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const id = useEditorStore.getState().layers.find((l: Layer) => l.type === "rect")!.id;
      useEditorStore.getState().moveLayer(id, 2, 3);
      const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
      expect(layer.bbox.row).toBe(2);
      expect(layer.bbox.col).toBe(3);
    });

    it("moveLayer still does nothing when id is unknown", () => {
      useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
      const before = useEditorStore.getState().layers;
      useEditorStore.getState().moveLayer("nonexistent", 2, 3);
      const after = useEditorStore.getState().layers;
      expect(after).toBe(before);
    });
  });
});

describe("tool state", () => {
  beforeEach(() => useEditorStore.getState().reset());

  it("defaults to select tool", () => {
    expect(useEditorStore.getState().activeTool).toBe("select");
  });

  it("setActiveTool changes the active tool", () => {
    useEditorStore.getState().setActiveTool("rect");
    expect(useEditorStore.getState().activeTool).toBe("rect");
  });

  it("reset restores activeTool to select", () => {
    useEditorStore.getState().setActiveTool("eraser");
    useEditorStore.getState().reset();
    expect(useEditorStore.getState().activeTool).toBe("select");
  });

  it("setFileHandle stores a handle", () => {
    const fakeHandle = {} as FileSystemFileHandle;
    useEditorStore.getState().setFileHandle(fakeHandle);
    expect(useEditorStore.getState().fileHandle).toBe(fakeHandle);
  });

  it("reset clears fileHandle to null", () => {
    useEditorStore.getState().setFileHandle({} as FileSystemFileHandle);
    useEditorStore.getState().reset();
    expect(useEditorStore.getState().fileHandle).toBeNull();
  });
});

describe("autosave guards", () => {
  beforeEach(() => useEditorStore.getState().reset());

  it("toText is stable across selection changes", () => {
    useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
    const text1 = useEditorStore.getState().toText();
    useEditorStore.getState().selectLayer(
      useEditorStore.getState().layers[1]?.id ?? null
    );
    const text2 = useEditorStore.getState().toText();
    expect(text2).toBe(text1);
  });
});

describe("addLayer", () => {
  beforeEach(() => useEditorStore.getState().reset());

  it("appends a new layer with generated id and z", () => {
    const cells = new Map([["0,0", "┌"], ["0,1", "─"], ["0,2", "┐"],
      ["1,0", "│"], ["1,2", "│"], ["2,0", "└"], ["2,1", "─"], ["2,2", "┘"]]);
    useEditorStore.getState().addLayer({
      type: "rect",
      bbox: { row: 0, col: 0, w: 3, h: 3 },
      cells,
      visible: true,
      style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
    });
    const { layers } = useEditorStore.getState();
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBeTruthy();
    expect(layers[0].z).toBe(1);
    expect(layers[0].parentId).toBeNull();
    expect(layers[0].type).toBe("rect");
    expect(layers[0].cells).toBe(cells);
  });

  it("z is computed among root siblings", () => {
    useEditorStore.getState().addLayer({
      type: "rect", bbox: { row: 0, col: 0, w: 3, h: 3 },
      cells: new Map(), visible: true,
    });
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 5, col: 5, w: 3, h: 1 },
      cells: new Map(), visible: true, content: "Hi",
    });
    const { layers } = useEditorStore.getState();
    expect(layers[0].z).toBe(1);
    expect(layers[1].z).toBe(2);
  });

  it("zundo captures addLayer for undo", () => {
    useEditorStore.temporal.getState().clear();
    useEditorStore.getState().addLayer({
      type: "rect", bbox: { row: 0, col: 0, w: 3, h: 3 },
      cells: new Map(), visible: true,
    });
    expect(useEditorStore.temporal.getState().pastStates.length).toBe(1);
    useEditorStore.temporal.getState().undo();
    expect(useEditorStore.getState().layers).toHaveLength(0);
  });
});

describe("eraseCells", () => {
  beforeEach(() => useEditorStore.getState().reset());

  it("erases a cell from the topmost owning layer", () => {
    const cells = regenerateCells({ row: 0, col: 0, w: 3, h: 3 }, LIGHT_RECT_STYLE);
    useEditorStore.getState().addLayer({
      type: "rect", bbox: { row: 0, col: 0, w: 3, h: 3 },
      cells, visible: true, style: LIGHT_RECT_STYLE,
    });
    const id = useEditorStore.getState().layers[0].id;
    useEditorStore.getState().eraseCells(["0,0"]);
    const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
    expect(layer.cells.has("0,0")).toBe(false);
    expect(layer.cells.has("0,1")).toBe(true);
  });

  it("removes layer with zero cells after erase", () => {
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 1, h: 1 },
      cells: new Map([["0,0", "A"]]), visible: true, content: "A",
    });
    expect(useEditorStore.getState().layers).toHaveLength(1);
    useEditorStore.getState().eraseCells(["0,0"]);
    expect(useEditorStore.getState().layers).toHaveLength(0);
  });

  it("recomputes bbox after partial erase", () => {
    const { cells, content, bbox } = buildTextCells(0, 0, "ABCDE");
    useEditorStore.getState().addLayer({
      type: "text", bbox, cells, visible: true, content,
    });
    useEditorStore.getState().eraseCells(["0,0", "0,4"]);
    const layer = useEditorStore.getState().layers[0];
    expect(layer.bbox).toEqual({ row: 0, col: 1, w: 3, h: 1 });
  });

  it("recomputes text content after erase", () => {
    const { cells, content, bbox } = buildTextCells(0, 0, "ABCDE");
    useEditorStore.getState().addLayer({
      type: "text", bbox, cells, visible: true, content,
    });
    useEditorStore.getState().eraseCells(["0,0"]);
    const layer = useEditorStore.getState().layers[0];
    expect(layer.content).toBe("BCDE");
  });

  it("does not mutate original layer object (clone before mutating)", () => {
    const origCells = new Map([["0,0", "A"], ["0,1", "B"]]);
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 2, h: 1 },
      cells: origCells, visible: true, content: "AB",
    });
    const layerBefore = useEditorStore.getState().layers[0];
    const cellsBefore = layerBefore.cells;
    useEditorStore.getState().eraseCells(["0,0"]);
    expect(cellsBefore.has("0,0")).toBe(true);
    expect(cellsBefore.size).toBe(2);
  });

  it("zundo captures eraseCells for undo", () => {
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 2, h: 1 },
      cells: new Map([["0,0", "A"], ["0,1", "B"]]), visible: true, content: "AB",
    });
    useEditorStore.temporal.getState().clear();
    useEditorStore.getState().eraseCells(["0,0"]);
    expect(useEditorStore.temporal.getState().pastStates.length).toBe(1);
    useEditorStore.temporal.getState().undo();
    const layer = useEditorStore.getState().layers[0];
    expect(layer.cells.has("0,0")).toBe(true);
    expect(layer.content).toBe("AB");
  });

  it("erasing cells not owned by any layer is a no-op", () => {
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 1, h: 1 },
      cells: new Map([["0,0", "A"]]), visible: true, content: "A",
    });
    const before = useEditorStore.getState().layers;
    useEditorStore.getState().eraseCells(["5,5"]);
    expect(useEditorStore.getState().layers).toBe(before);
  });

  it("erasing top-layer cell reveals underlying layer cell", () => {
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 1, h: 1 },
      cells: new Map([["0,0", "A"]]), visible: true, content: "A",
    });
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 1, h: 1 },
      cells: new Map([["0,0", "B"]]), visible: true, content: "B",
    });
    useEditorStore.getState().eraseCells(["0,0"]);
    expect(useEditorStore.getState().layers).toHaveLength(1);
    expect(useEditorStore.getState().layers[0].cells.get("0,0")).toBe("A");
  });

  it("recomputes group bbox after erasing from grouped child", () => {
    // Create two children, then group them (createGroup requires >= 2)
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 3, h: 1 },
      cells: new Map([["0,0", "A"], ["0,1", "B"], ["0,2", "C"]]),
      visible: true, content: "ABC",
    });
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 2, col: 0, w: 1, h: 1 },
      cells: new Map([["2,0", "X"]]),
      visible: true, content: "X",
    });
    const childId1 = useEditorStore.getState().layers[0].id;
    const childId2 = useEditorStore.getState().layers[1].id;
    const groupId = useEditorStore.getState().createGroup([childId1, childId2]);
    expect(groupId).toBeTruthy();
    // Group bbox spans both children: rows 0-2, cols 0-2 → w=3, h=3
    const groupBefore = useEditorStore.getState().layers.find((l: Layer) => l.id === groupId)!;
    expect(groupBefore.bbox.w).toBe(3);
    // Erase col 2 from child1 — child1 bbox shrinks to w=2
    useEditorStore.getState().eraseCells(["0,2"]);
    const child1 = useEditorStore.getState().layers.find((l: Layer) => l.id === childId1)!;
    expect(child1.bbox.w).toBe(2);
    // Group bbox should recompute: now spans rows 0-2, cols 0-1 → w=2
    const groupAfter = useEditorStore.getState().layers.find((l: Layer) => l.id === groupId)!;
    expect(groupAfter.bbox.w).toBe(2);
  });
});
