# Debug plan — gridpad harness recovery

**Worktree:** `.claude/worktrees/unified-document`
**Current status:** harness **143/0 — TARGET HELD**. vitest 627/4 (4 = pre-existing baseline pins: 2 deferred apply-layer pins from Bug B/C + 2 dead Group C diag pins; consider deleting `src/groupC-bandTopClamp.diag.test.ts`).
**Trajectory:** 112/32 (regression baseline, ~6 weeks ago) → 143/1 → 143/0 (2026-05-06, Group C harness test deleted as obsolete; Group D shipped same day in `fbc7362`) → **143/0 with Bug G shipped** (PR #10, `feature/bug-g-rect-as-container`).

This is the **live working doc.** Open work lives at the top; closed bugs are one-line history below.

---

## Open work

### Wrapper asymmetry — deferred

Scanner's `groupIntoContainers` (`frame.ts:439`) wraps multi-rect bands at file load; runtime `applyAddTopLevelFrame` (`editorState.ts:1303`) doesn't. **Decision (2026-05-06):** wrapping should be a human-initiated gesture (multi-select + group), not implicit at runtime. Future work: build the multi-select UX; revisit scanner auto-grouping then. Surfaced via `▢ Wrappers` debug toggle.

### Rect-in-rect serialization — deferred

Bug G enables nesting a rect frame inside another rect's interior in-memory. `serializeUnified` doesn't render the inner rect's content when its parent is also a rect — re-scan flattens nested rects to siblings on save. Acceptable for now (Bug G's scope was mutation, not persistence). The convergence harness `wall-converge` was tweaked to avoid triggering nesting mid-test; revisit if/when in-memory rect-in-rect persistence becomes a goal.

### Deferred apply-layer pins (Bug B/C)

Two pinned assertions in `ghostOnDragPastEnd.diag.test.ts` and `ghostOnEqualSizePromote.diag.test.ts` document edge cases where the decision oracle is correct but the apply layer corrupts state. Cleared by the architectural reparent rewrite at `docs/plans/2026-05-04-reparent-step-rewrite.md` if/when it ships.

---

## Workflow

After each commit: `npx vitest run` and `npx playwright test e2e/harness.spec.ts --workers=8` (8 workers ≈ 81s).

---

## Closed work — one-line summaries

### Bug G — drop-on-rect demotes into rect (Figma-style nesting) (RESOLVED 2026-05-06, PR #10, commits `495f45d` + `970e716`)

Initial spec was "extend `isContainer` to accept labeled rect leaves + clamp child to interior." Two non-obvious gaps surfaced during implementation:

- **Descendant guard.** With rect-as-container, the leaf→root walk could pick the dragged frame's own labeled rect children as targets (the existing `frameContains(f, draggedId)` only filtered ancestors). Nesting a frame into its descendant corrupted the tree — root cause of the "every drag pins frames to top-left" regression.
- **Strip dragged from hit-test.** The dragged frame follows the cursor during a drag (cumulative-drag updates its bbox), so a mouseup with the cursor still over the dragged's current visible position made `hitTestFrames` return the dragged itself → walk skipped it → no candidate → `none`. Symptom: "can't reparent into top-level frames or into shrink-wrapped children" because the cursor naturally ends up over the dragged's own bbox. Fix: build a copy of frames with the dragged subtree stripped, run `hitTestFrames` against that. The unstripped frames are still re-tested in the no-hit branch to preserve "drop on yourself with no movement → none."
- **Interior-only test for rect targets.** Drops on/near a rect's border fall through to the next outer container; only ≥1-cell-into-the-interior counts as a nest. Bands and empty wireframes are unaffected (no load-bearing borders).
- **Inset clamp.** When the demote parent is a rect, clamp the child's parent-relative coords to leave ≥1 cell from each border. Pure clamp (`min(max(landing, 1), maxRow)`) — does not teleport when the cursor's landing is already in the interior.

Repros: `src/reparentSweep.diag.test.ts` (USER_FLOW, SIDE_BY_SIDE, SMALL_INTO_BIG, edge-flush-drop). Updated assertions in `reparentDecision.test.ts` and `groupB-undoReparent.diag.test.ts` to reflect new "demote into rect" semantics. `wall-converge` harness gesture reduced so A and B don't accidentally nest mid-test.

### Group D — transient double-band after promote (RESOLVED 2026-05-06, commit `fbc7362`)

Promote that lands flush against (or overlapping) the source band left two top-level bands. `mergeOverlappingBands` was only called after `moveFrameEffect` (line 206), and its strict-overlap test missed touching pairs. Fix 14 (`editorState.test.ts:2915`) needs touching bands to remain distinct after drag-clamp, so loosening the global rule was a no-go. **Fix:** added optional `mergeTouching=false` parameter; called with `true` at end of `reparentFrameEffect` handler. Drag-clamp keeps strict-overlap; reparent collapses touching+overlapping. Repro `src/groupD-adjacentPromoteBand.diag.test.ts`.

### Group C — in-band upward clamp (RESOLVED 2026-05-06 via test deletion)

Harness test was written against an obsolete selection mental model (assumed click-1 selects leaf; current behavior is click-1 selects the wrapper) and used a fixture with zero in-band slack. Geometry described was unreachable. Test deleted; manual verification in app confirmed selection drilling works. Three fix-surface options for the underlying `shouldEscalateResidual` rule are documented in commit `b614d23` if a real reproducer ever surfaces.

### Bugs A–F — same-band reparent recovery

All cleared via the surgical pattern: model-layer diag reproducer → bisect to one file:line → guard at the decision oracle (`decideReparent`) or the dispatch layer (`applyReparentFrame`), preferring the oracle.

| Bug | Root cause | Fix surface | Commit |
|-----|------------|-------------|--------|
| A | promote past doc end overwrote prose | `decideReparent` `docExtentPy` guard | `537ee5e` |
| B | `aRow/aCol` placed cursor at target cell, not frame | `landingGridFromCursor(grabOffset)` helper | `eb74556` |
| C | promote into prose-occupied row overwrote prose | `decideReparent` `promoteLanding.proseRows` guard | `8fb4593` |
| D | demote-overlapping-sibling produced junction glyphs | `decideReparent` `demoteLanding` size-guard | `02e8bf7` |
| E | drag+reparent created two history entries | dispatch reparent against `mouseDownState` | `bcf678f`, `7c235be` |
| F | `decideReparent` refused all same-band reparents | walk hit→root for smallest enclosing container; demote handler walks parent path | `7c235be` |

**Pattern:** decision oracle for geometry guards (A–D, F, G); transaction atomicity for history (E). Apply-layer rewrite (`docs/plans/2026-05-04-reparent-step-rewrite.md`) deferred — surgical pattern has cleared everything to date.

### Earlier shipped fixes

| Fix | Commit | Effect |
|-----|--------|--------|
| 1 — drag-vs-click separation in onMouseDown | `957a90b` | -15 (112→127) |
| 2 — clampBandMoveDelta past doc end | `926764c` | 0 (defensive) |
| 3 — decideReparent leaf-vs-leaf size guard | `70822a2` | 0 (proven via 4 unit tests) |
| 4 — text frames excluded from resize handles | `6ba9c7c` | -1 |
| 5 — shouldEscalateResidual + bandSlackRows | `52b0964`, `d69e9ae` | 0 (proven via 6 unit tests) |
| 7 — test asserted pre-Phase-B tree shape | `e6e9251` | -1 |
| 8 — tests drill from shrink-wrap before resize | `f3df3cc` | -2 |
| 9 — commit-on-mouseup for resize/move drags | `4b745bf` | -2 |
| 10 — Home/End handlers in prose mode | `07d889d` | -1 |
| 14 — computeRotationBudget single source of truth | `01b255b` | net 0 (better failure quality) |
| line-height bump (1.15× → 1.4×) | `f747d04` | cosmetic |
| reparent revival | `3a06b24` | shape-shift; rebaseline 132/13 |
| Test cleanup (retire/rewrite outdated harness tests) | `aaa78d9` | +2 (140/5 → 142/3) |

---

## Diagnostic artifacts left in place

- `src/debugBucketA.test.ts`, `src/debugBucketF.test.ts` — Phase 1 reproducers.
- `src/ghostOnDragPastEnd.diag.test.ts`, `src/ghostOnEqualSizePromote.diag.test.ts` — Bug A/B + C reproducers; 1 test each pins deferred apply-layer bug.
- `src/ghostOnConvergeDemote.diag.test.ts` — Bug D reproducer.
- `src/groupB-undoReparent.diag.test.ts` — Bug E reproducer.
- `src/groupB-promoteThenDragOldParent.diag.test.ts`, `src/groupB-promoteThenDragPromotedFrame.diag.test.ts` — pinned outdated-test findings.
- `src/groupC-bandTopClamp.diag.test.ts` — 2 dead pins (Group C resolved by test deletion); safe to remove.
- `src/groupD-adjacentPromoteBand.diag.test.ts` — Group D reproducer (passing).
- `src/reparentSweep.diag.test.ts` — Bug G reproducer (USER_FLOW, SIDE_BY_SIDE, SMALL_INTO_BIG, edge-flush-clamp).
- `src/landingGridFromCursor.test.ts`, `src/dragGeometry.diag.test.ts` — Bug B helper unit tests.
- `e2e/debug-bucket-f.spec.ts`, `e2e/probe-investigations.spec.ts` — playwright probes from earlier phases.
- `e2e/artifacts/drag-down/output.md`, `e2e/artifacts/large-drag/` — captured ghost evidence.

Keep as regression-watch tests, or delete before merge.
