# Reparent rewrite — single-function apply layer

**Date:** 2026-05-04
**Author:** parijat
**Status:** draft

**Scope fence.** Reparent operations only. `moveFrame`, `resizeFrame`, `addFrame`, text editing, and undo/redo machinery are explicitly out of scope.

**Constraint.** Gridpad's source of truth is a plain-text `.md` file with wireframes pinned to grid rows. Some drag-drops have no valid grid landing (e.g., dropping a wireframe onto a row of prose). The user accepts these as no-ops — refuse the drop and snap the rect back to where per-tick drag put it. The plan does NOT auto-shift prose to make room.

---

## 1. Problem statement

The reparent apply layer (`applyReparentFrame`, the `reparentFrameEffect` handler in `framesField`, and the reparent-related branches in `unifiedDocSync`) splits one logical operation across three files and four conditional branches. The branches behave inconsistently:

- Promote-into-existing-band correctly expands the destination band when the new child won't fit.
- Raw-demote does not expand the destination band — children silently overlap.
- Promote correctly inserts blank rows when the target row is past doc end, but inserts in the wrong place when the target row is occupied prose.

This asymmetry has been patched four times by adding "guard at the door" checks to `decideReparent` (Bugs A, B, C, D — see `DEBUG_PLAN.md`). The guards correctly prevent corruption but the underlying apply-layer code remains brittle: three Group B harness failures (`undo a drag-into-frame reparent`, `promote then drag old parent`, `promote then drag the promoted frame`) describe state desync between the source band's release and the destination's claim — visible because the operation isn't atomic from CodeMirror's perspective.

**Today:** vitest 607/2, harness 139/6 (commit `da839ef`).

**Goal.** Replace the four-branch apply path with one function that takes a validated intent, computes the post-reparent frame tree and the doc edits together, and dispatches one atomic CodeMirror transaction. Keep the existing `decideReparent` guards (correct under the grid-pinned model). Move the promote-into-existing-band redirect into `decideReparent` so the apply layer is fully dumb. Fix the apply-layer brittleness.

**Constraint reframe.** Refusing bad-geometry drops is the design (per the user's grid-pinned-model constraint), so the only bug surface this rewrite targets is **apply-layer atomicity** — making a reparent appear as one transaction so consumers (undo, paint, serialize) never observe inconsistent intermediate state. The guards stay, the geometry semantics stay, only the dispatch shape changes.

---

## 2. Design — one function, no AST

The temptation to model this as a list of typed Steps does not pay off here. ProseMirror needs Steps because they're serialized, network-synced, and rebased across concurrent edits. Gridpad has a single user, single client, no rebase, no network. The Step list collapses to two real shapes (doc-edit + frames-update vs frames-only) and the orchestrator already has full case knowledge — the abstraction adds an indirection layer with no capability gain. It also forces threading a `currentDoc` through step composition, which mixes coordinate spaces in subtle ways that are easy to get wrong.

**Approach:** one pure function returns `{ changes, framesAfter }` or `null`, plus a thin commit wrapper that turns the result into a CodeMirror transaction. No Step types, no `applyStep` loop, no `currentDoc` threading. All `ChangeSpec`s computed against `beforeState.doc`; CodeMirror's `sequential: true` resolves them when the transaction dispatches.

```typescript
type ReparentIntent = {
  draggedId: string;
  newParentId: string | null;        // from decideReparent, AFTER the redirect (see §3)
  aRow: number;
  aCol: number;
  charWidth: number;
  charHeight: number;
};

type ReparentTransition = {
  changes: ChangeSpec[];        // all offsets in beforeState.doc coords
  framesAfter: Frame[];          // all docOffsets in beforeState.doc coords (see §4)
};

// Pure. Reads beforeState; returns null if intent is invalid.
function buildReparentTransition(
  beforeState: EditorState,
  intent: ReparentIntent,
): ReparentTransition | null;

// Thin wrapper. Dispatches the transaction.
function commitReparent(state: EditorState, intent: ReparentIntent): EditorState {
  const t = buildReparentTransition(state, intent);
  if (!t) return state;
  return state.update({
    changes: t.changes,
    effects: setFramesEffect.of(t.framesAfter),
    annotations: Transaction.addToHistory.of(true),
    sequential: true,
  }).state;
}
```

`applyReparentFrame` becomes a one-line wrapper around `commitReparent`. The function bodies (today's `applyReparentFrame:1440-1535` plus the reparent branches in `framesField` and `unifiedDocSync`) collapse into the single `buildReparentTransition` plus its helpers in `src/reparentTransition.ts`. Net code change is approximately neutral; the win is **one apply path instead of four**, not line count.

---

## 3. The promote-into-existing-band redirect moves into `decideReparent`

Today the redirect lives in `applyReparentFrame:1481-1519`: when `newParentId === null` AND a band already claims `absoluteGridRow`, redirect to demote-into-that-band. The plan moves this into `decideReparent` so the call chain is auditable — `decideReparent` returns either `{ kind: "promote" }` or `{ kind: "demote", targetTopLevelId }`, and the apply layer executes verbatim.

**Why centralize.** The plan's premise is that splitting one logical operation across multiple branches/files is the bug. Putting the redirect in the orchestrator preserves that split. Centralizing the decision in `decideReparent` honors the layer split: oracle decides, apply executes.

**Implementation.** `decideReparent` already receives `aRow` via `promoteLanding` (Bug C parameter at `editorState.ts:1916-1924`). Reuse that field; no signature change beyond what already exists:

```typescript
// Inside decideReparent, in the promote branch (after Bug A/C guards pass):
const sourceBand = findContainingBandDeep(frames, draggedId);
const existingBand = findBandAtRow(frames, promoteLanding.aRow);
if (existingBand && existingBand.id !== sourceBand?.id) {
  return { kind: "demote", targetTopLevelId: existingBand.id };
}
return { kind: "promote" };
```

After this change, the apply function (§2) sees only direct intents. No internal redirects.

**Important:** the redirect is bundled with the unified apply path in PR 3 (see §7), NOT shipped as a standalone PR. Shipping the redirect alone would silently drop today's band-expansion logic that today's redirect block at `editorState.ts:1486-1499` performs alongside the redirect itself.

---

## 4. The dual-target commit mechanism

Two targets must stay synchronized: CodeMirror's linear text doc and the in-memory frame tree.

**Single-transaction approach:** `commitReparent` (§2) dispatches one `state.update()` with the merged `ChangeSpec[]` and a `setFramesEffect` carrying the entire post-reparent frame tree.

### `framesField.update` reorder

Today (`editorState.ts:139-200`): `tr.docChanged` mapPos pass FIRST, then effects loop. Required: handle `setFramesEffect` first (replaces `result` with the orchestrator's pre-built tree), then run the unified mapPos pass. The `restoreFramesEffect` early-return must remain in place — undo/redo transactions carry the post-forward snapshot whose docOffsets are already in their final coordinates and must NOT be re-mapped.

```typescript
update(frames, tr) {
  let result = frames;
  // Phase 1: full-tree replacements.
  // restoreFramesEffect early-returns (undo/redo: snapshot is already in final coords).
  // setFramesEffect sets result and falls through to mapPos (framesAfter is in beforeState coords).
  for (const e of tr.effects) {
    if (e.is(restoreFramesEffect)) return e.value;
    if (e.is(setFramesEffect)) { result = e.value; break; }
  }
  // Phase 2: docOffset mapPos. Runs on whatever result is now (frames or setFramesEffect's payload).
  if (tr.docChanged) {
    result = result.map(f =>
      f.lineCount === 0 ? f : { ...f, docOffset: tr.changes.mapPos(f.docOffset, 1) },
    );
  }
  // Phase 3: incremental effects (move/resize/etc.) — must explicitly skip setFramesEffect.
  for (const e of tr.effects) { /* moveFrameEffect, resizeFrameEffect, etc. (else-chain that does NOT match setFramesEffect) */ }
  return result;
}
```

**Why `restoreFramesEffect` early-return is correct for undo AND redo.** `frameInversion` snapshots `tr.startState.field(framesField)` on every transaction with a frame effect. After a forward reparent, the snapshot held by undo carries pre-transaction coords. After undo, the snapshot held by redo carries post-forward coords (which are already final, post-mapPos). Re-running mapPos on either would double-shift. The early-return preserves the invariant that snapshots are stored and replayed in their final coordinate space.

### The docOffset invariant (load-bearing)

**Hard rule:** `framesAfter` returned by `buildReparentTransition` MUST contain `docOffset` values in `beforeState.doc` coordinates only. Phase 2's `mapPos` shifts them all in lockstep with the merged ChangeSet. If any frame's docOffset is in post-edit coordinates, it gets double-shifted.

Concretely:
- For frames the orchestrator did not touch: keep their existing `docOffset` (already in beforeState coords).
- For a band the orchestrator created (promote → wrapAsBand): compute its `docOffset` against `beforeState.doc`. If `intent.aRow + 1 <= beforeState.doc.lines`: `beforeState.doc.line(intent.aRow + 1).from`. If `aRow + 1 > beforeState.doc.lines`: the new band's claim lines are inserted by the same transaction (see "promote doc-edit" below); `docOffset = beforeState.doc.length` and mapPos shifts it forward into the inserted blanks.
- For a band the orchestrator deleted (sourceWillEmpty): not in `framesAfter` at all.
- For a band the orchestrator expanded: `docOffset` unchanged (band still claims same first line).

This invariant is tested directly via matrix cell #14, which reads `framesAfter` from `buildReparentTransition`'s return value (BEFORE dispatch), not from the post-transaction state.

### Doc-edit emission

`buildReparentTransition` emits ChangeSpecs for three cases. All offsets computed against `beforeState.doc`.

**Case 1 — promote needs trailing blanks** (mirrors today's `unifiedDocSync:811-833`). When `intent.newParentId === null`:
```typescript
const targetLine = Math.min(Math.max(intent.aRow, 0), beforeState.doc.lines - 1);
let blankAtTarget = 0;
for (let n = targetLine + 1; n <= beforeState.doc.lines; n++) {
  if (beforeState.doc.line(n).length === 0) blankAtTarget++;
  else break;
}
const needed = Math.max(0, dragged.gridH - blankAtTarget);
if (needed > 0) {
  changes.push({ from: beforeState.doc.line(targetLine + 1).from, insert: '\n'.repeat(needed) });
}
```

The Bug C `proseRows` guard ensures the target rows aren't occupied by prose, but does NOT guarantee they exist. A promote whose `aRow + gridH` extends past doc end is allowed by Bug C (rows past doc end aren't in `proseRows`) and requires this insert.

**Case 2 — demote needs band expansion** (mirrors today's apply-layer redirect at `editorState.ts:1486-1499`). When `requiredBandH > newParent.gridH`:
```typescript
const lineAfterBand = newParent.gridRow + newParent.gridH;  // 0-indexed row past band's bottom
const linesToAdd = requiredBandH - newParent.gridH;
// Compute how many trailing blanks exist after the band's current bottom.
let blankAtBottom = 0;
for (let n = lineAfterBand + 1; n <= beforeState.doc.lines; n++) {
  if (beforeState.doc.line(n).length === 0) blankAtBottom++;
  else break;
}
const needed = Math.max(0, linesToAdd - blankAtBottom);
if (needed > 0) {
  const offset = beforeState.doc.line(Math.min(lineAfterBand + 1, beforeState.doc.lines)).from;
  changes.push({ from: offset, insert: '\n'.repeat(needed) });
}
```

**Case 3 — release claim lines** (mirrors today's `unifiedDocSync:778-794` for `deleteFrameEffect` and `unifiedDocSync:834-846` for top-level-dragged demote). Factored into one helper:

```typescript
function releaseClaimLines(beforeDoc: Text, frame: Frame): ChangeSpec | null {
  if (frame.lineCount === 0) return null;
  const startLine = beforeDoc.lineAt(frame.docOffset);
  const endLineNum = startLine.number + frame.lineCount - 1;
  if (endLineNum > beforeDoc.lines) return null;
  const endLine = beforeDoc.line(endLineNum);
  const docLength = beforeDoc.length;
  const from = startLine.from > 0 ? startLine.from - 1 : 0;
  const to = startLine.from > 0 ? endLine.to : Math.min(endLine.to + 1, docLength);
  return { from, to };
}
```

Call sites:
- When `sourceBand && sourceWillEmpty`: `releaseClaimLines(beforeState.doc, sourceBand)`.
- When demote is dispatched with a top-level dragged frame (`dragged.lineCount > 0`, defensive — likely unreachable since `hitTestFrames` returns leaves only and bands aren't draggable, but cheap defense): `releaseClaimLines(beforeState.doc, dragged)`.

### `frameInversion` whitelist add

Append `e.is(setFramesEffect)` to the OR chain at `editorState.ts:569-583`. Without this, undo reverts text but leaves the frame tree post-reparent → divergence. Critical correctness requirement.

### `unifiedDocSync` runs but does nothing for reparent transactions

The transactionFilter still runs (it always runs); it does not recognize `setFramesEffect` and after PR 3's cutover contains no reparent-specific branches. The pre-baked `t.changes` are applied directly. This is a "load-bearing bypass" claim — pin it with a unit test in PR 3 that dispatches a reparent transaction and asserts `unifiedDocSync` returns the transaction unchanged (no extra effects, no extra changes). If a future contributor adds a `setFramesEffect` branch to the filter, the test breaks loudly.

### Dirty propagation

`setFramesEffect` bypasses the per-effect `markDirtyById` calls in today's `framesField.update` (per-effect handlers each call `markDirtyById` which is exported at `editorState.ts:114-121`). The renderer and serializer skip non-dirty frames; without dirty propagation, reparented elements are invisible until something else marks them.

**Hard rule:** `framesAfter` must have `dirty: true` set on every frame the orchestrator mutated AND on the chain of ancestors leading to each. Implementation: after computing `framesAfter`, walk every changed id and call `markDirtyById(framesAfter, id)` (which already propagates up). Reuses the existing helper rather than reimplementing.

### `recomputeWireframeBounds` interaction

`recomputeWireframeBounds` runs unless effects are move-only (`editorState.ts:458-462`). `setFramesEffect` is not move-only, so recompute fires. The orchestrator's `framesAfter` must be in canonical form such that `recomputeWireframeBounds` is **idempotent** — produces an equivalent tree. (The earlier wording "must be a no-op" was too strong; recompute may rewrite wireframe bboxes when children moved, and that's fine as long as the result is stable on re-application.)

---

## 5. The orchestrator: `buildReparentTransition`

```typescript
function buildReparentTransition(
  beforeState: EditorState,
  intent: ReparentIntent,
): ReparentTransition | null {
  const frames = getFrames(beforeState);
  const dragged = findFrameInList(frames, intent.draggedId);
  if (!dragged) return null;
  if (intent.newParentId !== null && !findFrameInList(frames, intent.newParentId)) return null;
  if (intent.aRow < 0 || intent.aRow >= beforeState.doc.lines) return null;

  const sourceBand = findContainingBandDeep(frames, intent.draggedId);
  const sourceWillEmpty = computeSourceWillEmpty(sourceBand, intent.draggedId);
  const docWidthCols = computeDocWidthCols(beforeState.doc);
  const changes: ChangeSpec[] = [];

  if (intent.newParentId === null) {
    // PROMOTE.
    // Case 1: promote needs trailing blank rows for the new band's claim.
    const promoteInsert = computePromoteInsert(beforeState.doc, intent.aRow, dragged.gridH);
    if (promoteInsert) changes.push(promoteInsert);

    let framesAfter = computePromoteFramesAfter(
      frames, dragged, sourceBand, intent, docWidthCols, beforeState.doc,
    );
    // Case 3: release source band's claim if cascade-pruned.
    if (sourceBand && sourceWillEmpty) {
      const release = releaseClaimLines(beforeState.doc, sourceBand);
      if (release) changes.push(release);
      framesAfter = framesAfter.filter(f => f.id !== sourceBand.id);
    }
    framesAfter = markDirtyForReparent(framesAfter, dragged.id, sourceBand?.id);
    return { changes, framesAfter };
  }

  // DEMOTE.
  const newParent = findFrameInList(frames, intent.newParentId)!;
  const requiredBandH = (intent.aRow - newParent.gridRow) + dragged.gridH;
  // Defense-in-depth: bands grow downward only. Today's Bug D guard makes
  // requiredBandH < newParent.gridH unreachable in practice, but clamp regardless.
  const safeBandH = Math.max(newParent.gridH, requiredBandH);

  // Case 2: band expansion needs trailing blank rows.
  if (safeBandH > newParent.gridH) {
    const expandInsert = computeExpandInsert(
      beforeState.doc, newParent.gridRow + newParent.gridH, safeBandH - newParent.gridH,
    );
    if (expandInsert) changes.push(expandInsert);
  }

  let framesAfter = computeDemoteFramesAfter(
    frames, dragged, sourceBand, intent, newParent, safeBandH, beforeState.doc,
  );
  // Case 3: release source band's claim if cascade-pruned.
  if (sourceBand && sourceWillEmpty && sourceBand.id !== newParent.id) {
    const release = releaseClaimLines(beforeState.doc, sourceBand);
    if (release) changes.push(release);
    framesAfter = framesAfter.filter(f => f.id !== sourceBand.id);
  }
  // Defensive: if dragged was top-level (lineCount > 0), release its claim too.
  if (dragged.lineCount > 0) {
    const release = releaseClaimLines(beforeState.doc, dragged);
    if (release) changes.push(release);
  }
  framesAfter = markDirtyForReparent(framesAfter, dragged.id, sourceBand?.id, newParent.id);
  return { changes, framesAfter };
}
```

**Helpers (all read `beforeState.doc` only):**

- `computePromoteInsert(doc, aRow, gridH)`: Case 1 above.
- `computeExpandInsert(doc, lineAfterBand, linesToAdd)`: Case 2 above.
- `releaseClaimLines(doc, frame)`: Case 3 helper, mirrors `unifiedDocSync:789-792` exactly.
- `computePromoteFramesAfter`: extract `dragged` from current parent, wrap in fresh band via `wrapAsBand` (mirroring `editorState.ts:296-300`), append to top-level. New band's `docOffset = beforeState.doc.line(intent.aRow + 1).from` if in range, else `beforeState.doc.length`. All other frames retain their `docOffset`. `lineCount = dragged.gridH`.
- `computeDemoteFramesAfter`: extract `dragged`, rebase coords parent-relative (`gridRow = intent.aRow - newParent.gridRow`, `gridCol = intent.aCol - newParent.gridCol`, `x = gridCol * cw`, `y = gridRow * ch`). Append to `newParent.children`. If `safeBandH > newParent.gridH`, set `newParent.gridH = safeBandH` AND `newParent.lineCount = safeBandH` (top-level bands have `lineCount > 0`).
- `computeSourceWillEmpty(band, draggedId)`: recursive cascade-prune. Walks any depth: starting from `band`, descend through any chain of solo-children (`children.length === 1` and child is the dragged frame OR another wireframe wrapper recursing) until either we reach the dragged frame (band will empty) or find a node with siblings (band stays). Replaces today's 2-level-only check at `editorState.ts:1462-1479` — this is a **semantic change**, not just a bug fix; the matrix cell #12 pins the new behavior explicitly.
- `markDirtyForReparent(framesAfter, ...ids)`: walks every supplied id, calls the existing exported `markDirtyById(framesAfter, id)` which propagates dirty to ancestors.

---

## 6. Golden-test matrix

14 cells. **Bug today** = fails today, must pass after PR 3. **Intended** = must match today's exact output. (Cell #15 from earlier draft removed — see §9 mergeOverlappingBands compromise.)

| # | Source | decideReparent's decision | aRow lands on | Source siblings | Expected | Today's status |
|---|--------|-----|-----|-----|----------|----------------|
| 1 | top-level rect | promote | empty mid-doc | n/a | promote, fresh band at aRow | intended |
| 2 | child-of-band | none (Bug A guard refused) | past doc end | n/a | no-op | intended |
| 3 | child-of-band | none (Bug A guard refused) | above doc (dropPy < 0) | n/a | no-op | intended |
| 4 | child-of-band | none (Bug C guard refused) | prose row | n/a | no-op | intended |
| 5 | child-of-band | promote | empty mid-doc, doc has trailing blanks at aRow | source band has 1 child | promote + cascade-prune source band, no doc grow | intended |
| 5b | child-of-band | promote | aRow + gridH past doc end | source band has 1 child | promote + cascade-prune + insert blank rows for new band's claim | intended (today's `unifiedDocSync:811-833`) |
| 6 | child-of-band | promote | empty mid-doc | source band has 2+ children | promote, source band stays at original gridH | intended |
| 7 | child-of-band | demote | empty band-row of dest | dest band has sibling, dragged < sibling | demote, no expansion (Figma nest) | intended |
| 8 | child-of-band | none (Bug D guard refused) | row collides with sibling | dest band has sibling | no-op | intended |
| 9 | child-of-band | none (drop on self-band) | any | n/a | no-op | intended |
| 10 | child-of-band | demote (decideReparent's redirect, §3) | inside dest band's claim, past child rows, requires expansion | one child in dest band | demote + expand band + insert blank rows for expansion | intended (today's apply-level redirect; new path's decision-level redirect produces identical end-state) |
| 11 | child-of-band | demote (caller passed band id directly via leaf hit-test) | inside dest band's claim, past child rows, requires expansion | one child in dest band | demote + expand band + insert blank rows | intended |
| 12 | deeply-nested child (band → wireframe → wireframe → rect) | promote | empty mid-doc | dragged is sole leaf in chain | promote + cascade-prune entire chain | bug today (cascade only goes 1 level deep, `editorState.ts:1462-1479`) |
| 13 | undo of cell #5 | (undo) | (undo) | (undo) | restores original tree, prose intact | bug today (Group B failure) |
| 14 | post-promote frame's `docOffset` invariant | promote | empty mid-doc, two existing bands (one ABOVE the new band's row) | (n/a) | `buildReparentTransition`'s returned `framesAfter[i].docOffset` is in `beforeState.doc` coords for ALL frames including the new band (verified by inspection BEFORE dispatch) | new (invariant test for §4 hard rule) |

(Cells 5 and 5b split today's intended behavior for promote: 5 covers "doc has enough blanks already" (no insert), 5b covers "doc needs grow" (insert path). Together they pin both branches of `unifiedDocSync:828-832`.)

(Cells 10 and 11 test the same end-state from two different intent shapes — proving the decision-level redirect produces identical end-state regardless of which path the intent reached the apply layer through.)

(Removed: cells that proposed "insert blanks + promote" or "expand into prose" — those are refused by guards as no-ops. Removed: "top-level band into existing-band" — bands aren't draggable, `hitTestFrames` returns leaves only per `frame.ts:250`. Removed previous cell 15 covering `mergeOverlappingBands` parity — today's reparent doesn't merge bands either, so there is no parity to verify; see §9.)

The matrix is a vitest file `src/reparentMatrix.diag.test.ts` — one test per cell using `toMatchInlineSnapshot` for `(framesAfter, doc, saved)`. The full pipeline `decideReparent → applyReparentFrame` is exercised; cell #14 additionally calls `buildReparentTransition` directly to inspect pre-dispatch `framesAfter`. Cells #12, #13, #14 fail today, intentionally pinning the bugs the rewrite fixes.

---

## 7. Migration plan (3 PRs)

The earlier draft's PR 2 (redirect-only refactor) is collapsed into PR 3. Shipping the redirect alone would silently drop today's band-expansion logic (today's redirect block at `editorState.ts:1486-1499` does TWO things: emits the redirect AND adds a `resizeFrameEffect` for band expansion). PR 3 lands both atomically behind a flag where `buildReparentTransition` handles expansion uniformly.

**PR 1 — Capture (no production change).**
- `src/reparentMatrix.diag.test.ts` with 14 cells using inline snapshots.
- Bug-tagged cells (#12, #13, #14) assert post-rewrite expected behavior; they fail today.
- Intended cells assert today's exact output, snapshotted from current behavior.
- `applyReparentFrame` is unchanged.
- Pin commit SHA in §1's `Today:` line so PR 3's harness count claim is verifiable.

**PR 2 — Effect plumbing (no behavior change).**
- Define and `export` `setFramesEffect` from `editorState.ts`.
- Apply the `framesField.update` reorder (§4 mechanism). Since no transaction carries `setFramesEffect`, the reorder is a structural no-op; verify by full vitest + harness pass at 139/6, 607/2.
- Add `setFramesEffect` to the `frameInversion` whitelist. Pre-emptive; harmless on transactions that don't use it.
- Make `wrapAsBand` (from `frame.ts`) callable from `reparentTransition.ts` if not already exported.

**PR 3 — Wire `buildReparentTransition` and the redirect, behind a flag, atomically.**
- Add `src/reparentTransition.ts` with `buildReparentTransition`, `commitReparent`, the helpers (`computePromoteInsert`, `computeExpandInsert`, `releaseClaimLines`, `computePromoteFramesAfter`, `computeDemoteFramesAfter`, `computeSourceWillEmpty`, `markDirtyForReparent`).
- Unit tests for each helper. Plus the unifiedDocSync-bypass invariant test: dispatch a reparent transaction; assert `unifiedDocSync` returns it unchanged.
- Move the promote-into-existing-band redirect from `applyReparentFrame:1481-1519` into `decideReparent` (§3).
- Feature flag `USE_NEW_REPARENT` (env var or window global).
- `applyReparentFrame` checks the flag: on → `commitReparent(state, intent)`; off → today's code.
- Run the matrix suite under both flag values. Expected diffs on cells #12, #13, #14 (success signal). All other cells must match.
- Run full vitest + harness under both flag values:
  - Flag off: 139/6, 607/2 (today's baseline).
  - Flag on: target 142/3, 609/0 (three Group B failures clear; deferred apply-layer pin tests likely still fail — they pin "promote into prose should somehow succeed" which is correctly refused under the kept-guards design — confirm in this PR).

**PR 4 — Cut over and cleanup.**
- Default the flag to on. Delete the flag check; `applyReparentFrame` becomes a one-line wrapper around `commitReparent`.
- Delete the four-branch logic in `applyReparentFrame` body (`editorState.ts:1440-1535`, ~96 lines), leaving only the wrapper.
- Delete the `reparentFrameEffect` handler in `framesField.update` (around line 244).
- Delete reparent-specific branches in `unifiedDocSync` (search `editorState.ts:805-846` for `reparentFrameEffect` references; delete those branches).
- Delete `e.is(reparentFrameEffect)` from the `frameInversion` whitelist.
- Delete the `reparentFrameEffect` definition itself.
- The `decideReparent` signature stays at `(frames, draggedId, dropPx, dropPy, docExtentPy, promoteLanding?, demoteLanding?)`. **Guards stay.**
- The two pin tests in `ghostOnDragPastEnd.diag.test.ts` and `ghostOnEqualSizePromote.diag.test.ts` may continue to fail; they pin "promote into prose should succeed somehow" which the kept-guards design refuses. Either delete them or update snapshots — decide based on PR 3's matrix output.
- Confirm Group B harness failures clear.

---

## 8. Explicit non-goals

- **Not converting `moveFrame`, `resizeFrame`, `addFrame` to the new path.** Future work.
- **Not changing undo/redo machinery.** Adding `setFramesEffect` to `frameInversion`'s whitelist is the only change.
- **Not removing `decideReparent` guards.** Bug A/C/D guards stay. Refusing bad-geometry drops is correct under the grid-pinned model.
- **Not auto-shifting prose to make room.** Out of scope.
- **Not touching `mergeOverlappingBands` or the Group D UX issue.** Separate pass.
- **Not implementing horizontal collision detection.** `landingGridFromCursor` produces `aCol`; orchestrator uses verbatim. Multi-rect-per-row collisions resolve via "last writer wins" in the serializer, same as today.

---

## 9. Risks and known compromises

**Open risks:**

- **Pin tests.** PR 3 will determine whether the two deferred apply-layer pins (`ghostOnDragPastEnd.diag.test.ts`, `ghostOnEqualSizePromote.diag.test.ts`) flip or stay broken. Their hypotheses ("promote into prose should produce a coherent result") are at odds with the kept-guards design. PR 4 either deletes them or rewrites their assertions.
- **Group B harness count prediction.** §10 predicts 139/6 → 142/3. Verify by running the three named Group B tests (`undo a drag-into-frame reparent`, `promote then drag old parent: promoted frame stays put`, `promote then drag the promoted frame: old parent stays put`) at `da839ef` and confirming each fails specifically due to apply-layer non-atomicity (the bug this rewrite targets), not some other cause. Add the trace to PR 1's evidence.

**Known compromises (accepted, called out for future readers):**

- **`computeDocWidthCols` is O(N) per reparent.** A full doc scan to find max line width, run on every promote that needs `wrapAsBand`. Today's `applyAddTopLevelFrame` already does this scan, so this isn't new. Acceptable; flag for profiling if reparent-heavy workflows surface as slow.
- **Bands grow downward only.** `requiredBandH = (intent.aRow - newParent.gridRow) + dragged.gridH` assumes the demote target row is at or below the band's existing top. Defense-in-depth: §5 clamps via `safeBandH = Math.max(newParent.gridH, requiredBandH)`. Today's Bug D guard makes the dangerous case unreachable; the clamp defends against future intent-construction changes.
- **Refused drops are no-ops.** Per the user constraint: drops onto prose, past doc end, or onto a same-size sibling produce no movement. Correct under the grid-pinned model.
- **`mergeOverlappingBands` is not called by the new path.** Today's `mergeOverlappingBands` only fires inside the `moveFrameEffect` branch (`editorState.ts:206`). It does NOT run on `reparentFrameEffect` today either. So the new path's behavior is identical to today's: reparent transactions never merge adjacent bands. The kept guards prevent the orchestrator from creating overlapping bands. This is preserved-behavior parity, not a regression. (Earlier drafts proposed a matrix cell to verify parity, but since today's reparent also does not merge, there is no behavior to capture as today's-baseline that differs from the new path's.)
- **The `restoreFramesEffect` early-return path does not run mapPos.** Intentional, with rationale in §4: undo/redo snapshots are stored in their final coordinate space, so re-mapping would double-shift. A code comment in PR 2 documents this so future readers don't "fix" the early-return.
- **Defensive top-level-dragged demote release** in §5 is reachable in theory but unreachable in practice (`hitTestFrames` returns leaves only). Cheap to keep as defense.

---

## 10. Success criteria

- vitest: 607/2 baseline preserved (no regressions). The two deferred apply-layer pin tests likely stay pinned (kept-guards design refuses what they assume succeeds); PR 3 confirms.
- Harness 139/6 → 142/3 (three Group B failures clear).
- `decideReparent` signature unchanged. Guards retained. The promote-into-existing-band redirect added (§3) is a behavior-preserving relocation; the matrix's intended cells (especially #10 and #11) prove parity.
- One file added (`src/reparentTransition.ts`). Net code change is approximately neutral; the win is **one apply path instead of four**.
