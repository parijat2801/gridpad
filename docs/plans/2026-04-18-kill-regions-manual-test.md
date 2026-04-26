# Kill Regions — Manual Test Plan

**URL:** http://localhost:5177/gridpad/

## High-Risk Regression Areas

These are the areas where the old region pipeline was deeply integrated and where the new grid pipeline differs most. Test these first.

---

### 1. Round-Trip Fidelity (CRITICAL)

The #1 regression risk. The old pipeline used `framesToMarkdown` with region-based stitching. The new `gridSerialize` uses a 4-phase grid approach.

**Test:**
1. Open a .md file with mixed prose and wireframes (Cmd+O)
2. **Do NOT edit anything**
3. Save immediately (Cmd+S or Cmd+Shift+S)
4. Close and reopen the same file
5. **Verify:** The file is byte-for-byte identical. No extra whitespace, no missing characters, no junction char corruption.

**What to look for:**
- Junction characters (├┬┤┴┼) preserved in divided boxes
- Nested box indentation preserved
- Side-by-side boxes preserved (this was impossible with old regions!)
- Prose paragraph spacing preserved (blank lines between paragraphs)
- No trailing whitespace added to empty lines

**Test fixtures:**
```
Simple box:
┌──────┐
│      │
└──────┘

Divided box (junction chars):
┌───────────┬───────────┐
│  Left     │  Right    │
├───────────┼───────────┤
│  Bottom L │  Bottom R │
└───────────┴───────────┘

Side-by-side boxes:
┌──────┐  ┌──────┐
│  A   │  │  B   │
└──────┘  └──────┘

Nested boxes:
┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner            │  │
│  └──────────────────┘  │
└────────────────────────┘
```

---

### 2. Prose Editing + Wireframe Position (HIGH RISK)

The old pipeline shifted region boundaries on Enter/Backspace. The new pipeline shifts frame y-positions via `moveFrameEffect`. This is the biggest behavioral change.

**Test A — Enter pushes frames down:**
1. Click in prose text ABOVE a wireframe
2. Press Enter several times
3. **Verify:** The wireframe moves down visually (stays below the prose)
4. Save and reopen
5. **Verify:** Wireframe is at the new position in the file (more blank lines between prose and wireframe)

**Test B — Backspace pulls frames up:**
1. Place cursor at the start of a line above a wireframe
2. Press Backspace to merge lines
3. **Verify:** The wireframe moves up
4. Save and reopen
5. **Verify:** Wireframe position is correct in file

**Test C — Enter below wireframe:**
1. Click in prose text BELOW a wireframe
2. Press Enter
3. **Verify:** The wireframe does NOT move (only frames below the edit point shift)

**What can go wrong:**
- Frame doesn't move → prose and wireframe overlap in saved file
- Frame moves wrong direction or wrong amount
- Frame shift accumulates incorrectly (Enter 3 times → should shift by 3 rows)

---

### 3. Drag + Save (HIGH RISK)

The old pipeline used `region.text` as a base layer for non-dirty frames. The new pipeline uses `originalGrid` and blanks dirty frame original positions via `originalFrameBboxes`.

**Test A — Drag and save:**
1. Drag a wireframe to a new position
2. Save (Cmd+S)
3. Reopen
4. **Verify:** Wireframe is at the new position
5. **Verify:** No "ghost" wireframe at the old position

**Test B — Drag, save twice:**
1. Drag a wireframe
2. Save
3. Save again without editing
4. Reopen
5. **Verify:** File is identical to after first save (save twice = no-op)

**Test C — Multiple drags before save:**
1. Drag wireframe to position A
2. Drag it again to position B
3. Save
4. **Verify:** Wireframe is at position B, no ghost at original or A

---

### 4. Delete Frame (MEDIUM RISK)

New cascade delete behavior: deleting the last child of a container removes the container too.

**Test A — Delete a frame:**
1. Click a wireframe to select it
2. Press Delete or Backspace
3. **Verify:** Wireframe disappears
4. Save and reopen
5. **Verify:** Wireframe is gone from the file (no ghost characters)

**Test B — Undo after delete:**
1. Delete a wireframe
2. Cmd+Z to undo
3. **Verify:** Wireframe reappears at original position

**Test C — Delete child of nested box:**
1. Open a file with nested boxes (inner box inside outer box)
2. Select the inner box
3. Delete it
4. **Verify:** If outer box was a content-less container, it should also be deleted (cascade)
5. Save and verify

---

### 5. Add New Frame (MEDIUM RISK)

New frames are added at absolute pixel positions with `dirty=true`. Phase B of `gridSerialize` writes their cells.

**Test:**
1. Select the Rect tool from toolbar
2. Draw a new rectangle on the canvas
3. Save
4. Reopen
5. **Verify:** New rectangle appears in the markdown file with box-drawing characters

---

### 6. Text Label Editing (LOW RISK)

Text labels inside wireframes should still be editable.

**Test:**
1. Double-click a text label inside a wireframe (e.g., "Hello" inside a box)
2. Edit the text
3. Save and reopen
4. **Verify:** Updated text appears in the file

---

### 7. Resize Frame (LOW RISK)

Resize uses `resizeFrameEffect` which marks dirty + regenerates cells. Same mechanism as before.

**Test:**
1. Select a wireframe
2. Drag a resize handle
3. Save and reopen
4. **Verify:** Resized wireframe appears correctly with proper box-drawing chars

---

### 8. Pure Prose Document (LOW RISK)

No wireframes at all — should work exactly like before.

**Test:**
1. Open a pure markdown file with no wireframes
2. Edit prose (type, delete, Enter, Backspace)
3. Save and reopen
4. **Verify:** File is correct, no corruption

---

### 9. Large File Performance (LOW RISK)

The new pipeline scans twice on load (once for `originalGrid`, once inside `createEditorStateFromText`). Check that this doesn't cause noticeable delay.

**Test:**
1. Open a large .md file (>50KB with multiple wireframes)
2. **Verify:** File opens without noticeable delay
3. Type in prose area
4. **Verify:** No lag during typing

---

## Known v1 Limitations (NOT regressions)

- **Inline annotations:** Prose text on the same row as a wireframe (e.g., `└────┘  Some note`) may overwrite non-dirty frame characters on save if the frame shares that row. This is a v1 simplification — the old pipeline handled this via region boundaries.

- **Text labels as prose:** Scanner-detected text labels (like standalone text near wireframes) may appear in both the CM prose editor AND as text frames. This is cosmetic, not data-corrupting.
