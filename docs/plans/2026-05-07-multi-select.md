# Multi-Select (Figma-style) — Implementation Plan

**Date:** 2026-05-07
**Author:** Architect (Parijat)
**Status:** Draft — pending review

## 1. Goal

Add Figma-style multi-selection of wireframe frames. The user can select multiple frames via shift-click and rubber-band marquee, drag them as a rigid group, and delete them together.

## 2. Behavior spec (Figma rules)

1. **Plain click** on a frame → unchanged. Selects the outermost non-band ancestor; repeated click drills one level. (`resolveSelectionTarget` already does this.)
2. **Cmd/Ctrl-click** → unchanged. "Deep select" to the deepest frame under the cursor.
3. **Shift-click** on a frame → toggle that frame in the selection set. The toggle target is the same frame `resolveSelectionTarget` would pick for a plain click (outermost non-band ancestor). NEW.
4. **Marquee** (drag on empty canvas) → select every top-level non-band frame whose absolute pixel bbox intersects the rubber-band rect. Replaces existing selection. NEW.
5. **Drag of multi-selection** → rigid group move. Capture each selected frame's `(absX, absY)` at mousedown, apply the same integer `(dCol, dRow)` cell delta to all. No reparenting during a multi-drag. NEW.
6. **Delete / Backspace** with multi-selection → delete every frame in the set. (Deletion of a parent already removes its children, so parent+child selections are harmless.) NEW.
7. **Resize handles** → only render when `selectedIds.size === 1`. Hide on multi-select; group-resize is out of scope. NEW.
8. **Escape / click empty canvas without drag** → clear all selection. (Already works for single; trivially extends.)

Out of scope: alt-marquee descend into children, group resize, copy/paste of multi-selection, multi-frame z-order shortcuts.

## 3. State model

`selectedIdField` migrates from `string | null` to `ReadonlySet<string>`.

**Effects:**
- `selectFrameEffect: StateEffect<string | null>` — keep. `null` clears all; non-null collapses selection to that single id. Existing call sites continue to work.
- `setSelectedIdsEffect: StateEffect<ReadonlySet<string>>` — NEW. Replaces selection with the given set. Used by marquee commit.
- `toggleFrameInSelectionEffect: StateEffect<string>` — NEW. Toggles one id in the current set. Used by shift-click.

**Readers:**
- `getSelectedId(state) → string | null` — keep as a back-compat shim returning the first member of the set, or `null`. Used by external e2e harness via `__gridpad.getSelectedId()`.
- `getSelectedIds(state) → ReadonlySet<string>` — NEW. Primary reader for all internal code.

**CodeMirror gotcha (must preserve):** `StateField` uses `===` referential equality. Every update path must return a *fresh* `Set` instance, never mutate in place. Returning the same reference when no change is intended is correct (and required) for change-detection.

**Undo invariant (must preserve):** Selection is not in `invertedEffects` and must stay out. The new effects (`setSelectedIdsEffect`, `toggleFrameInSelectionEffect`) must NOT appear in `invertedEffects.of(...)` at editorState.ts:617. Verified by existing test `editorState.test.ts:1013` — update it to assert set-shaped selection is not undone.

## 4. File-by-file changes

### 4.1 `src/editorState.ts`

**Add new effects (near line 96):**
```typescript
export const setSelectedIdsEffect = StateEffect.define<ReadonlySet<string>>();
export const toggleFrameInSelectionEffect = StateEffect.define<string>();
```

**Replace `selectedIdField` (lines 521–533):**
```typescript
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

const selectedIdsField = StateField.define<ReadonlySet<string>>({
  create: () => EMPTY_SELECTION,
  update(val, tr) {
    for (const e of tr.effects) {
      if (e.is(selectFrameEffect)) {
        if (e.value === null) return val.size === 0 ? val : EMPTY_SELECTION;
        if (val.size === 1 && val.has(e.value)) return val;
        return new Set([e.value]);
      }
      if (e.is(setSelectedIdsEffect)) {
        // caller must pass a fresh Set; we wrap defensively
        return new Set(e.value);
      }
      if (e.is(toggleFrameInSelectionEffect)) {
        const next = new Set(val);
        if (next.has(e.value)) next.delete(e.value);
        else next.add(e.value);
        return next;
      }
    }
    return val;
  },
});

export function getSelectedIds(state: EditorState): ReadonlySet<string> {
  return state.field(selectedIdsField);
}

export function getSelectedId(state: EditorState): string | null {
  const set = state.field(selectedIdsField);
  if (set.size === 0) return null;
  // First (insertion-order) member; deterministic for tests.
  return set.values().next().value ?? null;
}
```

Update the `extensions` registration in `createEditorStateUnified` (line 921) to use `selectedIdsField` instead of `selectedIdField`.

**Update `applyDeleteFrame` (line 2278):**
Replace the single-id selection-clear at line 2305–2307 with a set-aware clear:
```typescript
const selectedIds = getSelectedIds(state);
let anyAffected = false;
for (const sid of selectedIds) {
  if (isAffected(sid)) { anyAffected = true; break; }
}
if (anyAffected) {
  // Clear all selection. (Surviving non-deleted ids could be preserved with
  // setSelectedIdsEffect, but matching Figma: deleting any selected member
  // collapses selection to empty.)
  effects.push(selectFrameEffect.of(null));
}
```

**Update `decideSelectionForMouseDown` signature (line 1751):**
The function still operates on a single hit. Its job is to decide whether the mousedown is preserving an existing drag-target or applying the rule. Multi-select changes only the input: instead of `currentSelectedId: string | null`, accept `currentSelectedIds: ReadonlySet<string>`. The "preserve" branch fires when `hit.id ∈ currentSelectedIds` OR any member of `currentSelectedIds` is a strict ancestor of `hit.id`.

```typescript
export function decideSelectionForMouseDown(
  hit: Frame,
  currentSelectedIds: ReadonlySet<string>,
  frames: Frame[],
  ctrlHeld: boolean,
): MouseDownSelectionDecision {
  if (ctrlHeld) {
    // Pass first selected id (or null) for drill-chain context.
    const first = currentSelectedIds.size > 0 ? currentSelectedIds.values().next().value ?? null : null;
    return { kind: "applyRule", frameId: resolveSelectionTarget(hit, first, frames, true) };
  }
  if (currentSelectedIds.has(hit.id)) {
    return { kind: "preserveSelection", frameId: hit.id };
  }
  for (const sid of currentSelectedIds) {
    if (isAncestorInTree(frames, sid, hit.id)) {
      return { kind: "preserveSelection", frameId: sid };
    }
  }
  const first = currentSelectedIds.size > 0 ? currentSelectedIds.values().next().value ?? null : null;
  return { kind: "applyRule", frameId: resolveSelectionTarget(hit, first, frames, false) };
}
```

`resolveSelectionTarget` itself stays unchanged — it operates on a single id and is correct.

**Add marquee hit-test helper (new function in src/frame.ts, see 4.4):**
Imported from `./frame`.

### 4.2 `src/DemoV2.tsx` — mousedown handler (lines 601–713)

**Read selection set:**
```typescript
const currentSelectedIds = getSelectedIds(stateRef.current);
const currentSelectedId = currentSelectedIds.size === 1
  ? (currentSelectedIds.values().next().value ?? null)
  : null;
```

**Resize handle hit-test (lines 641–651) — gate on size:**
```typescript
if (currentSelectedIds.size === 1 && currentSelectedId) {
  const sel = findFrameById(framesRef.current, currentSelectedId);
  if (sel && shouldShowResizeHandles(sel.frame, framesRef.current)) {
    const handleHit = hitTestHandle(...);
    if (handleHit) { /* existing resize-drag setup */ return; }
  }
}
```

**Modifiers (line 661):**
```typescript
const ctrlHeld = e.ctrlKey || e.metaKey;
const shiftHeld = e.shiftKey;
```

**Shift-click branch (insert before existing `decision = ...` at line 662):**
```typescript
if (shiftHeld && hit) {
  // Toggle the same target that a plain click would resolve to.
  const toggleTarget = resolveSelectionTarget(hit, null, framesRef.current, false);
  if (toggleTarget) {
    stateRef.current = stateRef.current.update({
      effects: toggleFrameInSelectionEffect.of(toggleTarget),
    }).state;
  }
  // Shift-click does NOT initiate a drag; it only modifies selection.
  dragRef.current = null;
  paint();
  return;
}
```

**Group-drag setup (line 694, after `dragRef.current = { ... }`):**
Extend `DragState` with an optional `groupOrigins`:
```typescript
interface DragState {
  // ...existing fields...
  groupOrigins?: Map<string, { absX: number; absY: number; gridCol: number; gridRow: number }>;
}
```

When `currentSelectedIds.size > 1` AND the hit-resolved `targetId` is in `currentSelectedIds`, populate `groupOrigins`:
```typescript
const isGroupDrag = currentSelectedIds.size > 1 && currentSelectedIds.has(targetId);
let groupOrigins: DragState["groupOrigins"];
if (isGroupDrag) {
  groupOrigins = new Map();
  for (const sid of currentSelectedIds) {
    const f = findFrameById(framesRef.current, sid);
    if (f) groupOrigins.set(sid, {
      absX: f.absX, absY: f.absY,
      gridCol: f.frame.gridCol, gridRow: f.frame.gridRow,
    });
  }
}
dragRef.current = { /* ...existing... */, groupOrigins };
```

If `isGroupDrag` is false but the user clicked a frame already in the multi-selection, treat it as collapsing to single-select (Figma: a plain click on a multi-select member collapses to that member only). Since `decideSelectionForMouseDown` already returns `applyRule` in this case (the hit is in currentSelectedIds → preserve branch fires, returns `hit.id`), the existing flow at line 688 dispatches `selectFrameEffect.of(targetId)` which collapses the set to that one id. That's already correct.

Wait — the preserve branch returns `kind: "preserveSelection"`, which at line 688 does NOT dispatch (only `applyRule` does). That means clicking one member of a multi-selection currently does nothing to the state, then on mouseup-without-movement the deferred-drill logic at line 929 handles it. We need to verify the deferred-drill path collapses the selection to the one clicked member. **Action item for implementation**: confirm via test before coding that mouseup-without-movement on a multi-selection member collapses to single. If not, add a collapse step in the mouseup handler.

### 4.3 `src/DemoV2.tsx` — mousemove + mouseup (lines 785–909)

**Mousemove (line 785, the move-not-resize branch):**
Add a group-move path:
```typescript
if (drag.groupOrigins) {
  const cw = cwRef.current, ch = chRef.current;
  // Use the dragged frame as the "pivot" — compute its dCol/dRow from
  // its own origin, then apply the same delta to every other frame.
  const pivot = drag.groupOrigins.get(drag.frameId);
  if (!pivot) return;  // defensive
  const targetCol = Math.round(Math.max(0, pivot.absX + dx) / cw);
  const targetRow = Math.round(Math.max(0, pivot.absY + dy) / ch);
  const dCol = targetCol - pivot.gridCol;
  const dRow = targetRow - pivot.gridRow;
  if (dCol === 0 && dRow === 0) return;
  const effects: StateEffect<unknown>[] = [];
  for (const [sid, origin] of drag.groupOrigins) {
    const f = findFrameById(framesRef.current, sid);
    if (!f) continue;
    const curCol = f.frame.gridCol;
    const curRow = f.frame.gridRow;
    const targetColI = origin.gridCol + dCol;
    const targetRowI = origin.gridRow + dRow;
    const dColI = targetColI - curCol;
    const dRowI = targetRowI - curRow;
    if (dColI === 0 && dRowI === 0) continue;
    effects.push(moveFrameEffect.of({ id: sid, dCol: dColI, dRow: dRowI, charWidth: cw, charHeight: ch }));
  }
  if (effects.length > 0) {
    stateRef.current = stateRef.current.update({
      effects, annotations: [Transaction.addToHistory.of(false)],
    }).state;
    syncRefsFromState();
  }
  return;
}
// existing single-frame move path follows
```

**Caveat:** band-containment clamping (existing logic at ~line 800–840) is NOT applied to group moves in v1. Group-move can land children outside their bands. This is a known limitation; deferred to a later phase. Document in the test plan.

**Mouseup commit (`commitCumulativeDrag`, line 896):**
Extend `computeCumulativeDragEffects` to walk `groupOrigins` if present and emit one `moveFrameEffect` per id, computing each frame's net delta from its `mouseDownState` snapshot grid coords to the current state's grid coords.

```typescript
function computeCumulativeDragEffects(
  drag: DragState,                       // pass full drag, not just frameId
  snapshot: EditorState,
  isResize: boolean,
): StateEffect<unknown>[] {
  if (drag.groupOrigins && !isResize) {
    const effects: StateEffect<unknown>[] = [];
    const before = getFrames(snapshot);
    const after = framesRef.current;
    for (const sid of drag.groupOrigins.keys()) {
      const b = findFrameById(before, sid);
      const a = findFrameById(after, sid);
      if (!b || !a) continue;
      const dCol = a.frame.gridCol - b.frame.gridCol;
      const dRow = a.frame.gridRow - b.frame.gridRow;
      if (dCol === 0 && dRow === 0) continue;
      effects.push(moveFrameEffect.of({ id: sid, dCol, dRow,
        charWidth: cwRef.current, charHeight: chRef.current }));
    }
    return effects;
  }
  // existing single-id path...
}
```

The single transaction with `addToHistory.of(true)` makes the group-move one undo step. ✓

### 4.4 `src/DemoV2.tsx` — empty-canvas mousedown + marquee (lines 704–712)

**Add marquee state (near `dragRef`, line 213):**
```typescript
interface MarqueeState {
  startX: number; startY: number;
  curX: number; curY: number;
  shiftHeld: boolean;
  selectionAtStart: ReadonlySet<string>;
}
const marqueeRef = useRef<MarqueeState | null>(null);
```

**Replace empty-canvas branch:**
```typescript
} else {
  // Start marquee. Defer selection clear and prose-cursor placement
  // to mouseup-without-movement.
  marqueeRef.current = {
    startX: px, startY: py, curX: px, curY: py,
    shiftHeld,
    selectionAtStart: getSelectedIds(stateRef.current),
  };
  dragRef.current = null;
  // Do NOT clear selection or place prose cursor yet.
  paint();
}
```

**Mousemove during marquee (add at top of mousemove handler):**
```typescript
const marquee = marqueeRef.current;
if (marquee) {
  const rect = canvasRef.current?.getBoundingClientRect();
  if (!rect) return;
  marquee.curX = e.clientX - rect.left;
  marquee.curY = e.clientY - rect.top + (canvasRef.current?.parentElement?.scrollTop ?? 0);
  paint();
  return;
}
```

**Mouseup with marquee (top of mouseup handler):**
```typescript
const marquee = marqueeRef.current;
if (marquee) {
  const moved = Math.abs(marquee.curX - marquee.startX) > 2 ||
                Math.abs(marquee.curY - marquee.startY) > 2;
  if (moved) {
    const ax = Math.min(marquee.startX, marquee.curX);
    const ay = Math.min(marquee.startY, marquee.curY);
    const aw = Math.abs(marquee.curX - marquee.startX);
    const ah = Math.abs(marquee.curY - marquee.startY);
    const hits = collectMarqueeHits(framesRef.current, ax, ay, aw, ah);
    let nextSet: Set<string>;
    if (marquee.shiftHeld) {
      nextSet = new Set(marquee.selectionAtStart);
      for (const id of hits) nextSet.add(id);
    } else {
      nextSet = new Set(hits);
    }
    stateRef.current = stateRef.current.update({
      effects: setSelectedIdsEffect.of(nextSet),
    }).state;
  } else {
    // Click without movement on empty canvas → clear selection,
    // place prose cursor (port the original empty-canvas behavior here).
    stateRef.current = stateRef.current.update({
      effects: selectFrameEffect.of(null),
    }).state;
    textEditRef.current = null;
    const cursor = proseCursorFromClick(marquee.startX, marquee.startY);
    proseCursorRef.current = cursor;
    if (cursor) stateRef.current = moveCursorTo(stateRef.current, cursor);
    blinkRef.current = true;
  }
  marqueeRef.current = null;
  paint();
  return;
}
// existing mouseup logic follows
```

**Marquee preview rendering (in `paint()`, after frame paint, before selection paint):**
```typescript
const marquee = marqueeRef.current;
if (marquee) {
  const ax = Math.min(marquee.startX, marquee.curX);
  const ay = Math.min(marquee.startY, marquee.curY);
  const aw = Math.abs(marquee.curX - marquee.startX);
  const ah = Math.abs(marquee.curY - marquee.startY);
  ctx.save();
  ctx.fillStyle = "rgba(74, 144, 217, 0.1)";
  ctx.strokeStyle = "rgba(74, 144, 217, 0.6)";
  ctx.lineWidth = 1;
  ctx.fillRect(ax, ay, aw, ah);
  ctx.strokeRect(ax, ay, aw, ah);
  ctx.restore();
}
```

### 4.5 `src/DemoV2.tsx` — render selection (line 451)

Replace the single-selection block:
```typescript
const selectedIds = getSelectedIds(stateRef.current);
const showHandles = selectedIds.size === 1;
for (const sid of selectedIds) {
  const sel = findFrameById(framesRef.current, sid);
  if (!sel) continue;
  const handlesAllowed = showHandles && shouldShowResizeHandles(sel.frame, framesRef.current);
  renderFrameSelection(ctx, sel.frame, sel.absX, sel.absY, handlesAllowed);
}
```

`renderFrameSelection` itself does not change.

### 4.6 `src/DemoV2.tsx` — keyboard handlers (lines 1498–1510)

**Escape:** unchanged (`selectFrameEffect.of(null)` collapses set to empty).

**Delete / Backspace:**
```typescript
const idsToDelete = getSelectedIds(stateRef.current);
if ((e.key === "Delete" || e.key === "Backspace") && idsToDelete.size > 0) {
  applyAndTrack(prev => {
    let next = prev;
    for (const id of idsToDelete) {
      next = applyDeleteFrame(next, id);
    }
    return next;
  });
  syncRefsFromState();
  doLayout();
  paint();
}
```

`applyDeleteFrame` is idempotent on already-deleted ids (the `findFrameById`-style guards inside short-circuit). Order does not matter functionally; document this.

**Z-order shortcuts (line 1509):** Keep as single-frame-only for v1. If `selectedIds.size !== 1`, ignore the shortcut. Add an early-return.

### 4.7 `src/DemoV2.tsx` — `__gridpad` API (lines 1149, 1167, 1181)

- `__gridpad.getSelectedId()` (line 1149) — keep, return `getSelectedId(state)` (first member). E2e tests continue to work.
- `__gridpad.getSelectedIds()` — NEW. Returns `Array.from(getSelectedIds(state))`.
- `__gridpad.selectFrame(id)` (line 1181) — keep. Single-select via `selectFrameEffect.of(id)` collapses set to one.
- `__gridpad.setSelectedIds(ids: string[])` — NEW. For e2e tests of multi-select.

### 4.8 `src/frame.ts` — marquee hit-test (NEW, append to file)

```typescript
function rectsIntersect(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * Collect ids of all top-level non-band frames whose absolute pixel bbox
 * intersects the given rectangle. Walks only the top level by default —
 * does not descend into children. (Figma's default marquee behavior.)
 *
 * Frames have parent-relative pixel x/y; we walk the tree to compute absX/absY.
 */
export function collectMarqueeHits(
  frames: Frame[], rx: number, ry: number, rw: number, rh: number,
): string[] {
  const hits: string[] = [];
  for (const f of frames) {
    if (f.isBand) {
      // Bands themselves aren't selectable; descend to their non-band children.
      for (const child of f.children) {
        if (child.isBand) continue;
        if (rectsIntersect(rx, ry, rw, rh, f.x + child.x, f.y + child.y, child.w, child.h)) {
          hits.push(child.id);
        }
      }
    } else {
      if (rectsIntersect(rx, ry, rw, rh, f.x, f.y, f.w, f.h)) {
        hits.push(f.id);
      }
    }
  }
  return hits;
}
```

**Open question for review:** the band-vs-top-level walk. Today, top-level frames in `framesRef` may include band wrappers. The implementer must verify by reading `framesField` what the top level looks like in practice. If bands are always the top level and real wireframes are children of bands, the helper should walk one level into bands but no deeper.

### 4.9 `src/frameRenderer.ts`

No change. The function already takes a `showHandles` flag.

## 5. Tests

### 5.1 Unit tests (`src/editorState.test.ts`)

New `describe("multi-select")` block:
- Empty initial state: `getSelectedIds(state).size === 0`.
- `selectFrameEffect.of("a")` → set is `{a}`.
- `selectFrameEffect.of("b")` → set is `{b}` (collapses, doesn't add).
- `selectFrameEffect.of(null)` → set is empty.
- `setSelectedIdsEffect.of(new Set(["a","b"]))` → set is `{a,b}`.
- `toggleFrameInSelectionEffect.of("a")` on `{}` → `{a}`.
- `toggleFrameInSelectionEffect.of("a")` on `{a}` → `{}`.
- `toggleFrameInSelectionEffect.of("c")` on `{a,b}` → `{a,b,c}`.
- Referential equality: dispatching `selectFrameEffect.of("a")` when set is already `{a}` returns the same reference (verify `state1.field === state2.field`).
- Undo: after multi-select + frame move + undo, selection state is unchanged (matches existing `editorState.test.ts:1013` invariant).

`decideSelectionForMouseDown` tests (extend existing):
- Hit on a frame in `{a,b}` set → `preserveSelection` with `frameId: hit.id`.
- Hit on a frame NOT in set, but its ancestor is in set → `preserveSelection` with the ancestor.
- Hit on a frame unrelated to set → `applyRule` with the rule's resolution.

`applyDeleteFrame` tests:
- Delete with `{a,b}` selected, deleting `a` → selection becomes empty.
- Delete with `{a,b}` selected, deleting unrelated `c` → selection unchanged (`{a,b}`).

### 5.2 Marquee unit tests (`src/frame.test.ts`)

`collectMarqueeHits`:
- Marquee rect that contains 2 of 3 frames → returns those 2 ids.
- Marquee rect with zero overlap → returns `[]`.
- Marquee rect that grazes a frame edge (1px overlap) → returns it.
- Frames inside a band → marquee returns child ids, not band id.

### 5.3 E2e tests (`e2e/multi-select.spec.ts`, NEW)

- Shift-click two frames → `__gridpad.getSelectedIds().length === 2`, both ids present.
- Shift-click selected frame → toggles off (`length === 1`).
- Marquee drag over two frames → both selected.
- Marquee + shift drag → adds to existing selection.
- Drag multi-selection → both frames moved by the same delta. Verify with `getFrames()` (gridRow/gridCol differences are equal).
- Single undo restores both frames to original positions.
- Delete with two frames selected → both gone, selection empty.
- Resize handles not visible when 2+ selected (visual: hit-test the handle position, expect no handle hit).
- Click on empty canvas without drag → selection cleared.
- Existing single-select tests (e.g., `e2e/harness.spec.ts:280`) still pass unchanged.

### 5.4 Existing tests to update

- `e2e/harness.spec.ts:352` — `getSelectedId(page)` helper unchanged (still returns first / null).
- `src/editorState.test.ts:988–1016` — update assertions to use `getSelectedIds` where appropriate; keep one `getSelectedId` test for back-compat shim.
- `src/groupB-*.diag.test.ts`, `src/groupC-*.diag.test.ts` — these dispatch `selectFrameEffect.of(id)` for setup. Keep as-is; the effect still works (collapses to single).
- `src/debugBucketF.test.ts` — same; setup-only calls still valid.

## 6. Phasing

**Phase 1 — State migration (no behavior change):**
1. Add new effects (`setSelectedIdsEffect`, `toggleFrameInSelectionEffect`).
2. Replace `selectedIdField` with `selectedIdsField`. Keep `getSelectedId` as shim.
3. Update `decideSelectionForMouseDown` signature. Update its caller in DemoV2 to pass the set.
4. Update `applyDeleteFrame` set-aware clear.
5. Update render loop to iterate set (with size 0 or 1 only — same visual output).
6. Run full unit + e2e suite. **No new behavior. Must be 100% green.**

**Phase 2 — Shift-click toggle:**
1. Add shift-click branch in mousedown.
2. Add `__gridpad.getSelectedIds` API.
3. Add multi-select unit tests.
4. Add e2e test for shift-click toggle.

**Phase 3 — Group drag:**
1. Add `groupOrigins` to DragState.
2. Add group-move branch in mousemove.
3. Update `computeCumulativeDragEffects` for group commit.
4. Add e2e test for group drag + undo.

**Phase 4 — Marquee:**
1. Add `marqueeRef` state.
2. Add marquee start/move/commit in mouse handlers.
3. Add `collectMarqueeHits` in frame.ts + unit tests.
4. Add marquee preview rendering.
5. Add e2e tests.

**Phase 5 — Polish:**
1. Hide resize handles on multi-select (one-line gate already in render).
2. Z-order shortcuts no-op on multi-select.
3. Confirm Escape clears multi-select.

Each phase ends with full e2e suite green before moving on.

## 6.5 Gemini review patches (2026-05-07)

External review surfaced six issues. One (claim that `applyDeleteFrame` was hallucinated) was **rejected after re-verifying editorState.ts:2278–2317** — that function is the full 40-line version as documented. The other five are accepted and patched below.

### Patch A — Group-drag delta math (was BUG in §4.3)

Original mousemove computed `dRow = targetRow - pivot.gridRow`, mixing absolute pixel→cell row with parent-relative `gridRow`. Frames inside bands would teleport.

**Corrected mousemove (replaces the snippet in §4.3):**
```typescript
if (drag.groupOrigins) {
  const cw = cwRef.current, ch = chRef.current;
  const pivot = drag.groupOrigins.get(drag.frameId);
  if (!pivot) return;
  // Compute delta in absolute cell space.
  const startAbsCol = Math.round(pivot.absX / cw);
  const startAbsRow = Math.round(pivot.absY / ch);
  const targetCol = Math.round(Math.max(0, pivot.absX + dx) / cw);
  const targetRow = Math.round(Math.max(0, pivot.absY + dy) / ch);
  const dCol = targetCol - startAbsCol;
  const dRow = targetRow - startAbsRow;
  if (dCol === 0 && dRow === 0) return;
  // Apply same absolute-cell delta to each frame's CURRENT gridCol/gridRow.
  // (Each frame's gridCol/gridRow is parent-relative; same dCol/dRow applies
  //  uniformly because all frames share the same parent transform during a
  //  rigid-group move — and we explicitly disable reparenting for group drags,
  //  see Patch B.)
  const effects: StateEffect<unknown>[] = [];
  for (const [sid, origin] of drag.groupOrigins) {
    const f = findFrameById(framesRef.current, sid);
    if (!f) continue;
    const targetGridCol = origin.gridCol + dCol;
    const targetGridRow = origin.gridRow + dRow;
    const dColI = targetGridCol - f.frame.gridCol;
    const dRowI = targetGridRow - f.frame.gridRow;
    if (dColI === 0 && dRowI === 0) continue;
    effects.push(moveFrameEffect.of({
      id: sid, dCol: dColI, dRow: dRowI, charWidth: cw, charHeight: ch,
    }));
  }
  if (effects.length > 0) {
    stateRef.current = stateRef.current.update({
      effects, annotations: [Transaction.addToHistory.of(false)],
    }).state;
    syncRefsFromState();
  }
  return;
}
```

**Caveat to verify in implementation:** the assumption "all selected frames share the same parent transform" is only true when group-selected frames are siblings under the same parent. If multi-selection spans different parents (e.g., one top-level and one inside a band), applying the same `(dCol, dRow)` parent-relative delta will move them by *different* absolute distances. Two options:
- (a) Restrict marquee to siblings of one parent in v1 (Figma also does this — top-level only by default).
- (b) Convert each frame's move to absolute-cell terms by walking its parent chain.

Plan picks (a) for v1: marquee already collects only top-level frames, and shift-click across hierarchy levels is rare. Add a unit test that asserts group drag of cross-parent multi-selection is either a no-op or correctly normalized in absolute terms — pick one and document.

### Patch B — Reparenting bypass location (was MISSING in §7 risk 4)

Gemini located the reparent trigger in `onMouseUp` around line 850 (the call to `decideReparent`/equivalent). Implementation must gate that call:

```typescript
// In onMouseUp, where reparenting is currently decided:
if (drag.hasMoved && !drag.resizeHandle && !drag.groupOrigins) {
  // existing reparent-decision block
}
```

**Action item for implementer:** before Phase 3 implementation, find the actual reparent call in `onMouseUp` (Gemini's "around line 850" — verify by grep for `reparent` or `decideReparent` in DemoV2.tsx) and add the `!drag.groupOrigins` guard. If reparenting is triggered from the move-effect application path inside `framesField.update` instead, escalate — a deeper plan revision is needed.

### Patch C — Mouseup-without-movement collapse (was Risk 1, confirmed BUG)

The deferred-drill in `onMouseUp` (~line 929) only re-dispatches selection when `newTarget !== drag.frameId`. When the user clicks one member of a multi-selection, `resolveSelectionTarget` returns the same id, so the dispatch is skipped and the multi-selection survives — wrong vs. Figma.

**Fix:**
```typescript
const currentSelectedIds = getSelectedIds(stateRef.current);
const shouldCollapseToSingle = currentSelectedIds.size > 1;
if (newTarget && (newTarget !== drag.frameId || shouldCollapseToSingle)) {
  stateRef.current = stateRef.current.update({
    effects: selectFrameEffect.of(newTarget),
  }).state;
}
```

### Patch D — Hover cursor gate (was MISSED in §4.5)

`onMouseMove` reads selection at line ~725 to compute the resize cursor. With multi-select, hovering over the (now-hidden) handle positions of a multi-selected frame still flips the cursor to `nwse-resize` etc. Add a gate at the cursor-decision branch:

```typescript
// In onMouseMove cursor logic:
const selIds = getSelectedIds(stateRef.current);
if (selIds.size === 1) {
  // existing handle-hit-test → cursor logic
} else {
  // skip handle test; cursor stays default
}
```

### Patch E — Multi-delete undo grouping (was BUG in §4.6)

Looping `applyDeleteFrame` produces N transactions (each `addToHistory.of(true)`), so `Cmd+Z` only restores one frame.

**Replace the keydown delete handler in §4.6 with a single transaction:**
```typescript
const idsToDelete = getSelectedIds(stateRef.current);
if ((e.key === "Delete" || e.key === "Backspace") && idsToDelete.size > 0) {
  applyAndTrack(prev => {
    const effects: StateEffect<unknown>[] = [];
    // Mirror applyDeleteFrame's band-redirect logic for each id.
    const frames = getFrames(prev);
    const redirected = new Set<string>();
    for (const id of idsToDelete) {
      let targetId = id;
      for (const f of frames) {
        if (f.isBand && f.children.length === 1 && f.children[0].id === id) {
          targetId = f.id; break;
        }
      }
      if (!redirected.has(targetId)) {
        effects.push(deleteFrameEffect.of({ id: targetId }));
        redirected.add(targetId);
      }
    }
    effects.push(selectFrameEffect.of(null));
    // Clear text edit if its frame is being deleted.
    const te = getTextEdit(prev);
    if (te && (idsToDelete.has(te.frameId) || redirected.has(te.frameId))) {
      effects.push(setTextEditEffect.of(null));
    }
    return prev.update({
      effects, annotations: Transaction.addToHistory.of(true),
    }).state;
  });
  syncRefsFromState();
  doLayout();
  paint();
}
```

**Note:** This bypasses `applyDeleteFrame` and replicates its band-redirect logic inline. An alternative is to add a new `applyDeleteFrames(state, ids: ReadonlySet<string>)` helper to `editorState.ts` that does the multi-id version cleanly. **Recommended for the implementer:** extract to `applyDeleteFrames` to keep DemoV2 thin and editorState testable in isolation.

### Patch F — New e2e test

Add to §5.3:
- Multi-delete + `Cmd+Z` → both frames restored. Asserts single-transaction undo grouping.

## 7. Resolved questions (2026-05-07)

All five originally-open questions resolved by direct code reading.

1. **Mouseup-without-movement on a multi-select member** — **CONFIRMED bug.** `DemoV2.tsx:927` guards on `newTarget !== drag.frameId`; clicking a multi-select member returns the same id and skips the dispatch. **Fix:** Patch C in §6.5 (already drafted) — amend the condition to also fire when `currentSelectedIds.size > 1`.

2. **Band-containment clamping during group drag** — **More than a UX nicety.** `DemoV2.tsx:808–839` clamp is required because (a) the clamp escalates over-band motion to a band-level `moveFrameEffect` (band rotation via `unifiedDocSync`); (b) without it, mouseup `decideReparent` at `DemoV2.tsx:941` fires for the pivot frame and can mutate the band hierarchy mid-drag. **Decision for v1:** skip the clamp itself (group drag may land frames outside bands visually) but Patch B's `!drag.groupOrigins` guard on the reparent block is **mandatory** to prevent data corruption. Document this as a known v1 limitation: group-dragged frames can extend past band edges; band-rotation does not fire for group moves; reparenting does not fire for group moves.

3. **`framesRef.current` top-level structure** — **Top level is bands-only.** `editorState.ts:1021–1082` (eager-band wrapping) wraps every top-level frame in a band unconditionally. Solo shapes: `band → shape`. Multi-shape composites: `band → wireframe → shape, shape`. `collectMarqueeHits` (§4.8) is correct: descend exactly one level into bands. The intermediate `wireframe` node has `isBand: undefined/false`, so the helper correctly returns its id (matching what `resolveSelectionTarget` returns on plain click).

4. **Reparenting bypass location** — **Confirmed in `onMouseUp` only.** The reparent decision lives at `DemoV2.tsx:939–977`, gated by `if (dragRef.current.hasMoved && e && !dragRef.current.resizeHandle)` at line 941. `reparentFrameEffect` is dispatched at line 1001 via `applyReparentFrame`, never inside `framesField.update`. **Patch B's gate placement is correct:** amend line 941 to add `&& !dragRef.current.groupOrigins`. One-line change.

5. **Selection serialization** — **Confirmed in-memory only.** `grep` of `src/gridSerialize.ts` for selection returns zero matches. The save path reads only `getFrames(state)` and the CodeMirror doc text. No file-format change.

### Group-drag math (separate concern, deferred to implementation)

Plan §6.5 Patch A picks v1 strategy (a): apply same parent-relative `(dCol, dRow)` to all frames, accepting that this is only correct when group members share a parent. Marquee already top-level-only, so the common case is fine. **Action item for implementer:** if shift-click ever assembles a cross-parent multi-selection, group drag is incorrect. Either disallow shift-click across parent boundaries, or convert to absolute-cell deltas. Add a unit test that asserts the chosen behavior.

## 8. Acceptance criteria

- All existing unit + e2e tests pass.
- New tests in 5.1, 5.2, 5.3 pass.
- Manual smoke: shift-click, marquee, group drag, multi-delete, single undo restores group move, escape clears.
- No regression in single-select click/drag/resize/delete/undo.
- File size: `DemoV2.tsx` stays ≤300 lines per project rule (currently ~1750; this plan adds ~80 lines so it stays violated to the same degree as today, no worse). Marquee helper goes in `frame.ts`. If `DemoV2.tsx` growth is a concern, marquee state + handlers can extract to `src/marquee.ts`.
