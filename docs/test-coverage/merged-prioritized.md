# Merged & Prioritized Test List

Tests from Gemini and Codex lists, deduplicated, with already-covered harness tests removed.

**Already covered in harness (removed):**
- No-edit round-trips: simple-box, labeled-box, junction, nested, side-by-side, two-separate, form, pure-prose, emoji, dashes/markdown-syntax, shared walls (vertical, horizontal, three-in-row, asymmetric, 3x2 grid)
- Idempotent save (2x and 3x)
- Drag right/down/junction/default, position accumulates across saves, L-path drag, 10 sequential drags
- Resize expand/shrink, resize then move, resize then prose edit, resize to minimum clamp, resize to very large, resize shared-wall box, resize creating overlap
- Delete frame (prose preserved), delete child (outer survives), delete all wireframes, delete from junction grid, delete+undo restores frame, delete child+undo+move parent
- Undo drag, undo resize, undo chain (move+resize), interleaved undo (move+type+move), multiple undo/redo cycle
- Prose editing: type at start, Enter pushes frames down (3x and 10x), Backspace merges lines / pulls frame up, type between wireframes, type 100 chars
- Text label: double-click edit, append char, edit prose then edit label
- Add new rect (draw tool), add rect to empty doc, add rect then move, move frame + add new rect
- Drill-down selection (child), move child within parent, resize parent (children adjust)
- Text alignment (center, right+move)
- Move two different frames, move+resize+edit combo, move all 4 default frames
- Visual: no selection on fresh load, selection toggle, prose doesn't overlap wireframes (fresh + after drag + default), text labels inside wireframe visible
- Structure: simple-box (1 rect), side-by-side (container+2), nested, two-separate, junction, form depth, default text frame count
- Shared walls: all no-edit round-trips, drag (junction, horizontal, three-in-row, 3x2, asymmetric), drag+save+drag accumulates, drag adjacent, drag overlap, stack vertically, nest by drag, same-row adjacency, drag+type between, convergence
- Prose order preserved (drag up/down), prose stability (sub-char move)
- Invariants (default, after drag+save+reload)
- Rogue pipe in prose not parsed as wireframe, bbox ghost detection
- Negative X drag clamp, 0 and 3 blank lines between prose/wireframe, adjacent shared wall, indented wireframe preserves offset, tiny 2x2 box, wide 50+ col box
- Markdown syntax (headings, bold, lists, blockquotes, code) survives
- Rapid click between wireframe and prose
- Multi-cycle edit+save+reload
- Heading adjacent to wireframe, heading+wireframe after drag, two frames with prose between, prose beside narrow box, default doc drag dashboard

---

## P0: Click frame border pixel selects frame (not prose)

**Source:** Codex #7
**Fixture:** simple-box (prose above, box, prose below)
**Actions:** Click exactly on a frame border character (not interior)
**Assertions:** Frame is selected (getSelectedId returns frame ID), prose cursor is NOT set
**Why P0:** Users click frame borders constantly; if this fails, selection is broken.

---

## P0: Click empty canvas sets prose cursor, no frame selected

**Source:** Codex #1
**Fixture:** simple-box
**Actions:** Click on empty area (no frame, no prose)
**Assertions:** getSelectedId returns null, prose cursor is positioned
**Why P0:** Clicking empty space is the most basic interaction; broken state here blocks everything.

---

## P0: Click overlapping frames selects highest z-order

**Source:** Codex #4
**Fixture:** Two overlapping boxes (drag one onto another first, or use a fixture with overlap)
**Actions:** Click the overlap region
**Assertions:** The frame with higher z-order is selected
**Why P0:** Users with overlapping wireframes will hit this immediately.

---

## P0: Typing near frame reflows prose around obstacle

**Source:** Codex #58 / Gemini #12
**Fixture:** tight-prose (prose text adjacent to a frame)
**Actions:** Click prose near frame edge, type several words
**Assertions:** Rendered prose wraps around frame bbox, no overlap, line heights aligned
**Why P0:** Core reflow behavior; if prose overlaps frames during editing, the document is unusable.

---

## P0: Arrow keys in prose maintain approximate column across wraps

**Source:** Codex #54
**Fixture:** simple-box with multi-line prose
**Actions:** Click prose, arrow down/up across wrapped lines
**Assertions:** Cursor column is approximately preserved (within 1-2 chars)
**Why P0:** Arrow navigation is used constantly; broken column tracking makes editing painful.

---

## P0: Escape clears prose cursor

**Source:** Codex #60
**Fixture:** simple-box
**Actions:** Click prose to set cursor, press Escape
**Assertions:** Prose cursor is cleared, no frame selected, no visible cursor blink
**Why P0:** Escape is the universal "deselect" key; if it doesn't work, users get stuck.

---

## P0: Click elsewhere exits text edit mode

**Source:** Codex #49
**Fixture:** labeled-box
**Actions:** Double-click label to enter text edit, then click on prose area
**Assertions:** Text edit mode exits, edits are preserved, prose cursor is set
**Why P0:** Users expect clicking away to exit edit mode; failure traps them.

---

## P1: Arrow left/right across grapheme clusters (emoji)

**Source:** Codex #53 / Gemini #9 (partial)
**Fixture:** emoji-doc (prose with emoji like "Hello 🎉 world 👨‍👩‍👧‍👦")
**Actions:** Click before emoji, press ArrowRight repeatedly
**Assertions:** Cursor advances by one grapheme cluster per keypress (not by UTF-16 code unit)
**Why P1:** Users with emoji in docs will encounter this in their first session.

---

## P1: Backspace deletes previous grapheme (including emoji)

**Source:** Codex #44
**Fixture:** emoji-doc
**Actions:** Click after an emoji character, press Backspace
**Assertions:** The entire emoji grapheme cluster is deleted (not just one code unit)
**Why P1:** Broken backspace on emoji corrupts the document.

---

## P1: Arrow keys move caret inside text frame

**Source:** Codex #43
**Fixture:** labeled-box with multi-word label
**Actions:** Double-click label to enter text edit, press ArrowLeft/ArrowRight
**Assertions:** Caret moves within the label text, does not exit text edit mode
**Why P1:** Users editing labels need arrow navigation within the first session.

---

## P1: Enter exits text-edit mode

**Source:** Codex #45
**Fixture:** labeled-box
**Actions:** Double-click label, type a character, press Enter
**Assertions:** Text edit mode exits, edits preserved
**Why P1:** Common expectation that Enter confirms edits in single-line labels.

---

## P1: Drag parent moves all children

**Source:** Codex #19
**Fixture:** nested-boxes (outer with inner)
**Actions:** Click outer frame (parent), drag right 80px
**Assertions:** Both outer and inner frame positions shift by same delta; inner stays inside outer
**Why P1:** Users rearranging nested wireframes need group movement.

---

## P1: Resize from top-left handle changes x/y and w/h

**Source:** Codex #22
**Fixture:** simple-box
**Actions:** Click frame, drag top-left handle down-right 30px
**Assertions:** Frame x/y increase, w/h decrease correspondingly; frame stays valid
**Why P1:** Top-left resize is a standard interaction users discover quickly.

---

## P1: Resize regenerates border chars correctly

**Source:** Codex #26
**Fixture:** simple-box
**Actions:** Click frame, resize by 40px wider and 20px taller, save
**Assertions:** Output has correct corner chars (not duplicated or misaligned); border length matches new dimensions
**Why P1:** Corrupted borders after resize make the wireframe unreadable.

---

## P1: Resize shrink then expand back is idempotent

**Source:** Codex #30
**Fixture:** simple-box
**Actions:** Click frame, resize -40,-20, then resize +40,+20, save
**Assertions:** Output matches original input (or very close); no ghosts
**Why P1:** Users resize back and forth while designing; must be non-destructive.

---

## P1: Delete container removes all children

**Source:** Codex #32
**Fixture:** nested-boxes
**Actions:** Click outer (container), press Delete
**Assertions:** Both outer and inner frames are removed; prose survives; no ghosts
**Why P1:** Deleting a container must cascade; leaving orphan children corrupts the doc.

---

## P1: Delete then save removes frame from output

**Source:** Codex #39
**Fixture:** simple-box
**Actions:** Click frame, Delete, save
**Assertions:** Output contains no wire chars; prose intact; no ghost chars
**Why P1:** Users expect deleted frames to vanish from the saved file.

---

## P1: Delete frame between prose closes gap

**Source:** Codex #40
**Fixture:** two-separate (prose-frame-prose-frame-prose)
**Actions:** Delete first frame, save
**Assertions:** Prose above and below merge closer (fewer blank lines where frame was)
**Why P1:** Leftover blank gaps after deletion make the doc look broken.

---

## P1: Save after move clears dirty state

**Source:** Codex #72
**Fixture:** simple-box
**Actions:** Click frame, drag right, save
**Assertions:** After save, dirty flag is false; subsequent save produces identical output
**Why P1:** Users rely on dirty state to know if they have unsaved changes.

---

## P1: Redo frame move reapplies position

**Source:** Codex #64
**Fixture:** simple-box
**Actions:** Drag frame right, Cmd+Z (undo), Cmd+Shift+Z (redo), save
**Assertions:** Frame is at the dragged position (not original); output matches post-drag state
**Why P1:** Redo is fundamental to any editor workflow.

---

## P1: Cursor hover states change correctly

**Source:** Gemini #30 / Codex #29
**Fixture:** simple-box
**Actions:** Hover over: empty prose area, frame interior, frame resize handle
**Assertions:** Cursor CSS changes: text -> grab/pointer -> nwse-resize (or appropriate directional cursor)
**Why P1:** Wrong cursors confuse users about what interaction is available.

---

## P1: Drawing tool preview renders dashed outline without modifying frame tree

**Source:** Gemini #32
**Fixture:** pure-prose
**Actions:** Press R (rect tool), mousedown, mousemove (no mouseup)
**Assertions:** Dashed preview rectangle visible on canvas; getFrameTree returns same count as before draw
**Why P1:** Users need visual feedback while drawing; premature frame creation causes bugs.

---

## P1: Typing after selecting frame does not mutate prose

**Source:** Codex #61
**Fixture:** simple-box
**Actions:** Click frame (frame selected), type "abc" without clicking prose first
**Assertions:** Prose text unchanged; typed keys either ignored or handled as frame shortcuts
**Why P1:** Users accidentally type while a frame is selected; must not corrupt prose.

---

## P1: Delete all text in label leaves empty label, frame persists

**Source:** Gemini #18 / Codex #48
**Fixture:** labeled-box
**Actions:** Double-click label, select all (Cmd+A), Backspace, Escape, save
**Assertions:** Frame borders intact in output; label area is spaces; no crash
**Why P1:** Users clear labels to retype them; frame must not disappear.

---

## P2: Small drag (< 1 grid cell) may not change grid position

**Source:** Codex #15
**Fixture:** simple-box
**Actions:** Click frame, drag 2px right (less than half cell width ~4.8px)
**Assertions:** Frame grid position unchanged; save produces identical output to input
**Why P2:** Edge case of snap-to-grid behavior.

---

## P2: Drag frame past document bottom expands grid

**Source:** Codex #20
**Fixture:** simple-box
**Actions:** Drag frame down 500px (past current document end)
**Assertions:** Document grows (more lines in output); frame is at new position; no crash
**Why P2:** Power users drag frames to extend documents.

---

## P2: Selection survives viewport scroll

**Source:** Codex #10 / #99 / #100
**Fixture:** tall-document (many lines + wireframe)
**Actions:** Click frame, scroll viewport 500px down, scroll back up
**Assertions:** Frame still selected (blue outline visible); selection overlay aligns with frame position
**Why P2:** Only matters with documents taller than viewport.

---

## P2: Scroll during drag applies correct deltas

**Source:** Gemini #31
**Fixture:** tall-document
**Actions:** Scroll 300px, click frame, drag 50px down
**Assertions:** Frame moves by 50px in content coords (not viewport coords); no position jump on mouseup
**Why P2:** Drag+scroll combo only hits power users with tall documents.

---

## P2: Window resize triggers reflow

**Source:** Gemini #29 / Codex #77
**Fixture:** simple-box
**Actions:** Load at 1000px viewport width, resize browser to 500px
**Assertions:** Prose re-wraps (line count increases); no prose-frame overlap
**Why P2:** Users rarely resize mid-session, but reflowed prose must stay correct when they do.

---

## P2: Draw new line tool

**Source:** Gemini #25 / Codex #89
**Fixture:** pure-prose
**Actions:** Press L (line tool), drag vertically 100px, save
**Assertions:** Output contains column of vertical line chars; new frame in tree
**Why P2:** Line tool is secondary to rect tool for most users.

---

## P2: Text placement tool

**Source:** Codex #90-92
**Fixture:** pure-prose
**Actions:** Press T (text tool), click location, type text, press Escape to cancel OR Enter to confirm
**Assertions:** Text frame created at click location; Escape cancels without creating frame
**Why P2:** Text placement is a power-user feature.

---

## P2: Z-order shortcuts (] brings forward, [ sends backward, Mod variants)

**Source:** Codex #94-98
**Fixture:** side-by-side (two overlapping frames)
**Actions:** Select frame A, press ], press Mod+]
**Assertions:** Frame A z-order increases; Mod+] sends to front
**Why P2:** Z-order is a power-user feature for overlapping wireframes.

---

## P2: V key returns to select mode

**Source:** Codex #93
**Fixture:** pure-prose
**Actions:** Press R (rect tool), then press V
**Assertions:** Tool mode returns to select; clicking sets prose cursor (not drawing)
**Why P2:** Tool switching is discoverable but not critical-path.

---

## P2: R key enters rect draw mode, click frame in draw mode reverts to select

**Source:** Codex #85 / #88
**Fixture:** simple-box
**Actions:** Press R, click existing frame
**Assertions:** Draw mode cancelled, frame selected instead
**Why P2:** Edge case of tool switching.

---

## P2: Tiny rect draw (< 1 cell) ignored

**Source:** Codex #87
**Fixture:** pure-prose
**Actions:** Press R, mousedown, mouseup at nearly same position (< 1 cell)
**Assertions:** No frame created; frame tree unchanged
**Why P2:** Accidental micro-drags should not create invisible frames.

---

## P2: Cursor blink only in prose and text-edit mode

**Source:** Codex #101
**Fixture:** simple-box
**Actions:** Click prose (cursor should blink), click frame (no blink), double-click label (blink again)
**Assertions:** Cursor blink visible only when prose cursor or text-edit is active
**Why P2:** Visual polish; wrong blink state is confusing but not blocking.

---

## P2: Rendered prose never appears inside frame obstacle

**Source:** Codex #102
**Fixture:** Load default document, drag a frame to various positions
**Actions:** After each position, check rendered lines vs frame bboxes
**Assertions:** No rendered prose line has its x,y inside any frame's interior
**Why P2:** Already tested for specific cases; this is the generalized invariant.

---

## P2: CRLF input round-trips safely

**Source:** Codex #111
**Fixture:** simple-box with \r\n line endings
**Actions:** Load, save, reload
**Assertions:** No crash; output is valid; line endings normalized or preserved consistently
**Why P2:** Windows users may paste CRLF content.

---

## P2: Tabs in prose do not crash positioning

**Source:** Codex #110
**Fixture:** Prose with tab characters: "Hello\tWorld\n\n[box]"
**Actions:** Load, click on prose, type a character, save
**Assertions:** No crash; tab rendered as spaces or preserved; wireframe intact
**Why P2:** Tab chars are uncommon but should not crash.

---

## P2: Save after resize blanks old footprint

**Source:** Codex #74
**Fixture:** simple-box
**Actions:** Click frame, resize larger, save
**Assertions:** No ghost chars remain at the original smaller footprint position
**Why P2:** Footprint cleanup is tested indirectly but deserves a focused check.

---

## P2: Label overflow / long word in small box

**Source:** Gemini #16 / Codex #47
**Fixture:** small-box (3x3 frame)
**Actions:** Double-click label, type very long word (20 chars)
**Assertions:** Text either clips visually or frame expands; no crash; save preserves content
**Why P2:** Edge case of label editing in tiny frames.

---

## P2: Double-click timing does not accidentally start drag

**Source:** Codex #115
**Fixture:** simple-box
**Actions:** Double-click on frame rapidly
**Assertions:** Text edit mode entered (not a drag); frame position unchanged
**Why P2:** Race condition between double-click and drag detection.

---

## P2: Mouse-up after drag finalizes cleanly

**Source:** Codex #116
**Fixture:** simple-box
**Actions:** Mousedown on frame, drag 50px, mouseup
**Assertions:** Frame stays at drop position; no lingering drag state; subsequent click works normally
**Why P2:** Drag finalization edge case.

---

## P3: 10,000-char prose line does not crash

**Source:** Codex #112
**Fixture:** Single line of 10,000 "A" characters + a box below
**Actions:** Load, save
**Assertions:** No crash; wireframe intact; output contains the long line
**Why P3:** Theoretical stress test; no user types 10k chars on one line.

---

## P3: 5+ levels nested frames do not cause recursion issues

**Source:** Codex #113
**Fixture:** 5-level nested box fixture
**Actions:** Load, save, reload
**Assertions:** No stack overflow; all levels present in frame tree; round-trip preserves structure
**Why P3:** Extreme nesting is theoretical; real wireframes rarely exceed 3 levels.

---

## P3: Large doc with 50+ boxes loads within time budget

**Source:** Gemini #26 / Codex #79
**Fixture:** Generated 50-box document
**Actions:** Load, drag one box, save
**Assertions:** No crash; reflow completes; save < 2s
**Why P3:** Stress test; typical docs have 1-10 wireframes.

---

## P3: Extreme grid dimensions (300-char wide box)

**Source:** Gemini #27
**Fixture:** ultra-wide-box (300 chars wide)
**Actions:** Type inside, save
**Assertions:** Width maintained; no out-of-bounds; output correct
**Why P3:** Extreme dimension edge case.

---

## P3: Rapid undo/redo does not crash

**Source:** Codex #82
**Fixture:** simple-box
**Actions:** Drag, type, then Cmd+Z 20 times rapidly, then Cmd+Shift+Z 20 times
**Assertions:** No crash; final state is consistent
**Why P3:** Stress test of undo system.

---

## P3: Autosave debounce fires once for rapid edits

**Source:** Gemini #33 / Codex #83
**Fixture:** simple-box (with autosave enabled)
**Actions:** Type A, 100ms, B, 100ms, C, wait 600ms
**Assertions:** saveToHandle called once with final state (not 3 times)
**Why P3:** I/O logic; depends on autosave implementation details.

---

## P3: Save As (new file) assigns new handle

**Source:** Gemini #34
**Fixture:** simple-box
**Actions:** Cmd+Shift+S, resolve file picker
**Assertions:** New file handle assigned; dirty cleared
**Why P3:** File system API edge case.

---

## P3: Abort file open (AbortError) does not crash

**Source:** Gemini #35 / Codex #84
**Fixture:** simple-box (already open)
**Actions:** Cmd+O, reject/cancel file picker (AbortError)
**Assertions:** No crash; existing document remains intact
**Why P3:** Error handling edge case.

---

## P3: Comprehensive mixed workflow (10+ operations, no errors)

**Source:** Codex #120
**Fixture:** Default document
**Actions:** Type prose, draw rect, move frame, resize, delete, undo, redo, text-edit label, save, reload
**Assertions:** No crash; no ghosts; frame tree invariants hold; prose intact
**Why P3:** Integration soak test; individual operations already covered.
