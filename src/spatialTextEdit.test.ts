/**
 * spatialTextEdit.test.ts — unit tests for pure text-grid edit logic.
 *
 * Tests applyDragToText, applyResizeToText, applyLiveDrag, applyLiveResize
 * without React or state.
 */
import { describe, it, expect } from "vitest";
import {
  applyDragToText,
  applyResizeToText,
  applyLiveDrag,
  applyLiveResize,
} from "./spatialTextEdit";
import type { Layer } from "./layers";
import { regenerateCells, LIGHT_RECT_STYLE } from "./layers";
import type { Bbox } from "./types";
import type { ResizeEdge } from "./spatialHitTest";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRectLayer(id: string, row: number, col: number, w: number, h: number, z = 1): Layer {
  const bbox: Bbox = { row, col, w, h };
  return {
    id,
    type: "rect",
    z,
    visible: true,
    bbox,
    cells: regenerateCells(bbox, LIGHT_RECT_STYLE),
    style: LIGHT_RECT_STYLE,
  };
}

// Wireframe text that matches a single 12-wide × 4-tall box at row=0, col=0.
// ┌──────────┐
// │          │
// │          │
// └──────────┘
const BOX_12x4_TEXT = [
  "┌──────────┐",
  "│          │",
  "│          │",
  "└──────────┘",
].join("\n");

// Two-box layout used for overlap/junction tests.
// Box A at row=0,col=0 w=12 h=4, Box B at row=0,col=14 w=10 h=4.
// Row 0: "┌──────────┐  ┌────────┐"
// Row 1: "│          │  │        │"
// Row 2: "│          │  │        │"
// Row 3: "└──────────┘  └────────┘"
const TWO_BOX_TEXT = [
  "┌──────────┐  ┌────────┐",
  "│          │  │        │",
  "│          │  │        │",
  "└──────────┘  └────────┘",
].join("\n");

const layerA = makeRectLayer("A", 0, 0, 12, 4, 1);
const layerB = makeRectLayer("B", 0, 14, 10, 4, 2);

// ── applyLiveDrag ─────────────────────────────────────────────────────────────

describe("applyLiveDrag", () => {
  it("shifts all cells by (dRow, dCol) and returns new position", () => {
    const layer = makeRectLayer("box", 0, 0, 12, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const result = applyLiveDrag(layer, startBbox, 2, 3);
    expect(result).not.toBeNull();
    expect(result!.newRow).toBe(2);
    expect(result!.newCol).toBe(3);
    // Original TL corner was at "0,0" → should now be at "2,3"
    expect(result!.cells.get("2,3")).toBe("┌");
    // Original TR corner was at "0,11" → "2,14"
    expect(result!.cells.get("2,14")).toBe("┐");
  });

  it("returns null when dRow and dCol are both zero", () => {
    const layer = makeRectLayer("box", 0, 0, 12, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const result = applyLiveDrag(layer, startBbox, 0, 0);
    expect(result).toBeNull();
  });

  it("preserves the number of cells after move", () => {
    const layer = makeRectLayer("box", 0, 0, 12, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const result = applyLiveDrag(layer, startBbox, 5, 5);
    expect(result!.cells.size).toBe(layer.cells.size);
  });

  it("handles negative deltas correctly", () => {
    // Layer starts at row=5,col=5; drag up-left by 2
    const layer = makeRectLayer("box", 5, 5, 6, 3, 1);
    const startBbox: Bbox = { row: 5, col: 5, w: 6, h: 3 };
    const result = applyLiveDrag(layer, startBbox, -2, -2);
    expect(result).not.toBeNull();
    expect(result!.newRow).toBe(3);
    expect(result!.newCol).toBe(3);
  });
});

// ── applyLiveResize ───────────────────────────────────────────────────────────

describe("applyLiveResize", () => {
  it("expands right edge and returns regenerated cells", () => {
    const layer = makeRectLayer("box", 0, 0, 12, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const edges: ResizeEdge = { top: false, bottom: false, left: false, right: true };
    const result = applyLiveResize(layer, startBbox, 0, 3, edges);
    expect(result).not.toBeNull();
    expect(result!.bbox.w).toBe(15);
    expect(result!.bbox.col).toBe(0);
    // New TR corner at "0,14"
    expect(result!.cells.get("0,14")).toBe("┐");
  });

  it("expands bottom edge correctly", () => {
    const layer = makeRectLayer("box", 0, 0, 12, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const edges: ResizeEdge = { top: false, bottom: true, left: false, right: false };
    const result = applyLiveResize(layer, startBbox, 2, 0, edges);
    expect(result).not.toBeNull();
    expect(result!.bbox.h).toBe(6);
    expect(result!.cells.get("5,0")).toBe("└");
  });

  it("shrinks from the top edge, adjusting row and height", () => {
    const layer = makeRectLayer("box", 0, 0, 12, 6, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 6 };
    const edges: ResizeEdge = { top: true, bottom: false, left: false, right: false };
    const result = applyLiveResize(layer, startBbox, 2, 0, edges);
    expect(result).not.toBeNull();
    expect(result!.bbox.row).toBe(2);
    expect(result!.bbox.h).toBe(4);
  });

  it("clamps minimum width to 2", () => {
    const layer = makeRectLayer("box", 0, 0, 4, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 4, h: 4 };
    const edges: ResizeEdge = { top: false, bottom: false, left: false, right: true };
    // Shrink by more than the width allows
    const result = applyLiveResize(layer, startBbox, 0, -10, edges);
    expect(result).not.toBeNull();
    expect(result!.bbox.w).toBe(2);
  });

  it("clamps minimum height to 2", () => {
    const layer = makeRectLayer("box", 0, 0, 4, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 4, h: 4 };
    const edges: ResizeEdge = { top: false, bottom: true, left: false, right: false };
    const result = applyLiveResize(layer, startBbox, -10, 0, edges);
    expect(result).not.toBeNull();
    expect(result!.bbox.h).toBe(2);
  });

  it("returns null when nothing changed", () => {
    const layer = makeRectLayer("box", 0, 0, 12, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const edges: ResizeEdge = { top: false, bottom: true, left: false, right: false };
    const result = applyLiveResize(layer, startBbox, 0, 0, edges);
    expect(result).toBeNull();
  });
});

// ── applyDragToText ───────────────────────────────────────────────────────────

describe("applyDragToText", () => {
  it("writes the layer at the new position after moving right and down", () => {
    // Start: layer at row=0,col=0; end: layer at row=1,col=2
    const movedLayer = makeRectLayer("A", 1, 2, 12, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const result = applyDragToText(BOX_12x4_TEXT, [movedLayer], "A", startBbox, 6);
    const lines = result.split("\n");
    // Row 1, col 2 is the TL corner of the moved box
    expect(lines[1]?.[2]).toBe("┌");
    // Row 0 is now blank (old position was erased)
    expect(lines[0].trim()).toBe("");
  });

  it("restores other layer chars at erased cells", () => {
    // Move box A right by 3; box B stays at col=14
    const movedA = makeRectLayer("A", 0, 3, 12, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const layers = [movedA, layerB];
    const result = applyDragToText(TWO_BOX_TEXT, layers, "A", startBbox, 4);
    const lines = result.split("\n");
    // Box B right edge is at col=23; it should still be present
    expect(lines[0][23]).toBe("┐");
  });

  it("returns original text when layerId is not found", () => {
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const result = applyDragToText(BOX_12x4_TEXT, [layerA], "NONEXISTENT", startBbox, 4);
    expect(result).toBe(BOX_12x4_TEXT);
  });

  it("places moved layer cells precisely in the text grid", () => {
    const movedLayer = makeRectLayer("A", 0, 5, 12, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const result = applyDragToText(BOX_12x4_TEXT, [movedLayer], "A", startBbox, 4);
    const lines = result.split("\n");
    // TL corner should now be at col=5
    expect(lines[0][5]).toBe("┌");
    // Old TL at col=0 should be gone
    expect(lines[0][0] ?? " ").toBe(" ");
  });
});

// ── applyResizeToText ─────────────────────────────────────────────────────────

describe("applyResizeToText", () => {
  it("erases old bbox and writes new wider box", () => {
    const resizedLayer = makeRectLayer("A", 0, 0, 16, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const result = applyResizeToText(BOX_12x4_TEXT, [resizedLayer], "A", startBbox, 4);
    const lines = result.split("\n");
    // New TR corner at col=15
    expect(lines[0][15]).toBe("┐");
    // Old TR corner at col=11 should now be interior horizontal border
    expect(lines[0][11]).toBe("─");
  });

  it("erases old bbox and writes new taller box", () => {
    const resizedLayer = makeRectLayer("A", 0, 0, 12, 6, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const tallText = BOX_12x4_TEXT + "\n" + " ".repeat(12) + "\n" + " ".repeat(12);
    const result = applyResizeToText(tallText, [resizedLayer], "A", startBbox, 6);
    const lines = result.split("\n");
    expect(lines[5][0]).toBe("└");
    expect(lines[5][11]).toBe("┘");
  });

  it("returns original text when layerId is not found", () => {
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const result = applyResizeToText(BOX_12x4_TEXT, [layerA], "NONEXISTENT", startBbox, 4);
    expect(result).toBe(BOX_12x4_TEXT);
  });

  it("restores other layers at overwritten positions after resize", () => {
    // Resize A from w=12 to w=10; B stays at col=14
    const resizedA = makeRectLayer("A", 0, 0, 10, 4, 1);
    const startBbox: Bbox = { row: 0, col: 0, w: 12, h: 4 };
    const layers = [resizedA, layerB];
    const result = applyResizeToText(TWO_BOX_TEXT, layers, "A", startBbox, 4);
    const lines = result.split("\n");
    // Box B right corner must survive
    expect(lines[0][23]).toBe("┐");
  });
});
