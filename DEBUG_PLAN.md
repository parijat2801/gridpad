# Debug plan — gridpad harness recovery

**Worktree:** `.claude/worktrees/unified-document`
**Current status:** vitest 607/2 (both fails are diag tests that pin deferred apply-layer bugs B + C), harness **139/6**.
**Trajectory:** 112/32 (regression baseline, ~6 weeks ago) → 139/6 (today). Target: 144/0.

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

---

## Current open failures (6 tests, harness 139/6)

| # | Test | Class | Hypothesis |
|---|------|-------|------------|
| 1 | reparent › equal-size frames passed through each other do not nest | Test outdated | Output is now clean (no ghost). Test asserts `tree[0].children` has no rect, but `getFrameTree` returns band-wrapped frames so `tree[0]=band-A → [rect-A,…]`. Assertion needs to walk past the band wrapper. |
| 2 | reparent › undo a drag-into-frame reparent restores original tree | Group B (apply layer) | Undo of a demote doesn't fully restore the source band's claim. |
| 3 | drag independence › promote then drag old parent: promoted frame stays put | Group B (apply layer) | After promote, dragging the old parent shifts the promoted frame. Likely shared-claim mapPos issue between adjacent bands. |
| 4 | drag independence › promote then drag the promoted frame: old parent stays put | Group B (apply layer) | Mirror of #3. |
| 5 | eager-band UX regressions › dragging a rect up inside its band clamps at band top edge | Group C | In-band clamp bug; unrelated to reparent. |
| 6 | eager-band UX regressions › Fix 14: drag does not cross non-blank prose line | Test outdated (post-Bug-D) | Test pins legacy "A reorders past Middle" behavior. Bug C refused the promote and Bug D refused the demote-into-B; together A correctly stays in place — but the test's `idxMiddle < idxA` assertion still expects the legacy reorder. Re-derive expectation. |

**Recommended next attack — architectural pass.** #2/#3/#4 plus the two deferred apply-layer pins (`ghostOnDragPastEnd.diag.test.ts`, `ghostOnEqualSizePromote.diag.test.ts`) are all about the apply layer (`applyReparentFrame` + `unifiedDocSync`) mishandling reparent transactions. Bugs A/C/D were guard-style oracle fixes — the oracle now refuses operations the apply layer can't safely perform. Stacking a fourth guard is possible but the underlying asymmetry (promote-into-existing-band branch expands the band, raw-demote branch doesn't; cascade-prune ordering differs per branch) warrants a unified rewrite of the demote/promote application path. Worth raising with the user before continuing.

---

## Workflow

After each commit: run `npx vitest run` and `npx playwright test e2e/harness.spec.ts --workers=8` (8 workers cuts harness time from 156s → 81s).

**Final target:** harness 144/0.

---

## Diagnostic artifacts left in place

- `src/debugBucketA.test.ts`, `src/debugBucketF.test.ts` — model-layer reproducers from Phase 1 investigation.
- `src/ghostOnDragPastEnd.diag.test.ts` — Bug A/B reproducer; one test pins deferred apply-layer bug.
- `src/ghostOnEqualSizePromote.diag.test.ts` — Bug C reproducer; one test pins deferred apply-layer bug.
- `src/ghostOnConvergeDemote.diag.test.ts` — Bug D reproducer (this session).
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
