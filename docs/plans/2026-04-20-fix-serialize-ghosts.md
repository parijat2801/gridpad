# Fix Serialize Ghosts — 3 Root Causes

**Goal:** Fix 65+ e2e failures (ghosts, frame count changes, non-convergence) caused by three bugs in the grid-based serialization pipeline.

## Root Causes (empirically verified)

1. **Container bboxes not snapshotted** — `snapshotFrameBboxes` skips frames with `content===null`. Container frames cover gaps between children (column separators, shared junction rows). When a wireframe moves, Phase A doesn't blank these gap cells → ghosts.

2. **Phase B write-order destroys sibling text** — `writeFrameToGrid` processes siblings sequentially, each blanking its own bbox before writing. Later siblings erase text written by earlier siblings when they share overlapping grid rows (e.g., junction sub-rects).

3. **resizeFrame doesn't constrain children** — Shrinking a parent rect leaves children overflowing the new boundary. Overflowing cells create junction artifacts on serialization, and the scanner sees different shapes on reload.

## Tasks

### Task 1: Include containers in snapshotFrameBboxes

**Files:** `src/gridSerialize.ts`

**Change:** In `snapshotFrameBboxes`, add container frames (content===null) to the snapshot. They have no cells but their bbox covers the full wireframe footprint. Phase A will then blank the entire wireframe area at the old position.

**Implementation:** Remove the `if (f.content)` guard, or add the container bbox unconditionally before the guard. Container frames have valid x/y/w/h from `groupIntoContainers`.

**Tests:**
- Snapshot of junction fixture includes the container bbox
- Dashboard dragged 50px right produces zero ghosts
- Dashboard dragged 80px down produces zero ghosts
- CRM-simple dragged right produces zero ghosts after reload

### Task 2: Fix Phase B write-order — collect all cells, write once

**Files:** `src/gridSerialize.ts`

**Change:** Instead of blanking+writing per frame in `writeFrameToGrid`, collect ALL dirty frame cells into a map first, then blank all dirty bboxes at once, then write all collected cells. This prevents later siblings from erasing earlier siblings' text cells.

**Implementation:** Split `writeFrameToGrid` into two passes:
- Pass 1 (`collectFrameCells`): Walk frame tree, collect all cells that need writing into a Map<"row,col", char>. Also collect all bboxes that need blanking.
- Pass 2: Blank all collected bboxes, then write all collected cells.

**Tests:**
- Junction fixture resize-larger preserves all 8 content frames after reload
- Junction fixture resize-larger output contains "Bottom L" and "Bottom R" text

### Task 3: Clip children to parent bounds during serialization

**Files:** `src/gridSerialize.ts`

**Change:** In the cell-collection pass (from Task 2), clip child frame cells to the parent rect's bounding box. Cells that fall outside the parent's grid bbox are dropped.

**Implementation:** `collectFrameCells` receives the parent's grid bbox as a clipping rect. Children's cells are only collected if they fall within the clip rect. Top-level frames have no clip (full grid).

**Tests:**
- Nested fixture resize-smaller preserves 4 content frames after reload (not 6)
- Nested fixture resize-smaller output has no junction artifacts (no `┤` where `┐` should be)

## Verification

After all 3 tasks:
- `npm test` (337+ unit tests) all pass
- `npx playwright test e2e/harness.spec.ts` (125 tests) all pass
- Re-run diagnostic.test.ts — all 18 tests pass
- Significant reduction in `npx playwright test e2e/` failures (target: <20 remaining from 71)

## What does NOT change

- Scanner, layers, autoLayout, reflowLayout, frameRenderer, grid, DemoV2
- The no-edit round-trip path (Phase C prose writing)
- The undo/redo system
- The dirty flag propagation logic in editorState.ts
