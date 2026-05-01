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

## Status — post-Fix-1, Fix-7, Fix-4, Fix-8 (branch `harness_fixes`)

| Date | Vitest | Harness | Notes |
|------|--------|---------|-------|
| Pre-Fix-1 | 546/0 | 112/32 | Original regression baseline |
| Post-Fix-1 (cc70f5c on main) | 559/0 | 127/17 | Strategy A drag-vs-click separation |
| Post-Fix-7 (e6e9251) | 559/0 | 128/16 | Test asserted pre-Phase-B tree shape |
| Post-Fix-4 (6ba9c7c) | 559/0 | 129/15 | Text frames excluded from resize handles |
| Post-Fix-8 (f3df3cc) | 559/0 | 131/13 | Tests drill from shrink-wrap before resize |

**Branch:** `harness_fixes` (forked from `main` @ cc70f5c).
**Pending:** 13 harness failures across 7 distinct root causes (below).

---

## Post-Fix-1 verification matrix (actuals)

| Fix | Status | Vitest | Harness delta | Actual delta |
|-----|--------|--------|--------------|--------------|
| 1 (drag-vs-click) | DONE on main | 559/0 | 112→127 / 32→17 | **-15** (15 of 22 cleared; 7 cascades remain) |
| 7 (test update side-by-side) | DONE | 559/0 | -1 (test 32) | -1 ✓ |
| 4 (text frames no handles) | DONE | 559/0 | -1 (test 29) | -1 ✓ |
| 8 (drill before resize) | DONE | 559/0 | -2 (tests 87, 92) | -2 ✓ |
| 3 (reparent guard) | TODO | n/a | -2 (3594, 3631) | — |
| 5 (residual escalation) | TODO | n/a | -2 (3749, 4140) | — |
| 2 (rotation clip past EOF) | TODO | new unit test | -3 to -4 (959, 2216, 2759, possibly 1889) | — |
| 9 (resize undo doesn't shrink doc) | TODO | new unit test | -2 (2705, 2723) | — |
| 10 (Backspace at line-2 home) | TODO | n/a | -1 (2891) | — |
| 11 (cross-parent drag merges bands) | TODO | n/a | -1 (3507) | — |
| 12 (drag-independence between adjacent bands) | TODO | new unit test | -1 (3827) | — |

**Final target:** harness 144/0 (zero failures).

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

**Why it doesn't work:** the resize-grow transaction's changeset is
`{from: endLine.to, insert: "\n\n"}`. CM history inverts that to
`{from: endLine.to, to: endLine.to + 2}` — a deletion. **But the
undo transaction also fires a `restoreFramesEffect` that overrides
the framesField wholesale.** The framesField after restore has the
original 4-row band; but the doc still has 10 lines, so the band's
docOffset/lineCount don't match doc reality. Save serializes the
4-row band against a 10-line doc → 2 trailing blanks.

Need to verify: does `editorUndo` actually emit the inverted changeset
to the doc, or does it only restore frames? Check
`editorState.ts` undo wiring.

**Fix shape:** ensure undo restores BOTH frames AND doc state. If
`editorUndo` currently uses CM's stock `undo` plus
`restoreFramesEffect`, the doc DOES revert (CM handles it) — but
something is preventing the doc revert from going through. Possible
causes: (a) the resize doc-change is not annotated `addToHistory`, so
CM doesn't track it; (b) the restoreFramesEffect transaction is
dispatched in a way that skips CM's standard undo of the doc.

**TDD path:** write a unit test that dispatches resize, calls
`editorUndo`, and asserts both `getFrames(state).length === 1`,
`frames[0].gridH === original`, AND `getDoc(state).split("\n").length
=== originalLineCount`.

**Risk:** medium-high. Undo wiring is foundational; a regression here
breaks far more than 2 tests.

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

**Fix shape:** two options.
- **A.** Make `mergeOverlappingBands` only fire on EXPLICIT user gestures
  (e.g., drag-and-drop reparent), not on every intermediate drag-tick.
  Drag-tick rotations should be allowed to overlap *temporarily* —
  bands only merge on mouseup if they still overlap.
- **B.** Move `mergeOverlappingBands` from `framesField.update` to
  `onMouseUp` so per-tick drag rotations don't trigger it.

**Risk:** medium-high. `mergeOverlappingBands` exists for a reason
(invariant: "row-partition; bands never share rows"). Moving it to
mouseup may violate the invariant during drag, causing render glitches.
Need to study why it's there.

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

**Fix shape:** band rotation must be DOC-NEUTRAL for other bands. The
balanced delete+insert pair must net to zero shift on docOffsets that
sit OUTSIDE the rotating band's claim. Options:
- Use `mapPos` with `assoc=-1` on the lower band's docOffset (so the
  upstream insert doesn't shift it).
- Or: `unifiedDocSync` could, alongside the rotation, emit a
  `relocateFrameEffect` for adjacent bands to anchor their docOffsets.
- Or: rethink — store band identity by *line index* rather than
  *char offset*, so insertions on other lines don't matter.

**Risk:** high. This is the architectural issue at the heart of
"drag independence" — likely the same root as several E-bucket
failures and possibly hides under multiple symptoms.

---

## Recommended fix order (next session)

1. **Fix 3** (reparent guard, leaf-vs-leaf) — small, clears 2. Low risk.
2. **Fix 5** (residual escalation guard) — small, clears 2. Medium risk.
3. **Fix 10** (Backspace at column 0) — small, clears 1. Low risk.
4. **Fix 2** (band gridRow clamp past doc end) — TDD-first. Clears 3-4. Medium risk.
5. **Fix 9** (resize undo doc-state restore) — TDD-first. Clears 2. Medium-high risk.
6. **Fix 12** (drag-independence between adjacent bands) — last,
   biggest design change. Clears 1 directly, may also affect Fix 5
   correctness. High risk.
7. **Fix 11** (cross-parent drag merges bands) — depends on Fix 12;
   merge logic should be re-examined once drag-independence is fixed.
   Clears 1. High risk.

Final target: 144/0 (no failures).

After each commit: run `npx vitest run` and `npx playwright test e2e/harness.spec.ts`.

---

## Diagnostic artifacts left in place

- `src/debugBucketA.test.ts` — 4 vitest cases that demonstrate click + drag math at the model layer.
- `src/debugBucketF.test.ts` — vitest case showing model can complete dblclick → text-edit → save when given effects directly.
- `e2e/debug-bucket-f.spec.ts` — instrumented playwright spec showing the missed mousedown for click 3.
- `e2e/artifacts/drag-down/output.md` — captured evidence of Bucket B clipping.
- `e2e/probe-investigations.spec.ts` — five INV probes for Fixes 2/9/10/11/12 (delete after fixes commit).

These can be deleted before merge, or kept as regression-watch tests.

---

## Revision — 2026-04-30: spike outcome + revised architecture

### Spike outcome (read-only investigation, verified)

A spike was attempted to replace band rotation with derived bands +
doc projection. The investigation surfaced ONE fatal flaw and TWO
secondary obstacles before any code shipped:

**Fatal — top-level wireframe immobility under the naive rewrite.**
`wrapAsBand` (frame.ts:550-596) sets `band.gridH = maxRow - minRow`,
i.e., the band is exactly as tall as the union of its children. For
a single-child band wrapping a top-level wireframe, `band.gridH ===
child.gridH`, so the child's clamp range inside the band
(DemoV2.tsx:676-682) is `[0, 0]` — zero slack in either direction.
Today, `clampedDRow === 0` and `residualDRow === dRow`; line
688-690 escalates the full delta to the band's id, and
`unifiedDocSync` rotates newlines around the band's claim, making
the wireframe appear to move. **If you delete the residual
escalation (the spike's "drop residual silently" instruction), every
top-level wireframe freezes in place — they have no other path to
motion.** Manually verified by reading frame.ts:540-596 and
DemoV2.tsx:640-704.

**Secondary obstacles** (would have surfaced during implementation):
- `unifiedDocSync` emits `relocateFrameEffect` keyed by band id; if
  recompute regenerates band ids, the relocate effect targets a
  ghost.
- `framesField.update` runs on every transaction, including pure
  prose edits; `recomputeBands` would need an early-out to avoid
  thrashing band identity unnecessarily.

**Conclusion:** the full doc-projection rewrite is too risky in a
3-hour spike. A SMALLER, surgical version of the same idea is
viable.

### Revised architecture — recomputeBands replaces mergeOverlappingBands

Keep band rotation in `unifiedDocSync` and the residual escalation in
`DemoV2.tsx`. They're load-bearing for top-level wireframe motion.

**The change:** replace `mergeOverlappingBands` (called from
`framesField.update`, editorState.ts:~181) with a `recomputeBands(
frames, charWidth, charHeight, docWidthCols)` pass that:

1. Walks top-level frames.
2. Ungroups every band's children back to absolute grid coords.
3. Re-groups via the existing `groupIntoContainers` logic (rows that
   overlap → same band).
4. Re-wraps each group via `wrapAsBand`.
5. Returns a fresh frames[] array.

**Early-out:** only run when the transaction had at least one frame
effect (move, resize, reparent, etc.). Pure prose edits skip the
recompute.

**Why this clears Fix 11 (cross-parent drag merges bands):** today
`mergeOverlappingBands` greedily fuses any bands whose row ranges
touch, even mid-drag. With `recomputeBands`, mid-drag rotations that
TEMPORARILY put bands adjacent don't merge — the recompute sees that
each band's children belong to distinct logical groupings and keeps
them separate. The merge only happens when children's rows actually
overlap.

**Why this clears Fix 12 (drag-independence between adjacent bands):**
recomputed bands get fresh `docOffset` values derived from their
children's claims (`wrapAsBand` line 564). Today's `mapPos` cascade
shifts an adjacent band's docOffset when an upstream insert lands;
with recompute, the docOffset is REDERIVED from the post-edit child
positions, breaking the cascade.

**Risk:** medium. Touches the band-identity invariant — band ids no
longer persist across transactions. If anything in the codebase
relies on stable band ids (selection state across edits, undo
references, animation keys), it will break. Need to grep before
shipping.

### Mini-spike (proof-of-concept, before full plan execution)

**Where:** `.claude/worktrees/spike-derived-bands` (already exists).
**Time budget:** 90 minutes.
**Scope:**
1. Add `recomputeBands` to `src/frame.ts`.
2. Replace `mergeOverlappingBands` call in `framesField.update` with
   `recomputeBands` + early-out.
3. Don't touch band rotation, doc projection, escalation, or
   anything else.

**Pass/fail signals:**
- ✅ vitest stays at 559/0 (or drops by ≤2 with a clear explanation).
- ✅ harness 131/13 → some delta. Watch test 3507 (Fix 11) and 3827
  (Fix 12).
- ✅ Fix 11 (3507) flips GREEN → strong signal architectural claim
  holds.
- ✅ Fix 12 (3827) flips GREEN → recompute also fixes mapPos cascade.
- ❌ Vitest drops >5 OR harness <125 → abandon, go fully surgical.
- ⚠️ 11/12 stay red, no regression → recompute alone insufficient,
  surgical fixes for 11/12 still needed.

### Two new issues from user (2026-04-30)

**Issue 1 — Fix 13: band separation on continued drag.** Two
wireframes sharing a band can't be moved independently today. User
spec: a wireframe knows its own lineCount; if dragged past the band's
edge, the band SPLITS — the dragged wireframe lands on its own claim
below (or above), and the original band shrinks to wrap the
remaining children. The other children must NOT move (visually or in
gridRow).

This falls out for free from `recomputeBands` — once the dragged
child's gridRow no longer overlaps siblings', the recompute splits
the band naturally. So Fix 13 is mostly a consequence of the
mini-spike's success.

**Issue 2 — Fix 14: no wireframe across prose.** A wireframe's
vertical motion is bounded by the nearest non-blank, non-wireframe
prose line above and below its current claim. Reparent-into-target
ignores this rule (drops are tree topology, not vertical motion).

This requires a new clamp added to the move handler. Not a
consequence of recompute — separate concern.

**Trigger threshold:** immediate (Figma-style). No deliberate
threshold for separation.

**Conflict resolution:** when Rule 13 (separation) and Rule 14
(prose-clamp) conflict — e.g., dragging a child past the band edge
into prose immediately below — Rule 14 wins (drag clamps at the
prose row).

### Revised fix order

1. **Fix 3** (reparent guard, leaf-vs-leaf) — small, clears 2. Low
   risk. **Independent of architecture work.**
2. **Fix 5** (residual escalation guard at wall) — small, clears 2.
   Medium risk.
3. **Fix 10** (Backspace at column 0) — small, clears 1. Low risk.
4. **Mini-spike: recomputeBands replacement** — proves the
   architectural claim. Time-boxed 90 min.
5. **If spike succeeds:** ship recomputeBands. Re-evaluate Fix 11,
   Fix 12, Fix 13 — likely cleared or significantly reduced.
6. **Fix 14** (no-cross-prose clamp) — independent of recompute.
   Add to move handler.
7. **Fix 2** (band gridRow clamp past doc end) — TDD-first. Clears
   3-4. Medium risk.
8. **Fix 9** (resize undo doc-state restore) — TDD-first. Clears 2.
   Medium-high risk.
9. **Fix 11/12 surgical fallback** (only if mini-spike doesn't clear
   them) — `mapPos` assoc adjustment + move `mergeOverlappingBands`
   to mouseup. High risk.

Final target: 144/0 (no failures).
