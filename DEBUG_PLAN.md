# Debug plan — gridpad harness recovery

**Worktree:** `.claude/worktrees/unified-document`
**Current status:** vitest 603/2 (both fails are diag tests that pin deferred apply-layer bugs B + C), harness **139/6**.
**Trajectory:** 112/32 (regression baseline, ~6 weeks ago) → 139/6 (today). Target: 144/0.

This is the **live working doc**. The "Shipped fixes" table summarizes what's already landed; the rest of the file is open work — Group A/B/C/D taxonomy, recommended next-step order, and the active investigation appended at the bottom.

---

## Shipped fixes (2026-04-29 → 2026-05-02)

| Fix | Commit | Effect |
|-----|--------|--------|
| 1 — drag-vs-click separation in onMouseDown | 957a90b | -15 harness (112→127) |
| 7 — test asserted pre-Phase-B tree shape | e6e9251 | -1 |
| 4 — text frames excluded from resize handles | 6ba9c7c | -1 |
| 8 — tests drill from shrink-wrap before resize | f3df3cc | -2 |
| 3 — decideReparent leaf-vs-leaf size guard | 70822a2 | 0 (proven via 4 unit tests) |
| 5 — shouldEscalateResidual + bandSlackRows | 52b0964 + d69e9ae | 0 (proven via 6 unit tests) |
| 10 — Home/End handlers in prose mode | 07d889d | -1 |
| 2 — clampBandMoveDelta past doc end | 926764c | 0 (defensive; data-loss prevention) |
| 9 — commit-on-mouseup for resize/move drags | 4b745bf | -2 |
| 14 — computeRotationBudget single source of truth | 01b255b | net 0 (better failure quality, exposed downstream reparent issues) |
| line-height bump (1.15× → 1.4×) | f747d04 | cosmetic |
| reparent revival (size guard removal, bbox-skip-on-move, mouseup repaint) | 3a06b24 | shape-shift; rebaseline 132/13 |
| **Bug A — decideReparent doc bound** | 537ee5e | **+2 (132/13 → 134/11)** |
| **Bug B — landingGridFromCursor (grab-offset)** | eb74556 | **0 net (correctness fix; 1 test rewritten)** |
| **Bug C — decideReparent prose-row guard** | (this session, 2026-05-03) | **+5 (134/11 → 139/6); 1 sibling regression exposed** |

**Trajectory:** 112/32 (regression baseline, ~6 weeks ago) → 134/11 (today). Final target: 144/0.

**Open work** lives in the next sections (Group A/B/C/D + the 2026-05-02 ghost-on-drag investigation).

## Failure categorization (drawn against 132/13 baseline; 2 of these have since cleared via Bug A fix)

The 13 baseline failing tests clustered into three groups (still useful for navigating remaining 11):

### Group A — tests assert pre-revival behavior (5 tests)

These tests assert "drag wireframe past another wireframe does not
nest" or "equal-size frames don't nest each other." Pre-revival, the
size guard rejected these drops; post-revival, drops now legitimately
demote when cursor lands on a target. The tests need to be UPDATED
to reflect the new (Figma-like) UX. These are not bugs.

- "equal-size frames passed through each other do not nest"
- "Fix 14: drag does not cross non-blank prose line"
- "drag frame A past frame B: B does not move"
- "large-drag: drag first wireframe past second, no collision"
- "drag box down onto another — overlapping positions"

### Group B — reparent-on-drop interactions (4 tests)

Tests that drag a wireframe with extreme cursor offset (past doc end,
into prose, etc.). Reparent now fires more aggressively; in some
cases the new band lands at a row that collides with prose or
existing claims. Drop position needs better post-clamp handling.

- "prose order preserved when dragging wireframe down"
- "promote then drag old parent: promoted frame stays put"
- "promote then drag the promoted frame: old parent stays put"
- "undo a drag-into-frame reparent restores original tree"

### Group C — independent issues (4 tests)

Not directly related to reparent revival; pre-existing bugs in
move/rotation paths.

- "drag: move box down, no ghosts"
- "drag shared-horizontal box down, no ghosts"
- "move-then-enter: move frame down, then Enter above it"
- "dragging a rect up inside its band clamps at band top edge"

### Group D — transient double-band after promote (no test yet)

**Reported by user 2026-05-02. Visual issue, not in harness.**

**Symptom:** After horizontally dragging a child wireframe OUT of
its parent dashboard (promote → new top-level band), TWO BANDS
visibly coexist for some time. The new band's selection bbox and
the old band's selection bbox overlap vertically by 1-2 rows.
While both bands exist, subsequent drags of either wireframe behave
weirdly (motion clamps strangely, frame jumps unexpectedly). Once
the user moves either wireframe enough that the two bands' claim
ranges actually OVERLAP, `mergeOverlappingBands` fires and
collapses them into ONE band. From then on, motion is correct.

**Hypothesis:**
1. Promote (`applyReparentFrame` with `null` parent) creates a new
   band at `aRow = Math.round(upPy / ch)`. The new band's claim
   occupies `[aRow, aRow + gridH)`.
2. The OLD parent band's claim was `[oldRow, oldRow + oldH)`. When
   the child leaves, the old band may shrink (cascade-prune) or
   not, depending on remaining children.
3. If the new band's claim is ADJACENT to the old band's (e.g.,
   one starts where the other ends, sharing an edge but not rows),
   `mergeOverlappingBands` sees no overlap → both survive.
4. The visual selection bbox extends 1-2 rows beyond the actual
   claim due to padding/handles, making them LOOK overlapping
   even when their claims don't.
5. Each band has its own `computeRotationBudget` walls; the two
   bands wall each other off, producing the "weird motion."
6. Once the user drags one band by enough to ACTUALLY overlap the
   other band's claim (not just visually), `mergeOverlappingBands`
   collapses them and motion normalizes.

**Possible fixes (not implemented):**
- After `applyReparentFrame` (promote case), explicitly check if
  the new band's claim is adjacent to any other band's claim. If
  so, eagerly merge or place the new band with at least 1 blank
  row of separation.
- Or: change the promote target so the new band always lands in
  EMPTY blank space (not row-adjacent to existing bands), which
  may require shifting the promote drop position.
- Or: relax `mergeOverlappingBands` to also merge ADJACENT bands
  (touching but not overlapping). Risky — bands separated by 0
  blank rows may be intentionally distinct in some flows.

**Severity:** UX papercut, not data corruption. Self-heals when
user keeps interacting. Worth fixing but lower priority than
Groups A/B.

---

## Recommended fix order (REVISED 2026-05-02 after reparent revival)

**Sessions shipped:** Fix 2, 3, 5, 9, 10, 14, plus reparent revival
(size guard removed, bbox-skip-on-move, mouseup repaint). Reparent
revival was NOT in the original plan — it emerged from runtime
testing where the architect noticed "drag-onto-frame does nothing."

**Critical re-evaluation needed.** The reparent revival fundamentally
changed the drag-and-drop UX: children can now leave their parent,
nest into other frames, and the bbox stays put. Many of the
remaining 11 harness failures (134/11 pre-revival) likely behave
differently now. The harness should be re-run as a baseline before
any further plan work.

**Open work, re-prioritized:**

1. **Group A — update tests to match new UX (5 tests, easy).** These
   tests assert pre-revival behavior that is now incorrect. Update
   each to assert the new (Figma-like) expected behavior: when the
   user drags wireframe A onto wireframe B, A nests as a child of B.
   For "drag past" tests, change the action to drop in EMPTY SPACE
   past B (cursor not on any wireframe) — that triggers the move
   path without nesting. ~30 min total.

2. **Group B — fix reparent edge cases (4 tests, medium).** When the
   drop position lands past doc end or on prose, the resulting
   reparent corrupts the doc. Two sub-fixes:
   - Clamp `aRow` for promote/demote so the new claim doesn't
     overlap non-blank prose lines.
   - Skip reparent entirely when the drop row is unreachable
     (cursor past doc end with no blank rows available).

3. **Group C — independent move/rotation bugs (4 tests, varies).**
   Investigate each. May or may not relate to existing planned
   fixes (13, 12, 11).

4. **Architectural cleanup** (deferred, optional) — the per-tick
   drag handler still mutates state via `moveFrameEffect` even
   though Fix 9's commit-on-mouseup makes the per-tick mutations
   redundant for history purposes, and the reparent revival
   showed that per-tick state pollutes mouseup hit-testing
   decisions. A pure mouseup-only model (visual ghost during
   drag, single commit at mouseup) would simplify the codebase
   significantly. Big change — only worth it if remaining
   harness failures cluster around per-tick state-vs-cursor
   disagreement after Groups A and B are addressed.

Final target unchanged: harness 144/0.

After each commit: run `npx vitest run` and `npx playwright test e2e/harness.spec.ts --workers=8` (8 workers cuts harness time from 156s → 81s).

---

## Diagnostic artifacts left in place

- `src/debugBucketA.test.ts` — 4 vitest cases that demonstrate click + drag math at the model layer.
- `src/debugBucketF.test.ts` — vitest case showing model can complete dblclick → text-edit → save when given effects directly.
- `e2e/debug-bucket-f.spec.ts` — instrumented playwright spec showing the missed mousedown for click 3.
- `e2e/artifacts/drag-down/output.md` — captured evidence of Bucket B clipping.
- `e2e/probe-investigations.spec.ts` — five INV probes for Fixes 2/9/10/11/12 (delete after fixes commit).

These can be deleted before merge, or kept as regression-watch tests.

---

## 2026-05-02 (session) — Ghost-on-drag investigation

**Trigger.** Group A test patches (drop-in-empty-space) did not reduce the harness count (still 132/13). The same 5 tests fail with a NEW failure mode: saved markdown contains stray `┌` glyphs (ghost wire chars) at positions no frame in the post-reload tree claims.

**Evidence so far.**
- `e2e/artifacts/drag-down/`: input is a single frame between "Prose above" and "Prose below". After `dragSelected(0, 100)` and save, output is:
  ```
  Prose above
  
  
  
  
  
  
          ┌──────────────┐
  ```
  `tree-after.json` is `[]` — the frame is gone from the model. "Prose below" is also lost. A phantom `┌──────────────┐` line survives at column 8 (matching the drag's horizontal offset, which should have been 0).
- `e2e/artifacts/large-drag/`: drag A past B in TWO_SEPARATE. Output keeps B intact but appends a stray `┌────┐` at line 13 (the prose row "Bottom" is gone, replaced by phantom corner).

**Symptom common to both.** The frame disappears from the model (tree shrinks) but its top edge `┌` survives in the doc text. Real-prose lines below the drag origin go missing.

**Smells like.** The unified-document `moveFrameEffect` handler's rotation/relocate code edits doc text (inserting blank rows above the new frame position, removing rows below) without keeping the frame model's claim ranges in sync. When the post-rotation row is past doc end the frame model evicts the frame entirely, but the doc text still has the original `┌` lines.

**Investigation strands (in flight).**
1. **Unit reproducer** — recreate the leak in vitest at the model layer to bisect playwright vs model.
2. **Data flow trace** — find the boundary in `editorState.ts` (or `frame.ts` / `gridSerialize.ts`) where text edits and frame removals desync.

### Strand 1 finding — unit reproducer (model-layer leak confirmed)

Reproducer at `src/ghostOnDragPastEnd.diag.test.ts` (3 tests, 1 pass / 2 fail). The bug reproduces purely at the model layer — no playwright needed.

**Root cause (single line, file:line cited):** `src/editorState.ts:1854-1856`. `decideReparent(frames, draggedId, dropPx, dropPy)` returns `{ kind: "promote" }` whenever:
1. `hitTestFrames` returns null at the cursor position (cursor is in empty space — including past doc end), AND
2. `draggedId !== draggedTopAncestor.id` (the dragged thing is a child, not a top-level frame).

The branch is correct for "child dragged into empty mid-canvas space" (legitimately promote it) but wrong when the cursor is past the doc's last line — there's no row to land on, so the resulting promote clamps to `docLines - 1 = 7` and overwrites whatever prose lives at row 7 ("Prose below" in the repro).

**Mechanism of the ghost:**
1. User drags the rect (leaf, `id = "rect-1"`, parent band `id = "band-0"`) past doc end.
2. `decideReparent` returns `promote` because cursor missed all frames AND the rect's top ancestor (band) ≠ rect.
3. `applyReparentFrame(state, rectId, null, aRow=7, aCol=8, ...)` runs. `aRow` is clamped to `docLines - 1`. `aCol` carries the cursor's leftover horizontal offset (8 in the repro).
4. The band gets emptied and pruned. The rect becomes a new top-level claim at row 7, col 8.
5. `serializeUnified` writes wireframe chars at row 7 and drops the prose that lived there → "Prose below" lost; phantom `        ┌──────────────┐` appears in the saved doc.

**Why it produces "ghosts" rather than visible bugs in the live editor:** the reload after save reads back the doc text, the scanner sees the orphaned `┌──────────────┐` but no matching `└` close-row, so it discards the partial frame. Result: tree-after = `[]` AND a stray glyph survives in the markdown → "ghost" detector fires.

**Fix surface (small).** Guard `decideReparent` so that promote only fires when `hitTestFrames` returned a non-null target (cursor is inside another frame), or when the cursor is within doc bounds AND on a blank-space row. Specifically: refuse promote if `dropPy > (doc.lines * ch)` or refuse promote whenever `hitTestFrames` is null (empty-space drops should fall through to the move path, not promote).

### Strand 2 finding — data-flow trace (corroborates strand 1, adds drift mechanism)

Read-only trace of `onMouseUp → decideReparent → applyReparentFrame → reparentFrameEffect → serializeUnified` confirms strand 1 and surfaces TWO compounding bugs at the same call site:

**Bug A (spurious promote)** — `src/editorState.ts:1853-1856`:
```typescript
const targetLeaf = hitTestFrames(frames, dropPx, dropPy);
if (!targetLeaf) {
  if (draggedTopAncestor.id !== draggedId) return { kind: "promote" };
  return { kind: "none" };
}
```
A pure vertical drag of a child rect lands the cursor in empty space (no frame hit). The branch fires `promote` because `draggedTopAncestor.id (band) !== draggedId (rect)` — even when the user just wanted to nudge the rect within its band.

**Bug B (column drift on promote)** — `src/DemoV2.tsx:800-816`:
```typescript
const decision = decideReparent(framesRef.current, draggedId, upPx, upPy);
if (decision.kind === "promote") {
  const aRow = Math.max(0, Math.min(docLines - 1, Math.round(upPy / ch)));
  const aCol = Math.round(upPx / cw);   // ← cursor X, not original frame col
  stateRef.current = applyReparentFrame(stateRef.current, draggedId, null, aRow, aCol, cw, ch);
}
```
`upPx` is the cursor position at mouseup — for a frame whose center the user grabbed, that's `originalLeft + frame.gridW/2 * cw`. For a 16-col frame starting at col 0, `aCol` becomes `8` ⇒ phantom appears at col 8 of the saved doc. Pure vertical drag → horizontal drift on promote.

**How they compose to produce the ghost.**
1. User drags rect-in-band downward, cursor exits doc bottom → empty space.
2. Bug A fires `promote`.
3. Bug B picks `aCol = 8` (cursor X = frame center) and `aRow = docLines - 1 = 7` (clamped past-end Y).
4. `applyReparentFrame` (a) deletes the source band's claim (rows 3-5), (b) creates a new top-level band with the rect at `gridCol=8`, claiming row 7.
5. Row 7 had `"Prose below"` → overwritten.
6. `serializeUnified` writes `        ┌──────────────┐` at row 7.
7. On reload, scanner sees an orphan `┌` with no closing `└` → drops the partial frame from the model.
8. Result: tree-after = `[]`, markdown contains a phantom glyph at col 8 row 7 → "ghost".

### Phase 3 — hypothesis & fix plan

**Hypothesis (single).** The visible ghost-on-drag failures are caused by Bug A alone (spurious promote when cursor lands past doc end). Bug B (column drift) only matters for *legitimate* promotes (drop in mid-doc empty space) — none of the failing tests exercise that. Fix Bug A first; re-run; decide on Bug B based on remaining failures.

**Fix (Option B — push doc bound into helper).** Change `decideReparent` signature to take `docExtentPy` (= `docLines * ch`). Refuse `promote` when `dropPy > docExtentPy`. Update one production call site (`DemoV2.tsx:800`) and existing tests in `reparentDecision.test.ts` and `ghostOnDragPastEnd.diag.test.ts`.

```typescript
// New signature — docExtentPy is the px extent of the doc body.
export function decideReparent(
  frames: Frame[],
  draggedId: string,
  dropPx: number,
  dropPy: number,
  docExtentPy: number,   // ← new
): ReparentDecision {
  // ... existing body ...
  if (!targetLeaf) {
    if (draggedTopAncestor.id !== draggedId
        && dropPy >= 0
        && dropPy <= docExtentPy) {
      return { kind: "promote" };  // legitimate empty-space promote in doc bounds
    }
    return { kind: "none" };  // out-of-bounds OR top-level dragged
  }
  // ...
}
```

**Why this is the right surface (not "fix in DemoV2.tsx"):** the helper is meant to be a pure decision oracle ("given this geometry, what should reparent do?"). The "doc has finite extent" is part of that geometry — passing the extent in completes the contract. Fixing in DemoV2.tsx would leave the helper subtly wrong for other callers (none today, but the test file already calls it with no doc-bound info).

**Expected impact.** Group A (5 tests) + half of Group C (the 3 "no ghosts" tests) clear. Estimated: 132/13 → ~140/5.

**Bug B status (column drift on promote).** Deferred. Will reassess after Bug A fix lands and the harness reveals which of the remaining 13 failures still involve a legitimate promote.

### Phase 4 outcome — Bug A fix landed, harness 132/13 → 134/11

**Diff applied** (across 4 files):
- `src/editorState.ts:1844` — `decideReparent` now takes a 5th param `docExtentPy: number`. The `!targetLeaf` branch refuses to return `{ kind: "promote" }` when `dropPy < 0 || dropPy > docExtentPy` and falls through to `{ kind: "none" }`.
- `src/DemoV2.tsx:800` — call site computes `docExtentPy = stateRef.current.doc.lines * chRef.current` and passes it as the 5th arg.
- `src/reparentDecision.test.ts` — 4 existing test calls updated with `Number.POSITIVE_INFINITY` (preserves their pre-fix expectations).
- `src/ghostOnDragPastEnd.diag.test.ts` — diag test calls pass realistic `state.doc.lines * CH`.

**Suites:**
- vitest: 589/1. The 1 fail is the diag test that calls `applyReparentFrame` directly with past-end coords — this demonstrates Bug B (deeper bug at the reparent application layer) and is intentional signal, not regression.
- harness: 134/11 (+2 from baseline). Cleared: `drag: move box down, no ghosts`; `prose order preserved when dragging wireframe down`.

**Still failing (11):**

| Group | Test |
|-------|------|
| A | large-drag: drag first wireframe past second |
| C | move-then-enter: move frame down, then Enter above |
| C | drag shared-horizontal box down, no ghosts |
| A | drag box down onto another — overlapping positions |
| A | equal-size frames passed through each other do not nest |
| B | undo a drag-into-frame reparent restores original tree |
| A | drag frame A past frame B: B does not move |
| B | promote then drag old parent: promoted frame stays put |
| B | promote then drag the promoted frame: old parent stays put |
| C | dragging a rect up inside its band clamps at band top edge |
| A | Fix 14: drag does not cross non-blank prose line |

**Reading.** None of these involve cursor-past-doc-end — they all reach a different codepath. The 5 Group A cases drop ON another frame's bbox (now triggers demote, not promote — but apparently still produces ghosts, suggesting demote has its own column-drift / claim-overwrite issue analogous to Bug B). Group B (3 reparent edge cases) and Group C (3 rotation/clamp bugs) are independent.

**Next.** Two distinct work items remain:
1. **Bug B (column drift).** When `applyReparentFrame` runs (whether from a legitimate promote or a demote), `aCol = Math.round(upPx / cw)` uses the cursor's center-of-frame X instead of preserving the dragged frame's original `gridCol`. Fix: pass the dragged frame's current `gridCol` as the new column for vertical-only drags, or compute `aCol = upPx/cw - frameW/2` to convert cursor-center back to frame-left-edge.
2. **Group B/C investigation.** Each likely a separate root cause; needs its own systematic-debugging round.

**Lessons (prediction vs reality).** Phase 3 estimated +8 fixes (~140/5); actual was +2 (134/11), miss of ~6. Cause: I assumed all 5 Group A failures hit Bug A's past-doc-end branch. Only 2 did (`drag: move box down`, `prose order preserved when dragging wireframe down`). The other 3 Group A drops land *on* B's bbox, triggering `demote` — which uses the same `aCol = round(upPx/cw)` formula in `DemoV2.tsx:805` (cursor-center, not frame-edge) → Bug B's column drift produces equivalent ghosts on the demote side. Bug A and Bug B are sibling expressions of the same underlying issue: `onMouseUp` translates cursor coordinates to frame coordinates without accounting for (a) doc bounds, (b) where on the frame the user originally grabbed. Fixing Bug B should clear the rest of Group A and possibly some of Group B.

### Phase 5 outcome — Bug B fix landed, harness 134/11 (no net move)

**Diff applied** (3 files):
- `src/editorState.ts:1820-1859` — new pure helper `landingGridFromCursor(upPx, upPy, grabOffsetPx, grabOffsetPy, cw, ch, docLines)` translates a cursor-at-mouseup back to the dragged frame's top-left grid cell. Clamps `aRow` to `[0, docLines-1]` and `aCol` to `[0, ∞)`.
- `src/DemoV2.tsx:798-820` — both `demote` and `promote` branches now compute `grabOffsetPx = startX - startFrameX` (and same for Py) from the existing `dragRef.current` (no new state needed), then call the helper. Replaces inline `aRow = round(upPy/ch); aCol = round(upPx/cw)` in both branches.
- `src/landingGridFromCursor.test.ts` — 5 unit tests pin the helper (vertical-only drag preserves col, edge-grab tracks frame-left, clamps in both axes).
- `src/dragGeometry.diag.test.ts` — 5 invariant tests pin the geometry: grabbed point follows cursor for center / top-left / bottom-right / vertical-only / horizontal-only drags.
- `e2e/harness.spec.ts:3608-3614` — `drag child to a different parent` test updated to drop at `b.y + b.h/2 + childNode.h/2` so Inner's top edge lands at B-center (not at B-title) under the new (correct) center-grab geometry.

**Suites:**
- vitest: 599/1 (added 10 tests). The 1 fail is the same pre-existing `applyReparentFrame promote empties the band` diag test that calls the model directly — unchanged signal, intentional pin.
- harness: **134/11 (net 0)**. The Bug B fix is geometrically correct (verified by 10 unit tests) but did NOT clear any of the original 11 failures. The 1 transient regression (`drag child to a different parent`) was caused by the test having been tuned to the buggy off-by-h/2 behavior; updating its drop coordinates restored it.

**Lessons (prediction vs reality, again).** Phase 4 hypothesis: "Bug B's column drift on demote produces equivalent ghosts → fixing it clears the 3 Group A demote tests and possibly some of Group B." Actual: 0 of those 11 cleared. The hypothesis was wrong. Ghost glyphs in the remaining failures have a DIFFERENT root cause — Bug B was a real correctness bug (sibling of Bug A) but is **not the lever** for the residual harness failures. Two takeaways:
1. The cursor-center vs frame-edge gap mattered for the `drag past doc end` cases (Bug A) because the doc-bound clamp turned a small horizontal drift into a same-row prose collision. Without that clamp interaction, the column drift alone doesn't surface as a harness ghost — `unifiedDocSync` handles in-doc drag deltas correctly via `moveFrameEffect` per tick; only the reparent application path saw the wrong column, and apparently that drift mostly fell within tolerance for the remaining tests.
2. Test `drag child to a different parent` was a hidden tripwire: it asserted "Outer B label survives" when grabbing Inner's center and dropping at B-center. With pre-fix off-by-h/2 placement, Inner landed below B-title (passes by accident). With correct centering, Inner overlaps B-title. **Whenever a test passes with a known buggy geometry, it's pinning the bug, not the spec.** Worth grep-auditing other passing tests for similar accidental dependencies.

**Open work unchanged.** The 11 remaining failures still cluster as Group A (5 demote-onto-frame ghosts), Group B (3 reparent edge cases), Group C (3 move/clamp bugs). Next session needs a fresh hypothesis for Group A specifically — Bug B is exhausted as an explanation. Probable next probes:
- Instrument `applyReparentFrame` to log the source-band cleanup vs. the destination claim — does the source band's claim release fully when the dragged child demotes into a different parent? (i.e. is there a row-overlap leak between source and destination when both top-levels are vertically close?)
- Look at `unifiedDocSync` for the reparent transaction — does it serialize the new claim BEFORE releasing the old one, leaving the source's wireframe glyphs in the doc text temporarily and then failing to clear them?

### 2026-05-03 (session) — Bug C investigation: promote into prose-occupied row

**Trigger.** Group A re-attack via systematic-debugging skill. Picked the cleanest failing test (`equal-size frames passed through each other do not nest`) for a model-layer reproducer.

**Reproducer:** `src/ghostOnEqualSizePromote.diag.test.ts` (4 tests, 1 fail surfaces the bug). The failure reproduces purely at the model layer — calls `applyReparentFrame(state, A, null, aRow=11, aCol=0, ...)` with no Playwright. Saved markdown matches the harness fingerprint exactly: "Bottom" prose lost, orphan `┌────┐` at the end with no closing `└`.

**DIAG trace (test 4 in the file):**
- BEFORE: 13-line doc; band-A claims rows 2-4 (`docOffset=5`); band-B claims rows 8-10 (`docOffset=17`); "Bottom" at row 12.
- aRow computed by `landingGridFromCursor(dropPy=232.4, grabOffsetPy=A.h/2=27.6, ch=18.4, docLines=13)` → `framePy=204.8`, `aRow=round(204.8/18.4)=11`. Clamped to docLines-1=12 max → 11.
- AFTER: 12-line doc; "Middle" shifts up to row 3 (was 6); "Bottom" lands at row 11 (was 12); new band-A' has `gridRow=11 lineCount=3 docOffset=20`. **The new band's claim covers row 11 — which contains "Bottom" prose.**
- Serializer renders frame cells at row 11 → "Bottom" overwritten with `┌────┐`. Rows 12 and 13 of the band's claim don't exist in the doc → clipped silently.

**Root cause (Bug C):** A promote whose `aRow + frame.gridH` lands on or past existing prose silently destroys that prose. Specifically the `unifiedDocSync` promote handler (`editorState.ts:811-833`) inserts only the difference between `frame.gridH` and consecutive blank rows after `targetLine`. When there are zero blank rows after the target (because the target IS prose), it inserts blanks BEFORE the prose line. The framesField then maps `docOffset` to `tr.newDoc.lineAt(...)` and lands on the prose line itself, not on the freshly inserted blanks. The serializer overrides docLines[row] with the band's content for any claimed row → ghost.

**Why Bug A (doc-bound guard) didn't catch it.** `dropPy = 232.4` < `docExtentPy = 13 * 18.4 = 239.2`. Drop is in bounds; Bug A's guard only refuses out-of-bounds. The drop is in the legal-but-occupied region between the last band and doc end.

**Fix surface decision.** Three candidates considered:
1. **decideReparent** — extend signature to take prose-row info; refuse promote when target row(s) overlap prose. Mirrors Bug A's `docExtentPy` pattern; decision oracle stays the single source of truth.
2. **applyReparentFrame** — silently no-op promote when target overlaps prose. Localized but pushes business logic into the apply layer.
3. **unifiedDocSync** — re-order or relocate the blank inserts. Most invasive; transactions already complex.

**Chosen: option 1.** Extend `decideReparent` to take a `proseRows: Set<number>` (rows containing non-blank prose). Promote branch refuses when any row in `[aRow, aRow + draggedFrame.gridH)` is in `proseRows`. Caller (`DemoV2.tsx`) builds the set from doc text; tests pass an empty set to preserve their pre-fix behavior unless they explicitly test the new guard.

Optional refinement: fold `landingGridFromCursor` into `decideReparent` so the oracle owns the row computation. Deferred for now to keep the diff small — the call site already computes aRow/aCol and passes both to `applyReparentFrame`; passing them to `decideReparent` too is one extra param.

**Predicted impact.** Clears `equal-size frames passed through each other do not nest` (verified at model layer). Likely clears `Fix 14: drag does not cross non-blank prose line` (same mechanism — promote target lands on prose). Less certain for the other 3 Group A tests where the drop is ON another frame (demote path, not promote).

### Phase 6 outcome — Bug C fix landed, harness 134/11 → 139/6 (+5)

**Diff applied** (3 files):
- `src/editorState.ts:1859-1916` — `decideReparent` now takes optional 6th param `promoteLanding: { aRow, gridH, proseRows }`. Promote branch refuses when any row in `[aRow, aRow + gridH)` is in `proseRows`. `findFrameInList` exported for caller use.
- `src/DemoV2.tsx:798-830` — call site computes `proseRows` (rows with non-blank doc text) and passes `promoteLanding` to `decideReparent`. The aRow already came from `landingGridFromCursor`.
- `src/ghostOnEqualSizePromote.diag.test.ts` — 5 tests: input fixture pin, decideReparent without/with prose-rows, apply-layer pin (failing — defers deeper apply-layer bug), DIAG trace.

**Suites:**
- vitest: 603/2. Two failing tests are intentional pins of the deferred apply-layer bugs (Bug B's leftover in `ghostOnDragPastEnd.diag.test.ts`, and Bug C's apply-layer in `ghostOnEqualSizePromote.diag.test.ts`). Same pattern as established in Phase 4 (vitest 589/1 → 603/2 after adding 14 new passing tests + 1 new pinning test).
- harness: **139/6**. Cleared 6 from baseline 134/11:
  - `large-drag: drag first wireframe past second`
  - `move-then-enter: move frame down, then Enter above`
  - `drag shared-horizontal box down, no ghosts`
  - `drag box down onto another — overlapping positions`
  - `drag frame A past frame B: B does not move`
  - `Fix 14: drag does not cross non-blank prose line`
- One **regression**: `move two separate boxes toward each other, save` now fails. Pre-fix it passed.

**Regression mechanism (NOT a true regression, but a sibling bug exposed).** The test moves A down 80px, then moves B up 80px. Pre-fix, A's drag down created a ghost (mostly silently — the test didn't assert against the ghost, only `expect(saved).toContain("A")`). Post-fix, A's drag-down works correctly. THEN B's drag up triggers a demote-into-A or a promote whose target row overlaps A's new row → produces a NEW ghost in the opposite direction. The bug is the same class (apply-layer overwriting prose during reparent) but on the demote side.

**Still failing (6):**

| Group | Test | Mechanism |
|-------|------|-----------|
| (regression) | move two separate boxes toward each other, save | Same as Bug C but on demote side |
| A | equal-size frames passed through each other do not nest | Tree-shape assertion mismatch (test outdated for band wrapping; not a ghost any more) |
| B | undo a drag-into-frame reparent restores original tree | Reparent edge case |
| B | promote then drag old parent: promoted frame stays put | Reparent edge case |
| B | promote then drag the promoted frame: old parent stays put | Reparent edge case |
| C | dragging a rect up inside its band clamps at band top edge | In-band clamp bug |

**Next.** Two paths to consider:
1. **Bug D (sibling of Bug C, demote side):** Apply same proseRows guard to demote branch in `decideReparent`. When demote target row + dragged.gridH would overlap prose past the destination top-level's claim, refuse demote. Risk: too aggressive — legitimate nest-into-frame drops shouldn't be blocked.
2. **Update `equal-size frames` test assertion:** Walk past band-wrapper to assert "no nested rects under any rect leaf" rather than "tree[0] has no rect children". The test is asserting the pre-band-wrap tree shape.
3. **Group B (3 tests):** Distinct from Bug C/D; investigate separately.


