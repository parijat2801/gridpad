# Layers as Source of Truth

**Goal:** Drawing tools create layers directly (no scanner round-trip), eraser removes cells from existing layers, composite is memoized — scanner only runs on file import.

## Review fixes (Codex review, 2026-04-14)

- Fix 1: `addLayer` computes z among same-parent siblings (not global max) to preserve correct stacking within groups.
- Fix 2: `eraseCells` builds a cell→owner map via `compositeLayers`-style DFS (respecting parentId, visibility, z-order) instead of flat z-sort — guarantees erasing the visually topmost layer.
- Fix 3: `eraseCells` clones each affected Layer object and its cells Map before mutating — preserves zundo history snapshots and useMemo cache validity.
- Fix 4: After erasing cells from a text layer, recompute `content` from remaining cells (join chars left-to-right by column order).
- Fix 5: New layers are always top-level (`parentId: null`); z computed among root siblings only.
- Fix 6: Build the cell→owner map in one DFS pass (O(total cells)), then apply deletions by map lookup — avoids O(erasedCells × layers).

---

1. **`addLayer` store action.** `addLayer(layer: Omit<Layer, "id" | "z">)` appends with `id = randomId()` and z computed as `max(z of siblings with same parentId) + 1` (defaults to 1 if no siblings). New layers always have `parentId: null` (top-level); grouping happens separately via existing `reparentLayer`. One `set({ layers: [...layers, newLayer] })` call — zundo captures it. No scan, no diff.

2. **`eraseCells` store action.** `eraseCells(cellKeys: string[])` builds a `Map<cellKey, layerId>` using a `compositeLayersWithOwnership` helper (same DFS as `compositeLayers` but stores which layer painted each cell). For each erased cellKey, looks up the owning layer, clones that layer's object and its cells `Map` (fix 3), deletes the cell from the clone. After all deletions: recomputes bbox for each affected layer via `recomputeBbox`; for text layers, recomputes `content` from remaining cells sorted by column (fix 4); removes layers with zero cells. One `set()` with the new layers array.

3. **`compositeLayersWithOwnership` in `src/layers.ts`.** Same parent/child DFS as `compositeLayers` but returns `Map<string, { char: string; layerId: string }>` — each cell maps to both its character and the layer that painted it. This is the single source of truth for "which layer is visually topmost at this cell" (fix 2, fix 6).

4. **`buildLineCells` helper in `src/layers.ts`.** Takes `(r1, c1, r2, c2)` → returns `{ bbox, cells: Map<string, string> }`. Constrains to dominant axis (same logic as `stampLine`), fills cells with `─` or `│`.

5. **`buildTextCells` helper in `src/layers.ts`.** Takes `(row, col, buffer: string)` → returns `{ bbox, cells, content }`. Filters to printable ASCII + box-drawing. Each character gets a cell entry at `(row, col+i)`. Returns filtered string as `content`.

6. **`useToolHandlers` stops calling `loadFromText`.** Rect tool: `store.addLayer({ type: "rect", bbox, cells: regenerateCells(bbox, LIGHT_RECT_STYLE), style: LIGHT_RECT_STYLE, visible: true })` where `LIGHT_RECT_STYLE` is a constant. Line tool: `store.addLayer(...)` with `buildLineCells` output. Text tool: `store.addLayer(...)` with `buildTextCells` output. Eraser tool: `store.eraseCells(cellKeys)` where cellKeys are `"row,col"` strings. All four drop `stampX` imports.

7. **`compositeLayers` memoization in `KonvaCanvas`.** `useMemo(() => compositeLayers(layers), [layers])`. Zustand replaces the array reference on every mutation, so memo invalidates correctly. Eliminates re-compositing during selection changes, tool switches, viewport updates.

8. **`loadFromText` stays unchanged.** Scan → diff → rebuild. Only called from `handleOpen` and `handleReload`. Scanner fragility contained to file import.

9. **`toText` stays unchanged.** `layerToText` composites and serializes. Autosave writes `toText()` to disk.

10. **`recomputeBbox` helper.** Iterates cell keys, returns `{ row: minR, col: minC, w: maxC-minC+1, h: maxR-minR+1 }`. Returns `{ row: 0, col: 0, w: 0, h: 0 }` for empty maps (caller should remove the layer instead).

---

| File | Change |
|------|--------|
| `src/store.ts` | Add `addLayer`, `eraseCells` actions |
| `src/layers.ts` | Add `compositeLayersWithOwnership`, `buildLineCells`, `buildTextCells`, `recomputeBbox`; export `LIGHT_RECT_STYLE` |
| `src/useToolHandlers.tsx` | Replace `stampX` → `loadFromText` with `addLayer`/`eraseCells`; drop stamp imports |
| `src/KonvaCanvas.tsx` | `useMemo` on `compositeLayers` |
| `src/store.test.ts` | Tests for `addLayer`, `eraseCells`, bbox recomputation |
| `src/layers.test.ts` | Tests for `buildLineCells`, `buildTextCells`, `recomputeBbox`, `compositeLayersWithOwnership` |

**What does NOT change:** `src/scanner.ts`, `src/diff.ts`, `src/identity.ts`, `src/groups.ts`, `src/grid.ts`, `src/App.tsx`, `src/Toolbar.tsx`, `src/useGestureAdapter.ts`, `src/LayerPanel.tsx`. The stamp functions in `src/tools/` become unused — delete them and their tests after migration.
