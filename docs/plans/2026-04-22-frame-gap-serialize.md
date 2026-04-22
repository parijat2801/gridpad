# Frame-Gap Serialization

**Goal:** Replace `gridSerialize`'s Phase C prose row assignment (proseSegmentMap + dirty-path reflow heuristic) with frame-gap derivation — top-level frames define where wireframes go; prose fills the gaps. No new data structure, no region tracking, no mutable state.

1. The serializer already knows where every wireframe is: top-level frames sorted by `gridRow`. Prose rows are the complement — row 0 to first frame's `gridRow - 1`, gaps between consecutive frames, and everything after the last frame's `gridRow + gridH - 1`. `framesToProseGaps(frames: Frame[]): { startRow: number; endRow: number }[]` computes these intervals by sorting top-level frames on `gridRow`, walking them in order, and emitting gap intervals between each pair (including before-first and after-last). Adjacent blank lines that pad wireframes are inside the frame's `gridH` already — no separate blank-line claiming logic needed.

2. Phase C replacement: instead of `proseSegmentMap[i].row` (a frozen snapshot from load time), the serializer calls `framesToProseGaps(frames)` at serialize time (always fresh, tracks frame moves automatically). For each prose line `i`, it maps to the next available row in the gap sequence — filling gaps top-to-bottom, advancing to the next gap when the current one is full. Prose column stays at 0 (`scanToFrames` already prepends leading spaces to extracted text to match `seg.col`, so `proseLines[i]` contains physical indentation — writing at col 0 preserves formatting). If prose has more lines than gap rows, the grid grows downward (push empty rows and continue). If prose has fewer lines than gap rows, remaining gap rows stay blank (spaces from Phase A copy).

3. The no-edit path and dirty path are unified: both call `framesToProseGaps`. No `anyDirty` branch. Clean frames produce the same gaps as load time (round-trip preserved). Dirty frames shift gap boundaries automatically — prose fills the new gaps in order.

4. `proseSegmentMap` becomes dead code in the serialize path — Phase C no longer reads it. **`originalProseSegments` must stay**: Phase A (lines 109-115 of gridSerialize.ts) uses it to blank old prose positions in the grid copy before writing new content. Without it, moved frames leave ghost text. `gridSerialize` signature shrinks from 8 to 7 params (drop `proseSegmentMap`, keep `originalProseSegments`). `originalGridRef` and `frameBboxSnapshotRef` remain (Phase A and Phase B still use them).

5. Wire into DemoV2: `saveToHandle`, `serializeDocument`, and `saveDocument` drop the `getProseSegmentMap(state)` argument only. Keep `getOriginalProseSegments(state)` — Phase A needs it. Keep the post-save `scanToFrames` → `applySetOriginalProseSegments` block — it refreshes Phase A's erasure data after each save.

6. `loadDocument` still calls `createEditorStateFromText` which runs `scanToFrames` internally. The prose text extraction (byRow map → sorted join) stays. `proseSegmentMap` no longer needs to be a StateField — audit whether cursor code reads it; if not, delete `proseSegmentMapField` and `getProseSegmentMap` from `editorState.ts`.

7. Edge case — frame overlap/adjacency: two frames whose row ranges overlap or touch (frame A rows 5-10, frame B rows 8-12). `framesToProseGaps` must merge overlapping/adjacent frame intervals before computing gaps — use `next.gridRow <= prev.gridRow + prev.gridH` (not strict `<`) so touching frames merge. Sort frames by `gridRow`, merge greedily, then compute gaps from the merged list.

8. Edge case — no frames: `framesToProseGaps([])` returns a single gap `{ startRow: 0, endRow: Infinity }` — prose fills from row 0 downward, matching current behavior for pure-prose documents.

9. Edge case — no prose: all gaps are empty, wireframe-only document serializes identically to today. Phase C writes nothing.

10. Dead code removal (after wiring + tests pass): delete `proseSegmentMapField`, `getProseSegmentMap` from `editorState.ts`. Delete `getProseSegmentMap` import from `DemoV2.tsx`. Keep `originalProseSegmentsField`, `getOriginalProseSegments`, `applySetOriginalProseSegments` — Phase A needs them.

**Gemini review corrections applied:** (a) Keep `originalProseSegments` for Phase A erasure. (b) Keep post-save `scanToFrames` roundtrip. (c) Merge adjacent frames (not just overlapping).

**Files:**

| File | Change |
|------|--------|
| `src/gridSerialize.ts` | Add `framesToProseGaps`; rewrite Phase C to use gaps instead of proseSegmentMap; drop `proseSegmentMap` param (8→7 params); delete `anyDirty` branch |
| `src/gridSerialize.test.ts` | Unit tests for `framesToProseGaps` (merging, no-frames, no-prose, overlap, adjacency) |
| `src/DemoV2.tsx` | Drop `getProseSegmentMap(state)` arg from all 3 serialize call sites |
| `src/editorState.ts` | Delete `proseSegmentMapField`, `getProseSegmentMap` (after audit confirms nothing else reads them) |

**What does NOT change:** `src/scanner.ts`, `src/frame.ts`, `src/scanToFrames.ts`, `src/reflowLayout.ts`, `src/autoLayout.ts`, `src/layers.ts`, `src/grid.ts`, `src/preparedCache.ts`, `src/cursorFind.ts`, `src/textFont.ts`, `src/frameRenderer.ts`. Phase A (grid copy + blank dirty positions), Phase B (two-pass compositor + junction repair), and Phase D (flatten) are untouched. The rendering pipeline, hit testing, Pretext integration, and CM editing stay exactly as they are.
