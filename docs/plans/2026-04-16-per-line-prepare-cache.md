# Per-Line Prepare Cache

**Goal:** Typing on a 1935-line document re-prepares only the edited line, not the entire doc — making keystroke response O(1 line) instead of O(all lines).

---

1. **The data model is a `(PreparedTextWithSegments | null)[]` array** stored as `preparedCacheRef` in DemoV2, indexed by 0-based source line number. `prepareWithSegments` in `whiteSpace: "pre-wrap"` mode treats `\n` as a hard break with no cross-line context (no hyphenation, no bidi reordering across lines), so preparing each line independently produces identical segment/width/kind arrays to preparing the full doc and splitting — the preparation is line-separable. Array (not Map) because `Array.splice` handles insert/delete with a native `memmove` — shifting 1887 object references takes microseconds, no GC pressure from rewriting map keys.

2. **`buildPreparedCache(text: string): (PreparedTextWithSegments | null)[]`** splits text on `\n`, calls `prepareWithSegments(line, FONT, { whiteSpace: "pre-wrap" })` for each line (or `null` for empty lines), returns the array. Called once on `loadDocument` and on undo/redo (full rebuild is fine for these infrequent operations). Empty lines store `null` — `reflowLayout` handles them via the existing empty-line fallback.

3. **`invalidateLine(cache, lineNum, newLineText)`** replaces a single entry: `cache[lineNum] = newLineText.length > 0 ? prepareWithSegments(newLineText, FONT, { whiteSpace: "pre-wrap" }) : null`. Called from keystroke handlers (character insert, backspace, enter) with `cursor.row` as `lineNum` and `state.doc.line(cursor.row + 1).text` as `newLineText`. This is the hot path — one `prepareWithSegments` call on ~80 chars instead of ~100KB.

4. **Enter and backspace-at-line-start use `Array.splice`.** Enter splits one line into two: `cache.splice(row + 1, 0, prepareWithSegments(newSecondLine, ...))` then `cache[row] = prepareWithSegments(newFirstLine, ...)` — V8's splice shifts the remaining ~1887 pointers via `memmove` in microseconds. Backspace at col 0 merges two lines: `cache.splice(row, 1)` removes the current entry (shifting the rest down), then `cache[row - 1] = prepareWithSegments(mergedLine, ...)`. Both operations re-prepare at most 2 lines.

5. **`reflowLayout` changes signature** from `(prepared, canvasWidth, lineHeight, obstacles, docLineCount?)` to `(preparedLines: (PreparedTextWithSegments | null)[], canvasWidth, lineHeight, obstacles)`. It iterates `preparedLines` by index; for each entry, if non-null it calls `layoutNextLine` per slot with `sourceLine = i` and `sourceCol` computed from that line's local segments (starting at 0). Null entries (empty lines) emit no visual line but advance `lineTop += lineHeight`. The global `segToLine`/`segToCol` prefix map disappears — each line's segments are self-contained, so `sourceLine = i` and `sourceCol = segToCol[localSegIdx] + graphemeIndex`. Simpler than the current global map because there's no cross-line segment indexing.

6. **`PositionedLine.startCursor` semantics change.** Currently `segmentIndex` indexes into the global segment array. With per-line preparation, `segmentIndex` indexes into that line's local segment array (resets to 0 per line). This doesn't break anything — `startCursor` is only used by the now-obsolete segment-to-line mapping; `sourceLine`/`sourceCol` are the canonical fields. Comment the change.

7. **`proseCursorFromClick` and `findCursorLine` need zero changes** — they already work on `sourceLine`/`sourceCol`, which `reflowLayout` still populates. The data flows through unchanged.

8. **Edge cases.** (a) Empty document: `lineCount = 1`, map is empty (single empty line) — `reflowLayout` emits no visual lines, cursor fallback works. (b) Document is one giant line with no `\n`: map has one entry at key 0, re-prepared on every keystroke — same perf as today but no worse (and the common case of multi-line docs is fast). (c) Undo/redo: full rebuild via `buildPreparedCache` — undo can change arbitrary lines, not worth tracking. (d) File load: full rebuild, same as today's one-time cost. (e) Resize: only `reflowLayout` reruns (preparations are width-independent per Pretext's design — "the same PreparedText can be laid out at any maxWidth").

---

| File | Changes |
|------|---------|
| `src/reflowLayout.ts` | New signature taking `(PreparedTextWithSegments | null)[]`; per-line layout loop; simplified `sourceLine`/`sourceCol` (no global prefix map); remove `segToLine`/`segToCol`/`maxColForLine` |
| `src/reflowLayout.test.ts` | Update all tests to pass array instead of single `PreparedTextWithSegments`; add test for single-line invalidation producing same layout as full rebuild |
| `src/DemoV2.tsx` | Replace `preparedRef` with `preparedCacheRef: (PreparedTextWithSegments | null)[]`; `buildPreparedCache` on load/undo/redo; `invalidateLine` on keystroke; `splice` on Enter/Backspace-at-line-start; update `doLayout` call |
| `src/cursorFind.ts` | No changes |
| `src/cursorFind.test.ts` | No changes (tests use `PositionedLine` directly, not `reflowLayout`) |

**What does NOT change:** `editorState.ts`, `frame.ts`, `frameRenderer.ts`, `serialize.ts`, `cursorFind.ts`, `grid.ts`, `spatialHitTest.ts`. The `proseCursorFromClick` and `findCursorLine` functions are unaffected — they consume `PositionedLine[]` which has the same shape.
