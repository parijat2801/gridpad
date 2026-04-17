# Phase 2: Serialization & State Coherence

**Goal:** Fix fragile mutation detection and stale region/proseParts state.

*Depends on Phase 1 (recursive delete must work before dirty tracking can mark containers on child deletion).*

1. `childrenHaveMoved` in `serialize.ts:146-183` uses a heuristic that only detects downward movement (`minRow > 0`). Horizontal moves, resizing, child additions, and child deletions are all missed. Replace with a `dirty: boolean` flag on `Frame` (default `false`). Every mutation effect in `framesField.update` — `moveFrameEffect`, `resizeFrameEffect`, `addFrameEffect`, `deleteFrameEffect`, `editTextFrameEffect`, `setTextAlignEffect` — sets `dirty = true` on the mutated frame itself. For child mutations, also walk up to mark the top-level container dirty (since `framesToMarkdown` at serialize.ts:61 checks `childrenHaveMoved(frame, ...)` on the root wireframe frame, not on individual children). For top-level frame mutations (move/resize of the wireframe container itself), mark the frame directly — Codex flagged that the original plan missed this case. `childrenHaveMoved` becomes `return container.dirty`. Delete the 40-line deliberation comment block (serialize.ts:112-145).

2. Add `clearDirtyEffect` to `editorState.ts`. After `framesToMarkdown` succeeds in `saveToHandle` (DemoV2.tsx:200), dispatch `clearDirtyEffect` to reset all dirty flags. This ensures re-saving an unchanged file is a no-op. The save path is `saveToHandle` (DemoV2.tsx:200) called from `scheduleAutosave` (DemoV2.tsx:215) and Cmd+S (DemoV2.tsx:651) — both paths converge on `saveToHandle`, so a single `clearDirtyEffect` dispatch there covers all cases.

3. `regionsField` and `prosePartsField` (editorState.ts:161-179) are set once at init and never updated. `rebuildProseParts` (editorState.ts:293) re-slices the doc against stale `region.startRow` boundaries — if lines are added/removed, splits break. Fix: after prose edits that change line count (Enter key → `splitLine`, Backspace at line start → `mergeLines`), recompute both regions AND proseParts together and dispatch both `setRegionsEffect` and `setProsePartsEffect`. DemoV2 does not currently import `detectRegions` — add the import from `regions.ts`. Note: this fix is scoped to Enter/Backspace; future paste/cut/multi-line operations would also need this, but those features don't exist yet.

4. The `dirty` flag survives undo/redo automatically: `invertedEffects` (editorState.ts:223-237) snapshots the full `Frame[]` before each transaction, and `dirty` is a field on Frame. Add test: mutate a child, undo, verify `dirty` is false on the restored frame.

| File | Changes |
|------|---------|
| `src/frame.ts` | Add `dirty: boolean` to `Frame` interface, default `false` in all `create*` factories |
| `src/editorState.ts` | Mark frame/container dirty on mutations; add `clearDirtyEffect`; export `setRegionsEffect` and `setProsePartsEffect` |
| `src/serialize.ts` | Replace `childrenHaveMoved` heuristic with `container.dirty`; delete comment block |
| `src/DemoV2.tsx` | Dispatch `clearDirtyEffect` in `saveToHandle`; recompute regions+proseParts after line-count-changing edits |
| `src/serialize.test.ts` | Tests for dirty-based mutation detection |
| `src/editorState.test.ts` | Tests for dirty flag propagation, container marking, and undo |

**What does NOT change:** `scanner.ts`, `reflowLayout.ts`, `frameRenderer.ts`, `grid.ts`, `layers.ts`.
