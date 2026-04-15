# Manual Test Guide — Architecture Refactor

**URL:** http://localhost:5178/
**Branch:** `feature/architecture-refactor`

This guide verifies that the architecture refactor (Phases 1-4, 6) did not break
any existing behavior. Phase 5 (DemoV2 rewrite) is deferred — the app still runs
on the old DemoV2 shell, so all existing interactions should work identically.

---

## 1. App loads without errors

- [ ] Open http://localhost:5178/
- [ ] Canvas renders with dark background
- [ ] Default wireframe content is visible (boxes, text)
- [ ] No console errors (open DevTools → Console)

## 2. Prose text rendering

- [ ] Prose text renders above/below/between wireframes
- [ ] Text is readable (light color on dark background)
- [ ] Text wraps at canvas width

## 3. Wireframe display

- [ ] Box-drawing characters render correctly (corners: `┌ ┐ └ ┘`, edges: `─ │`)
- [ ] Nested boxes render with correct alignment
- [ ] Text labels inside boxes are visible
- [ ] Lines (standalone `─` or `│` runs) render

## 4. Frame selection

- [ ] Click a wireframe box — blue selection outline appears
- [ ] Click empty space — selection clears
- [ ] Click a different box — selection moves to that box

## 5. Frame drag

- [ ] Click and drag a selected frame — it moves with the mouse
- [ ] Release mouse — frame stays at new position
- [ ] Drag does NOT affect other frames
- [ ] Drag does NOT corrupt prose text

## 6. Frame resize

- [ ] Hover edge/corner of selected frame — resize cursor appears
- [ ] Drag edge — frame resizes
- [ ] Box-drawing characters regenerate to match new size
- [ ] Minimum size enforced (can't shrink to 0)

## 7. Drawing tools

### Rect tool (R key or toolbar)
- [ ] Press R to activate rect tool
- [ ] Click and drag on canvas — dashed preview rectangle appears
- [ ] Release — new box with `┌─┐ │ │ └─┘` characters appears
- [ ] New box is selectable and draggable

### Line tool (L key or toolbar)
- [ ] Press L to activate line tool
- [ ] Click and drag — dashed preview line appears
- [ ] Release — line of `─` or `│` characters appears

### Text tool (T key or toolbar)
- [ ] Press T to activate text tool
- [ ] Click on canvas — text placement cursor appears
- [ ] Type characters — they appear in the preview box
- [ ] Press Enter or click away — text frame is placed

## 8. Prose editing

- [ ] Click on prose text — blinking cursor appears
- [ ] Type characters — text inserts at cursor
- [ ] Backspace — deletes character before cursor
- [ ] Arrow keys — cursor moves left/right/up/down
- [ ] Enter — inserts newline

## 9. Text frame editing

- [ ] Double-click a text frame — editing cursor appears inside
- [ ] Type characters — text updates in the frame
- [ ] Backspace removes characters
- [ ] Escape exits text editing mode

## 10. File I/O

### Open file
- [ ] Click "Open" (or use keyboard shortcut)
- [ ] Select a `.md` file with ASCII wireframes
- [ ] File loads — wireframes and prose render correctly

### Save file
- [ ] Make changes (move a frame, type text)
- [ ] Click "Save" (or Cmd+S)
- [ ] Reopen the file — changes are preserved

## 11. Tool switching

- [ ] Press S → select tool active
- [ ] Press R → rect tool active
- [ ] Press L → line tool active
- [ ] Press T → text tool active
- [ ] Toolbar buttons match active tool

## 12. Scroll

- [ ] Long documents scroll vertically
- [ ] Wireframes at scroll positions render correctly
- [ ] Prose text reflows around wireframe obstacles during scroll

---

## What changed (for context)

These changes are **internal refactors** — no user-visible behavior should differ:

1. **Dead code removed** — diff.ts, identity.ts, munkres-js, unused layer mutations
2. **Pipeline simplified** — `scanToFrames()` replaces 3-step scan+detect+convert
3. **Region.layers removed** — framesFromRegions builds from ScanResult directly
4. **New modules added** (not yet wired into DemoV2):
   - `editorState.ts` — CM6-backed state with unified undo (ready for Phase 5)
   - `canvasRenderer.ts` — extracted paint logic (ready for Phase 5)
5. **z field added to Frame** — default 0, no visual change yet (Phase 6 keyboard
   shortcuts `]`/`[` will be wired in Phase 5)

## If something breaks

1. Check DevTools console for errors
2. Compare with `main` branch: `git stash && git checkout main && npm run dev`
3. File an issue referencing the specific test case number above
