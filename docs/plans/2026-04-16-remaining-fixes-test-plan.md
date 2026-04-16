# Manual Test Plan — Remaining Fixes

**Branch:** `feature/remaining-fixes`
**Dev server:** `npm run dev` → http://localhost:5173

---

## Fix 1 & 2 & 4: Null guards (pre-init crash)

These prevent a crash if keydown/resize/paint fires before EditorState initializes.

**Test:** Hard to reproduce manually (race condition on slow machines). Verify no crash on normal startup:

1. Open http://localhost:5173 — page loads without console errors
2. Resize the browser window immediately while the page is loading
3. Press a key immediately while the page is loading
4. Check DevTools console — no "Field is not present" or null reference errors

## Fix 3: Scroll useEffect → onScroll prop

**Test:** Verify scrolling still repaints correctly.

1. Open the app — default document has a wireframe in the middle
2. Scroll down past the wireframe — text and wireframe should remain visible and correctly positioned (not frozen/stale)
3. Scroll back up — content repaints smoothly
4. Open a longer .md file (Cmd+O) with lots of content
5. Scroll through the entire document — no blank areas, no stale rendering

## Fix 5: Cursor rendering (last-matching-line algorithm)

### 5a: Basic cursor placement

1. Click on the prose text "Welcome to Gridpad" — cursor should appear at the clicked position
2. Click at the beginning of a line — cursor at column 0
3. Click at the end of a line — cursor at the last character
4. Type some characters — cursor advances correctly

### 5b: Multi-line navigation

1. Click on any prose line to place cursor
2. Press Arrow Down multiple times — cursor moves down through lines
3. Press Arrow Up — cursor moves back up
4. Verify cursor is visible at each position (not invisible or misplaced)

### 5c: Empty line navigation

1. Place cursor on a line above an empty line (e.g., between paragraphs)
2. Press Arrow Down to move into the empty line
3. **Expected:** Cursor appears at x=0 on the empty line (not invisible, not jumping to top)
4. Press Arrow Down again to move past the empty line
5. **Expected:** Cursor appears on the next text line

### 5d: Long document with wrapping

1. Open a .md file with long paragraphs that wrap
2. Click on wrapped text (second visual line of a paragraph)
3. **Expected:** Cursor appears at the clicked position on the wrapped line
4. Use arrow keys to navigate through the wrap boundary
5. **Expected:** Cursor moves smoothly from end of first visual line to start of second

### 5e: Cursor blink

1. Click to place cursor anywhere in prose
2. Wait — cursor should blink on/off (~530ms interval)
3. Type a character — blink resets (cursor stays visible)

---

## Regression checks

- [ ] Wireframe selection: click a wireframe → blue selection handles appear
- [ ] Wireframe drag: click and drag a wireframe → it moves, text reflows
- [ ] Wireframe resize: drag a selection handle → wireframe resizes
- [ ] Drill-down: click container → selected, click child inside → child selected
- [ ] Drawing tools: press R, draw a rect → rect appears, tool reverts to Select
- [ ] Text frame: press T, click empty space, type, press Enter → text frame created
- [ ] Undo/Redo: Cmd+Z / Cmd+Shift+Z work
- [ ] File open: Cmd+O opens file picker
- [ ] Delete: select wireframe, press Delete → wireframe removed
