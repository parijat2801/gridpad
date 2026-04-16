# Proportional Prose Font (Inter)

**Goal:** Render prose text in Inter (proportional) while wireframe structure stays monospace — making documents readable while keeping ASCII art grid-aligned.

---

1. **Two font constants live in separate modules.** `grid.ts` keeps `GRID_FONT = "16px monospace"` for wireframe borders and cell measurement — unchanged. New `textFont.ts` exports `PROSE_FONT_MEASURE = "16px Inter"` (for Pretext measurement — no fallback stack, avoids Pretext's `system-ui` accuracy issue on macOS), `PROSE_FONT_RENDER = "16px Inter, sans-serif"` (for `ctx.font` with fallback), and `PROSE_LINE_HEIGHT = 22`. `preparedCache.ts` switches from importing grid font to importing `PROSE_FONT_MEASURE`; every `prepareWithSegments` call now measures Inter widths. The grid's `charWidth`/`charHeight` remain the monospace cell size for frame positioning, snap-to-grid, and serialization.

2. **Inter is loaded via `@fontsource/inter` (npm package, no CDN dependency).** Import `@fontsource/inter/latin-400.css` in `main.tsx`; the woff2 ships in the bundle (~25KB gzipped). `ensureProseFontReady()` in `textFont.ts` calls `document.fonts.load("16px Inter")` and resolves when Inter is available — called in `DemoV2`'s init `useEffect` alongside `measureCellSize()`, before first `buildPreparedCache`. Non-Latin text falls back to `sans-serif` for both measurement and rendering; Pretext measures whatever font the browser resolves, so metrics stay consistent between prepare and paint even on fallback glyphs.

3. **`reflowLayout` stores richer metadata on `PositionedLine`.** Add `endCursor: { segmentIndex, graphemeIndex }` and `slotWidth: number` to the `PositionedLine` interface — populated during the existing `layoutNextLine` loop (endCursor is `line.end`, slotWidth is `slot.right - slot.left`). These fields enable click-to-cursor and cursor painting without re-deriving layout. No signature change; `lineHeight` parameter switches from `LH` (~19px) to `PROSE_LINE_HEIGHT` (22px).

4. **Prose rendering (`ctx.fillText`) switches font.** In `DemoV2.tsx` `paint()` and `canvasRenderer.ts`, set `ctx.font = PROSE_FONT_RENDER` before drawing prose lines. `frameRenderer.ts` keeps monospace for wireframe cell content. Two `ctx.font` assignments per paint: prose font for prose lines, grid font for frame content.

5. **`proseCursorFromClick` uses `ctx.measureText` prefix measurement.** Current code: `clickCol = Math.floor((px - best.x) / charWidth)`. New code: for the clicked `PositionedLine`, extract the visual line text, then binary-search or linear-scan grapheme boundaries using `ctx.measureText(text.substring(0, n)).width` to find which grapheme the click falls on — the grapheme whose cumulative width first exceeds `(px - best.x)` is the clicked column. `ctx.measureText` with `PROSE_FONT_RENDER` uses the same font as rendering, so pixel positions match exactly. This avoids relying on Pretext's internal segment widths (which don't map to exact glyph positions per the README) and avoids needing to reconstruct the line range. Same approach applies to `canvasRenderer.ts`'s `clickToCursor`.

6. **`findCursorLine` in `cursorFind.ts` uses the same `ctx.measureText` approach.** Current code: `x = targetLine.x + (cursor.col - targetLine.sourceCol) * charWidth`. New code: extract the source line text from `sourceCol` to `cursor.col`, measure its pixel width via a width-lookup function `(text: string) => number` passed as parameter (wraps `ctx.measureText(text).width`). Signature becomes `findCursorLine(cursor, lines, measureWidth, lineHeight)` where `measureWidth` is `(s: string) => ctx.measureText(s).width` with the prose font set. Falls back to `gridCharWidth * count` for empty lines (no text to measure).

7. **`PROSE_LINE_HEIGHT` replaces `LH` for prose layout and obstacle interaction.** Inter at 16px needs ~22px for comfortable reading. `reflowLayout` receives `PROSE_LINE_HEIGHT` instead of `LH`. `framesToObstacles` and wireframe positioning still use `charHeight` (grid row height) — wireframes don't move. Prose line bands are now 22px tall scanning for obstacle overlaps, so text carves slightly taller bands around wireframes. Cursor painting uses `PROSE_LINE_HEIGHT` for the cursor bar height.

8. **Edge cases.** (a) Empty document: no prose lines, no Pretext calls — unchanged. (b) Click on an empty source line: `proseCursorFromClick` snaps to nearest visual line (pre-existing behavior — empty lines emit no `PositionedLine`; fixing this is a separate issue). (c) Emoji/grapheme clusters: Pretext + `ctx.measureText` handle these natively. (d) Resize: `reflowLayout` reruns with same prepared cache (Pretext widths are width-independent); per-line cache optimization still applies. (e) Undo/redo: full cache rebuild via `buildPreparedCache` — unchanged. (f) File serialization: font-neutral — `serialize.ts` uses only grid `charWidth`/`charHeight` for frame-to-grid conversion; prose is plain text. Note: the existing prose-region reconstruction in `rebuildProseParts` has a pre-existing fragility when line counts change across regions — the font change does not worsen this but does not fix it either.

---

| File | Changes |
|------|---------|
| `src/textFont.ts` | **New.** `PROSE_FONT_MEASURE`, `PROSE_FONT_RENDER`, `PROSE_LINE_HEIGHT`, `ensureProseFontReady()` |
| `src/reflowLayout.ts` | Add `endCursor` and `slotWidth` fields to `PositionedLine`; populate in layout loop |
| `src/preparedCache.ts` | Import `PROSE_FONT_MEASURE` from `textFont.ts` instead of grid font constants |
| `src/DemoV2.tsx` | Use `PROSE_FONT_RENDER` for prose `ctx.fillText`; use `PROSE_LINE_HEIGHT` for layout; update `proseCursorFromClick` with `ctx.measureText` prefix measurement; call `ensureProseFontReady()` in init; pass `measureWidth` to `findCursorLine` |
| `src/canvasRenderer.ts` | Use `PROSE_FONT_RENDER` for prose rendering; update `clickToCursor` with `ctx.measureText`; update cursor painting with `measureWidth` |
| `src/cursorFind.ts` | Accept `measureWidth: (text: string) => number` parameter; use it for cursor x positioning |
| `src/main.tsx` | Add `import '@fontsource/inter/latin-400.css'` |
| `package.json` | Add `@fontsource/inter` dependency |

**What does NOT change:** `grid.ts` (monospace cell measurement), `frame.ts` (frame sizing/resize), `frameRenderer.ts` (wireframe cell rendering stays monospace), `serialize.ts` (grid-based serialization), `scanner.ts`, `regions.ts`, `layers.ts`, `editorState.ts`, `spatialHitTest.ts`, `spatialTextEdit.ts`.

**Known pre-existing issues not addressed:** (1) Empty-line click targeting — snaps to nearest visual line. (2) Vertical cursor navigation (`proseMoveUp/Down`) is source-line based, not visual-line based — more noticeable with Inter since wrapping patterns change. (3) Prose-region reconstruction fragility in `rebuildProseParts` when line counts shift.
