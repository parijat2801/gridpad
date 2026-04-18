# Round-Trip Serialization Issues

**Date:** 2026-04-18
**Tested:** All edit types against `framesToMarkdown` pipeline
**Result:** 13 of 18 scenarios have bugs

---

## Issue 1: Extra blank line before wireframe regions (ALL no-edit tests)

**Severity:** Critical — every save corrupts spacing
**Repro:** Open any .md with wireframes, save immediately without editing.

`detectRegions` includes a leading `\n` in wireframe region text (e.g. `"\n┌──────┐\n│..."`). `framesToMarkdown` joins regions with `\n\n`, producing three newlines instead of two.

**Input:** `"Prose\n\n┌──────┐\n│      │\n└──────┘\n\nEnd"`
**Output:** `"Prose\n\n\n┌──────┐\n│      │\n└──────┘\n\nEnd"` ← extra `\n`

**Affects:** Every save of every file. Accumulates — each save adds another blank line.

---

## Issue 2: Extra blank line AFTER wireframe regions (dirty/move/resize)

**Severity:** High
**Repro:** Move or resize any frame, then save.

When `dirty=true`, `framesToMarkdown` regenerates the wireframe text from cells. The regenerated text has a trailing blank line that the original didn't.

**Example (move):** `"Prose\n\n┌──────┐\n│      │\n└──────┘\n\n\nEnd"` ← extra `\n` after box

---

## Issue 3: `framesToMarkdown` only writes direct children, not grandchildren

**Severity:** Critical — text labels vanish
**Repro:** Move any grandchild frame (inner rect, text label inside a rect), then save.

`framesToMarkdown` line 92 iterates `frame.children` but never recurses into `child.children`. Grandchildren (inner rects, text labels inside rects) are silently dropped.

**Example (nested box after move):**
- Input has "Outer" and "Inner" text labels
- Output: `"┌────────────────────────┐\n│                        │\n│                        │\n│                        │\n│                        │\n└────────────────────────┘"` — all content gone

**Example (text edit):**
- Change "Hello" to "World" inside a rect
- Output: `"┌──────────────┐\n│              │\n└──────────────┘"` — text label gone entirely

---

## Issue 4: Delete child empties entire container

**Severity:** High
**Repro:** Delete a child inside a nested wireframe container, then save.

Deleting one child (the outer rect) removes ALL children. The container serializes as empty rows.

**Output:** `"Prose\n\n\n\n\n\n\n\n\n\nEnd"` — wireframe replaced by blank lines

---

## Issue 5: Resize doesn't update serialized dimensions

**Severity:** High
**Repro:** Resize a wireframe, save.

After resize, `dirty=true` triggers regeneration. But the output still shows original dimensions — the regenerated cells come from the frame's content.cells which were updated, but the grid dimensions use the original region text size.

**Output:** Original 8-col box serialized as 8-col even though frame was resized to 12 cols.

---

## Issue 6: Added frames are not serialized

**Severity:** High
**Repro:** Draw a new rect (R tool), save.

`framesToMarkdown` iterates regions and matches wireframe regions to frames by index. Newly added frames have no corresponding wireframe region, so they're silently dropped.

**Output:** `"Just prose\n\nMore prose"` — the new rect disappears

---

## Issue 7: Prose newline (Enter) drops trailing content

**Severity:** Critical
**Repro:** Click in prose, press Enter, save.

`rebuildProseParts` uses frozen `region.startRow` boundaries. Adding a line shifts all subsequent content but the boundaries don't update. The last prose region gets truncated.

**Input:** `"Prose\n\n┌──────┐\n│      │\n└──────┘\n\nEnd"`
**After Enter in "Prose":** Output loses "End" entirely — `"Prose\n\n\n┌──────┐\n│      │\n└──────┘\n\n"`

---

## Issue 8: Multi-region prose edit lands in wrong region

**Severity:** Critical
**Repro:** Type in a prose section between two wireframes, save.

Edits intended for "Middle" prose region end up appended to "Bottom" instead. `rebuildProseParts` slices by stale line counts.

**Input:** Insert " text" after "Middle"
**Expected:** `"Middle text"` in the middle section
**Got:** `"Middle"` unchanged, `"Bottom text"` at the end

---

## Issue 9: Delete top-level frame doesn't remove region

**Severity:** Medium
**Repro:** Delete a wireframe, save.

The wireframe region persists in the regions list even though the frame is gone. `framesToMarkdown` tries to match it to the next frame, causing misalignment. First deleted frame leaves its region text (including the extra `\n` from Issue 1).

---

## Summary

| # | Issue | Severity | Root Cause |
|---|-------|----------|------------|
| 1 | Extra `\n` before wireframe | Critical | `detectRegions` includes leading blank in wireframe text |
| 2 | Extra `\n` after wireframe (dirty) | High | `framesToMarkdown` regeneration adds trailing blank |
| 3 | Grandchildren not serialized | Critical | `framesToMarkdown` doesn't recurse into `child.children` |
| 4 | Delete child empties container | High | All children removed, blank lines serialized |
| 5 | Resize doesn't update serialized size | High | Grid dims from original region, not resized frame |
| 6 | Added frames not serialized | High | No region exists for new frames |
| 7 | Enter drops trailing content | Critical | `rebuildProseParts` uses frozen boundaries |
| 8 | Multi-region edit lands in wrong region | Critical | Same stale boundary bug as #7 |
| 9 | Delete frame doesn't remove region | Medium | Region/frame index mismatch after deletion |

**Root causes cluster into 3 areas:**
1. **Region text boundaries** (Issues 1, 2, 7, 8, 9) — `detectRegions` and `rebuildProseParts` produce/consume misaligned text
2. **Shallow child iteration** (Issues 3, 4) — `framesToMarkdown` only walks one level of children
3. **Missing region lifecycle** (Issues 5, 6, 9) — no mechanism to add/remove/resize regions after initial scan
