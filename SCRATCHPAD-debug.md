# Debugging Scratchpad: E2E Failures

## Before fixes: 250 tests, 179 pass, 71 fail
## After all fixes: 266 tests pass, 55 fail (-16 from baseline)

### Fixes applied:
1. Container bboxes in snapshotFrameBboxes (Phase A blanks full wireframe footprint)
2. Two-pass Phase B (collect cells then blank then write — prevents sibling text erasure)
3. Skip-overflow clipping (children outside resized parent are dropped)
4. DEFAULT_TEXT ≡ line typo (21 chars vs 20)
5. Wire-char margin blanking (3-cell margin around frame bboxes catches misaligned ASCII art)

### Remaining 30 ghosts root cause: BROWSER FONT METRICS
The browser measures `cw=9.63, ch=13.37` while unit tests use `CW=9.6, CH=18.4`.
The 38% difference in character height causes Math.round() in bbox calculations
to produce different grid positions. Wire characters fall 1 cell outside frame
bboxes due to rounding mismatches between:
- The serializer's cell-position calculation
- The ghost detector's bbox-from-pixels calculation
Both use the SAME char dims, but rounding of fractional intermediate values
(e.g., 50px / 9.63 = 5.19 → round to 5, but a child at position 80*9.63 + 50 =
820.4 → round(820.4/9.63) = round(85.17) = 85, while parent bbox = round(50/9.63)
+ round(81*9.63/9.63) = 5 + 81 = 86) creates 1-cell discrepancies.

## Findings (empirically verified via diagnostic.test.ts)

### Finding 1: Drags work. Ghosts are NOT from shared-wall blanking.

**Evidence:** Junction fixture dragged right by 2 and 5 cells → zero ghosts, perfect output, convergence passes. CRM-simple dragged right 3 cells → zero ghosts, frame count preserved. Even drag DOWN works perfectly.

**Corrected understanding:** The Phase A blanking + Phase B rewrite + Phase B.5 junction repair pipeline handles moves correctly. My initial "shared wall blanking" hypothesis was WRONG for moves.

### Finding 2: Container dirty does NOT propagate to children — but moves work anyway.

**Evidence:**
```
container dirty=true
  rect dirty=false    ← children NOT marked dirty
```
Yet `writeFrameToGrid` has `ancestorDirty` parameter (line 276) that cascades the dirty flag during Phase B writes. So children get rewritten even though their `.dirty` flag is false. This is correct behavior.

### Finding 3: RESIZE is the actual broken operation — not drag.

Both unit test failures are resize:
- Nested resize-smaller: 4 → 6 content frames (scanner sees broken borders)
- Junction resize-larger: 8 → 6 content frames (text labels lost)

### Finding 4: Nested resize-smaller — border corruption.

**Input:**
```
┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘
```

**After resize-smaller + serialize:**
```
┌──Outer──────────────┐
│                     │
│  ┌──────────────────┤  ← Inner top-right fused with Outer right edge
└──┤  Inner           │  ← Outer bottom-left fused with Inner left edge
   └──────────────────┘
```

The inner rect now protrudes beyond the outer rect's boundary. repairJunctions created `┤` junctions where the inner and outer rects' borders now touch. On reload, the scanner sees this as a completely different shape — a single connected rect with lines, producing 6 content frames instead of 4.

**Root cause:** `resizeFrame` shrinks the outer rect but does NOT check if children still fit inside. The inner rect (and its text labels) extend beyond the new outer boundary. `writeFrameToGrid` writes the inner rect cells beyond the outer rect's bbox, creating overlapping borders that junction repair turns into shared walls.

### Finding 5: Junction resize-larger — text labels lost.

**Before resize:**
```
container (content=null, 25x5 grid)
  rect (2,0) 13x3 with children: text "Left", text "Bottom L"
  rect (2,12) 13x3 with children: text "Right", text "Bottom R"
  rect (4,0) 13x3
  rect (4,12) 13x3
```

**After resize (before save):**
Container grows to 28x6. All 4 rects keep original size. Container is dirty=true, children are dirty=false.

**Serialized output:**
```
┌───────────┬───────────┐
│  Left     │  Right    │
├───────────┼───────────┤
│           │           │      ← "Bottom L" and "Bottom R" MISSING
└───────────┴───────────┘
```

Wait — the junctions look right, the grid size is the same as original (25x5, not 28x6)! The container was resized to 28x6 but the output is 25x5. The children weren't resized. Since the container has `content=null`, resizing it does nothing to the grid — the children are the ones with cells.

The issue: **text labels "Bottom L" and "Bottom R" are gone.** The text frames were at absolute grid positions (5,3) and (5,15). But the child rects they belong to span rows 4-6 (3-row height). The bottom rects at (4,0) and (4,12) have no text children. The top rects at (2,0) and (2,12) each have TWO text children: "Left" at row 3 and "Bottom L" at row 5.

Wait — "Bottom L" at row 5 is a child of the TOP-LEFT rect (2,0) which spans rows 2-4 (3 rows). Row 5 is OUTSIDE this rect's bbox! How can a text be a child of a rect when it's outside the rect's bounds?

**This is a reparenting bug in the scanner pipeline.** `reparentChildren` in `autoLayout.ts` assigns text labels to the "smallest enclosing rect", but the junction grid has 4 sub-rects and the text "Bottom L" at row 5 is inside the BOTTOM-LEFT rect (4,0) spanning rows 4-6, not the top-left rect.

Let me re-examine: The tree shows:
```
rect grid=(2,0) 13x3 ← spans rows 2-4
  text grid=(3,3) "Left" ← row 3, inside rows 2-4 ✓
  text grid=(5,3) "Bottom L" ← row 5, OUTSIDE rows 2-4! BUG?
```

No wait — the rect positions are RELATIVE to their parent container. Container is at grid (2,0). The rect at pos=(0,0) relative to container → absolute (2,0). Size 13x3 → spans rows 2 to 4. Text at pos relative to rect → needs to check absolute position.

Actually, looking at the printTree output more carefully:
```
rect grid=(2,0) 13x3 cells=28 text="" dirty=false
  text grid=(3,3) 4x1 cells=4 text="Left" dirty=false
  text grid=(5,3) 8x1 cells=8 text="Bottom L" dirty=false
```

The text "Bottom L" is at absolute grid row 5. The parent rect spans absolute rows 2-4. So "Bottom L" IS outside its parent rect. This means `reparentChildren` incorrectly assigned it.

BUT: `reparentChildren` uses pixel positions with a `charWidth` tolerance. Maybe the tolerance causes the text at row 5 to be accepted into the rect at rows 2-4. Let me check autoLayout.ts containment logic.

**Alternatively:** Maybe the scanner considers the top-left rect as spanning rows 2-6 (the full height of the junction grid), and reparentChildren correctly places "Bottom L" inside it. But then why does the frame model show the rect as 13x3 (3 rows)?

I need to check what `buildLayersFromScan` produces for the junction fixture.

### Finding 6: E2E ghost failures are on COMPLEX fixtures only

The fixtures that produce ghosts in e2e tests are all complex multi-nested ones (crm-workspace, admin-panel, enterprise-dashboard, etc.). The simple junction fixture passes drag tests at the unit level. The difference is likely that:

1. E2e tests perform pixel-space drags that may not align to grid boundaries
2. Complex fixtures have more container nesting where child overflow during resize creates more junction ambiguity
3. The e2e `resize-smaller` and `resize-larger` operations are the real culprits, not drag

### Finding 7: Prose editing works correctly at unit level

"prose insert between wireframes serializes correctly" — PASSES. The prose "Middle EDITED" appears in serialized output. The e2e failures for prose editing are likely cursor placement issues in the browser tests, not serialization bugs.

### Finding 8: Enter key above wireframe works correctly at unit level

Enter key test passes. The newline is added, segment map updates, frames shift correctly when moveFrameEffect is applied.

## Revised Root Cause Summary

| Category | Count | Root Cause | Verified? |
|----------|-------|-----------|-----------|
| GHOSTS (38) | 38 | Resize (not drag) on complex fixtures corrupts borders, leaving orphaned wire chars | Partially — unit test shows resize border corruption; e2e ghosts need further investigation |
| FRAME_COUNT (21) | 21 | Resize causes child frames to overflow parent, border corruption → scanner sees different shapes | Yes — nested resize-smaller: 4→6, junction resize-larger: 8→6 |
| NON_CONVERGENT (6) | 6 | Consequence of frame count change — each cycle produces different scan | Yes — cascade |
| PROSE_EDIT (3) | 3 | Likely e2e cursor placement, not serialization bug | Yes — unit test for prose insert passes |
| UNDO_REDO (1) | 1 | Separate issue — needs investigation |  |
| NEWLINE_COUNT (1) | 1 | Likely e2e-specific — unit test for Enter key passes | |
| SELECTION_VISUAL (1) | 1 | Paint/render issue | |

## Key Questions Remaining

1. **Why does resizeFrame not constrain children?** When outer rect shrinks, inner rect overflows. Is this by design or a bug?
2. **Why do text labels in junction get lost after resize-larger?** The junction grid output looks correct but texts are missing. Where do they go?
3. **What makes e2e complex fixtures produce ghosts from drag?** Unit tests show drags are clean. Is it a timing issue? Pixel rounding?
4. **Is the reparenting of "Bottom L" to the top-left rect correct?** It seems like a bug.

## ROOT CAUSE #1 CONFIRMED: Phase B write-order destruction (junction text loss)

**Mechanism:** When sibling frames in the same container share overlapping grid rows, `writeFrameToGrid` processes them sequentially. Each sibling blanks its own bounding box before writing cells. If an earlier sibling's text child was written into a grid row that a later sibling also claims, the later sibling's blanking erases the text.

**Concrete example (junction fixture):**
- Top-left rect (rows 2-4) owns text "Bottom L" at row 5 (via tolerance in reparentChildren)
- Bottom-left rect (rows 4-6) has no text children
- Phase B writes top-left rect → writes "Bottom L" at row 5
- Phase B writes bottom-left rect → blanks rows 4-6 → erases "Bottom L"
- Bottom-left rect writes only border cells (no text) → "Bottom L" is gone

**Contributing factor:** `reparentChildren` assigns "Bottom L" to the WRONG parent (top-left rect at rows 2-4) because of the `+charHeight` tolerance in containment check. The text at row 5 is 1 row below the top-left rect but within tolerance. It should belong to the bottom-left rect (rows 4-6) which actually contains row 5.

**Fix options:**
A. Fix `reparentChildren` to assign text to the correct parent (tighter containment, or prefer the parent whose bbox actually contains the text without tolerance)
B. Change Phase B to write ALL cells first, THEN blank only truly empty areas
C. Change write order so that text cells are written AFTER all rect blanking

## ROOT CAUSE #2 CONFIRMED: Resize causes child overflow (nested resize-smaller)

**Mechanism:** `resizeFrame` shrinks a parent rect but does NOT reposition or clip children. Children that extended to the old boundary now overflow the new boundary. On serialization, overflowing cells get written beyond the parent's bbox, creating junction artifacts with neighboring frames.

**Fix options:**
A. `resizeFrame` should clip/reposition children to fit within new bounds
B. `writeFrameToGrid` should clip children's cells to parent's bbox
C. Clamp children during serialization (not at edit time)

## ROOT CAUSE #3 CONFIRMED: Container bbox not in snapshot → uncovered grid cells not blanked

**This is the PRIMARY cause of 38 ghost failures.** Verified with fractional pixel moves.

**Mechanism:** `snapshotFrameBboxes` only captures frames with `content !== null`. Container frames (content=null) are skipped. The container's bbox covers the ENTIRE wireframe including gaps between child frames. When the wireframe moves, Phase A only blanks individual child bboxes, leaving cells in the gaps (column separators, shared rows between child rects) at their old positions.

**Evidence:** Dashboard moved 50px right → ghosts at row 5 cols 0,12,40,56 (column separator `│` characters). These cells are NOT in any child frame's snapshot bbox — they're in the "gap" between the header rect (rows 2-4) and the body line frames (rows 7+).

**Why grid-aligned moves (CW*5) pass but fractional moves (50px) fail:** Both should fail. The CW*5 test also drops text labels (28→26 content frames). Need to verify if CW*5 actually has ghosts that the test doesn't catch due to how it measures. UPDATE: CW*5 output does NOT have ghosts at old positions — the body rows are properly shifted. This suggests the grid-aligned case somehow works while fractional doesn't. The difference must be in how `Math.round()` interacts with the fractional position to create edge cases in bbox coverage.

**Fix:** Include container frames in `snapshotFrameBboxes`. Even though containers have no `content`, their bbox should be blanked to cover all cells within the wireframe footprint.

## Revised Root Cause Summary

| # | Root Cause | Failure Count | Fix |
|---|-----------|--------------|-----|
| 3 | snapshotFrameBboxes skips containers → uncovered grid cells unblanked | ~38 ghost failures + cascade effects | Add containers to snapshot |
| 1 | Phase B write-order: sibling blanking erases earlier sibling's text children | Subset of 21 frame-count + 6 non-convergent | Fix reparentChildren OR change write order |
| 2 | resizeFrame doesn't constrain children to fit new bounds | Subset of 21 frame-count | Clip children during resize or serialization |
| ? | Prose edit e2e failures | 3 | Likely cursor placement in browser tests, not serialization |
| ? | Undo/redo, newline, selection | 3 | Independent issues |

## Next Steps

1. Run a targeted e2e test with debug output to see what complex fixtures look like
2. Check if e2e resize operations are the hidden cause (resize test wrapped in drag test?)
3. Determine which fix is least regressive to the kill-regions architecture
