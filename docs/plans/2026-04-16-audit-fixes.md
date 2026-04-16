# Audit Fixes — Bugs + Missing Tests

**Goal:** Fix 4 bugs found by audit, add tests for 6 untested exports.

---

1. `rebuildProseParts` (editorState.ts:266) splits the CM doc by `\n` but `createEditorStateFromText` joins prose parts with `\n\n` — the empty separator line is never accounted for in `lineOffset`, so the second prose region slices from the wrong offset. Fix: after each prose region, advance `lineOffset` by 1 extra line to skip the `\n\n` separator (but only when there's a subsequent prose region — the last one has no trailing separator). The test: create state with two prose regions separated by a wireframe, edit the second region, call `rebuildProseParts`, assert the edit appears in the correct part and the first part is unchanged.

2. ~~`clickToCursor`~~ — DROPPED. Verified not a bug (returns correct result). Function is also unused by DemoV2 (it uses `proseCursorFromClick` instead).

3. Drill-down selection (DemoV2.tsx:300) uses `f.children.some(c => c.id === hit.id)` which only checks one level deep — grandchildren of containers are invisible to the lookup. Fix: replace with a recursive `hasDescendant(f, id)` helper that walks `children` recursively. The test: not unit-testable (DemoV2 internals) but add a `hitTestFrames` test with 3-level nesting to verify the hit returns the deepest child.

4. `framesToMarkdown` (serialize.ts:36) silently returns `""` via `?? ""` when `proseParts[proseIdx]` is undefined — this masks bug #1 by producing empty prose instead of failing. Fix: after fixing bug #1, change the fallback to `region.text` (the original scanned text) instead of `""` — this way even if `rebuildProseParts` returns fewer parts than expected, the original text is preserved rather than lost.

5. Missing test: `framesToMarkdown` — create a serialize.test.ts with: (a) pure prose round-trip, (b) prose + wireframe regions produce correct markdown, (c) edited prose appears in output, (d) missing prosePart falls back to original region text.

6. Missing test: `paintCanvas` — add to canvasRenderer.test.ts: call `paintCanvas` with a mock ctx and a RenderState containing prose + frames + cursor + selection, assert `fillText` called for prose, `fillRect` called for cursor, frame rendering calls exist.

7. Missing test: `createLineFrame` — add to frame.test.ts: horizontal line, vertical line, reversed coordinates. Missing test: `hitTestFrames` — add: hit inside frame, miss outside, highest-z wins on overlap (partially covered by zorder.test.ts but not in frame.test.ts).

8. Missing test: `compositeLayers` and `buildLineCells` in layers.ts — `compositeLayers` is tested in harness.test.ts (via `getLayersForRegion` + `compositeLayers` calls); `buildLineCells` is tested in layers.test.ts. Confirm coverage exists before adding duplicates.

9. Type safety fixes (DemoV2.tsx): change `useRef<EditorState>(null!)` to `useRef<EditorState | null>(null)` with null checks at usage sites; change `content!.text` to `content?.text ?? ""`; add null check after `canvas.getContext("2d")` in grid.ts.

---

| File | Changes |
|------|---------|
| `src/editorState.ts` | Fix `rebuildProseParts` lineOffset accounting |
| `src/editorState.test.ts` | Add multi-region `rebuildProseParts` test |
| `src/canvasRenderer.ts` | Fix `clickToCursor` newline accounting |
| `src/canvasRenderer.test.ts` | Add `clickToCursor` multi-line test, `paintCanvas` test |
| `src/DemoV2.tsx` | Recursive `hasDescendant` for drill-down; `stateRef` null safety |
| `src/serialize.ts` | Fallback to `region.text` instead of `""` |
| `src/serialize.test.ts` | New file: 4 tests for `framesToMarkdown` |
| `src/frame.test.ts` | Add `createLineFrame`, `hitTestFrames` tests |
| `src/grid.ts` | Null check on `getContext("2d")` |

**What does NOT change:** scanner.ts, regions.ts, reflowLayout.ts, frameRenderer.ts, layers.ts, scanToFrames.ts, harness.test.ts, zorder.test.ts.
