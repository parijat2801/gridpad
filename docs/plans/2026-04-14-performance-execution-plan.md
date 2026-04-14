# Gridpad Performance Optimization — Execution Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate unnecessary sceneFunc re-executions and reduce per-execution cost — target <2ms render for typical edits.

**Architecture:** Split KonvaCanvas into TextLayer (owns composite + sceneFunc, re-renders only on layer changes) and InteractiveLayer (handles selection, tool previews, drag/resize). Cache the text Shape as a bitmap. Replace the full-grid loop with sparse-row rendering. Add a glyph atlas for fast character drawing. Share the composite with autosave.

**Tech Stack:** TypeScript, React 19, react-konva, Konva, Zustand, Vitest

---

### Verified Facts

- `src/KonvaCanvas.tsx:12` — single `KonvaCanvas` component subscribes to `layers`, `selectedId`, `activeTool`. Any change re-renders everything including sceneFunc.
- `src/KonvaCanvas.tsx:47` — `composite` is already memoized with `useMemo([layers])`.
- `src/KonvaCanvas.tsx:54-60` — grid bounds recomputed imperatively from `composite.keys()` every render (O(cells) string parsing).
- `src/KonvaCanvas.tsx:79-82` — `byId` Map and `visibleLayers` filter rebuilt every render.
- `src/KonvaCanvas.tsx:107-113` — sceneFunc iterates `effectiveRows × effectiveCols` (min 4,000 cells), calls `fillText` per row.
- `src/KonvaCanvas.tsx:117-209` — interactive Rects/Lines, Transformer, and preview all in same component.
- `src/KonvaCanvas.tsx:177` — `toolHandlers.previewNode` rendered inside interactive Layer.
- `src/useGestureAdapter.ts:93-107` — `onDragStart(layerId, node, charWidth, charHeight)` signature (not curried).
- `src/KonvaCanvas.tsx:186-207` — `boundBoxFunc` has stable-edge snapping logic (rightStable/bottomStable). Must preserve exactly.
- `src/layers.ts:318-345` — `layerToText` calls `compositeLayers` internally, uses `.trimEnd()` per row.
- `src/grid.ts:20-40` — `measureCellSize` awaits `document.fonts.ready`, measures with a sample string. Returns `{ charWidth, charHeight }`.

---

### Task 1: Split KonvaCanvas + memoize derived values

**Files:**
- Modify: `src/KonvaCanvas.tsx` (full rewrite)
- Modify: `src/layers.ts:318` (add shared composite helpers)
- Test: `src/layers.test.ts` (add composite cache tests)

**Step 1: Write the failing test**

Add to `src/layers.test.ts`:

```typescript
import {
  // ... existing imports ...
  setLastComposite,
  getLastComposite,
} from "./layers";

describe("shared composite cache", () => {
  it("stores and retrieves composite", () => {
    const composite = new Map([["0,0", "A"]]);
    setLastComposite(composite);
    expect(getLastComposite()).toBe(composite);
    setLastComposite(null);
    expect(getLastComposite()).toBeNull();
  });

  it("layerToText uses cached composite when set", () => {
    const cached = new Map([["0,0", "Z"], ["0,1", "Z"]]);
    setLastComposite(cached);
    // layerToText should use the cached composite, not recompute
    expect(layerToText([])).toBe("ZZ");
    setLastComposite(null);
  });

  it("layerToText recomputes when no cache", () => {
    setLastComposite(null);
    expect(layerToText([])).toBe("");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/layers.test.ts -t "shared composite cache"`
Expected: FAIL — `setLastComposite` and `getLastComposite` not exported

**Step 3: Write minimal implementation**

Add to `src/layers.ts` after the existing `compositeLayers` and `compositeLayersWithOwnership` functions:

```typescript
// ── Shared composite cache ────────────────────────────────
// TextLayer sets this after computing composite; layerToText
// reuses it to avoid a redundant O(all-cells) pass during autosave.

let _lastComposite: Map<string, string> | null = null;

export function setLastComposite(c: Map<string, string> | null): void {
  _lastComposite = c;
}

export function getLastComposite(): Map<string, string> | null {
  return _lastComposite;
}
```

Modify `layerToText` (line ~318) — change the first line:

```typescript
export function layerToText(layers: Layer[]): string {
  const composite = _lastComposite ?? compositeLayers(layers);
  if (composite.size === 0) return "";
  // ... rest unchanged ...
```

Now rewrite `src/KonvaCanvas.tsx` — split into three parts:

```typescript
import React, { memo, useEffect, useMemo, useState, useRef } from "react";
import { Stage, Layer, Shape, Rect, Line as KonvaLine, Transformer } from "react-konva";
import { useEditorStore } from "./store";
import { compositeLayers, isEffectivelyVisible, setLastComposite } from "./layers";
import type { Layer as LayerType } from "./layers";
import {
  GRID_WIDTH, GRID_HEIGHT, CANVAS_PADDING, FONT_SIZE, FONT_FAMILY,
  BG_COLOR, FG_COLOR, measureCellSize, getCharWidth, getCharHeight,
} from "./grid";
import { useGestureAdapter } from "./useGestureAdapter";
import { useToolHandlers } from "./useToolHandlers";

// ── Pure helpers ──────────────────────────────────────────

interface GridBounds {
  contentRows: number;
  contentCols: number;
}

function deriveGridBounds(composite: Map<string, string>): GridBounds {
  let maxRow = 0;
  let maxCol = 0;
  for (const key of composite.keys()) {
    const i = key.indexOf(",");
    const r = Number(key.slice(0, i));
    const c = Number(key.slice(i + 1));
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }
  return {
    contentRows: maxRow + 1 + CANVAS_PADDING,
    contentCols: maxCol + 1 + CANVAS_PADDING,
  };
}

// ── TextLayer ─────────────────────────────────────────────

interface TextLayerProps {
  layers: LayerType[];
  effectiveRows: number;
  effectiveCols: number;
  charWidth: number;
  charHeight: number;
}

const TextLayer = memo(function TextLayer({
  layers,
  effectiveRows,
  effectiveCols,
  charWidth,
  charHeight,
}: TextLayerProps) {
  const composite = useMemo(() => compositeLayers(layers), [layers]);

  useEffect(() => {
    setLastComposite(composite);
    return () => setLastComposite(null);
  }, [composite]);

  return (
    <Layer listening={false}>
      <Shape
        sceneFunc={(ctx) => {
          ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
          ctx.fillStyle = FG_COLOR;
          ctx.textBaseline = "top";
          for (let row = 0; row < effectiveRows; row++) {
            let line = "";
            for (let col = 0; col < effectiveCols; col++) {
              line += composite.get(`${row},${col}`) ?? " ";
            }
            ctx.fillText(line, 0, row * charHeight);
          }
        }}
      />
    </Layer>
  );
});

// ── InteractiveLayer ──────────────────────────────────────

interface InteractiveLayerProps {
  layers: LayerType[];
  selectedId: string | null;
  activeTool: string;
  charWidth: number;
  charHeight: number;
  previewNode: React.ReactNode;
}

function InteractiveLayer({
  layers,
  selectedId,
  activeTool,
  charWidth,
  charHeight,
  previewNode,
}: InteractiveLayerProps) {
  const selectLayer = useEditorStore((s) => s.selectLayer);
  const { onDragStart, onDragEnd, onTransformStart, onTransformEnd, gestureRef } =
    useGestureAdapter();
  const transformerRef = useRef<any>(null);
  const shapeRefs = useRef<Map<string, any>>(new Map());

  const byId = useMemo(() => new Map(layers.map((l) => [l.id, l])), [layers]);
  const visibleLayers = useMemo(
    () => layers.filter(
      (l) => l.type !== "base" && l.type !== "group" && isEffectivelyVisible(l, byId),
    ),
    [layers, byId],
  );

  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const selectedLayer = layers.find((l) => l.id === selectedId);
    if (selectedId && selectedLayer?.type === "rect" && selectedLayer.style
        && shapeRefs.current.has(selectedId)) {
      tr.nodes([shapeRefs.current.get(selectedId)]);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [selectedId, layers]);

  const isTransforming = gestureRef.current?.active && gestureRef.current.mode === "resize";

  return (
    <Layer listening={activeTool === "select"}>
      {visibleLayers.map((l) => {
        const x = l.bbox.col * charWidth;
        const y = l.bbox.row * charHeight;
        const w = l.bbox.w * charWidth;
        const h = l.bbox.h * charHeight;
        const selected = l.id === selectedId;

        if (l.type === "line") {
          const isH = l.bbox.h === 1;
          const points = isH
            ? [0, h / 2, w, h / 2]
            : [w / 2, 0, w / 2, h];
          return (
            <KonvaLine
              key={l.id}
              x={x} y={y}
              points={points}
              stroke={selected ? "#4a90e2" : "transparent"}
              strokeWidth={selected ? 2 : 1}
              hitStrokeWidth={10}
              draggable={l.id === selectedId && activeTool === "select"}
              dragBoundFunc={(pos) => ({
                x: Math.round(pos.x / charWidth) * charWidth,
                y: Math.round(pos.y / charHeight) * charHeight,
              })}
              onClick={() => selectLayer(l.id)}
              onTap={() => selectLayer(l.id)}
              onDragStart={(e) => onDragStart(l.id, e.target, charWidth, charHeight)}
              onDragEnd={(e) => onDragEnd(l.id, e.target, charWidth, charHeight)}
            />
          );
        }

        return (
          <Rect
            key={l.id}
            ref={(node) => {
              if (node) shapeRefs.current.set(l.id, node);
              else shapeRefs.current.delete(l.id);
            }}
            x={x} y={y} width={w} height={h}
            fill="transparent"
            stroke={selected ? "#4a90e2" : "transparent"}
            strokeWidth={selected ? 2 : 0}
            hitStrokeWidth={10}
            draggable={l.id === selectedId && activeTool === "select" && !isTransforming}
            dragBoundFunc={(pos) => ({
              x: Math.round(pos.x / charWidth) * charWidth,
              y: Math.round(pos.y / charHeight) * charHeight,
            })}
            onClick={() => selectLayer(l.id)}
            onTap={() => selectLayer(l.id)}
            onDragStart={(e) => onDragStart(l.id, e.target, charWidth, charHeight)}
            onDragEnd={(e) => onDragEnd(l.id, e.target, charWidth, charHeight)}
            onTransformStart={(e) => onTransformStart(l.id, e.target, charWidth, charHeight)}
            onTransformEnd={(e) => onTransformEnd(l.id, e.target, charWidth, charHeight)}
          />
        );
      })}
      {previewNode}
      <Transformer
        ref={transformerRef}
        rotateEnabled={false}
        keepRatio={false}
        enabledAnchors={[
          "top-left", "top-right", "bottom-left", "bottom-right",
          "top-center", "bottom-center", "middle-left", "middle-right",
        ]}
        boundBoxFunc={(oldBox, newBox) => {
          const snapped = { ...newBox };
          const rightStable = Math.abs((newBox.x + newBox.width) - (oldBox.x + oldBox.width)) < charWidth / 2;
          if (rightStable) {
            const right = oldBox.x + oldBox.width;
            snapped.x = Math.round(newBox.x / charWidth) * charWidth;
            snapped.width = Math.max(charWidth, right - snapped.x);
          } else {
            snapped.x = Math.round(newBox.x / charWidth) * charWidth;
            snapped.width = Math.max(charWidth, Math.round(newBox.width / charWidth) * charWidth);
          }
          const bottomStable = Math.abs((newBox.y + newBox.height) - (oldBox.y + oldBox.height)) < charHeight / 2;
          if (bottomStable) {
            const bottom = oldBox.y + oldBox.height;
            snapped.y = Math.round(newBox.y / charHeight) * charHeight;
            snapped.height = Math.max(charHeight, bottom - snapped.y);
          } else {
            snapped.y = Math.round(newBox.y / charHeight) * charHeight;
            snapped.height = Math.max(charHeight, Math.round(newBox.height / charHeight) * charHeight);
          }
          return snapped;
        }}
      />
    </Layer>
  );
}

// ── KonvaCanvas (shell) ───────────────────────────────────

export function KonvaCanvas() {
  const layers = useEditorStore((s) => s.layers);
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectLayer = useEditorStore((s) => s.selectLayer);
  const activeTool = useEditorStore((s) => s.activeTool);
  const [ready, setReady] = useState(false);
  const highWaterRef = useRef<{ rows: number; cols: number }>({ rows: 0, cols: 0 });

  useEffect(() => {
    measureCellSize().then(() => setReady(true));
  }, []);

  const charWidth = ready ? getCharWidth() : 0;
  const charHeight = ready ? getCharHeight() : 0;
  const toolHandlers = useToolHandlers(activeTool, charWidth, charHeight);

  const composite = useMemo(() => compositeLayers(layers), [layers]);
  const gridBounds = useMemo(() => deriveGridBounds(composite), [composite]);

  if (!ready) {
    return <div style={{ background: BG_COLOR, width: "100%", height: "100%" }} />;
  }

  if (layers.length === 0) {
    highWaterRef.current = { rows: 0, cols: 0 };
  }

  const effectiveRows = Math.max(GRID_HEIGHT, gridBounds.contentRows, highWaterRef.current.rows);
  const effectiveCols = Math.max(GRID_WIDTH, gridBounds.contentCols, highWaterRef.current.cols);
  highWaterRef.current = { rows: effectiveRows, cols: effectiveCols };

  return (
    <Stage
      width={effectiveCols * charWidth}
      height={effectiveRows * charHeight}
      style={{ background: BG_COLOR }}
      tabIndex={0}
      role="application"
      aria-label="ASCII wireframe canvas"
      onClick={(e) => {
        if (e.target === e.target.getStage()) selectLayer(null);
      }}
      onMouseDown={toolHandlers.onMouseDown}
      onMouseMove={toolHandlers.onMouseMove}
      onMouseUp={toolHandlers.onMouseUp}
    >
      <TextLayer
        layers={layers}
        effectiveRows={effectiveRows}
        effectiveCols={effectiveCols}
        charWidth={charWidth}
        charHeight={charHeight}
      />
      <InteractiveLayer
        layers={layers}
        selectedId={selectedId}
        activeTool={activeTool}
        charWidth={charWidth}
        charHeight={charHeight}
        previewNode={toolHandlers.previewNode}
      />
    </Stage>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/layers.test.ts -t "shared composite cache"`
Then: `npx vitest run`
Expected: All tests pass, build succeeds

**Step 5: Commit**

```bash
git add src/KonvaCanvas.tsx src/layers.ts src/layers.test.ts
git commit -m "perf: split KonvaCanvas into TextLayer + InteractiveLayer, share composite"
```

---

### Task 2: Sparse row rendering in sceneFunc

**Files:**
- Modify: `src/KonvaCanvas.tsx` (TextLayer sceneFunc + add `buildSparseRows` helper)
- Test: `src/KonvaCanvas.test.ts` (new file)

**Step 1: Write the failing test**

Create `src/KonvaCanvas.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSparseRows } from "./KonvaCanvas";

describe("buildSparseRows", () => {
  it("groups cells by row, fills gaps with spaces", () => {
    const composite = new Map([
      ["0,0", "A"],
      ["0,2", "B"],
      ["2,1", "C"],
    ]);
    expect(buildSparseRows(composite)).toEqual([
      { row: 0, startCol: 0, text: "A B" },
      { row: 2, startCol: 1, text: "C" },
    ]);
  });

  it("returns empty array for empty composite", () => {
    expect(buildSparseRows(new Map())).toEqual([]);
  });

  it("handles single cell", () => {
    const composite = new Map([["5,10", "X"]]);
    expect(buildSparseRows(composite)).toEqual([
      { row: 5, startCol: 10, text: "X" },
    ]);
  });

  it("handles contiguous row without gaps", () => {
    const composite = new Map([
      ["0,0", "A"], ["0,1", "B"], ["0,2", "C"],
    ]);
    expect(buildSparseRows(composite)).toEqual([
      { row: 0, startCol: 0, text: "ABC" },
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/KonvaCanvas.test.ts`
Expected: FAIL — `buildSparseRows` not exported

**Step 3: Write minimal implementation**

Add to `src/KonvaCanvas.tsx` (after the `deriveGridBounds` helper, before `TextLayer`):

```typescript
export interface SparseRow {
  row: number;
  startCol: number;
  text: string;
}

export function buildSparseRows(composite: Map<string, string>): SparseRow[] {
  const byRow = new Map<number, Map<number, string>>();
  for (const [key, ch] of composite) {
    const i = key.indexOf(",");
    const r = Number(key.slice(0, i));
    const c = Number(key.slice(i + 1));
    let cols = byRow.get(r);
    if (!cols) {
      cols = new Map();
      byRow.set(r, cols);
    }
    cols.set(c, ch);
  }

  const result: SparseRow[] = [];
  const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
  for (const row of sortedRows) {
    const cols = byRow.get(row)!;
    const sortedCols = [...cols.keys()].sort((a, b) => a - b);
    const startCol = sortedCols[0];
    const endCol = sortedCols[sortedCols.length - 1];
    let text = "";
    for (let c = startCol; c <= endCol; c++) {
      text += cols.get(c) ?? " ";
    }
    result.push({ row, startCol, text });
  }
  return result;
}
```

Update `TextLayer` sceneFunc to use sparse rows:

```typescript
const TextLayer = memo(function TextLayer({ ... }: TextLayerProps) {
  const composite = useMemo(() => compositeLayers(layers), [layers]);
  const sparseRows = useMemo(() => buildSparseRows(composite), [composite]);

  useEffect(() => {
    setLastComposite(composite);
    return () => setLastComposite(null);
  }, [composite]);

  return (
    <Layer listening={false}>
      <Shape
        sceneFunc={(ctx) => {
          ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
          ctx.fillStyle = FG_COLOR;
          ctx.textBaseline = "top";
          for (const { row, startCol, text } of sparseRows) {
            ctx.fillText(text, startCol * charWidth, row * charHeight);
          }
        }}
      />
    </Layer>
  );
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/KonvaCanvas.test.ts`
Then: `npx vitest run`
Expected: All pass

**Step 5: Commit**

```bash
git add src/KonvaCanvas.tsx src/KonvaCanvas.test.ts
git commit -m "perf: sparse row rendering — only draw rows with content"
```

---

### Task 3: Cache the text Shape node

**Files:**
- Modify: `src/KonvaCanvas.tsx` (TextLayer — add Shape ref + cache effect)

**Step 1: No new test needed** — this is a Konva rendering optimization. The existing `layerToText` and composite tests verify data correctness. Caching only affects the Konva draw path (bitmap blit vs sceneFunc re-execution).

**Step 2: Write implementation**

Update `TextLayer` to cache the Shape after composite changes:

```typescript
const TextLayer = memo(function TextLayer({
  layers,
  effectiveRows,
  effectiveCols,
  charWidth,
  charHeight,
}: TextLayerProps) {
  const shapeRef = useRef<any>(null);
  const composite = useMemo(() => compositeLayers(layers), [layers]);
  const sparseRows = useMemo(() => buildSparseRows(composite), [composite]);

  useEffect(() => {
    setLastComposite(composite);
    return () => setLastComposite(null);
  }, [composite]);

  // Cache the Shape as a bitmap — subsequent Layer redraws blit the
  // bitmap instead of re-executing sceneFunc.
  useEffect(() => {
    const node = shapeRef.current;
    if (!node) return;
    node.clearCache();
    node.cache({
      x: 0,
      y: 0,
      width: effectiveCols * charWidth,
      height: effectiveRows * charHeight,
      pixelRatio: 1,
    });
    node.getLayer()?.batchDraw();
  }, [composite, effectiveCols, effectiveRows, charWidth, charHeight]);

  return (
    <Layer listening={false}>
      <Shape
        ref={shapeRef}
        sceneFunc={(ctx) => {
          ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
          ctx.fillStyle = FG_COLOR;
          ctx.textBaseline = "top";
          for (const { row, startCol, text } of sparseRows) {
            ctx.fillText(text, startCol * charWidth, row * charHeight);
          }
        }}
      />
    </Layer>
  );
});
```

**Step 3: Run full test suite**

Run: `npx vitest run && npm run build`
Expected: All pass, build succeeds

**Step 4: Commit**

```bash
git add src/KonvaCanvas.tsx
git commit -m "perf: cache text Shape as bitmap, blit instead of re-executing sceneFunc"
```

---

### Task 4: Glyph atlas

**Files:**
- Modify: `src/grid.ts` (add atlas builder + getter)
- Modify: `src/KonvaCanvas.tsx` (use atlas in sceneFunc)
- Test: `src/grid.test.ts` (new file)

**Step 1: Write the failing test**

Create `src/grid.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildGlyphAtlas } from "./grid";

describe("buildGlyphAtlas", () => {
  it("creates atlas with all printable ASCII and box-drawing chars", () => {
    const atlas = buildGlyphAtlas(10, 18);
    expect(atlas.canvas).toBeDefined();
    expect(atlas.cellWidth).toBe(10);
    expect(atlas.cellHeight).toBe(18);
    // Printable ASCII
    expect(atlas.glyphs.has("A")).toBe(true);
    expect(atlas.glyphs.has(" ")).toBe(true);
    expect(atlas.glyphs.has("~")).toBe(true);
    // Box-drawing
    expect(atlas.glyphs.has("┌")).toBe(true);
    expect(atlas.glyphs.has("─")).toBe(true);
    expect(atlas.glyphs.has("│")).toBe(true);
    // Each glyph has sx, sy coordinates
    const a = atlas.glyphs.get("A")!;
    expect(typeof a.sx).toBe("number");
    expect(typeof a.sy).toBe("number");
  });

  it("total glyph count = 95 ASCII + 128 box-drawing = 223", () => {
    const atlas = buildGlyphAtlas(10, 18);
    expect(atlas.glyphs.size).toBe(223);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/grid.test.ts`
Expected: FAIL — `buildGlyphAtlas` not exported

**Step 3: Write minimal implementation**

Add to `src/grid.ts`:

```typescript
export interface GlyphAtlas {
  canvas: HTMLCanvasElement;
  glyphs: Map<string, { sx: number; sy: number }>;
  cellWidth: number;
  cellHeight: number;
}

export function buildGlyphAtlas(charWidth: number, charHeight: number): GlyphAtlas {
  const chars: string[] = [];
  // Printable ASCII: 32 (space) through 126 (~) = 95 chars
  for (let code = 32; code <= 126; code++) chars.push(String.fromCharCode(code));
  // Box-drawing: U+2500 through U+257F = 128 chars
  for (let code = 0x2500; code <= 0x257f; code++) chars.push(String.fromCharCode(code));

  const cols = 16;
  const rows = Math.ceil(chars.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(cols * charWidth);
  canvas.height = Math.ceil(rows * charHeight);
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";

  const glyphs = new Map<string, { sx: number; sy: number }>();
  for (let i = 0; i < chars.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const sx = Math.round(col * charWidth);
    const sy = Math.round(row * charHeight);
    glyphs.set(chars[i], { sx, sy });
    ctx.fillText(chars[i], sx, sy);
  }

  return { canvas, glyphs, cellWidth: charWidth, cellHeight: charHeight };
}

let _glyphAtlas: GlyphAtlas | null = null;

export function getGlyphAtlas(): GlyphAtlas | null {
  return _glyphAtlas;
}
```

Update `measureCellSize` — add atlas build at the end (after `_measured = true`):

```typescript
  _measured = true;
  _glyphAtlas = buildGlyphAtlas(_charWidth, _charHeight);
  return { charWidth: _charWidth, charHeight: _charHeight };
```

Update `TextLayer` sceneFunc in `src/KonvaCanvas.tsx` to use the atlas:

```typescript
import { getGlyphAtlas } from "./grid";

// Inside TextLayer sceneFunc:
sceneFunc={(ctx) => {
  const atlas = getGlyphAtlas();
  if (!atlas) {
    // Fallback: fillText (atlas not yet built)
    ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.fillStyle = FG_COLOR;
    ctx.textBaseline = "top";
    for (const { row, startCol, text } of sparseRows) {
      ctx.fillText(text, startCol * charWidth, row * charHeight);
    }
    return;
  }
  for (const { row, startCol, text } of sparseRows) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === " ") continue; // background handles blank cells
      const glyph = atlas.glyphs.get(ch);
      if (!glyph) {
        // Char not in atlas — fallback to fillText for this char
        ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
        ctx.fillStyle = FG_COLOR;
        ctx.textBaseline = "top";
        ctx.fillText(ch, (startCol + i) * charWidth, row * charHeight);
        continue;
      }
      ctx.drawImage(
        atlas.canvas,
        glyph.sx, glyph.sy, atlas.cellWidth, atlas.cellHeight,
        (startCol + i) * charWidth, row * charHeight, charWidth, charHeight,
      );
    }
  }
}}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/grid.test.ts`
Then: `npx vitest run && npm run build`
Expected: All pass

**Step 5: Commit**

```bash
git add src/grid.ts src/grid.test.ts src/KonvaCanvas.tsx
git commit -m "perf: glyph atlas — drawImage instead of fillText"
```

---

### Task 5: Shrinkable high-water mark

**Files:**
- Modify: `src/KonvaCanvas.tsx` (replace grow-only logic)

**Step 1: Implementation**

In the `KonvaCanvas` shell, replace the grow-only high-water logic:

```typescript
  // Allow high-water mark to shrink to content bounds (floored at grid minimums)
  const effectiveRows = Math.max(GRID_HEIGHT, gridBounds.contentRows);
  const effectiveCols = Math.max(GRID_WIDTH, gridBounds.contentCols);
```

Remove the `highWaterRef` entirely — it's no longer needed. The grid dimensions are purely derived from content + minimums.

**Step 2: Run full test suite**

Run: `npx vitest run && npm run build`
Expected: All pass

**Step 3: Commit**

```bash
git add src/KonvaCanvas.tsx
git commit -m "perf: remove grow-only high-water mark, derive grid size from content"
```

---

### Task 6: Stabilize callbacks + memoized InteractiveShape

**Files:**
- Modify: `src/KonvaCanvas.tsx` (extract `InteractiveShape`, stabilize callbacks)

This task extracts per-layer rendering from the `visibleLayers.map(...)` loop in `InteractiveLayer` into a `React.memo`-wrapped `InteractiveShape` component. Currently every `InteractiveLayer` render creates new `dragBoundFunc`, `onClick`, `onDragStart`, `onDragEnd`, `onTransformStart`, `onTransformEnd` closures for every visible layer — react-konva re-applies all event handlers even when the layer data hasn't changed. After this task, only layers whose props actually changed will re-render.

**Step 1: Write the failing test**

Add to `src/KonvaCanvas.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSparseRows } from "./KonvaCanvas";

// ... existing buildSparseRows tests ...

describe("InteractiveShape memoization contract", () => {
  it("InteractiveShape is exported and wrapped in React.memo", async () => {
    const mod = await import("./KonvaCanvas");
    // React.memo wraps the component — the wrapper has a $$typeof of Symbol.for('react.memo')
    expect((mod as any).InteractiveShape).toBeDefined();
    expect((mod as any).InteractiveShape.$$typeof).toBe(Symbol.for("react.memo"));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/KonvaCanvas.test.ts -t "InteractiveShape"`
Expected: FAIL — `InteractiveShape` is not exported or not memo-wrapped

**Step 3: Write minimal implementation**

Add a stable `snapPos` callback in `InteractiveLayer`:

```typescript
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Inside InteractiveLayer, before the return:
const snapPos = useCallback(
  (pos: { x: number; y: number }) => ({
    x: Math.round(pos.x / charWidth) * charWidth,
    y: Math.round(pos.y / charHeight) * charHeight,
  }),
  [charWidth, charHeight],
);
```

Extract the per-layer rendering into a new `InteractiveShape` component:

```typescript
interface InteractiveShapeProps {
  layer: LayerType;
  selected: boolean;
  activeTool: string;
  charWidth: number;
  charHeight: number;
  isTransforming: boolean;
  selectLayer: (id: string | null) => void;
  onDragStart: (id: string, node: any, cw: number, ch: number) => void;
  onDragEnd: (id: string, node: any, cw: number, ch: number) => void;
  onTransformStart: (id: string, node: any, cw: number, ch: number) => void;
  onTransformEnd: (id: string, node: any, cw: number, ch: number) => void;
  snapPos: (pos: { x: number; y: number }) => { x: number; y: number };
  setShapeRef: (id: string, node: any) => void;
}

export const InteractiveShape = memo(function InteractiveShape({
  layer: l,
  selected,
  activeTool,
  charWidth,
  charHeight,
  isTransforming,
  selectLayer,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
  snapPos,
  setShapeRef,
}: InteractiveShapeProps) {
  const handleClick = useCallback(() => selectLayer(l.id), [selectLayer, l.id]);
  const handleDragStart = useCallback(
    (e: any) => onDragStart(l.id, e.target, charWidth, charHeight),
    [onDragStart, l.id, charWidth, charHeight],
  );
  const handleDragEnd = useCallback(
    (e: any) => onDragEnd(l.id, e.target, charWidth, charHeight),
    [onDragEnd, l.id, charWidth, charHeight],
  );
  const handleTransformStart = useCallback(
    (e: any) => onTransformStart(l.id, e.target, charWidth, charHeight),
    [onTransformStart, l.id, charWidth, charHeight],
  );
  const handleTransformEnd = useCallback(
    (e: any) => onTransformEnd(l.id, e.target, charWidth, charHeight),
    [onTransformEnd, l.id, charWidth, charHeight],
  );
  const handleRef = useCallback(
    (node: any) => setShapeRef(l.id, node),
    [setShapeRef, l.id],
  );

  const x = l.bbox.col * charWidth;
  const y = l.bbox.row * charHeight;
  const w = l.bbox.w * charWidth;
  const h = l.bbox.h * charHeight;

  if (l.type === "line") {
    const isH = l.bbox.h === 1;
    const points = isH ? [0, h / 2, w, h / 2] : [w / 2, 0, w / 2, h];
    return (
      <KonvaLine
        x={x} y={y}
        points={points}
        stroke={selected ? "#4a90e2" : "transparent"}
        strokeWidth={selected ? 2 : 1}
        hitStrokeWidth={10}
        draggable={selected && activeTool === "select"}
        dragBoundFunc={snapPos}
        onClick={handleClick}
        onTap={handleClick}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      />
    );
  }

  return (
    <Rect
      ref={handleRef}
      x={x} y={y} width={w} height={h}
      fill="transparent"
      stroke={selected ? "#4a90e2" : "transparent"}
      strokeWidth={selected ? 2 : 0}
      hitStrokeWidth={10}
      draggable={selected && activeTool === "select" && !isTransforming}
      dragBoundFunc={snapPos}
      onClick={handleClick}
      onTap={handleClick}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onTransformStart={handleTransformStart}
      onTransformEnd={handleTransformEnd}
    />
  );
});
```

Replace the `visibleLayers.map(...)` block in `InteractiveLayer`'s return with:

```typescript
const setShapeRef = useCallback((id: string, node: any) => {
  if (node) shapeRefs.current.set(id, node);
  else shapeRefs.current.delete(id);
}, []);

// In the return JSX:
{visibleLayers.map((l) => (
  <InteractiveShape
    key={l.id}
    layer={l}
    selected={l.id === selectedId}
    activeTool={activeTool}
    charWidth={charWidth}
    charHeight={charHeight}
    isTransforming={isTransforming}
    selectLayer={selectLayer}
    onDragStart={onDragStart}
    onDragEnd={onDragEnd}
    onTransformStart={onTransformStart}
    onTransformEnd={onTransformEnd}
    snapPos={snapPos}
    setShapeRef={setShapeRef}
  />
))}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/KonvaCanvas.test.ts`
Then: `npx vitest run && npm run build`
Expected: All pass

**Step 5: Commit**

```bash
git add src/KonvaCanvas.tsx src/KonvaCanvas.test.ts
git commit -m "perf: extract memoized InteractiveShape with stable callbacks"
```

---

### Final Verification

```bash
npx vitest run && npm run build
```

Expected: All tests pass, production build succeeds.

---

**Edge cases / risks:**
- `setLastComposite` assumes one canvas instance. Multiple editors would need instance scoping.
- Glyph atlas fallback path handles non-atlas Unicode gracefully (per-char `fillText`).
- Shape caching with `pixelRatio: 1` may look slightly less crisp on Retina — change to `window.devicePixelRatio` if needed (at memory cost).
- Removing high-water mark means the canvas may visually shrink after deleting content. If this feels jarring, add a 1-second debounced shrink instead.
- `InteractiveShape` receives `selectLayer`, `onDragStart`, `onDragEnd`, `onTransformStart`, `onTransformEnd` as props — these must be stable references from the parent. `selectLayer` comes from Zustand (stable by default). The gesture adapter functions are created once per `useGestureAdapter()` call — stable across renders since they close over refs, not state.

**Dependency graph:**
```
Task 1 (Split + memoize + share composite)
  → Task 2 (Sparse rows — modifies TextLayer sceneFunc)
  → Task 3 (Cache Shape — adds ref + useEffect to TextLayer)
  → Task 4 (Glyph atlas — replaces fillText in sceneFunc)
  → Task 6 (InteractiveShape — refactors InteractiveLayer)
Task 5 (Shrinkable high-water — modifies KonvaCanvas shell, independent)
```
