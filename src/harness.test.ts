/**
 * Programmatic test harness for the Pretext spatial document pipeline.
 *
 * Tests the full data pipeline without a browser:
 * 1. Wireframe compositing — correct characters at correct positions
 * 2. Resize + regenerate — box-drawing redrawn at new size
 * 3. Pretext layout — line counts change with width
 * 4. Performance targets
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { scan } from "./scanner";
import {
  buildLayersFromScan,
  compositeLayers,
  regenerateCells,
  LIGHT_RECT_STYLE,
  type Layer,
} from "./layers";
import { buildSparseRows } from "./sparseRows";
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
      // @ts-expect-error mocking canvas getContext for tests
      el.getContext = () => ({
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

const PURE_WIREFRAME = `┌─────────┐
│ Box A   │
├─────────┤
│ Box B   │
└─────────┘`;

// ── 1. Wireframe compositing ─────────────────────────────

describe("wireframe compositing", () => {
  it("composite produces correct characters for a simple box", () => {
    const scanResult = scan(PURE_WIREFRAME);
    const layers = buildLayersFromScan(scanResult);
    const composite = compositeLayers(layers);
    expect(composite.get("0,0")).toBe("┌");
    expect(composite.get("0,10")).toBe("┐");
    expect(composite.get("4,0")).toBe("└");
  });

  it("buildSparseRows groups cells correctly", () => {
    const scanResult = scan(PURE_WIREFRAME);
    const layers = buildLayersFromScan(scanResult);
    const composite = compositeLayers(layers);
    const sparse = buildSparseRows(composite);
    expect(sparse.length).toBe(5);
    expect(sparse[0].startCol).toBe(0);
    expect(sparse[0].text[0]).toBe("┌");
  });

  it("composite is deterministic", () => {
    const scanResult = scan(PURE_WIREFRAME);
    const layers = buildLayersFromScan(scanResult);
    const c1 = compositeLayers(layers);
    const c2 = compositeLayers(layers);
    expect([...c1.entries()]).toEqual([...c2.entries()]);
  });
});

// ── 2. Resize + regenerate ───────────────────────────────

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
    const layers = buildLayersFromScan(scanResult);
    const rect = layers.find(l => l.type === "rect" && l.style)!;
    rect.bbox.w += 5;
    rect.cells = regenerateCells(rect.bbox, rect.style!);
    const composite = compositeLayers(layers);
    expect(composite.get(`${rect.bbox.row},${rect.bbox.col + rect.bbox.w - 1}`)).toBe("┐");
  });
});

// ── 3. Pretext layout ────────────────────────────────────

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
    expect(r1.lines.map((l: { text: string }) => l.text)).toEqual(r2.lines.map((l: { text: string }) => l.text));
  });
});

// ── 4. Performance targets ──────────────────────────────

describe("performance targets", () => {
  it("pretext layout < 5ms", async () => {
    const { prepareWithSegments, layoutWithLines } = await import("@chenglou/pretext");
    const prepared = prepareWithSegments("Test line.\n".repeat(20), '16px monospace');
    const start = performance.now();
    for (let i = 0; i < 100; i++) layoutWithLines(prepared, 800, 19);
    const ms = (performance.now() - start) / 100;
    console.log(`  Pretext layout: ${ms.toFixed(2)}ms (<5ms)`);
    expect(ms).toBeLessThan(5);
  });

  it("composite < 16ms per call", () => {
    const scanResult = scan(PURE_WIREFRAME);
    const layers = buildLayersFromScan(scanResult);
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
    console.log(`  Composite: ${ms.toFixed(2)}ms/frame (<16ms)`);
    expect(ms).toBeLessThan(16);
  });
});

// ── 5. Resize boundary conditions ────────────────────────

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
    const layers = buildLayersFromScan(scanResult);
    const rect = layers.find(l => l.type === "rect")!;

    // Resize from w=4,h=3 to w=8,h=6 — extends well beyond original text
    const newBbox = { row: rect.bbox.row, col: rect.bbox.col, w: 8, h: 6 };
    rect.bbox = newBbox;
    rect.cells = regenerateCells(newBbox, rect.style ?? LIGHT_RECT_STYLE);

    // Build a grid from the original text and write new cells into it
    const textLines = small.split("\n");
    const grid: string[][] = textLines.map((l: string) => [...l]);

    for (const [k, ch] of rect.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      while (grid.length <= r) grid.push([]);
      if (!grid[r]) grid[r] = [];
      while (grid[r]!.length <= c) grid[r]!.push(" ");
      grid[r]![c] = ch;
    }

    const newText = grid.map((row: string[]) => row.join("").trimEnd()).join("\n");
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
});

// ── 6. Drag math ─────────────────────────────────────────

describe("drag math", () => {
  it("moving a layer shifts bbox and cell keys", () => {
    const singleBox = "┌──┐\n│  │\n└──┘";
    const scanResult = scan(singleBox);
    const layers = buildLayersFromScan(scanResult);
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
    const layers = buildLayersFromScan(scanResult);
    const layer = layers.find(l => l.type === "rect")!;
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

// ── 7. Layer cells use canonical chars only ───────────────

describe("layer cells canonical chars", () => {
  // Two-box fixture with junction chars ├ and ┤
  const OUTER_WITH_DIVIDER = [
    "┌──────────────────┐",
    "│                  │",
    "├──────────────────┤",
    "│                  │",
    "└──────────────────┘",
  ].join("\n");

  it("fixture: OUTER_WITH_DIVIDER has two detectable rects", () => {
    expect(scan(OUTER_WITH_DIVIDER).rects.length).toBe(2);
  });

  it("layer cells NEVER contain junction chars — they use canonical chars only", () => {
    // regenerateCells produces ┌┐└┘─│ only. Junction chars (├┤┬┴┼) only
    // exist in the source text, never in layer.cells.
    const scanResult = scan(OUTER_WITH_DIVIDER);
    const layers = buildLayersFromScan(scanResult);
    const junctionChars = new Set("├┤┬┴┼");
    for (const layer of layers) {
      for (const ch of layer.cells.values()) {
        expect(junctionChars.has(ch)).toBe(false);
      }
    }
  });
});

// ── 8. Drag persistence text-grid edit ───────────────────

describe("drag persistence text-grid edit", () => {
  /**
   * Simulates the exact onMouseUp logic in Demo.tsx:
   *   1. Build a character grid from region text
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
    const maxCols = Math.max(...textLines.map((l: string) => [...l].length), 0);
    const grid: string[][] = textLines.map((l: string) => {
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
        while (grid.length <= r) grid.push(new Array<string>(maxCols).fill(" "));
        const row = grid[r]!;
        while (row.length <= c) row.push(" ");
        row[c] = ch;
      }
    }

    return grid.map((row: string[]) => row.join("").trimEnd()).join("\n");
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
    const maxCols = Math.max(...textLines.map((l: string) => [...l].length), 0);
    const grid: string[][] = textLines.map((l: string) => {
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
        while (grid.length <= r) grid.push(new Array<string>(maxCols).fill(" "));
        const row = grid[r]!;
        while (row.length <= c) row.push(" ");
        row[c] = ch;
      }
    }

    return grid.map((row: string[]) => row.join("").trimEnd()).join("\n");
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
    // Scanner sees ├ as valid TL corner → detects bottom-sub rect (rows 2-4)
    // in addition to outer rect (rows 0-4). Two rects total.
    expect(scan(OUTER_WITH_DIVIDER).rects.length).toBe(2);
  });

  it("buggy erase: outer rect moved right 2 cols — vacated junction positions get spaces, breaking bottom-sub rect", () => {
    const scanResult = scan(OUTER_WITH_DIVIDER);
    const allLayers = buildLayersFromScan(scanResult);
    const origRectCount = scan(OUTER_WITH_DIVIDER).rects.length; // 2

    // Outer rect is the one spanning all 5 rows (largest by area). Move it right 2.
    const outerRect = allLayers
      .filter(l => l.type === "rect")
      .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0]!;

    const cloned = allLayers.map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const buggyResult = applyDragBuggy(OUTER_WITH_DIVIDER, cloned, outerRect.id, 0, 2);

    // Bottom-sub rect's top-left corner at (2,0) is now " " → scanner can't detect it
    expect(scan(buggyResult).rects.length).toBeLessThan(origRectCount);
  });

  it("fixed erase: outer rect moved right 2 cols — OLD positions restored from otherComposite (not spaces)", () => {
    const scanResult = scan(OUTER_WITH_DIVIDER);
    const allLayers = buildLayersFromScan(scanResult);

    const outerRect = allLayers
      .filter(l => l.type === "rect")
      .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0]!;

    // Verify otherComposite has the bottom-sub rect's TL corner at (2,0)
    const otherComposite = compositeLayers(allLayers.filter(l => l.id !== outerRect.id));
    const charAt2_0 = otherComposite.get("2,0");
    expect(charAt2_0).toBeDefined();
    expect(charAt2_0).not.toBe(" ");

    const cloned = allLayers.map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const fixedResult = applyDragFixed(OUTER_WITH_DIVIDER, cloned, outerRect.id, 0, 2);

    // Fixed erase correctly restores charAt2_0 at old position (2,0)
    const resultRow2 = [...(fixedResult.split("\n")[2] ?? "")];
    expect(resultRow2[0]).toBe(charAt2_0);

    // Fixed is at least as good as buggy (may recover some rects):
    const cloned2 = allLayers.map(l => ({ ...l, bbox: { ...l.bbox }, cells: new Map(l.cells) }));
    const buggyResult = applyDragBuggy(OUTER_WITH_DIVIDER, cloned2, outerRect.id, 0, 2);
    const buggyRectCount = scan(buggyResult).rects.length;
    expect(scan(fixedResult).rects.length).toBeGreaterThanOrEqual(buggyRectCount);
  });
});

// ── 9. Shared wall drag ───────────────────────────────────

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
    const maxCols = Math.max(...textLines.map((l: string) => [...l].length), 0);
    const grid: string[][] = textLines.map((l: string) => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

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
      while (grid.length <= r) grid.push(new Array<string>(maxCols).fill(" "));
      if (!grid[r]) grid[r] = new Array<string>(maxCols).fill(" ");
      while (grid[r]!.length <= c) grid[r]!.push(" ");
      grid[r]![c] = ch;
    }

    return grid.map((row: string[]) => row.join("").trimEnd()).join("\n");
  }

  it("TWO_ADJACENT fixture scans as 2 rects with junction chars", () => {
    const result = scan(TWO_ADJACENT);
    expect(result.rects.length).toBe(2);
    expect(TWO_ADJACENT).toContain("┬");
    expect(TWO_ADJACENT).toContain("┴");
  });

  it("drag left rect down by 1: otherComposite restores right rect TL at row 0", () => {
    const scanResult = scan(TWO_ADJACENT);
    const allLayers = buildLayersFromScan(scanResult);
    const rectLayers = allLayers.filter(l => l.type === "rect");
    expect(rectLayers.length).toBe(2);

    const leftRect = rectLayers.reduce((a, b) => (a.bbox.col < b.bbox.col ? a : b));
    const rightRect = rectLayers.find(l => l.id !== leftRect.id)!;
    const sharedCol = rightRect.bbox.col;

    // What character does the right rect's layer have at its TL corner?
    const rightRectTL = rightRect.cells.get(`0,${sharedCol}`);
    expect(rightRectTL).toBeDefined();
    expect(rightRectTL).not.toBe(" ");

    const cloned = allLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    const result = applyDragFixed2(TWO_ADJACENT, cloned, leftRect.id, 1, 0);

    const resultRow0 = [...(result.split("\n")[0] ?? "")];
    expect(resultRow0[sharedCol]).toBe(rightRectTL);
  });

  it("drag left rect down by 1: KNOWN BUG — new cells at row 1 overwrite right rect left border", () => {
    const scanResult = scan(TWO_ADJACENT);
    const allLayers = buildLayersFromScan(scanResult);
    const rectLayers = allLayers.filter(l => l.type === "rect");
    const leftRect = rectLayers.reduce((a, b) => (a.bbox.col < b.bbox.col ? a : b));
    const rightRect = rectLayers.find(l => l.id !== leftRect.id)!;

    const cloned = allLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    const result = applyDragFixed2(TWO_ADJACENT, cloned, leftRect.id, 1, 0);
    const rescan = scan(result);

    // BUG: left rect's new cells overwrite right rect's left border at row 1
    const rightRectAfter = rescan.rects.find(r => r.col === rightRect.bbox.col);
    // Document current (buggy) behavior
    expect(rightRectAfter).toBeUndefined();
  });

  it("drag left rect right by 1: right rect boundary chars preserved", () => {
    const scanResult = scan(TWO_ADJACENT);
    const allLayers = buildLayersFromScan(scanResult);
    const rectLayers = allLayers.filter(l => l.type === "rect");
    const leftRect = rectLayers.reduce((a, b) => (a.bbox.col < b.bbox.col ? a : b));

    const cloned = allLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDragFixed2(TWO_ADJACENT, cloned, leftRect.id, 0, 1);

    // The result should still contain box-drawing characters
    const boxCount = [...result].filter(c => "┌┐└┘├┤┬┴┼─│".includes(c)).length;
    expect(boxCount).toBeGreaterThan(0);

    // Right rect should still scan correctly
    const rescan = scan(result);
    expect(rescan.rects.length).toBeGreaterThan(0);
  });

  it("buggy erase: dragging left rect down loses shared junction chars", () => {
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
      const maxCols = Math.max(...textLines.map((l: string) => [...l].length), 0);
      const grid: string[][] = textLines.map((l: string) => {
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
          grid[r]![c] = " ";
        }
      }

      for (const [k, ch] of layer.cells) {
        const ci = k.indexOf(",");
        const r = Number(k.slice(0, ci));
        const c = Number(k.slice(ci + 1));
        while (grid.length <= r) grid.push(new Array<string>(maxCols).fill(" "));
        if (!grid[r]) grid[r] = new Array<string>(maxCols).fill(" ");
        while (grid[r]!.length <= c) grid[r]!.push(" ");
        grid[r]![c] = ch;
      }

      return grid.map((row: string[]) => row.join("").trimEnd()).join("\n");
    }

    const scanResult = scan(TWO_ADJACENT);
    const allLayers = buildLayersFromScan(scanResult);
    const rectLayers = allLayers.filter(l => l.type === "rect");
    const leftRect = rectLayers.reduce((a, b) => (a.bbox.col < b.bbox.col ? a : b));

    const origJunctions = [...TWO_ADJACENT].filter(c => "┬┴".includes(c)).length;
    expect(origJunctions).toBe(2); // one ┬ and one ┴

    const cloned = allLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    const buggyResult = applyDragBuggy2(TWO_ADJACENT, cloned, leftRect.id, 1, 0);
    const buggyJunctions = [...buggyResult].filter(c => "┬┴".includes(c)).length;

    const cloned2 = allLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    const fixedResult = applyDragFixed2(TWO_ADJACENT, cloned2, leftRect.id, 1, 0);
    const fixedJunctions = [...fixedResult].filter(c => "┬┴".includes(c)).length;

    expect(fixedJunctions).toBeGreaterThanOrEqual(buggyJunctions);
  });
});

// ── 10. Text label preservation during drag ───────────────

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
    const maxCols = Math.max(...textLines.map((l: string) => [...l].length), 0);
    const grid: string[][] = textLines.map((l: string) => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

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
      while (grid.length <= r) grid.push(new Array<string>(maxCols).fill(" "));
      if (!grid[r]) grid[r] = new Array<string>(maxCols).fill(" ");
      while (grid[r]!.length <= c) grid[r]!.push(" ");
      grid[r]![c] = ch;
    }

    return grid.map((row: string[]) => row.join("").trimEnd()).join("\n");
  }

  it("LOGIN_FORM fixture scans as a rect with text labels inside", () => {
    const result = scan(LOGIN_FORM);
    expect(result.rects.length).toBe(1);
    // Text labels are scanned as separate text layers inside the rect
    expect(result.texts.length).toBeGreaterThan(0);
    const allText = result.texts.map((t: { content: string }) => t.content).join(" ");
    // The scanner may trim whitespace from text content
    expect(allText).toMatch(/Login Form|Login/);
    expect(allText).toMatch(/\[Username\]|\[Password\]|\[Submit\]/);
  });

  it("LOGIN_FORM: text layers are separate from the rect layer", () => {
    const scanResult = scan(LOGIN_FORM);
    const wfLayers = buildLayersFromScan(scanResult);
    const textLayers = wfLayers.filter(l => l.type === "text");
    const rectLayer = wfLayers.find(l => l.type === "rect")!;

    expect(textLayers.length).toBeGreaterThan(0);
    for (const tl of textLayers) {
      expect(tl.bbox.row).toBeGreaterThan(rectLayer.bbox.row);
      expect(tl.bbox.row).toBeLessThan(rectLayer.bbox.row + rectLayer.bbox.h);
    }
  });

  it("KNOWN BUG: drag rect down by 1 overwrites text at row 1 (new border = old text row)", () => {
    const scanResult = scan(LOGIN_FORM);
    const wfLayers = buildLayersFromScan(scanResult);
    const rectLayer = wfLayers.find(l => l.type === "rect")!;
    const cloned = wfLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDragWithLabels(LOGIN_FORM, cloned, rectLayer.id, 1, 0);

    // BUG: "Login Form" at row 1 is overwritten by the new ┌─────────────┐ at row 1
    const loginFormSurvived = result.includes("Login Form");
    expect(loginFormSurvived).toBe(false);

    expect(result).toContain("[Username]");
    expect(result).toContain("[Password]");
    expect(result).toContain("[Submit]");
  });

  it("drag rect right by 2: text labels survive because cols don't overlap with new border", () => {
    const scanResult = scan(LOGIN_FORM);
    const wfLayers = buildLayersFromScan(scanResult);
    const rectLayer = wfLayers.find(l => l.type === "rect")!;
    const cloned = wfLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDragWithLabels(LOGIN_FORM, cloned, rectLayer.id, 0, 2);

    expect(result).toContain("[Username]");
    expect(result).toContain("[Password]");
    expect(result).toContain("[Submit]");
  });

  it("text layers do NOT move when only the rect layer is dragged", () => {
    const scanResult = scan(LOGIN_FORM);
    const wfLayers = buildLayersFromScan(scanResult);
    const textLayers = wfLayers.filter(l => l.type === "text");
    expect(textLayers.length).toBeGreaterThan(0);

    const origTextRows = textLayers.map(l => ({ id: l.id, row: l.bbox.row }));

    const rectLayer = wfLayers.find(l => l.type === "rect")!;
    const cloned = wfLayers.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));
    applyDragWithLabels(LOGIN_FORM, cloned, rectLayer.id, 2, 0);

    for (const orig of origTextRows) {
      const clonedTl = cloned.find(l => l.id === orig.id);
      expect(clonedTl?.bbox.row).toBe(orig.row);
    }
  });
});

// ── 11. Prose cursor editing ──────────────────────────────

describe("prose cursor editing", () => {
  it("insertChar inserts a character at the given position", () => {
    const text = "Hello\nWorld";
    const { text: newText } = insertChar(text, { row: 0, col: 5 }, "X");
    expect(newText).toBe("HelloX\nWorld");
  });

  it("deleteChar removes a character at the given position", () => {
    const text = "Hello\nWorld";
    const { text: newText } = deleteChar(text, { row: 0, col: 5 });
    expect(newText).toBe("Hell\nWorld");
  });

  it("cursor arrow navigation stays within source line bounds", () => {
    const text = "Hello\nWorld\nFoo";
    const lines = text.split("\n");

    // ArrowRight at end of line doesn't exceed line length
    const lastCol = lines[0]!.length; // 5
    const clampedRight = Math.min(lastCol + 1, lines[0]!.length);
    expect(clampedRight).toBe(lines[0]!.length);

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
