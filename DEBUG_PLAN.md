# Debug plan — root causes for 32 harness failures on `feature/add-frame-fix`

**Branch:** `feature/add-frame-fix` @ 363d456 (Tasks 9-14 + Gemini fixes + revert)
**Status:** vitest 546/0 ✓, harness 112/32 ✗ (regressed from 119/25)
**Worktree:** `.claude/worktrees/unified-document`

This document is **research-only** — no code changes. It records the root causes
identified by the systematic-debugging investigation in `DEBUG_SCRATCH.md` and
prescribes the fix order, but does not implement them.

**Revision note:** the original plan called for changing `resolveSelectionTarget`
to "click-to-deepest". After verifying Figma's actual behavior in their help
docs, the existing parent-first + drill-on-repeat-click rule is correct (matches
Figma exactly). The bug is elsewhere — in how `onMouseDown` re-runs selection
during a drag-start. See Fix 1 for the corrected diagnosis.

---

## Five distinct root causes for 32 failures

| # | Bug | Tests | Severity | Fix complexity |
|---|-----|-------|----------|----------------|
| 1 | `onMouseDown` re-resolves selection when starting a drag, silently retargeting | ~22 (Bucket A + cascading D) | Critical | Small — one conditional in onMouseDown |
| 2 | Band rotation past doc-end clips wireframe rows | 2-3 (Bucket B) | Data loss | Medium — clamp rotation, or grow doc |
| 3 | Reparent size-guard bypassed by eager-band wrapping | 2-4 (E131, E132) | Production bug | Small — compare leaf-vs-leaf |
| 4 | Resize handle hit boxes (24×24) cover entire small text labels | 1 (F) | UX bug | Small — exclude text-content frames |
| 5 | Vertical residual escalates band rotation when child is at wall | 2 (E143, E144) | UX bug | Small — drop residual when clampedDelta = 0 |
| 6 | Promote step doesn't produce 2 top-level frames | 2 (E136, E137) | Open | Unknown — needs separate investigation |
| 7 | Test assertion uses pre-Phase-B tree shape | 1 (C) | Test-only | Trivial — update assertion |
| I-A..E | Five A→D cascades that didn't clear with Fix 1 (62, 98, 99, 109, 130) | 5 | Mixed | See "Open investigations" section below |

Estimated post-fix harness: **~3 tests still failing** (E136, E137 + maybe one cascade).

---

## Fix order (recommended)

### Fix 1 — onMouseDown silently retargets selection mid-drag (unblocks ~22 tests)

**Bug location:** `src/DemoV2.tsx:514-516` (where `resolveSelectionTarget` is called from `onMouseDown`). Note: `resolveSelectionTarget` itself is NOT broken — its parent-first + drill-on-repeat-click rule matches Figma exactly.

**The actual bug.** A user gesture in this codebase has two distinct events:
- A discrete *click* (mouse-down + mouse-up without movement) — should run the selection rule.
- A *drag start* (mouse-down that becomes the head of a drag gesture) — should USE the existing selection, not re-resolve it.

`onMouseDown` currently runs the selection rule on EVERY mouse-down, including the one that starts a drag. So:

1. User clicks rect inside JUNCTION → `resolveSelectionTarget(rect, null) → wireframe.id` (parent-first, ✓ Figma).
2. User starts dragging. Mouse-down fires `onMouseDown` again.
3. `resolveSelectionTarget(rect, wireframe.id)` drills deeper → returns rect.id (✓ Figma's repeat-click drill — but this is a drag-start, not a repeat-click).
4. `dragRef.frameId = rect.id`. Drag operates on rect.
5. The harness recorded `selId = wireframe.id` before the drag. After: rect moved within wireframe, wireframe bbox unchanged → "didn't move".

The selection rule did exactly what Figma does. The mistake is **applying the rule to a drag-start mouse-down**.

**The fix.** Before `onMouseDown` calls `resolveSelectionTarget`, check whether the mouse-down lands on the current selection or one of its descendants. If yes, this is a drag-start of the existing selection — keep the target as-is. If no, it's a fresh click on something else — run the selection rule.

```js
// In onMouseDown, replace lines 510-516 with:
const currentSelectedId = getSelectedId(stateRef.current);
let targetId: string | null;
if (
  hit &&
  currentSelectedId &&
  (currentSelectedId === hit.id || isAncestorInTree(framesRef.current, currentSelectedId, hit.id))
) {
  // Mouse-down on current selection or its descendant → drag-start. Keep target.
  targetId = currentSelectedId;
} else {
  // Fresh click on something else (or nothing selected) → run selection rule.
  const ctrlHeld = e.ctrlKey || e.metaKey;
  targetId = hit
    ? resolveSelectionTarget(hit, currentSelectedId, framesRef.current, ctrlHeld)
    : null;
}
```

`isAncestorInTree(frames, ancestorId, descendantId)` is a small helper: walk findPath(descendantId), return true if ancestorId appears in the path (excluding the descendant itself if you want strict-ancestor; either works for this check).

**Why drilling still works.** A discrete click (mouse-down → mouse-up without movement) still fires `onMouseDown`. If the click hits the currently-selected frame or a descendant, my new branch keeps `targetId = currentSelected`. That looks like "no drill happened" — but a follow-up dispatch (or just leaving selection unchanged) is fine for the click case too: the user clicked the thing already selected; selection stays. Drilling occurs on the NEXT click, when the previous click released somewhere else, or via Figma's keyboard shortcut Enter. Wait — that's wrong.

Actually let me re-derive. Figma drills on **double-click** (a discrete second click within ~300ms of the first). The current code uses `lastClickRef` to detect dblclicks for text-edit (line 519). The drill-on-repeat-click is implicit: each successive single click runs the rule with the prior selection in chain → drills one level.

So a user wanting to drill from wireframe → rect today would:
1. Click rect: wireframe selected.
2. Click rect again (discrete click, not drag): rule runs with currentSel=wireframe → drills to rect.
3. Click rect once more: rule runs with currentSel=rect → no further drill (last in chain).

With my proposed fix, step 2 would NOT drill because the second click hits the currently-selected wireframe (or descendant thereof). User is stuck.

**Refined fix.** Distinguish drag-start from discrete-click using mouse motion. The existing handler already has this distinction at the drag level (3-pixel threshold at line 578). We need it at the selection level too.

Two strategies:

**Strategy A — defer drill to mouseup-without-movement.** On mouse-down, if the click would hit current selection or descendant, set `dragRef.frameId = currentSelected` and DON'T re-resolve yet. On mouseup, if `dragRef.hasMoved === false` (the click didn't become a drag), THEN run `resolveSelectionTarget` to drill. This makes drilling a discrete-click action and dragging a no-drill action.

**Strategy B — use double-click detection for drilling.** Drill only when `isDblClick && hit is descendant of current selection`. Drag never drills. Single click on the current selection just keeps it selected. Single click on something unrelated runs the regular rule.

**Strategy A** matches Figma's UX more faithfully (a discrete click drills; double-clicks are reserved for text-edit). It's also slightly trickier to implement because the drilling logic moves from `onMouseDown` to `onMouseUp`.

**Strategy B** is simpler but changes UX: users would need to double-click to drill, which may feel off (Figma drills on discrete clicks too, not double-clicks specifically — though discrete clicks ARE detected partly by absence of drag).

**Recommendation: Strategy A.** It preserves "click drills, drag respects selection" exactly like Figma.

Implementation sketch for Strategy A:

```js
// onMouseDown:
const currentSelectedId = getSelectedId(stateRef.current);

// Resize handle check (unchanged) — line 500-509 stays as-is.

if (hit && currentSelectedId &&
    (currentSelectedId === hit.id ||
     isAncestorInTree(framesRef.current, currentSelectedId, hit.id))) {
  // Drag-start of current selection. Don't change selection or run rule yet.
  // If this turns out to be a discrete click (no movement), onMouseUp will drill.
  const found = findFrameById(framesRef.current, currentSelectedId);
  if (found) {
    dragRef.current = {
      frameId: currentSelectedId,
      startX: px, startY: py,
      startFrameX: found.absX, startFrameY: found.absY,
      startFrameW: found.frame.w, startFrameH: found.frame.h,
      hasMoved: false,
      // tag this dragRef as "selection-confirmed" — onMouseUp uses it to
      // decide whether to drill on no-movement release
      selectionConfirmed: false,
    };
    paint();
  }
  return;
}

// Fresh click — run selection rule (existing code unchanged).
const ctrlHeld = e.ctrlKey || e.metaKey;
const targetId = hit
  ? resolveSelectionTarget(hit, currentSelectedId, framesRef.current, ctrlHeld)
  : null;
// ... rest of existing onMouseDown logic ...

// onMouseUp:
if (dragRef.current && !dragRef.current.hasMoved &&
    dragRef.current.selectionConfirmed === false) {
  // Discrete click on the existing selection or descendant — drill now.
  const hit = hitTestFrames(framesRef.current, /* mouse coords */);
  if (hit) {
    const newTarget = resolveSelectionTarget(
      hit,
      dragRef.current.frameId,
      framesRef.current,
      false /* ctrlHeld irrelevant on mouse-up */,
    );
    if (newTarget && newTarget !== dragRef.current.frameId) {
      stateRef.current = stateRef.current.update({
        effects: selectFrameEffect.of(newTarget),
      }).state;
      paint();
    }
  }
}
// ... rest of existing onMouseUp logic ...
```

**TDD test (red first):**
```ts
// In a new e2e spec or unit test that mocks the onMouseDown/Up flow:
it("drag of currently-selected frame keeps selection on selected frame", async () => {
  // Tree: band → wireframe → rect.
  // Pre-select wireframe.
  // mouse.down at rect's center.
  // Expect: dragRef.frameId === wireframe.id (NOT rect.id).
});

it("discrete click on currently-selected frame drills one level", async () => {
  // Pre-select wireframe (from a tree band → wireframe → rect).
  // mouse.down + mouse.up at rect's center, no movement.
  // Expect: getSelectedId() === rect.id (drilled).
});

it("discrete click on a sibling frame replaces selection without drilling", async () => {
  // Pre-select rect A (in a tree of two siblings).
  // Click rect B's center.
  // Expect: rect B's parent-first target gets selected (the rule runs because
  // hit is NOT descendant of A).
});
```

**Verification:** rerun the 14 direct Bucket A tests + 8 cascading D tests. Expect ~22 to flip green.

---

### Fix 2 — Band rotation past doc-end clips frame

**File:** `src/editorState.ts:660-728` (`unifiedDocSync` moveFrameEffect handler — band rotation).

**Symptom:** SIMPLE_BOX dragged 100px down. Output saves the wireframe's TOP edge at L8 (where "Prose below" was), with rows L9-L11 silently dropped. Data loss.

**Hypothesis:** rotation budget IS clamped to maxDown=1, but the FRAME's gridRow is updated by `moveFrame()` using the unclamped delta, then `relocateFrameEffect` (line 726) tries to fix it but the band's eventual lineCount + gridRow combination falls past doc.lines.

**Investigation needed before fix.** Add a unit test that simulates a moveFrameEffect on a band whose drag exceeds maxDown. Inspect the resulting band.gridRow + band.lineCount and the doc state. Find which one diverges from "consistent".

**Fix shape (depends on what investigation reveals):**
- If frame state and doc state diverge: ensure `framesField.update` uses the post-relocate gridRow consistently.
- If the rotation budget computation is correct but lineCount-aware-clamping is missing: clamp gridRow + lineCount ≤ doc.lines at the framesField level.

**TDD test:**
```ts
it("band rotation past EOF clamps to doc boundary, preserves all frame rows", () => {
  // SIMPLE_BOX-like fixture. Drag 6 rows down.
  // Expect: serialize output contains full 4-row wireframe at clamped position.
  // No characters dropped. No "ghost" detected.
});
```

---

### Fix 3 — Reparent size guard with eager bands

**File:** `src/DemoV2.tsx:709-711` (`onMouseUp` reparent decision).

**Bug:** the size guard compares the small dragged rect to the full-width destination band:
```js
const targetIsLarger = !!hitTopLevel && !!draggedFrame
  && hitTopLevel.gridW > draggedFrame.gridW   // band.gridW=120 > rect.gridW=8 → always true
  && hitTopLevel.gridH > draggedFrame.gridH;
```
Pre-eager-bands, `hitTopLevel` was the destination rect. Post-eager-bands, it's the band. Guard always passes; equal-size frames nest unintentionally.

**Fix:** find the destination LEAF at the drop point (not the destination band), compare leaf-to-leaf.
```js
const targetLeaf = hitTestFrames(framesRef.current, upPx, upPy);
// targetLeaf is the smallest frame at the drop point (per hitTestOne smallest-area rule).
const targetIsLarger = !!targetLeaf && !!draggedFrame
  && targetLeaf.gridW > draggedFrame.gridW
  && targetLeaf.gridH > draggedFrame.gridH;
// Use targetLeaf's containing top-level for the reparent destination.
```

**TDD test (e2e):** the existing E131 covers this directly.

---

### Fix 4 — Text-label resize handles steal click

**File:** `src/DemoV2.tsx:500-508` (`onMouseDown` handle-hit branch).

**Bug:** 24×24 handle hit boxes on a 13.4px-tall text label cover the entire label. Click at center hits the "tm" handle → resize-drag starts, dblclick-to-edit never reached.

**Fix (preferred — matches mental model):** text-content frames don't get resize handles. Their size is content-derived; users edit via dblclick + type.

```js
// Skip handle hit for text-content frames — they can't be resized directly.
if (currentSelectedId) {
  const sel = findFrameById(framesRef.current, currentSelectedId);
  if (sel && sel.frame.content?.type !== "text") {
    const handleHit = hitTestHandle(...);
    if (handleHit) { ... }
  }
}
```

**TDD test:** existing F test covers this. Add a unit-level assertion that text-content frames don't expose resize handles in `computeHandleRects` (or simply that dblclick on a text label after a prior selection click enters text-edit mode).

---

### Fix 5 — Residual escalation on zero clampedDelta

**File:** `src/DemoV2.tsx:640-663` (drag handler residual escalation).

**Bug:** when child rect is at the band's edge (clampedDRow=0) but residualDRow != 0, the residual escalates to band rotation. User intent was "move within band, hit edge, stop"; behavior is "rotate the entire band".

**Fix:** only escalate residual when the rect made meaningful clamped motion this gesture.
```js
// Escalate residual only if some clamped motion happened — i.e., the user
// moved the rect THIS frame and now wants to push past. If clampedDRow=0
// from the start, the rect is already at the wall; don't move the band.
if (clampedDRow !== 0 && residualDRow !== 0) {
  effects.push(moveFrameEffect.of({
    id: containingBand.id, dCol: 0, dRow: residualDRow, charWidth: cw, charHeight: ch,
  }));
}
```

Note: this is per-mousemove-tick logic. Even with this guard, a continuous drag where the rect starts mid-band, hits the edge, and the user keeps dragging will see clampedDRow=0 on subsequent ticks (rect is now at the wall). To preserve the "drag the band when pushing past" feel, track gesture-level state: was clampedDRow nonzero at any point in this drag? If yes, allow escalation. Use a flag on `dragRef`.

**TDD test (e2e):** existing E143/E144 cover this. Add a unit-level moveFrame test for the band-rotation-on-residual rule.

---

### Fix 6 — Promote step doesn't produce 2 top-level frames

**Tests:** E136, E137.

**Status:** unknown root cause. Needs separate investigation. Likely involves `applyReparentFrame` with `newParentId === null` (promotion) interacting with the eager-band rewrap to merge the two frames back into one band.

**Investigation steps (next session):**
1. Reproduce E136 in isolation with browser instrumentation.
2. Dump frame tree before promote, after promote, after subsequent drag.
3. Trace `applyReparentFrame` path for `newParentId === null`.

---

### Fix 7 — Update test for new tree shape (Bucket C)

**File:** `e2e/harness.spec.ts:1334-1345`.

**Change:**
```js
// Old:
const rectChildren = tree[0].children.filter((c: any) => c.contentType === "rect");
expect(rectChildren.length).toBe(2);

// New:
const wireframe = tree[0].children.find((c: any) =>
  c.contentType === "container" && !c.isBand);
expect(wireframe).toBeTruthy();
const rectChildren = wireframe.children.filter((c: any) => c.contentType === "rect");
expect(rectChildren.length).toBe(2);
```

Pure test update; no production code change.

---

## Status — post-Fix-3/5/10/2 (branch `harness_fixes`)

| Date | Vitest | Harness | Notes |
|------|--------|---------|-------|
| Pre-Fix-1 | 546/0 | 112/32 | Original regression baseline |
| Post-Fix-1 (cc70f5c on main) | 559/0 | 127/17 | Strategy A drag-vs-click separation |
| Post-Fix-7 (e6e9251) | 559/0 | 128/16 | Test asserted pre-Phase-B tree shape |
| Post-Fix-4 (6ba9c7c) | 559/0 | 129/15 | Text frames excluded from resize handles |
| Post-Fix-8 (f3df3cc) | 559/0 | 131/13 | Tests drill from shrink-wrap before resize |
| Post-Fix-3 (70822a2) | 563/0 | 131/13 | decideReparent helper, leaf-vs-leaf size guard. No harness delta — tests 3594/3631 are actually Fix 14 territory (re-attributed below). |
| Post-Fix-5 (52b0964 + d69e9ae) | 569/0 | 131/13 | shouldEscalateResidual + bandSlackRows + bandSiblings. No harness delta — targeted tests 4140/3770 turned out to be Fix 14 territory too. |
| Post-Fix-10 (07d889d) | 574/0 | **132/12** | Home/End handlers in prose mode. Cleared test 2891. ✓ |
| Post-Fix-2 (926764c) | 579/0 | 132/12 | clampBandMoveDelta past doc end. No targeted-red-test cleared but defensive correctness fix. |
| Post-Fix-9 (4b745bf) | 580/0 | **134/10** | Commit-on-mouseup pattern in DemoV2.tsx. Cleared tests 2705 + 2723. ✓ |
| Post-Fix-14 (01b255b) | 587/0 | **134/11** | computeRotationBudget single source of truth, plus promote-target row clamp to doc bounds. Cleared "prose order UP" + new Fix 14 test. Regressed "prose order DOWN" + "promote old parent" — exposed downstream reparent-on-drop issues that rotation-eats-prose previously masked. Net neutral count, better failure quality. |
| Post-line-height (f747d04) | 587/0 | 134/11 | Cosmetic: bump _charHeight multiplier 1.15× → 1.4× ascent+descent. No behavior change. |
| Post-reparent-revival (3a06b24) | 590/0 | not re-run | (1) Removed Fix 3's leaf-vs-leaf size guard in decideReparent — guard was rejecting every realistic drop because draggedFrame was the full-width band, not the leaf. (2) Skipped recomputeWireframeBounds for move-only effects — bbox no longer follows moved children, so children can leave their parent. (3) Added doLayout(); paint() at end of onMouseUp drag block — fixes "places on next click" lag after commit-on-mouseup. Vitest +3 (one test updated, two passing for new behavior). |
| Post-baseline (38f5e2a) | 590/0 | **132/13** | Re-baseline after reparent revival. Slight count regression (134→132) but the failure SHAPE changed: prior "rotation eats prose" failures are now "drag-then-drop demotes when test expected pass-through" — tests asserting old behavior are now violating new (correct, Figma-like) UX. See "Failure categorization" section below. |

**Branch:** `harness_fixes` (forked from `main` @ cc70f5c).
**Pending:** 12 harness failures across 5 root causes (below).

---

## Post-Fix-1 verification matrix (actuals)

| Fix | Status | Vitest | Harness delta | Actual delta |
|-----|--------|--------|--------------|--------------|
| 1 (drag-vs-click) | DONE on main | 559/0 | 112→127 / 32→17 | **-15** (15 of 22 cleared; 7 cascades remain) |
| 7 (test update side-by-side) | DONE | 559/0 | -1 (test 32) | -1 ✓ |
| 4 (text frames no handles) | DONE | 559/0 | -1 (test 29) | -1 ✓ |
| 8 (drill before resize) | DONE | 559/0 | -2 (tests 87, 92) | -2 ✓ |
| 3 (reparent guard) | DONE (70822a2) | 563/0 | targeted -2 tests not cleared (re-attributed to Fix 14) | 0 ✓ correct on merits, proven via 4 unit tests |
| 5 (residual escalation) | DONE (52b0964 + d69e9ae) | 569/0 | targeted -2 tests not cleared (Fix 14 territory) | 0 ✓ proven via 6 unit tests |
| 10 (Home/End in prose mode) | DONE (07d889d) | 574/0 | -1 (test 2891) | -1 ✓ |
| 2 (rotation clip past EOF) | DONE (926764c) | 579/0 | no test directly red for data loss past doc end | 0 ✓ defensive correctness via 5 unit tests |
| 9 (resize undo doesn't shrink doc) | DONE 2026-05-01 | 580/0 | -2 (2705, 2723) | -2 ✓ Commit-on-mouseup landed: snapshot stateRef at mousedown, dispatch all ticks with addToHistory(false), at mouseup commit one transaction against snapshot with cumulative final effects + addToHistory(true). |
| 14 (no crossing prose lines) | DONE 2026-05-01 | 587/0 | net 0 (cleared "prose order up", regressed "prose order down" + "promote old parent") | — computeRotationBudget pure helper called from BOTH unifiedDocSync's rotation handler AND framesField.update's applyMove (single source of truth, against tr.startState). Treats blank-walk walls as: non-blank prose, doc edges, OR another top-level band's claim. Plus promote-target row clamped to doc bounds. The two new regressions are downstream reparent-on-drop issues (promote past doc end clobbers prose) — pre-Fix-14 they failed for "rotation ate prose" reason; post-Fix-14 they fail for "reparent clobbers prose" reason. Same tests, different layer. New test "Fix 14: drag does not cross non-blank prose line" passes. |
| 11 (cross-parent drag merges bands) | TODO | n/a | -1 (3507) | — Depends on Fix 14 |
| 12 (drag-independence between adjacent bands) | TODO | new unit test | -1 (3827) | — Depends on Fix 14 |
| 13 (sibling-band separation on continued drag) | TODO (NEW) | new unit test | new red harness tests | — Depends on Fix 14 |
| 14 (no crossing prose lines) | TODO (NEW, attempt failed) | new unit test | new red harness tests + 4 existing | — See ATTEMPTED row above |

**Final target:** harness 144/0 (zero failures) + new Fix 13/14 tests green.

---

## Remaining 13 failures — confirmed root causes (post-investigation)

Each entry below is backed by browser-level probe evidence captured on
2026-04-30 via `e2e/probe-investigations.spec.ts` (now deleted). Probe
JSONs were inspected and the diagnoses below are FACTS observed, not
hypotheses.

### Fix 3 — reparent size guard bypassed by eager bands (2 tests)

**Tests:** 3594 (`equal-size frames passed through each other do not nest`),
3631 (`undo a drag-into-frame reparent restores original tree`).

**Diagnosis (already in original plan, still correct):** `DemoV2.tsx:709-711`
compares the dragged rect to the destination band's full-width bbox:
```js
const targetIsLarger = !!hitTopLevel && !!draggedFrame
  && hitTopLevel.gridW > draggedFrame.gridW   // band.gridW=120 > rect.gridW=8 → always true
  && hitTopLevel.gridH > draggedFrame.gridH;
```
Pre-eager-bands `hitTopLevel` was the destination rect; post-eager-bands
it's the band. Guard always passes; equal-size frames nest unintentionally.

**Fix:** find the destination LEAF at the drop point via
`hitTestFrames(framesRef.current, upPx, upPy)` (smallest-area rule),
compare leaf-to-leaf. Use the leaf's containing top-level for the
reparent destination.

**Risk:** low. Both tests are existing red regressions.

---

### Fix 5 — vertical residual escalates band rotation when child at wall (2 tests)

**Tests:** 3749 (`drag frame A past frame B: B does not move`),
4140 (`dragging a rect up inside its band clamps at band top edge`).

**Diagnosis (already in original plan, still correct):** `DemoV2.tsx:640-663`
escalates vertical residual to band rotation even when `clampedDRow === 0`.
At a band edge: rect can't move, residual = full drag delta, escalates
fully → band rotates → adjacent band's docOffset shifts via mapPos.

**Fix:** only escalate residual when *some meaningful clamped motion* has
happened in the gesture. Track gesture-level state on `dragRef`: was
clampedDRow nonzero at any point? If no, drop the residual silently
(rect at wall → motion stops there).

**Risk:** medium. Need to verify the gesture-level flag doesn't break
"drag past edge to keep moving" UX in the cases where it currently
works.

---

### Fix 2 — band rotation past doc-end clips wireframe rows (3-4 tests)

**Tests:** 959 (`drag: move box down, no ghosts`),
2216 (`drag shared-horizontal box down, no ghosts`),
2759 (`prose order preserved when dragging wireframe down`),
likely 1889 (`move-then-enter`) as cascade.

**Probe evidence (INV1):** Drag SIMPLE_BOX 100px down. Doc length
unchanged (29 chars before/after). Frame's `gridRow` moved from 2 to **7**.
Doc has 8 lines (indices 0-7). Band claims `gridRow=7, lineCount=4` →
rows 7, 8, 9, 10 — but only row 7 exists. Serializer writes wireframe
top edge at L7; rows 8-10 silently dropped (`└` and the two `│` rows
disappear).

**Confirmed mechanism:** `unifiedDocSync` band-rotation handler
(`editorState.ts:660-728`) emits a balanced delete+insert pair that
ROTATES newlines around the band's claim. The handler does NOT clamp
the band's NEW gridRow against `doc.lines - lineCount`. So when the
user drags a 4-line band on an 8-line doc downward, the band can land
at gridRow=7 even though the last valid claim start is gridRow=4
(8 - 4).

**The plan's original "rotation budget = blank lines" framing was
incomplete.** The rotation budget is correctly computed as the number
of blank lines around the claim. The budget is correctly clamped per
tick — but the `moveFrameEffect` reducer (`framesField.update` at
line 169-176) calls `moveFrame` which adds `dRow` to `gridRow`
unconditionally. Even if `unifiedDocSync` clamps the doc-change
correctly, the framesField may still update `gridRow` past the doc's
last valid row.

**Fix shape:** in `framesField.update`'s moveFrameEffect handler,
clamp `newGridRow` so that `newGridRow + lineCount ≤ doc.lines` when
the moved frame has `lineCount > 0` (a band that claims doc rows). OR,
in `unifiedDocSync`, reject (skip) any moveFrameEffect whose dRow
would push the band's claim past the doc end.

**TDD path:** write a unit test that drives `applyMove` directly with
SIMPLE_BOX-shaped frames + an 8-line doc; assert that
`framesField` post-move has `gridRow + lineCount ≤ 8`.

**Risk:** medium. Touches the rotation handler (load-bearing for many
passing tests). Needs careful TDD.

---

### Fix 9 — resize undo doesn't shrink doc back (2 tests) [NEW]

**Tests:** 2705 (`undo: resize then undo, save matches original`),
2723 (`undo: move-resize-undo-undo, back to original`).

**Probe evidence (INV2):** Load SIMPLE_BOX (8 lines, 29 chars). Resize
the wireframe by +30px height. Doc grows to 10 lines, 31 chars (correct
— resize handler inserts 2 blank lines via `unifiedDocSync` line 744).
Press Cmd+Z. Frame state correctly inverts (wireframe renders at
original size). **But doc is still 10 lines.** Save output:
```
Prose above
                 ← blank
┌──────────────┐
│              │
│              │
└──────────────┘
                 ← blank
                 ← blank (extra)
                 ← blank (extra)
Prose below
```
Two extra blank lines persist between wireframe and "Prose below".

**Confirmed mechanism:** `unifiedDocSync` is a `transactionFilter` that
appends doc-changes to the user-dispatched transaction (line 749:
`allChanges.push({ from: keepLast.to, to: endLine.to });` for shrink,
line 744 for grow). When the transaction is filtered, the appended
changes ARE part of the merged transaction's changeset, so CodeMirror
history stores them. On undo, the inverted changeset SHOULD delete the
extra lines.

**Confirmed root cause (verified 2026-05-01 via grep):**
`DemoV2.tsx:709` dispatches the resize drag with
`Transaction.addToHistory.of(isFirstDragStep)`. Only the very first
tick of the gesture (`isFirstDragStep === true`) goes into CM
history; tick 2..N pass `false`.

So the undo stack contains: ONE transaction whose changeset takes
the doc from "original (8 lines)" to "after first tick (8 lines + 1
blank)". Subsequent ticks grow the doc to 10 lines, but those
changes are NOT in history. Cmd+Z inverts the first-tick transaction
only → reverts 1 blank line, leaving 1 stray blank. The framesField
restoreFramesEffect path is fine — it's the doc side that's missing
9 ticks of history.

The plan's speculation about `restoreFramesEffect` overriding the
doc was incorrect. There is no doc-override; there's just nothing
in history to undo.

**Right fix — commit-on-mouseup pattern:**
1. At `onMouseDown` (resize handle hit), capture
   `mouseDownState = stateRef.current` and `mouseDownFrames =
   framesRef.current` snapshots.
2. During `onMouseMove` ticks, dispatch with
   `addToHistory.of(false)` for ALL ticks (not just non-first).
   These are visual-only updates; nothing goes into history.
3. At `onMouseUp`, if `dragRef.hasMoved`:
   - Compute the cumulative resize delta from the snapshot to
     current state.
   - Dispatch ONE transaction containing
     `[resizeFrameEffect.of({...final dims...}), moveFrameEffect.of(
     {...final position...})]` against `mouseDownState` as the
     starting state. This produces a single doc changeset spanning
     the full resize.
   - Annotate this single transaction with
     `addToHistory.of(true)`. Cmd+Z now inverts the entire resize
     atomically.
4. Same pattern applies to move drag (`DemoV2.tsx:707-710`) — same
   bug structure, currently masked by the simpler shape of move
   doc-changes (rotation is balanced; resize is not).

**Subtleties to verify:**
- The commit-on-mouseup transaction will NOT see the intermediate
  doc state. `unifiedDocSync` runs against `tr.startState =
  mouseDownState`, computes the doc-change for the FINAL gridH, and
  emits the right number of insert/delete chars. Check that the
  ranges work — specifically that `frame.docOffset` in
  `mouseDownState` is still the original, not the mid-drag offset.
- Tests at `editorState.test.ts:2556` already use
  `addToHistory.of(i === 0)` patterns — confirm those don't break.
- The first-tick visual update needs to actually render. Currently
  the first tick goes into history AND renders; under the new
  pattern, the first tick just renders. Verify
  `syncRefsFromState()` after every visual-only dispatch.

**TDD path:**
1. Vitest test (drives state directly, no canvas): apply 5
   resizeFrameEffect dispatches with `addToHistory.of(false)` for
   all, then ONE final dispatch with `addToHistory.of(true)`.
   Call `editorUndo`. Assert `getDoc(state).split("\n").length ===
   originalLineCount` AND `frames[0].gridH === originalH`.
2. Repeat for move-drag with `moveFrameEffect`.
3. Then update DemoV2.tsx to match.

**Risk:** medium. The commit-on-mouseup pattern is well-defined but
intrusive — touches resize and move drag in DemoV2.tsx. Verify in
isolation (vitest first) before changing the canvas handlers.

---

### Fix 10 — Backspace at start of line-2 doesn't merge into blank line above (1 test) [NEW]

**Test:** 2891 (`Backspace merges line above wireframe, frame shifts up`).

**Probe evidence (INV3):** Fixture: `Line one\n\nLine two\n\n┌────┐\n...`.
Click "Line two", press Home, press Backspace. Expected: line 2 ("Line two")
merges with the blank line above; doc loses one line; wireframe's
docOffset shifts up by 1 row → frame.y decreases.

**Actual:** `yBefore = yAfter = 53.47` — frame didn't move. Saved doc:
```
Line one
                 ← blank (preserved)
ine two          ← lost the "L" instead of merging
                 ← blank
┌────┐
...
```

**Confirmed mechanism:** Home + Backspace did NOT merge with line above.
Instead, Backspace deleted a character within "Line two" — meaning the
prose cursor was NOT actually at column 0 when Backspace fired. Either:
(a) `Home` keypress didn't move the prose cursor (handler ignores Home),
or (b) the cursor was at column 0 but the prose-Backspace handler
treats column-0 backspace as a no-op (and the harness's keystroke
deleted the "L" from a different cursor position).

**Likely culprit:** `proseDeleteBefore` in `editorState.ts` may not
implement the standard "merge with line above" behavior at column 0.
CM's stock backspace at the start of a line deletes the preceding
newline (merging lines). If gridpad's prose handler intercepts and
does its own backspace, it may skip this case.

**Fix shape:** at column 0, prose-Backspace should delete the preceding
newline (merging with the previous line), which is what CM does
natively. If `proseDeleteBefore` is the wrong abstraction, just let CM
handle Backspace via `keymap.of(defaultKeymap)`.

**Open question:** the symptom suggests the cursor was NOT at column 0.
Need to instrument `getCursor()` after Home keypress to confirm.

**Risk:** low if it's a column-0 Backspace special case. Medium if it
means refactoring how prose keys are handled.

---

### Fix 11 — cross-parent drag merges target bands (1 test) [NEW]

**Test:** 3507 (`drag child to a different parent: child nests under new parent`).

**Probe evidence (INV4):** Two separate top-level wireframes (Outer A
with Inner inside, Outer B empty). Started with `treeBefore.length === 2`.
Drag Inner from A toward B's top-left.

**Actual:** `treeAfter.length === 1`. Output doc shows the two formerly-
separate wireframes merged into ONE wireframe with a `├──┤` junction
between them:
```
┌────────────────────────┐
│  Outer A               │
│                        │
│                        │
│                        │
├────────────────────────┤
│  Outer B               │
│                        │
├──────────────────┐     │
│  Inner           │     │
└──────────────────┴─────┘
```

**Confirmed mechanism:** During the drag, the residual-escalation rule
emits `moveFrameEffect`s on Outer A's band (since Inner is at the band
edge and residual escalates). When Outer A's band rotates close enough
to Outer B's band that their gridRow ranges overlap or become adjacent,
**`mergeOverlappingBands` fires** (`framesField.update` at line 181 in
moveFrameEffect handler). Bands are merged into one. Once merged,
Inner reparents under the merged band. Save serializes a single
multi-cell wireframe.

**The merge is irreversible** — `mergeOverlappingBands` consumes both
bands and returns a single new one. There is no inverse operation.

**Fix shape (REVISED 2026-05-01 after solution review):**

The plan's options A and B both treat the merge as the bug. The
merge is not the bug — it's the consequence of allowing the
dragging band to rotate INTO another band's claim rows. If Fix 14
(no crossing prose lines + no crossing other-band claims) lands
correctly, the dragging band physically can't enter another band's
rows. `mergeOverlappingBands` then never fires in the drag path
because the precondition (overlap) never occurs.

**The right ordering:** Fix 14 is the prerequisite. Land it, run the
harness, see if test 3507 still fails. If it does, only THEN reach
for an explicit fix here.

**If Fix 14 doesn't auto-resolve test 3507 (verify, don't assume):**
the fix is to make `computeRotationBudget` (Fix 14's helper) treat
"row claimed by ANY top-level band whose id !== rotating band's id"
as a wall. That's already part of Fix 14's spec. So if Fix 14 is
implemented correctly, Fix 11 must be resolved.

**Why option B (move merge to mouseup) is risky:** the row-partition
invariant ("bands never share rows") is enforced by
`mergeOverlappingBands` so downstream consumers — serializer, hit-
tester, mapPos behavior — can assume non-overlapping bands. If two
bands transiently overlap during drag, hit-test results during the
drag may be wrong (which band owns row 5?), causing follow-up
effects to go to the wrong frame. This is exactly the kind of
inconsistency that produced the Fix 14 first-attempt regression.

**Action for this fix:** none directly. Implement Fix 14, then
recheck test 3507 specifically. Update this section after that
verification.

**Risk:** zero if Fix 14 is correct (no code change here). High if
we attempt to move the merge — defer.

---

### Fix 12 — drag-independence between two adjacent top-level bands (1 test) [NEW]

**Test:** 3827 (`promote then drag the promoted frame: old parent stays put`).

**Probe evidence (INV5):** Promote Inner from Outer to top-level.
Result: `topLevelCount === 2` ✓ (Plan's Fix 6 hypothesis "promote
doesn't produce 2" is WRONG — promote works fine). Then drag the
*promoted* frame down by 18px.

**Actual:**
- `outerYDelta = 40.106` — outer moved DOWN 40px (one full claim row).
- `promotedYDelta ≈ 0` — promoted didn't move.

**Confirmed mechanism:** When the user clicks the promoted frame and
drags down, `onMouseDown`'s parent-first selection lands on the band
wrapping the promoted frame. The drag then dispatches `moveFrameEffect`
on the band, which triggers band rotation. The band rotation inserts a
newline above the band's claim and deletes one below. Both edits are
in the doc — and the OUTER band's docOffset is mapped through
`tr.changes.mapPos` (line 152-156 in framesField update), which sees
the upstream insert and shifts Outer's docOffset forward → Outer's
visible row shifts DOWN by 1 row (40px).

**Why "promoted didn't move":** the band rotation's net char-change is
zero (insert one + delete one), so on the macroscopic level the
promoted frame's claim stays at the same gridRow. But the OUTER band,
which lives at a docOffset BEFORE the promoted band's claim, sees only
the insert (the delete is past its position) — net +1 char shift →
docOffset += 1 → frame moves down.

**This is the same root cause hypothesis DEBUG_SCRATCH.md flagged
for E135** (`drag frame A past frame B: B does not move`). It also
likely affects test 3749 (Fix 5) at the boundary case.

**Diagnosis review (REVISED 2026-05-01):** the probe's stated cause —
"the OUTER band, which lives at a docOffset BEFORE the promoted
band's claim, sees only the insert" — is INCONSISTENT with the actual
rotation handler at `editorState.ts:706-715`.

The rotation emits TWO change specs in this order:
```
{ from: endLine.to, to: endLine.to + N }          // delete N chars after band
{ from: startLine.from, insert: movedChars }      // insert N chars before band
```

For a band whose `docOffset` is BEFORE `startLine.from` (i.e., ABOVE
the rotating band): both edits are DOWNSTREAM of its docOffset.
`mapPos(offset, +1)` returns the offset unchanged. So Outer (above)
should NOT shift.

For a band whose `docOffset` is AFTER `endLine.to + N` (i.e., BELOW
the rotating band): both edits are UPSTREAM. The delete removes N
chars at endLine.to (upstream → offset shifts by -N). The insert
adds N chars at startLine.from (upstream → offset shifts by +N).
Net zero, as the comment at line 707-709 promises.

For a band whose `docOffset` is AT `startLine.from` exactly (BAND
ITSELF): the insert at `startLine.from` with assoc=+1 pushes its
offset forward by N. That's the rotating band's own offset, which
is then overwritten by `relocateFrameEffect` at line 733. ✓

**So the probe's reported symptom — Outer above shifts down 40px —
should not happen via rotation alone.** Either:
1. The probe interpretation is wrong about which band is "above."
2. The shift comes from `mergeOverlappingBands` (Fix 11 territory),
   not mapPos.
3. The probe captured a state where Outer isn't actually above —
   e.g., promote initially placed the new band at the SAME row as
   Outer, triggering a merge.
4. There's a code path that reorders or merges the change specs
   before mapPos sees them.

**Required investigation BEFORE picking a fix:**
1. Re-instrument the probe (or write a vitest equivalent of it).
   Capture `tr.changes.toJSON()` AND `tr.startState.field(
   framesField)` for the failing tick.
2. Capture `mapPos(outer.docOffset, +1)` directly. If it's nonzero,
   the rotation handler's specs are different from what's documented
   above. If it's zero, the shift comes from elsewhere
   (`mergeOverlappingBands`, the ordering of `extraEffects`, or
   `applyMove` itself).
3. Only after this is verified, pick a fix.

**Possible fixes once root cause is confirmed:**
- If mapPos shifts unexpectedly: change `mapPos(offset, +1)` to
  `mapPos(offset, -1)` for offsets ABOVE the rotating band's
  startLine; this is non-trivial because `framesField.update` runs
  AFTER `unifiedDocSync` but doesn't know which effects are
  rotations.
- If shift comes from merge: defer to Fix 11.
- If shift comes from `extraEffects` ordering: reorder so
  `relocateFrameEffect` runs before mapPos remaps other frames.

**Risk:** high. Don't pick a fix yet — investigate first. The
plan's three options (mapPos assoc=-1, relocate-adjacent-bands,
line-index-identity) are all premature.

---

### Fix 13 — sibling wireframes in same band move together (NEW, user-reported)

**Tests:** to be added (red harness tests, expected to fail until fix).

**Spec (from user):** "A wireframe knows how many bands it needs, so if a
user continues to pull on a wireframe, their bands can separate."

**User-observable failure:** two wireframes `W1` and `W2` live on the
same band `B` (e.g., side-by-side, sharing a row range). User clicks
`W1` and drags it down. Currently, once `W1` reaches `B`'s vertical
edge, the residual escalates to a `moveFrameEffect` on `B` itself
(`DemoV2.tsx:688-690`). Band `B` rotates → `W2` visually moves down
with `W1`. Sibling-independence is broken inside the same band.

**Expected behavior:** `W1` separates from `B` into its own band at
the new position; `W2` and any other siblings stay put on the
original `B` (which shrinks/splits accordingly). The wireframe owns
its `lineCount`; the band is just a grouping abstraction that
contains whatever children currently claim those rows.

**Trigger threshold:** immediate — as soon as `W1`'s desired
`gridRow` exits `B`'s claim by 1 row, it separates. No deliberate
deadband (matches Figma).

**Interaction with Rule 14 (no crossing prose):** if Rule 14 clamps
`W1` at a prose line before it can separate, Rule 14 wins — `W1`
stops at the prose wall and never separates.

**Fix shape (REVISED 2026-05-01 after solution review):**

The original proposal — a new `splitBandEffect` — duplicates work that
`reparentFrameEffect` with `newParentId === null` already does. Look
at `editorState.ts:256-283`: promote-to-top-level wraps the
extracted child in a fresh full-width band at the target absolute
row, prunes the now-empty source band if needed, and inserts blank
claim lines via `unifiedDocSync`'s `reparentFrameEffect` doc-change
branch. That IS "split band on drag past edge."

**Why the current code never triggers it during drag:** the drag
handler (`DemoV2.tsx:680-705`) only emits `moveFrameEffect`s.
`reparentFrameEffect` is gated by `decideReparent` on `mouseup`
(`DemoV2.tsx:746-770`), which checks for hit-target, not for "rect
escaped its band." So a multi-sibling band always sees the residual
escalate to band rotation (Fix 5 explicitly excludes multi-sibling
bands from residual-drop, see `shouldEscalateResidual` at
`editorState.ts:1734`: `if (bandSiblings > 1) return false`).

**Right approach:**
1. In the drag handler, when `clampedDRow === 0 && residualDRow !==
   0 && bandSiblings > 1`, REPLACE the band-level `moveFrameEffect`
   with `applyReparentFrame(state, draggedId, null, aRow, aCol, cw,
   ch)` where `aRow = found.absY/ch + residualDRow`.
2. The existing promote-path handles claim-row insertion and source-
   band cleanup. No new effect.
3. Critical ordering: Fix 14 must land first. Without Fix 14, the
   newly-promoted band lands wherever the cursor is, which can be
   inside another band's claim or past the doc end. Fix 14's
   rotation-budget clamp gives the bound for `aRow`.

**Mid-drag-promote risk to verify:** after the promote, the new band
exists alongside the old band on the next mousemove tick. The drag
handler holds `dragRef.frameId = draggedId`. The next tick's
`findContainingBandDeep(draggedId)` returns the NEW band. Check
that this is true — if `dragRef`'s captured `startFrameY` etc. are
still in old-band coordinates, the next tick's clamp math could
jump. May need to re-sync `dragRef` after the promote.

**TDD path:**
1. Red harness test: TWO_RECTS_ONE_BAND fixture; drag `W1` down past
   `W2`; assert post-save tree has two distinct top-level bands; `W2`
   stays at original row.
2. Red harness test (upward): same fixture, drag `W1` up past `B`'s
   top; assert `W1` lands above `B`, `W2` unmoved.
3. Vitest unit test for the drag-handler decision: given band-edge +
   residual + bandSiblings > 1, returns "promote" instead of "rotate
   band."

**Risk:** medium. No new effect — reuses promote path. Main risk is
`dragRef` coherence post-promote (see "Mid-drag-promote risk" above).
Order: Fix 14 first, then Fix 13.

---

### Fix 14 — wireframe drag must not cross a prose line (NEW, user-reported)

**Tests:** to be added (red harness tests, expected to fail until fix).

**Spec (from user):** "No wireframe can be taken across a prose
boundary."

**User-observable failure:** wireframe `W` lives in band `B1`. Below
`B1` is a non-blank prose line (e.g., "Some heading"), then band `B2`.
User drags `W` down past the prose line. Currently, `W` either: (a)
rotates `B1` past the prose, eating prose chars (Fix 2 territory);
(b) merges `B1` and `B2` via `mergeOverlappingBands` (Fix 11). Both
are wrong — the prose line is a wall.

**Expected behavior:** `W`'s vertical motion is bounded by the
nearest non-blank, non-wireframe line above and below its current
claim. The drag clamps at the wall (Figma-style — cursor moves
past, frame doesn't follow). Reparent-into-target on mouseup is
NOT subject to this rule (renesting works exactly as if both
wireframes were in the same band — tree topology is independent
of vertical motion).

**Fix shape (REVISED 2026-05-01 after solution review):**

The original proposal — adding a `proseBoundsFor` helper and clamping
`gridRow` inside `onMouseMove` — is the WRONG LAYER. That's why the
last attempt regressed: it clamped frame state in `applyMove` while
`unifiedDocSync` ran a separate clamp via its blank-line walk
(`editorState.ts:689-703`). Two clamp authorities on different
`tr.startState` snapshots disagreed; `mergeOverlappingBands` then ran
on inconsistent state.

**The clamp already half-exists.** `unifiedDocSync` walks blank lines
above (`maxUp`) and below (`maxDown`) the rotating band's claim and
breaks at the first non-blank line. That break IS the prose-wall
clamp for adjacent prose. What's missing: it does NOT stop at lines
owned by ANOTHER band's claim — those are also walls.

**Right approach (single source of truth):**
1. Extract a pure helper `computeRotationBudget(frames, doc, frameId)
   → { maxUp, maxDown }`. Walks doc lines around the frame's claim,
   stops at the first row that is EITHER non-blank OR claimed by a
   different top-level band (`findBandAtRow` on the candidate row).
2. Use this helper in `unifiedDocSync` to replace the existing
   inline `maxUp`/`maxDown` walks (lines 689-703 of editorState.ts).
3. Mirror the same clamp in `framesField.update`'s `applyMove` so
   `frame.gridRow` and the doc rotation can never disagree. Either
   call the helper twice (frame and doc sides), or have
   `unifiedDocSync` emit an annotation carrying `effectiveDRow` and
   `applyMove` reads it from the transaction.
4. Reparent path (`onMouseUp`) is unchanged — it doesn't go through
   `moveFrameEffect`, so the clamp doesn't apply to drop-on-target.

**Why this avoids last attempt's regression:** there is one walk, one
budget, one number. `mergeOverlappingBands` only runs on `applyMove`'s
result, which now matches the doc-side rotation's clamp by
construction. No transient overlap, no merge.

**TDD path:**
1. Vitest unit test for `computeRotationBudget`: covers (a) blank-
   line walls, (b) non-blank prose walls, (c) other-band-claim
   walls, (d) doc start/end as walls.
2. Red harness test: wireframe + prose line + wireframe fixture;
   drag upper wireframe down 100px; assert it clamps at the prose
   line, doesn't merge with lower wireframe.
3. Red harness test (upward): drag lower wireframe up; assert
   clamp at prose above.
4. Green test: reparent-across-prose still works — drop wireframe
   onto a target across a prose line; assert nesting succeeds.

**Risk:** medium. The change replaces inline blank-line walks with
a helper call, which is mostly mechanical IF the helper matches the
existing semantics for the all-blank case. The new "stop at other-
band claim" rule is additive. No new effects, no new fields. Order:
Fix 2 first (already done), then Fix 14, then Fix 13.

---

## Failure categorization (after 2026-05-02 baseline, 132/13)

The 13 failing tests cluster into three groups:

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
