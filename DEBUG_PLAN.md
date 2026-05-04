# Debug plan — gridpad harness recovery

**Worktree:** `.claude/worktrees/unified-document`
**Current status:** vitest 617/2 (both fails are diag tests that pin deferred apply-layer bugs B + C), harness **142/1**.
**Trajectory:** 112/32 (regression baseline, ~6 weeks ago) → 142/1 (today). Target: 143/0.

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
| **Bug E — fold cumulative drag into reparent transaction** | _pending_ | **+1 (139/6 → 140/5); cleared `undo a drag-into-frame reparent restores original tree`. Pre-fix, drag and reparent were two history entries; single undo only reversed the reparent → small box stuck at mid-drag column. Fix: applyReparentFrame accepts extraEffects; onMouseUp dispatches against mouseDownState with cumulative-drag effects prepended.** |

---

## Current open failures (1 test, harness 142/1)

| # | Test | Class | Hypothesis |
|---|------|-------|------------|
| 1 | eager-band UX regressions › dragging a rect up inside its band clamps at band top edge | Group C | In-band clamp bug; unrelated to reparent. The dragged rect's upward motion isn't clamped at the band's top edge — it crosses out, possibly altering the doc. Separate triage; not part of the reparent fix sequence. |

**Triage outcome (2026-05-04, Day 1 of the surgical plan).** Three model-layer reproducers were written to bisect each Group B failure to its mechanism:

- `src/groupB-undoReparent.diag.test.ts` — reproduces #2 (`undo a drag-into-frame reparent`). **Real apply-layer bug confirmed.** Undo restores the doc text correctly and produces 2 top-level frames, but tree[0] still contains a nested rect — i.e., the source band's "extracted small rect" mutation isn't fully reversed. Worth a Bug E fix on Day 2.
- `src/groupB-promoteThenDragOldParent.diag.test.ts` — pins #3 (`promote then drag old parent`). **Not an apply-layer bug.** The test's drop coordinates land past doc end (`outer.y + outer.h + 80px = 227px` on a 184px doc); Bug A's docExtentPy guard correctly refuses the promote as a no-op. The harness assertion `expect(afterPromote.length).toBe(2)` was written at commit `69434ed` (2026-04-28), before Bug A landed (`537ee5e`). The test pins legacy behavior the kept-guards design no longer permits — same shape as Fix 14.
- `src/groupB-promoteThenDragPromotedFrame.diag.test.ts` — pins #4 (mirror of #3). **Not an apply-layer bug.** Test drops at `outer.y + outer.h + 60px = 207px` on a 239px doc (in-bounds for Bug A), but the resulting target row range [10, 13) collides with "Bottom prose" at row 12; Bug C's prose-row guard correctly refuses. Same shape: pre-Bug-C test pinning legacy behavior.

**Revised plan.** Two of the three "Group B apply-layer bugs" are actually outdated tests (same as Fix 14 in row 6). Only #2 (Bug E) needs a production fix. After Bug E ships:

- harness goes from 139/6 to 140/5 (one real bug cleared).
- Three remaining failures (#3, #4, #6) all need test rewrites or deletions, not production fixes. They pin legacy "promote past doc end / promote into prose should succeed somehow" behavior the kept-guards design refuses.
- Final target shifts: it's not 144/0 unless those tests are explicitly retired or rewritten. Realistic post-Bug-E target: 140/5, with a subsequent test-cleanup PR taking the count to 143/2 (deletion of #3, #4, #6) or 144/1 if their assertions can be salvaged. The two remaining failures (#1 + #5) are unrelated to reparent.

**Day 2 (Bug E only).** Use `superpowers:systematic-debugging` to trace `src/groupB-undoReparent.diag.test.ts`'s failure. Likely root cause: `frameInversion` (`editorState.ts:563-586`) snapshots `tr.startState.field(framesField)` for the FORWARD transaction, but the forward reparent dispatches multiple effects (`reparentFrameEffect` + optional `deleteFrameEffect` for cascade-prune). The inverted ChangeSet correctly reverses the doc edit; the snapshot correctly captures pre-transaction frames. Why does undo leave a nested rect? Possibilities:

1. **`recomputeWireframeBounds` runs after `restoreFramesEffect` and rewrites the restored tree.** `editorState.ts:458-462` gates recompute on `!hasMoveOnlyEffects`; `restoreFramesEffect` is not in the move-only list, so recompute fires after the snapshot is restored. If recompute mutates the snapshotted tree (rebasing children), the result diverges from what was snapshotted.
2. **The snapshot's docOffsets don't match the post-undo doc.** Although `restoreFramesEffect` early-returns from `framesField.update` (line 160), bypassing mapPos, the `gridRow sync` pass at lines 432-449 runs unconditionally and reads from `tr.newDoc`. If the snapshot's docOffsets point at lines that no longer exist (or shifted), gridRow sync may produce a different tree.
3. **The forward transaction's effects (`reparentFrameEffect` + `deleteFrameEffect`) leave the source band's removed-from state recorded somewhere that undo doesn't reach.**

Day 2's first action: add `console.log` instrumentation inside the diag test's "step 1 + step 2 (undo)" assertion, dumping `state2`'s frames. Compare to `state0`'s frames. The diff localizes the bug.

**Day 3 (ship Bug E + retire/rewrite outdated tests).**

- Commit 1: Bug E production fix (likely &lt;30 lines).
- Commit 2: Either delete or rewrite the three outdated tests (#3, #4, #6 from "Current open failures"; aka harness lines 3831, 3886, 4256). Use the diag-test pin files as documentation of why each is outdated.
- After both: harness should reach 142/3 or 143/2 depending on whether those three tests are retired.

**Stop conditions:**
- After Day 2: if Bug E fix can't be expressed in &lt;30 lines, escalate. Re-evaluate whether the architectural rewrite at `docs/plans/2026-05-04-reparent-step-rewrite.md` is justified for this single bug (probably not — the cost is still 4-PR migration for one fix).
- If a Bug E fix introduces new failures, revert and re-think.

**Files to consult during this work:**
- `src/groupB-undoReparent.diag.test.ts` — the live reproducer for Bug E.
- `src/groupB-promoteThenDragOldParent.diag.test.ts`, `src/groupB-promoteThenDragPromotedFrame.diag.test.ts` — pins for the two outdated tests (read these to understand what's outdated and why).
- `src/ghostOnConvergeDemote.diag.test.ts` — template for how diag tests are written (drives the same effects DemoV2 emits).
- `src/editorState.ts:563-586` — `frameInversion` (undo/redo snapshot mechanism; likely Bug E lives here).
- `src/editorState.ts:139-200` — `framesField.update` (Phase 1 restoreFramesEffect + Phase 2 mapPos + Phase 3 effects + gridRow sync).
- `src/editorState.ts:1440-1535` — `applyReparentFrame` (today's split-across-branches apply layer).
- `e2e/harness.spec.ts:3689,3831,3886` — the three Group B harness tests (for context on what each was supposed to verify before guards landed).

**Why surgical, not architectural.** A reparent rewrite plan was drafted at `docs/plans/2026-05-04-reparent-step-rewrite.md` and went through multiple reviewer rounds. Each round surfaced new issues; net diff was ~400 lines + a 4-PR migration. The user's call: that's expensive for +3 harness tests on a working 139/6 baseline. The same surgical pattern that took the harness from 112/32 to 139/6 (write a model-layer diag reproducer, bisect to a single line, propose 2-3 fix-surface options before coding, ship one targeted fix) should clear #2 too. The plan doc is kept for reference if Bug E triage reveals genuinely structural rot — but start surgical.

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

## 2026-05-02 → 2026-05-03 sessions — Bug A/B/C/D investigation summary

Each Bug below was found via systematic-debugging: write a model-layer reproducer (`src/*.diag.test.ts`), bisect to a single file:line, decide between fix surfaces, prefer the decision-oracle (`decideReparent`) over apply-layer rewrites. All four added an optional parameter to `decideReparent` so callers can refuse operations whose geometry would corrupt prose or sibling claims.

### Bug A — promote past doc end

`decideReparent(frames, draggedId, dropPx, dropPy)` returned `promote` whenever `hitTestFrames` returned null AND the dragged thing was a child. When the cursor sat past the doc's last line, `applyReparentFrame` clamped the new claim to `docLines - 1` and overwrote whatever prose lived there. Fix: pass `docExtentPy` (= `docLines * ch`); refuse promote when `dropPy < 0 || dropPy > docExtentPy`. See commit 537ee5e.

### Bug B — column drift on promote/demote

`onMouseUp` computed `aRow = round(upPy/ch)` and `aCol = round(upPx/cw)` — placing the *cursor* at the target cell, not the *frame*. For a center-grab drag this shifted the frame by w/2 cols horizontally, which only surfaced as a harness ghost when combined with Bug A's clamp. Fix: extracted `landingGridFromCursor(upPx, upPy, grabOffsetPx, grabOffsetPy, cw, ch, docLines)` that subtracts the grab offset before computing the landing cell. Geometric correctness verified by 10 unit tests; net harness change 0 (Bug B was a sibling, not the lever, for the residual failures). See commit eb74556.

### Bug C — promote into prose-occupied row

A promote whose `[aRow, aRow + gridH)` row range landed on prose silently overwrote that prose. Bug A's guard didn't catch it because the drop was in-bounds, just on an occupied row. Fix: pass `promoteLanding: { aRow, gridH, proseRows }` (caller computes `proseRows` from `state.doc`); refuse promote when any landing row is in `proseRows`. See commit 8fb4593.

### Bug D — demote-into-band where landing rows overlap a sibling

`applyReparentFrame`'s raw-demote branch (line 1524-1535) inserts the dragged rect into the destination band as a sibling without expanding the band or offsetting existing children. When the dragged frame's claim rows overlap a sibling's, both rects share band cells and the serializer renders junctions (`├────┤`) — visible content rows like `│ A │` and `│ B │` disappear from the saved markdown. Fix: pass `demoteLanding: { aRow, gridH }`; refuse demote when the landing range overlaps a sibling AND the dragged frame is at least as large as the colliding sibling (the size check preserves legitimate Figma-style nesting where dragged is strictly smaller). See `src/ghostOnConvergeDemote.diag.test.ts` for the reproducer.

**Pattern across all four bugs.** The decision oracle is the right surface — callers compute landing geometry from cursor + doc + frames, the oracle says yes/no. The apply layer (`applyReparentFrame` + `unifiedDocSync`) has known edge cases that produce silent corruption when the oracle gives the green light on bad geometry; the deferred apply-layer pins in `ghostOnDragPastEnd.diag.test.ts` and `ghostOnEqualSizePromote.diag.test.ts` document those. A unified rewrite of the apply path would also clear those pins and the three remaining Group B failures.
