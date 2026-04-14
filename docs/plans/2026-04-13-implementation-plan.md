# Gridpad Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a single-view ASCII wireframe editor with Konva canvas, MS-Paint-style drawing tools, and file-based autosave.

**Architecture:** Text is the document. Drawing tools stamp characters into text → `loadFromText` → scanner → layers. Move/resize mutates layers directly → `toText()` → autosave. Konva renders the grid + interactive shapes. No CodeMirror. See `docs/plans/2026-04-13-single-view-architecture.md`.

**Tech Stack:** React 19, TypeScript, Konva + react-konva, Mantine v9, Zustand + Zundo, Vitest

**Baseline:** 177 tests passing. All tests must stay green after every task.

**Prep (before Task 1):**

1. Extract `Bbox` type into `src/types.ts` and re-export from
   `src/store.ts`. Currently `Bbox` is defined in `store.ts`
   (exported) and duplicated privately in `layers.ts:57`.
   Centralizing it lets stamp functions (`src/tools/*.ts`) import
   from `src/types.ts` without coupling to the store — important
   for the Obsidian plugin reuse goal. Update `layers.ts` to import
   from `src/types.ts` and delete its private copy.

2. Add `snapToGrid` helper to `src/grid.ts`:
   ```typescript
   export function snapToGrid(
     px: number, py: number
   ): { x: number; y: number } {
     return {
       x: Math.round(px / _charWidth) * _charWidth,
       y: Math.round(py / _charHeight) * _charHeight,
     };
   }
   ```
   Used by `dragBoundFunc` (Task 3) and `boundBoxFunc` (Task 4)
   instead of inlining the same rounding logic in both places.

Run `npm test` after both changes to verify.

---

## Review fixes (applied from Gemini + Codex review, 2026-04-13)

### Fix 1: Autosave/watcher infinite loop (Critical — Tasks 1, 10)

The autosave subscriber writes to the file, bumping `lastModified`.
The file watcher sees the newer timestamp and calls `loadFromText`,
which changes layers, which triggers autosave again — infinite loop.

**Fix:** The autosave subscriber MUST update `lastModifiedRef.current`
after every successful write. The watcher only reloads if
`file.lastModified > lastModifiedRef.current`. Since autosave updates
the ref after writing, the watcher ignores app-originated writes.

Same fix for explicit Save (`handleSave`): update `lastModifiedRef`
after `writable.close()`.

Same fix for Open (`handleOpen`): set `lastModifiedRef` BEFORE
calling `loadFromText`, not after — otherwise the autosave subscriber
can fire in between and write to the file before the ref is set.

### Fix 2: moveLayerLive on drag start triggers autosave (High — Task 3)

The architecture says tools call `moveLayerLive` once on `onDragStart`
to trigger the zundo snapshot. But `moveLayerLive` creates a new
`layers` array (even if the bbox doesn't change), which triggers the
autosave subscriber.

**Fix:** The autosave subscriber must check whether `toText()` has
actually changed before writing. Cheap: store the last-written text
hash or the last-written string. Only write if different.

```typescript
// In autosave subscriber:
const newText = useEditorStore.getState().toText();
if (newText === lastWrittenTextRef.current) return; // no change, skip
// ... write to file ...
lastWrittenTextRef.current = newText;
```

This also prevents unnecessary disk writes during selection changes,
tool switches, and other non-text-affecting state changes that
produce new `layers` array references without changing content.

### Fix 3: useGestureAdapter cleanup must distinguish move vs resize (High — Tasks 3, 4)

The hook's `useEffect` cleanup always calls `moveLayerCommit`. If a
resize is in progress, it should call `resizeLayerCommit` instead and
reset `node.scaleX/Y` to 1.

**Fix:** The `GestureState` ref stores a `mode: "move" | "resize"`
field. Cleanup checks the mode and calls the appropriate commit
action. Resize cleanup also resets the node's scale attrs.

```typescript
interface GestureState {
  layerId: string;
  startBbox: Bbox;
  active: boolean;
  mode: "move" | "resize";
  node: any; // Konva node ref for cleanup
}
```

### Fix 4: Disable draggable during transform (Medium — Task 4)

A selected rect is both `draggable` and transformable — gesture
conflict. Fix: set `draggable={false}` while a transform is active.
Use a `transformingRef` boolean flag, set true in `onTransformStart`,
false in `onTransformEnd`/cancel.

Or simpler: `draggable={l.id === selectedId && activeTool === "select" && !isTransforming}`.

### Fix 5: boundBoxFunc left/top handle wobble (Medium — Task 4)

Rounding x/y/width/height independently causes the opposite edge to
wobble when resizing from left/top handles.

**Fix:** When the right/bottom edge is stationary, compute the
snapped position from the stationary edge:

```typescript
boundBoxFunc={(oldBox, newBox) => {
  const snapped = { ...newBox };
  // If right edge is ~stationary, anchor it and snap left
  if (Math.abs((newBox.x + newBox.width) - (oldBox.x + oldBox.width)) < charWidth / 2) {
    const right = oldBox.x + oldBox.width;
    snapped.x = Math.round(newBox.x / charWidth) * charWidth;
    snapped.width = right - snapped.x;
  } else {
    snapped.x = Math.round(newBox.x / charWidth) * charWidth;
    snapped.width = Math.max(charWidth, Math.round(newBox.width / charWidth) * charWidth);
  }
  // Same logic for top/bottom edge
  if (Math.abs((newBox.y + newBox.height) - (oldBox.y + oldBox.height)) < charHeight / 2) {
    const bottom = oldBox.y + oldBox.height;
    snapped.y = Math.round(newBox.y / charHeight) * charHeight;
    snapped.height = bottom - snapped.y;
  } else {
    snapped.y = Math.round(newBox.y / charHeight) * charHeight;
    snapped.height = Math.max(charHeight, Math.round(newBox.height / charHeight) * charHeight);
  }
  return snapped;
}}
```

### Fix 6: Additional tests needed (Medium — Tasks 5, 10)

Add to Task 5 tests:
- `setFileHandle` stores a handle
- `reset()` clears `fileHandle` to null
- `reset()` restores `activeTool` after transitions

Add to Task 10 (or new Task 10b):
- Autosave skips write when text hasn't changed
- Autosave updates `lastModifiedRef` after write
- Watcher ignores app-originated writes
- Open sets `lastModifiedRef` before `loadFromText`
- Save updates `lastModifiedRef`

### Fix 7: Task 4 must define installResizeListeners (Medium)

Task 4's `onTransformStart` references `installResizeListeners` but
doesn't define it. The implementation must:
- Install Escape listener that resets `node.scaleX(1); node.scaleY(1)`
  and calls `resizeLayerCommit(id, startBbox)`
- Install pointercancel listener with same revert
- Reset node width/height to pre-transform pixel values on cancel
- Be removed in onTransformEnd and cleanup

### Fix 8: Text tool input constraint (Low — Task 8)

The architecture says grapheme clusters / emoji are out of scope.
`stampText` should filter input to printable single-column characters
(charCode 32-126 plus Unicode box-drawing range U+2500-U+257F).
Reject or ignore other input.

### Note: `[...string]` spread and multi-byte characters (Low — Tasks 6-9)

The stamp functions' `setChar` helper uses `[...lines[r]]` to spread
a string into an array by codepoint. Box-drawing characters (U+2500–
U+257F) are single codepoints, so this is safe for all tool output.
However, if a user externally edits the `.md` file to include emoji
or other multi-codepoint graphemes, a stamp operation on that row
would split them into individual codepoints, corrupting the string.
This is acceptable for v1 (emoji is a non-goal) but stamp functions
should not be used as evidence that grapheme-safe editing works.

### Fix 9: Drawing tools must verify zundo tracking is active (Low — Tasks 6-9)

Drawing tools call `loadFromText(newText)` which does a normal
`set()` — zundo captures this as an undo step. But if a prior drag
was interrupted without cleanup (component unmount edge case),
`_inLiveDrag` could be stuck `true` with tracking paused.

**Fix:** At the top of each stamp commit path in `useToolHandlers`,
guard with a tracking check:

```typescript
const t = useEditorStore.temporal.getState();
if (!t.isTracking) t.resume();
```

This is defensive — the gesture adapter cleanup should always fire,
but a one-line guard prevents silent undo breakage.

### Fix 10: `measureCellSize` fallback for failed font load (Low — Task 1)

If the monospace font fails to load (missing system font, slow
network for web fonts), `measureCellSize` could produce a 0-width
or wildly wrong cell size. `getCharWidth()`/`getCharHeight()` throw
if not measured, but there's no fallback.

**Fix:** After measurement, validate the result. If `_charWidth` or
`_charHeight` is 0 or unreasonable (< 4px or > 40px), fall back to
hardcoded defaults:

```typescript
const FALLBACK_CHAR_WIDTH = 9.6;  // typical 16px Menlo
const FALLBACK_CHAR_HEIGHT = 18.4;

// After measurement:
if (_charWidth < 4 || _charWidth > 40) _charWidth = FALLBACK_CHAR_WIDTH;
if (_charHeight < 4 || _charHeight > 40) _charHeight = FALLBACK_CHAR_HEIGHT;
```

---

## Phase 1: Konva renders the character grid

### Task 1: KonvaCanvas with character grid rendering + dynamic sizing

**Files:**
- Create: `src/KonvaCanvas.tsx`
- Modify: `src/grid.ts` (add `CANVAS_PADDING` constant)
- Modify: `src/App.tsx` (mount KonvaCanvas in canvas-area)
- Modify: `src/index.css` (canvas-area overflow: auto)

**Step 1: Add `CANVAS_PADDING` to `src/grid.ts`**

```typescript
export const CANVAS_PADDING = 5; // cells of empty space beyond content
```

**Step 2: Create `src/KonvaCanvas.tsx`**

The component measures cell size on mount, then renders a Konva Stage
with a single Layer containing a custom Shape that batch-renders the
composited character grid via `ctx.fillText()` row by row.

The Stage size is **dynamic**: derived from the composite cell map's
bounding box + padding, with a high-water mark so it never shrinks
during a session. Minimum size is `GRID_WIDTH × GRID_HEIGHT`.
The high-water mark resets when `layers` becomes empty (reset/new file).

```typescript
import { useEffect, useState, useRef } from "react";
import { Stage, Layer, Shape } from "react-konva";
import { useEditorStore } from "./store";
import { compositeLayers } from "./layers";
import {
  GRID_WIDTH, GRID_HEIGHT, CANVAS_PADDING, FONT_SIZE, FONT_FAMILY,
  BG_COLOR, FG_COLOR, measureCellSize, getCharWidth, getCharHeight,
} from "./grid";

export function KonvaCanvas() {
  const layers = useEditorStore((s) => s.layers);
  const [ready, setReady] = useState(false);
  const highWaterRef = useRef<{ rows: number; cols: number }>({ rows: 0, cols: 0 });

  useEffect(() => {
    measureCellSize().then(() => setReady(true));
  }, []);

  if (!ready) {
    return <div style={{ background: BG_COLOR, width: "100%", height: "100%" }} />;
  }

  const charWidth = getCharWidth();
  const charHeight = getCharHeight();
  const composite = compositeLayers(layers);

  // Derive grid dimensions from content
  let maxRow = 0;
  let maxCol = 0;
  for (const key of composite.keys()) {
    const [r, c] = key.split(",").map(Number);
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }

  const contentRows = maxRow + 1 + CANVAS_PADDING;
  const contentCols = maxCol + 1 + CANVAS_PADDING;

  // Reset high-water mark when layers are empty (reset/new file)
  if (layers.length === 0) {
    highWaterRef.current = { rows: 0, cols: 0 };
  }

  // Grow only, never shrink
  const effectiveRows = Math.max(GRID_HEIGHT, contentRows, highWaterRef.current.rows);
  const effectiveCols = Math.max(GRID_WIDTH, contentCols, highWaterRef.current.cols);
  highWaterRef.current = { rows: effectiveRows, cols: effectiveCols };

  const stageWidth = effectiveCols * charWidth;
  const stageHeight = effectiveRows * charHeight;

  return (
    <Stage width={stageWidth} height={stageHeight} style={{ background: BG_COLOR }}>
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
    </Stage>
  );
}
```

**Step 3: Update `src/index.css`**

Change `.canvas-area` overflow from `hidden` to `auto` so scrollbars
appear when the Stage exceeds the viewport:

```css
.canvas-area {
  flex: 1 1 auto;
  position: relative;
  overflow: auto;
  background: #1a1a1a;
}
```

**Step 4: Mount in App.tsx**

Replace the `<pre>` placeholder in the canvas-area div:

```typescript
import { KonvaCanvas } from "./KonvaCanvas";

// In the return, replace the <pre> with:
<div className="canvas-area">
  <KonvaCanvas />
</div>
```

**Step 5: Verify**

Run: `npm test` → 177 passed
Run: `npm run dev` → open browser, verify characters render
Verify: canvas has scrollbars if content exceeds viewport
Verify: drawing near bottom-right edge grows the canvas

**Step 6: Commit**

```bash
git add src/KonvaCanvas.tsx src/grid.ts src/App.tsx src/index.css
git commit -m "feat: KonvaCanvas with dynamic sizing — canvas grows as content grows"
```

---

### Task 2: Interactive shape outlines with click-to-select

**Files:**
- Modify: `src/KonvaCanvas.tsx`

**Step 1: Add a second Layer with shape hit-targets**

Below the grid Layer, add an interactive Layer that maps each
visible, non-base, non-group layer to a Konva node:

- Rect layers → `<Rect>` with transparent fill
- Line layers → `<Line>` with `hitStrokeWidth={10}`
- Text layers → `<Rect>` sized to text bbox

Each node gets `onClick={() => selectLayer(l.id)}`.
Stage gets `onClick` on empty space → `selectLayer(null)`.
Selected shape gets a blue stroke.

```typescript
import { Stage, Layer, Shape, Rect, Line as KonvaLine } from "react-konva";
import { isEffectivelyVisible } from "./layers";

const selectedId = useEditorStore((s) => s.selectedId);
const selectLayer = useEditorStore((s) => s.selectLayer);

// Use isEffectivelyVisible (not l.visible) so hiding a parent group
// also hides its children on the canvas — consistent with LayerPanel.
const byId = new Map(layers.map((l) => [l.id, l]));
const visibleLayers = layers.filter(
  (l) => l.type !== "base" && l.type !== "group" && isEffectivelyVisible(l, byId)
);

// Second Layer:
<Layer>
  {visibleLayers.map((l) => {
    const x = l.bbox.col * charWidth;
    const y = l.bbox.row * charHeight;
    const w = l.bbox.w * charWidth;
    const h = l.bbox.h * charHeight;
    const selected = l.id === selectedId;

    if (l.type === "line") {
      // Determine if horizontal or vertical from bbox
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
          onClick={() => selectLayer(l.id)}
          onTap={() => selectLayer(l.id)}
        />
      );
    }

    return (
      <Rect
        key={l.id}
        x={x} y={y} width={w} height={h}
        fill="transparent"
        stroke={selected ? "#4a90e2" : "transparent"}
        strokeWidth={selected ? 2 : 0}
        hitStrokeWidth={10}
        onClick={() => selectLayer(l.id)}
        onTap={() => selectLayer(l.id)}
      />
    );
  })}
</Layer>
```

Stage deselect:
```typescript
<Stage
  onClick={(e) => {
    if (e.target === e.target.getStage()) selectLayer(null);
  }}
>
```

**Step 2: Verify**

Click a shape → blue outline. Click empty → outline clears.
Click panel row → canvas outline follows. Click canvas shape →
panel row highlights.

**Step 3: Commit**

```bash
git add src/KonvaCanvas.tsx
git commit -m "feat: interactive shape outlines with click-to-select"
```

---

### Task 3: Drag-to-move with grid snapping

**Files:**
- Modify: `src/KonvaCanvas.tsx`
- Create: `src/useGestureAdapter.ts`

**Step 1: Create the lifecycle adapter hook**

This hook wraps Konva drag events with zundo safety (snapshot on
start, commit on end, revert on Escape/cancel/unmount).

```typescript
// src/useGestureAdapter.ts
import { useEffect, useRef } from "react";
import { useEditorStore } from "./store";
import type { Bbox } from "./store";

interface GestureState {
  layerId: string;
  startBbox: Bbox;
  active: boolean;
  mode: "move" | "resize";  // Fix 3: distinguish move vs resize
  node: any;                 // Fix 3: Konva node ref for cleanup
}

/**
 * Returns callbacks for move (onDragStart/onDragEnd) and resize
 * (onTransformStart/onTransformEnd) + cleanup.
 * Konva owns node position during drag (no per-frame store updates).
 * Store updates ONCE on end via moveLayerCommit/resizeLayerCommit.
 */
export function useGestureAdapter() {
  const gestureRef = useRef<GestureState | null>(null);
  const escapeRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const cancelRef = useRef<((e: PointerEvent) => void) | null>(null);

  // Cleanup on unmount: commit pre-gesture bbox if interrupted.
  // Fix 3: use mode to call the correct commit action.
  useEffect(() => {
    return () => {
      const g = gestureRef.current;
      if (g?.active) {
        if (g.mode === "resize") {
          // Reset scale before reverting
          g.node.scaleX(1);
          g.node.scaleY(1);
          useEditorStore.getState().resizeLayerCommit(g.layerId, g.startBbox);
        } else {
          useEditorStore.getState().moveLayerCommit(g.layerId, g.startBbox);
        }
      }
      if (escapeRef.current) {
        window.removeEventListener("keydown", escapeRef.current, true);
      }
      if (cancelRef.current) {
        window.removeEventListener("pointercancel", cancelRef.current);
      }
    };
  }, []);

  // Mode-aware: handles both move and resize revert (fixes 2c + 2d).
  function installListeners(node: any, g: GestureState, charWidth: number, charHeight: number) {
    const revertGesture = () => {
      const store = useEditorStore.getState();
      if (g.mode === "resize") {
        node.scaleX(1);
        node.scaleY(1);
        node.width(g.startBbox.w * charWidth);
        node.height(g.startBbox.h * charHeight);
        store.resizeLayerCommit(g.layerId, g.startBbox);
      } else {
        store.moveLayerCommit(g.layerId, g.startBbox);
      }
      node.position({
        x: g.startBbox.col * charWidth,
        y: g.startBbox.row * charHeight,
      });
    };

    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !gestureRef.current?.active) return;
      e.stopPropagation();
      revertGesture();
      if (g.mode === "move") node.stopDrag();
      gestureRef.current = null;
      removeListeners();
    };
    const onCancel = () => {
      if (!gestureRef.current?.active) return;
      revertGesture();
      gestureRef.current = null;
      removeListeners();
    };
    const removeListeners = () => {
      window.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("pointercancel", onCancel);
      escapeRef.current = null;
      cancelRef.current = null;
    };

    window.addEventListener("keydown", onEscape, true); // capture phase
    window.addEventListener("pointercancel", onCancel);
    escapeRef.current = onEscape;
    cancelRef.current = onCancel;

    return removeListeners;
  }

  function onDragStart(layerId: string, node: any, charWidth: number, charHeight: number) {
    const layer = useEditorStore.getState().layers.find((l) => l.id === layerId);
    if (!layer) return;
    const g: GestureState = {
      layerId,
      startBbox: { ...layer.bbox },
      active: true,
      mode: "move",
      node,
    };
    gestureRef.current = g;
    // Trigger zundo snapshot-then-pause via a no-op live call
    useEditorStore.getState().moveLayerLive(layerId, layer.bbox);
    installListeners(node, g, charWidth, charHeight);
  }

  function onDragEnd(layerId: string, node: any, charWidth: number, charHeight: number) {
    if (!gestureRef.current?.active) return;
    const newCol = Math.round(node.x() / charWidth);
    const newRow = Math.round(node.y() / charHeight);
    const layer = useEditorStore.getState().layers.find((l) => l.id === layerId);
    if (!layer) return;
    useEditorStore.getState().moveLayerCommit(layerId, {
      row: newRow, col: newCol, w: layer.bbox.w, h: layer.bbox.h,
    });
    gestureRef.current = null;
    // Remove listeners
    if (escapeRef.current) {
      window.removeEventListener("keydown", escapeRef.current, true);
      escapeRef.current = null;
    }
    if (cancelRef.current) {
      window.removeEventListener("pointercancel", cancelRef.current);
      cancelRef.current = null;
    }
  }

  return { onDragStart, onDragEnd, gestureRef };
}
```

**Step 2: Wire drag into KonvaCanvas**

On each shape Rect (for rect layers only in v1):

```typescript
const { onDragStart, onDragEnd } = useGestureAdapter();

// On each Rect node:
draggable={l.id === selectedId && activeTool === "select" && !gestureRef.current?.active}
dragBoundFunc={(pos) => ({
  x: Math.round(pos.x / charWidth) * charWidth,
  y: Math.round(pos.y / charHeight) * charHeight,
})}
onDragStart={(e) => onDragStart(l.id, e.target, charWidth, charHeight)}
onDragEnd={(e) => onDragEnd(l.id, e.target, charWidth, charHeight)}
```

**Step 3: Verify**

Select a rect → drag it → snaps to grid. Characters update on
release. Undo (Cmd+Z) restores. Escape mid-drag reverts.

**Step 4: Commit**

```bash
git add src/useGestureAdapter.ts src/KonvaCanvas.tsx
git commit -m "feat: drag-to-move with grid snapping and zundo-safe lifecycle"
```

---

### Task 4: Transformer resize handles

**Files:**
- Modify: `src/KonvaCanvas.tsx`
- Modify: `src/useGestureAdapter.ts` (add resize mode)

**Step 1: Add resize to the gesture adapter**

Add `onTransformStart`/`onTransformEnd` to `useGestureAdapter`:

```typescript
function onTransformStart(layerId: string, node: any, charWidth: number, charHeight: number) {
  const layer = useEditorStore.getState().layers.find((l) => l.id === layerId);
  if (!layer) return;
  const g: GestureState = {
    layerId,
    startBbox: { ...layer.bbox },
    active: true,
    mode: "resize",
    node,
  };
  gestureRef.current = g;
  // Trigger zundo snapshot
  useEditorStore.getState().resizeLayerLive(layerId, layer.bbox);
  // installListeners is mode-aware: checks g.mode to reset scale on revert
  installListeners(node, g, charWidth, charHeight);
}

function onTransformEnd(layerId: string, node: any, charWidth: number, charHeight: number) {
  if (!gestureRef.current?.active) return;
  const scaleX = node.scaleX();
  const scaleY = node.scaleY();
  const newW = Math.max(1, Math.round((node.width() * scaleX) / charWidth));
  const newH = Math.max(1, Math.round((node.height() * scaleY) / charHeight));
  const newCol = Math.round(node.x() / charWidth);
  const newRow = Math.round(node.y() / charHeight);
  node.scaleX(1);
  node.scaleY(1);
  node.width(newW * charWidth);
  node.height(newH * charHeight);
  useEditorStore.getState().resizeLayerCommit(layerId, {
    row: newRow, col: newCol, w: newW, h: newH,
  });
  gestureRef.current = null;
  // Shared removeListeners — same as move, installed by installListeners
  if (escapeRef.current) {
    window.removeEventListener("keydown", escapeRef.current, true);
    escapeRef.current = null;
  }
  if (cancelRef.current) {
    window.removeEventListener("pointercancel", cancelRef.current);
    cancelRef.current = null;
  }
}
```

**Step 2: Add Transformer to KonvaCanvas**

```typescript
import { Transformer } from "react-konva";

const transformerRef = useRef<any>(null);
const shapeRefs = useRef<Map<string, any>>(new Map());

// Attach transformer to selected rect:
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

// After shape nodes:
<Transformer
  ref={transformerRef}
  rotateEnabled={false}
  keepRatio={false}
  enabledAnchors={[
    "top-left","top-right","bottom-left","bottom-right",
    "top-center","bottom-center","middle-left","middle-right"
  ]}
  boundBoxFunc={(oldBox, newBox) => {
    // Fix 5: anchor stationary edge to prevent wobble on left/top handles
    const snapped = { ...newBox };
    const rightStable = Math.abs((newBox.x + newBox.width) - (oldBox.x + oldBox.width)) < charWidth / 2;
    if (rightStable) {
      const right = oldBox.x + oldBox.width;
      snapped.x = Math.round(newBox.x / charWidth) * charWidth;
      snapped.width = right - snapped.x;
    } else {
      snapped.x = Math.round(newBox.x / charWidth) * charWidth;
      snapped.width = Math.max(charWidth, Math.round(newBox.width / charWidth) * charWidth);
    }
    const bottomStable = Math.abs((newBox.y + newBox.height) - (oldBox.y + oldBox.height)) < charHeight / 2;
    if (bottomStable) {
      const bottom = oldBox.y + oldBox.height;
      snapped.y = Math.round(newBox.y / charHeight) * charHeight;
      snapped.height = bottom - snapped.y;
    } else {
      snapped.y = Math.round(newBox.y / charHeight) * charHeight;
      snapped.height = Math.max(charHeight, Math.round(newBox.height / charHeight) * charHeight);
    }
    return snapped;
  }}
/>

// On each rect Rect node, add:
ref={(node) => { if (node) shapeRefs.current.set(l.id, node); else shapeRefs.current.delete(l.id); }}
onTransformStart={(e) => onTransformStart(l.id, e.target, charWidth, charHeight)}
onTransformEnd={(e) => onTransformEnd(l.id, e.target, charWidth, charHeight)}
```

**Step 2: Verify**

Select a rect → 8 handles. Drag a handle → rect resizes with grid
snap. Characters regenerate on release. Undo works. Escape reverts.

**Step 3: Commit**

```bash
git add src/KonvaCanvas.tsx src/useGestureAdapter.ts
git commit -m "feat: Transformer resize with grid snap and zundo-safe lifecycle"
```

---

## Phase 2: Toolbar and drawing tools

### Task 5: Toolbar component + tool state + keyboard shortcuts

**Files:**
- Create: `src/Toolbar.tsx`
- Modify: `src/App.tsx` (mount Toolbar, add keyboard listener)
- Modify: `src/store.test.ts` (add tool state tests)

**Step 1: Write failing tests for tool state**

Add to `src/store.test.ts`:

```typescript
describe("tool state", () => {
  beforeEach(() => useEditorStore.getState().reset());

  it("defaults to select tool", () => {
    expect(useEditorStore.getState().activeTool).toBe("select");
  });

  it("setActiveTool changes the active tool", () => {
    useEditorStore.getState().setActiveTool("rect");
    expect(useEditorStore.getState().activeTool).toBe("rect");
  });

  it("reset restores activeTool to select", () => {
    useEditorStore.getState().setActiveTool("eraser");
    useEditorStore.getState().reset();
    expect(useEditorStore.getState().activeTool).toBe("select");
  });

  // Fix 6: fileHandle tests
  it("setFileHandle stores a handle", () => {
    const fakeHandle = {} as FileSystemFileHandle;
    useEditorStore.getState().setFileHandle(fakeHandle);
    expect(useEditorStore.getState().fileHandle).toBe(fakeHandle);
  });

  it("reset clears fileHandle to null", () => {
    useEditorStore.getState().setFileHandle({} as FileSystemFileHandle);
    useEditorStore.getState().reset();
    expect(useEditorStore.getState().fileHandle).toBeNull();
  });
});
```

**Step 2: Run tests** → should pass (store already has activeTool + fileHandle)

**Step 3: Create `src/Toolbar.tsx`**

```typescript
import { ActionIcon, Group, Tooltip, Divider } from "@mantine/core";
import {
  IconPointer, IconSquare, IconMinus, IconLetterT,
  IconEraser, IconFileUpload, IconDeviceFloppy,
} from "@tabler/icons-react";
import { useEditorStore } from "./store";

const TOOLS = [
  { id: "select", icon: IconPointer, label: "Select (V)" },
  { id: "rect", icon: IconSquare, label: "Rectangle (R)" },
  { id: "line", icon: IconMinus, label: "Line (L)" },
  { id: "text", icon: IconLetterT, label: "Text (T)" },
  { id: "eraser", icon: IconEraser, label: "Eraser (E)" },
] as const;

export function Toolbar({
  onOpen,
  onSave,
}: {
  onOpen: () => void;
  onSave: () => void;
}) {
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);

  return (
    <Group gap="xs" p="xs" style={{ borderBottom: "1px solid #334155" }}>
      <Tooltip label="Open file (Cmd+O)" position="bottom">
        <ActionIcon variant="subtle" color="gray" size="lg" onClick={onOpen}>
          <IconFileUpload size={20} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Save file (Cmd+S)" position="bottom">
        <ActionIcon variant="subtle" color="gray" size="lg" onClick={onSave}>
          <IconDeviceFloppy size={20} />
        </ActionIcon>
      </Tooltip>
      <Divider orientation="vertical" />
      {TOOLS.map(({ id, icon: Icon, label }) => (
        <Tooltip key={id} label={label} position="bottom">
          <ActionIcon
            variant={activeTool === id ? "filled" : "subtle"}
            color={activeTool === id ? "burgundy" : "gray"}
            size="lg"
            onClick={() => setActiveTool(id)}
          >
            <Icon size={20} />
          </ActionIcon>
        </Tooltip>
      ))}
    </Group>
  );
}
```

**Step 4: Mount Toolbar in App.tsx + add keyboard shortcuts**

```typescript
import { Toolbar } from "./Toolbar";

// Inside App component:
const handleOpen = async () => { /* Task 10 */ };
const handleSave = async () => { /* Task 10 */ };

// Keyboard shortcuts:
useEffect(() => {
  const isMac = navigator.platform.includes("Mac");
  const handler = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement) return;
    const store = useEditorStore.getState();
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.key === "o") { e.preventDefault(); handleOpen(); return; }
    if (mod && e.key === "s") { e.preventDefault(); handleSave(); return; }
    // Tool shortcuts suppressed in text typing mode
    if (store.activeTool === "text") {
      if (e.key === "Escape") store.setActiveTool("select");
      return;
    }
    switch (e.key.toLowerCase()) {
      case "v": store.setActiveTool("select"); break;
      case "r": store.setActiveTool("rect"); break;
      case "l": store.setActiveTool("line"); break;
      case "t": store.setActiveTool("text"); break;
      case "e": store.setActiveTool("eraser"); break;
      case "escape": store.setActiveTool("select"); break;
      case "delete": case "backspace":
        if (store.activeTool === "select" && store.selectedId) {
          e.preventDefault();
          store.deleteLayer(store.selectedId);
        }
        break;
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, []);

// In return JSX:
<div className="toolbar-pane">
  <Toolbar onOpen={handleOpen} onSave={handleSave} />
</div>
```

**Step 5: Run tests, verify toolbar renders, shortcuts work**

Run: `npm test` → all pass
Press V, R, L, T, E → toolbar button highlights change.

**Step 6: Commit**

```bash
git add src/Toolbar.tsx src/App.tsx src/store.test.ts
git commit -m "feat: Toolbar with tool buttons, keyboard shortcuts, file open/save placeholders"
```

---

### Task 6: Rectangle drawing tool + `useToolHandlers` hook

**Files:**
- Create: `src/tools/stampRect.ts`
- Create: `src/tools/stampRect.test.ts`
- Create: `src/useToolHandlers.ts`
- Modify: `src/KonvaCanvas.tsx`

**Step 1: Write failing test for stampRect**

```typescript
import { describe, it, expect } from "vitest";
import { stampRect } from "./stampRect";

describe("stampRect", () => {
  it("stamps a 3x3 rect at origin", () => {
    const text = "          \n          \n          ";
    const result = stampRect(text, { row: 0, col: 0, w: 3, h: 3 });
    const lines = result.split("\n");
    expect(lines[0].slice(0, 3)).toBe("┌─┐");
    expect(lines[1][0]).toBe("│");
    expect(lines[1][2]).toBe("│");
    expect(lines[2].slice(0, 3)).toBe("└─┘");
  });

  it("stamps a rect at an offset", () => {
    const text = "          \n          \n          \n          ";
    const result = stampRect(text, { row: 1, col: 2, w: 4, h: 2 });
    const lines = result.split("\n");
    expect(lines[1].slice(2, 6)).toBe("┌──┐");
    expect(lines[2].slice(2, 6)).toBe("└──┘");
  });

  it("returns original text for rect < 2x2", () => {
    const text = "     ";
    expect(stampRect(text, { row: 0, col: 0, w: 1, h: 1 })).toBe(text);
  });

  it("pads only affected rows, not entire document", () => {
    const text = "ab\ncd\nef";
    const result = stampRect(text, { row: 0, col: 5, w: 3, h: 2 });
    const lines = result.split("\n");
    // Row 0 and 1 are padded to col 7 (5+3-1)
    expect(lines[0].length).toBeGreaterThanOrEqual(8);
    // Row 2 is NOT padded
    expect(lines[2]).toBe("ef");
  });
});
```

**Step 2: Run test → FAIL (module not found)**

**Step 3: Implement `src/tools/stampRect.ts`**

```typescript
import type { Bbox } from "../types";

/** Stamp a Unicode light rect's border characters into text.
 * Returns modified text. Only pads affected rows. */
export function stampRect(text: string, bbox: Bbox): string {
  const { row, col, w, h } = bbox;
  if (w < 2 || h < 2) return text;

  const lines = text.split("\n");
  // Ensure enough rows
  while (lines.length <= row + h - 1) lines.push("");

  const setChar = (r: number, c: number, ch: string) => {
    // Pad only this row if needed
    if (lines[r].length < c + 1) {
      lines[r] = lines[r] + " ".repeat(c + 1 - lines[r].length);
    }
    const arr = [...lines[r]];
    arr[c] = ch;
    lines[r] = arr.join("");
  };

  setChar(row, col, "┌");
  setChar(row, col + w - 1, "┐");
  setChar(row + h - 1, col, "└");
  setChar(row + h - 1, col + w - 1, "┘");
  for (let c = col + 1; c < col + w - 1; c++) {
    setChar(row, c, "─");
    setChar(row + h - 1, c, "─");
  }
  for (let r = row + 1; r < row + h - 1; r++) {
    setChar(r, col, "│");
    setChar(r, col + w - 1, "│");
  }

  return lines.join("\n");
}
```

**Step 4: Run test → PASS**

**Step 5: Create `src/useToolHandlers.ts`**

Single hook that dispatches mouse events to the active tool's handler.
Returns `{ onMouseDown, onMouseMove, onMouseUp, previewNode }` for
KonvaCanvas to wire into the Stage and render layer. Each tool's
logic is a private function inside the hook — easy to extract into
separate files later if needed.

```typescript
import { useState, useRef, type ReactNode } from "react";
import { Rect as KonvaRect } from "react-konva";
import { useEditorStore } from "./store";
import type { Bbox } from "./types";
import type { ToolId } from "./store";
import { pixelToCell } from "./grid";
import { stampRect } from "./tools/stampRect";

interface ToolHandlers {
  onMouseDown: (e: any) => void;
  onMouseMove: (e: any) => void;
  onMouseUp: () => void;
  previewNode: ReactNode;
}

export function useToolHandlers(
  activeTool: ToolId,
  charWidth: number,
  charHeight: number,
): ToolHandlers {
  // ── Rect tool state ──
  const [rectPreview, setRectPreview] = useState<Bbox | null>(null);
  const rectStartRef = useRef<{ row: number; col: number } | null>(null);

  // ── Dispatch ──
  function onMouseDown(e: any) {
    const stage = e.target.getStage?.();
    if (!stage) return;
    const isStage = e.target === stage;
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const cell = pixelToCell(pos.x, pos.y);

    if (activeTool === "rect" && isStage) {
      rectStartRef.current = cell;
      setRectPreview({ row: cell.row, col: cell.col, w: 1, h: 1 });
    }
    // Tasks 7-9 add line/text/eraser branches here
  }

  function onMouseMove(e: any) {
    const pos = e.target.getStage?.()?.getPointerPosition();
    if (!pos) return;
    const cell = pixelToCell(pos.x, pos.y);

    if (activeTool === "rect" && rectStartRef.current) {
      const s = rectStartRef.current;
      setRectPreview({
        row: Math.min(s.row, cell.row),
        col: Math.min(s.col, cell.col),
        w: Math.abs(cell.col - s.col) + 1,
        h: Math.abs(cell.row - s.row) + 1,
      });
    }
    // Tasks 7-9 add line/text/eraser branches here
  }

  function onMouseUp() {
    if (activeTool === "rect" && rectPreview) {
      if (rectPreview.w >= 2 && rectPreview.h >= 2) {
        const text = useEditorStore.getState().toText();
        const newText = stampRect(text, rectPreview);
        if (newText !== text) {
          useEditorStore.getState().loadFromText(newText);
        }
      }
      setRectPreview(null);
      rectStartRef.current = null;
    }
    // Tasks 7-9 add line/text/eraser branches here
  }

  // ── Preview nodes ──
  let previewNode: ReactNode = null;
  if (rectPreview) {
    previewNode = (
      <KonvaRect
        x={rectPreview.col * charWidth}
        y={rectPreview.row * charHeight}
        width={rectPreview.w * charWidth}
        height={rectPreview.h * charHeight}
        fill="transparent"
        stroke="#4a90e2"
        strokeWidth={1}
        dash={[4, 4]}
        listening={false}
      />
    );
  }

  return { onMouseDown, onMouseMove, onMouseUp, previewNode };
}
```

**Step 6: Wire into KonvaCanvas**

KonvaCanvas becomes a thin rendering shell. It delegates all
drawing-tool mouse events and preview rendering to `useToolHandlers`:

```typescript
const toolHandlers = useToolHandlers(activeTool, charWidth, charHeight);

<Stage
  onMouseDown={toolHandlers.onMouseDown}
  onMouseMove={toolHandlers.onMouseMove}
  onMouseUp={toolHandlers.onMouseUp}
  // ... existing onClick for deselect
>
  {/* Layer 1: grid */}
  {/* Layer 2: interactive shapes + gesture adapter */}
  <Layer>
    {/* ... shape nodes ... */}
    {toolHandlers.previewNode}
  </Layer>
</Stage>
```

**Step 7: Run full tests, visual verify, commit**

```bash
git add src/tools/stampRect.ts src/tools/stampRect.test.ts src/useToolHandlers.ts src/KonvaCanvas.tsx
git commit -m "feat: rectangle tool + useToolHandlers hook for drawing tool dispatch"
```

---

### Task 7: Line drawing tool

**Files:**
- Create: `src/tools/stampLine.ts`
- Create: `src/tools/stampLine.test.ts`
- Modify: `src/useToolHandlers.ts` (add line tool branch)

Same pattern as Task 6's rect. The `stampLine` function constrains to
the dominant axis (horizontal if `abs(dCol) >= abs(dRow)`, else
vertical), stamps `─` or `│` characters, minimum length 2.

Add line tool state and branches to `useToolHandlers` (same pattern
as rect: `useRef` for start cell, `useState` for preview, branches
in `onMouseDown`/`onMouseMove`/`onMouseUp`, preview node returned).

**Step 1: Tests**

```typescript
import { describe, it, expect } from "vitest";
import { stampLine } from "./stampLine";

describe("stampLine", () => {
  it("stamps a horizontal line", () => {
    const text = "          ";
    const result = stampLine(text, 0, 2, 0, 6);
    expect(result.slice(2, 7)).toBe("─────");
  });

  it("stamps a vertical line", () => {
    const text = "     \n     \n     \n     ";
    const result = stampLine(text, 0, 2, 3, 2);
    const lines = result.split("\n");
    for (let r = 0; r <= 3; r++) expect(lines[r][2]).toBe("│");
  });

  it("constrains diagonal to dominant axis", () => {
    const text = "          \n          ";
    const result = stampLine(text, 0, 0, 1, 5);
    expect(result.split("\n")[0].slice(0, 6)).toBe("──────");
  });

  it("discards single-cell line", () => {
    const text = "     ";
    expect(stampLine(text, 0, 2, 0, 2)).toBe(text);
  });
});
```

**Step 2: Implement, add to useToolHandlers, verify, commit**

```bash
git add src/tools/stampLine.ts src/tools/stampLine.test.ts src/useToolHandlers.ts
git commit -m "feat: line drawing tool — stamps horizontal/vertical lines"
```

---

### Task 8: Text tool

**Files:**
- Create: `src/tools/stampText.ts`
- Create: `src/tools/stampText.test.ts`
- Modify: `src/useToolHandlers.ts` (add text tool branch)

Text tool: click to place cursor, type to insert characters into a
local buffer, commit on Escape or click-away. On commit, call
`stampText(toText(), row, col, buffer)` → `loadFromText`.

The text tool's keyboard listener is managed inside `useToolHandlers`
(installed when text tool activates a cursor, removed on commit).

**Step 1: Tests**

```typescript
import { describe, it, expect } from "vitest";
import { stampText } from "./stampText";

describe("stampText", () => {
  it("writes characters at cursor position", () => {
    const text = "          \n          ";
    const result = stampText(text, 0, 3, "Hello");
    expect(result.split("\n")[0].slice(3, 8)).toBe("Hello");
  });

  it("overwrites existing characters", () => {
    const text = "XXXXXXXXXX";
    expect(stampText(text, 0, 2, "Hi")).toBe("XXHiXXXXXX");
  });

  it("pads row if text extends beyond current width", () => {
    const text = "ab";
    const result = stampText(text, 0, 5, "XY");
    expect(result.length).toBeGreaterThanOrEqual(7);
    expect(result[5]).toBe("X");
    expect(result[6]).toBe("Y");
  });
});
```

**Step 2: Implement, wire cursor/preview, verify, commit**

```bash
git add src/tools/stampText.ts src/tools/stampText.test.ts src/useToolHandlers.ts
git commit -m "feat: text tool — click to place cursor, type to insert characters"
```

---

### Task 9: Eraser tool

**Files:**
- Create: `src/tools/stampErase.ts`
- Create: `src/tools/stampErase.test.ts`
- Modify: `src/useToolHandlers.ts` (add eraser tool branch)

Eraser: drag across cells, write spaces. On mouseUp, call
`stampErase(toText(), cells)` → `loadFromText`.

**Step 1: Tests**

```typescript
import { describe, it, expect } from "vitest";
import { stampErase } from "./stampErase";

describe("stampErase", () => {
  it("replaces characters with spaces", () => {
    const text = "Hello\nWorld";
    const cells = [{ row: 0, col: 1 }, { row: 0, col: 2 }];
    expect(stampErase(text, cells).split("\n")[0]).toBe("H  lo");
  });

  it("no-ops on out-of-bounds cells", () => {
    expect(stampErase("Hi", [{ row: 5, col: 5 }])).toBe("Hi");
  });
});
```

**Step 2: Implement, wire red highlight preview, verify, commit**

```bash
git add src/tools/stampErase.ts src/tools/stampErase.test.ts src/useToolHandlers.ts
git commit -m "feat: eraser tool — drag to clear characters"
```

---

## Phase 3: File handling

### Task 10: File open, save, and reload

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/Toolbar.tsx` (add Reload button)

**NOTE:** `lastModifiedRef` and `lastWrittenTextRef` already exist in
App.tsx (applied in Fix 1/2). The autosave subscriber also already
exists with the skip-if-unchanged and lastModified-update logic.
This task adds Open, Save, and Reload. File watcher (polling for
external changes) is deferred — Reload covers the "Claude edited
my file" workflow without the autosave/watcher loop complexity.

**Step 1: Implement open handler**

Fix 1 ordering: set `lastModifiedRef` BEFORE `loadFromText` so the
autosave subscriber doesn't fire in between.

```typescript
const handleOpen = async () => {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
    });
    const file = await handle.getFile();
    const text = await file.text();
    // Fix 1: set lastModified BEFORE loadFromText to prevent
    // autosave from seeing the open as a "change" and writing back
    lastModifiedRef.current = file.lastModified;
    lastWrittenTextRef.current = text;
    // Reset before loading new file — clears layers to [],
    // which resets KonvaCanvas high-water mark for dynamic sizing
    useEditorStore.getState().reset();
    useEditorStore.getState().setFileHandle(handle);
    useEditorStore.getState().loadFromText(text);
  } catch (e) {
    // User cancelled — ignore
  }
};
```

**Step 2: Implement save handler**

Update `lastModifiedRef` after write to prevent watcher loop.

```typescript
const handleSave = async () => {
  let handle = useEditorStore.getState().fileHandle;
  if (!handle) {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: "wireframe.md",
        types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
      });
      useEditorStore.getState().setFileHandle(handle);
    } catch { return; }
  }
  const text = useEditorStore.getState().toText();
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  lastWrittenTextRef.current = text;
  // Update lastModified so reload knows what we last wrote
  const file = await handle.getFile();
  lastModifiedRef.current = file.lastModified;
};
```

**Step 3: Implement reload handler**

Re-reads the current file handle and reloads the canvas. This is the
manual alternative to a file watcher — the user presses Cmd+Shift+R
(or clicks the Reload button) after Claude or another editor modifies
the file.

```typescript
const handleReload = async () => {
  const handle = useEditorStore.getState().fileHandle;
  if (!handle) return;
  try {
    const file = await handle.getFile();
    const text = await file.text();
    lastModifiedRef.current = file.lastModified;
    lastWrittenTextRef.current = text;
    useEditorStore.getState().loadFromText(text);
  } catch (e) {
    console.error("Reload failed:", e);
  }
};
```

**Step 4: Add Reload button to Toolbar and keyboard shortcut**

In `src/Toolbar.tsx`, add a Reload button after Save:

```typescript
import { IconRefresh } from "@tabler/icons-react";

// Add onReload prop:
export function Toolbar({
  onOpen,
  onSave,
  onReload,
}: {
  onOpen: () => void;
  onSave: () => void;
  onReload: () => void;
}) {
  // ... existing code ...

  // After Save button:
  <Tooltip label="Reload file (Cmd+Shift+R)" position="bottom">
    <ActionIcon variant="subtle" color="gray" size="lg" onClick={onReload}>
      <IconRefresh size={20} />
    </ActionIcon>
  </Tooltip>
```

In App.tsx keyboard handler, add:

```typescript
if (mod && e.shiftKey && e.key === "r") {
  e.preventDefault(); handleReload(); return;
}
```

And pass to Toolbar:

```typescript
<Toolbar onOpen={handleOpen} onSave={handleSave} onReload={handleReload} />
```

**Step 5: Add tests (Fix 6)**

Note: `setFileHandle` and `reset` tests are already covered in Task 5's
"tool state" describe block. Do NOT duplicate them here. Only add the
autosave-specific tests below.

Add to `src/store.test.ts`:

```typescript
describe("autosave guards", () => {
  beforeEach(() => useEditorStore.getState().reset());

  it("toText is stable across selection changes", () => {
    // Verifies that non-text-affecting state changes don't produce
    // different toText output (which would trigger unnecessary writes)
    useEditorStore.getState().loadFromText("┌─┐\n│ │\n└─┘");
    const text1 = useEditorStore.getState().toText();
    useEditorStore.getState().selectLayer(
      useEditorStore.getState().layers[1]?.id ?? null
    );
    const text2 = useEditorStore.getState().toText();
    expect(text2).toBe(text1);
  });
});
```

**Step 6: Verify**

Open a `.md` file → renders on canvas. Draw a rect → autosaves.
Open the file in a text editor → see the new rect characters.
Edit the file externally → press Cmd+Shift+R → canvas updates.

**Step 7: Commit**

```bash
git add src/App.tsx src/Toolbar.tsx src/store.test.ts
git commit -m "feat: file open/save/reload with File System Access API"
```

---

**Note:** If `npx tsc -b` errors on `showOpenFilePicker` or
`FileSystemFileHandle`, add a `src/file-system.d.ts` with type
declarations for the File System Access API (Chrome 86+). The
project already uses `FileSystemFileHandle` in `store.ts` without
errors, so this is likely unnecessary with current TS lib settings.

---

## Phase 4: Polish and cleanup

### Task 11: CLAUDE.md for gridpad

**Files:**
- Create: `CLAUDE.md`

Write a CLAUDE.md that describes the new architecture:

```markdown
# CLAUDE.md

## What this project is

Gridpad is a visual ASCII wireframe editor. Open a .md file, see
shapes rendered on a Konva canvas, draw with MS-Paint-style tools.
Text is the source of truth — tools stamp characters, the scanner
derives layers.

## Architecture

Text (the document) ↔ Scanner → Layers (derived) → Konva renders
Drawing tools → stamp chars into text → loadFromText → scanner
Move/resize → mutate layers → toText → autosave to file

## Stack

Vite + React 19 + TypeScript + Konva + react-konva + Mantine v9 +
Zustand + Zundo + Vitest

## Key files

- src/scanner.ts — parses ASCII text into shapes
- src/layers.ts — layer model, compositing, mutations
- src/diff.ts — identity-preserving diff pass
- src/store.ts — zustand store (no CodeMirror)
- src/KonvaCanvas.tsx — Konva Stage with grid + interactive shapes
- src/Toolbar.tsx — tool buttons
- src/tools/ — stamp helpers (stampRect, stampLine, etc.)
- src/grid.ts — cell measurement constants
- src/LayerPanel.tsx — layer tree panel

## Commands

npm run dev — start dev server
npm test — run vitest
npm run build — production build
```

**Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md with project architecture"
```

---

### Task 12: Final verification

Run: `npm test` → all pass
Run: `npm run build` → succeeds
Run: `npm run dev` → open browser

Walk through:
- [ ] Open a .md file
- [ ] Characters render on canvas
- [ ] Click a shape → selects
- [ ] Drag a shape → grid-snapped move
- [ ] Resize a rect → grid-snapped resize
- [ ] Draw a rect with R tool
- [ ] Draw a line with L tool
- [ ] Type text with T tool
- [ ] Erase with E tool
- [ ] Keyboard shortcuts work (V, R, L, T, E, Escape, Delete)
- [ ] Autosave → file updates
- [ ] External edit → canvas reloads
- [ ] Undo/redo covers all actions
- [ ] Layer panel shows all shapes
- [ ] Groups, visibility, reparent all work
