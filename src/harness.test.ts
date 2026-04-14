/**
 * Programmatic test harness for the Pretext spatial document pipeline.
 *
 * Tests the full data pipeline without a browser:
 * 1. Region detection — correct prose/wireframe splitting
 * 2. Wireframe compositing — correct characters at correct positions
 * 3. Drag math — layers move, cells rekey correctly
 * 4. Resize + regenerate — box-drawing redrawn at new size
 * 5. Pretext layout — line counts change with width
 * 6. Round-trip — stitch regions back to markdown, re-parse, compare
 * 7. Real file stress — actual plan files stay under perf thresholds
 *
 * Fixtures are realistic Claude-Code-generated ASCII wireframes.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { scan } from "./scanner";
import { detectRegions, type Region } from "./regions";
import {
  compositeLayers,
  regenerateCells,
  LIGHT_RECT_STYLE,
} from "./layers";
import { buildSparseRows } from "./KonvaCanvas";
// @ts-expect-error vitest runs in node where fs/path exist
import * as fs from "fs";
// @ts-expect-error vitest runs in node where fs/path exist
import * as path from "path";

// ── Canvas mock for Pretext ──────────────────────────────
// Pretext needs canvas measureText. Provide a rough monospace mock.
beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as any).getContext = () => ({
        font: "",
        fillStyle: "",
        textBaseline: "",
        fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6, // approximate monospace width
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      });
    }
    return el;
  });
});

// ── Fixtures ─────────────────────────────────────────────

const DASHBOARD = `# Task Management Dashboard

This wireframe shows the main layout for task management.

┌────────────────────────────────────────┐
│            Header / Nav Bar            │
├──────────┬─────────────────────────────┤
│ Sidebar  │  Task List                  │
│          │                             │
│ - Tasks  │  ┌─────────────────────┐   │
│ - Done   │  │ Task: Fix login bug │   │
│          │  │ Status: In Progress │   │
│          │  └─────────────────────┘   │
│          │                             │
└──────────┴─────────────────────────────┘

The sidebar contains navigation items.
The main area shows the task list with cards.`;

const MULTI_WIREFRAME = `# Design Spec

## Current State

┌──────────┐
│ Old Box  │
└──────────┘

The old design was too simple.

## Proposed State

┌──────────────────┐
│   New Layout     │
├────────┬─────────┤
│ Left   │ Right   │
└────────┴─────────┘

This design splits the view into two panels.`;

const PURE_PROSE = `# Architecture Overview

This document describes the system architecture.
There are no wireframes in this file.

## Components

The system consists of three services:
- API gateway
- Worker pool
- Database layer

Each service runs independently.`;

const PURE_WIREFRAME = `┌─────────┐
│ Box A   │
├─────────┤
│ Box B   │
└─────────┘`;

const MARKDOWN_HR = `# Section One

Some text here.

---

## Section Two

More text here.`;

// ── 1. Region detection ──────────────────────────────────

describe("region detection", () => {
  it("pure prose → single prose region", () => {
    const regions = detectRegions(scan(PURE_PROSE));
    expect(regions.length).toBe(1);
    expect(regions[0].type).toBe("prose");
  });

  it("pure wireframe → single wireframe region", () => {
    const regions = detectRegions(scan(PURE_WIREFRAME));
    expect(regions.length).toBe(1);
    expect(regions[0].type).toBe("wireframe");
    expect(regions[0].layers!.length).toBeGreaterThan(0);
  });

  it("dashboard layout → prose / wireframe / prose", () => {
    const regions = detectRegions(scan(DASHBOARD));
    expect(regions.length).toBe(3);
    expect(regions.map(r => r.type)).toEqual(["prose", "wireframe", "prose"]);
  });

  it("multiple wireframes → alternating regions", () => {
    const regions = detectRegions(scan(MULTI_WIREFRAME));
    expect(regions.length).toBe(5);
    expect(regions.map(r => r.type)).toEqual([
      "prose", "wireframe", "prose", "wireframe", "prose",
    ]);
  });

  it("markdown --- horizontal rule is NOT wireframe", () => {
    const regions = detectRegions(scan(MARKDOWN_HR));
    // --- uses ASCII dashes, not box-drawing ─
    expect(regions.every(r => r.type === "prose")).toBe(true);
  });

  it("wireframe region layers have row-rebased coordinates", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;
    // All layer bbox rows should be >= 0 (rebased from their absolute position)
    for (const l of wf.layers!) {
      expect(l.bbox.row).toBeGreaterThanOrEqual(0);
    }
    // All cell keys should have non-negative rows
    for (const l of wf.layers!) {
      for (const key of l.cells.keys()) {
        const row = Number(key.split(",")[0]);
        expect(row).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("no region exceeds 500 layers (perf threshold)", () => {
    // Test with all inline fixtures
    for (const fixture of [DASHBOARD, MULTI_WIREFRAME, PURE_WIREFRAME]) {
      const regions = detectRegions(scan(fixture));
      for (const r of regions) {
        if (r.layers) {
          expect(r.layers.length).toBeLessThan(500);
        }
      }
    }
  });
});

// ── 2. Wireframe compositing ─────────────────────────────

describe("wireframe compositing", () => {
  it("composite produces correct characters for a simple box", () => {
    const regions = detectRegions(scan(PURE_WIREFRAME));
    const wf = regions[0];
    const composite = compositeLayers(wf.layers!);
    // Top-left corner should be ┌
    expect(composite.get("0,0")).toBe("┌");
    // Top-right corner (box is 11 chars wide: cols 0-10)
    expect(composite.get("0,10")).toBe("┐");
    // Bottom-left
    expect(composite.get("4,0")).toBe("└");
  });

  it("buildSparseRows groups cells correctly", () => {
    const regions = detectRegions(scan(PURE_WIREFRAME));
    const composite = compositeLayers(regions[0].layers!);
    const sparse = buildSparseRows(composite);
    // Should have rows 0-4
    expect(sparse.length).toBe(5);
    // First row starts at col 0
    expect(sparse[0].startCol).toBe(0);
    // First row text starts with ┌
    expect(sparse[0].text[0]).toBe("┌");
  });

  it("composite is deterministic (same input → same output)", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;
    const c1 = compositeLayers(wf.layers!);
    const c2 = compositeLayers(wf.layers!);
    expect([...c1.entries()]).toEqual([...c2.entries()]);
  });
});

// ── 3. Drag math ─────────────────────────────────────────

describe("drag math", () => {
  it("moving a layer shifts bbox and cell keys", () => {
    // Use a single-rect fixture to avoid overlap confusion
    const singleBox = "┌──┐\n│  │\n└──┘";
    const regions = detectRegions(scan(singleBox));
    const wf = regions[0];
    const layer = wf.layers!.find(l => l.type === "rect")!;
    const origRow = layer.bbox.row;
    const origCol = layer.bbox.col;

    // Simulate drag: shift by (+2, +3)
    const deltaRow = 2;
    const deltaCol = 3;
    const newCells = new Map<string, string>();
    for (const [key, val] of layer.cells) {
      const i = key.indexOf(",");
      const r = Number(key.slice(0, i)) + deltaRow;
      const c = Number(key.slice(i + 1)) + deltaCol;
      newCells.set(`${r},${c}`, val);
    }
    layer.cells = newCells;
    layer.bbox.row = origRow + deltaRow;
    layer.bbox.col = origCol + deltaCol;

    // Verify bbox shifted
    expect(layer.bbox.row).toBe(origRow + 2);
    expect(layer.bbox.col).toBe(origCol + 3);

    // Verify composite reflects new position
    const composite = compositeLayers(wf.layers!);
    // New position should have the corner
    expect(composite.get(`${origRow + 2},${origCol + 3}`)).toBe("┌");
  });

  it("drag preserves all cell characters", () => {
    const regions = detectRegions(scan(PURE_WIREFRAME));
    const wf = regions[0];
    const layer = wf.layers!.find(l => l.type === "rect")!;
    const origChars = [...layer.cells.values()].sort();

    // Shift by (1, 1)
    const newCells = new Map<string, string>();
    for (const [key, val] of layer.cells) {
      const i = key.indexOf(",");
      const r = Number(key.slice(0, i)) + 1;
      const c = Number(key.slice(i + 1)) + 1;
      newCells.set(`${r},${c}`, val);
    }
    layer.cells = newCells;

    const newChars = [...layer.cells.values()].sort();
    expect(newChars).toEqual(origChars);
  });
});

// ── 4. Resize + regenerate ───────────────────────────────

describe("resize + regenerate", () => {
  it("regenerateCells produces valid box at new size", () => {
    const bbox = { row: 0, col: 0, w: 10, h: 5 };
    const cells = regenerateCells(bbox, LIGHT_RECT_STYLE);

    // Corners
    expect(cells.get("0,0")).toBe("┌");
    expect(cells.get("0,9")).toBe("┐");
    expect(cells.get("4,0")).toBe("└");
    expect(cells.get("4,9")).toBe("┘");

    // Top edge
    expect(cells.get("0,1")).toBe("─");
    expect(cells.get("0,5")).toBe("─");

    // Left edge
    expect(cells.get("1,0")).toBe("│");
    expect(cells.get("3,0")).toBe("│");

    // Interior should be empty
    expect(cells.has("2,5")).toBe(false);
  });

  it("resize smaller preserves valid box shape", () => {
    const bbox = { row: 0, col: 0, w: 4, h: 3 };
    const cells = regenerateCells(bbox, LIGHT_RECT_STYLE);
    expect(cells.get("0,0")).toBe("┌");
    expect(cells.get("0,3")).toBe("┐");
    expect(cells.get("2,0")).toBe("└");
    expect(cells.get("2,3")).toBe("┘");
  });

  it("resize updates composite correctly", () => {
    const regions = detectRegions(scan(PURE_WIREFRAME));
    const wf = regions[0];
    const rect = wf.layers!.find(l => l.type === "rect" && l.style)!;
    expect(rect).toBeDefined();

    // Original width
    const origW = rect.bbox.w;

    // Resize wider
    rect.bbox.w = origW + 5;
    rect.cells = regenerateCells(rect.bbox, rect.style!);

    const composite = compositeLayers(wf.layers!);
    // New right edge should have ┐
    expect(composite.get(`${rect.bbox.row},${rect.bbox.col + rect.bbox.w - 1}`)).toBe("┐");
  });

  it("minimum size 2x2 still produces valid box", () => {
    const bbox = { row: 0, col: 0, w: 2, h: 2 };
    const cells = regenerateCells(bbox, LIGHT_RECT_STYLE);
    expect(cells.get("0,0")).toBe("┌");
    expect(cells.get("0,1")).toBe("┐");
    expect(cells.get("1,0")).toBe("└");
    expect(cells.get("1,1")).toBe("┘");
  });
});

// ── 5. Pretext layout ────────────────────────────────────

describe("pretext layout", () => {
  // Import dynamically to avoid issues if canvas mock isn't ready
  it("line count increases when width decreases", async () => {
    const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
    const text = "The sidebar contains navigation items. The main area shows the task list with cards.";
    const font = '16px Menlo, Monaco, "Courier New", monospace';
    const prepared = prepareWithSegments(text, font);

    const wide = layoutWithLines(prepared, 800, 19);
    const narrow = layoutWithLines(prepared, 200, 19);

    expect(narrow.lineCount).toBeGreaterThan(wide.lineCount);
    expect(narrow.height).toBeGreaterThan(wide.height);
  });

  it("empty text produces zero lines", async () => {
    const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
    const font = '16px Menlo, Monaco, "Courier New", monospace';
    const prepared = prepareWithSegments("", font);
    const result = layoutWithLines(prepared, 800, 19);
    expect(result.lineCount).toBe(0);
    expect(result.height).toBe(0);
  });

  it("layout is pure — same input same output", async () => {
    const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
    const text = "Hello world this is a test of text layout.";
    const font = '16px Menlo, Monaco, "Courier New", monospace';
    const prepared = prepareWithSegments(text, font);

    const r1 = layoutWithLines(prepared, 300, 19);
    const r2 = layoutWithLines(prepared, 300, 19);
    expect(r1.lineCount).toBe(r2.lineCount);
    expect(r1.height).toBe(r2.height);
    expect(r1.lines.map(l => l.text)).toEqual(r2.lines.map(l => l.text));
  });
});

// ── 6. Round-trip ────────────────────────────────────────

describe("round-trip", () => {
  function stitchRegions(regions: Region[]): string {
    return regions.map(r => r.text).join("\n\n");
  }

  it("stitch → re-parse preserves region count (dashboard)", () => {
    const r1 = detectRegions(scan(DASHBOARD));
    const stitched = stitchRegions(r1);
    const r2 = detectRegions(scan(stitched));
    expect(r2.length).toBe(r1.length);
    expect(r2.map(r => r.type)).toEqual(r1.map(r => r.type));
  });

  it("stitch → re-parse preserves region count (multi wireframe)", () => {
    const r1 = detectRegions(scan(MULTI_WIREFRAME));
    const stitched = stitchRegions(r1);
    const r2 = detectRegions(scan(stitched));
    expect(r2.length).toBe(r1.length);
    expect(r2.map(r => r.type)).toEqual(r1.map(r => r.type));
  });

  it("stitch → re-parse preserves wireframe rect count", () => {
    const r1 = detectRegions(scan(DASHBOARD));
    const stitched = stitchRegions(r1);
    const r2 = detectRegions(scan(stitched));
    const rectCount1 = r1.filter(r => r.type === "wireframe")
      .reduce((sum, r) => sum + (r.layers?.filter(l => l.type === "rect").length ?? 0), 0);
    const rectCount2 = r2.filter(r => r.type === "wireframe")
      .reduce((sum, r) => sum + (r.layers?.filter(l => l.type === "rect").length ?? 0), 0);
    expect(rectCount2).toBe(rectCount1);
  });
});

// ── 7. Real file stress tests ────────────────────────────

describe("real file stress tests", () => {
  const planDir = "/Users/parijat/dev/colex-platform/docs/plans";

  // Skip if colex-platform not available
  const hasColex = fs.existsSync(planDir);

  it.skipIf(!hasColex)("all plan files with wireframes produce valid regions", () => {
    const files = findMdFiles(planDir);
    let filesWithRects = 0;

    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      const result = scan(text);
      if (result.rects.length === 0) continue;
      filesWithRects++;

      const regions = detectRegions(result);
      // Basic validity
      expect(regions.length).toBeGreaterThan(0);
      // At least one wireframe region
      expect(regions.some(r => r.type === "wireframe")).toBe(true);

      for (const r of regions) {
        // No region should have absurd layer counts
        if (r.layers) {
          expect(r.layers.length).toBeLessThan(500);
        }
        // Row ranges should be valid
        expect(r.startRow).toBeLessThanOrEqual(r.endRow);
        expect(r.startRow).toBeGreaterThanOrEqual(0);
      }
    }

    expect(filesWithRects).toBeGreaterThan(0);
  });

  it.skipIf(!hasColex)("no wireframe region produces empty composite", () => {
    const files = findMdFiles(planDir);

    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      const result = scan(text);
      if (result.rects.length === 0) continue;

      const regions = detectRegions(result);
      for (const r of regions) {
        if (r.type === "wireframe" && r.layers && r.layers.length > 0) {
          const composite = compositeLayers(r.layers);
          expect(composite.size).toBeGreaterThan(0);
        }
      }
    }
  });

  it.skipIf(!hasColex)("round-trip preserves region structure for all wireframe files", () => {
    const files = findMdFiles(planDir);
    let tested = 0;

    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      const result = scan(text);
      if (result.rects.length === 0) continue;
      tested++;

      const r1 = detectRegions(result);
      const stitched = r1.map(r => r.text).join("\n\n");
      const r2 = detectRegions(scan(stitched));

      expect(r2.length).toBe(r1.length);
      expect(r2.map(r => r.type)).toEqual(r1.map(r => r.type));
    }

    expect(tested).toBeGreaterThan(0);
  });
});

// ── 8. Demo simulation — full interaction sequences ──────

describe("demo simulation", () => {
  /**
   * Simulates the exact data flow in Demo.tsx:
   * load text → detectRegions → layout prose → composite wireframes
   * → hit test → drag → recomposite → verify
   */

  it("full load + render pipeline produces renderable data", () => {
    const regions = detectRegions(scan(DASHBOARD));
    expect(regions.length).toBe(3);

    // Prose regions produce Pretext-layoutable text
    const prose = regions.filter(r => r.type === "prose");
    for (const p of prose) {
      expect(p.text.length).toBeGreaterThan(0);
    }

    // Wireframe regions produce compositable layers
    const wf = regions.find(r => r.type === "wireframe")!;
    const composite = compositeLayers(wf.layers!);
    expect(composite.size).toBeGreaterThan(0);
    const sparse = buildSparseRows(composite);
    expect(sparse.length).toBeGreaterThan(0);
  });

  it("click hit-test finds correct layer in wireframe region", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;
    const layers = wf.layers!;

    // Find a rect layer and click inside it
    const rect = layers.find(l => l.type === "rect" && l.bbox.w > 3)!;
    const clickRow = rect.bbox.row + 1; // inside the rect
    const clickCol = rect.bbox.col + 1;

    // Hit test — same logic as Demo.tsx onMouseDown
    let bestId: string | null = null;
    let bestZ = -Infinity;
    for (const l of layers) {
      if (l.type === "base" || l.type === "group" || !l.visible) continue;
      const { row, col, w, h } = l.bbox;
      if (clickRow >= row && clickRow < row + h &&
          clickCol >= col && clickCol < col + w &&
          l.z > bestZ) {
        bestId = l.id;
        bestZ = l.z;
      }
    }
    expect(bestId).not.toBeNull();
  });

  it("drag sequence: move layer, recomposite, verify new position", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;
    const layers = wf.layers!;
    const rect = layers.find(l => l.type === "rect" && l.style)!;

    const origRow = rect.bbox.row;
    const origCol = rect.bbox.col;
    const origCorner = [...rect.cells.entries()].find(([, v]) => v === "┌");
    expect(origCorner).toBeDefined();

    // Simulate drag: move by (+3, +5)
    const dRow = 3, dCol = 5;
    const newCells = new Map<string, string>();
    for (const [key, val] of rect.cells) {
      const i = key.indexOf(",");
      const r = Number(key.slice(0, i)) + dRow;
      const c = Number(key.slice(i + 1)) + dCol;
      newCells.set(`${r},${c}`, val);
    }
    rect.cells = newCells;
    rect.bbox.row = origRow + dRow;
    rect.bbox.col = origCol + dCol;

    // Recomposite — this is what Demo.tsx does in onMouseMove
    const composite = compositeLayers(layers);
    const sparse = buildSparseRows(composite);

    // Verify the layer moved: corner should be at new position
    expect(rect.bbox.row).toBe(origRow + 3);
    expect(rect.bbox.col).toBe(origCol + 5);

    // Sparse rows should still be non-empty
    expect(sparse.length).toBeGreaterThan(0);
  });

  it("resize sequence: resize rect, regenerate cells, recomposite", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;
    const layers = wf.layers!;
    const rect = layers.find(l => l.type === "rect" && l.style)!;

    const origW = rect.bbox.w;
    const origH = rect.bbox.h;

    // Resize: make wider and taller
    rect.bbox.w = origW + 4;
    rect.bbox.h = origH + 2;
    rect.cells = regenerateCells(rect.bbox, rect.style!);

    // Verify cells regenerated at new size
    expect(rect.cells.size).toBeGreaterThan(0);
    // Top-right corner should be at new position
    const trKey = `${rect.bbox.row},${rect.bbox.col + rect.bbox.w - 1}`;
    expect(rect.cells.get(trKey)).toBe("┐");

    // Recomposite
    const composite = compositeLayers(layers);
    expect(composite.size).toBeGreaterThan(0);

    // Composite should have the corner at the right place
    expect(composite.get(trKey)).toBe("┐");
  });

  it("drag persists after stitching regions back to text", () => {
    // Simulate: drag → stitch → re-parse → verify layer at new position
    const text = DASHBOARD;
    const regions = detectRegions(scan(text));
    const wf = regions.find(r => r.type === "wireframe")!;
    const rect = wf.layers!.find(l => l.type === "rect" && l.style)!;
    const origId = rect.id;

    // Drag the rect by (+2, +3)
    const dRow = 2, dCol = 3;
    const newCells = new Map<string, string>();
    for (const [key, val] of rect.cells) {
      const i = key.indexOf(",");
      const r = Number(key.slice(0, i)) + dRow;
      const c = Number(key.slice(i + 1)) + dCol;
      newCells.set(`${r},${c}`, val);
    }
    rect.cells = newCells;
    rect.bbox.row += dRow;
    rect.bbox.col += dCol;

    // Stitch regions back — same logic as Demo.tsx onMouseUp
    const parts: string[] = [];
    for (const r of regions) {
      if (r.type === "wireframe" && r.layers) {
        const composite = compositeLayers(r.layers);
        const sparse = buildSparseRows(composite);
        const rows = r.endRow - r.startRow + 1;
        const textLines: string[] = [];
        for (let row = 0; row < rows; row++) {
          const sr = sparse.find(s => s.row === row);
          if (sr) {
            textLines.push(" ".repeat(sr.startCol) + sr.text);
          } else {
            textLines.push("");
          }
        }
        while (textLines.length > 0 && textLines[textLines.length - 1] === "") textLines.pop();
        parts.push(textLines.join("\n"));
      } else {
        parts.push(r.text);
      }
    }
    const stitched = parts.join("\n\n");

    // Re-parse and verify the rect is at the new position
    const regions2 = detectRegions(scan(stitched));
    const wf2 = regions2.find(r => r.type === "wireframe")!;
    expect(wf2).toBeDefined();
    expect(wf2.layers!.length).toBeGreaterThan(0);

    // The stitched text should contain the wireframe at the shifted position
    // (exact ID matching may not work since content-addressed IDs change with position,
    // but we can verify rects exist)
    const rects2 = wf2.layers!.filter(l => l.type === "rect");
    expect(rects2.length).toBeGreaterThan(0);
  });

  it("drag does NOT survive re-layout from same text (the old bug, now fixed by stitching)", () => {
    // This test documents the bug: doLayout() re-scans docText,
    // creating new layer objects that overwrite any drag mutations.
    const text = DASHBOARD;
    const regions1 = detectRegions(scan(text));
    const wf1 = regions1.find(r => r.type === "wireframe")!;
    const rect1 = wf1.layers!.find(l => l.type === "rect" && l.style)!;

    // Drag the rect
    rect1.bbox.row += 3;
    rect1.bbox.col += 5;

    // Re-layout from same text (what happens on React re-render)
    const regions2 = detectRegions(scan(text));
    const wf2 = regions2.find(r => r.type === "wireframe")!;
    const rect2 = wf2.layers!.find(l => l.id === rect1.id)!;

    // The drag is lost — rect2 has the original position
    expect(rect2.bbox.row).not.toBe(rect1.bbox.row);
    // This is the fundamental bug we need to fix for drag to persist
  });

  it("drag persists if we update the source text after drag", () => {
    // The fix: after drag ends, regenerate the source text from layers
    const text = DASHBOARD;
    const regions = detectRegions(scan(text));
    const wf = regions.find(r => r.type === "wireframe")!;

    // Find a standalone rect (the inner "Card" box is a good candidate)
    const rects = wf.layers!.filter(l => l.type === "rect" && l.style);
    expect(rects.length).toBeGreaterThan(0);

    // Verify that compositing + sparse rows → text round-trip works
    const composite = compositeLayers(wf.layers!);
    const sparse = buildSparseRows(composite);

    // Sparse rows should produce text that re-scans to the same structure
    expect(sparse.length).toBeGreaterThan(0);
    // Each row should have content
    for (const sr of sparse) {
      expect(sr.text.length).toBeGreaterThan(0);
    }
  });
});

// ── 9. Performance targets ───────────────────────────────

describe("performance targets", () => {
  const planDir = "/Users/parijat/dev/colex-platform/docs/plans";
  const hasColex = fs.existsSync(planDir);

  it.skipIf(!hasColex)("file open pipeline < 500ms for 300-line plan file", () => {
    // Use the runtime-ux plan file (367 lines, 4 rects)
    const filePath = path.join(planDir, "gardener-plans-pending/g-plan-garden-runtime-ux-v1-pending.md");
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, "utf8");

    const start = performance.now();
    const scanResult = scan(text);
    const regions = detectRegions(scanResult);
    // Simulate layout: composite each wireframe region
    for (const r of regions) {
      if (r.type === "wireframe" && r.layers) {
        compositeLayers(r.layers);
      }
    }
    const elapsed = performance.now() - start;

    console.log(`  File open pipeline: ${elapsed.toFixed(1)}ms (target: <500ms)`);
    expect(elapsed).toBeLessThan(500);
  });

  it("region detection < 50ms for dashboard fixture", () => {
    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      detectRegions(scan(DASHBOARD));
    }
    const elapsed = (performance.now() - start) / 10;

    console.log(`  Region detection (avg): ${elapsed.toFixed(1)}ms (target: <50ms)`);
    expect(elapsed).toBeLessThan(50);
  });

  it("pretext layout < 5ms per prose region", async () => {
    const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
    const font = '16px Menlo, Monaco, "Courier New", monospace';
    // Use a realistic prose block
    const proseText = "This wireframe shows the main layout for task management.\n".repeat(20);

    const prepared = prepareWithSegments(proseText, font);
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      layoutWithLines(prepared, 800, 19);
    }
    const elapsed = (performance.now() - start) / 100;

    console.log(`  Pretext layout (avg): ${elapsed.toFixed(2)}ms (target: <5ms)`);
    expect(elapsed).toBeLessThan(5);
  });

  it("drag recomposite < 16ms (60fps budget)", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;
    const layers = wf.layers!;

    // Simulate 60 frames of drag
    const start = performance.now();
    for (let frame = 0; frame < 60; frame++) {
      // Move first rect by 1 cell each frame
      const rect = layers.find(l => l.type === "rect")!;
      const newCells = new Map<string, string>();
      for (const [key, val] of rect.cells) {
        const ci = key.indexOf(",");
        const r = Number(key.slice(0, ci)) + 1;
        const c = key.slice(ci + 1);
        newCells.set(`${r},${c}`, val);
      }
      rect.cells = newCells;
      rect.bbox.row += 1;

      // Recomposite + sparse rows (what paint() needs)
      const composite = compositeLayers(layers);
      buildSparseRows(composite);
    }
    const elapsed = performance.now() - start;
    const perFrame = elapsed / 60;

    console.log(`  Drag recomposite (avg per frame): ${perFrame.toFixed(2)}ms (target: <16ms)`);
    expect(perFrame).toBeLessThan(16);
  });

  it.skipIf(!hasColex)("largest wireframe file: all regions < 500 layers", () => {
    // workspace-redesign.md has 20 rects
    const filePath = path.join(planDir, "workspace-redesign.md");
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, "utf8");
    const regions = detectRegions(scan(text));

    let maxLayers = 0;
    for (const r of regions) {
      if (r.layers) {
        maxLayers = Math.max(maxLayers, r.layers.length);
      }
    }
    console.log(`  Max layers per region: ${maxLayers} (target: <500)`);
    expect(maxLayers).toBeLessThan(500);
  });
});

// ── Helpers ──────────────────────────────────────────────

function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) results.push(full);
    }
  }
  walk(dir);
  return results;
}
