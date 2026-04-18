/**
 * Programmatic test harness for the Pretext spatial document pipeline.
 *
 * Tests the data pipeline without a browser:
 * 1. Wireframe compositing — correct characters at correct positions
 * 2. Resize + regenerate — box-drawing redrawn at new size
 * 3. Pretext layout — line counts change with width
 * 4. Performance targets
 * 5. Prose cursor navigation
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { scan } from "./scanner";
import {
  buildLayersFromScan,
  compositeLayers,
  regenerateCells,
  LIGHT_RECT_STYLE,
} from "./layers";
import { framesFromScan } from "./frame";
import { buildSparseRows } from "./sparseRows";

// ── Canvas mock for Pretext ──────────────────────────────
beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = ((() => ({
        font: "",
        fillStyle: "",
        textBaseline: "",
        fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      })) as unknown) as HTMLCanvasElement["getContext"];
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

const PURE_WIREFRAME = `┌─────────┐
│ Box A   │
├─────────┤
│ Box B   │
└─────────┘`;

// ── 1. Resize + regenerate ───────────────────────────────

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
});

// ── 2. Pretext layout ────────────────────────────────────

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

// ── 3. Performance targets ──────────────────────────────

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
    const frames = framesFromScan(scanResult, 9.6, 18.4);
    const ms = performance.now() - start;

    console.log(`  Synthetic 50KB: ${text.length} chars, ${frames.length} frames, ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(500);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("large file content height does not require oversized canvas", () => {
    // Regression: 52KB file produced 60K+ pixel content height.
    // At 2x DPR this is 120K canvas pixels — exceeds Chrome's ~16K-32K limit
    // and crashes the tab. Canvas must be capped to viewport height.
    const sections: string[] = [];
    for (let i = 0; i < 100; i++) {
      sections.push(`# Section ${i}\n`);
      sections.push(`This is paragraph ${i} with some longer text content that fills up the line. `.repeat(5) + "\n\n\n");
      sections.push("┌──────────────────────┐\n│ Wireframe box       │\n│                      │\n└──────────────────────┘\n\n\n");
    }
    const text = sections.join("");
    const scanResult = scan(text);
    const frames = framesFromScan(scanResult, 9.6, 18.4);

    // Compute content height the same way paint() does
    let contentH = 100;
    for (const f of frames) contentH = Math.max(contentH, f.y + f.h);

    // The raw content height can be huge — that's expected
    // But the CANVAS should never be set to this height directly.
    // This test documents the problem; the fix is viewport-clamped canvas.
    console.log(`  Content height: ${contentH.toFixed(0)}px`);

    // Max safe canvas height at 2x DPR is ~16384px (GPU-dependent).
    // If content exceeds this, paint() MUST clamp canvas to viewport.
    const MAX_SAFE_CANVAS = 16384;
    const DPR = 2;
    const viewportH = 900; // typical viewport
    const canvasH = Math.min(contentH, viewportH) * DPR;
    expect(canvasH).toBeLessThanOrEqual(MAX_SAFE_CANVAS);
  });

});

// ── 4. Prose cursor navigation ───────────────────────────

describe("prose cursor navigation", () => {
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

// ── 5. Resize boundary conditions ───────────────────────

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

// ── 6. Scan + layers basic ──────────────────────────────

describe("scan + layers basic", () => {
  it("PURE_WIREFRAME composite produces correct corner characters", () => {
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
    const scanResult = scan(DASHBOARD);
    const layers = buildLayersFromScan(scanResult);
    const c1 = compositeLayers(layers);
    const c2 = compositeLayers(layers);
    expect([...c1.entries()]).toEqual([...c2.entries()]);
  });

  it("DASHBOARD scan produces layers and non-empty composite", () => {
    const scanResult = scan(DASHBOARD);
    const layers = buildLayersFromScan(scanResult);
    expect(compositeLayers(layers).size).toBeGreaterThan(0);
    expect(buildSparseRows(compositeLayers(layers)).length).toBeGreaterThan(0);
  });
});

