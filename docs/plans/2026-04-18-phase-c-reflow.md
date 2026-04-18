# Phase C Rewrite — Serialize Prose from reflowLayout Positions

**Goal:** Replace the dual-path Phase C (clean vs dirty) with a single path that reads prose positions from `reflowLayout` output — the same coordinates the canvas already uses for rendering.

---

1. `gridSerialize` gains a `renderedLines: Array<{x, y, text, sourceLine, sourceCol}>` parameter — these are the positioned prose lines from `reflowLayout`, already computed by DemoV2 on every paint. Phase C writes each line to the grid at `(row = round(y/ch), col = round(x/cw))` — no `proseSegmentMap`, no `anyDirty` split, no `availableRows` computation. The reflow already solved prose-frame collision (it carved around obstacles), so prose and frame cells never overlap in the grid.

2. Phase A stays unchanged: deep-copy `originalGrid`, blank original prose segment positions, blank dirty/deleted frame original bboxes. Phase B stays unchanged: write dirty frame cells at current positions. Phase D stays unchanged: flatten grid to text.

3. The `anyDirty` boolean and its two code paths are deleted. Every save uses the same logic: blank old positions, write frames, write prose from reflow positions. A sub-char drag that doesn't change grid position produces zero prose movement — the reflow output is identical to before the drag, so Phase C writes prose to the same grid cells. The prose stability test passes automatically.

4. `DemoV2.tsx` `saveDocument` test hook passes `linesRef.current` to `gridSerialize`. The real `saveToHandle` does the same — it already has `linesRef` in scope. `doLayout()` must be called before serialize to ensure `linesRef` is current (it already is — layout runs before every paint, and paint runs before save via `scheduleAutosave`).

5. `proseSegmentMap` is still needed for the clean (no-edit) path in Phase A blanking — we blank original prose positions before writing new ones. The `proseSegmentMapField` stays in `editorState.ts` for tracking which grid row each CM doc line maps to (used by Enter/Backspace frame shifting). But Phase C no longer reads it.

6. Edge case: prose lines that reflow to the right of a wireframe (e.g., `reflowLayout` positions "## Dashboard Layout" at `x=549, y=154`) write to grid at `col = round(549/9.6) = 57`. This is correct — the prose IS at column 57 in the rendered layout. On reload, `scanToFrames` will extract it as a prose segment at `(row, col=57)`, and `reflowLayout` will position it at the same pixel x. Round-trip stable.

7. Edge case: prose lines that wrap across multiple slots around a wireframe produce multiple `renderedLines` entries with different `x` positions but the same `sourceLine`. Each entry writes its `text` substring to the grid at its own `(row, col)`. No conflict because reflow guarantees non-overlapping slots.

| File | Changes |
|------|---------|
| `src/gridSerialize.ts` | Replace Phase C (~30 lines): delete `anyDirty` split, add `renderedLines` param, write prose from reflow positions |
| `src/DemoV2.tsx` | Pass `linesRef.current` to `gridSerialize` in `saveDocument` hook and `saveToHandle` (~4 lines) |

**What does NOT change:** `src/scanToFrames.ts`, `src/frame.ts`, `src/editorState.ts`, `src/proseSegments.ts`, `src/reflowLayout.ts`, `src/preparedCache.ts`. The rendering path, frame model, CM state, and reflow engine are untouched.
