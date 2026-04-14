# Gridpad Performance Optimization

**Goal:** Eliminate the rendering bottleneck — sceneFunc currently iterates 4,000+ cells and calls fillText 40+ times per render, even when nothing changed. Target: <2ms render for typical edits.

**Sequencing rationale:** Fix *when* we render before *how* we render. The split (#1) eliminates ~80% of unnecessary sceneFunc executions (selection changes, tool switches, mousemove previews all currently trigger it). Memoization (#2) is a trivial companion change. Caching (#3) makes even the necessary redraws cheap. Only then does optimizing the sceneFunc body (#4, #5) matter — it runs far less often after 1–3.

---

1. **Split KonvaCanvas into TextLayer + InteractiveLayer components.** Currently one component subscribes to `layers`, `selectedId`, `activeTool`, and `viewport` — any change re-renders everything including the sceneFunc. Extract `<TextLayer>` (subscribes only to `layers`, owns composite + sceneFunc) and `<InteractiveLayer>` (subscribes to `layers`, `selectedId`, `activeTool`, renders hit-target Rects/Lines + Transformer + preview). When `selectedId` changes, only InteractiveLayer re-renders; TextLayer's sceneFunc is untouched. Wrap both in `React.memo`. This is the highest-impact single change because the sceneFunc currently re-executes on every selection change, tool switch, and preview mousemove — none of which affect the text grid.

2. **Memoize derived values.** Grid bounds (lines 54–60), `byId` map (line 79), and `visibleLayers` filter (lines 80–82) all recompute on every render. Wrap each in `useMemo(() => ..., [composite])` or `useMemo(() => ..., [layers])`. Cost: 3 lines changed; eliminates O(cells) string parsing + O(layers) Map construction per render. Do this alongside the split — trivial companion change.

3. **Cache the text Shape node.** After splitting, the TextLayer's Konva Shape can be cached via `shapeRef.current.cache()` in a `useEffect([composite])`. Konva renders the sceneFunc once to an offscreen bitmap; subsequent Layer redraws blit the bitmap instead of re-executing sceneFunc. Call `clearCache()` then `cache()` only when composite changes. Depends on #1 (split) — without the split, the text Layer shares a Konva Stage with the interactive Layer and cache invalidation is unreliable.

4. **Sparse row rendering in sceneFunc.** Now that sceneFunc runs less often (only on layer changes, not on selection/tool/preview), make each execution faster. The inner loop iterates `effectiveRows × effectiveCols` (min 40×100 = 4,000 Map lookups) including entirely blank rows. Instead: group composite entries by row into a `Map<number, string[]>`, draw only rows that contain at least one character, and only span from the row's min-col to max-col. The Stage's `style={{ background: BG_COLOR }}` already fills blank regions — no visual change. Cuts fillText calls from 40+ to the number of occupied rows (typically 5–15).

5. **Glyph atlas replaces fillText.** `fillText` is the single most expensive Canvas API call (font shaping + glyph rasterization per invocation). Build a glyph atlas at startup: render every printable ASCII char (32–126) plus box-drawing range (U+2500–U+257F) onto a single offscreen canvas, one glyph per cell at `charWidth × charHeight`. In sceneFunc, replace `ctx.fillText(line, ...)` with per-character `ctx.drawImage(atlas, sx, sy, charWidth, charHeight, dx, dy, charWidth, charHeight)` — drawImage from a pre-rasterized source skips font shaping entirely. Measured speedup from research: 5–10× for text-heavy rendering (Miro engineering, xterm.js, canvas-fill-text-opt benchmarks). Only worth the effort after #1–4 reduce how often sceneFunc runs.

6. **Share composite with autosave.** `toText()` (called from App.tsx autosave) internally calls `compositeLayers()` — a second O(all-cells) pass. Instead: store the last composite in a module-level ref (`_lastComposite`) updated by the TextLayer's useMemo. Export a `getLastComposite()` function; `layerToText` uses it when available, falls back to recomputing. Depends on #1 (split gives us the TextLayer that owns the composite).

7. **Stabilize callback references.** Every render creates new `dragBoundFunc`, `onClick`, `onDragStart`, `onDragEnd`, `onTransformStart`, `onTransformEnd` closures for each visible layer. These cause react-konva to re-apply event handlers. Lift `dragBoundFunc` to a stable factory (`const snapPos = useCallback((pos) => ({ x: Math.round(pos.x/charWidth)*charWidth, ... }), [charWidth, charHeight])`). Extract per-layer callbacks into a memoized `<InteractiveShape>` component that receives `layer`, `selected`, `charWidth`, `charHeight` as props and wraps in `React.memo`. Independent of other tasks.

8. **Allow high-water mark to shrink.** Currently the grid never shrinks once expanded (highWaterRef grows only). Add a 2-second debounced shrink: after layers change, if contentRows/contentCols are smaller than the high-water mark for 2 seconds, reduce it. Prevents the sceneFunc from iterating dead rows/cols after content deletion. Lowest priority — only matters for large-then-small documents.

---

| File | Change |
|------|--------|
| `src/KonvaCanvas.tsx` | Split into `TextLayer`, `InteractiveLayer`, `InteractiveShape`; add useMemo for bounds/byId/visibleLayers; stabilize callbacks; shrinkable high-water mark |
| `src/grid.ts` | Add `buildGlyphAtlas()`, `getGlyphAtlas()` |
| `src/layers.ts` | Add `_lastComposite` ref + `getLastComposite()` export; `layerToText` uses cached composite when available |
| `src/useToolHandlers.tsx` | No change (preview node stays as-is) |
| `src/store.ts` | No change |
| `src/App.tsx` | No change |

**What does NOT change:** `src/scanner.ts`, `src/diff.ts`, `src/identity.ts`, `src/groups.ts`, `src/store.ts`, `src/useToolHandlers.tsx`, `src/useGestureAdapter.ts`, `src/Toolbar.tsx`, `src/LayerPanel.tsx`. The store shape, layer model, tool event flow, and autosave mechanism are unchanged — this is purely a rendering optimization.

**Invariant verification:** (1) Component split passes composite via useMemo, not stale cache — composite always matches current layers. (2) Sparse rendering uses Stage background for blank areas — no visual change. (3) Glyph atlas uses the same charWidth/charHeight from measureCellSize — spacing identical. (4) Shared composite updates on every layers change via useMemo — autosave never sees stale data. (5) High-water shrink is debounced — no flicker during rapid edits.

**Dependency graph:**
```
#1 Split ──→ #3 Cache Shape
         ──→ #6 Share composite
#2 Memoize (companion to #1, do together)
#4 Sparse rows (independent, best after #1)
#5 Glyph atlas (independent, best after #4)
#7 Stable callbacks (independent)
#8 Shrinkable high-water (independent)
```
