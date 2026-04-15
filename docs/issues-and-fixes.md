# Gridpad: Issues and Fixes

Findings from a full codebase audit (April 2026). Ordered by severity.
Performance claims (proseCursor, global reflow) were investigated and
disproven — 50-250x headroom at current document sizes. Not listed here.

---

## P0 — App doesn't work as an editor

### Save path is missing — wireframe edits are silently lost

`saveToHandle` writes `proseRef.current` (prose text only). `framesRef.current`
— which holds all drag, resize, and newly-drawn shapes — is never serialized.
Users lose all wireframe edits on save/reopen.

The journey tests document this explicitly:
- `"CRITICAL GAP: save after drag should persist wireframe position"` (journey.test.ts:408)
- `"The save path (framesToMarkdown) DOES NOT EXIST YET"` (journey.test.ts:13)

**Fix:** Build `framesToMarkdown`. Frame cells are already grid-coordinate maps,
so this is `buildSparseRows` per frame positioned at `Math.round(x/charWidth)`,
stitched with prose regions. The journey tests contain two prototype
implementations that can serve as a starting point.

### Junction characters (├┬┤┴┼) destroyed on drag

`regenerateCells` produces canonical corners (`┌┐└┘`) only. When a rect sharing
a wall is dragged, junction characters at the shared border are erased. This is
documented in harness.test.ts with `applyDragBuggy` vs `applyDragFixed`.

**Fix:** Edit the original text as a character grid (erase old position, write
new) rather than regenerating from style. This is also required for the save
path — both problems share the same root cause (no grid-level editing).

---

## P1 — Overlap and z-order

These three issues are related and should be fixed together.

### No z-order on frames

Frame has no `z` field. Frames render in array order, which is arbitrary after
drag operations.

### No background fill — overlapping frames produce character soup

The renderer calls `fillText` with no background clear. Two frames at the same
position paint both sets of characters on top of each other.

### Hit testing ignores z-order

`hitTestFrames` picks the smallest matching frame, not the topmost. When frames
overlap, clicks should go to the highest-z frame.

**Fix (all three):** Add `z: number` to Frame. Sort by z before painting. Paint
a background `fillRect` behind each frame's content before drawing characters.
Change hit test to iterate in reverse z-order and return first hit.

---

## P2 — Dead code (~850 lines production, ~450 lines tests)

These are all related — the Layer model was replaced by Frame but never removed.

### diff.ts and identity.ts are unreachable

`diffLayers` (Hungarian matching) and `contentAddressedId` (FNV-32a hashing)
are only imported by test files. They operate on the Layer type which doesn't
exist at runtime. They can't be reused for Frame — wrong data structure
(flat list with parentId vs nested children tree, grid coords vs pixels,
content-addressed IDs vs random IDs).

### Layer mutation functions are unreachable

`moveLayer`, `moveLayerCascading`, `deleteLayer`, `toggleVisible`,
`compositeLayers`, `compositeLayersWithOwnership`, `layerToText`,
`isEffectivelyVisible`, `recomputeBbox`, `buildTextCells` — all only imported
by test files. The app uses Frame equivalents (`moveFrame`, `replaceFrame`,
`resizeFrame`) instead.

### Region type carries Layer[] for no reason

`Region.layers?: Layer[]` is the only reason the Layer type flows through
runtime code. `detectRegions` calls `buildLayersFromScan`, then
`framesFromRegions` immediately converts those layers to frames and discards
them. Layer is a transient intermediate that doesn't need its own type.

### detectRegions and framesFromRegions are split awkwardly

Two functions that always run together, connected by Layer as unnecessary glue.
`detectRegions` does grid-space work, `framesFromRegions` converts to pixels.

**Fix (all four):** Delete `diff.ts`, `identity.ts`, their tests, and all unused
functions from `layers.ts`. Keep only cell-generation utilities
(`regenerateCells`, `buildLineCells`, `extractRectStyle`) and `LIGHT_RECT_STYLE`.
Replace `buildLayersFromScan` with a simpler intermediate struct
(`{ type, bbox, cells, style?, content? }`). Consider merging into a single
`scanToFrames(text, charWidth, charHeight)` function.

---

## P3 — DemoV2 complexity blocks future features

### DemoV2.tsx exceeds size targets

556 lines (CLAUDE.md target: 300). `onKeyDown` is 145 lines (target: 60).
18 refs, 9 `framesRef.current` mutation sites, 4 `proseRef.current` mutation
sites. No centralized state management.

### No undo/redo

zustand + zundo were previously in the project and deliberately removed.
Currently 13 mutation sites are fire-and-forget. No history, no snapshots,
no command pattern.

**Fix (both):** Extract an `EditorState` type and `dispatch(action)` reducer
from DemoV2. Each mutation site becomes a dispatched action. DemoV2 shrinks to
event wiring + canvas JSX. Undo becomes a history stack of states pushed on
each dispatch.

---

## P4 — Minor hygiene

### Duplicated canvas mock across 4 test files

Identical 20-line `beforeAll` block in harness.test.ts, corpus.test.ts,
journey.test.ts, reflowLayout.test.ts. Values are consistent with grid.ts
(`FALLBACK_CHAR_WIDTH = 9.6`, computed height 18.4), but if the mock changes,
4 files need updating.

**Fix:** Extract to a shared vitest setup file.
