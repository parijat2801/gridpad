# Kill Regions — Grid-Based Serialization

**Goal:** Replace the region-based serialize/deserialize pipeline with a single-grid model. Frames live at absolute grid positions. Prose is segments of unclaimed text at exact grid positions. No regions, no proseParts, no startRow/endRow sync. Side-by-side wireframes and inline annotations just work.

## Open → Edit → Save pipeline

**Open:** `scan(text)` → character grid + rects/lines/texts + unclaimed cells → build frames at absolute positions → extract prose segments from unclaimed cells (preserving row, col, and original text) → CM doc holds prose, frames array holds wireframes, `originalGrid` ref holds the raw character grid.

**Edit:** unchanged — mouse/keyboard handlers mutate frames via effects, prose via CM doc, `reflowLayout` wraps prose around frame obstacles on canvas.

**Save:** deep-copy `originalGrid` → blank all prose segment positions → blank dirty frame cells → write dirty frame cells → write prose segments back to their grid positions → flatten grid to text → update refs.

## Key design decisions

**Prose is segments, not lines.** A prose segment is a run of unclaimed characters at a specific `(row, col)` position. Most segments start at col 0 and span the full row. But annotations like `└────┘  Some note here` produce a segment at `(row, col=12)`. This handles inline text next to wireframes naturally.

**Prose preserves original formatting.** Hard-wrapped paragraphs survive round-trip. The CM doc stores prose with original `\n` characters intact. On save, each prose segment maps back to its exact grid position.

**Prose position tracking via CM transactions.** `proseSegmentMap` updates from CodeMirror's transaction `changes` object — not just Enter/Backspace keyboard events. Any transaction that changes line count (paste, multi-line delete, undo/redo, replace-selection) correctly shifts subsequent segment rows.

**Wireframes are page-anchored.** Pressing Enter above a wireframe does NOT push the wireframe down. Wireframes stay at their absolute grid positions. Prose flows around them.

## Steps (in execution order)

1. **`scanToFrames` drops `detectRegions`.** New signature: `scanToFrames(text, cw, ch) → { frames, proseSegments, originalGrid }`. Call `scan(text)` then `framesFromScan(scanResult, cw, ch)`. Return the scanner's `grid` as `originalGrid`. `proseSegments` is an array of `{ row: number; col: number; text: string }` — one entry per contiguous run of unclaimed characters on a grid row. Blank unclaimed rows emit `{ row, col: 0, text: "" }` to preserve paragraph spacing.

2. **`framesFromScan(scanResult, cw, ch)` replaces `framesFromRegions`.** `buildLayersFromScan` (`layers.ts:159`) produces layers with absolute grid positions. Exclude `base`-type layers — those are unclaimed characters preserved via `originalGrid` and extracted as prose segments. For non-base layers: each becomes a frame at `x = bbox.col * cw, y = bbox.row * ch`. Grouping rule: top-level rects become containers; orphan lines/text stay top-level. Call `reparentChildren` (`autoLayout.ts`) unchanged. Prose extraction: walk the scanner's `unclaimedCells` map. Group consecutive unclaimed cells on the same row into runs. Each run becomes `{ row, col: firstCol, text: cells joined }`. Rows with no unclaimed cells at all AND not covered by any frame bbox emit `{ row, col: 0, text: "" }` (blank separator).

3. **`createEditorState` drops `regions` and `proseParts` from init.** New signature: `createEditorState({ prose, frames })`. Remove `regionsField`, `prosePartsField`, `setRegionsEffect`, `setProsePartsEffect`, `rebuildProseParts`, `getRegions`, `getProseParts` from `editorState.ts`. The CM doc is built by placing each prose segment into the correct line: segments at the same row are joined (space-separated or with col gaps preserved); segments at different rows are separated by `\n`. CM doc line N corresponds to prose segments from grid row `proseSegmentMap[N].row`. Rewrite `createEditorStateFromText` to call `scanToFrames` and construct the new shape. Must land simultaneously with step 5.

4. **`proseSegmentMap` tracks CM doc lines → grid positions.** Store as `Array<{ row: number; col: number }>` — index is CM doc line number, value is the grid position for that line. On open: derived from `proseSegments`. Updates from CM transactions: listen to `transaction.changes` — for each line inserted, splice a new entry (row = previous + 1, col = 0, shift subsequent rows); for each line deleted, remove the entry and shift subsequent rows down. This covers Enter, Backspace-merge, paste, multi-line delete, undo/redo, and replace-selection — all go through CM transactions.

5. **DemoV2 simplifications.** Add `originalGridRef` and `proseSegmentMapRef` — stored by `loadDocument` from `scanToFrames`. Remove all region-related imports and dispatching. Replace Enter/Backspace region-shift logic with `proseSegmentMap` splice (or better: derive from CM transactions in a single place). `saveToHandle` calls `gridSerialize`. `applyClearDirty` stays. Rewrite `loadDocument` to use new `scanToFrames` return shape — no more `regions` or `proseParts`.

6. **`gridSerialize(frames, prose, proseSegmentMap, originalGrid, cw, ch)` replaces `framesToMarkdown`.** Four phases:

   **Phase A — Prepare working grid.** Deep-copy `originalGrid`. Expand if any frame extends beyond original bounds. Blank all prose segment positions in the working grid — for each entry in `proseSegmentMap`, clear the cells at `(row, col)` through `(row, col + text.length)`. This prevents ghost text when prose shrinks or gets deleted.

   **Phase B — Frame cells.** Walk frame tree with accumulated pixel offsets for absolute grid positions. If `dirty=false`, skip — original grid characters are already correct (junction chars preserved). If `dirty=true`, blank the frame's bounding box, then write all cells (and descendants recursively) at absolute positions. Dirty child inside non-dirty parent: only blank and rewrite the child's bounding box. Deleted frames: compare current frame bboxes against a snapshot of previous frame bboxes (stored at load time and after each save). Any bbox in the snapshot not present in current frames → blank it. This prevents deleted wireframe ghosts.

   **Phase C — Prose segments.** Split CM doc by `\n` into lines. For each CM doc line `i`, write it to working grid at `(proseSegmentMap[i].row, proseSegmentMap[i].col)`. Extend row if text exceeds grid width. If more CM doc lines than grid rows, expand the grid.

   **Phase D — Flatten.** Join each row's characters, `trimEnd` each line, join with `\n`, strip trailing empty lines.

7. **Delete cascade for empty containers.** In `deleteFrameEffect` handler: after removing a child, check if parent container's `children.length === 0`; if so, remove the parent too (recursive). Single transaction, so undo restores everything via `invertedEffects` snapshot.

8. **New frames serialize naturally.** `applyAddFrame` adds frames at absolute pixel positions with `dirty=true`. Phase B writes their cells. No region needed.

9. **Refs update after save.** After `gridSerialize` produces output text: rebuild `originalGrid` from output (`text.split("\n").map(line => [...line])`). Snapshot current frame bboxes for next save's delete detection. Keep `proseSegmentMap` as-is (it's already correct). `applyClearDirty` + refs refresh = "save twice without editing = no-op."

| File | Changes |
|------|---------|
| `src/scanToFrames.ts` | Drop `detectRegions`; return `originalGrid` + `proseSegments`; call `framesFromScan` |
| `src/frame.ts` | Add `framesFromScan` (replaces `framesFromRegions`); delete `framesFromRegions` |
| `src/editorState.ts` | Remove `regionsField`, `prosePartsField`, `setRegionsEffect`, `setProsePartsEffect`, `rebuildProseParts`, `getRegions`, `getProseParts`; simplify `createEditorState` and rewrite `createEditorStateFromText` |
| `src/serialize.ts` | Replace `framesToMarkdown` with `gridSerialize` |
| `src/DemoV2.tsx` | Add `originalGridRef` + `proseSegmentMapRef` + `frameBboxSnapshotRef`; remove region imports/dispatching; derive proseSegmentMap updates from CM transactions; simplify `saveToHandle` and rewrite `loadDocument` |
| `src/roundtrip.test.ts` | Update tests; add side-by-side wireframe + inline annotation tests |
| `src/harness.test.ts` | Rewrite tests that use `detectRegions`/`framesFromRegions` to use `framesFromScan`/`gridSerialize` |
| `src/editorState.test.ts` | Remove region/proseParts tests |
| `src/serialize.test.ts` | Rewrite for `gridSerialize` |
| `src/regions.ts` | Delete |

**What does NOT change:** `src/scanner.ts`, `src/layers.ts`, `src/reflowLayout.ts`, `src/frameRenderer.ts`, `src/grid.ts`, `src/autoLayout.ts`, `src/preparedCache.ts`, `src/cursorFind.ts`, `src/textFont.ts`. The canvas editing path (mouse handlers, keyboard handlers, paint, undo/redo, frame model) is untouched.
