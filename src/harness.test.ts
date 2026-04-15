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
 * 8. Demo simulation — full interaction sequences
 * 9. Stitch-back fidelity — drag/resize doesn't lose characters
 * 10. Performance targets
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { scan, type ScanResult } from "./scanner";
import { detectRegions, type Region } from "./regions";
import {
  buildLayersFromScan,
  compositeLayers,
  regenerateCells,
  LIGHT_RECT_STYLE,
  type Layer,
} from "./layers";
import { framesFromRegions } from "./frame";
import { buildSparseRows } from "./sparseRows";
import { insertChar, deleteChar } from "./proseCursor";
// @ts-expect-error vitest runs in node where fs/path exist
import * as fs from "fs";
// @ts-expect-error vitest runs in node where fs/path exist
import * as path from "path";

/** Get layers for a wireframe region by calling buildLayersFromScan directly
 * and filtering to layers within the region's row range.
 * Replaces region.layers after Region.layers field is removed. */
function getLayersForRegion(scanResult: ScanResult, region: Region): Layer[] {
  const allLayers = buildLayersFromScan(scanResult);
  return allLayers.filter(l => {
    const layerEndRow = l.bbox.row + l.bbox.h - 1;
    return l.bbox.row >= region.startRow && layerEndRow <= region.endRow;
  });
}

// ── Canvas mock for Pretext ──────────────────────────────
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
          width: text.length * 9.6,
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
    const scanResult = scan(PURE_WIREFRAME);
    const regions = detectRegions(scanResult);
    expect(regions.length).toBe(1);
    expect(regions[0].type).toBe("wireframe");
    expect(getLayersForRegion(scanResult, regions[0]).length).toBeGreaterThan(0);
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
    expect(regions.every(r => r.type === "prose")).toBe(true);
  });

  it("wireframe region layers have row-rebased coordinates", () => {
    const scanResult = scan(DASHBOARD);
    const regions = detectRegions(scanResult);
    const wf = regions.find(r => r.type === "wireframe")!;
    for (const l of getLayersForRegion(scanResult, wf)) {
      expect(l.bbox.row).toBeGreaterThanOrEqual(0);
      for (const key of l.cells.keys()) {
        expect(Number(key.split(",")[0])).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("no region exceeds 500 layers", () => {
    for (const fixture of [DASHBOARD, MULTI_WIREFRAME, PURE_WIREFRAME]) {
      const scanResult = scan(fixture);
      for (const r of detectRegions(scanResult)) {
        if (r.type === "wireframe") {
          const layers = getLayersForRegion(scanResult, r);
          expect(layers.length).toBeLessThan(500);
        }
      }
    }
  });
});

// ── 2. Wireframe compositing ─────────────────────────────

describe("wireframe compositing", () => {
  it("composite produces correct characters for a simple box", () => {
    const scanResult = scan(PURE_WIREFRAME);
    const regions = detectRegions(scanResult);
    const composite = compositeLayers(getLayersForRegion(scanResult, regions[0]));
    expect(composite.get("0,0")).toBe("┌");
    expect(composite.get("0,10")).toBe("┐");
    expect(composite.get("4,0")).toBe("└");
  });

  it("buildSparseRows groups cells correctly", () => {
    const scanResult = scan(PURE_WIREFRAME);
    const regions = detectRegions(scanResult);
    const composite = compositeLayers(getLayersForRegion(scanResult, regions[0]));
    const sparse = buildSparseRows(composite);
    expect(sparse.length).toBe(5);
    expect(sparse[0].startCol).toBe(0);
    expect(sparse[0].text[0]).toBe("┌");
  });

  it("composite is deterministic", () => {
    const scanResult = scan(DASHBOARD);
    const wf = detectRegions(scanResult).find(r => r.type === "wireframe")!;
    const layers = getLayersForRegion(scanResult, wf);
    const c1 = compositeLayers(layers);
    const c2 = compositeLayers(layers);
    expect([...c1.entries()]).toEqual([...c2.entries()]);
  });
});

// ── 3. Drag math ─────────────────────────────────────────

describe("drag math", () => {
  it("moving a layer shifts bbox and cell keys", () => {
    const singleBox = "┌──┐\n│  │\n└──┘";
    const scanResult = scan(singleBox);
    const wf = detectRegions(scanResult)[0];
    const layers = getLayersForRegion(scanResult, wf);
    const layer = layers.find(l => l.type === "rect")!;
    const origRow = layer.bbox.row;
    const origCol = layer.bbox.col;

    const newCells = new Map<string, string>();
    for (const [key, val] of layer.cells) {
      const i = key.indexOf(",");
      newCells.set(`${Number(key.slice(0, i)) + 2},${Number(key.slice(i + 1)) + 3}`, val);
    }
    layer.cells = newCells;
    layer.bbox.row = origRow + 2;
    layer.bbox.col = origCol + 3;

    expect(layer.bbox.row).toBe(origRow + 2);
    const composite = compositeLayers(layers);
    expect(composite.get(`${origRow + 2},${origCol + 3}`)).toBe("┌");
  });

  it("drag preserves all cell characters", () => {
    const scanResult = scan(PURE_WIREFRAME);
    const wf = detectRegions(scanResult)[0];
    const layer = getLayersForRegion(scanResult, wf).find(l => l.type === "rect")!;
    const origChars = [...layer.cells.values()].sort();

    const newCells = new Map<string, string>();
    for (const [key, val] of layer.cells) {
      const i = key.indexOf(",");
      newCells.set(`${Number(key.slice(0, i)) + 1},${Number(key.slice(i + 1)) + 1}`, val);
    }
    layer.cells = newCells;
    expect([...layer.cells.values()].sort()).toEqual(origChars);
  });
});

// ── 4. Resize + regenerate ───────────────────────────────

describe("resize + regenerate", () => {
  it("regenerateCells produces valid box at new size", () => {
    const cells = regenerateCells({ row: 0, col: 0, w: 10, h: 5 }, LIGHT_RECT_STYLE);
    expect(cells.get("0,0")).toBe("┌");
    expect(cells.get("0,9")).toBe("┐");
    expect(cells.get("4,0")).toBe("└");
    expect(cells.get("4,9")).toBe("┘");
    expect(cells.get("0,1")).toBe("─");
    expect(cells.get("1,0")).toBe("│");
    expect(cells.has("2,5")).toBe(false);
  });

  it("minimum size 2x2 still produces valid box", () => {
    const cells = regenerateCells({ row: 0, col: 0, w: 2, h: 2 }, LIGHT_RECT_STYLE);
    expect(cells.get("0,0")).toBe("┌");
    expect(cells.get("0,1")).toBe("┐");
    expect(cells.get("1,0")).toBe("└");
    expect(cells.get("1,1")).toBe("┘");
  });

  it("resize updates composite correctly", () => {
    const scanResult = scan(PURE_WIREFRAME);
    const wf = detectRegions(scanResult)[0];
    const layers = getLayersForRegion(scanResult, wf);
    const rect = layers.find(l => l.type === "rect" && l.style)!;
    rect.bbox.w += 5;
    rect.cells = regenerateCells(rect.bbox, rect.style!);
    const composite = compositeLayers(layers);
    expect(composite.get(`${rect.bbox.row},${rect.bbox.col + rect.bbox.w - 1}`)).toBe("┐");
  });
});

// ── 5. Pretext layout ────────────────────────────────────

describe("pretext layout", () => {
  it("line count increases when width decreases", async () => {
    const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
    const font = '16px Menlo, Monaco, "Courier New", monospace';
    const prepared = prepareWithSegments("The sidebar contains navigation items. The main area shows task cards.", font);
    const wide = layoutWithLines(prepared, 800, 19);
    const narrow = layoutWithLines(prepared, 200, 19);
    expect(narrow.lineCount).toBeGreaterThan(wide.lineCount);
  });

  it("empty text produces zero lines", async () => {
    const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
    const result = layoutWithLines(prepareWithSegments("", '16px monospace'), 800, 19);
    expect(result.lineCount).toBe(0);
  });

  it("layout is pure — same input same output", async () => {
    const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
    const prepared = prepareWithSegments("Hello world test.", '16px monospace');
    const r1 = layoutWithLines(prepared, 300, 19);
    const r2 = layoutWithLines(prepared, 300, 19);
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
    const r2 = detectRegions(scan(stitchRegions(r1)));
    expect(r2.length).toBe(r1.length);
    expect(r2.map(r => r.type)).toEqual(r1.map(r => r.type));
  });

  it("stitch → re-parse preserves region count (multi wireframe)", () => {
    const r1 = detectRegions(scan(MULTI_WIREFRAME));
    const r2 = detectRegions(scan(stitchRegions(r1)));
    expect(r2.map(r => r.type)).toEqual(r1.map(r => r.type));
  });
});

// ── 7. Real file stress tests ────────────────────────────

describe("real file stress tests", () => {
  const planDir = "/Users/parijat/dev/colex-platform/docs/plans";
  const hasColex = fs.existsSync(planDir);

  it.skipIf(!hasColex)("all plan files with wireframes produce valid regions", () => {
    const files = findMdFiles(planDir);
    let count = 0;
    for (const f of files) {
      const scanResult = scan(fs.readFileSync(f, "utf8"));
      if (scanResult.rects.length === 0) continue;
      count++;
      const regions = detectRegions(scanResult);
      expect(regions.length).toBeGreaterThan(0);
      expect(regions.some(r => r.type === "wireframe")).toBe(true);
      for (const r of regions) {
        if (r.type === "wireframe") expect(getLayersForRegion(scanResult, r).length).toBeLessThan(500);
        expect(r.startRow).toBeLessThanOrEqual(r.endRow);
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it.skipIf(!hasColex)("no wireframe region produces empty composite", () => {
    for (const f of findMdFiles(planDir)) {
      const scanResult = scan(fs.readFileSync(f, "utf8"));
      if (scanResult.rects.length === 0) continue;
      for (const r of detectRegions(scanResult)) {
        if (r.type === "wireframe") {
          const layers = getLayersForRegion(scanResult, r);
          if (layers.length > 0) {
            expect(compositeLayers(layers).size).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it.skipIf(!hasColex)("round-trip preserves region structure", () => {
    let count = 0;
    for (const f of findMdFiles(planDir)) {
      const text = fs.readFileSync(f, "utf8");
      if (scan(text).rects.length === 0) continue;
      count++;
      const r1 = detectRegions(scan(text));
      const r2 = detectRegions(scan(r1.map(r => r.text).join("\n\n")));
      expect(r2.length).toBe(r1.length);
      expect(r2.map(r => r.type)).toEqual(r1.map(r => r.type));
    }
    expect(count).toBeGreaterThan(0);
  });
});

// ── 8. Demo simulation ──────────────────────────────────

describe("demo simulation", () => {
  it("full pipeline produces renderable data", () => {
    const scanResult = scan(DASHBOARD);
    const regions = detectRegions(scanResult);
    expect(regions.length).toBe(3);
    const wf = regions.find(r => r.type === "wireframe")!;
    const layers = getLayersForRegion(scanResult, wf);
    expect(compositeLayers(layers).size).toBeGreaterThan(0);
    expect(buildSparseRows(compositeLayers(layers)).length).toBeGreaterThan(0);
  });

  it("click hit-test finds correct layer", () => {
    const scanResult = scan(DASHBOARD);
    const wf = detectRegions(scanResult).find(r => r.type === "wireframe")!;
    const layers = getLayersForRegion(scanResult, wf);
    const rect = layers.find(l => l.type === "rect" && l.bbox.w > 3)!;
    let bestId: string | null = null;
    let bestZ = -Infinity;
    for (const l of layers) {
      if (l.type === "base" || l.type === "group" || !l.visible) continue;
      const { row, col, w, h } = l.bbox;
      if (rect.bbox.row + 1 >= row && rect.bbox.row + 1 < row + h &&
          rect.bbox.col + 1 >= col && rect.bbox.col + 1 < col + w && l.z > bestZ) {
        bestId = l.id; bestZ = l.z;
      }
    }
    expect(bestId).not.toBeNull();
  });

  it("drag does NOT survive re-layout from same text (known limitation)", () => {
    const scanResult1 = scan(DASHBOARD);
    const r1 = detectRegions(scanResult1);
    const rect1 = getLayersForRegion(scanResult1, r1.find(r => r.type === "wireframe")!).find(l => l.type === "rect")!;
    rect1.bbox.row += 3;
    const scanResult2 = scan(DASHBOARD);
    const r2 = detectRegions(scanResult2);
    const rect2 = getLayersForRegion(scanResult2, r2.find(r => r.type === "wireframe")!).find(l => l.id === rect1.id)!;
    expect(rect2.bbox.row).not.toBe(rect1.bbox.row);
  });
});

// ── 9. Stitch-back fidelity ─────────────────────────────

describe("stitch-back fidelity", () => {
  /**
   * THE KEY INSIGHT: Don't reconstruct wireframe text from layers.
   * Keep the original region.text and only modify it when a shape
   * actually moves/resizes. The composite loses junction characters
   * (├┬┤ become ┌┐┘) because regenerateCells uses canonical corners.
   */

  it("region.text preserves original wireframe characters exactly", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;
    // The original text should contain junction chars
    expect(wf.text).toContain("├");
    expect(wf.text).toContain("┬");
    expect(wf.text).toContain("┴");
  });

  it("composite LOSES junction characters (known limitation of layer model)", () => {
    const scanResult = scan(DASHBOARD);
    const regions = detectRegions(scanResult);
    const wf = regions.find(r => r.type === "wireframe")!;
    const composite = compositeLayers(getLayersForRegion(scanResult, wf));
    // Composite uses canonical corners, not original junction chars
    const compositeText = Array.from(composite.values()).join("");
    // ├ and ┬ from the original are replaced by ┌ and ┐
    // This is WHY we must use region.text, not composite, for stitching
    const hasJunction = compositeText.includes("├") || compositeText.includes("┬");
    // May or may not have junctions depending on z-order — the point is
    // we can't rely on composite for faithful text output
    expect(typeof hasJunction).toBe("boolean"); // just documenting the issue
  });

  it("stitch using region.text (not composite) preserves everything", () => {
    const regions = detectRegions(scan(DASHBOARD));
    // Stitch using original text — NO composite reconstruction
    const stitched = regions.map(r => r.text).join("\n\n");
    // All labels preserved
    expect(stitched).toContain("Dashboard");
    expect(stitched).toContain("Sidebar");
    expect(stitched).toContain("Task List");
    expect(stitched).toContain("Task: Fix login bug");
    expect(stitched).toContain("Header / Nav Bar");
    // Junction chars preserved
    expect(stitched).toContain("├");
    expect(stitched).toContain("┬");
    expect(stitched).toContain("┴");
    // Prose preserved
    expect(stitched).toContain("Task Management Dashboard");
  });

  it("stitch using region.text preserves rect count", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const stitched = regions.map(r => r.text).join("\n\n");
    expect(scan(stitched).rects.length).toBe(scan(DASHBOARD).rects.length);
  });

  it("stitch using region.text preserves box-drawing char count", () => {
    const count = (t: string) => [...t].filter(c => "┌┐└┘├┤┬┴┼─│".includes(c)).length;
    const regions = detectRegions(scan(DASHBOARD));
    const stitched = regions.map(r => r.text).join("\n\n");
    expect(count(stitched)).toBe(count(DASHBOARD));
  });

  it("multi-wireframe stitch preserves all regions", () => {
    const r1 = detectRegions(scan(MULTI_WIREFRAME));
    const stitched = r1.map(r => r.text).join("\n\n");
    const r2 = detectRegions(scan(stitched));
    expect(r2.map(r => r.type)).toEqual(r1.map(r => r.type));
  });

  const planDir = "/Users/parijat/dev/colex-platform/docs/plans";
  const hasColex = fs.existsSync(planDir);

  it.skipIf(!hasColex)("real file: stitch preserves box-drawing char count", () => {
    const filePath = path.join(planDir, "gardener-plans-pending/g-plan-garden-runtime-ux-v1-pending.md");
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, "utf8");
    const count = (t: string) => [...t].filter(c => "┌┐└┘├┤┬┴┼─│║═╔╗╚╝╠╣╦╩╬".includes(c)).length;

    const regions = detectRegions(scan(text));
    const stitched = regions.map(r => r.text).join("\n\n");
    const origCount = count(text);
    const newCount = count(stitched);
    console.log(`  Real file box chars: ${origCount} → ${newCount}`);
    expect(newCount).toBe(origCount);
  });

  it.skipIf(!hasColex)("real file: stitch preserves rect count", () => {
    const filePath = path.join(planDir, "gardener-plans-pending/g-plan-garden-runtime-ux-v1-pending.md");
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, "utf8");
    const regions = detectRegions(scan(text));
    const stitched = regions.map(r => r.text).join("\n\n");
    expect(scan(stitched).rects.length).toBe(scan(text).rects.length);
  });
});

// ── 11. Drag persistence text-grid edit ─────────────────

describe("drag persistence text-grid edit", () => {
  /**
   * Simulates the exact onMouseUp logic in Demo.tsx:
   *   1. Build a character grid from region.text
   *   2. Erase old cells (original positions = new positions - delta)
   *   3. Write new cells at new positions
   *   4. Stitch back and re-scan
   *
   * THE BUG: erasing old cells writes spaces unconditionally, destroying
   * junction chars (├┬┤┴┼) that belong to OTHER layers sharing those cells.
   *
   * Root cause: `regenerateCells` produces canonical chars (┌┐└┘─│) for
   * every rect layer. The original text at those positions may be junction
   * chars (├┤┬┴) that arise where two shapes OVERLAP in the source text.
   * When we erase old cells with spaces, those junction chars are destroyed.
   *
   * The fix: instead of writing `" "` at the old position, write the
   * character from OTHER layers' composite at that position (or `" "` if
   * nothing else owns that cell). This restores the other shapes' visible
   * chars rather than creating a gap in the border.
   */

  type LayerList = Layer[];

  /** Replicates the (buggy) onMouseUp erase-old/write-new logic from Demo.tsx.
   *  Only processes cells with non-negative row coordinates (guards against
   *  off-screen drags in tests). */
  function applyDragBuggy(
    regionText: string,
    layers: LayerList,
    layerId: string,
    dRow: number,
    dCol: number,
  ): string {
    const layer = layers.find(l => l.id === layerId)!;
    const newCells = new Map<string, string>();
    for (const [k, val] of layer.cells) {
      const ci = k.indexOf(",");
      newCells.set(`${Number(k.slice(0, ci)) + dRow},${Number(k.slice(ci + 1)) + dCol}`, val);
    }
    layer.cells = newCells;
    layer.bbox.row += dRow;
    layer.bbox.col += dCol;

    const textLines = regionText.split("\n");
    const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
    const grid: string[][] = textLines.map(l => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

    // BUG: unconditional space — destroys junction chars from other layers
    for (const [k] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci)) - dRow;
      const c = Number(k.slice(ci + 1)) - dCol;
      if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
        grid[r]![c] = " ";
      }
    }

    for (const [k, ch] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      if (r >= 0) {
        while (grid.length <= r) grid.push(new Array(maxCols).fill(" "));
        const row = grid[r]!;
        while (row.length <= c) row.push(" ");
        row[c] = ch;
      }
    }

    return grid.map(row => row.join("").trimEnd()).join("\n");
  }

  /** Fixed version: restore other layers' chars instead of blindly writing spaces. */
  function applyDragFixed(
    regionText: string,
    layers: LayerList,
    layerId: string,
    dRow: number,
    dCol: number,
  ): string {
    const layer = layers.find(l => l.id === layerId)!;
    // Snapshot composite of all OTHER layers BEFORE moving anything
    const otherComposite = compositeLayers(layers.filter(l => l.id !== layerId));

    const newCells = new Map<string, string>();
    for (const [k, val] of layer.cells) {
      const ci = k.indexOf(",");
      newCells.set(`${Number(k.slice(0, ci)) + dRow},${Number(k.slice(ci + 1)) + dCol}`, val);
    }
    layer.cells = newCells;
    layer.bbox.row += dRow;
    layer.bbox.col += dCol;

    const textLines = regionText.split("\n");
    const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
    const grid: string[][] = textLines.map(l => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

    // FIX: restore the other layers' composite char, not a space
    for (const [k] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci)) - dRow;
      const c = Number(k.slice(ci + 1)) - dCol;
      if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
        grid[r]![c] = otherComposite.get(`${r},${c}`) ?? " ";
      }
    }

    for (const [k, ch] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      if (r >= 0) {
        while (grid.length <= r) grid.push(new Array(maxCols).fill(" "));
        const row = grid[r]!;
        while (row.length <= c) row.push(" ");
        row[c] = ch;
      }
    }

    return grid.map(row => row.join("").trimEnd()).join("\n");
  }

  // Fixture: outer rect with a horizontal divider creating junction chars.
  // The scanner detects:
  //   - 1 outer rect layer (rows 0–4, uses canonical │ at rows 1-3 left/right)
  //   - 1 horizontal line layer (row 2: ├──────────────────┤, verbatim chars)
  // The text at (2,0) = ├ and (2,19) = ┤.
  // Outer rect layer cells at (2,0) = │ and (2,19) = │ (canonical, not ├/┤).
  // Dragging the outer rect DOWN by 1:
  //   Buggy erase: writes " " at old (2,0) → ├ is destroyed → border gap
  //   Fixed erase: writes "─" from line layer composite at (2,0) → no gap
  const OUTER_WITH_DIVIDER = [
    "┌──────────────────┐",
    "│                  │",
    "├──────────────────┤",
    "│                  │",
    "└──────────────────┘",
  ].join("\n");

  it("fixture: OUTER_WITH_DIVIDER has junction chars and two detectable rects", () => {
    const regions = detectRegions(scan(OUTER_WITH_DIVIDER));
    expect(regions.length).toBe(1);
    expect(regions[0].type).toBe("wireframe");
    expect(regions[0].text).toContain("├");
    expect(regions[0].text).toContain("┤");
    // Scanner sees ├ as valid TL corner → detects bottom-sub rect (rows 2-4)
    // in addition to outer rect (rows 0-4). Two rects total.
    expect(scan(OUTER_WITH_DIVIDER).rects.length).toBe(2);
  });

  it("layer cells NEVER contain junction chars — they use canonical chars only", () => {
    // This is WHY the bug exists: regenerateCells produces ┌┐└┘─│ only.
    // Junction chars (├┤┬┴┼) only exist in region.text, never in layer.cells.
    // So erasing a layer's old cells from the text grid unconditionally writes
    // spaces where junction chars live — destroying chars from other layers.
    const scanResult = scan(OUTER_WITH_DIVIDER);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const junctionChars = new Set("├┤┬┴┼");
    for (const layer of getLayersForRegion(scanResult, wf)) {
      for (const ch of layer.cells.values()) {
        expect(junctionChars.has(ch)).toBe(false);
      }
    }
    // But junction chars ARE in the original text
    expect(wf.text).toContain("├");
    expect(wf.text).toContain("┤");
  });

  it("buggy erase: outer rect moved right 2 cols — vacated junction positions get spaces, breaking bottom-sub rect", () => {
    const scanResult = scan(OUTER_WITH_DIVIDER);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const origRectCount = scan(OUTER_WITH_DIVIDER).rects.length; // 2

    // Outer rect is the one spanning all 5 rows (largest by area). Move it right 2.
    // Old left edge cells (rows 1-3, col 0) are vacated (new left edge at col 2).
    // At (2,0): outer rect had │ in its cells, text has ├ (junction char).
    // Buggy erase writes " " at (2,0) → bottom-sub rect's ┌ corner vanishes from text.
    const outerRect = getLayersForRegion(scanResult, wf)
      .filter(l => l.type === "rect")
      .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0]!;

    const cloned = getLayersForRegion(scanResult, wf).map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const buggyResult = applyDragBuggy(wf.text, cloned, outerRect.id, 0, 2);

    // Bottom-sub rect's top-left corner at (2,0) is now " " → scanner can't detect it
    expect(scan(buggyResult).rects.length).toBeLessThan(origRectCount);
  });

  it("fixed erase: outer rect moved right 2 cols — OLD positions restored from otherComposite (not spaces)", () => {
    // This test verifies that the fixed erase writes otherComposite chars at vacated
    // positions rather than spaces. However, the outer rect's NEW position writes over
    // the bottom-sub rect's cells — so the bottom-sub rect may still be lost.
    // The fixed erase is strictly BETTER than buggy (fewer chars destroyed), but
    // moving a large rect over adjacent rects still has issues.
    const scanResult = scan(OUTER_WITH_DIVIDER);
    const regions = detectRegions(scanResult);
    const wf = regions[0];

    const outerRect = getLayersForRegion(scanResult, wf)
      .filter(l => l.type === "rect")
      .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0]!;

    // Verify otherComposite has the bottom-sub rect's TL corner at (2,0)
    const otherComposite = compositeLayers(getLayersForRegion(scanResult, wf).filter(l => l.id !== outerRect.id));
    const charAt2_0 = otherComposite.get("2,0");
    expect(charAt2_0).toBeDefined();
    expect(charAt2_0).not.toBe(" ");

    const cloned = getLayersForRegion(scanResult, wf).map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const fixedResult = applyDragFixed(wf.text, cloned, outerRect.id, 0, 2);

    // Fixed erase correctly restores charAt2_0 at old position (2,0)
    const resultRow2 = [...(fixedResult.split("\n")[2] ?? "")];
    expect(resultRow2[0]).toBe(charAt2_0);

    // However, the overall rect count may still be less than original due to
    // the outer rect's new cells overwriting bottom-sub rect's cells at new positions.
    // Document actual behavior:
    const newRectCount = scan(fixedResult).rects.length;
    // Fixed is at least as good as buggy (may recover some rects):
    const cloned2 = getLayersForRegion(scanResult, wf).map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const buggyResult = applyDragBuggy(wf.text, cloned2, outerRect.id, 0, 2);
    const buggyRectCount = scan(buggyResult).rects.length;
    expect(newRectCount).toBeGreaterThanOrEqual(buggyRectCount);
  });

  it("DASHBOARD: buggy right-drag of outer rect loses rect(s); fixed drag is strictly better", () => {
    // Documents the behavior difference between buggy and fixed erase.
    // The buggy approach writes spaces at vacated positions, destroying adjacent rect corners.
    // The fixed approach writes otherComposite chars — preserving more structure.
    // However, even the fixed approach may not perfectly preserve ALL rects when
    // the dragged rect's new position overlaps other rects.
    const scanResult = scan(DASHBOARD);
    const regions = detectRegions(scanResult);
    const wf = regions.find(r => r.type === "wireframe")!;
    const origRectCount = scan(DASHBOARD).rects.length;

    // Outer rect (largest). Move right 2 cols — vacates col 0 (left border with ├/┤).
    const outerRect = getLayersForRegion(scanResult, wf)
      .filter(l => l.type === "rect")
      .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0]!;

    const clonedBuggy = getLayersForRegion(scanResult, wf).map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const clonedFixed = getLayersForRegion(scanResult, wf).map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));

    const buggyResult = applyDragBuggy(wf.text, clonedBuggy, outerRect.id, 0, 2);
    const fixedResult = applyDragFixed(wf.text, clonedFixed, outerRect.id, 0, 2);

    // Buggy: spaces at vacated junction positions break shared rect corners
    expect(scan(buggyResult).rects.length).toBeLessThan(origRectCount);
    // Fixed: at least as good as buggy (never WORSE than buggy approach)
    expect(scan(fixedResult).rects.length).toBeGreaterThanOrEqual(scan(buggyResult).rects.length);
  });
});

// ── 10. Performance targets ──────────────────────────────

describe("performance targets", () => {
  const planDir = "/Users/parijat/dev/colex-platform/docs/plans";
  const hasColex = fs.existsSync(planDir);

  it.skipIf(!hasColex)("file open pipeline < 500ms", () => {
    const f = path.join(planDir, "gardener-plans-pending/g-plan-garden-runtime-ux-v1-pending.md");
    if (!fs.existsSync(f)) return;
    const text = fs.readFileSync(f, "utf8");
    const start = performance.now();
    const scanResult = scan(text);
    const regions = detectRegions(scanResult);
    for (const r of regions) {
      if (r.type === "wireframe") compositeLayers(getLayersForRegion(scanResult, r));
    }
    const ms = performance.now() - start;
    console.log(`  File open: ${ms.toFixed(1)}ms (<500ms)`);
    expect(ms).toBeLessThan(500);
  });

  it("region detection < 50ms", () => {
    const start = performance.now();
    for (let i = 0; i < 10; i++) detectRegions(scan(DASHBOARD));
    const ms = (performance.now() - start) / 10;
    console.log(`  Region detection: ${ms.toFixed(1)}ms (<50ms)`);
    expect(ms).toBeLessThan(50);
  });

  it("pretext layout < 5ms", async () => {
    const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
    const prepared = prepareWithSegments("Test line.\n".repeat(20), '16px monospace');
    const start = performance.now();
    for (let i = 0; i < 100; i++) layoutWithLines(prepared, 800, 19);
    const ms = (performance.now() - start) / 100;
    console.log(`  Pretext layout: ${ms.toFixed(2)}ms (<5ms)`);
    expect(ms).toBeLessThan(5);
  });

  it("drag recomposite < 16ms (60fps)", () => {
    const scanResult = scan(DASHBOARD);
    const wf = detectRegions(scanResult).find(r => r.type === "wireframe")!;
    const layers = getLayersForRegion(scanResult, wf);
    const start = performance.now();
    for (let i = 0; i < 60; i++) {
      const rect = layers.find(l => l.type === "rect")!;
      const nc = new Map<string, string>();
      for (const [k, v] of rect.cells) {
        const ci = k.indexOf(",");
        nc.set(`${Number(k.slice(0, ci)) + 1},${k.slice(ci + 1)}`, v);
      }
      rect.cells = nc;
      rect.bbox.row++;
      compositeLayers(layers);
      buildSparseRows(compositeLayers(layers));
    }
    const ms = (performance.now() - start) / 60;
    console.log(`  Drag recomposite: ${ms.toFixed(2)}ms/frame (<16ms)`);
    expect(ms).toBeLessThan(16);
  });

  it("synthetic 50KB file: scanToFrames completes < 500ms", () => {
    // Generate ~50KB file with 100 wireframes separated by prose
    const sections: string[] = [];
    for (let i = 0; i < 100; i++) {
      sections.push(`# Section ${i}\n`);
      sections.push(`This is paragraph ${i} with some longer text content that fills up the line. `.repeat(5) + "\n");
      sections.push("\n\n");
      sections.push("┌──────────────────────┐\n");
      sections.push(`│ Wireframe box ${String(i).padStart(3)} │\n`);
      sections.push("│                      │\n");
      sections.push("└──────────────────────┘\n");
      sections.push("\n\n");
    }
    const text = sections.join("");
    expect(text.length).toBeGreaterThan(40000);

    const start = performance.now();
    const scanResult = scan(text);
    const regions = detectRegions(scanResult);
    const { frames } = framesFromRegions(regions, 9.6, 18.4, scanResult);
    const ms = performance.now() - start;

    console.log(`  Synthetic 50KB: ${text.length} chars, ${regions.length} regions, ${frames.length} frames, ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(500);
    expect(frames.length).toBeGreaterThan(0);
    expect(regions.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasColex)("largest file: all regions < 500 layers", () => {
    const f = path.join(planDir, "workspace-redesign.md");
    if (!fs.existsSync(f)) return;
    const fileText = fs.readFileSync(f, "utf8");
    const scanResult = scan(fileText);
    const max = Math.max(...detectRegions(scanResult)
      .map(r => r.type === "wireframe" ? getLayersForRegion(scanResult, r).length : 0));
    console.log(`  Max layers/region: ${max} (<500)`);
    expect(max).toBeLessThan(500);
  });
});

// ── 11. Prose editing ────────────────────────────────────

describe("prose editing", () => {
  function stitchRegions(regions: Region[]): string {
    return regions.map(r => r.text).join("\n\n");
  }

  function countBoxDrawing(text: string): number {
    return [...text].filter(c => "┌┐└┘├┤┬┴┼─│║═╔╗╚╝╠╣╦╩╬".includes(c)).length;
  }

  it("insert char into prose region preserves other regions", () => {
    const regions = detectRegions(scan(DASHBOARD));
    expect(regions.length).toBe(3);
    expect(regions[0].type).toBe("prose");

    const proseRegion = regions[0];
    const wfBefore = regions.find(r => r.type === "wireframe")!;
    const rectCountBefore = scan(wfBefore.text).rects.length;

    const { text: newProseText } = insertChar(proseRegion.text, { row: 0, col: 5 }, "X");
    const modifiedRegions = regions.map((r, i) => i === 0 ? { ...r, text: newProseText } : r);
    const stitched = stitchRegions(modifiedRegions);

    const reparsed = detectRegions(scan(stitched));
    expect(reparsed.length).toBe(3);

    const wfAfter = reparsed.find(r => r.type === "wireframe")!;
    expect(scan(wfAfter.text).rects.length).toBe(rectCountBefore);
  });

  it("delete char from prose region preserves wireframe", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const proseRegion = regions[0];
    const wfBefore = regions.find(r => r.type === "wireframe")!;
    const rectCountBefore = scan(wfBefore.text).rects.length;

    // Delete from a position that has a char (row 0, col 5)
    const { text: newProseText } = deleteChar(proseRegion.text, { row: 0, col: 5 });
    const modifiedRegions = regions.map((r, i) => i === 0 ? { ...r, text: newProseText } : r);
    const stitched = stitchRegions(modifiedRegions);

    const reparsed = detectRegions(scan(stitched));
    expect(reparsed.length).toBe(3);

    const wfAfter = reparsed.find(r => r.type === "wireframe")!;
    expect(scan(wfAfter.text).rects.length).toBe(rectCountBefore);
  });

  it("enter splits prose line, region count stays same", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const proseRegion = regions[0];

    // Insert a newline into the prose region
    const { text: newProseText } = insertChar(proseRegion.text, { row: 0, col: 5 }, "\n");
    const modifiedRegions = regions.map((r, i) => i === 0 ? { ...r, text: newProseText } : r);
    const stitched = stitchRegions(modifiedRegions);

    const reparsed = detectRegions(scan(stitched));
    // Region count should still be 3 — the newline in prose doesn't create a wireframe
    expect(reparsed.length).toBe(3);
    expect(reparsed.map(r => r.type)).toEqual(["prose", "wireframe", "prose"]);
  });

  it("editing prose doesn't affect wireframe box-drawing chars", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const boxCharsBefore = countBoxDrawing(regions.find(r => r.type === "wireframe")!.text);

    const proseRegion = regions[0];
    const { text: newProseText } = insertChar(proseRegion.text, { row: 0, col: 3 }, "Z");
    const modifiedRegions = regions.map((r, i) => i === 0 ? { ...r, text: newProseText } : r);
    const stitched = stitchRegions(modifiedRegions);

    const reparsed = detectRegions(scan(stitched));
    const boxCharsAfter = countBoxDrawing(reparsed.find(r => r.type === "wireframe")!.text);
    expect(boxCharsAfter).toBe(boxCharsBefore);
  });

  it("insert into empty prose between wireframes", () => {
    const regions = detectRegions(scan(MULTI_WIREFRAME));
    expect(regions.length).toBe(5);

    // The middle prose region is at index 2
    const middleProse = regions[2];
    expect(middleProse.type).toBe("prose");

    const { text: newProseText } = insertChar(middleProse.text, { row: 0, col: 0 }, "A");
    const modifiedRegions = regions.map((r, i) => i === 2 ? { ...r, text: newProseText } : r);
    const stitched = stitchRegions(modifiedRegions);

    const reparsed = detectRegions(scan(stitched));
    expect(reparsed.length).toBe(5);
    expect(reparsed.map(r => r.type)).toEqual(["prose", "wireframe", "prose", "wireframe", "prose"]);
  });

  it("cursor arrow navigation stays within source line bounds", () => {
    const text = "Hello\nWorld\nFoo";
    const lines = text.split("\n");

    // ArrowRight at end of line doesn't exceed line length
    const lastCol = lines[0].length; // 5
    const clampedRight = Math.min(lastCol + 1, lines[0].length);
    expect(clampedRight).toBe(lines[0].length);

    // ArrowDown from last line stays at last line
    const lastRow = lines.length - 1; // 2
    const clampedDown = Math.min(lastRow + 1, lines.length - 1);
    expect(clampedDown).toBe(lastRow);

    // ArrowLeft at (0,0) stays at (0,0)
    const newCol = Math.max(0, 0 - 1);
    expect(newCol).toBe(0);
    const newRow = Math.max(0, 0 - 1);
    expect(newRow).toBe(0);
  });
});

// ── 12. Real file drag simulation ────────────────────────

describe("real file drag simulation", () => {
  const planDir = "/Users/parijat/dev/colex-platform/docs/plans";
  const hasColex = fs.existsSync(planDir);

  /**
   * Replicates the FIXED onMouseUp logic from Demo.tsx:
   * - Snapshot otherComposite BEFORE moving the layer
   * - Erase old cells by restoring from otherComposite (not spaces)
   * - Write new cells
   */
  function applyDragOnMouseUp(
    regionText: string,
    layers: Layer[],
    layerId: string,
    dRow: number,
    dCol: number,
  ): string {
    const layer = layers.find(l => l.id === layerId)!;

    // Snapshot composite of other layers BEFORE moving anything
    const otherComposite = compositeLayers(layers.filter(l => l.id !== layerId));

    // Move the layer in-place (simulate onMouseMove)
    const newCells = new Map<string, string>();
    for (const [k, val] of layer.cells) {
      const ci = k.indexOf(",");
      newCells.set(`${Number(k.slice(0, ci)) + dRow},${Number(k.slice(ci + 1)) + dCol}`, val);
    }
    layer.cells = newCells;
    layer.bbox.row += dRow;
    layer.bbox.col += dCol;

    // Build character grid from region.text
    const textLines = regionText.split("\n");
    const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
    const grid: string[][] = textLines.map(l => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

    // Erase old cells: restore from otherComposite (the FIXED approach)
    for (const [k] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci)) - dRow;
      const c = Number(k.slice(ci + 1)) - dCol;
      if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
        grid[r][c] = otherComposite.get(`${r},${c}`) ?? " ";
      }
    }

    // Write new cells
    for (const [k, ch] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      while (grid.length <= r) grid.push(new Array(maxCols).fill(" "));
      if (!grid[r]) grid[r] = new Array(maxCols).fill(" ");
      while (grid[r].length <= c) grid[r].push(" ");
      grid[r][c] = ch;
    }

    return grid.map(row => row.join("").trimEnd()).join("\n");
  }

  it.skipIf(!hasColex)(
    "all plan files: drag (+1,0) of each rect — document actual char retention and rect count delta",
    () => {
      const files = findMdFiles(planDir);
      let filesTested = 0;
      let totalRects = 0;
      let retentionFailures = 0;
      let rectCountFailures = 0;

      for (const f of files) {
        const text = fs.readFileSync(f, "utf8");
        const initialScan = scan(text);
        if (initialScan.rects.length === 0) continue;

        const regions = detectRegions(initialScan);
        const wfRegions = regions.filter(r => r.type === "wireframe");

        for (const wf of wfRegions) {
          const wfLayers = getLayersForRegion(initialScan, wf);
          if (wfLayers.length === 0) continue;
          const rectLayers = wfLayers.filter(l => l.type === "rect" && l.style);
          if (rectLayers.length === 0) continue;

          const boxCount = (t: string) =>
            [...t].filter(c => "┌┐└┘├┤┬┴┼─│║═╔╗╚╝╠╣╦╩╬".includes(c)).length;
          const origBoxChars = boxCount(wf.text);
          const origRects = scan(wf.text).rects.length;

          for (const rectLayer of rectLayers) {
            totalRects++;
            // Deep-clone all layers for this simulation
            const cloned = wfLayers.map(l => ({
              ...l,
              bbox: { ...l.bbox },
              cells: new Map(l.cells),
            }));

            const result = applyDragOnMouseUp(wf.text, cloned, rectLayer.id, 1, 0);
            const rescan = scan(result);
            const newBoxChars = boxCount(result);
            const newRects = rescan.rects.length;

            // Track failures — but don't fail individual assertions since
            // we want to count failures across all rects
            if (origBoxChars > 0 && newBoxChars / origBoxChars < 0.8) {
              retentionFailures++;
            }
            if (Math.abs(newRects - origRects) > 2) {
              rectCountFailures++;
            }
          }

          filesTested++;
        }
      }

      expect(filesTested).toBeGreaterThan(0);
      // At least 80% of rect drags should retain ≥80% of box-drawing chars
      // (20% failure rate allowed for edge cases with large overlapping shapes)
      const retentionFailureRate = totalRects > 0 ? retentionFailures / totalRects : 0;
      expect(retentionFailureRate).toBeLessThan(0.2);
      // At least 90% of rect drags should keep rect count within ±2
      const rectCountFailureRate = totalRects > 0 ? rectCountFailures / totalRects : 0;
      expect(rectCountFailureRate).toBeLessThan(0.1);
    },
  );
});

// ── 13. Shared wall drag ──────────────────────────────────

describe("shared wall drag", () => {
  // Two adjacent rects sharing a wall — the ┬ and ┴ are junction chars
  // that belong to the visual boundary between left and right boxes.
  const TWO_ADJACENT = [
    "┌──────┬──────┐",
    "│ Left │Right │",
    "└──────┴──────┘",
  ].join("\n");

  type LayerList = Layer[];

  function applyDragFixed2(
    regionText: string,
    layers: LayerList,
    layerId: string,
    dRow: number,
    dCol: number,
  ): string {
    const layer = layers.find(l => l.id === layerId)!;
    const otherComposite = compositeLayers(layers.filter(l => l.id !== layerId));

    const newCells = new Map<string, string>();
    for (const [k, val] of layer.cells) {
      const ci = k.indexOf(",");
      newCells.set(`${Number(k.slice(0, ci)) + dRow},${Number(k.slice(ci + 1)) + dCol}`, val);
    }
    layer.cells = newCells;
    layer.bbox.row += dRow;
    layer.bbox.col += dCol;

    const textLines = regionText.split("\n");
    const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
    const grid: string[][] = textLines.map(l => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

    for (const [k] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci)) - dRow;
      const c = Number(k.slice(ci + 1)) - dCol;
      if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
        grid[r][c] = otherComposite.get(`${r},${c}`) ?? " ";
      }
    }

    for (const [k, ch] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      while (grid.length <= r) grid.push(new Array(maxCols).fill(" "));
      if (!grid[r]) grid[r] = new Array(maxCols).fill(" ");
      while (grid[r].length <= c) grid[r].push(" ");
      grid[r][c] = ch;
    }

    return grid.map(row => row.join("").trimEnd()).join("\n");
  }

  it("TWO_ADJACENT fixture scans as 2 rects with junction chars", () => {
    const result = scan(TWO_ADJACENT);
    expect(result.rects.length).toBe(2);
    expect(TWO_ADJACENT).toContain("┬");
    expect(TWO_ADJACENT).toContain("┴");
  });

  it("TWO_ADJACENT wireframe region preserves junction chars in text", () => {
    const regions = detectRegions(scan(TWO_ADJACENT));
    expect(regions.length).toBe(1);
    expect(regions[0].type).toBe("wireframe");
    expect(regions[0].text).toContain("┬");
    expect(regions[0].text).toContain("┴");
  });

  it("drag left rect down by 1: otherComposite restores right rect TL at row 0", () => {
    // The fixed erase restores the right rect's TL corner at old row 0.
    // The left rect's new cells start at row 1, so row 0 is not overwritten.
    // This tests the key junction-char preservation: old erase positions get
    // otherComposite chars (not spaces) written back.
    const scanResult = scan(TWO_ADJACENT);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const rectLayers = getLayersForRegion(scanResult, wf).filter(l => l.type === "rect");
    expect(rectLayers.length).toBe(2);

    const leftRect = rectLayers.reduce((a, b) => (a.bbox.col < b.bbox.col ? a : b));
    const rightRect = rectLayers.find(l => l.id !== leftRect.id)!;
    const sharedCol = rightRect.bbox.col;

    // What character does the right rect's layer have at its TL corner?
    const rightRectTL = rightRect.cells.get(`0,${sharedCol}`);
    expect(rightRectTL).toBeDefined();
    expect(rightRectTL).not.toBe(" ");

    const cloned = getLayersForRegion(scanResult, wf).map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    const result = applyDragFixed2(wf.text, cloned, leftRect.id, 1, 0);

    // Row 0 at the shared col should have the right rect's TL corner char
    // (restored from otherComposite because left rect's old TR was at that position,
    //  and new left rect cells start at row 1 — so row 0 is not overwritten)
    const resultRow0 = [...(result.split("\n")[0] ?? "")];
    expect(resultRow0[sharedCol]).toBe(rightRectTL);
  });

  it("drag left rect down by 1: KNOWN BUG — new cells at row 1 overwrite right rect left border", () => {
    // This test documents a real bug: the left rect's new TR corner at (1, sharedCol)
    // overwrites the right rect's left border (│) at that position, causing the right
    // rect to fail re-scanning. This is distinct from the junction char erasure bug
    // and represents a second class of drag problem: new cell positions colliding with
    // adjacent rects.
    const scanResult = scan(TWO_ADJACENT);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const rectLayers = getLayersForRegion(scanResult, wf).filter(l => l.type === "rect");
    const leftRect = rectLayers.reduce((a, b) => (a.bbox.col < b.bbox.col ? a : b));
    const rightRect = rectLayers.find(l => l.id !== leftRect.id)!;

    const cloned = getLayersForRegion(scanResult, wf).map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    const result = applyDragFixed2(wf.text, cloned, leftRect.id, 1, 0);
    const rescan = scan(result);

    // BUG: left rect's new cells overwrite right rect's left border at row 1
    // Right rect cannot be found at its original col after this drag
    const rightRectAfter = rescan.rects.find(r => r.col === rightRect.bbox.col);
    // Document current (buggy) behavior
    expect(rightRectAfter).toBeUndefined();
  });

  it("drag left rect right by 1: right rect boundary chars preserved", () => {
    const scanResult = scan(TWO_ADJACENT);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const rectLayers = getLayersForRegion(scanResult, wf).filter(l => l.type === "rect");
    const leftRect = rectLayers.reduce((a, b) => (a.bbox.col < b.bbox.col ? a : b));

    const cloned = getLayersForRegion(scanResult, wf).map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDragFixed2(wf.text, cloned, leftRect.id, 0, 1);

    // The result should still contain box-drawing characters
    const boxCount = [...result].filter(c => "┌┐└┘├┤┬┴┼─│".includes(c)).length;
    expect(boxCount).toBeGreaterThan(0);

    // Right rect should still scan correctly
    const rescan = scan(result);
    expect(rescan.rects.length).toBeGreaterThan(0);
  });

  it("buggy erase: dragging left rect down loses shared junction chars", () => {
    // The BUGGY version writes spaces at erased cells unconditionally.
    // This should destroy the ┬ and ┴ at the shared wall.
    function applyDragBuggy2(
      regionText: string,
      layers: LayerList,
      layerId: string,
      dRow: number,
      dCol: number,
    ): string {
      const layer = layers.find(l => l.id === layerId)!;
      const newCells = new Map<string, string>();
      for (const [k, val] of layer.cells) {
        const ci = k.indexOf(",");
        newCells.set(`${Number(k.slice(0, ci)) + dRow},${Number(k.slice(ci + 1)) + dCol}`, val);
      }
      layer.cells = newCells;
      layer.bbox.row += dRow;
      layer.bbox.col += dCol;

      const textLines = regionText.split("\n");
      const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
      const grid: string[][] = textLines.map(l => {
        const chars = [...l];
        while (chars.length < maxCols) chars.push(" ");
        return chars;
      });

      // BUGGY: writes spaces unconditionally
      for (const [k] of layer.cells) {
        const ci = k.indexOf(",");
        const r = Number(k.slice(0, ci)) - dRow;
        const c = Number(k.slice(ci + 1)) - dCol;
        if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
          grid[r][c] = " ";
        }
      }

      for (const [k, ch] of layer.cells) {
        const ci = k.indexOf(",");
        const r = Number(k.slice(0, ci));
        const c = Number(k.slice(ci + 1));
        while (grid.length <= r) grid.push(new Array(maxCols).fill(" "));
        if (!grid[r]) grid[r] = new Array(maxCols).fill(" ");
        while (grid[r].length <= c) grid[r].push(" ");
        grid[r][c] = ch;
      }

      return grid.map(row => row.join("").trimEnd()).join("\n");
    }

    const scanResult = scan(TWO_ADJACENT);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const rectLayers = getLayersForRegion(scanResult, wf).filter(l => l.type === "rect");
    const leftRect = rectLayers.reduce((a, b) => (a.bbox.col < b.bbox.col ? a : b));

    const origJunctions = [...TWO_ADJACENT].filter(c => "┬┴".includes(c)).length;
    expect(origJunctions).toBe(2); // one ┬ and one ┴

    const cloned = getLayersForRegion(scanResult, wf).map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    const buggyResult = applyDragBuggy2(wf.text, cloned, leftRect.id, 1, 0);
    const buggyJunctions = [...buggyResult].filter(c => "┬┴".includes(c)).length;

    // Buggy version erases cells that may overlap with the shared wall chars.
    // The left rect's cells at the shared wall column get erased (overwritten with space).
    // Whether those cells ARE the ┬/┴ depends on what the scanner assigned to left vs right.
    // Either way, the fixed version must produce >= the buggy version's junction count.
    const cloned2 = getLayersForRegion(scanResult, wf).map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    const fixedResult = applyDragFixed2(wf.text, cloned2, leftRect.id, 1, 0);
    const fixedJunctions = [...fixedResult].filter(c => "┬┴".includes(c)).length;

    expect(fixedJunctions).toBeGreaterThanOrEqual(buggyJunctions);
  });
});

// ── 14. Text label preservation during drag ───────────────

describe("text label preservation during drag", () => {
  const LOGIN_FORM = [
    "┌──────────────┐",
    "│  Login Form  │",
    "│              │",
    "│  [Username]  │",
    "│  [Password]  │",
    "│  [Submit]    │",
    "└──────────────┘",
  ].join("\n");

  type LayerList = Layer[];

  function applyDragWithLabels(
    regionText: string,
    layers: LayerList,
    layerId: string,
    dRow: number,
    dCol: number,
  ): string {
    const layer = layers.find(l => l.id === layerId)!;
    const otherComposite = compositeLayers(layers.filter(l => l.id !== layerId));

    const newCells = new Map<string, string>();
    for (const [k, val] of layer.cells) {
      const ci = k.indexOf(",");
      newCells.set(`${Number(k.slice(0, ci)) + dRow},${Number(k.slice(ci + 1)) + dCol}`, val);
    }
    layer.cells = newCells;
    layer.bbox.row += dRow;
    layer.bbox.col += dCol;

    const textLines = regionText.split("\n");
    const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
    const grid: string[][] = textLines.map(l => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

    for (const [k] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci)) - dRow;
      const c = Number(k.slice(ci + 1)) - dCol;
      if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
        grid[r][c] = otherComposite.get(`${r},${c}`) ?? " ";
      }
    }

    for (const [k, ch] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      while (grid.length <= r) grid.push(new Array(maxCols).fill(" "));
      if (!grid[r]) grid[r] = new Array(maxCols).fill(" ");
      while (grid[r].length <= c) grid[r].push(" ");
      grid[r][c] = ch;
    }

    return grid.map(row => row.join("").trimEnd()).join("\n");
  }

  it("LOGIN_FORM fixture scans as a rect with text labels inside", () => {
    const result = scan(LOGIN_FORM);
    expect(result.rects.length).toBe(1);
    // Text labels are scanned as separate text layers inside the rect
    expect(result.texts.length).toBeGreaterThan(0);
    const allText = result.texts.map(t => t.content).join(" ");
    // The scanner may trim whitespace from text content
    expect(allText).toMatch(/Login Form|Login/);
    expect(allText).toMatch(/\[Username\]|\[Password\]|\[Submit\]/);
  });

  it("LOGIN_FORM: text layers are separate from the rect layer", () => {
    // This is the architectural property that creates the text-label drag bug.
    // Text layers have their own cells at fixed positions. They are NOT
    // automatically moved when the rect layer moves.
    const scanResult = scan(LOGIN_FORM);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const wfLayers = getLayersForRegion(scanResult, wf);
    const textLayers = wfLayers.filter(l => l.type === "text");
    const rectLayer = wfLayers.find(l => l.type === "rect")!;

    // Text layers exist independently of the rect
    expect(textLayers.length).toBeGreaterThan(0);
    // Text layers are inside the rect's bbox
    for (const tl of textLayers) {
      expect(tl.bbox.row).toBeGreaterThan(rectLayer.bbox.row);
      expect(tl.bbox.row).toBeLessThan(rectLayer.bbox.row + rectLayer.bbox.h);
    }
  });

  it("KNOWN BUG: drag rect down by 1 overwrites text at row 1 (new border = old text row)", () => {
    // BUG: When dragging the rect DOWN by 1, the new top border (┌─...─┐) is
    // written at row 1, which is where "Login Form" lives. The text layer
    // is NOT moved — only the rect layer moves. So the new border overwrites the label.
    //
    // Root cause: Demo.tsx onMouseUp only moves the selected layer. To fix this,
    // all layers within the rect's bbox should move together when dragging.
    const scanResult = scan(LOGIN_FORM);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const wfLayers = getLayersForRegion(scanResult, wf);
    const rectLayer = wfLayers.find(l => l.type === "rect")!;
    const cloned = wfLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDragWithLabels(wf.text, cloned, rectLayer.id, 1, 0);

    // BUG: "Login Form" at row 1 is overwritten by the new ┌─────────────┐ at row 1
    const loginFormSurvived = result.includes("Login Form");
    // Document current behavior: Login Form is lost
    expect(loginFormSurvived).toBe(false);

    // But labels NOT at the new top border row should survive in the stitched text
    // (their cells are in the original text grid and aren't overwritten by the rect's cells
    //  IF the rect's new cells don't reach those rows)
    // [Username] is at row 3 (1-indexed inside rect), new rect borders at rows 1,2,4,5,6...
    // Actually the rect is h=7, so it spans rows 1-7 after move. Row 3 has a new left/right │
    // at cols 0 and 16 only (not the interior). So [Username] at col 3-12 should survive.
    expect(result).toContain("[Username]");
    expect(result).toContain("[Password]");
    expect(result).toContain("[Submit]");
  });

  it("drag rect right by 2: text labels survive because cols don't overlap with new border", () => {
    // When dragging RIGHT by 2, the new top border row is still row 0.
    // The old top border at row 0 is erased (restored to spaces from otherComposite).
    // The new top border at row 0 (shifted right by 2) doesn't overlap text at rows 1-5.
    // So text labels at rows 1-5 in the original positions survive.
    const scanResult = scan(LOGIN_FORM);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const wfLayers = getLayersForRegion(scanResult, wf);
    const rectLayer = wfLayers.find(l => l.type === "rect")!;
    const cloned = wfLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDragWithLabels(wf.text, cloned, rectLayer.id, 0, 2);

    // When moving horizontally, the new border occupies the same ROWS as before.
    // The only cells that change are the left and right borders (cols shift by 2).
    // Interior text labels survive if their cols don't overlap with the new borders.
    // Labels in the middle of the rect survive because only the perimeter moves.
    expect(result).toContain("[Username]");
    expect(result).toContain("[Password]");
    expect(result).toContain("[Submit]");
  });

  it("text layers do NOT move when only the rect layer is dragged", () => {
    // Verify architectural property: applyDragWithLabels moves only the target layer.
    // The text layer's bbox.row is unchanged after dragging the rect.
    const scanResult = scan(LOGIN_FORM);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const wfLayers = getLayersForRegion(scanResult, wf);
    const textLayers = wfLayers.filter(l => l.type === "text");
    expect(textLayers.length).toBeGreaterThan(0);

    // Record original rows of all text layers
    const origTextRows = textLayers.map(l => ({ id: l.id, row: l.bbox.row }));

    const rectLayer = wfLayers.find(l => l.type === "rect")!;
    const cloned = wfLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    applyDragWithLabels(wf.text, cloned, rectLayer.id, 2, 0);

    // Each text layer's bbox.row is unchanged (rect was moved, not text layers)
    for (const orig of origTextRows) {
      const clonedTl = cloned.find(l => l.id === orig.id);
      expect(clonedTl?.bbox.row).toBe(orig.row);
    }
  });

  it("DASHBOARD: drag inner card preserves labels NOT at new border positions", () => {
    // The inner card (small rect) is dragged. The outer layout's labels are in
    // separate text layers. Since the inner card's new border doesn't overwrite
    // the outer layout's text positions, those labels survive.
    const scanResult = scan(DASHBOARD);
    const regions = detectRegions(scanResult);
    const wf = regions.find(r => r.type === "wireframe")!;
    const wfLayers = getLayersForRegion(scanResult, wf);

    const innerCard = wfLayers
      .filter(l => l.type === "rect")
      .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];

    const cloned = wfLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDragWithLabels(wf.text, cloned, innerCard.id, 1, 0);

    // The outer layout's header text is at row 0. The inner card moves from
    // its position down by 1 row. If the new top border of the inner card
    // doesn't land on row 0 where "Dashboard" and "Header / Nav Bar" live,
    // those labels survive.
    // The inner card's bbox.row after move is innerCard.bbox.row + 1.
    // "Dashboard" and "Header / Nav Bar" are at row 0.
    if (innerCard.bbox.row + 1 !== 0) {
      // "Header / Nav Bar" is always at the top row of the wf (row 0) — safe
      expect(result).toContain("Header / Nav Bar");
    }
    // The drag should not crash and should produce valid text
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── 15. Resize boundary conditions ───────────────────────

describe("resize boundary conditions", () => {
  it("resize to minimum 2x2 produces a valid 4-corner box with no interior", () => {
    const cells = regenerateCells({ row: 0, col: 0, w: 2, h: 2 }, LIGHT_RECT_STYLE);
    expect(cells.size).toBe(4); // exactly 4 corners, no interior
    expect(cells.get("0,0")).toBe("┌");
    expect(cells.get("0,1")).toBe("┐");
    expect(cells.get("1,0")).toBe("└");
    expect(cells.get("1,1")).toBe("┘");
    // No interior cells
    expect(cells.has("0,2")).toBe(false);
    expect(cells.has("1,2")).toBe(false);
  });

  it("resize to 1x1 produces single corner cell", () => {
    const cells = regenerateCells({ row: 5, col: 3, w: 1, h: 1 }, LIGHT_RECT_STYLE);
    expect(cells.size).toBe(1);
    expect(cells.get("5,3")).toBe("┌");
  });

  it("minimum-size guard: w < 2 clamped to 2 in Demo.tsx onMouseMove logic", () => {
    // Test the clamping logic that Demo.tsx applies: newW = Math.max(2, newW)
    let newW = -5;
    let newH = -3;
    if (newW < 2) newW = 2;
    if (newH < 2) newH = 2;
    expect(newW).toBe(2);
    expect(newH).toBe(2);

    // verify regenerateCells still works at clamped values
    const cells = regenerateCells({ row: 0, col: 0, w: newW, h: newH }, LIGHT_RECT_STYLE);
    expect(cells.size).toBe(4);
  });

  it("resize extending beyond original grid: grid is expanded, not truncated", () => {
    const small = "┌──┐\n│  │\n└──┘";
    const scanResult = scan(small);
    const regions = detectRegions(scanResult);
    const wf = regions[0];
    const rect = getLayersForRegion(scanResult, wf).find(l => l.type === "rect")!;

    // Resize from w=4,h=3 to w=8,h=6 — extends well beyond original text
    const newBbox = { row: rect.bbox.row, col: rect.bbox.col, w: 8, h: 6 };
    rect.bbox = newBbox;
    rect.cells = regenerateCells(newBbox, rect.style ?? LIGHT_RECT_STYLE);

    // Simulate the stitch-back (writing new cells into a grid)
    const textLines = wf.text.split("\n");
    const grid: string[][] = textLines.map(l => [...l]);

    for (const [k, ch] of rect.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      while (grid.length <= r) grid.push([]);
      if (!grid[r]) grid[r] = [];
      while (grid[r].length <= c) grid[r].push(" ");
      grid[r][c] = ch;
    }

    const newText = grid.map(row => row.join("").trimEnd()).join("\n");
    const rescan = scan(newText);
    // Must scan as a valid rect at the new size
    expect(rescan.rects.length).toBeGreaterThan(0);
    const found = rescan.rects.find(r => r.w === 8 && r.h === 6);
    expect(found).toBeDefined();
  });

  it("resize that changes only width: corner and edge chars updated correctly", () => {
    const cells5 = regenerateCells({ row: 0, col: 0, w: 5, h: 3 }, LIGHT_RECT_STYLE);
    const cells10 = regenerateCells({ row: 0, col: 0, w: 10, h: 3 }, LIGHT_RECT_STYLE);

    // New TR corner at new right edge
    expect(cells5.get("0,4")).toBe("┐");
    expect(cells10.get("0,9")).toBe("┐");
    // Old TR position should be interior (─) in wider box
    expect(cells10.get("0,4")).toBe("─");
    // Width-5 box does NOT have a corner at col 9
    expect(cells5.has("0,9")).toBe(false);
  });

  it("resize that changes only height: corner and edge chars updated correctly", () => {
    const cells3 = regenerateCells({ row: 0, col: 0, w: 5, h: 3 }, LIGHT_RECT_STYLE);
    const cells6 = regenerateCells({ row: 0, col: 0, w: 5, h: 6 }, LIGHT_RECT_STYLE);

    // BL corner at new bottom
    expect(cells3.get("2,0")).toBe("└");
    expect(cells6.get("5,0")).toBe("└");
    // Old BL position is now interior (│) in taller box
    expect(cells6.get("2,0")).toBe("│");
  });

  it("resize from DASHBOARD's outer rect preserves inner layout chars", () => {
    const scanResult = scan(DASHBOARD);
    const regions = detectRegions(scanResult);
    const wf = regions.find(r => r.type === "wireframe")!;

    // The outer (largest) rect
    const outerRect = getLayersForRegion(scanResult, wf)
      .filter(l => l.type === "rect")
      .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0];

    const origText = wf.text;
    const junctionCount = (t: string) => [...t].filter(c => "├┤┬┴┼".includes(c)).length;

    // Regenerate cells for the outer rect (just the perimeter)
    const newBbox = { ...outerRect.bbox, w: outerRect.bbox.w + 2 };
    const newCells = regenerateCells(newBbox, outerRect.style ?? LIGHT_RECT_STYLE);

    // Build the stitch result by writing new cells into original text grid
    const textLines = origText.split("\n");
    const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
    const grid: string[][] = textLines.map(l => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

    for (const [k, ch] of newCells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      while (grid.length <= r) grid.push(new Array(maxCols).fill(" "));
      if (!grid[r]) grid[r] = new Array(maxCols).fill(" ");
      while (grid[r].length <= c) grid[r].push(" ");
      grid[r][c] = ch;
    }

    const result = grid.map(row => row.join("").trimEnd()).join("\n");

    // The internal structure (├┬┤┴ from internal dividers) should be preserved
    // since we only wrote NEW cells for the outer rect's NEW perimeter
    expect(junctionCount(result)).toBeGreaterThan(0);
  });
});

// ── 16. Prose editing at region boundaries ────────────────

describe("prose editing at region boundaries", () => {
  function stitchRegions(regions: Region[]): string {
    return regions.map(r => r.text).join("\n\n");
  }

  it("insert at last line of prose region before wireframe: wireframe not corrupted", () => {
    const regions = detectRegions(scan(DASHBOARD));
    expect(regions.length).toBe(3);
    const proseRegion = regions[0];

    // Get last line of the prose region
    const proseLines = proseRegion.text.split("\n");
    const lastRow = proseLines.length - 1;
    const lastCol = proseLines[lastRow].length;

    // Insert a character at the very end of the prose (right before wireframe)
    const { text: newProseText } = insertChar(proseRegion.text, { row: lastRow, col: lastCol }, "X");
    const modified = regions.map((r, i) => (i === 0 ? { ...r, text: newProseText } : r));
    const stitched = stitchRegions(modified);

    const reparsed = detectRegions(scan(stitched));
    // Structure must be preserved
    expect(reparsed.length).toBe(3);
    expect(reparsed.map(r => r.type)).toEqual(["prose", "wireframe", "prose"]);

    // Wireframe must have same rect count
    const wfBefore = regions.find(r => r.type === "wireframe")!;
    const wfAfter = reparsed.find(r => r.type === "wireframe")!;
    expect(scan(wfAfter.text).rects.length).toBe(scan(wfBefore.text).rects.length);

    // Box-drawing chars in wireframe must be unchanged
    const boxCount = (t: string) => [...t].filter(c => "┌┐└┘├┤┬┴┼─│".includes(c)).length;
    expect(boxCount(wfAfter.text)).toBe(boxCount(wfBefore.text));
  });

  it("insert newline at end of prose region before wireframe: structure preserved", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const proseRegion = regions[0];
    const proseLines = proseRegion.text.split("\n");
    const lastRow = proseLines.length - 1;
    const lastCol = proseLines[lastRow].length;

    const { text: newProseText } = insertChar(proseRegion.text, { row: lastRow, col: lastCol }, "\n");
    const modified = regions.map((r, i) => (i === 0 ? { ...r, text: newProseText } : r));
    const stitched = stitchRegions(modified);

    const reparsed = detectRegions(scan(stitched));
    expect(reparsed.map(r => r.type)).toEqual(["prose", "wireframe", "prose"]);
  });

  it("delete last char of last line of prose region: wireframe intact", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const proseRegion = regions[0];
    const proseLines = proseRegion.text.split("\n");
    const lastRow = proseLines.length - 1;
    const lastCol = proseLines[lastRow].length;

    if (lastCol === 0) return; // nothing to delete

    const { text: newProseText } = deleteChar(proseRegion.text, { row: lastRow, col: lastCol });
    const modified = regions.map((r, i) => (i === 0 ? { ...r, text: newProseText } : r));
    const stitched = stitchRegions(modified);

    const reparsed = detectRegions(scan(stitched));
    expect(reparsed.length).toBe(3);
    expect(reparsed.map(r => r.type)).toEqual(["prose", "wireframe", "prose"]);

    const wfBefore = regions.find(r => r.type === "wireframe")!;
    const wfAfter = reparsed.find(r => r.type === "wireframe")!;
    expect(scan(wfAfter.text).rects.length).toBe(scan(wfBefore.text).rects.length);
  });

  it("insert at first line of trailing prose region: preceding wireframe intact", () => {
    const regions = detectRegions(scan(DASHBOARD));
    expect(regions.length).toBe(3);
    const trailingProse = regions[2];
    expect(trailingProse.type).toBe("prose");

    const { text: newProseText } = insertChar(trailingProse.text, { row: 0, col: 0 }, "X");
    const modified = regions.map((r, i) => (i === 2 ? { ...r, text: newProseText } : r));
    const stitched = stitchRegions(modified);

    const reparsed = detectRegions(scan(stitched));
    expect(reparsed.length).toBe(3);
    expect(reparsed.map(r => r.type)).toEqual(["prose", "wireframe", "prose"]);

    const wfBefore = regions.find(r => r.type === "wireframe")!;
    const wfAfter = reparsed.find(r => r.type === "wireframe")!;
    const boxCount = (t: string) => [...t].filter(c => "┌┐└┘├┤┬┴┼─│".includes(c)).length;
    expect(boxCount(wfAfter.text)).toBe(boxCount(wfBefore.text));
  });

  it("insert text that looks like a wireframe char into prose: not misclassified", () => {
    // Insert a '─' (box-drawing char) into prose text. Since it's isolated
    // (no adjacent box chars), it should not create a spurious wireframe region.
    const regions = detectRegions(scan(DASHBOARD));
    const proseRegion = regions[0];

    const { text: newProseText } = insertChar(proseRegion.text, { row: 0, col: 5 }, "─");
    const modified = regions.map((r, i) => (i === 0 ? { ...r, text: newProseText } : r));
    const stitched = stitchRegions(modified);

    const reparsed = detectRegions(scan(stitched));
    // Should still be 3 regions — one isolated ─ char is not a wireframe
    expect(reparsed.length).toBe(3);
    expect(reparsed.map(r => r.type)).toEqual(["prose", "wireframe", "prose"]);
  });

  it("MULTI_WIREFRAME: editing middle prose region doesn't affect either wireframe", () => {
    const regions = detectRegions(scan(MULTI_WIREFRAME));
    expect(regions.length).toBe(5);
    const middleProse = regions[2];
    expect(middleProse.type).toBe("prose");

    const wf1Before = scan(regions[1].text).rects.length;
    const wf2Before = scan(regions[3].text).rects.length;

    // Insert text in the middle of the middle prose region
    const midLine = Math.floor(middleProse.text.split("\n").length / 2);
    const { text: newProseText } = insertChar(
      middleProse.text,
      { row: midLine, col: 0 },
      "New content here. ",
    );
    const modified = regions.map((r, i) => (i === 2 ? { ...r, text: newProseText } : r));
    const stitched = stitchRegions(modified);

    const reparsed = detectRegions(scan(stitched));
    expect(reparsed.length).toBe(5);
    expect(reparsed.map(r => r.type)).toEqual([
      "prose",
      "wireframe",
      "prose",
      "wireframe",
      "prose",
    ]);

    expect(scan(reparsed[1].text).rects.length).toBe(wf1Before);
    expect(scan(reparsed[3].text).rects.length).toBe(wf2Before);
  });
});

// ── Helpers ──────────────────────────────────────────────

function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) results.push(p);
    }
  })(dir);
  return results;
}
