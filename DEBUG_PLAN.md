# Debug plan — gridpad harness recovery

**Worktree:** `.claude/worktrees/unified-document`
**Current status:** vitest 617/2 (both fails are diag tests that pin deferred apply-layer bugs B + C), harness **143/1**.
**Trajectory:** 112/32 (regression baseline, ~6 weeks ago) → 143/1 (today). Target: 144/0.

This is the **live working doc**. The "Shipped fixes" table summarizes what's already landed; "Current open failures" lists what's still failing; the bottom section keeps the latest investigation narrative for handoff.

---

## Shipped fixes

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
| **Bug A — decideReparent doc-bound guard** | 537ee5e | **+2 (132/13 → 134/11)** |
| **Bug B — landingGridFromCursor (grab-offset)** | eb74556 | **0 net (correctness fix; 1 test rewritten)** |
| **Bug C — decideReparent prose-row guard** | 8fb4593 | **+5 (134/11 → 138/7); reclassified one Group A test as a Bug D demote-side sibling** |
| **Bug D — decideReparent demote-overlap guard** | 02e8bf7 | **+1 (138/7 → 139/6); cleared `shared walls › move two separate boxes toward each other`** |
| **Bug E — dispatch reparent against mouseDownState** | bcf678f | **+1 (139/6 → 140/5); cleared `undo a drag-into-frame reparent restores original tree`. Pre-fix, drag and reparent were two history entries; single undo only reversed the reparent → small box stuck at mid-drag column. Fix: dispatch the reparent transaction against mouseDownState (NOT post-tick state). The reparent itself positions the dragged frame at (aRow, aCol), so cumulative-drag effects are not folded in. frameInversion captures mouseDownState's frames as the undo snapshot. (Earlier attempt prepended cumulative-drag effects via an extraEffects param; that broke drag-onto-existing-frame because moveFrameEffect's handler runs mergeOverlappingBands before reparentFrameEffect. Fixed in 7c235be by removing the extraEffects path entirely.)** |
| Test cleanup — retire/rewrite outdated harness tests | aaa78d9 | **+2 (140/5 → 142/3, then continued to 142/1 after dependency clears); 4 tests pre-dated Bug A/C/D guards or eager-bands tree shape. Two deleted (test-outdated post-Bug-A/C; same drag-independence invariant covered by simpler tests); two assertions rewritten to check round-trip / original-ordering instead of pre-revival reorder behavior.** |
| **Bug F — drop-on-sibling-wireframe reparent** | 7c235be | **+1 (142/1 → 143/1); user-reported: drew a rect in the same band as an existing wireframe, dragged onto the wireframe → no nest. decideReparent's same-top-ancestor guard refused all same-band reparents. Fix: walk up from hit leaf to find smallest enclosing container (wireframe or band) that's not the dragged or its ancestor; demote into that. applyReparentFrame's demote handler also fixed to compute parent-relative coords correctly when newParent is a nested wireframe (sums gridRow along the parent path, mirroring applyAddChildFrame).** |

---

## Current open failures (1 test, harness 143/1) — handoff for next agent

| # | Test | File:line | Class |
|---|------|-----------|-------|
| 1 | `eager-band interactive UX regressions › dragging a rect up inside its band clamps at band top edge` | `e2e/harness.spec.ts:4207` | Group C — in-band clamp, unrelated to reparent |

**What the test does:** loads a fixture with a wireframe that has rotation budget below it (blank rows), clicks the rect to select, drags it UP inside its band (band-relative motion only), then asserts:
1. `expect(aAfter!.y).toBeGreaterThanOrEqual(before[0].y - 1)` — the rect should NOT have moved more than 1px above its starting position. Today it moves further up than expected.
2. `expect(docAfter).toBe(docBefore)` — the doc text should be unchanged for in-band motion (no claim-line changes). Today the doc may be modified.

**What the next agent should do** (use `superpowers:systematic-debugging`):

1. **Reproduce at the model layer.** Write `src/groupC-bandTopClamp.diag.test.ts` mirroring the pattern of `src/ghostOnConvergeDemote.diag.test.ts`. The reproducer should:
   - Load the test fixture (read `e2e/harness.spec.ts:4207`+ for exact text and steps).
   - Replay the per-tick `moveFrameEffect` ticks via `simulateDragSelected` (template in `ghostOnConvergeDemote.diag.test.ts:96+`).
   - Assert the rect's post-drag absolute `gridRow` is ≥ pre-drag gridRow (didn't move above the band's top edge), and that the saved markdown matches the input (no doc edits).

2. **Bisect to a single file:line.** Likely culprits to verify (don't anchor — verify):
   - `clampBandMoveDelta` (`src/editorState.ts`, search for the function) — clamps a band's gridRow within doc bounds. Maybe doesn't clamp at the band's top edge for in-band rect motion.
   - `framesField.update`'s `moveFrameEffect` handler (`editorState.ts:170+`) — applies moveFrame after computing `clampBandMoveDelta` and `computeRotationBudget`. The rotation budget is for CLAIMING frames (top-level bands); rect-in-band motion uses different math. Find the path for "rect inside band, dRow up".
   - `shouldEscalateResidual` (`editorState.ts:1794+`) — decides when a clamped in-band move escalates to a band-level rotate. If escalation happens when it shouldn't, the rect's residual upward motion rotates the band's claim above doc start.
   - `DemoV2.tsx` per-tick onMouseMove (around line 651-715) — computes `clampedDRow` against band bounds; check if `minDRow = -bandRow` correctly clamps at band top.

3. **Propose 2-3 fix-surface options before coding.** Same discipline as Bugs A-F.

4. **Ship one targeted fix.** Goal: harness 143/1 → 144/0. After ship, also confirm the saved-doc round-trip is unaltered (assertion 2).

**Files the next agent will touch (most likely):**
- `src/editorState.ts` — `framesField.update` effect handlers, possibly `clampBandMoveDelta` or `shouldEscalateResidual`.
- `src/DemoV2.tsx:651-715` — per-tick onMouseMove math (less likely; existing logic is well-tested by Bugs A-F).
- New `src/groupC-bandTopClamp.diag.test.ts` — model-layer reproducer.
- Existing `e2e/harness.spec.ts:4207` — should turn green after fix; no rewrite needed (the assertion is correct, just the implementation is wrong).

**Stop conditions:**
- If the fix can't be expressed in <30 lines, escalate. Reparent saw an architectural-rewrite plan deferred at `docs/plans/2026-05-04-reparent-step-rewrite.md`; the same kind of caution applies here.
- If a fix introduces new failures, revert and re-think.

After this clears: harness 144/0, vitest 617/2 (the 2 fails are still the deferred apply-layer pins from Bug B/C — those are intentional pins, not bugs to fix in this round; documented as known compromises).

**Why surgical, not architectural.** A reparent rewrite plan was drafted at `docs/plans/2026-05-04-reparent-step-rewrite.md` and went through multiple reviewer rounds. Each round surfaced new issues; net diff was ~400 lines + a 4-PR migration. The decision: that's expensive when the surgical pattern (write a model-layer diag reproducer, bisect to a single line, propose 2-3 fix-surface options before coding, ship one targeted fix) has cleared Bugs A-F cleanly. The plan doc is kept for reference if a future bug reveals genuinely structural rot — but start surgical.

---

## Workflow

After each commit: run `npx vitest run` and `npx playwright test e2e/harness.spec.ts --workers=8` (8 workers cuts harness time from 156s → 81s).

**Final target:** harness 144/0.

---

## Diagnostic artifacts left in place

- `src/debugBucketA.test.ts`, `src/debugBucketF.test.ts` — model-layer reproducers from Phase 1 investigation.
- `src/ghostOnDragPastEnd.diag.test.ts` — Bug A/B reproducer; one test pins deferred apply-layer bug.
- `src/ghostOnEqualSizePromote.diag.test.ts` — Bug C reproducer; one test pins deferred apply-layer bug.
- `src/ghostOnConvergeDemote.diag.test.ts` — Bug D reproducer.
- `src/groupB-undoReparent.diag.test.ts` — Bug E reproducer (real apply-layer bug; undo doesn't fully restore source band).
- `src/groupB-promoteThenDragOldParent.diag.test.ts` — pin for "test outdated post-Bug-A" finding (drop past doc end).
- `src/groupB-promoteThenDragPromotedFrame.diag.test.ts` — pin for "test outdated post-Bug-C" finding (drop on prose row).
- `src/landingGridFromCursor.test.ts`, `src/dragGeometry.diag.test.ts` — Bug B helper unit tests.
- `e2e/debug-bucket-f.spec.ts`, `e2e/probe-investigations.spec.ts` — playwright probes from earlier phases.
- `e2e/artifacts/drag-down/output.md`, `e2e/artifacts/large-drag/` — captured ghost evidence.

These can be deleted before merge, or kept as regression-watch tests.

---

## Group D — transient double-band after promote (visual UX, no harness coverage)

**Reported by user 2026-05-02. Not in harness.**

After horizontally dragging a child wireframe OUT of its parent dashboard (promote → new top-level band), TWO BANDS visibly coexist for some time. The new band's selection bbox and the old band's selection bbox overlap vertically by 1-2 rows. Subsequent drags behave weirdly until the user moves either wireframe enough to actually overlap the other band's claim — `mergeOverlappingBands` collapses them and motion normalizes.

**Root-cause hypothesis:** new promote band's claim is row-adjacent to the old parent band's, so `mergeOverlappingBands` sees no row-overlap → both survive. Visual selection bbox includes padding/handles → looks overlapping but isn't.

**Possible fixes:** eagerly merge adjacent bands after promote; OR shift promote-drop into empty space; OR relax `mergeOverlappingBands` to merge adjacent (risky — could fold intentionally distinct bands).

**Severity:** UX papercut, not data corruption. Lower priority than apply-layer rewrite.

---

## Bug A/B/C/D/E/F investigation summary

Each Bug below was found via systematic-debugging: write a model-layer reproducer (`src/*.diag.test.ts`), bisect to a single file:line, decide between fix surfaces, prefer the decision-oracle (`decideReparent`) over apply-layer rewrites. Bugs A-D added optional parameters to `decideReparent` so callers can refuse operations whose geometry would corrupt prose or sibling claims. Bug E fixed the drag/reparent atomicity at the dispatch layer. Bug F relaxed the same-band-sibling guard and made the demote handler walk the parent path for nested-wireframe targets.

### Bug A — promote past doc end

`decideReparent(frames, draggedId, dropPx, dropPy)` returned `promote` whenever `hitTestFrames` returned null AND the dragged thing was a child. When the cursor sat past the doc's last line, `applyReparentFrame` clamped the new claim to `docLines - 1` and overwrote whatever prose lived there. Fix: pass `docExtentPy` (= `docLines * ch`); refuse promote when `dropPy < 0 || dropPy > docExtentPy`. See commit 537ee5e.

### Bug B — column drift on promote/demote

`onMouseUp` computed `aRow = round(upPy/ch)` and `aCol = round(upPx/cw)` — placing the *cursor* at the target cell, not the *frame*. For a center-grab drag this shifted the frame by w/2 cols horizontally, which only surfaced as a harness ghost when combined with Bug A's clamp. Fix: extracted `landingGridFromCursor(upPx, upPy, grabOffsetPx, grabOffsetPy, cw, ch, docLines)` that subtracts the grab offset before computing the landing cell. Geometric correctness verified by 10 unit tests; net harness change 0 (Bug B was a sibling, not the lever, for the residual failures). See commit eb74556.

### Bug C — promote into prose-occupied row

A promote whose `[aRow, aRow + gridH)` row range landed on prose silently overwrote that prose. Bug A's guard didn't catch it because the drop was in-bounds, just on an occupied row. Fix: pass `promoteLanding: { aRow, gridH, proseRows }` (caller computes `proseRows` from `state.doc`); refuse promote when any landing row is in `proseRows`. See commit 8fb4593.

### Bug D — demote-into-band where landing rows overlap a sibling

`applyReparentFrame`'s raw-demote branch (line 1524-1535) inserts the dragged rect into the destination band as a sibling without expanding the band or offsetting existing children. When the dragged frame's claim rows overlap a sibling's, both rects share band cells and the serializer renders junctions (`├────┤`) — visible content rows like `│ A │` and `│ B │` disappear from the saved markdown. Fix: pass `demoteLanding: { aRow, gridH }`; refuse demote when the landing range overlaps a sibling AND the dragged frame is at least as large as the colliding sibling (the size check preserves legitimate Figma-style nesting where dragged is strictly smaller). See `src/ghostOnConvergeDemote.diag.test.ts` for the reproducer. See commit 02e8bf7.

### Bug E — drag-and-reparent produced two history entries

A drag-and-reparent gesture fired two transactions: the cumulative-drag commit (Fix 9) and the reparent. A single Cmd+Z only reversed the second — the cumulative drag stayed applied, leaving the dragged frame at its mid-drag column inside its (now-restored) source band. Saved markdown after undo had the rect at the wrong column. Fix: dispatch the reparent transaction against `mouseDownState` (the pre-drag snapshot). The reparent itself positions the dragged frame at `(aRow, aCol)` from the cursor at mouseup — so the cumulative-drag delta is redundant for final position. `frameInversion` snapshots `mouseDownState`'s frames, so undo restores the entire pre-drag state. (An earlier attempt prepended cumulative-drag effects via an `extraEffects` parameter; that broke drag-onto-existing-frame because `moveFrameEffect`'s handler runs `mergeOverlappingBands` before `reparentFrameEffect` in the same transaction. Fixed by dropping the extraEffects path entirely in commit 7c235be.) See `src/groupB-undoReparent.diag.test.ts` for the reproducer. Commits: bcf678f (initial), 7c235be (cleanup).

### Bug F — drop-on-sibling-wireframe did not reparent

`decideReparent` had a guard `if (hitTopLevel.id === draggedTopAncestor.id) return { kind: "none" };` that refused ALL same-band reparents. When two rects shared a top-level band (siblings — e.g., a freshly-drawn rect next to an existing wireframe), dropping one onto the other returned no-op. Fix (two parts): (1) `decideReparent` walks UP from the hit leaf to find the smallest enclosing container (wireframe with `content === null && !isBand`, OR a top-level band) that's not the dragged itself, not an ancestor of the dragged, and not the dragged's immediate parent. Returns that container's id. (2) `applyReparentFrame`'s demote handler now walks the parent path to compute absolute coords (mirroring `applyAddChildFrame`'s logic at line 1392-1395) — required because the new target may be a nested wireframe whose `gridRow` is parent-relative, not absolute. See `e2e/harness.spec.ts:3741` for the harness test. See commit 7c235be.

**Pattern across all six bugs.** The decision oracle is the right surface for geometry guards (Bugs A-D, F): callers compute landing geometry from cursor + doc + frames, the oracle says yes/no. Atomicity is the right surface for history concerns (Bug E): one logical user-gesture = one CodeMirror transaction = one history entry. The apply layer (`applyReparentFrame` + `unifiedDocSync`) has known edge cases that produce silent corruption when the oracle gives the green light on bad geometry; the deferred apply-layer pins in `ghostOnDragPastEnd.diag.test.ts` and `ghostOnEqualSizePromote.diag.test.ts` document those. A unified rewrite of the apply path would also clear those pins; the architectural-rewrite plan at `docs/plans/2026-05-04-reparent-step-rewrite.md` is kept for that future work but is not on the current path.
