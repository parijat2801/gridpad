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
  type Layer,
} from "./layers";
import { buildSparseRows } from "./KonvaCanvas";
import * as fs from "fs";
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
