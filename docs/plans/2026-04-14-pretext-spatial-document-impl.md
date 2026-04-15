# Pretext Spatial Document — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the monolithic Konva canvas with a Pretext-powered spatial document where prose text and interactive wireframe canvases coexist on a single HTML5 Canvas, with live reflow at 60fps.

**Architecture:** A new `detectRegions()` function splits scanner output into alternating prose/wireframe regions. A single `<SpatialCanvas>` component renders everything on one `<canvas>`: Pretext lays out prose text, the existing glyph atlas draws wireframe characters, and direct canvas event handlers replace the 2,000+ React `InteractiveShape` components. Text editing uses a minimal cursor drawn on canvas.

**Tech Stack:** TypeScript, React 19, @chenglou/pretext, Zustand, Vitest, HTML5 Canvas (no Konva, no react-konva)

---

### Verified Facts

- `src/scanner.ts:549` — `scan(text: string): ScanResult` returns `{ rects: ScannedRect[], lines: ScannedLine[], texts: ScannedText[], unclaimedCells: Map<string, string>, grid: string[][] }`.
- `src/scanner.ts:447` — `proposalsFromScan(result: ScanResult): ProposedLayer[]` converts scan output to diff proposals.
- `src/scanner.ts:283` — `detectTexts()` creates one `ScannedText` per whitespace-separated word run. A 367-line plan file produces ~2,047 text layers — the root cause of slowness.
- `src/layers.ts:265` — `compositeLayers(layers: Layer[]): Map<string, string>` composites via DFS over parent/child tree.
- `src/layers.ts:370` — `layerToText(layers: Layer[]): string` uses `_lastComposite ?? compositeLayers(layers)`, trims per row.
- `src/grid.ts:5-8` — `FONT_SIZE = 16`, `FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'`, `BG_COLOR = "#1a1a1a"`, `FG_COLOR = "#e0e0e0"`.
- `src/grid.ts:29` — `buildGlyphAtlas(charWidth, charHeight): GlyphAtlas` pre-renders 223 chars (95 ASCII + 128 box-drawing) into an offscreen canvas.
- `src/grid.ts:100` — `pixelToCell(px, py): { row, col }` converts pixel coords to grid cell.
- `src/store.ts:120` — `loadFromText(text)` calls `scan → proposalsFromScan → diffLayers → set({ layers })`.
- `src/store.ts:316` — `toText()` returns `layerToText(get().layers)`.
- `src/App.tsx:4` — imports `KonvaCanvas` from `"./KonvaCanvas"`. Line 155 renders `<KonvaCanvas />`.
- `src/App.tsx:29-55` — autosave subscribes to `layers` changes, debounces 500ms, writes `toText()` to file handle.
- `src/useToolHandlers.tsx:2` — imports `Rect as KonvaRect, Line as KonvaLine` from `react-konva` for preview rendering. Returns `{ onMouseDown, onMouseMove, onMouseUp, previewNode: ReactNode }`.
- `src/KonvaCanvas.tsx:45` — `buildSparseRows(composite): SparseRow[]` groups composite cells by row for efficient drawing. Reusable.
- `src/types.ts` — exports `type Bbox = { row: number; col: number; w: number; h: number }`.
- `@chenglou/pretext@0.0.5` — `prepareWithSegments(text, font, options?)` → `PreparedTextWithSegments`; `layoutWithLines(prepared, maxWidth, lineHeight)` → `{ lines: LayoutLine[], height, lineCount }` where `LayoutLine = { text, width, start, end }`.
- `package.json` — current deps include `konva@^10.2.5`, `react-konva@^19.2.3`.

---

### Task 1: Region detection from scan results

**Files:**
- Create: `src/regions.ts`
- Create: `src/regions.test.ts`

**Step 1: Write the failing test**

Add to `src/regions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectRegions, type Region } from "./regions";
import { scan } from "./scanner";

describe("detectRegions", () => {
  it("pure prose file → single prose region", () => {
    const text = "Hello world\nThis is prose\nMore text";
    const result = scan(text);
    const regions = detectRegions(result);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("prose");
    expect(regions[0].text).toBe(text);
  });

  it("pure wireframe → single wireframe region", () => {
    const text = "┌──┐\n│  │\n└──┘";
    const result = scan(text);
    const regions = detectRegions(result);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("wireframe");
    expect(regions[0].startRow).toBe(0);
    expect(regions[0].endRow).toBe(2);
  });

  it("prose then wireframe then prose → three regions", () => {
    const text = [
      "# Title",
      "Some description",
      "",
      "┌──────┐",
      "│ Box  │",
      "└──────┘",
      "",
      "More prose below",
    ].join("\n");
    const result = scan(text);
    const regions = detectRegions(result);
    expect(regions).toHaveLength(3);
    expect(regions[0].type).toBe("prose");
    expect(regions[1].type).toBe("wireframe");
    expect(regions[2].type).toBe("prose");
    // wireframe region includes the box rows
    expect(regions[1].startRow).toBe(3);
    expect(regions[1].endRow).toBe(5);
  });

  it("adjacent wireframes within 2 rows merge into one region", () => {
    const text = [
      "┌──┐",
      "└──┘",
      "",
      "┌──┐",
      "└──┘",
    ].join("\n");
    const result = scan(text);
    const regions = detectRegions(result);
    // Gap of 1 empty row → should merge
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("wireframe");
  });

  it("empty input → empty regions", () => {
    const result = scan("");
    const regions = detectRegions(result);
    expect(regions).toHaveLength(0);
  });

  it("wireframe region carries layers from buildLayersFromScan", () => {
    const text = "┌──┐\n│  │\n└──┘";
    const result = scan(text);
    const regions = detectRegions(result);
    expect(regions[0].type).toBe("wireframe");
    expect(regions[0].layers).toBeDefined();
    expect(regions[0].layers!.length).toBeGreaterThan(0);
  });

  it("prose regions carry their original text slice", () => {
    const text = "Line one\nLine two\n\n┌─┐\n└─┘\n\nLine six";
    const result = scan(text);
    const regions = detectRegions(result);
    expect(regions[0].type).toBe("prose");
    expect(regions[0].text).toBe("Line one\nLine two");
    expect(regions[2].type).toBe("prose");
    expect(regions[2].text).toBe("Line six");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/regions.test.ts`
Expected: FAIL — `detectRegions` not found / module doesn't exist

**Step 3: Write minimal implementation**

Create `src/regions.ts`:

```typescript
import type { ScanResult } from "./scanner";
import { buildLayersFromScan } from "./layers";
import type { Layer } from "./layers";

export interface Region {
  type: "prose" | "wireframe";
  startRow: number;
  endRow: number;
  /** For prose regions: the original text lines joined with \n */
  text: string;
  /** For wireframe regions: layers built from the scan shapes in this region */
  layers?: Layer[];
}

/**
 * Split a scan result into alternating prose/wireframe regions.
 *
 * Algorithm:
 * 1. Collect all rows touched by rects and lines into a Set.
 * 2. Expand each shape's row range by a 1-row margin (to absorb labels/gaps).
 * 3. Merge overlapping/adjacent (within 2 rows) shape rows into contiguous
 *    wireframe row ranges.
 * 4. Everything outside wireframe ranges is prose.
 * 5. Wireframe regions get layers built from shapes whose bbox overlaps the range.
 */
export function detectRegions(scanResult: ScanResult): Region[] {
  const { rects, lines, grid } = scanResult;
  if (grid.length === 0) return [];

  // Collect row ranges from shapes
  const shapeRanges: { start: number; end: number }[] = [];

  for (const r of rects) {
    shapeRanges.push({
      start: Math.max(0, r.row - 1),
      end: Math.min(grid.length - 1, r.row + r.h), // 1 row below
    });
  }

  for (const l of lines) {
    const minR = Math.min(l.r1, l.r2);
    const maxR = Math.max(l.r1, l.r2);
    // Only count lines that are at least 3 chars and use box-drawing
    const isBoxLine = grid[minR]?.some(ch =>
      ch === "─" || ch === "│" || ch === "━" || ch === "║" ||
      ch === "├" || ch === "┤" || ch === "┬" || ch === "┴" || ch === "┼"
    );
    if (!isBoxLine) continue;
    shapeRanges.push({
      start: Math.max(0, minR - 1),
      end: Math.min(grid.length - 1, maxR + 1),
    });
  }

  if (shapeRanges.length === 0) {
    // Pure prose
    const text = grid.map(row => row.join("")).join("\n").replace(/\s+$/, "");
    if (text.length === 0) return [];
    return [{ type: "prose", startRow: 0, endRow: grid.length - 1, text }];
  }

  // Sort by start row and merge overlapping/close ranges (gap ≤ 2)
  shapeRanges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [shapeRanges[0]];
  for (let i = 1; i < shapeRanges.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = shapeRanges[i];
    if (cur.start <= prev.end + 2) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }

  // Build regions by walking rows
  const regions: Region[] = [];
  let currentRow = 0;

  for (const wf of merged) {
    // Prose before this wireframe
    if (currentRow < wf.start) {
      const proseText = gridSliceToText(grid, currentRow, wf.start - 1);
      if (proseText.length > 0) {
        regions.push({
          type: "prose",
          startRow: currentRow,
          endRow: wf.start - 1,
          text: proseText,
        });
      }
    }

    // Wireframe region — build layers from shapes in this range
    const regionLayers = buildLayersForRegion(scanResult, wf.start, wf.end);
    regions.push({
      type: "wireframe",
      startRow: wf.start,
      endRow: wf.end,
      text: gridSliceToText(grid, wf.start, wf.end),
      layers: regionLayers,
    });

    currentRow = wf.end + 1;
  }

  // Trailing prose
  if (currentRow < grid.length) {
    const proseText = gridSliceToText(grid, currentRow, grid.length - 1);
    if (proseText.length > 0) {
      regions.push({
        type: "prose",
        startRow: currentRow,
        endRow: grid.length - 1,
        text: proseText,
      });
    }
  }

  return regions;
}

function gridSliceToText(grid: string[][], startRow: number, endRow: number): string {
  const lines: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    lines.push((grid[r] ?? []).join("").trimEnd());
  }
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // Trim leading empty lines and adjust? No — preserve offset.
  return lines.join("\n");
}

/**
 * Build layers for shapes whose bbox overlaps [startRow, endRow].
 * Uses the full buildLayersFromScan then filters to overlapping shapes,
 * adjusting bbox row to be relative to startRow.
 */
function buildLayersForRegion(
  scanResult: ScanResult,
  startRow: number,
  endRow: number,
): Layer[] {
  const layers = buildLayersFromScan(scanResult);
  return layers.filter(l => {
    const layerStart = l.bbox.row;
    const layerEnd = l.bbox.row + l.bbox.h - 1;
    return layerEnd >= startRow && layerStart <= endRow;
  }).map(l => ({
    ...l,
    // Adjust bbox to be relative to the region's top row
    bbox: {
      ...l.bbox,
      row: l.bbox.row - startRow,
    },
    // Adjust cell keys to be relative to the region's top row
    cells: adjustCellRows(l.cells, -startRow),
  }));
}

function adjustCellRows(
  cells: Map<string, string>,
  deltaRow: number,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, ch] of cells) {
    const i = key.indexOf(",");
    const r = Number(key.slice(0, i)) + deltaRow;
    const c = key.slice(i + 1);
    result.set(`${r},${c}`, ch);
  }
  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/regions.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/regions.ts src/regions.test.ts
git commit -m "feat: region detection — split scan results into prose/wireframe regions"
```

---

### Task 2: Install Pretext, scaffold SpatialCanvas with prose rendering

**Files:**
- Modify: `package.json` (add `@chenglou/pretext`)
- Create: `src/SpatialCanvas.tsx`
- Modify: `src/App.tsx:4,155` (swap KonvaCanvas for SpatialCanvas)

**Step 1: Install Pretext**

Run: `npm install @chenglou/pretext`

**Step 2: Write the failing test**

Create `src/SpatialCanvas.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderProseRegion } from "./SpatialCanvas";

// Mock canvas context for jsdom
function mockCtx() {
  return {
    font: "",
    fillStyle: "",
    textBaseline: "",
    fillText: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 10 }),
    save: vi.fn(),
    restore: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe("renderProseRegion", () => {
  it("draws text lines at correct y positions", () => {
    const ctx = mockCtx();
    const lines = [
      { text: "Hello world", width: 110, start: { segmentIndex: 0, graphemeIndex: 0 }, end: { segmentIndex: 0, graphemeIndex: 11 } },
      { text: "Second line", width: 110, start: { segmentIndex: 0, graphemeIndex: 12 }, end: { segmentIndex: 0, graphemeIndex: 23 } },
    ];
    renderProseRegion(ctx, lines, 0, 20, 0);
    expect(ctx.fillText).toHaveBeenCalledTimes(2);
    expect(ctx.fillText).toHaveBeenCalledWith("Hello world", 0, 0);
    expect(ctx.fillText).toHaveBeenCalledWith("Second line", 0, 20);
  });

  it("applies scrollY offset", () => {
    const ctx = mockCtx();
    const lines = [
      { text: "Line 1", width: 60, start: { segmentIndex: 0, graphemeIndex: 0 }, end: { segmentIndex: 0, graphemeIndex: 6 } },
    ];
    renderProseRegion(ctx, lines, 0, 20, 50);
    expect(ctx.fillText).toHaveBeenCalledWith("Line 1", 0, -50);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/SpatialCanvas.test.ts`
Expected: FAIL — module doesn't exist

**Step 4: Write minimal implementation**

Create `src/SpatialCanvas.tsx`:

```typescript
import { useEffect, useRef, useState, useMemo } from "react";
import { prepareWithSegments, layoutWithLines, type LayoutLine } from "@chenglou/pretext";
import { useEditorStore } from "./store";
import { scan } from "./scanner";
import { detectRegions, type Region } from "./regions";
import { compositeLayers } from "./layers";
import { buildSparseRows, type SparseRow } from "./KonvaCanvas";
import {
  FONT_SIZE, FONT_FAMILY, BG_COLOR, FG_COLOR,
  measureCellSize, getCharWidth, getCharHeight,
  getGlyphAtlas,
} from "./grid";

const PROSE_FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const LINE_HEIGHT = Math.ceil(FONT_SIZE * 1.15);

/** Laid-out region ready for rendering */
interface RenderedRegion {
  region: Region;
  y: number;       // pixel y offset of this region in the document
  height: number;  // pixel height of this region
  // Prose-specific
  lines?: LayoutLine[];
  // Wireframe-specific
  sparseRows?: SparseRow[];
}

export function renderProseRegion(
  ctx: CanvasRenderingContext2D,
  lines: LayoutLine[],
  regionY: number,
  lineHeight: number,
  scrollY: number,
): void {
  ctx.font = PROSE_FONT;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i].text, 0, regionY + i * lineHeight - scrollY);
  }
}

function renderWireframeRegion(
  ctx: CanvasRenderingContext2D,
  sparseRows: SparseRow[],
  regionY: number,
  charWidth: number,
  charHeight: number,
  scrollY: number,
): void {
  const atlas = getGlyphAtlas();
  if (!atlas) {
    ctx.font = PROSE_FONT;
    ctx.fillStyle = FG_COLOR;
    ctx.textBaseline = "top";
    for (const { row, startCol, text } of sparseRows) {
      ctx.fillText(text, startCol * charWidth, regionY + row * charHeight - scrollY);
    }
    return;
  }
  for (const { row, startCol, text } of sparseRows) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === " ") continue;
      const glyph = atlas.glyphs.get(ch);
      if (!glyph) {
        ctx.font = PROSE_FONT;
        ctx.fillStyle = FG_COLOR;
        ctx.textBaseline = "top";
        ctx.fillText(ch, (startCol + i) * charWidth, regionY + row * charHeight - scrollY);
        continue;
      }
      ctx.drawImage(
        atlas.canvas,
        glyph.sx, glyph.sy, atlas.cellWidth, atlas.cellHeight,
        (startCol + i) * charWidth, regionY + row * charHeight - scrollY,
        charWidth, charHeight,
      );
    }
  }
}

export function SpatialCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const layers = useEditorStore((s) => s.layers);

  useEffect(() => {
    measureCellSize().then(() => setReady(true));
  }, []);

  const charWidth = ready ? getCharWidth() : 0;
  const charHeight = ready ? getCharHeight() : 0;

  // Detect regions from current text
  const regions = useMemo(() => {
    const text = useEditorStore.getState().toText();
    if (!text) return [];
    const scanResult = scan(text);
    return detectRegions(scanResult);
  }, [layers]);

  // Lay out each region
  const renderedRegions = useMemo(() => {
    if (!ready || charWidth === 0) return [];
    const canvas = canvasRef.current;
    if (!canvas) return [];
    const maxWidth = canvas.width;

    let y = 0;
    const result: RenderedRegion[] = [];

    for (const region of regions) {
      if (region.type === "prose") {
        const prepared = prepareWithSegments(region.text, PROSE_FONT);
        const layout = layoutWithLines(prepared, maxWidth, LINE_HEIGHT);
        result.push({
          region,
          y,
          height: layout.height,
          lines: layout.lines,
        });
        y += layout.height;
      } else {
        // Wireframe region — composite layers and build sparse rows
        const composite = compositeLayers(region.layers ?? []);
        const sparse = buildSparseRows(composite);
        const regionRows = region.endRow - region.startRow + 1;
        const height = regionRows * charHeight;
        result.push({
          region,
          y,
          height,
          sparseRows: sparse,
        });
        y += height;
      }
    }
    return result;
  }, [regions, ready, charWidth, charHeight]);

  // Total document height
  const totalHeight = renderedRegions.reduce((sum, r) => sum + r.height, 0);

  // Render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const rr of renderedRegions) {
      if (rr.region.type === "prose" && rr.lines) {
        renderProseRegion(ctx, rr.lines, rr.y, LINE_HEIGHT, scrollY);
      } else if (rr.sparseRows) {
        renderWireframeRegion(ctx, rr.sparseRows, rr.y, charWidth, charHeight, scrollY);
      }
    }
  }, [renderedRegions, scrollY, ready, charWidth, charHeight]);

  // Handle scroll
  const handleWheel = (e: React.WheelEvent) => {
    setScrollY(prev => Math.max(0, Math.min(totalHeight - 400, prev + e.deltaY)));
  };

  if (!ready) {
    return <div style={{ background: BG_COLOR, width: "100%", height: "100%" }} />;
  }

  return (
    <canvas
      ref={canvasRef}
      width={800}
      height={600}
      style={{ background: BG_COLOR, cursor: "text" }}
      tabIndex={0}
      role="application"
      aria-label="Spatial document canvas"
      onWheel={handleWheel}
    />
  );
}
```

**Step 5: Wire into App.tsx**

Modify `src/App.tsx:4` — change:
```typescript
import { KonvaCanvas } from "./KonvaCanvas";
```
to:
```typescript
import { SpatialCanvas } from "./SpatialCanvas";
```

Modify `src/App.tsx:155` — change:
```typescript
<KonvaCanvas />
```
to:
```typescript
<SpatialCanvas />
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run src/SpatialCanvas.test.ts`
Then: `npx vitest run && npm run build`
Expected: All pass, build succeeds

**Step 7: Commit**

```bash
git add package.json package-lock.json src/SpatialCanvas.tsx src/SpatialCanvas.test.ts src/App.tsx
git commit -m "feat: SpatialCanvas with Pretext prose rendering + wireframe glyph atlas"
```

---

### Task 3: Canvas interaction — click to select wireframe shapes

**Files:**
- Create: `src/canvasHitTest.ts`
- Create: `src/canvasHitTest.test.ts`
- Modify: `src/SpatialCanvas.tsx` (add click handler)

**Step 1: Write the failing test**

Create `src/canvasHitTest.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { hitTestWireframe } from "./canvasHitTest";
import type { Layer } from "./layers";

function makeLayer(id: string, row: number, col: number, w: number, h: number): Layer {
  return {
    id, type: "rect", z: 1, visible: true,
    bbox: { row, col, w, h },
    cells: new Map(),
    parentId: null,
  };
}

describe("hitTestWireframe", () => {
  it("returns layer id when click is inside bbox", () => {
    const layers = [makeLayer("r1", 2, 3, 10, 5)];
    // Click at grid cell (4, 7) — inside the rect
    expect(hitTestWireframe(layers, 4, 7)).toBe("r1");
  });

  it("returns null when click is outside all bboxes", () => {
    const layers = [makeLayer("r1", 2, 3, 10, 5)];
    expect(hitTestWireframe(layers, 0, 0)).toBeNull();
  });

  it("returns topmost (highest z) layer when overlapping", () => {
    const layers = [
      { ...makeLayer("r1", 0, 0, 10, 10), z: 1 },
      { ...makeLayer("r2", 0, 0, 10, 10), z: 5 },
    ];
    expect(hitTestWireframe(layers, 5, 5)).toBe("r2");
  });

  it("only tests non-base non-group layers", () => {
    const layers = [
      { ...makeLayer("base", 0, 0, 100, 100), type: "base" as const },
      makeLayer("r1", 2, 3, 10, 5),
    ];
    expect(hitTestWireframe(layers, 50, 50)).toBeNull();
    expect(hitTestWireframe(layers, 4, 7)).toBe("r1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/canvasHitTest.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Write minimal implementation**

Create `src/canvasHitTest.ts`:

```typescript
import type { Layer } from "./layers";

/**
 * Hit-test a click at (gridRow, gridCol) against wireframe layers.
 * Returns the id of the topmost (highest z) matching layer, or null.
 * Skips base and group layers.
 */
export function hitTestWireframe(
  layers: Layer[],
  gridRow: number,
  gridCol: number,
): string | null {
  let bestId: string | null = null;
  let bestZ = -Infinity;

  for (const l of layers) {
    if (l.type === "base" || l.type === "group") continue;
    if (!l.visible) continue;
    const { row, col, w, h } = l.bbox;
    if (gridRow >= row && gridRow < row + h && gridCol >= col && gridCol < col + w) {
      if (l.z > bestZ) {
        bestZ = l.z;
        bestId = l.id;
      }
    }
  }

  return bestId;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/canvasHitTest.test.ts`
Expected: All pass

**Step 5: Add click handler to SpatialCanvas**

Add to `src/SpatialCanvas.tsx` — in the `SpatialCanvas` component, add a click handler that:
1. Converts pixel (x, y) to document coords (add scrollY)
2. Finds which region the click is in
3. If wireframe region: convert to grid coords relative to region, call `hitTestWireframe`, call `selectLayer`
4. If prose region: (no-op for now, text cursor comes in Task 5)

Add to the `<canvas>` element:
```typescript
onClick={(e) => {
  const rect = canvasRef.current!.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top + scrollY;

  // Find which region
  for (const rr of renderedRegions) {
    if (py >= rr.y && py < rr.y + rr.height) {
      if (rr.region.type === "wireframe" && rr.region.layers) {
        const localY = py - rr.y;
        const gridRow = Math.floor(localY / charHeight);
        const gridCol = Math.floor(px / charWidth);
        const hit = hitTestWireframe(rr.region.layers, gridRow, gridCol);
        useEditorStore.getState().selectLayer(hit);
      } else {
        useEditorStore.getState().selectLayer(null);
      }
      return;
    }
  }
  useEditorStore.getState().selectLayer(null);
}}
```

**Step 6: Add selection highlight to wireframe rendering**

In `renderWireframeRegion`, add an optional `selectedId` parameter. After drawing the wireframe, if a layer is selected, draw a blue stroke rect around its bbox:

```typescript
// After all glyph rendering:
if (selectedId) {
  for (const l of layers) {
    if (l.id === selectedId) {
      ctx.strokeStyle = "#4a90e2";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        l.bbox.col * charWidth,
        regionY + l.bbox.row * charHeight - scrollY,
        l.bbox.w * charWidth,
        l.bbox.h * charHeight,
      );
    }
  }
}
```

**Step 7: Run full suite**

Run: `npx vitest run && npm run build`
Expected: All pass

**Step 8: Commit**

```bash
git add src/canvasHitTest.ts src/canvasHitTest.test.ts src/SpatialCanvas.tsx
git commit -m "feat: canvas hit testing — click to select wireframe shapes"
```

---

### Task 4: Wireframe drag to move

**Files:**
- Modify: `src/SpatialCanvas.tsx` (add mousedown/mousemove/mouseup handlers)
- Modify: `src/store.ts` (reuse existing `moveLayerCommit`)

**Step 1: No new test file** — drag behavior is integration-level (canvas events → store mutations). The existing `moveLayer`/`moveLayerCommit` tests in the store cover the mutation logic. This task wires canvas events to those existing store methods.

**Step 2: Implementation**

Add drag state to `SpatialCanvas`:

```typescript
const dragRef = useRef<{
  layerId: string;
  regionIndex: number;
  startBbox: Bbox;
  startPixel: { x: number; y: number };
} | null>(null);
```

On `mousedown` in a wireframe region:
1. Hit-test to find the layer
2. If found and selected, start drag: record `startBbox`, `startPixel`

On `mousemove` while dragging:
1. Compute delta in grid cells: `deltaRow = Math.round((currentY - startPixel.y) / charHeight)`, same for col
2. Call `useEditorStore.getState().moveLayerLive(layerId, newBbox)` for visual feedback

On `mouseup`:
1. Compute final grid delta
2. Call `useEditorStore.getState().moveLayerCommit(layerId, newBbox)`
3. Clear `dragRef`

Escape cancels: restore `startBbox` via `moveLayerCommit(layerId, startBbox)`.

**Step 3: Run full suite**

Run: `npx vitest run && npm run build`
Expected: All pass

**Step 4: Commit**

```bash
git add src/SpatialCanvas.tsx
git commit -m "feat: drag to move wireframe shapes on spatial canvas"
```

---

### Task 5: Prose text cursor and basic editing

**Files:**
- Create: `src/proseCursor.ts`
- Create: `src/proseCursor.test.ts`
- Modify: `src/SpatialCanvas.tsx` (add cursor rendering + keyboard handler)
- Modify: `src/store.ts` (add `regions` to state, `updateProseText` action)

**Step 1: Write the failing test**

Create `src/proseCursor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { insertChar, deleteChar, type CursorPos } from "./proseCursor";

describe("insertChar", () => {
  it("inserts at cursor position", () => {
    const result = insertChar("Hello world", { row: 0, col: 5 }, "!");
    expect(result.text).toBe("Hello! world");
    expect(result.cursor).toEqual({ row: 0, col: 6 });
  });

  it("inserts into middle of multiline text", () => {
    const result = insertChar("Line 1\nLine 2", { row: 1, col: 4 }, "!");
    expect(result.text).toBe("Line 1\nLine! 2");
    expect(result.cursor).toEqual({ row: 1, col: 5 });
  });

  it("handles newline insertion", () => {
    const result = insertChar("Hello world", { row: 0, col: 5 }, "\n");
    expect(result.text).toBe("Hello\n world");
    expect(result.cursor).toEqual({ row: 1, col: 0 });
  });
});

describe("deleteChar", () => {
  it("deletes char before cursor", () => {
    const result = deleteChar("Hello", { row: 0, col: 5 });
    expect(result.text).toBe("Hell");
    expect(result.cursor).toEqual({ row: 0, col: 4 });
  });

  it("merges lines on backspace at start of line", () => {
    const result = deleteChar("Line 1\nLine 2", { row: 1, col: 0 });
    expect(result.text).toBe("Line 1Line 2");
    expect(result.cursor).toEqual({ row: 0, col: 6 });
  });

  it("no-op at start of text", () => {
    const result = deleteChar("Hello", { row: 0, col: 0 });
    expect(result.text).toBe("Hello");
    expect(result.cursor).toEqual({ row: 0, col: 0 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/proseCursor.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Write minimal implementation**

Create `src/proseCursor.ts`:

```typescript
export interface CursorPos {
  row: number;
  col: number;
}

export function insertChar(
  text: string,
  cursor: CursorPos,
  ch: string,
): { text: string; cursor: CursorPos } {
  const lines = text.split("\n");
  const line = lines[cursor.row] ?? "";
  const before = line.slice(0, cursor.col);
  const after = line.slice(cursor.col);

  if (ch === "\n") {
    lines.splice(cursor.row, 1, before, after);
    return { text: lines.join("\n"), cursor: { row: cursor.row + 1, col: 0 } };
  }

  lines[cursor.row] = before + ch + after;
  return { text: lines.join("\n"), cursor: { row: cursor.row, col: cursor.col + 1 } };
}

export function deleteChar(
  text: string,
  cursor: CursorPos,
): { text: string; cursor: CursorPos } {
  if (cursor.row === 0 && cursor.col === 0) {
    return { text, cursor };
  }

  const lines = text.split("\n");

  if (cursor.col === 0) {
    // Merge with previous line
    const prevLine = lines[cursor.row - 1] ?? "";
    const curLine = lines[cursor.row] ?? "";
    const newCol = prevLine.length;
    lines.splice(cursor.row - 1, 2, prevLine + curLine);
    return { text: lines.join("\n"), cursor: { row: cursor.row - 1, col: newCol } };
  }

  const line = lines[cursor.row] ?? "";
  lines[cursor.row] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
  return { text: lines.join("\n"), cursor: { row: cursor.row, col: cursor.col - 1 } };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/proseCursor.test.ts`
Expected: All pass

**Step 5: Add cursor state + keyboard handling to SpatialCanvas**

Add to `SpatialCanvas.tsx`:
- Cursor state: `const [cursorPos, setCursorPos] = useState<CursorPos | null>(null)`
- `cursorRegionIndex` tracking which prose region has focus
- On click in prose region: compute cursor position from pixel coords using Pretext's line data (y → line index, x → character offset via monospace math `col = Math.floor(px / charWidth)`)
- On `keydown`: if cursor is active in a prose region, handle printable chars via `insertChar`, Backspace via `deleteChar`, Enter via `insertChar("\n")`, arrow keys for cursor movement
- Render cursor: draw a 1px wide rect at `(col * charWidth, regionY + row * lineHeight - scrollY)` with a 500ms blink interval

**Step 6: Add `updateProseText` to store**

Modify `src/store.ts` — add a new action that re-runs `loadFromText` with updated text. Since prose editing changes the underlying text, the store needs to re-scan and rebuild regions. However, for v1 simplicity, we can reconstruct the full text from regions, call `loadFromText`, and let the existing diff pipeline handle identity preservation.

**Step 7: Run full suite**

Run: `npx vitest run && npm run build`
Expected: All pass

**Step 8: Commit**

```bash
git add src/proseCursor.ts src/proseCursor.test.ts src/SpatialCanvas.tsx src/store.ts
git commit -m "feat: prose text cursor — click, type, backspace, enter in prose regions"
```

---

### Task 6: Autosave round-trip — stitch regions back to markdown

**Files:**
- Modify: `src/store.ts:316` (update `toText` to use regions)
- Modify: `src/App.tsx` (autosave already works via `toText`, just verify)

**Step 1: No new test file** — the existing `layerToText` tests cover wireframe serialization. Region stitching is: `proseRegions.text + wireframeRegions via layerToText`. The round-trip test is: open file → make edit → autosave → reload → verify same content.

**Step 2: Update `toText` in store**

The simplest approach: `toText()` walks regions in order. For prose regions, use the stored text. For wireframe regions, use `layerToText(region.layers)`. Join with `\n\n` between regions (preserving the original blank-line separators).

**Step 3: Manual verification**

1. `npm run dev`
2. Open a plan file with wireframes
3. Verify prose renders as text, wireframes render as shapes
4. Click a wireframe — blue selection highlight
5. Type in prose — characters appear
6. Check autosave writes correctly (reload file)

**Step 4: Run full suite**

Run: `npx vitest run && npm run build`
Expected: All pass

**Step 5: Commit**

```bash
git add src/store.ts
git commit -m "feat: autosave round-trip — stitch prose + wireframe regions to markdown"
```

---

### Final Verification

```bash
npx vitest run && npm run build
```

Expected: All tests pass, production build succeeds.

---

**Edge cases / risks:**
- Pretext's `prepareWithSegments` uses Canvas for measurement — jsdom tests need the same mock as `buildGlyphAtlas` tests (mock `document.createElement("canvas")` to return a fake context).
- Region detection uses a 1-row margin around wireframe shapes. A line of dashes `---` (markdown horizontal rule) uses the same chars as box-drawing `─` — the `isBoxLine` check should verify actual Unicode box-drawing chars, not ASCII dashes.
- Prose editing re-scans the full document via `loadFromText`. For large files, this could be slow. v1 accepts this; v2 could do incremental updates per-region.
- The `buildSparseRows` export from `KonvaCanvas.tsx` will need to be moved to a shared module if `KonvaCanvas.tsx` is eventually deleted. For now it stays.
- Text cursor blink needs a `setInterval` that cancels on blur/unmount.
- Arrow key navigation at region boundaries (moving from end of prose into a wireframe region) is not handled in v1. The cursor stays within its prose region.

**Dependency graph:**
```
Task 1 (Region detection)
  → Task 2 (SpatialCanvas + Pretext prose rendering)
  → Task 3 (Click to select wireframes)
  → Task 4 (Drag to move)
  → Task 5 (Prose text editing)
  → Task 6 (Autosave round-trip)
```

| File | Change |
|------|--------|
| `src/regions.ts` | **New.** `detectRegions(scanResult)` → `Region[]` |
| `src/regions.test.ts` | **New.** 7 tests for region splitting |
| `src/SpatialCanvas.tsx` | **New.** Single-canvas renderer: Pretext prose + glyph atlas wireframes + scroll + click + drag |
| `src/SpatialCanvas.test.ts` | **New.** Tests for `renderProseRegion` |
| `src/canvasHitTest.ts` | **New.** `hitTestWireframe(layers, row, col)` → layer id or null |
| `src/canvasHitTest.test.ts` | **New.** 4 tests for hit testing |
| `src/proseCursor.ts` | **New.** `insertChar`, `deleteChar` for prose editing |
| `src/proseCursor.test.ts` | **New.** 6 tests for text mutations |
| `src/App.tsx:4,155` | Swap `KonvaCanvas` import → `SpatialCanvas` |
| `src/store.ts:316` | Update `toText()` to stitch regions |
| `package.json` | Add `@chenglou/pretext` |

**What does NOT change:** `src/scanner.ts`, `src/layers.ts`, `src/diff.ts`, `src/identity.ts`, `src/grid.ts` (glyph atlas, cell measurement), `src/types.ts`, `src/LayerPanel.tsx`, `src/Toolbar.tsx`, `vitest.config.ts`. The wireframe detection, layer model, and diff pipeline are fully preserved.
