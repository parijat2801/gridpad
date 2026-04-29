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

## Open investigations (post Fix 1)

These failures were originally classified as A→D cascades, expected to
clear with Fix 1. They didn't — the click/drag separation alone wasn't
enough. Each has a secondary root cause that needs separate
investigation. Not yet promoted to numbered Fixes because root cause is
unknown.

| Inv # | Test | Symptom on current main | Investigation hypothesis |
|-------|------|--------------------------|--------------------------|
| I-A | 62 — move-then-enter: move frame down, then Enter above it | Tree state inconsistent after Enter follows a drag | Enter handler may not see the post-drag frame tree (stale ref?) |
| I-B | 98 — undo: resize then undo, save matches original | Save after undo doesn't match original input | Resize undo may not invert all effects; check inverted-effects coverage |
| I-C | 99 — undo: move-resize-undo-undo, back to original | Two-undo doesn't restore original tree | History stack may be coalescing or losing a step |
| I-D | 109 — Backspace merges line above wireframe, frame shifts up | Frame doesn't shift up the way the test expects | Backspace handler's interaction with band rotation budget |
| I-E | 130 — drag child to different parent: child nests under new parent | Cross-parent reparent on drop doesn't land where expected | Possibly related to Fix 3 (reparent guard) but also possibly a separate cross-parent path bug |

**Recommended approach:** investigate I-D and I-E first — both touch
band rotation / reparent paths that overlap with Fixes 2/3. May share
root causes. I-A, I-B, I-C are undo/sequence-of-actions bugs and likely
have a different shared cause (history-stack handling).

For each: write a unit-level repro that exercises the model directly
(no browser), confirm the failure mode, then promote to a numbered
Fix in the table above.

---

## Verification matrix (after each fix)

| Fix | Vitest re-run | Harness re-run | Expected delta | Actual delta |
|-----|---------------|----------------|----------------|---------------|
| 1 (drag-vs-click in onMouseDown) | 559/0 ✓ (was 546/0; +8 unit + +5 elsewhere) | 112→127 / 32→17 | -22 (Bucket A + D) | **-15** (15 of 22 cleared) |
| 2 (rotation clip) | new rotation-clamp test passes | -2 failures (Bucket B) | ~134 → ~136 | — |
| 3 (reparent guard) | n/a | -2 failures (E131, E132) | ~136 → ~138 | — |
| 4 (handle steal) | n/a | -1 failure (F) | ~138 → ~139 | — |
| 5 (residual escalation) | new rect-clamp test passes | -2 failures (E143, E144) | ~139 → ~141 | — |
| 6 (promote) | TBD | -2 failures (E136, E137) | ~141 → 144 | — |
| 7 (test update) | n/a | -1 failure (C) | ~141 → ~142 | — |

**Final target:** harness 144/0.

### Fix 1 — actual delta vs expected (post-implementation note)

Cleared 15 of 22 estimated (68%). Remaining failures after Fix 1:

| # | Test | Bucket | Why still fails (next fix) |
|---|------|--------|----------------------------|
| 14 | drag: move box down, no ghosts | B | Fix 2 (rotation clip) |
| 29 | text-label: double-click | F | Fix 4 (handle steal) |
| 32 | structure: side-by-side | C | Fix 7 (test update) |
| 62 | move-then-enter | A→D cascade not cleared | Investigate |
| 84 | shared-horizontal drag down ghosts | B-family | Fix 2 |
| 87 | shared-horizontal resize ghosts | possibly B/F-related | Investigate |
| 92 | resize box to overlap | possibly resize-related | Investigate |
| 98 | undo: resize then undo | A→D cascade not cleared | Investigate |
| 99 | undo: move-resize-undo-undo | A→D cascade not cleared | Investigate |
| 101 | prose order preserved (drag wireframe down) | B | Fix 2 |
| 109 | Backspace merges above | A→D cascade not cleared | Investigate |
| 130 | drag child to different parent | A→D cascade not cleared | Investigate |
| 131 | equal-size frames don't nest | E | Fix 3 (reparent guard) |
| 132 | undo reparent | E | Fix 3 |
| 135 | drag A past B | E | Fix 5 / band rotation side effect |
| 137 | promote then drag promoted | E | Fix 6 (promote investigation) |
| 143 | rect up inside band clamps | E | Fix 5 (residual escalation) |

The 15-cleared figure is the direct A bucket + a portion of A→D cascade.
Several A→D cascades (62, 98, 99, 109, 130) still fail — they have
secondary root causes that the click/drag-separation fix alone doesn't
address. Surfacing them is itself useful: each is now a focused next-step.

---

## Diagnostic artifacts left in place

- `src/debugBucketA.test.ts` — 4 vitest cases that demonstrate click + drag math at the model layer.
- `src/debugBucketF.test.ts` — vitest case showing model can complete dblclick → text-edit → save when given effects directly.
- `e2e/debug-bucket-f.spec.ts` — instrumented playwright spec showing the missed mousedown for click 3.
- `e2e/artifacts/drag-down/output.md` — captured evidence of Bucket B clipping.

These can be deleted before merge, or kept as regression-watch tests.

---

## Recommended commit order

1. Fix 7 (test update) — no risk, pure test correction.
2. Fix 1 (drag-vs-click separation) — biggest payoff. Strategy A: delay drilling until mouseup-without-movement.
3. Verify A and D buckets clear; rerun harness.
4. Fix 5 (residual escalation) — small change, clears E143/E144.
5. Fix 4 (handle steal) — small change, clears F.
6. Fix 3 (reparent guard) — small change, clears E131/E132.
7. Fix 2 (rotation clip) — needs investigation first; possibly biggest behavioral change.
8. Investigate Fix 6 — separate session.

After each commit: run `npx vitest run` and `npx playwright test e2e/harness.spec.ts` to verify net delta matches the expected matrix.
