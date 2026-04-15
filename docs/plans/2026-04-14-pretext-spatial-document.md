# Pretext Spatial Document — Execution Plan

**Goal:** Replace the monolithic Konva canvas with a Pretext-powered spatial document renderer where prose text flows around interactive wireframe canvases on a single HTML5 Canvas, with live reflow during drag/resize at 60fps.

---

1. **The document model splits a markdown file into alternating regions.** The scanner already detects rects/lines — a new `detectRegions(scanResult, grid)` function groups shapes whose bounding boxes are within 2 rows of each other into a single "wireframe region" (row range). Everything outside wireframe regions is a "prose region." The output is `Region[]` where each region is `{ type: 'prose' | 'wireframe', startRow, endRow, text, layers? }`. A file with prose, then a wireframe, then more prose produces three regions. Prose regions carry the raw text slice; wireframe regions carry their layers (existing layer model unchanged).

2. **A single full-width HTML5 Canvas renders the entire document.** No DOM text elements, no Konva Stage. One `<canvas>` element fills the viewport. The render loop: for each region top-to-bottom, if prose → Pretext lays out text and `fillText` draws it; if wireframe → draw box-drawing characters and interactive shapes. Both share the same canvas context and coordinate system — no hybrid DOM/canvas sync issues. Scroll is a simple y-offset applied to all drawing.

3. **Pretext handles all prose text layout.** For each prose region, `prepareWithSegments(text, font)` runs once (cached until text changes). `layoutWithLines(prepared, canvasWidth, lineHeight)` produces positioned lines. The render loop calls `ctx.fillText(line.text, x, line.y - scrollY)` per line. Because Pretext's layout is pure arithmetic over cached measurements, re-layout at a new width (window resize) costs <1ms for typical documents.

4. **Wireframe regions render on the same canvas using the existing glyph atlas + layer compositor.** `compositeLayers(region.layers)` produces the sparse cell map; `buildSparseRows(composite)` produces draw commands. The wireframe's pixel origin is `(0, regionTopY - scrollY)` where `regionTopY` is the cumulative height of all regions above it. The glyph atlas `drawImage` path renders box-drawing characters; the `fillText` fallback handles ASCII.

5. **Interactive wireframes use hit-testing on the single canvas instead of Konva.** On `mousedown`, check if the click falls within a wireframe region, then test against layer bboxes (pixel coords → grid coords via `pixelToCell`). Selected shapes get a blue stroke overlay. Drag snaps to grid (existing `snapToGrid` logic). Resize uses anchor hit zones at corners/edges of selected rect. This replaces the 2,000+ React `InteractiveShape` components with a single event handler + coordinate math — the core performance fix.

6. **Text reflows around wireframes in real time during drag.** When a wireframe region's height changes (user resizes a box taller), all regions below shift down. Pretext makes this cheap: the prose `PreparedTextWithSegments` are already cached, only `layoutWithLines` re-runs at the same width to get new y-positions. A `requestAnimationFrame` render loop re-draws the visible portion. Target: <2ms per frame for a 300-line document.

7. **Text editing in prose regions uses a minimal cursor system.** Click in a prose region → show a blinking cursor (drawn as a 1px line on canvas). Keyboard input inserts characters into the region's text string, `prepareWithSegments` re-runs for that region only, layout recomputes, canvas redraws. Selection is a highlighted rect range computed from Pretext's `LayoutCursor` positions. Copy/paste uses the clipboard API. This is the most complex new code but scoped to basic monospace editing — no rich text, no IME (v1).

8. **Autosave stitches regions back into a single markdown string.** Walk regions in order: prose regions contribute their text verbatim; wireframe regions contribute `layerToText(region.layers)`. Join with newlines. Write to file handle (existing debounced autosave logic).

9. **The existing scanner, layer model, and gesture math carry over unchanged.** `scan()`, `proposalsFromScan()`, `compositeLayers()`, `buildSparseRows()`, `moveLayer()`, `regenerateCells()`, `buildLineCells()`, `snapToGrid()`, `pixelToCell()`, the glyph atlas — all reused. What's deleted: `KonvaCanvas.tsx` (the monolithic Konva component), `InteractiveLayer`, `InteractiveShape`, `TextLayer`, react-konva dependency, and the `useGestureAdapter` hook (replaced by direct canvas event handlers).

10. **Milestone order:** (a) Region detection from scan results — test with real plan files, verify correct prose/wireframe splitting. (b) Canvas renderer — Pretext prose + glyph-atlas wireframes on a single canvas, read-only, scrollable. (c) Wireframe interaction — click to select, drag to move, resize handles. (d) Prose text editing — cursor, typing, selection, backspace/delete. (e) Autosave round-trip — edit prose, resize wireframe, save, reload, verify.

---

| File | Change |
|------|--------|
| `src/regions.ts` | **New.** `detectRegions(scanResult, grid)` → `Region[]` |
| `src/regions.test.ts` | **New.** Tests for region detection with real plan files |
| `src/SpatialCanvas.tsx` | **New.** Single-canvas renderer: Pretext prose + wireframe regions + scroll + interaction |
| `src/canvasInteraction.ts` | **New.** Hit testing, drag, resize on canvas (replaces Konva + useGestureAdapter) |
| `src/proseCursor.ts` | **New.** Text cursor, selection, keyboard input for prose regions |
| `src/store.ts` | Modify `loadFromText` to produce regions; `toText` to stitch regions back |
| `src/App.tsx` | Swap `<KonvaCanvas />` for `<SpatialCanvas />` |
| `src/grid.ts` | Unchanged (glyph atlas, cell measurement, constants) |
| `src/scanner.ts` | Unchanged (scan, proposalsFromScan) |
| `src/layers.ts` | Unchanged (compositeLayers, layerToText, moveLayer, etc.) |
| `src/diff.ts` | Unchanged |
| `package.json` | Add `@chenglou/pretext`, remove `react-konva`, `konva` |

**What does NOT change:** Scanner, layer model, diff pass, glyph atlas, grid constants, cell measurement. The entire wireframe detection and layer mutation pipeline is preserved. Pretext replaces the text rendering path; direct canvas events replace Konva's React component tree.
