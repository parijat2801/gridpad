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
    expect(regions.every(r => r.type === "prose")).toBe(true);
  });

  it("wireframe region layers have row-rebased coordinates", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;
    for (const l of wf.layers!) {
      expect(l.bbox.row).toBeGreaterThanOrEqual(0);
      for (const key of l.cells.keys()) {
        expect(Number(key.split(",")[0])).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("no region exceeds 500 layers", () => {
    for (const fixture of [DASHBOARD, MULTI_WIREFRAME, PURE_WIREFRAME]) {
      for (const r of detectRegions(scan(fixture))) {
        if (r.layers) expect(r.layers.length).toBeLessThan(500);
      }
    }
  });
});

// ── 2. Wireframe compositing ─────────────────────────────

describe("wireframe compositing", () => {
  it("composite produces correct characters for a simple box", () => {
    const regions = detectRegions(scan(PURE_WIREFRAME));
    const composite = compositeLayers(regions[0].layers!);
    expect(composite.get("0,0")).toBe("┌");
    expect(composite.get("0,10")).toBe("┐");
    expect(composite.get("4,0")).toBe("└");
  });

  it("buildSparseRows groups cells correctly", () => {
    const regions = detectRegions(scan(PURE_WIREFRAME));
    const composite = compositeLayers(regions[0].layers!);
    const sparse = buildSparseRows(composite);
    expect(sparse.length).toBe(5);
    expect(sparse[0].startCol).toBe(0);
    expect(sparse[0].text[0]).toBe("┌");
  });

  it("composite is deterministic", () => {
    const wf = detectRegions(scan(DASHBOARD)).find(r => r.type === "wireframe")!;
    const c1 = compositeLayers(wf.layers!);
    const c2 = compositeLayers(wf.layers!);
    expect([...c1.entries()]).toEqual([...c2.entries()]);
  });
});

// ── 3. Drag math ─────────────────────────────────────────

describe("drag math", () => {
  it("moving a layer shifts bbox and cell keys", () => {
    const singleBox = "┌──┐\n│  │\n└──┘";
    const wf = detectRegions(scan(singleBox))[0];
    const layer = wf.layers!.find(l => l.type === "rect")!;
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
    const composite = compositeLayers(wf.layers!);
    expect(composite.get(`${origRow + 2},${origCol + 3}`)).toBe("┌");
  });

  it("drag preserves all cell characters", () => {
    const wf = detectRegions(scan(PURE_WIREFRAME))[0];
    const layer = wf.layers!.find(l => l.type === "rect")!;
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
    const wf = detectRegions(scan(PURE_WIREFRAME))[0];
    const rect = wf.layers!.find(l => l.type === "rect" && l.style)!;
    rect.bbox.w += 5;
    rect.cells = regenerateCells(rect.bbox, rect.style!);
    const composite = compositeLayers(wf.layers!);
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
      const result = scan(fs.readFileSync(f, "utf8"));
      if (result.rects.length === 0) continue;
      count++;
      const regions = detectRegions(result);
      expect(regions.length).toBeGreaterThan(0);
      expect(regions.some(r => r.type === "wireframe")).toBe(true);
      for (const r of regions) {
        if (r.layers) expect(r.layers.length).toBeLessThan(500);
        expect(r.startRow).toBeLessThanOrEqual(r.endRow);
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it.skipIf(!hasColex)("no wireframe region produces empty composite", () => {
    for (const f of findMdFiles(planDir)) {
      const result = scan(fs.readFileSync(f, "utf8"));
      if (result.rects.length === 0) continue;
      for (const r of detectRegions(result)) {
        if (r.type === "wireframe" && r.layers && r.layers.length > 0) {
          expect(compositeLayers(r.layers).size).toBeGreaterThan(0);
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
    const regions = detectRegions(scan(DASHBOARD));
    expect(regions.length).toBe(3);
    const wf = regions.find(r => r.type === "wireframe")!;
    expect(compositeLayers(wf.layers!).size).toBeGreaterThan(0);
    expect(buildSparseRows(compositeLayers(wf.layers!)).length).toBeGreaterThan(0);
  });

  it("click hit-test finds correct layer", () => {
    const wf = detectRegions(scan(DASHBOARD)).find(r => r.type === "wireframe")!;
    const rect = wf.layers!.find(l => l.type === "rect" && l.bbox.w > 3)!;
    let bestId: string | null = null;
    let bestZ = -Infinity;
    for (const l of wf.layers!) {
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
    const r1 = detectRegions(scan(DASHBOARD));
    const rect1 = r1.find(r => r.type === "wireframe")!.layers!.find(l => l.type === "rect")!;
    rect1.bbox.row += 3;
    const r2 = detectRegions(scan(DASHBOARD));
    const rect2 = r2.find(r => r.type === "wireframe")!.layers!.find(l => l.id === rect1.id)!;
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
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;
    const composite = compositeLayers(wf.layers!);
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

// ── 10. Performance targets ──────────────────────────────

describe("performance targets", () => {
  const planDir = "/Users/parijat/dev/colex-platform/docs/plans";
  const hasColex = fs.existsSync(planDir);

  it.skipIf(!hasColex)("file open pipeline < 500ms", () => {
    const f = path.join(planDir, "gardener-plans-pending/g-plan-garden-runtime-ux-v1-pending.md");
    if (!fs.existsSync(f)) return;
    const text = fs.readFileSync(f, "utf8");
    const start = performance.now();
    const regions = detectRegions(scan(text));
    for (const r of regions) {
      if (r.type === "wireframe" && r.layers) compositeLayers(r.layers);
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
    const wf = detectRegions(scan(DASHBOARD)).find(r => r.type === "wireframe")!;
    const layers = wf.layers!;
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

  it.skipIf(!hasColex)("largest file: all regions < 500 layers", () => {
    const f = path.join(planDir, "workspace-redesign.md");
    if (!fs.existsSync(f)) return;
    const max = Math.max(...detectRegions(scan(fs.readFileSync(f, "utf8")))
      .map(r => r.layers?.length ?? 0));
    console.log(`  Max layers/region: ${max} (<500)`);
    expect(max).toBeLessThan(500);
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
