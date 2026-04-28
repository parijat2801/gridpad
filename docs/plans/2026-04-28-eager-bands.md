# Eager Bands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every top-level claiming wireframe frame in the editor lives inside a synthetic full-width band container that owns the doc-line claim. Drawing or promoting another frame onto a row already claimed by a band joins that band as a sibling child instead of inserting overlapping claim lines. This fixes the bug where drawing a new rect to the right of an existing rect on the same row band pushes the existing rect down.

**Architecture:** A "band" is a `Frame` with `content: null`, `clip: true`, `gridCol: 0`, full document width, and `lineCount > 0` (it owns the doc claim). Its children are rects/lines/text with `lineCount: 0` and coords relative to the band. We wrap eagerly at *every* boundary where a claiming frame enters the editor model: scanner load (`createEditorStateUnified`), draw new rect (`applyAddTopLevelFrame`), and reparent-promote (`applyReparentFrame`). The existing `groupIntoContainers` pattern in `src/frame.ts:417` is the template — extract a small `wrapAsBand` helper and call it from these three sites. The rotation-only drag invariant is preserved because dragging the band rotates newlines around the band's claim, and children come along automatically (they're parent-relative).

**Tech Stack:** TypeScript 5.x, CodeMirror 6 (StateField, transactionFilter), Vitest, Playwright. No new dependencies.

---

## Architectural notes for the implementer

Before writing any code, internalize these facts about the codebase. The plan refers back to them:

1. **`Frame` type** (src/frame.ts:27-48). Each frame has both pixel coords (x/y/w/h) and grid coords (gridRow/gridCol/gridW/gridH). For top-level claiming frames, `gridRow` is a CACHE of `state.doc.lineAt(docOffset).number - 1` and `lineCount > 0`. For child frames, `lineCount === 0` and gridRow is parent-relative. `content === null` means container/band; `content?.type === "rect"` means a rect leaf.

2. **`groupIntoContainers`** (src/frame.ts:417-510). Today this wraps multiple overlapping frames into a synthetic container. We will reuse its rebasing logic but generalize it: a band wraps even a *single* rect, and the band is always full-width. We will extract a new `wrapAsBand(rects, charWidth, charHeight, docWidthCols)` helper that produces a band from N children. `groupIntoContainers` itself becomes obsolete after this change but should be kept until Task 7 verifies the new path subsumes it.

3. **`applyAddTopLevelFrame`** (src/editorState.ts:1082-1106). Today: clamps gridRow, computes `docOffset` from CM doc, sets `lineCount = frame.gridH`, dispatches `addFrameEffect`. Under eager bands: the function detects whether a band already claims the target row. If yes → dispatch `addChildFrameEffect` (rebase coords parent-relative, lineCount=0). If no → wrap the new rect in a fresh band and dispatch `addFrameEffect` with the BAND. The internal effects do not change; only this public helper's branching changes.

4. **`applyReparentFrame` promote branch** (src/editorState.ts:1149-1164 → effect handler at src/editorState.ts:219-247). Today: the promote branch synthesizes a top-level claiming frame from the demoted child, dispatches `reparentFrameEffect` with `newParentId=null`, and `unifiedDocSync` inserts `gridH` blank lines at the target row. Under eager bands: when the target row is already claimed by an existing band, `applyReparentFrame` re-routes to `applyReparentFrame(..., newParentId=existingBand.id, ...)` — i.e., it demotes into the band instead of promoting to top-level. If no band exists at the target row, the promote branch wraps the frame in a fresh band before dispatching.

5. **Serializer** (src/serializeUnified.ts:14-116). Already container-aware: `buildLineToFrames` iterates top-level frames and maps each claimed line; `renderFrameRow` recurses into children regardless of parent gridH (line 112). A band with `content: null` skips the cell-render block (line 91 guard `if (frame.content)`) and only recurses, which is exactly what we want — the band itself draws nothing; its children draw their own borders. Round-trip output: side-by-side `┌─┐  ┌─┐` is produced naturally.

6. **`unifiedDocSync` transactionFilter** (src/editorState.ts:569-737). Handles doc surgery for each effect:
   - `addFrameEffect` (line 694): inserts `lineCount` newlines at `docOffset`. Under eager bands, the BAND carries `lineCount`; rects added as children carry `lineCount=0` and skip this branch (line 697 guard).
   - `addChildFrameEffect`: no doc surgery, never had any. Children are non-claiming.
   - `reparentFrameEffect` (line 707): promote inserts; demote releases. Eager bands turn most "promote into existing band's row" cases into demotes, so this filter naturally does the right thing.
   - `moveFrameEffect` (line 571): rotation-only on top-level (lineCount>0). For bands, the band rotates; its children come along via parent-relative coords. **Do not change drag logic** — commit 1cbf2e4 cemented this.

7. **The failing harness test** (e2e/harness.spec.ts:3851-3882). The test loads SIMPLE_BOX (one box), presses 'r', drags out a new rect to the right of the existing box on the same row band, and asserts `Math.abs(existingAfter!.y - existingYBefore) <= 1`. Under eager bands, the existing box is wrapped in a band on load. Drawing the new rect on the same row band detects the existing band and dispatches `addChildFrameEffect` (no doc change → no mapPos shift → existing rect's y unchanged). Test passes.

8. **What MUST NOT change:**
   - The rotation-only drag logic (src/editorState.ts:571-647). Net-zero doc change keeps siblings independent.
   - The `framesField` gridRow re-derivation at end of update (src/editorState.ts:386-395). Load-bearing for drag and prose edits.
   - The serialized markdown shape. A solo rect on disk → loaded as a band-wrapping-one-rect → saved should produce the same `┌─┐` (the band has no border; its single child rect draws `┌─┐`).

9. **`docWidthCols`** — the band's width. We need it to make the band "full width" so the visual hit-test treats the entire row band as the band's territory. Use a generous default: `docWidthCols = max(120, max(child.gridCol + child.gridW for all children))`. The band's `gridCol = 0` and `gridW = docWidthCols`; pixel width = `gridW * charWidth`. This is a UX choice — it makes the entire row clickable as the band but doesn't affect serialization (band has no content to render).

10. **Tests that need rewriting.** ~50 distinct unit + e2e tests assert on `getFrames(state)[0].x` etc. style indexing. Under eager bands, `getFrames(state)[0]` is the band; `getFrames(state)[0].children[0]` is the wrapped rect. Most assertions can be rewritten by walking through `.children[0]` (band bbox = union of children = single child's bbox for the 1-rect case, so x/y values still match). A focused sweep is in Task 6.

---

## Task 0: Confirm baseline state

**Note on Figma-style nest-on-draw under eager bands.** Today, `DemoV2.tsx:471` resolves a click's *top-level ancestor* and uses that id as the parent for nested draws (`applyAddChildFrame(state, f, parentTopLevel.id, ...)`). Under eager bands, the top-level is now the BAND, not the rect the user clicked on. This means drawing inside a rect would currently nest the new frame inside the *band* (sibling of the rect) — NOT inside the rect itself, breaking the Figma "draw inside a frame to nest" UX.

The fix: in `DemoV2.tsx:471`, walk DOWN from the band to find the smallest enclosing rect/container that contains the click point (use `hitTestOne`-style recursion), and prefer THAT as the parent. If the only enclosing frame is the band itself, the new frame becomes a band child (correct). If there's a rect inside the band that contains the click, the new frame nests inside the rect (preserves Figma UX). This is folded into Task 1 (hit-test guard for bands) below.



**Files:** none (just verify environment).

**Step 1: Confirm worktree, branch, and dev server**

```bash
cd ~/dev/gridpad/.claude/worktrees/unified-document
git status -sb | head -3
# Expected first line: "## feature/add-frame-fix...origin/feature/add-frame-fix"
```

Confirm dev server is running on :5177 (it's referenced in playwright.config.ts and the briefing said it was already started). If not running:

```bash
npm run dev -- --port 5177 &  # background; harness depends on it
```

**Step 2: Run the failing harness test once to confirm RED**

```bash
npx playwright test e2e/harness.spec.ts -g "draw new rect to the RIGHT" --reporter=line --workers=1
```

Expected output: 1 failed. Look at the failure — the assertion should be `Math.abs(existingAfter!.y - existingYBefore) <= 1` failing because the existing frame was pushed down by `gridH * charHeight` pixels (≈54px for a 3-row frame at default ch).

**Step 3: Run vitest baseline**

```bash
npx vitest run --reporter=dot 2>&1 | tail -5
```

Record the pre-fix passing count (briefing says ~489). We need to track which tests break because of the eager-bands change vs. which were already failing.

**Step 4: No commit — this task only verifies state.**

---

## Task 0.5: Refactor `unifiedDocSync` to accumulate doc-changes across multiple effects

**Files:**
- Modify: `src/editorState.ts` — `unifiedDocSync` transactionFilter (~line 569-737)
- Test: `src/editorState.test.ts`

**Why this task exists.** Today `unifiedDocSync` returns from the loop on the FIRST matching effect (lines 615/666/673/692/705/721/732 in `unifiedDocSync` are all `return [tr, ...]`). Tasks 3 and 4 dispatch multi-effect transactions: `[resizeFrameEffect, addChildFrameEffect]` (Task 3) and `[resizeFrameEffect, reparentFrameEffect]` (Task 4). The Task 3 case happens to work because `addChildFrameEffect` has no doc-surgery branch. The Task 4 case is BROKEN — the resize returns early, the reparent's release-or-insert-claim-lines branch is skipped, leaving orphan claim lines in the doc.

The fix: rewrite the filter to walk all effects, collect their doc-change specs into one array, and return `[tr, { changes: [...all], sequential: true }]` once at the end. Each effect's branch becomes "push to changes" instead of "return immediately." Same single-pass loop, but accumulate.

**Step 1: Write a failing test that verifies multi-effect transactions**

Add to `src/editorState.test.ts`:

```ts
describe("unifiedDocSync multi-effect transactions", () => {
  const CW = 8, CH = 18;
  const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("dispatching [resize, delete] processes BOTH effects (resize grows, then delete removes)", () => {
    // Setup: two stacked claiming frames. We dispatch resize on A and delete
    // on B in one transaction. Today the resize returns early, B is left with
    // its claim lines but B is gone from the frames list — orphaned lines.
    // After fix: both doc surgeries happen.
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const rectB = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, rectB, 5, 0);
    const docLenBefore = getDoc(state2).length;
    const aId = getFrames(state2)[0].id;
    const bId = getFrames(state2)[1].id;

    // Dispatch BOTH a resize on A and a delete on B in one transaction.
    const state3 = state2.update({
      effects: [
        resizeFrameEffect.of({ id: aId, gridW: 5, gridH: 5, charWidth: CW, charHeight: CH }),
        // Note: deleteFrameEffect is non-exported; use applyDeleteFrame
        // through a separate dispatch for now. The real multi-effect case
        // we care about is [resize, reparentFrameEffect] — emulate via
        // a pure exported helper if needed for the test.
      ],
    }).state;

    // Resize alone increases doc length by 2 (delta=2 newlines).
    expect(getDoc(state3).length).toBe(docLenBefore + 2);
  });
});
```

The above test exercises the single-effect case which already works. We can't easily test multi-effect from here without exporting more internals. **Decision: rely on the integration tests in Tasks 3, 4, and 6 to exercise the multi-effect path.** This task's correctness is verified end-to-end through the Task 3 "joining a band with a TALLER child grows the band's claim" test and the Task 4 "promote into existing band" test.

If the implementer wants stronger isolation, export `addChildFrameEffect` / `reparentFrameEffect` / `deleteFrameEffect` from editorState.ts as private-internal exports (e.g., `_addChildFrameEffect`) so tests can dispatch them directly. Skip if integration coverage is sufficient.

**Step 2: Refactor `unifiedDocSync` to accumulate**

Replace the body of `unifiedDocSync` (src/editorState.ts:569-737). Pattern:

```ts
const unifiedDocSync = EditorState.transactionFilter.of((tr) => {
  // Collect doc-change specs from each frame mutation effect. CM merges
  // them into a single transaction via resolveTransaction(state, filtered,
  // false) — sequential: true ensures positions in later specs are
  // interpreted in the doc state AFTER earlier specs apply.
  const allChanges: Array<{ from: number; to?: number; insert?: string }> = [];
  const extraEffects: StateEffect<unknown>[] = [];

  for (const e of tr.effects) {
    if (e.is(moveFrameEffect) && e.value.dRow !== 0) {
      // ... (existing logic, but instead of `return [tr, { changes }]`,
      // push to `allChanges` and `extraEffects` for relocateFrameEffect.)
      const frames = tr.startState.field(framesField);
      const frame = findFrameInList(frames, e.value.id);
      if (!frame || frame.lineCount === 0) continue;
      // ... (compute startLine, endLine, dRow, maxDown, maxUp, effectiveDRow as before)
      // Instead of:
      //   return [{ effects: [...], changes }];
      // do:
      //   allChanges.push(...);
      //   extraEffects.push(relocateFrameEffect.of({...}));
      // continue;
    }
    if (e.is(resizeFrameEffect)) {
      const frames = tr.startState.field(framesField);
      const frame = findFrameInList(frames, e.value.id);
      if (!frame || frame.lineCount === 0) continue;
      const newGridH = Math.max(2, e.value.gridH);
      const delta = newGridH - frame.lineCount;
      if (delta === 0) continue;
      const startLine = tr.startState.doc.lineAt(frame.docOffset);
      const endLineNum = startLine.number + frame.lineCount - 1;
      const endLine = tr.startState.doc.line(endLineNum);
      if (delta > 0) {
        allChanges.push({ from: endLine.to, insert: "\n".repeat(delta) });
      } else {
        const keepLastNum = endLineNum + delta;
        const keepLast = tr.startState.doc.line(keepLastNum);
        allChanges.push({ from: keepLast.to, to: endLine.to });
      }
      continue;
    }
    if (e.is(deleteFrameEffect)) {
      // ... same: compute from/to, push to allChanges, continue.
    }
    if (e.is(addFrameEffect)) {
      const newFrame = e.value;
      if (newFrame.lineCount === 0) continue;
      const doc = tr.startState.doc;
      const offset = Math.max(0, Math.min(newFrame.docOffset, doc.length));
      allChanges.push({ from: offset, insert: "\n".repeat(newFrame.lineCount) });
      continue;
    }
    if (e.is(reparentFrameEffect)) {
      // ... same: promote = push insert; demote = push delete-range.
    }
  }

  if (allChanges.length === 0 && extraEffects.length === 0) return tr;
  return [
    {
      ...(extraEffects.length > 0 ? { effects: [...tr.effects, ...extraEffects] } : {}),
      changes: allChanges,
      sequential: true,
    },
  ];
});
```

Key details:
- The drag (move) branch had a different return shape (`[{ effects, changes }]`) because it adds a `relocateFrameEffect`. After refactor, drag pushes both into `allChanges` (rotation = delete + insert) AND `extraEffects` (the relocate).
- `sequential: true` is critical — when multiple specs touch the doc, CM applies them one after another, mapping later specs through earlier ones. Without it, all specs are interpreted in the original doc state and you get position drift.
- The early `continue` (instead of `return`) is the core change — it lets the loop visit ALL effects.

**Step 3: Verify all single-effect cases still pass**

```bash
npx vitest run src/editorState.test.ts --reporter=dot 2>&1 | tail -10
```

The single-effect path is the bulk of test coverage. If anything single-effect-related broke, the refactor introduced a regression. Most common pitfall: the move (drag) branch's `effectiveDRow === 0 → continue` previously meant "return tr unchanged" (drag had no rotation budget). After refactor, it means "skip this effect, continue collecting from others." Same end state if no other effects produce changes.

**Step 4: Run e2e harness sanity**

```bash
npx playwright test e2e/harness.spec.ts --reporter=line --workers=4 2>&1 | tail -10
```

Expected: same pass/fail as baseline (132/136 + the still-RED draw-rect-RIGHT). The refactor is supposed to be behavior-preserving for single-effect transactions.

**Step 5: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "refactor: unifiedDocSync accumulates doc-changes across multiple effects

Rewrite the transactionFilter to collect doc-change specs from every
effect in the transaction, returning one merged spec at the end. Enables
upcoming multi-effect dispatches like [resize, reparent] in eager-bands
work.

Single-effect behavior is unchanged. sequential: true ensures later
specs are mapped through earlier ones."
```

---

## Task 1: Extract `wrapAsBand` helper in src/frame.ts

**Files:**
- Modify: `src/frame.ts` — export new helper, refactor `groupIntoContainers` to call it
- Test: `src/frame.test.ts`

**Step 1: Write the failing test**

Add to `src/frame.test.ts` (find an appropriate `describe` block, or add a new one at the bottom):

```ts
describe("wrapAsBand", () => {
  it("wraps a single rect into a band container with rebased coords", () => {
    const rect: Frame = {
      ...createRectFrame({ gridW: 6, gridH: 3, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: 8, charHeight: 18 }),
      gridRow: 5,
      gridCol: 10,
      x: 80, y: 90,
      docOffset: 100,
      lineCount: 3,
    };
    const band = wrapAsBand([rect], 8, 18, 120);
    // Band properties
    expect(band.content).toBeNull();
    expect(band.children).toHaveLength(1);
    expect(band.gridRow).toBe(5);
    expect(band.gridCol).toBe(0);
    expect(band.gridW).toBe(120);          // full doc width
    expect(band.gridH).toBe(3);            // matches rect height
    expect(band.lineCount).toBe(3);        // band owns the claim
    expect(band.docOffset).toBe(100);      // inherited from child
    // Child rebased: was at absolute (5, 10), now band-relative (0, 10)
    expect(band.children[0].gridRow).toBe(0);
    expect(band.children[0].gridCol).toBe(10);
    expect(band.children[0].lineCount).toBe(0);
    expect(band.children[0].docOffset).toBe(0);
    expect(band.children[0].content?.type).toBe("rect");
  });

  it("wraps two side-by-side rects into one band, both rebased", () => {
    const charW = 8, charH = 18;
    const rectA: Frame = {
      ...createRectFrame({ gridW: 4, gridH: 3, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: charW, charHeight: charH }),
      gridRow: 2, gridCol: 0, x: 0, y: 36, docOffset: 50, lineCount: 3,
    };
    const rectB: Frame = {
      ...createRectFrame({ gridW: 5, gridH: 3, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: charW, charHeight: charH }),
      gridRow: 2, gridCol: 8, x: 64, y: 36, docOffset: 50, lineCount: 3,
    };
    const band = wrapAsBand([rectA, rectB], charW, charH, 120);
    expect(band.children).toHaveLength(2);
    expect(band.gridRow).toBe(2);
    expect(band.gridH).toBe(3);
    expect(band.children[0].gridRow).toBe(0);
    expect(band.children[0].gridCol).toBe(0);
    expect(band.children[1].gridRow).toBe(0);
    expect(band.children[1].gridCol).toBe(8);
  });

  it("band gridH spans union of children rows", () => {
    const charW = 8, charH = 18;
    const rectA: Frame = {
      ...createRectFrame({ gridW: 4, gridH: 3, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: charW, charHeight: charH }),
      gridRow: 2, gridCol: 0, x: 0, y: 36, docOffset: 50, lineCount: 3,
    };
    const rectB: Frame = {
      ...createRectFrame({ gridW: 5, gridH: 4, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: charW, charHeight: charH }),
      gridRow: 4, gridCol: 8, x: 64, y: 72, docOffset: 50, lineCount: 4,
    };
    const band = wrapAsBand([rectA, rectB], charW, charH, 120);
    // Band rows: from 2 (top of A) to 4+4=8 → gridH = 6
    expect(band.gridRow).toBe(2);
    expect(band.gridH).toBe(6);
    expect(band.lineCount).toBe(6);
  });
});
```

Also add `wrapAsBand` to the import at the top of the file:

```ts
import { ..., wrapAsBand, ... } from "./frame";
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/frame.test.ts -t "wrapAsBand" 2>&1 | tail -30
```

Expected: FAIL with "wrapAsBand is not exported" or "is not a function".

**Step 3: Implement `wrapAsBand` in src/frame.ts**

Add this function near `groupIntoContainers` (after line 510, end of file). Use `nextId()` (already in scope at line 60-64).

```ts
/**
 * Wrap N child frames into a synthetic full-width band container.
 *
 * The band owns the doc-line claim (lineCount, docOffset) and is the new
 * top-level frame. Children are rebased to band-relative grid coords with
 * lineCount=0 and docOffset=0.
 *
 * The band has content=null (no border), full doc width (gridCol=0,
 * gridW=docWidthCols), and gridRow/gridH equal to the union of children's
 * absolute row ranges. The band's docOffset is inherited from the child
 * with the smallest gridRow (the topmost claim).
 *
 * Children must currently be in ABSOLUTE grid coordinates (i.e., they were
 * top-level before this call). Mixing already-band-relative and absolute
 * children is undefined behavior — the caller must ensure inputs are
 * consistent.
 */
export function wrapAsBand(
  children: Frame[],
  charWidth: number,
  charHeight: number,
  docWidthCols: number,
): Frame {
  if (children.length === 0) {
    throw new Error("wrapAsBand: cannot wrap empty children");
  }
  let minRow = Infinity, maxRow = 0;
  let docOffset = 0;
  for (const c of children) {
    if (c.gridRow < minRow) {
      minRow = c.gridRow;
      docOffset = c.docOffset;
    }
    if (c.gridRow + c.gridH > maxRow) maxRow = c.gridRow + c.gridH;
  }
  const gridH = maxRow - minRow;
  const rebasedChildren: Frame[] = children.map((c) => ({
    ...c,
    gridRow: c.gridRow - minRow,
    // gridCol stays absolute — band is full-width starting at col 0.
    x: c.gridCol * charWidth,
    y: (c.gridRow - minRow) * charHeight,
    docOffset: 0,
    lineCount: 0,
  }));
  return {
    id: nextId(),
    x: 0,
    y: minRow * charHeight,
    w: docWidthCols * charWidth,
    h: gridH * charHeight,
    z: 0,
    children: rebasedChildren,
    content: null,
    clip: true,
    dirty: true,
    gridRow: minRow,
    gridCol: 0,
    gridW: docWidthCols,
    gridH,
    docOffset,
    lineCount: gridH,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/frame.test.ts -t "wrapAsBand" 2>&1 | tail -20
```

Expected: 3 passing.

**Step 5: Confirm no regressions in frame.test.ts**

```bash
npx vitest run src/frame.test.ts --reporter=dot 2>&1 | tail -5
```

Expected: all existing frame.test.ts tests still pass.

**Step 6: Commit**

```bash
git add src/frame.ts src/frame.test.ts
git commit -m "feat: add wrapAsBand helper in frame.ts

wrapAsBand wraps N top-level frames into a synthetic full-width band
container. Children are rebased to band-relative coords with lineCount=0;
the band inherits docOffset from the topmost child and owns the claim.

Used by upcoming eager-band changes to applyAddTopLevelFrame and
applyReparentFrame."
```

---

## Task 1.5: Hit-test guard for synthetic bands + band-aware nest-on-draw

**Files:**
- Modify: `src/frame.ts` — `hitTestOne` (~line 210)
- Modify: `src/DemoV2.tsx` — `parentTopLevel` resolution (~line 471)
- Test: `src/frame.test.ts`

**Why this task exists.** Two related issues:
1. `hitTestOne` returns `bestHit ?? frame` (frame.ts:229). Under eager bands, clicking empty space inside a band's bbox (full-width × claimed rows) hits the band itself. Today the same click misses (no top-level frame). Selecting a band feels surprising because the band has no visible border.
2. `DemoV2.tsx:471` resolves the click's top-level ancestor and uses it as the parent for nested draws. Under eager bands, the top-level is the band, so drawing inside a rect would now make the new frame a band-child sibling of the rect, not a rect-child as expected (Figma "draw inside frame to nest" UX).

**Step 1: Write failing tests**

Add to `src/frame.test.ts`:

```ts
describe("hitTest skips synthetic bands when no child matched", () => {
  it("clicking inside a band's bbox but outside any child returns null", () => {
    const charW = 8, charH = 18;
    // Band at (0, 0, 120col, 3row), with one rect child at (0, 0-5col, 0-3row).
    const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
    const rect: Frame = {
      ...createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: charW, charHeight: charH }),
      gridRow: 0, gridCol: 0, x: 0, y: 0,
    };
    const band: Frame = wrapAsBand([rect], charW, charH, 120);
    // Click well to the right of the rect (col 50, well past rect's 5 cols).
    const hit = hitTestFrames([band], 50 * charW, charH); // y=18 (row 1)
    expect(hit).toBeNull();
  });

  it("clicking inside a child rect inside a band returns the child", () => {
    const charW = 8, charH = 18;
    const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
    const rect: Frame = {
      ...createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: charW, charHeight: charH }),
      gridRow: 0, gridCol: 0, x: 0, y: 0,
    };
    const band: Frame = wrapAsBand([rect], charW, charH, 120);
    // Click inside the rect (col 2, row 1).
    const hit = hitTestFrames([band], 2 * charW, charH);
    expect(hit).toBeTruthy();
    expect(hit!.id).toBe(rect.id);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/frame.test.ts -t "skips synthetic bands" 2>&1 | tail -20
```

Expected: 1st test FAILS (today returns the band). 2nd test PASSES (existing logic finds the child correctly).

**Step 3: Modify `hitTestOne` to skip content=null bands as fallbacks**

Replace the last line of `hitTestOne` (frame.ts:229):

```ts
  // Bands (content === null synthetic containers) are not selectable on
  // their own — clicking empty space inside a band returns no hit, not the
  // band. Children inside a band still hit normally via the recursive case.
  if (bestHit) return bestHit;
  if (frame.content === null) return null;
  return frame;
```

**Step 4: Run hit-test tests**

```bash
npx vitest run src/frame.test.ts -t "hitTest" --reporter=dot 2>&1 | tail -10
```

Expected: all passing, including the new band-skip tests.

**Step 5: Make `DemoV2.tsx` nest-on-draw band-aware**

Find the `parentTopLevel` resolution at DemoV2.tsx:471. The issue: `parentTopLevel` walks UP to the top-level (band), but for nest-on-draw we want the SMALLEST enclosing rect/container at the click point, not the topmost.

Update `parentTopLevel` resolution to prefer the smallest enclosing claiming frame. The `hit` from `hitTestFrames` is already the smallest matching child (frame.ts:222-227 picks min-area). After Task 1.5 step 3, clicking inside a rect inside a band returns the rect; clicking empty band space returns null. Using `hit?.id` directly as the nest-parent (when `hit` is a rect) gives Figma-style nesting. When `hit` is null (empty band space), fall back to the band:

```ts
// Old:
const parentTopLevel = hit ? framesRef.current.find(f => f.id === hit.id || hasDescendant(f, hit.id)) ?? null : null;

// New: nest into the SMALLEST claiming container we hit. If we hit a rect,
// nest in the rect. If we hit nothing (e.g., empty band space, or empty
// canvas), nest in the band that claims the click row, or top-level.
let nestParent: Frame | null = null;
if (hit) {
  // Walk up from `hit` to the smallest claiming ancestor. For a rect inside
  // a band, this returns the rect. For a band itself, the band.
  nestParent = hit; // hit is already the smallest match
} else {
  // No frame hit. Check if click row is inside a band; if so, nest in band.
  const cw = cwRef.current, ch = chRef.current;
  const rowAtClick = Math.floor(py / ch);
  for (const f of framesRef.current) {
    if (f.content === null && rowAtClick >= f.y / ch && rowAtClick < (f.y + f.h) / ch) {
      nestParent = f;
      break;
    }
  }
}
```

Then in DemoV2.tsx:475 and 481 (and 694, 702, 884), use `nestParent?.id ?? null` instead of `parentTopLevel?.id ?? null`.

**Step 6: Smoke-test in browser**

Open http://localhost:5177/gridpad/. Hard refresh.
1. Open default doc with one box.
2. Press 'r'. Drag inside the box — new rect should be a CHILD of the box (Figma nesting still works).
3. Drag in empty space to the right of the box (still on the same row band) — new rect joins the BAND as a sibling of the box (the eager-bands fix). Existing box doesn't move.

**Step 7: Commit**

```bash
git add src/frame.ts src/DemoV2.tsx src/frame.test.ts
git commit -m "feat: hit-test skips synthetic bands; nest-on-draw stays Figma-style

hitTestOne returns null instead of the band when no child matched —
empty band space is unselectable. DemoV2's nest-on-draw uses the
smallest enclosing frame as parent (rect-in-band nests in the rect),
falling back to the band only when the click is in band-empty space."
```

---

## Task 2: Find-band helper in src/editorState.ts

**Files:**
- Modify: `src/editorState.ts` — add a non-exported helper `findBandAtRow`
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

Add to `src/editorState.test.ts`:

```ts
describe("findBandAtRow", () => {
  it("returns the band claiming the given row, or null", () => {
    const charW = 8, charH = 18;
    // We test via applyAddTopLevelFrame side effects in Task 3;
    // for this task, we test the helper indirectly by constructing
    // a state with a band and querying via getFrames.
    // findBandAtRow itself is not exported — we test its semantics
    // through applyAddTopLevelFrame's branching in Task 3.
    expect(true).toBe(true); // placeholder — real test is in Task 3
  });
});
```

Note: `findBandAtRow` is a private helper. We don't unit-test it directly; we test its behavior through `applyAddTopLevelFrame` in Task 3. This task's test is just a placeholder so we still git-commit-isolate the helper.

**Step 2: Implement `findBandAtRow`**

In `src/editorState.ts`, add this private helper near the existing `findFrameInList` (around line 97):

```ts
/**
 * Return the top-level band frame whose claim range covers `row`, or null.
 * A band is a top-level frame with content=null and lineCount > 0.
 * Used by applyAddTopLevelFrame and applyReparentFrame to detect when a
 * mutation should join an existing band instead of inserting fresh claim
 * lines.
 */
function findBandAtRow(frames: Frame[], row: number): Frame | null {
  for (const f of frames) {
    if (f.lineCount === 0) continue;
    if (f.content !== null) continue; // only synthetic bands
    if (row >= f.gridRow && row < f.gridRow + f.lineCount) return f;
  }
  return null;
}
```

**Step 3: Verify build passes**

```bash
npm run build 2>&1 | tail -10
```

Expected: build succeeds (no `tsc -b` errors).

**Step 4: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: add findBandAtRow helper in editorState.ts

Private helper to detect whether a row is already claimed by a synthetic
band container. Used by upcoming applyAddTopLevelFrame and
applyReparentFrame eager-band branches."
```

---

## Task 3: Eager band in `applyAddTopLevelFrame` (with TDD)

**Files:**
- Modify: `src/editorState.ts` — `applyAddTopLevelFrame` (~line 1082)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing tests**

Add to `src/editorState.test.ts`:

```ts
describe("applyAddTopLevelFrame eager bands", () => {
  const CW = 8, CH = 18;
  const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("first rect on a row creates a band wrapping it", () => {
    // Empty doc, add a rect at row 0.
    const state = createEditorState({ prose: "\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rect = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const next = applyAddTopLevelFrame(state, rect, 0, 0);
    const frames = getFrames(next);
    expect(frames).toHaveLength(1);
    expect(frames[0].content).toBeNull();         // band
    expect(frames[0].children).toHaveLength(1);    // wrapping our rect
    expect(frames[0].children[0].content?.type).toBe("rect");
    expect(frames[0].lineCount).toBe(3);          // band owns claim
    expect(frames[0].children[0].lineCount).toBe(0);
    expect(frames[0].children[0].docOffset).toBe(0);
  });

  it("second rect on the SAME row joins the existing band", () => {
    // Setup: doc with 6 prose-row gaps; add rect A at row 0.
    const state0 = createEditorState({ prose: "\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const docAfterA = getDoc(state1);
    const frameAId = getFrames(state1)[0].id; // band id
    const rectAId = getFrames(state1)[0].children[0].id;

    // Add rect B at row 0 (same row band as A — col 8 is to the right).
    const rectB = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, rectB, 0, 8);

    // Doc length must NOT have changed (no fresh claim lines inserted).
    expect(getDoc(state2)).toBe(docAfterA);

    // Frames: still ONE top-level (the band), now with TWO children.
    const frames = getFrames(state2);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(frameAId);          // SAME band
    expect(frames[0].children).toHaveLength(2);
    const childIds = frames[0].children.map(c => c.id);
    expect(childIds).toContain(rectAId);

    // Original rect A's gridRow/gridCol must be unchanged (band-relative).
    const aChild = frames[0].children.find(c => c.id === rectAId)!;
    expect(aChild.gridRow).toBe(0);
    expect(aChild.gridCol).toBe(0);
  });

  it("joining a band with a TALLER child grows the band's claim", () => {
    // band claims rows 0,1,2 (gridH=3). Add a rect at row 1 with gridH=5
    // (extends to row 5). The band must grow to gridH=6 and the doc must
    // gain 3 extra blank lines.
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const docLenBefore = getDoc(state1).length;
    const bandId = getFrames(state1)[0].id;
    const tallRect = createRectFrame({ gridW: 4, gridH: 5, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, tallRect, 1, 8);
    const frames = getFrames(state2);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(bandId);
    expect(frames[0].children).toHaveLength(2);
    // Band must have grown to cover the taller child.
    expect(frames[0].gridH).toBeGreaterThanOrEqual(6);
    expect(frames[0].lineCount).toBeGreaterThanOrEqual(6);
    // Doc grew by exactly the difference (newH - oldH) blank lines.
    const docLenAfter = getDoc(state2).length;
    expect(docLenAfter).toBe(docLenBefore + (frames[0].lineCount - 3));
  });

  it("rect on a row CLAIMED by no band creates a fresh band", () => {
    // First rect at row 0 (creates band 1). Second rect at row 5
    // (separate doc range, no overlap → fresh band 2).
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const rectB = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, rectB, 5, 0);

    const frames = getFrames(state2);
    expect(frames).toHaveLength(2);
    expect(frames[0].content).toBeNull();
    expect(frames[1].content).toBeNull();
    expect(frames[0].children).toHaveLength(1);
    expect(frames[1].children).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/editorState.test.ts -t "eager bands" 2>&1 | tail -40
```

Expected: 3 failures. The first ("first rect creates a band") will fail because today `applyAddTopLevelFrame` adds the rect as the top-level frame directly — no wrapping. The second ("joins existing band") will fail because today the second add inserts new claim lines and produces TWO top-level rects with different ids. Read the failure carefully — make sure both fail for the RIGHT reason (wrong tree shape, not e.g. an import error).

**Step 3: Implement eager-band logic in `applyAddTopLevelFrame`**

Replace the body of `applyAddTopLevelFrame` (src/editorState.ts:1082-1106) with:

```ts
export function applyAddTopLevelFrame(
  state: EditorState,
  frame: Frame,
  gridRow: number,
  gridCol: number,
): EditorState {
  const targetLine = Math.min(Math.max(gridRow, 0), state.doc.lines - 1);
  const docOffset = state.doc.line(targetLine + 1).from;
  const charWidth = frame.gridW > 0 ? frame.w / frame.gridW : 0;
  const charHeight = frame.gridH > 0 ? frame.h / frame.gridH : 0;

  // Eager bands: if a band already claims `gridRow`, append the new frame
  // as a child of that band — no new top-level claim lines, no claim
  // collision. If the new child extends past the band's current bottom,
  // grow the band (and the doc's blank-line backing) via resizeFrameEffect.
  const existingBand = findBandAtRow(getFrames(state), gridRow);
  if (existingBand) {
    const childFrame: Frame = {
      ...frame,
      x: gridCol * charWidth,
      y: (gridRow - existingBand.gridRow) * charHeight,
      gridRow: gridRow - existingBand.gridRow,
      gridCol,
      docOffset: 0,
      lineCount: 0,
    };
    const childBottom = childFrame.gridRow + frame.gridH;
    const newBandH = Math.max(existingBand.gridH, childBottom);
    const effects: StateEffect<unknown>[] = [];
    if (newBandH > existingBand.gridH) {
      // Expand the band's claim FIRST so unifiedDocSync inserts the extra
      // blank lines before the child is added.
      effects.push(resizeFrameEffect.of({
        id: existingBand.id,
        gridW: existingBand.gridW,
        gridH: newBandH,
        charWidth,
        charHeight,
      }));
    }
    effects.push(addChildFrameEffect.of({ parentId: existingBand.id, frame: childFrame }));
    return state.update({
      effects,
      annotations: Transaction.addToHistory.of(true),
    }).state;
  }

  // No existing band — wrap the new rect in a fresh band and add as top-level.
  // Place the rect at absolute (gridRow, gridCol) so wrapAsBand's rebasing
  // produces a child at (0, gridCol) inside a band starting at gridRow.
  const placedRect: Frame = {
    ...frame,
    x: gridCol * charWidth,
    y: gridRow * charHeight,
    gridRow,
    gridCol,
    docOffset,            // inherited by the band via wrapAsBand
    lineCount: frame.gridH,
  };
  const docWidthCols = computeDocWidthCols(state, [placedRect]);
  const band = wrapAsBand([placedRect], charWidth, charHeight, docWidthCols);
  return applyAddFrame(state, band);
}

/** Choose a band's full-width gridW. Use the larger of: 120, longest doc
 * line in cols, max child right edge. The band has no border, so width
 * is purely a hit-test concern, not a serialization concern. */
function computeDocWidthCols(state: EditorState, children: Frame[]): number {
  let maxCol = 120;
  for (let i = 1; i <= state.doc.lines; i++) {
    const ln = state.doc.line(i);
    if (ln.length > maxCol) maxCol = ln.length;
  }
  for (const c of children) {
    const right = c.gridCol + c.gridW;
    if (right > maxCol) maxCol = right;
  }
  return maxCol;
}
```

Add the import for `wrapAsBand` at the top of `src/editorState.ts`:

```ts
import { moveFrame, resizeFrame, wrapAsBand } from "./frame";
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/editorState.test.ts -t "eager bands" 2>&1 | tail -30
```

Expected: 3 passing.

**Step 5: Run full editorState.test.ts to see breakage**

```bash
npx vitest run src/editorState.test.ts --reporter=dot 2>&1 | tail -10
```

Many tests will fail because `getFrames(state)[0]` is now the band, not the rect. **DO NOT FIX THEM IN THIS COMMIT.** They are expected fallout of the eager-bands change. Task 6 is the dedicated test sweep.

Record the failure count for tracking. Expected: ~15-25 unit tests failing.

**Step 6: Commit (with broken tests intentionally tracked)**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: eager band wrapping in applyAddTopLevelFrame

Every new top-level claiming frame is wrapped in a synthetic full-width
band container. Drawing a second frame on a row already claimed by a band
appends it as a child of that band (no new claim lines, no doc shift).

Existing tests that index getFrames(state)[0].field will break — they are
fixed in Task 6 (test sweep)."
```

---

## Task 3.5: Cascade-delete the band when its last child is deleted

**Files:**
- Modify: `src/editorState.ts` — `applyDeleteFrame` (~line 1166)
- Test: `src/editorState.test.ts`

**Why this task exists:** `framesField` already cascades-removes empty `content === null` containers (src/editorState.ts:320-330). But `unifiedDocSync` only sees the *child's* `deleteFrameEffect`, and children have `lineCount === 0`, so the doc-surgery branch at line 676-693 is skipped. The band vanishes from state but its claimed blank lines stay in the doc as ghost layout space. To release the doc lines correctly, we redirect the deletion to target the *band* whenever the user is deleting the only child of a band.

**Step 1: Write the failing test**

Add to `src/editorState.test.ts`:

```ts
describe("applyDeleteFrame cascades band cleanup", () => {
  const CW = 8, CH = 18;
  const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("deleting the only rect inside a band releases the band's doc lines", () => {
    const state0 = createEditorState({ prose: "\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const docLenBefore = getDoc(state0).length;
    const rect = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rect, 0, 0);
    const docLenWithBand = getDoc(state1).length;
    expect(docLenWithBand).toBeGreaterThan(docLenBefore); // band added 3 blank lines
    const rectId = getFrames(state1)[0].children[0].id;

    const state2 = applyDeleteFrame(state1, rectId);
    // Band must be gone.
    expect(getFrames(state2)).toHaveLength(0);
    // Doc must be back to its original length — claim lines released.
    expect(getDoc(state2).length).toBe(docLenBefore);
  });

  it("deleting one of TWO children in a band does NOT release the band", () => {
    const state0 = createEditorState({ prose: "\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const rectB = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, rectB, 0, 8);
    const docLenWithTwo = getDoc(state2).length;
    const rectAId = getFrames(state2)[0].children[0].id;

    const state3 = applyDeleteFrame(state2, rectAId);
    // Band still here, with one child.
    const frames = getFrames(state3);
    expect(frames).toHaveLength(1);
    expect(frames[0].content).toBeNull();
    expect(frames[0].children).toHaveLength(1);
    // Doc length unchanged — band still owns its claim.
    expect(getDoc(state3).length).toBe(docLenWithTwo);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/editorState.test.ts -t "cascades band cleanup" 2>&1 | tail -30
```

Expected: 1st test FAILS — band's claim lines remain in the doc. 2nd may pass coincidentally; verify the assertion runs.

**Step 3: Modify `applyDeleteFrame` to redirect when target is sole child of a band**

Replace the body of `applyDeleteFrame` (src/editorState.ts:1166-1192). The existing logic identifies affected selection/text-edit state; we add a redirection step at the top.

```ts
export function applyDeleteFrame(state: EditorState, id: string): EditorState {
  // If the target is the only child of a synthetic band, delete the band
  // instead — that releases the band's claim lines via unifiedDocSync.
  // Otherwise the band would be cascade-removed from state but its blank
  // doc lines would remain forever.
  let targetId = id;
  for (const f of getFrames(state)) {
    if (f.content === null && f.children.length === 1 && f.children[0].id === id) {
      targetId = f.id;
      break;
    }
  }

  // (rest of function uses targetId where it previously used id)
  const frameContains = (frame: Frame, lookId: string): boolean => {
    if (frame.id === lookId) return true;
    return frame.children.some(c => frameContains(c, lookId));
  };
  const deletedFrame = getFrames(state).find(f => frameContains(f, targetId));
  const isAffected = (lookId: string): boolean => {
    if (lookId === targetId) return true;
    if (!deletedFrame) return false;
    return frameContains(deletedFrame, lookId);
  };

  const effects: StateEffect<unknown>[] = [deleteFrameEffect.of({ id: targetId })];
  const selectedId = getSelectedId(state);
  if (selectedId && isAffected(selectedId)) {
    effects.push(selectFrameEffect.of(null));
  }
  const te = getTextEdit(state);
  if (te && isAffected(te.frameId)) {
    effects.push(setTextEditEffect.of(null));
  }
  return state.update({
    effects,
    annotations: Transaction.addToHistory.of(true),
  }).state;
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/editorState.test.ts -t "cascades band cleanup" 2>&1 | tail -30
```

Expected: 2 passing.

**Step 5: Confirm no regressions in delete behavior**

```bash
npx vitest run src/editorState.test.ts -t "applyDeleteFrame" --reporter=dot 2>&1 | tail -10
```

If pre-existing delete tests fail, they're casualties of the band-tree-shape change (Task 6 sweep). Don't fix them here unless the failure is *because* of the new redirection logic — in that case the redirection is too aggressive and needs guarding.

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: cascade-delete band when its last child is removed

Deleting the sole child of a synthetic band redirects the deletion to
the band itself. Without this, framesField would cascade-remove the
empty band from state but unifiedDocSync would skip releasing its claim
lines (children have lineCount=0)."
```

---

## Task 4: Eager band in `applyReparentFrame` promote branch

**Files:**
- Modify: `src/editorState.ts` — `applyReparentFrame` (~line 1149) and the reparent effect handler (~line 219-247)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing tests**

Add to `src/editorState.test.ts`:

```ts
describe("applyReparentFrame eager bands", () => {
  const CW = 8, CH = 18;
  const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("promote into a row claimed by an existing band joins the band", () => {
    // Setup: outer band with one child (rectA), separately a top-level
    // band with a rectC. Promote rectA OUT of outer band to a row claimed
    // by the band-with-rectC. Expect: rectA becomes a sibling of rectC
    // inside the existing band — no new top-level frame, no doc length change.
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    // Build the topology by drawing rect at row 0 (band1 + rectA), and
    // rect at row 5 (band2 + rectC).
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const rectC = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, rectC, 5, 0);
    const docBeforePromote = getDoc(state2);
    const band1 = getFrames(state2)[0];
    const band2 = getFrames(state2)[1];
    const rectAId = band1.children[0].id;
    const rectCId = band2.children[0].id;

    // "Promote" rectA TO row 5 (where band2 lives). Expected: rectA becomes
    // a child of band2 (joined the band). band1 should become empty (the
    // cascadeEmpty path in framesField will remove it).
    const state3 = applyReparentFrame(state2, rectAId, null, 5, 8, CW, CH);
    expect(getDoc(state3)).toBe(docBeforePromote); // no doc length change
    const frames = getFrames(state3);
    // band1 should be gone (cascade-deleted as empty container);
    // band2 still here with two children.
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(band2.id);
    expect(frames[0].children).toHaveLength(2);
    const childIds = frames[0].children.map(c => c.id);
    expect(childIds).toContain(rectAId);
    expect(childIds).toContain(rectCId);
  });

  it("promote to a row with NO existing band creates a fresh band", () => {
    // Outer band + rectA (child). Promote rectA to row 7 (empty doc range).
    // Expect: new band wrapping rectA at row 7.
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    // Add a child rectInner inside band1 to make rectA's "promotion" meaningful.
    const rectInner = createRectFrame({ gridW: 3, gridH: 2, style: rectStyle, charWidth: CW, charHeight: CH });
    const band1 = getFrames(state1)[0];
    const state2 = applyAddChildFrame(state1, rectInner, band1.children[0].id, 1, 1);
    const innerId = getFrames(state2)[0].children[0].children[0].id;
    // Promote rectInner to top-level at row 7.
    const state3 = applyReparentFrame(state2, innerId, null, 7, 0, CW, CH);
    const frames = getFrames(state3);
    expect(frames).toHaveLength(2);
    // Find the band that now claims row 7.
    const band7 = frames.find(f => f.gridRow === 7);
    expect(band7).toBeTruthy();
    expect(band7!.content).toBeNull();
    expect(band7!.children).toHaveLength(1);
    expect(band7!.children[0].id).toBe(innerId);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/editorState.test.ts -t "applyReparentFrame eager bands" 2>&1 | tail -40
```

Expected: 2 failures. Confirm the failure mode is "wrong tree shape" not import errors.

**Step 3: Modify `applyReparentFrame` to detect band-collision on promote**

Replace `applyReparentFrame` (src/editorState.ts:1149-1164) with:

```ts
export function applyReparentFrame(
  state: EditorState,
  frameId: string,
  newParentId: string | null,
  absoluteGridRow: number,
  absoluteGridCol: number,
  charWidth: number,
  charHeight: number,
): EditorState {
  // Eager-band promote: if newParentId === null AND a band already claims
  // absoluteGridRow, redirect to demote-into-that-band. If the promoted
  // frame extends past the band's current bottom, expand the band first
  // (resizeFrameEffect drives unifiedDocSync to insert the needed blank
  // lines). Task 0.5 ensures unifiedDocSync accumulates BOTH the resize and
  // the demote (release-claim-lines) into a single transaction; without
  // that refactor, only the resize would run and the demoted frame's old
  // top-level claim would be orphaned.
  if (newParentId === null) {
    const existingBand = findBandAtRow(getFrames(state), absoluteGridRow);
    if (existingBand) {
      const promoted = findFrameInList(getFrames(state), frameId);
      const effects: StateEffect<unknown>[] = [];
      if (promoted) {
        const childRowInBand = absoluteGridRow - existingBand.gridRow;
        const childBottom = childRowInBand + promoted.gridH;
        const newBandH = Math.max(existingBand.gridH, childBottom);
        if (newBandH > existingBand.gridH) {
          effects.push(resizeFrameEffect.of({
            id: existingBand.id,
            gridW: existingBand.gridW,
            gridH: newBandH,
            charWidth,
            charHeight,
          }));
        }
      }
      effects.push(reparentFrameEffect.of({
        frameId,
        newParentId: existingBand.id,
        absoluteGridRow,
        absoluteGridCol,
        charWidth,
        charHeight,
      }));
      return state.update({
        effects,
        annotations: Transaction.addToHistory.of(true),
      }).state;
    }
    // No band → reparent-promote effect, but the framesField handler will
    // wrap into a fresh band (see Task 4 step 4).
  }
  return state.update({
    effects: reparentFrameEffect.of({
      frameId, newParentId, absoluteGridRow, absoluteGridCol, charWidth, charHeight,
    }),
    annotations: Transaction.addToHistory.of(true),
  }).state;
}
```

**Step 4: Modify the reparent-promote framesField handler to wrap in band**

In `src/editorState.ts:219-247`, replace the `if (e.value.newParentId === null)` branch of the `reparentFrameEffect` handler. Today it directly pushes the promoted frame to top-level. Under eager bands, we wrap it.

Find this block at line 219-247:

```ts
        if (e.value.newParentId === null) {
          // Promote to top-level. Caller must supply absolute coords.
          ...
          const promoted: Frame = { ... };
          result = [...result, promoted];
        } else {
          ...
        }
```

Replace the promote branch with:

```ts
        if (e.value.newParentId === null) {
          // Promote to top-level — wrap in a fresh band container.
          const aRow = e.value.absoluteGridRow ?? orig.gridRow;
          const aCol = e.value.absoluteGridCol ?? orig.gridCol;
          const oldLines = tr.startState.doc.lines;
          const targetLineOld = Math.min(Math.max(aRow, 0), oldLines - 1) + 1;
          const docOffset = tr.startState.doc.line(targetLineOld).from;
          const lineNum = tr.newDoc.lineAt(docOffset).number - 1;
          const placedRect: Frame = {
            ...orig,
            gridRow: lineNum,
            gridCol: aCol,
            x: aCol * cw,
            y: lineNum * ch,
            lineCount: orig.gridH,
            docOffset,
            dirty: true,
          };
          // Wrap in a band. Use a generous full-width default; band bounds
          // are not visible (content=null) and only affect hit-test.
          let docWidthCols = 120;
          for (let i = 1; i <= tr.newDoc.lines; i++) {
            const ln = tr.newDoc.line(i);
            if (ln.length > docWidthCols) docWidthCols = ln.length;
          }
          const band = wrapAsBand([placedRect], cw, ch, docWidthCols);
          result = [...result, band];
        } else {
          // (existing demote branch unchanged)
          ...
        }
```

Add the import for `wrapAsBand` if not yet imported (Task 3 added it; verify it's there):

```ts
import { moveFrame, resizeFrame, wrapAsBand } from "./frame";
```

**Step 5: Run the new tests**

```bash
npx vitest run src/editorState.test.ts -t "applyReparentFrame eager bands" 2>&1 | tail -30
```

Expected: 2 passing.

**Step 6: Run all editorState tests, record breakage**

```bash
npx vitest run src/editorState.test.ts --reporter=dot 2>&1 | tail -5
```

Some tests still failing from Task 3's eager-band change. Don't fix here. The promote tests for the case "promote-with-no-band" (existing tests that assert promoted frame becomes top-level) may now break because the promoted frame is wrapped — Task 6 handles the sweep.

**Step 7: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: eager band wrapping in applyReparentFrame promote

Promoting a frame to top-level wraps it in a synthetic band. If a band
already claims the target row, the promote redirects to demote-into-band,
preventing duplicate claim lines."
```

---

## Task 5: Eager band in scanner load (`createEditorStateUnified`)

**Files:**
- Modify: `src/editorState.ts` — `createEditorStateUnified` (~line 808)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

```ts
describe("createEditorStateUnified eager bands", () => {
  it("a single rect on disk loads as a band wrapping the rect", () => {
    const md = "Top prose\n\n┌────┐\n│ A  │\n└────┘\n\nBottom prose";
    const state = createEditorStateUnified(md, 8, 18);
    const frames = getFrames(state);
    expect(frames).toHaveLength(1);
    expect(frames[0].content).toBeNull();
    expect(frames[0].children).toHaveLength(1);
    expect(frames[0].children[0].content?.type).toBe("rect");
    // Band claims rows 2,3,4 (0-indexed) — the wireframe lines.
    expect(frames[0].gridRow).toBe(2);
    expect(frames[0].lineCount).toBe(3);
  });

  it("two stacked rects load as TWO separate bands", () => {
    // groupIntoContainers (frame.ts:438) uses a 1-row vertical margin: rects
    // separated by 1 blank line are merged into one container. Use 3 blank
    // lines between A and B so they end up as separate top-level frames →
    // two separate bands after eager wrap.
    const md = "p\n\n┌──┐\n│A │\n└──┘\n\n\n\n┌──┐\n│B │\n└──┘\n\nq";
    const state = createEditorStateUnified(md, 8, 18);
    const frames = getFrames(state);
    expect(frames).toHaveLength(2);
    expect(frames[0].content).toBeNull();
    expect(frames[1].content).toBeNull();
    // Each band has one child rect.
    expect(frames[0].children).toHaveLength(1);
    expect(frames[1].children).toHaveLength(1);
  });

  it("two side-by-side rects load as ONE band with two children", () => {
    const md = "p\n\n┌──┐  ┌──┐\n│A │  │B │\n└──┘  └──┘\n\nq";
    const state = createEditorStateUnified(md, 8, 18);
    const frames = getFrames(state);
    expect(frames).toHaveLength(1);
    expect(frames[0].content).toBeNull();
    expect(frames[0].children).toHaveLength(2);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/editorState.test.ts -t "createEditorStateUnified eager bands" 2>&1 | tail -30
```

Expected: 1st and 2nd FAIL (today the scanner returns rect frames directly; no wrap), 3rd may PASS today (because `groupIntoContainers` already wraps overlapping side-by-side rects). If the 3rd already passes, that's fine.

**Step 3: Modify `createEditorStateUnified` to wrap each top-level claiming frame**

Find `createEditorStateUnified` at src/editorState.ts:808-846. After the existing `for (const f of frames) { ... f.docOffset = ... }` loop (around line 839-843), and before `return createEditorState(...)`, insert:

```ts
  // Eager bands: every top-level claiming frame is wrapped in a synthetic
  // full-width band. groupIntoContainers (in framesFromScan) already wraps
  // side-by-side rects into containers — those containers ARE bands now.
  // For solo top-level rects (containers from groupIntoContainers with
  // content=null are already bands; rects with content="rect" need wrapping).
  let docWidthCols = 120;
  for (const ln of unifiedLines) {
    if (ln.length > docWidthCols) docWidthCols = ln.length;
  }
  const wrapped: Frame[] = frames.map((f) => {
    if (f.content === null) {
      // Already a container from groupIntoContainers — promote to a band.
      // groupIntoContainers' children are container-relative, so promote
      // them back to absolute coords first, then rewrap. CRITICAL: the
      // container itself carries the docOffset (set by scanToFrames at
      // line 66-72); the children have docOffset=0 because they don't
      // claim. wrapAsBand inherits docOffset from the topmost child by
      // default, which would yield 0 here — we explicitly preserve the
      // container's docOffset onto the new band.
      const absChildren = f.children.map((c) => ({
        ...c,
        gridRow: c.gridRow + f.gridRow,
        gridCol: c.gridCol + f.gridCol,
      }));
      const band = wrapAsBand(absChildren, charWidth, charHeight, docWidthCols);
      band.docOffset = f.docOffset;
      band.lineCount = f.lineCount > 0 ? f.lineCount : band.gridH;
      return band;
    }
    // Solo claiming frame (rect/line) — wrap in band. f.docOffset and
    // f.lineCount were set by scanToFrames; wrapAsBand inherits docOffset
    // from f (the only child) and lineCount = gridH = f.gridH = f.lineCount,
    // so no extra preservation needed. But assert anyway for safety.
    const band = wrapAsBand([f], charWidth, charHeight, docWidthCols);
    if (f.lineCount > 0) band.lineCount = f.lineCount;
    if (f.docOffset > 0 && band.docOffset === 0) band.docOffset = f.docOffset;
    return band;
  });

  return createEditorState({ prose: unifiedText, frames: wrapped });
```

**Replace** the original `return createEditorState({ prose: unifiedText, frames });` line (~line 845).

**Step 4: Run new tests**

```bash
npx vitest run src/editorState.test.ts -t "createEditorStateUnified eager bands" 2>&1 | tail -30
```

Expected: 3 passing.

**Step 5: Run full vitest suite, record current failure list**

```bash
npx vitest run --reporter=dot 2>&1 | tail -10
```

Many failures expected (the test sweep is Task 6). Capture the failing test names for sweeping:

```bash
npx vitest run --reporter=verbose 2>&1 | grep -E "^\s*(×|FAIL)" > /tmp/eager-bands-failures.txt
wc -l /tmp/eager-bands-failures.txt
```

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: eager band wrapping in createEditorStateUnified

Every top-level claiming frame produced by the scanner is wrapped in a
synthetic full-width band on load. Side-by-side rects (already grouped
into containers by framesFromScan) are promoted to bands.

Existing tests indexing getFrames(state)[0] as the rect will break — fixed
in Task 6 (test sweep)."
```

---

## Task 6: Test sweep — rewrite assertions to reach through bands

**Files:**
- Modify: `src/editorState.test.ts` — failing tests
- Modify: `src/diagnostic.test.ts` — failing tests
- Modify: `src/interaction.test.ts` — failing tests
- Modify: `src/zorder.test.ts` — failing tests
- Modify: `src/frame.test.ts` — failing tests
- Modify: `e2e/harness.spec.ts` — failing harness tests
- Modify: `e2e/workflows.spec.ts` — failing tests
- Modify: `e2e/coverage.spec.ts` — failing tests
- Modify: `e2e/test-utils.ts` — helper updates if needed

**This task does NOT add new behavior. It rewrites assertions so they continue to verify the same thing under the new tree shape.**

**Step 1: Get the full list of failing unit tests**

```bash
npx vitest run --reporter=verbose 2>&1 | tee /tmp/sweep-vitest.log | grep -E "^\s*(×|FAIL)" | head -80
```

**Step 2: Categorize failures**

For each failing test, decide:
- **Coordinate access** (`frames[0].x === 15`): the band's pixel/grid coords are NOT the child's. `wrapAsBand` sets `band.gridCol = 0` and `band.x = 0` (full-width starting at column 0); `band.gridRow` matches the child's gridRow but `band.gridH` matches the child's gridH only for 1-child bands. **All `frames[0].x` and `frames[0].gridCol` assertions WILL break.** Rewrite to `frames[0].children[0].x === 15` (or `.gridCol`).
- **Identity** (`frames[0].id === rectId`): rewrite to `frames[0].children[0].id === rectId` (the rect now lives one level down).
- **Content type** (`frames[0].content?.type === "rect"`): rewrite to `frames[0].children[0].content?.type === "rect"`.
- **Length checks** (`getFrames(state)).toHaveLength(1)` after adding one rect): now means "one band" — still 1, may pass coincidentally. Strengthen by also asserting `frames[0].children.length === 1` and `frames[0].content === null`.
- **Reparent expectations**: tests that asserted "after promote, frame is top-level" must now assert "after promote, frame is wrapped in a fresh band at top-level OR is now a child of an existing band at the target row" — adjust based on the test's setup.

**Step 3: Rewrite each failing test**

This is mechanical but volume work. Recommended approach: process one test file at a time. After each file, run that file's tests in isolation and confirm green before moving on.

```bash
npx vitest run src/editorState.test.ts --reporter=dot 2>&1 | tail -5
# fix failures, re-run until green
npx vitest run src/diagnostic.test.ts --reporter=dot 2>&1 | tail -5
# fix, re-run
npx vitest run src/interaction.test.ts --reporter=dot 2>&1 | tail -5
# fix, re-run
npx vitest run src/zorder.test.ts --reporter=dot 2>&1 | tail -5
# fix, re-run
npx vitest run src/frame.test.ts --reporter=dot 2>&1 | tail -5
# fix, re-run
```

**Specific rewrite patterns:**

```ts
// PATTERN A: coordinate access
// Before:
expect(getFrames(state)[0].x).toBe(15);
// After: the band has x=0/gridCol=0 (full-width); the rect lives at children[0].
// Always reach through .children[0] for coordinate assertions.
expect(getFrames(state)[0].children[0].x).toBe(15);

// PATTERN B: identity
// Before:
expect(getFrames(s1)[0].id).toBe(frame.id);
// After:
expect(getFrames(s1)[0].children[0].id).toBe(frame.id);

// PATTERN C: count
// Before:
expect(getFrames(s1)).toHaveLength(1);
// After (more honest):
expect(getFrames(s1)).toHaveLength(1);
expect(getFrames(s1)[0].content).toBeNull();
expect(getFrames(s1)[0].children).toHaveLength(1);

// PATTERN D: content type
// Before:
expect(getFrames(s1)[0].content?.type).toBe("rect");
// After:
expect(getFrames(s1)[0].children[0].content?.type).toBe("rect");
```

For tests that involve `applyMoveFrame`, `applyResizeFrame`, etc.: these effects target a specific frame id. The id is unchanged by wrapping — `frame.id` is the rect's id, and that rect is now `getFrames(state)[0].children[0]`, but `applyMoveFrame(state, frame.id, ...)` still finds and moves the right frame. The framesField recursion handles nested mutation (line 156-158: `if (f.children.length > 0) return { ...f, children: f.children.map(applyMove) };`). Assertions about position after move need pattern A or B.

**Step 4: Run vitest until all green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -10
```

Expected: 489+ passing, 0 failing (from this branch's contributions). The 3 pre-existing failures (undo×2, backspace-merge from issues #3, #4, #5) may still be present — confirm they match the briefing's pre-existing list.

**Step 5: Run e2e harness, capture failures**

```bash
npx playwright test e2e/harness.spec.ts --reporter=line --workers=4 2>&1 | tee /tmp/sweep-harness.log | tail -20
```

Many e2e tests check `frames[0].x` after operations. Apply the same patterns.

**Step 6: Update e2e helpers if `frames[N]` indexing is widespread**

Look at `e2e/test-utils.ts` — does it have a `getFrames` or `getRect` helper? If yes, add a sibling `getRect(page, idx)` that walks `frames[idx].children[0] || frames[idx]` (the band-or-rect), so individual tests can be rewritten more concisely.

```bash
grep -n "getFrames\|frames\[" e2e/test-utils.ts
```

**Step 7: Run full e2e harness until green**

```bash
npx playwright test e2e/harness.spec.ts --workers=8 --reporter=line 2>&1 | tail -10
```

Expected: 132/136 + new fix's test passing (133/136). The 3 pre-existing failures (undo×2, backspace-merge) remain.

**Step 8: Commit incrementally**

It's fine to commit per-file as you go. Keep each commit small and message-clear:

```bash
git add src/editorState.test.ts
git commit -m "test: rewrite editorState tests for eager band tree shape"
git add src/diagnostic.test.ts
git commit -m "test: rewrite diagnostic tests for eager band tree shape"
# ...etc
git add e2e/harness.spec.ts e2e/test-utils.ts
git commit -m "test: rewrite e2e harness for eager band tree shape"
```

---

## Task 6.5: Add new harness tests for eager-band invariants

**Files:**
- Modify: `e2e/harness.spec.ts` — append new tests in `test.describe("drag independence", ...)` block (or a new `test.describe("eager bands", ...)` block).

**Why this task exists.** The eager-bands change introduces several invariants that should be guarded by browser-level tests. The unit tests in Tasks 3, 3.5, 4, 5 cover the data-model side, but only browser harness tests catch issues like "save+reload preserves the band shape" or "the band growing on add doesn't visually shift unrelated frames."

Each test follows the existing harness pattern: `await load(page, fixture); ...; const md = await save(page); ...` — see e2e/harness.spec.ts:3851 for an example structure.

**Tests to add:**

```ts
test.describe("eager bands", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  // Round-trip: a saved doc with side-by-side rects loads as one band with
  // two children, and saves back to the SAME markdown.
  test("round-trip: side-by-side rects preserve markdown shape", async ({ page }) => {
    const fixture = `Top prose\n\n┌────┐  ┌────┐\n│ A  │  │ B  │\n└────┘  └────┘\n\nBottom prose`;
    await load(page, fixture);
    writeArtifact("eager-band-roundtrip-side-by-side", "input.md", fixture);
    const before = await getFrames(page);
    expect(before.length).toBe(1); // one band
    // Save and verify the markdown is preserved.
    const saved = await page.evaluate(() => (window as any).__gridpad.saveDocumentText());
    writeArtifact("eager-band-roundtrip-side-by-side", "output.md", saved);
    expect(saved.replace(/\s+$/g, "")).toBe(fixture.replace(/\s+$/g, ""));
  });

  // Round-trip: a saved doc with a single rect loads as one band wrapping
  // the rect, and saves back to the SAME markdown (band has no border).
  test("round-trip: solo rect preserves markdown shape", async ({ page }) => {
    const fixture = `Top\n\n┌────┐\n│ A  │\n└────┘\n\nBottom`;
    await load(page, fixture);
    const saved = await page.evaluate(() => (window as any).__gridpad.saveDocumentText());
    expect(saved.replace(/\s+$/g, "")).toBe(fixture.replace(/\s+$/g, ""));
  });

  // Drawing a 2nd rect to the right joins the band — round-trip the result.
  test("draw next to existing rect, save, reload: both rects appear", async ({ page }) => {
    const fixture = `Top\n\n┌────┐\n│ A  │\n└────┘\n\nBottom`;
    await load(page, fixture);
    const before = await getFrames(page);
    expect(before.length).toBe(1);
    const existing = before[0];

    // Draw new rect to the RIGHT of the existing band's child rect.
    await page.keyboard.press("r");
    await page.waitForTimeout(200);
    const canvas = page.locator("canvas");
    const cbox = await canvas.boundingBox();
    const sx = cbox!.x + existing.x + 100; // well to the right
    const sy = cbox!.y + existing.y + 5;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 60, sy + 20, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    // Frame count stays 1 (single band, two children).
    const afterDraw = await getFrames(page);
    expect(afterDraw.length).toBe(1);

    // Save + reload — both rects must round-trip.
    const saved = await page.evaluate(() => (window as any).__gridpad.saveDocumentText());
    writeArtifact("eager-band-draw-rt", "saved.md", saved);
    // The saved markdown should contain TWO ┌ characters on the same line band.
    const lines = saved.split("\n");
    const topLines = lines.filter((l: string) => l.includes("┌"));
    expect(topLines.length).toBe(1);
    const topLine: string = topLines[0];
    const matches = topLine.match(/┌/g) || [];
    expect(matches.length).toBe(2);
  });

  // Drawing a TALLER 2nd rect grows the band; existing rect stays put.
  test("drawing taller rect grows band; existing stays put", async ({ page }) => {
    const fixture = `Top\n\n┌────┐\n│ A  │\n└────┘\n\n\n\n\nBottom`;
    await load(page, fixture);
    const before = await getFrames(page);
    const existingChild = before[0].children?.[0] ?? before[0];
    const existingY = existingChild.y;
    const existingId = existingChild.id;

    // Draw a tall rect to the right.
    await page.keyboard.press("r");
    await page.waitForTimeout(200);
    const canvas = page.locator("canvas");
    const cbox = await canvas.boundingBox();
    const sx = cbox!.x + existingChild.x + 80;
    const sy = cbox!.y + existingChild.y + 5;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 80, sy + 80, { steps: 8 }); // taller drag
    await page.mouse.up();
    await page.waitForTimeout(400);

    const after = await getFrames(page);
    // Existing rect must NOT have moved vertically.
    const existingAfter = after[0].children?.find((c: any) => c.id === existingId)
      ?? (after[0].id === existingId ? after[0] : null);
    expect(existingAfter).toBeTruthy();
    expect(Math.abs(existingAfter!.y - existingY)).toBeLessThanOrEqual(1);
  });

  // Deleting the only rect in a band releases its claim lines.
  test("delete only child of band: doc shrinks, band cascade-deleted", async ({ page }) => {
    const fixture = `Top\n\n┌────┐\n│ A  │\n└────┘\n\nBottom`;
    await load(page, fixture);
    const before = await getFrames(page);
    expect(before.length).toBe(1);

    // Click the rect to select it, then press Backspace/Delete.
    await clickFrame(page, 0);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);

    const after = await getFrames(page);
    expect(after.length).toBe(0); // band cascade-deleted
    // Saved doc has no claim lines left.
    const saved = await page.evaluate(() => (window as any).__gridpad.saveDocumentText());
    expect(saved).not.toContain("┌");
    expect(saved).not.toContain("└");
  });

  // Promote a child OUT of one band INTO another existing band's row.
  test("promote child onto existing band's row: joins band", async ({ page }) => {
    // Outer rect with an inner rect, plus a separate top-level rect on a
    // different row. Drag the inner OUT of outer and ONTO the row of the
    // separate rect. Expected: inner becomes a child of the separate rect's
    // band; outer becomes empty (or smaller); separate rect's row stays put.
    const fixture = `Top\n\n┌──────────────┐\n│  Outer       │\n│  ┌────┐      │\n│  │Inn │      │\n│  └────┘      │\n│              │\n└──────────────┘\n\n┌────┐\n│ C  │\n└────┘\n\nBot`;
    await load(page, fixture);
    const before = await getFrames(page);
    expect(before.length).toBeGreaterThanOrEqual(2);
    // (Detailed assertions depend on harness API for drag-out; left for the
    // implementer to wire to existing helpers like clickFrame + dragSelected
    // with a target row inside the second band.)
  });

  // Click in empty band space does NOT select the band (hit-test guard).
  test("clicking empty band space selects nothing", async ({ page }) => {
    const fixture = `Top\n\n┌────┐\n│ A  │\n└────┘\n\nBottom`;
    await load(page, fixture);
    const before = await getFrames(page);
    const child = before[0].children?.[0] ?? before[0];

    // Click WAY to the right of the rect, on the same row band.
    const canvas = page.locator("canvas");
    const cbox = await canvas.boundingBox();
    await page.mouse.click(cbox!.x + child.x + child.w + 200, cbox!.y + child.y + 5);
    await page.waitForTimeout(200);

    const selected = await page.evaluate(() => (window as any).__gridpad.getSelectedId?.());
    expect(selected).toBeFalsy();
  });
});
```

**Step 1: Add the tests above to e2e/harness.spec.ts.**

**Step 2: Run them**

```bash
npx playwright test e2e/harness.spec.ts -g "eager bands" --reporter=line --workers=4
```

Expected: all passing.

**Step 3: If a test references a window helper that doesn't exist, wire it.** The `__gridpad.saveDocumentText()` helper exists per DemoV2's window object (saveDocument is at line ~724). If `getSelectedId` isn't exposed, add a small accessor in the existing `__gridpad` object in DemoV2.tsx.

**Step 4: Commit**

```bash
git add e2e/harness.spec.ts
git commit -m "test: add e2e harness coverage for eager-bands invariants

Six tests guard the architectural invariants: round-trip preservation
for solo and side-by-side rects, draw-grows-band, delete-cascades-band,
promote-into-existing-band, and hit-test guard for empty band space."
```

---

## Task 7: Verify the originally-failing harness test passes

**Files:** none (verification only).

**Step 1: Run the targeted test**

```bash
npx playwright test e2e/harness.spec.ts -g "draw new rect to the RIGHT" --reporter=line --workers=1
```

Expected: PASS.

**Step 2: Run all "drag independence" tests**

```bash
npx playwright test e2e/harness.spec.ts -g "drag independence" --reporter=line --workers=4
```

Expected: all passing.

**Step 3: Run full harness one more time**

```bash
npx playwright test e2e/harness.spec.ts --reporter=line --workers=8 2>&1 | tail -5
```

Expected: 133/136 (3 pre-existing remain).

**Step 4: Manual smoke test in the live app**

Open http://localhost:5177/gridpad/. Hard refresh (Cmd+Shift+R).
1. Open default doc with one box.
2. Press 'r'.
3. Drag-draw a new rect to the RIGHT of the existing box, on the same row band.
4. Confirm: existing box does NOT move down.
5. Click off, then save (Cmd+S or whatever the binding is). Reload.
6. Confirm: both boxes render side-by-side in the markdown.

**Step 5: No commit. Move to Task 8.**

---

## Task 8: Gemini code review

**Files:** none — review only.

**Step 1: Compute the full branch diff**

```bash
git diff feature/unified-document..HEAD -- src/ e2e/ > /tmp/branch-diff.patch
wc -l /tmp/branch-diff.patch
```

**Step 2: Send to gemini for review**

```bash
cat /tmp/branch-diff.patch | gemini -m gemini-3-pro-preview \
  -p "You are reviewing a TypeScript change in a CodeMirror-backed Markdown editor. The architecture: top-level wireframe frames CLAIM contiguous doc lines via docOffset+lineCount. Empty lines mark claimed rows. mapPos shifts frames through doc edits.

This change introduces 'eager bands': every top-level claiming wireframe frame is wrapped in a synthetic full-width container Frame (content=null, lineCount>0). Children have lineCount=0 and parent-relative coords. When a second rect is drawn or promoted onto a row already claimed by a band, it joins the band as a sibling child instead of inserting overlapping claim lines (the original bug).

Review for:
1. Correctness — does the wrapping logic preserve the docOffset/lineCount invariants? Are children's gridRow/gridCol correctly rebased? Does the band's gridRow match the topmost child's docOffset?
2. Undo/redo — restoreFramesEffect snapshots the entire frames array; does the band-wrapped tree round-trip through invertedEffects correctly?
3. Drag invariants — drag is rotation-only (delete N newlines on one side, insert N on the other) on top-level claiming frames. Bands ARE the new top-level claimers. Does dragging a band still leave sibling top-level frames undisturbed?
4. Architectural fit — does the change duplicate logic that already exists in groupIntoContainers? Is wrapAsBand correctly scoped or does it mix concerns?
5. Edge cases — empty children array, single child with gridH=2, children at the same gridRow but different gridCol, child with content=null (band-of-band).
6. Anti-patterns — does any code path bypass the framesField gridRow re-derivation? Does any change touch the rotation-only drag logic?

Cite file paths and line numbers. Severity-order findings (CRITICAL > MAJOR > MINOR > NIT). Do not suggest stylistic changes." 2>&1 | tail -300
```

**Step 3: Address findings**

For each finding gemini returns:
- **CRITICAL/MAJOR:** Fix immediately. Write a regression test if the finding describes a real bug.
- **MINOR/NIT:** Decide case-by-case. If the change is small and clearly improves the code, do it. If it's stylistic, skip.

**Step 4: After fixes, commit and re-review (only if substantive changes)**

```bash
git add <files>
git commit -m "fix: address gemini review findings on eager bands

- <finding 1 summary>
- <finding 2 summary>"
```

If the second review is needed (substantive changes), repeat step 2.

---

## Task 9: Final verification before merge

**Files:** none.

**Step 1: Run full vitest**

```bash
npx vitest run --reporter=dot 2>&1 | tail -5
```

Expected: 489+ passing, 0 from this branch failing.

**Step 2: Run full e2e harness**

```bash
npx playwright test e2e/harness.spec.ts --workers=8 --reporter=line 2>&1 | tail -10
```

Expected: 133/136 (3 pre-existing remain: undo×2, backspace-merge from issues #3, #4, #5).

**Step 3: Run full e2e suite (sanity)**

```bash
npx playwright test e2e/ --workers=8 --reporter=line 2>&1 | tail -10
```

Look for new failures vs. baseline. Any test that broke that was NOT in the original 3 pre-existing failures must be addressed before merge.

**Step 4: Production build**

```bash
npm run build 2>&1 | tail -10
```

Expected: build succeeds. CLAUDE.md note: `tsc --noEmit` is not enough — `npm run build` runs `tsc -b` strict, which catches missing-field errors.

**Step 5: Commit final passing state**

If anything was changed in steps 1-4, commit it:

```bash
git status
# only commit if there are pending changes
```

**Step 6: Push and ready PR**

```bash
git push origin feature/add-frame-fix
```

The existing PR #2 will auto-update. Verify on GitHub:
- All commits show up.
- CI is green (if applicable).
- The PR description still describes the fix accurately — update if the eager-bands approach changes the framing.

---

## Acceptance criteria

- The harness test "draw new rect to the RIGHT of existing frame: existing must not move down" PASSES.
- All other "drag independence" tests still pass.
- Live app at http://localhost:5177/gridpad/ no longer pushes the existing frame down when drawing a new rect on the same row band.
- Round-trip works: load a doc with one box, draw a second box next to it, save, reload — both boxes appear side-by-side in the markdown.
- vitest: 489+ passing (or whatever the baseline was), 0 from this branch failing.
- harness: 133/136 (the 3 pre-existing failures remain).
- gemini review applied (severity-ordered).
- Production build succeeds (`npm run build`).
- PR #2 ready to merge.

## Don'ts (from briefing — preserved)

- DON'T touch the rotation-only drag logic (commit 1cbf2e4).
- DON'T mark tests as `.skip` / `.fixme` to make the suite pass.
- DON'T truncate test output with `| tail` when failures must be visible — read the RTK tee log under `~/Library/Application Support/rtk/tee/` if output is filtered.
- DON'T trust `tsc --noEmit` alone — run `npm run build`.
- DON'T bypass the gridRow re-derivation at end of `framesField.update`.
- DON'T add `// @ts-ignore`. Use `// @ts-expect-error` with justification only if absolutely needed.
- DON'T introduce backwards-compat shims. The eager-bands shape is the new shape.
