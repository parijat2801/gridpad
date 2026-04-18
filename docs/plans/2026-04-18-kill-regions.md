# Kill Regions — Grid-Based Serialization

**Goal:** Replace the region-based serialize/deserialize pipeline with a single-grid model. Frames live at absolute grid positions. Prose is one continuous stream. No regions, no proseParts, no startRow/endRow sync. Side-by-side wireframes just work.

**Execution order:** 2 → 1 → 7 → 4 → 6 → 8 → 9 → 10 (dependencies flow downward; step 8 cannot land before 7+4).

1. **`framesFromScan(scanResult, cw, ch)` replaces `framesFromRegions`.** `buildLayersFromScan` (`layers.ts:159`) produces layers with absolute grid positions. Exclude `base`-type layers — those are unclaimed characters (prose, stray glyphs) preserved only via `originalGrid`, not as frames. For non-base layers: each becomes a child frame at `x = bbox.col * cw, y = bbox.row * ch`. Grouping rule: top-level rects become containers; orphan lines/text stay top-level. Call `reparentChildren` (`autoLayout.ts`) to nest small rects inside enclosing rects (unchanged). Prose extraction: collect all grid rows NOT claimed by any non-base layer's bbox, join their text as a single string with `\n` between rows. Blank rows between wireframes become `\n\n` paragraph separators in the CM doc naturally.

2. **`scanToFrames` drops `detectRegions`.** New signature: `scanToFrames(text, cw, ch) → { frames, prose, originalGrid }`. Call `scan(text)` then `framesFromScan(scanResult, cw, ch)`. Return the scanner's `grid` as `originalGrid` — the reference layer for non-dirty saves. No `Region[]` in the return type. Note: `createEditorStateFromText` (`editorState.ts:290`) currently depends on `prose` being `startRow`-tagged; this changes to a plain string, requiring coordinated editor-state updates in step 7.

3. **`originalGridRef` in DemoV2 stores the file's character grid at load time.** `loadDocument` saves `originalGrid` from `scanToFrames` into a new ref. This grid preserves junction characters (├┬┤┴┼) exactly as the user wrote them. Save reads from this grid for cells that haven't changed. Must also be refreshed after save (step 10), otherwise subsequent saves diff against stale pre-save content.

4. **`gridSerialize(frames, prose, originalGrid, cw, ch)` replaces `framesToMarkdown`.** Deep-copy `originalGrid` into a working grid (never mutate the ref). Size the grid to fit all frames (expand if any frame extends beyond original bounds). For each frame (flattened absolute traversal — walk the frame tree, accumulate pixel offsets to get absolute grid positions): if `dirty=false`, skip — original grid already has the right characters. If `dirty=true`, blank the frame's bounding box in the working grid, then recursively write the frame's and all descendants' cells at their absolute grid positions. For dirty children inside a non-dirty parent: only blank and rewrite the child's region, not the parent's. Prose rows (step 9) fill remaining space. Flatten grid to lines, `trimEnd` each, strip trailing empty lines.

5. **New frames (drawn with R/L/T tools) serialize naturally.** `applyAddFrame` (`editorState.ts:514`) adds frames at absolute pixel positions with `dirty=true`. `gridSerialize` writes their cells to the working grid at those positions. No region needed. The original grid has whitespace at those positions, so no conflict.

6. **Delete cascade for empty containers.** In `applyDeleteFrame` (`editorState.ts:521`): after removing a child, walk up ancestors and remove any container whose `children.length === 0` after the removal. During serialization: deleted dirty frames leave their original grid cells intact (the working grid copy has them). If a container was deleted AND dirty, blank its bounding box in the working grid so old wireframe characters don't persist as ghosts. Non-dirty deleted containers: original grid cells remain, which is correct — they match the original file content; the next `originalGrid` refresh (step 10) will exclude them.

7. **`createEditorState` drops `regions` and `proseParts` from init.** New signature: `createEditorState({ prose, frames })`. Remove `regionsField`, `prosePartsField`, `setRegionsEffect`, `setProsePartsEffect`, `rebuildProseParts`, `getRegions`, `getProseParts` from `editorState.ts`. Remove `Region` import. The CM doc stores prose only (unchanged). `createEditorStateFromText` calls `scanToFrames`, passes prose string and frames directly — no `startRow` tags. Must land simultaneously with step 8's removal of region dispatching in DemoV2, or the build breaks.

8. **DemoV2 simplifications.** Remove all region-related imports and dispatching — delete `setRegionsEffect` import, delete region shift logic in Enter/Backspace handlers (lines ~877-906), delete `rebuildProseParts` call in `saveToHandle`. `saveToHandle` calls `gridSerialize(getFrames(state), getDoc(state), originalGridRef.current, cw, ch)`. `loadDocument` stores `originalGrid` and resets it on file open. `applyClearDirty` stays — after save, mark all frames clean so next save uses the passthrough path.

9. **Prose positioning on save.** `gridSerialize` places prose paragraphs (`\n\n`-separated in CM doc) into rows not occupied by any frame's bounding box. Walk the working grid top-to-bottom; for each contiguous run of frame-free rows, write the next prose paragraph as a single line (Obsidian-style, no hard wrapping). Multiple consecutive blank rows in the original file: if they're between wireframes, they become blank separator rows in the output naturally (frame bounding boxes don't cover them, prose paragraphs are separated by `\n\n`). Prose at top/bottom of file: first paragraph goes into the first frame-free rows; last paragraph goes after the last frame. Edge case: if a paragraph is longer than the grid width, the line just extends — markdown lines can be arbitrarily long.

10. **`originalGrid` updates after save.** After `gridSerialize` produces the output text, rebuild `originalGrid` from it: `text.split("\n").map(line => [...line])`. Store into `originalGridRef`. No need to re-run `scan()` — the grid is just a 2D character array. This ensures the next save diffs against post-save state, not the original file. `applyClearDirty` + grid refresh together make "save twice without editing = no-op."

| File | Changes |
|------|---------|
| `src/serialize.ts` | Replace `framesToMarkdown` with `gridSerialize`; delete region dependency |
| `src/scanToFrames.ts` | Drop `detectRegions`; return `originalGrid`; call `framesFromScan` |
| `src/frame.ts` | Add `framesFromScan` (replaces `framesFromRegions`); delete `framesFromRegions` |
| `src/editorState.ts` | Remove `regionsField`, `prosePartsField`, `setRegionsEffect`, `setProsePartsEffect`, `rebuildProseParts`, `getRegions`, `getProseParts`; simplify `createEditorState` init |
| `src/DemoV2.tsx` | Add `originalGridRef`; remove region imports/dispatching; simplify `saveToHandle` and `loadDocument` |
| `src/roundtrip.test.ts` | Update tests; add side-by-side wireframe test |
| `src/editorState.test.ts` | Remove region/proseParts tests |
| `src/serialize.test.ts` | Rewrite for `gridSerialize` |
| `src/regions.ts` | Becomes unused; delete |

**What does NOT change:** `src/scanner.ts`, `src/layers.ts`, `src/reflowLayout.ts`, `src/frameRenderer.ts`, `src/grid.ts`, `src/autoLayout.ts`, `src/preparedCache.ts`, `src/cursorFind.ts`, `src/textFont.ts`. The canvas editing path (mouse handlers, keyboard handlers, paint, undo/redo, frame model) is untouched.

**Codex review findings incorporated:**
- Exclude `base` layers from frame creation (step 1)
- Use working copy of `originalGrid` during serialization, never mutate the ref (step 4)
- Flatten frame tree to absolute positions for serialization, not per-container blanking (step 4)
- Dirty child inside non-dirty parent: only blank the child's region (step 4)
- `originalGrid` refresh after save is mandatory (step 10)
- Steps 7+8 must land together (build dependency)
- Execution order: 2 → 1 → 7 → 4 → 6 → 8 → 9 → 10
