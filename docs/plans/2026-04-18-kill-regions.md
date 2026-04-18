# Kill Regions — Grid-Based Serialization

**Goal:** Replace the region-based serialize/deserialize pipeline with a single-grid model. Frames live at absolute grid positions. Prose is one continuous stream. No regions, no proseParts, no startRow/endRow sync. Side-by-side wireframes just work.

## Open → Edit → Save pipeline

**Open:** `scan(text)` → character grid + rects/lines/texts → build frames at absolute positions → extract prose from unclaimed rows (preserving original line breaks and row positions) → CM doc holds prose, frames array holds wireframes, `originalGrid` ref holds the raw character grid.

**Edit:** unchanged — mouse/keyboard handlers mutate frames via effects, prose via CM doc, `reflowLayout` wraps prose around frame obstacles on canvas.

**Save:** deep-copy `originalGrid` → blank all prose rows → overwrite dirty frame cells → write prose lines back to their grid rows → flatten grid to text → update `originalGrid` from output.

## Key design decisions

**Prose lines preserve original formatting.** Obsidian does NOT rewrite hard-wrapped files. Neither does Gridpad. If the .md has paragraphs hard-wrapped at 80 chars, those line breaks survive round-trip. The CM doc stores prose with original `\n` characters intact. On save, each prose line maps back to its original grid row.

**Prose tracks row positions.** On open, each prose line gets a `startRow` — the grid row it came from. When the user presses Enter (adding a line) or Backspace-at-line-start (removing a line), the row positions shift: subsequent prose lines increment/decrement by 1. This is lighter than regions — it's just an integer per prose line, not a region boundary structure.

**Wireframes are page-anchored, not text-anchored.** Pressing Enter above a wireframe does NOT push the wireframe down. Wireframes stay at their absolute grid positions. Prose flows around them. This is the InDesign model, not the Word model. (If this is wrong, say so — it's the biggest UX decision in this plan.)

## Steps (in execution order)

1. **`scanToFrames` drops `detectRegions`.** New signature: `scanToFrames(text, cw, ch) → { frames, proseLines, originalGrid }`. Call `scan(text)` then `framesFromScan(scanResult, cw, ch)`. Return the scanner's `grid` as `originalGrid`. `proseLines` is an array of `{ row: number; text: string }` — one entry per unclaimed grid row, preserving original line content and position. No `Region[]` in the return type.

2. **`framesFromScan(scanResult, cw, ch)` replaces `framesFromRegions`.** `buildLayersFromScan` (`layers.ts:159`) produces layers with absolute grid positions. Exclude `base`-type layers — those are unclaimed characters (prose, stray glyphs) preserved via `originalGrid`, not as frames. For non-base layers: each becomes a frame at `x = bbox.col * cw, y = bbox.row * ch`. Grouping rule: top-level rects become containers; orphan lines/text stay top-level. Call `reparentChildren` (`autoLayout.ts`) to nest small rects inside enclosing rects (unchanged). Prose extraction: for each grid row not covered by any non-base layer's bbox, emit `{ row, text: gridRow.join("").trimEnd() }`. Skip rows that are entirely whitespace within a wireframe's vertical span. Consecutive blank rows between wireframe and prose become `{ row, text: "" }` entries — these become `\n` in the CM doc, preserving paragraph spacing.

3. **`createEditorState` drops `regions` and `proseParts` from init.** New signature: `createEditorState({ prose, frames })`. Remove `regionsField`, `prosePartsField`, `setRegionsEffect`, `setProsePartsEffect`, `rebuildProseParts`, `getRegions`, `getProseParts` from `editorState.ts`. The CM doc is built by joining `proseLines` texts with `\n`: each prose line becomes one CM doc line. The CM doc line number maps 1:1 to the `proseLines` array index — CM doc line 0 = `proseLines[0]`, etc. Must land simultaneously with step 6 (DemoV2 cleanup) or the build breaks.

4. **`proseRowMap` tracks prose line → grid row mapping.** Store as `number[]` — index is CM doc line number, value is grid row. On open: `proseRowMap[i] = proseLines[i].row`. On Enter at CM doc line N: insert a new entry after index N, set its row to `proseRowMap[N] + 1`, increment all subsequent entries by 1. On Backspace-merge at CM doc line N: remove entry at index N, decrement all subsequent entries by 1. This replaces the old region boundary shift logic — same two keyboard handler call sites, but updating an integer array instead of region objects.

5. **`gridSerialize(frames, prose, proseRowMap, originalGrid, cw, ch)` replaces `framesToMarkdown`.** Three phases:

   **Phase A — Prepare working grid.** Deep-copy `originalGrid` (never mutate the ref). Expand grid if any frame extends beyond original bounds. Blank all prose rows in the working grid (every row whose index appears in `proseRowMap`) — this prevents ghost text from old prose bleeding through when paragraphs shrink or get deleted.

   **Phase B — Frame cells.** Walk the frame tree with accumulated pixel offsets to get absolute grid positions. For each frame: if `dirty=false`, skip — original grid characters are already in the working grid (junction chars preserved). If `dirty=true`, blank the frame's bounding box in the working grid, then write all its cells (and descendants' cells recursively) at absolute grid positions. Dirty child inside non-dirty parent: only blank and rewrite the child's bounding box. Track deleted frames: if a frame existed in `originalGrid` but is no longer in the frames array, its bbox must also be blanked. (Codex review: without this, deleted wireframes persist as ghosts.)

   **Phase C — Prose lines.** Split CM doc by `\n` into lines. For each CM doc line `i`, write it to working grid row `proseRowMap[i]`. Each line starts at column 0, extends as far as the text goes. If a prose line is longer than the current grid width, extend that row. If `proseRowMap` has more entries than grid rows, expand the grid.

   **Phase D — Flatten.** Convert working grid to text: join each row's characters, `trimEnd` each line, join with `\n`, strip trailing empty lines.

6. **DemoV2 simplifications.** Add `originalGridRef` and `proseRowMapRef` — stored by `loadDocument` from `scanToFrames`. Remove all region-related imports and dispatching. Enter handler: instead of dispatching `setRegionsEffect`, splice into `proseRowMapRef` (insert row, shift subsequent). Backspace-merge handler: splice out of `proseRowMapRef` (remove row, shift subsequent). `saveToHandle` calls `gridSerialize(getFrames(state), getDoc(state), proseRowMapRef.current, originalGridRef.current, cw, ch)`. `applyClearDirty` stays.

7. **Delete cascade for empty containers.** In the `deleteFrameEffect` handler (`editorState.ts`): after removing a child, check if the parent container's `children.length === 0`; if so, remove the parent too (recursive). This happens in a single transaction, so `invertedEffects` snapshots the pre-delete state and undo restores everything. During serialization (Phase B): frames that existed in `originalGrid` but aren't in the current frames array need their bounding box blanked. Track this by comparing frame positions against the original grid's content — if a grid area has wireframe characters but no frame claims it, blank it.

8. **New frames serialize naturally.** `applyAddFrame` adds frames at absolute pixel positions with `dirty=true`. Phase B writes their cells to the working grid. The original grid has whitespace at those positions. No region needed.

9. **`originalGrid` + `proseRowMap` update after save.** After `gridSerialize` produces the output text, rebuild both: `originalGrid = text.split("\n").map(line => [...line])`. Re-derive `proseRowMap` by scanning the new grid for frame-free rows (or just keep the current map since it's already correct post-save). Store into refs. `applyClearDirty` + refs refresh = "save twice without editing = no-op."

| File | Changes |
|------|---------|
| `src/scanToFrames.ts` | Drop `detectRegions`; return `originalGrid` + `proseLines`; call `framesFromScan` |
| `src/frame.ts` | Add `framesFromScan` (replaces `framesFromRegions`); delete `framesFromRegions` |
| `src/editorState.ts` | Remove `regionsField`, `prosePartsField`, `setRegionsEffect`, `setProsePartsEffect`, `rebuildProseParts`, `getRegions`, `getProseParts`; simplify `createEditorState` init |
| `src/serialize.ts` | Replace `framesToMarkdown` with `gridSerialize` |
| `src/DemoV2.tsx` | Add `originalGridRef` + `proseRowMapRef`; remove region imports/dispatching; update Enter/Backspace to splice proseRowMap; simplify `saveToHandle` and `loadDocument` |
| `src/roundtrip.test.ts` | Update tests; add side-by-side wireframe test |
| `src/harness.test.ts` | Rewrite tests that use `detectRegions`/`framesFromRegions` to use `framesFromScan`/`gridSerialize` |
| `src/editorState.test.ts` | Remove region/proseParts tests |
| `src/serialize.test.ts` | Rewrite for `gridSerialize` |
| `src/regions.ts` | Delete |

**What does NOT change:** `src/scanner.ts`, `src/layers.ts`, `src/reflowLayout.ts`, `src/frameRenderer.ts`, `src/grid.ts`, `src/autoLayout.ts`, `src/preparedCache.ts`, `src/cursorFind.ts`, `src/textFont.ts`. The canvas editing path (mouse handlers, keyboard handlers, paint, undo/redo, frame model) is untouched.

## Review findings incorporated

**From Codex:**
- Delete ghost: deleted frames must have their bbox blanked in the working grid (Phase B)
- `harness.test.ts` needs rewriting, not just deletion
- Steps 3+6 must land together (build dependency)
- Undo works if cascade is in same transaction (step 7)

**From Gemini:**
- Ghost text from old prose: Phase A must blank prose rows before writing new prose — prevents old lines bleeding through when paragraphs shrink
- Prose ordering scramble: solved by `proseRowMap` — each CM doc line has a fixed grid row, no gap-matching needed
- Hard-wrap preservation: Obsidian does NOT rewrite files. Gridpad preserves original line breaks. One CM doc line = one grid row, not one paragraph = one line.
- Wireframes are page-anchored (InDesign model) — this is an intentional UX decision, flagged for user confirmation
