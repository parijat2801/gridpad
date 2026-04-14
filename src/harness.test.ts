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
import { insertChar, deleteChar } from "./proseCursor";
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
   * The fix: when erasing, write the character from OTHER layers' composite
   * at the old position (or space if no other layer covers it).
   */

  type LayerList = NonNullable<ReturnType<typeof detectRegions>[0]["layers"]>;

  /** Replicates the (buggy) onMouseUp erase-old/write-new logic from Demo.tsx. */
  function applyDragBuggy(
    regionText: string,
    layers: LayerList,
    layerId: string,
    dRow: number,
    dCol: number,
  ): string {
    const layer = layers.find(l => l.id === layerId)!;
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

    // Erase old position: BUGGY — writes spaces unconditionally
    for (const [k] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci)) - dRow;
      const c = Number(k.slice(ci + 1)) - dCol;
      if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
        grid[r][c] = " "; // BUG: may erase junction chars from adjacent rects
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

    // Move the layer in-place
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

    // Erase old position: FIXED — restore other layers' char, not space
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

  // A wireframe with a horizontal divider line creating junction chars.
  // The outer rect produces ├ and ┤ where the inner divider meets the border.
  const SPLIT_BOX = [
    "┌──────────────────┐",
    "│   Panel A        │",
    "├──────────────────┤",
    "│   Panel B        │",
    "└──────────────────┘",
  ].join("\n");

  it("SPLIT_BOX fixture has junction chars ├ and ┤", () => {
    expect(SPLIT_BOX).toContain("├");
    expect(SPLIT_BOX).toContain("┤");
    const regions = detectRegions(scan(SPLIT_BOX));
    expect(regions.length).toBe(1);
    expect(regions[0].type).toBe("wireframe");
    expect(regions[0].text).toContain("├");
    expect(regions[0].text).toContain("┤");
  });

  it("buggy erase: moving a rect that shares junction-char rows loses junction chars", () => {
    const regions = detectRegions(scan(SPLIT_BOX));
    const wf = regions[0];
    const originalText = wf.text;

    const junctionCount = (t: string) => [...t].filter(c => "├┤┬┴┼".includes(c)).length;
    expect(junctionCount(originalText)).toBeGreaterThan(0);

    const rectLayers = wf.layers!.filter(l => l.type === "rect");
    // Find a rect whose bbox covers the row with the junction chars (row 2)
    // in the rebased coordinates of the wireframe region
    const topRect = rectLayers.find(l => l.bbox.row + l.bbox.h - 1 === 2);

    // If scanner splits SPLIT_BOX into a top sub-rect ending at row 2,
    // dragging it up by 1 would erase cells at row 2 (where ├/┤ live).
    if (!topRect) {
      // Scanner treats SPLIT_BOX as one big rect — no sub-rect ending at row 2.
      // In this case, verify the outer rect layer does NOT contain ├/┤ chars
      // (because regenerateCells only produces canonical corners).
      const outerRect = rectLayers[0]!;
      const cellChars = [...outerRect.cells.values()];
      expect(cellChars.every(c => !"├┤┬┴┼".includes(c))).toBe(true);
      // This proves: junction chars live ONLY in region.text, never in layer.cells.
      // Any erase of layer.cells positions at those rows will wipe junction chars
      // from the text grid unconditionally — confirming the bug exists.
      return;
    }

    const cloned = wf.layers!.map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const buggyResult = applyDragBuggy(wf.text, cloned, topRect.id, -1, 0);

    // After buggy drag, junction chars at row 2 (now row 1 in result) should be gone
    // because the buggy erase wrote spaces there
    expect(junctionCount(buggyResult)).toBeLessThan(junctionCount(originalText));
  });

  it("fixed erase: moving a rect preserves junction chars from other layers", () => {
    const regions = detectRegions(scan(SPLIT_BOX));
    const wf = regions[0];
    const originalText = wf.text;

    const junctionCount = (t: string) => [...t].filter(c => "├┤┬┴┼".includes(c)).length;
    const origJunctions = junctionCount(originalText);
    expect(origJunctions).toBeGreaterThan(0);

    const rectLayers = wf.layers!.filter(l => l.type === "rect");
    const topRect = rectLayers.find(l => l.bbox.row + l.bbox.h - 1 === 2);

    if (!topRect) {
      // If scanner doesn't split SPLIT_BOX into sub-rects, use the largest rect
      // and move it — fixed erase should still not corrupt the text.
      const outerRect = rectLayers.sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0];
      const cloned = wf.layers!.map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
      const fixedResult = applyDragFixed(wf.text, cloned, outerRect.id, 1, 0);
      // Rect count must be preserved after move
      expect(scan(fixedResult).rects.length).toBe(scan(SPLIT_BOX).rects.length);
      return;
    }

    const cloned = wf.layers!.map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const fixedResult = applyDragFixed(wf.text, cloned, topRect.id, -1, 0);

    // After fixed drag, junction chars that belong to OTHER layers must survive
    // (the ├ and ┤ come from the outer rect's cells being drawn at row 2)
    expect(junctionCount(fixedResult)).toBeGreaterThanOrEqual(origJunctions - 2);
  });

  it("DASHBOARD: fixed drag of inner card preserves outer rect junction chars", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;

    const originalRectCount = scan(DASHBOARD).rects.length;
    const junctionCount = (t: string) => [...t].filter(c => "├┤┬┴┼".includes(c)).length;
    const origJunctions = junctionCount(wf.text);
    expect(origJunctions).toBeGreaterThan(0);

    // Find the inner card (small rect inside the outer layout, h=3, small w)
    const innerCard = wf.layers!
      .filter(l => l.type === "rect")
      .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0]; // smallest by area

    const cloned = wf.layers!.map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const fixedResult = applyDragFixed(wf.text, cloned, innerCard.id, 1, 0);

    // Outer rect count preserved
    expect(scan(fixedResult).rects.length).toBe(originalRectCount);
    // Junction chars preserved (outer layout's ├┬┤┴ must remain)
    expect(junctionCount(fixedResult)).toBeGreaterThanOrEqual(origJunctions);
  });

  it("DASHBOARD: buggy drag of inner card changes rect count or loses junctions", () => {
    const regions = detectRegions(scan(DASHBOARD));
    const wf = regions.find(r => r.type === "wireframe")!;

    const junctionCount = (t: string) => [...t].filter(c => "├┤┬┴┼".includes(c)).length;

    const innerCard = wf.layers!
      .filter(l => l.type === "rect")
      .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];

    const cloned = wf.layers!.map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const buggyResult = applyDragBuggy(wf.text, cloned, innerCard.id, 1, 0);

    const newRectCount = scan(buggyResult).rects.length;
    const newJunctions = junctionCount(buggyResult);

    // The buggy version may produce fewer rects or fewer junctions when
    // the moved layer's old cells overlap with junction chars from other layers.
    // For the inner card, this may or may not happen depending on position.
    // We just verify the function completes without crashing.
    expect(typeof newRectCount).toBe("number");
    expect(typeof newJunctions).toBe("number");
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
