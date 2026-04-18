# Kill Regions — Grid-Based Serialization

**Goal:** Replace the region-based serialize/deserialize pipeline with a single-grid model. Frames live at absolute grid positions. Prose is one continuous stream. No regions, no proseParts, no startRow/endRow sync. Side-by-side wireframes just work.

## Open → Edit → Save pipeline

**Open:** `scan(text)` → character grid + rects/lines/texts → build frames at absolute positions → extract prose from unclaimed rows → CM doc holds prose, frames array holds wireframes, `originalGrid` ref holds the raw character grid.

**Edit:** unchanged — mouse/keyboard handlers mutate frames via effects, prose via CM doc, `reflowLayout` wraps prose around frame obstacles on canvas.

**Save:** deep-copy `originalGrid` → overwrite dirty frame cells → write prose paragraphs into frame-free rows → flatten grid to text → update `originalGrid` from output.

## Steps (in execution order)

1. **`scanToFrames` drops `detectRegions`.** New signature: `scanToFrames(text, cw, ch) → { frames, prose, originalGrid }`. Call `scan(text)` then `framesFromScan(scanResult, cw, ch)`. Return the scanner's `grid` as `originalGrid` — the reference layer for non-dirty saves. No `Region[]` in the return type. `createEditorStateFromText` (`editorState.ts:290`) currently depends on `prose` being `startRow`-tagged; this changes to a plain string, requiring coordinated editor-state updates in step 3.

2. **`framesFromScan(scanResult, cw, ch)` replaces `framesFromRegions`.** `buildLayersFromScan` (`layers.ts:159`) produces layers with absolute grid positions. Exclude `base`-type layers — those are unclaimed characters (prose, stray glyphs) preserved via `originalGrid`, not as frames. For non-base layers: each becomes a frame at `x = bbox.col * cw, y = bbox.row * ch`. Grouping rule: top-level rects become containers; orphan lines/text stay top-level. Call `reparentChildren` (`autoLayout.ts`) to nest small rects inside enclosing rects (unchanged). Prose extraction: collect all grid rows NOT claimed by any non-base layer's bbox, join their text as a single string with `\n` between rows. Blank rows between wireframes become `\n\n` paragraph separators in the CM doc naturally.

3. **`createEditorState` drops `regions` and `proseParts` from init.** New signature: `createEditorState({ prose, frames })`. Remove `regionsField`, `prosePartsField`, `setRegionsEffect`, `setProsePartsEffect`, `rebuildProseParts`, `getRegions`, `getProseParts` from `editorState.ts`. Remove `Region` import. The CM doc stores prose only (unchanged). `createEditorStateFromText` calls `scanToFrames`, passes prose string and frames directly — no `startRow` tags. Must land simultaneously with step 6 (DemoV2 cleanup) or the build breaks.

4. **`gridSerialize(frames, prose, originalGrid, cw, ch)` replaces `framesToMarkdown`.** Three phases:

   **Phase A — Frame cells.** Deep-copy `originalGrid` into a working grid (never mutate the ref). Expand grid if any frame extends beyond original bounds. Walk the frame tree with accumulated pixel offsets to get absolute grid positions. For each frame: if `dirty=false`, skip — original grid already has the right characters (junction chars preserved). If `dirty=true`, blank the frame's bounding box in the working grid, then write all its cells (and descendants' cells recursively) at their absolute grid positions. Dirty child inside non-dirty parent: only blank and rewrite the child's bounding box, not the parent's.

   **Phase B — Prose.** Split CM doc prose by `\n\n` into paragraphs. Scan the working grid top-to-bottom to find contiguous runs of frame-free rows (rows whose columns don't overlap any frame's bounding box). For each gap, write the next prose paragraph as a single long line into the first row of that gap. If a paragraph won't fit in the gap (more paragraphs than gaps), append rows to the grid. Blank rows between gaps act as visual separators — no content written there.

   **Phase C — Flatten.** Convert the grid to text: join each row's characters, `trimEnd` each line, join with `\n`, strip trailing empty lines.

5. **New frames serialize naturally.** `applyAddFrame` (`editorState.ts:514`) adds frames at absolute pixel positions with `dirty=true`. `gridSerialize` writes their cells to the working grid. The original grid has whitespace at those positions, so no conflict. No region needed.

6. **DemoV2 simplifications.** Add `originalGridRef` — stored by `loadDocument` from `scanToFrames`. Remove all region-related imports and dispatching: delete `setRegionsEffect` import, delete region shift logic in Enter/Backspace handlers, delete `rebuildProseParts` call in `saveToHandle`. `saveToHandle` calls `gridSerialize(getFrames(state), getDoc(state), originalGridRef.current, cw, ch)`. `applyClearDirty` stays — after save, mark all frames clean so next save uses the passthrough path.

7. **Delete cascade for empty containers.** In `applyDeleteFrame` (`editorState.ts:521`): after removing a child, walk up ancestors and remove any container whose `children.length === 0`. During serialization: if a deleted container was dirty, its bounding box is already blanked (step 4). If non-dirty, original grid cells remain — correct, they match the file. The next `originalGrid` refresh (step 8) will exclude the deleted content.

8. **`originalGrid` updates after save.** After `gridSerialize` produces the output text, rebuild `originalGrid`: `text.split("\n").map(line => [...line])`. Store into `originalGridRef`. No need to re-run `scan()`. This ensures the next save diffs against post-save state. `applyClearDirty` + grid refresh together make "save twice without editing = no-op."

| File | Changes |
|------|---------|
| `src/scanToFrames.ts` | Drop `detectRegions`; return `originalGrid`; call `framesFromScan` |
| `src/frame.ts` | Add `framesFromScan` (replaces `framesFromRegions`); delete `framesFromRegions` |
| `src/editorState.ts` | Remove `regionsField`, `prosePartsField`, `setRegionsEffect`, `setProsePartsEffect`, `rebuildProseParts`, `getRegions`, `getProseParts`; simplify `createEditorState` init |
| `src/serialize.ts` | Replace `framesToMarkdown` with `gridSerialize` |
| `src/DemoV2.tsx` | Add `originalGridRef`; remove region imports/dispatching; simplify `saveToHandle` and `loadDocument` |
| `src/roundtrip.test.ts` | Update tests; add side-by-side wireframe test |
| `src/editorState.test.ts` | Remove region/proseParts tests |
| `src/serialize.test.ts` | Rewrite for `gridSerialize` |
| `src/regions.ts` | Delete |

**What does NOT change:** `src/scanner.ts`, `src/layers.ts`, `src/reflowLayout.ts`, `src/frameRenderer.ts`, `src/grid.ts`, `src/autoLayout.ts`, `src/preparedCache.ts`, `src/cursorFind.ts`, `src/textFont.ts`. The canvas editing path (mouse handlers, keyboard handlers, paint, undo/redo, frame model) is untouched.
