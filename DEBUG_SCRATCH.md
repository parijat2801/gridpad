# Debug scratch — harness regression after Tasks 9-14

**Worktree:** `/Users/parijat/dev/gridpad/.claude/worktrees/unified-document`
**Branch:** `feature/add-frame-fix` @ 363d456
**Vitest:** 546/0 — all unit cov green
**Harness:** 112/32 — regressed from 119/25

---

## Phase 1 evidence (gathered)

### Bucket A — "didn't move / didn't resize" (14 tests) — ROOT CAUSE FOUND

**Failing test fingerprint:** `before=0,27 after=0,27` on solo-shape and composite fixtures.

**Reproduction:** `npx playwright test e2e/harness.spec.ts -g "drag: move junction"`. Real error: `dragSelected: frame frame-557-... didn't move (before=0,27 after=0,27 dx=50 dy=0)`.

**Evidence collected via:**
- Unit-level repro: `src/debugBucketA.test.ts` (4 tests, kept as diagnostic)
- Real e2e error message captured

**Root cause: two-bug interaction.**

1. **Bug A1 — `resolveSelectionTarget` drill-down inverts user intent on first click.** For a tree like `band → wireframe → rect` (JUNCTION's first quadrant), `chain.filter(!isBand) = [wireframe, rect]`. With `currentSelectedId === null`, the rule returns `chain[0].id = wireframe`. The user clicked the leaf rect; the WIREFRAME parent gets selected.

   File: `src/editorState.ts` lines 1576-1594.

2. **Bug A2 — `dragSelected` measures wrong frame.** The harness's `dragSelected` (`e2e/harness.spec.ts` line 277) captures `selId` BEFORE issuing `mouse.down`. The `mouse.down` fires `onMouseDown` again, which re-runs `resolveSelectionTarget(hit, currentSelectedId, ...)`. Now `currentSelectedId === wireframe.id` → drills DEEPER → returns `rect.id` → `dragRef.frameId = rect.id`. Drag operates on rect.

   After drag: rect.gridCol changes by +6 (correct). But `recomputeWireframeBounds` (`src/editorState.ts:1602`) re-fits the wireframe bbox to its children. Since other rects didn't move and the moved rect still spans within the wireframe bounds, **wireframe bbox stays unchanged**. Harness queries `findFrameInTree(wireframe.id).absX/Y` → unchanged → "didn't move".

**Why solo-rect (SIMPLE_BOX) also fails:** SIMPLE_BOX has `band(120×4) → rect(16×4)`. `rect.gridH === band.gridH = 4`, so `maxDRow = 4 - 4 - 0 = 0` — vertical clamp = 0 → escalates 100% to band rotation. The model logic IS correct: at unit level, harness perspective (sum of path) absY: 36→144. Leaf appears to move +108px. The unit reproduction PASSES. The browser-level still fails because of Bug A2: harness measured the wireframe (the originally-selected frame), not the rect that was actually dragged.

**Fix shape:**
- Change `resolveSelectionTarget` so the FIRST click (no current selection) returns the LEAF (`hit.id`), not `chain[0].id`. Drill-down only on subsequent clicks of the same hit (Figma-style: click-to-deepest, then ⌘-click to escalate to ancestor).
- OR fix the harness drag helper to re-read selection AFTER mouseDown.
- The first option is also the right user-facing change (click-to-deepest matches Figma/Sketch and avoids surprising container selection).

---

### Bucket B — ghosts after drag (3 tests) — ROOT CAUSE FOUND (partial)

**Reproduction:** `npx playwright test e2e/harness.spec.ts -g "drag: move box down"`. After dragging SIMPLE_BOX 100px down, output.md shows: original wireframe lines (L3-L6) became empty strings, and `┌──────────────┐` appears at L8 (where "Prose below" was). **Wireframe was rotated past its original location into "Prose below"'s row, but only the TOP edge made it — bottom 3 rows fell off the end of the doc.**

**Evidence:**
```
e2e/artifacts/drag-down/output.md:
Prose above




        ┌──────────────┐    <-- only top edge survived
                            <-- doc ends here, rest dropped
```

**Root cause:** `unifiedDocSync` band-rotation handler (`src/editorState.ts:660-728`) rotates the band's claim lines but does NOT grow the doc. When the band's bottom edge would fall past `doc.lines`, the band's claim becomes malformed. Serializer writes wireframe at new gridRow but only rows that map onto existing doc lines survive; rest are silently dropped.

The "ghost ┌" is actually NOT a ghost — it's the SOLE surviving row of the wireframe at its new (clipped) location. Frame-bbox mask whitelists original gridRow region, but wireframe is now at a different row → ghost detector flags it.

**Open question — needs unit test:** rotation budget for SIMPLE_BOX should be `maxDown = 1` (only 1 blank line before "Prose below"). Drag dy=100px ~= 6 rows → effectiveDRow = min(6, 1) = 1. So band should only move down 1 row. But output shows ~5 rows of motion. Either budget calc wrong or band escalates past rotation.

**Fix shape:** verify rotation-budget computation. May need additional clamp / band's bottom never crosses doc end.

---

### Bucket C — tree-shape mismatch (1 test) — KNOWN MIGRATION COST

**Test:** `structure: side-by-side boxes produce 1 container with 2 rect children`

**Reproduction:** Error: expects `tree[0].children` filtered for `contentType === "rect"` to have length 2. Got length 0.

**Root cause:** Phase B introduced the wireframe layer between the band and rect groups. New tree shape is `band → wireframe → [rect, rect]`. Test asserts pre-Phase-B shape `band → [rect, rect]`.

**Fix shape:** update assertion to traverse one more level. Pure migration cost; no production change.

---

### Bucket F — text-label edit (1 test) — ROOT CAUSE FOUND

**Test:** `text-label: double-click label, append char, verify`

**Reproduction:** Wrote a focused playwright spec `e2e/debug-bucket-f.spec.ts` with temporary `console.log` in DemoV2's `onMouseDown`/`onMouseUp` (now reverted). Browser console relayed via `page.on("console")`.

**Evidence:**
- Click 1 (clickFrame helper): `[onMouseDown] hit=text type=text target=rect isDbl=false` — selects rect via drill-down rule (Bug A1).
- Click 2 (first of dblclick, after 400ms gap): `[onMouseDown] hit=text type=text target=text isDbl=false` — drills to text.
- Click 3 (second of dblclick, 50ms after click 2): **NO `[onMouseDown]` fires.** Only `[onMouseUp] dragRef=set`.

**Root cause:** After click 2 selects the small text label (48px wide × 13.4px tall), the resize handles get computed with 24×24 hit boxes around its 8 corners/midpoints. Because the label is SHORTER than the handle hit box (13.4 < 24), **the "tm" (top-middle) handle's hit box covers the entire vertical extent of the label**. Click 3 at the label's center (72, 47) lands inside the tm handle box (72±12 horiz, 28-52 vert).

Code path in `src/DemoV2.tsx:500-508` runs BEFORE the dblclick check at line 519:
```
if (currentSelectedId) {
  const sel = findFrameById(framesRef.current, currentSelectedId);  // text frame
  if (sel) {
    const handleHit = hitTestHandle(computeHandleRects(sel.absX, sel.absY, sel.frame.w, sel.frame.h), px, py);
    if (handleHit) {
      dragRef.current = { ..., resizeHandle: handleHit };
      paint(); return;   // ← returns BEFORE the dblclick check
    }
  }
}
```

**Fix shape:** Either
- Shrink handle hit boxes for small frames (e.g., min(HANDLE_HIT, frame.w/2, frame.h/2)).
- OR check `isDblClick` BEFORE the handle-hit branch — dblclick on a text label always means "edit text".
- OR exclude text-content frames from showing resize handles entirely (text labels resize via parent rect).

The third option matches user mental model best.

---

### Bucket E — deep-tree edge cases — INVESTIGATED

**E143 "dragging a rect up inside its band clamps at band top edge":**
- Side-by-side rects in one band: `band → wireframe → [rectA, rectB]`. clickFrame(0) selects wireframe (Bug A1), drag retargets to rectA (Bug A2).
- Drag rectA UP. minDRow = -bandRow = -0 = 0. clampedDRow = 0 (no movement). residualDRow = -15 (full drag delta).
- Residual escalates to BAND. Band rotation budget = blank lines above = 1. Band moves up 1 row. Rect's absY decreases by ~13.4px.
- Test expected rectA.y unchanged, got rectA.y = 13.4 (was 25.7 — moved up 12.4 ≈ 1 row of ch=13.4).
- **Root cause:** vertical residual escalates BOTH directions, but `// Horizontal residual has no rotation analog... is dropped` comment says horizontal is dropped. Vertical-up at top edge has the same "into a wall" semantics — should also be dropped or clamped against an *empty* band-rotation budget.
- Or simpler: residual should only escalate when child got SOME meaningful clamped displacement. Here clampedDRow=0, no displacement → no residual escalation.
- **Same family as Bucket A (drag handler bug).**

**E135 "drag frame A past frame B: B does not move":**
- Two separate top-level bands. Drag rect in band1 down past band2.
- Bug A2 retargets selection to rect. Drag emits moveFrameEffect(rect). Can't move within band1 (full-fill). residual escalates to band1. Band1 rotates down by maxDown (1 row).
- Test asserts band2 (lower) doesn't move. Got: band2 moved by ~13.4px (1 row).
- **Root cause hypothesis:** band1 rotation logic deletes \n at endLine.to and inserts at startLine.from. This shifts ALL chars between the boundaries by ±1, but ALSO affects band2's docOffset interpretation when CodeMirror remaps positions. Need to verify with focused test, but very likely a side-effect of the rotation rebalancing.
- May overlap with Bucket B's rotation-past-doc-end issue.

**E131 "equal-size frames passed through each other do not nest":**
- TWO_SEPARATE: two equal-size separate boxes. Drag frame 0 down past frame 1. Expect: both still top-level (no nest).
- Got: only 1 ┌ in saved → one frame deleted/merged into the other.
- Investigation: mouseUp's reparent guard `targetIsLarger = hitTopLevel.gridW > draggedFrame.gridW`. With eager bands wrapping, `hitTopLevel = band2 (gridW=120)`, `draggedFrame = rect0 (gridW=8)`. Guard ALWAYS true → reparents.
- **Root cause:** the size-guard at `src/DemoV2.tsx:709-711` compares the small rect to the wide band. Pre-eager-bands, `hitTopLevel` was the rect itself (top-level was a rect). Now it's a band. Guard logic needs updating to compare BAND to BAND or LEAF to LEAF.

**E132 "undo a drag-into-frame reparent restores original tree":**
Same root cause as E131 — the equal-size guard is bypassed, so reparent happens when it shouldn't. Then undo doesn't restore correctly because the reparent transaction nested differently than expected.

**E136, E137 "promote then drag old/promoted parent":**
Failing assertion: `afterPromote.length === 2`, got 1. The promote step itself isn't producing 2 top-level frames. Likely: after promote, the eager-band rewrap merges them back. Needs separate investigation — distinct from Bucket A.

**Bucket E summary:**
- E143: same family as Bucket A (drag handler residual escalation).
- E135: same family as B + A (band rotation side effects).
- E131, E132: distinct bug — `targetIsLarger` reparent guard bypassed by eager-bands wrapping.
- E136, E137: distinct bug — promote/eager-band interaction. Needs investigation.

---

## Full failing-test inventory (from real run)

```
14   drag: move box down, no ghosts                                          [B]
15   drag: move junction-char box, junctions preserved                       [A]
29   text-label: double-click label, append char, verify                     [F]
32   structure: side-by-side boxes produce 1 container with 2 rect children  [C]
62   move-then-enter: move frame down, then Enter above it                   [A→D]
70   align: change to right align, then move, save                           [A]
71   multi: move two different frames, save                                  [A]
72   multi: move frame, resize another, edit prose between                   [A]
78   drag 2x2 junction grid right, check for ghosts                          [A]
80   drag three-in-row right, no ghosts                                      [A]
82   drag shared-wall box twice, position accumulates                        [A]
84   resize shared-horizontal box, no ghosts                                 [A]
92   resize box to overlap with adjacent box                                 [A]
94   drag shared-wall box, undo, save — original position restored           [A]
96   move two separate boxes toward each other, save                         [A→D]
98   undo: resize then undo, save matches original                           [A→D]
99   undo: move-resize-undo-undo, back to original                           [A→D]
101  prose order preserved when dragging wireframe up                        [B]
109  Backspace merges line above wireframe, frame shifts up                  [A→D]
117  move all 4 frames in default doc, save                                  [A]
119  delete child → undo → move parent                                       [A]
128  drag frame into larger frame: demoted to child                          [A→D]
129  drag child out into empty space: promoted to top-level                  [A→D]
130  drag child to a different parent: child nests under new parent          [A→D]
131  equal-size frames passed through each other do not nest                 [E]
132  undo a drag-into-frame reparent restores original tree                  [E]
133  drag frame A down: frame B's y stays put                                [A]
135  drag frame A past frame B: B does not move                              [E]
136  promote then drag old parent: promoted frame stays put                  [E]
137  promote then drag the promoted frame: old parent stays put              [E]
143  dragging a rect up inside its band clamps at band top edge              [E]
144  drag upper band down: lower band's y stays put (rotation invariant)     [A]
```

Total: 32 failures. Bucket projection:
- A (selection drill-down): ~14 direct + ~8 cascading via D = ~22 tests
- B (band rotation past doc end): 2-3 tests
- C (tree-shape migration): 1 test
- E (deep-tree, partly downstream of A): 4-6 tests
- F (handle hit-box steals dblclick): 1 test

**Projected:** Fix Bucket A → ~22 pass. Fix B → 2-3 more. Fix F → 1. Update C → 1. E split. Estimate 3-5 remaining after all root-cause fixes.

---

## Phase 2 / 3 / 4: pending

Plan to write to `DEBUG_PLAN.md` once Bucket E investigation completes.
