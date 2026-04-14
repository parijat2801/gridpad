/**
 * spatialHitTest.test.ts — unit tests for pure hit-testing functions.
 *
 * Tests findLayerAt, findProseAt, detectResizeEdge without React or state.
 */
import { describe, it, expect } from "vitest";
import { findLayerAt, findProseAt, detectResizeEdge } from "./spatialHitTest";
import type { Layer } from "./layers";
import { regenerateCells, LIGHT_RECT_STYLE } from "./layers";
import type { LayoutRegion } from "./spatialLayout";
import type { Region } from "./regions";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRectLayer(id: string, row: number, col: number, w: number, h: number, z = 1): Layer {
  return {
    id,
    type: "rect",
    z,
    visible: true,
    bbox: { row, col, w, h },
    cells: regenerateCells({ row, col, w, h }, LIGHT_RECT_STYLE),
    style: LIGHT_RECT_STYLE,
  };
}

// Two non-overlapping rect layers at known grid positions.
// outer: row=0,col=0,w=40,h=10
// inner: row=2,col=15,w=22,h=5  (represents an inner card)
const outerRect = makeRectLayer("outer", 0, 0, 40, 10, 1);
const innerRect = makeRectLayer("inner", 2, 15, 22, 5, 2);

const wireframeRegion: Region = {
  type: "wireframe",
  startRow: 0,
  endRow: 11,
  text: "",
  layers: [outerRect, innerRect],
};

const proseRegion: Region = {
  type: "prose",
  startRow: 0,
  endRow: 0,
  text: "Hello world\nSecond line with more text",
};

// cw=9.6, ch=20 — realistic monospace cell dimensions
const CW = 9.6;
const CH = 20;
const LH = 23; // line height for prose

function wireLR(y = 0): LayoutRegion {
  return { region: wireframeRegion, y, height: 12 * CH };
}

function proseLR(y = 0): LayoutRegion {
  return { region: proseRegion, y, height: 100 };
}

// ── findLayerAt ───────────────────────────────────────────────────────────────

describe("findLayerAt", () => {
  it("returns a hit when clicking inside the outer rect", () => {
    const lr = wireLR(0);
    // Click at grid row=5, col=5 — inside outer, outside inner
    const hit = findLayerAt([lr], 5 * CW + 1, 5 * CH + 1, CW, CH);
    expect(hit).not.toBeNull();
    expect(hit!.layer.id).toBe("outer");
    expect(hit!.lrIdx).toBe(0);
  });

  it("returns null when clicking outside all layers", () => {
    const lr = wireLR(0);
    // Click at grid row=20 — beyond outer rect (h=10)
    const hit = findLayerAt([lr], 5 * CW, 20 * CH + 1, CW, CH);
    expect(hit).toBeNull();
  });

  it("picks the highest-z layer when layers overlap", () => {
    const lr = wireLR(0);
    // inner rect occupies rows 2-6, cols 15-36
    // Click at row=3, col=16 — inside both outer and inner
    const hit = findLayerAt([lr], 16 * CW + 1, 3 * CH + 1, CW, CH);
    expect(hit).not.toBeNull();
    expect(hit!.layer.id).toBe("inner"); // inner has z=2 > outer z=1
  });

  it("skips base layers", () => {
    const base: Layer = {
      id: "base",
      type: "base",
      z: 0,
      visible: true,
      bbox: { row: 0, col: 0, w: 50, h: 20 },
      cells: new Map([["0,0", " "]]),
    };
    // The only layer in the region is a base layer
    const region: Region = { type: "wireframe", startRow: 0, endRow: 19, text: "", layers: [base] };
    const lr: LayoutRegion = { region, y: 0, height: 20 * CH };
    const hit = findLayerAt([lr], 0, 0, CW, CH);
    expect(hit).toBeNull();
  });

  it("skips group layers", () => {
    const group: Layer = {
      id: "grp",
      type: "group",
      z: 5,
      visible: true,
      bbox: { row: 0, col: 0, w: 10, h: 10 },
      cells: new Map(),
    };
    const region: Region = { type: "wireframe", startRow: 0, endRow: 9, text: "", layers: [group] };
    const lr: LayoutRegion = { region, y: 0, height: 10 * CH };
    const hit = findLayerAt([lr], 2 * CW, 2 * CH + 1, CW, CH);
    expect(hit).toBeNull();
  });

  it("skips invisible layers", () => {
    const hidden: Layer = { ...outerRect, id: "hidden", visible: false };
    const region: Region = { type: "wireframe", startRow: 0, endRow: 10, text: "", layers: [hidden] };
    const lr: LayoutRegion = { region, y: 0, height: 11 * CH };
    const hit = findLayerAt([lr], 5 * CW, 5 * CH + 1, CW, CH);
    expect(hit).toBeNull();
  });

  it("returns null when region is prose, not wireframe", () => {
    const hit = findLayerAt([proseLR(0)], 5 * CW, 5, CW, CH);
    expect(hit).toBeNull();
  });

  it("returns correct lrIdx when multiple laid regions exist", () => {
    const lr0 = proseLR(0);
    const lr1 = wireLR(200);
    // Click inside second region (offset y=200), at grid row=1 → docY=201+CH
    const hit = findLayerAt([lr0, lr1], 2 * CW + 1, 200 + 1 * CH + 1, CW, CH);
    expect(hit).not.toBeNull();
    expect(hit!.lrIdx).toBe(1);
  });
});

// ── findProseAt ───────────────────────────────────────────────────────────────

describe("findProseAt", () => {
  it("returns correct regionIdx, row, col for a click in the first line", () => {
    const lr = proseLR(0);
    // Click at mid-line, line 0 (localY = LH/2 → visualLineIdx = 0)
    const cursor = findProseAt([lr], 3 * CW, LH / 2, CW, CH, LH, 800);
    expect(cursor).not.toBeNull();
    expect(cursor!.regionIdx).toBe(0);
    expect(cursor!.row).toBe(0);
    expect(cursor!.col).toBe(3);
  });

  it("returns correct row for a click in the second source line", () => {
    const lr = proseLR(0);
    // Second source line starts at visualLine 1 → y around LH*1.5
    const cursor = findProseAt([lr], 5 * CW, LH * 1.5, CW, CH, LH, 800);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(1);
  });

  it("returns null when clicking outside the prose region vertically", () => {
    const lr = proseLR(0); // height=100
    const cursor = findProseAt([lr], 0, 200, CW, CH, LH, 800);
    expect(cursor).toBeNull();
  });

  it("returns null when the region is a wireframe", () => {
    const lr = wireLR(0);
    const cursor = findProseAt([lr], 5 * CW, 5 * CH, CW, CH, LH, 800);
    expect(cursor).toBeNull();
  });

  it("clamps col to line length for clicks past the end of a line", () => {
    const lr = proseLR(0);
    // "Hello world" is 11 chars; click at col 999
    const cursor = findProseAt([lr], 999 * CW, LH / 2, CW, CH, LH, 800);
    expect(cursor).not.toBeNull();
    const lineLen = "Hello world".length;
    expect(cursor!.col).toBeLessThanOrEqual(lineLen);
  });
});

// ── detectResizeEdge ──────────────────────────────────────────────────────────

describe("detectResizeEdge", () => {
  // Layer at row=2, col=3, w=10, h=6  → spans rows 2-7, cols 3-12
  const layer = makeRectLayer("box", 2, 3, 10, 6, 1);
  const threshold = 0;

  it("returns top edge when clicking on the top row", () => {
    const edge = detectResizeEdge(layer, 2, 7, threshold);
    expect(edge).not.toBeNull();
    expect(edge!.top).toBe(true);
    expect(edge!.bottom).toBe(false);
  });

  it("returns bottom edge when clicking on the bottom row", () => {
    const edge = detectResizeEdge(layer, 7, 7, threshold);
    expect(edge).not.toBeNull();
    expect(edge!.bottom).toBe(true);
    expect(edge!.top).toBe(false);
  });

  it("returns left edge when clicking on the left col", () => {
    const edge = detectResizeEdge(layer, 4, 3, threshold);
    expect(edge).not.toBeNull();
    expect(edge!.left).toBe(true);
    expect(edge!.right).toBe(false);
  });

  it("returns right edge when clicking on the right col", () => {
    const edge = detectResizeEdge(layer, 4, 12, threshold);
    expect(edge).not.toBeNull();
    expect(edge!.right).toBe(true);
    expect(edge!.left).toBe(false);
  });

  it("returns top-left corner with both top and left set", () => {
    const edge = detectResizeEdge(layer, 2, 3, threshold);
    expect(edge).not.toBeNull();
    expect(edge!.top).toBe(true);
    expect(edge!.left).toBe(true);
  });

  it("returns null when clicking in the interior", () => {
    // Interior: row=4, col=7 — well inside the bbox with threshold=0
    const edge = detectResizeEdge(layer, 4, 7, threshold);
    expect(edge).toBeNull();
  });

  it("widens the detection zone with a positive threshold", () => {
    // row=3 is one row inside top border; with threshold=1 it should still trigger top
    const edge = detectResizeEdge(layer, 3, 7, 1);
    expect(edge).not.toBeNull();
    expect(edge!.top).toBe(true);
  });
});
