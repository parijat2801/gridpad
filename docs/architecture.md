# Gridpad Architecture

A markdown editor where ASCII wireframes (`┌──┐` boxes) come alive on an HTML5 canvas. Open `.md` files, prose renders as text, wireframes become click/drag/resize objects.

## The unified document model

**Single source of truth:** the CodeMirror 6 doc holds the full `.md` text. Wireframe lines are `""` (empty strings) in the doc. Top-level frames CLAIM line ranges via `docOffset` (CM character offset) + `lineCount`.

```
.md file → Scanner → scanToFrames → CM doc (full .md, claimed lines = "")
                                       ↓
                                  framesField holds frames with docOffset/lineCount
                                       ↓
                            ← Single HTML5 Canvas (reflow + frame render) →
                                       ↓
                                  serializeUnified ← single-pass line walk
```

**Why empty strings, not single spaces:** `preparedCache.ts:12` maps non-empty strings to non-null `PreparedTextWithSegments`. Empty strings hit the `null` fast-path in `reflowLayout` (advances `lineTop` by one row, no `PositionedLine` emitted). Single spaces would generate spurious lines that overdraw under the wireframe — invisible but wrong.

## Source-of-truth invariants

For TOP-LEVEL frames (`lineCount > 0`):

- `gridRow` is a CACHE of `state.doc.lineAt(docOffset).number - 1`.
- `framesField.update` re-derives `gridRow` from `docOffset` at the end of every doc-changing transaction (`src/editorState.ts:235-253`).
- `lineCount` is also clamped to `docLines - gridRow` so the frame can't claim past the doc end.

For CHILD frames (`lineCount === 0`):

- `gridRow` is PARENT-RELATIVE (offset within the parent rect).
- Children don't claim doc lines — their position is fully determined by the parent's claim plus their own `gridRow`.

This dual meaning of `gridRow` is what lets `serializeUnified` use `child.gridRow` for relative rendering while reading the top-level frame's (re-derived) `gridRow` for doc-line indexing.

## CM transaction architecture

Frame mutations dispatch StateEffects (`moveFrameEffect`, `resizeFrameEffect`, `addFrameEffect`, `deleteFrameEffect`). The `unifiedDocSync` transactionFilter intercepts those effects and pairs them with CM doc changes:

| Effect | Doc change |
|---|---|
| `moveFrameEffect` (dRow ≠ 0) | **Newline rotation.** Move `dRow` newlines from one side of the frame to the other. Doc length invariant. Clamped to count of consecutive empty lines on the relevant side; no-op if no buffer. |
| `resizeFrameEffect` (delta ≠ 0) | Insert/remove `delta` empty lines after the frame's claim. |
| `deleteFrameEffect` | Delete claimed lines + ONE boundary newline (leading if frame mid-doc, trailing if at file start). NOT both — would merge prose-above and prose-below. |
| `addFrameEffect` | Insert `lineCount` empty lines at `docOffset`. |
| Other effects (z-order, text-edit, align) | No doc change. |

When a transactionFilter returns an array of specs, CM merges them into ONE transaction via `resolveTransaction(state, filtered, false)`. The `false` means `changeFilter` is NOT re-applied to the merged transaction — programmatic emits from `unifiedDocSync` aren't blocked by the user-edit guard. This is intentional and is the reason the filter pattern works.

Undo reverses everything atomically:
- `frameInversion` (`invertedEffects.of`) snapshots the pre-transaction frames array as a `restoreFramesEffect`.
- CM's automatic ChangeSet inversion reverses the doc changes.
- Both are part of the same history entry → one undo reverses both.
- During undo, `mapPos` runs on the inverted ChangeSet first; then `restoreFramesEffect` overwrites the frames array with the pre-mutation snapshot. So `docOffset` is set from the snapshot, not from `mapPos`.

## changeFilter (claim-line guard)

`EditorState.changeFilter` rejects user-event edits that intersect any claimed line range:

```typescript
if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) return true; // bypass programmatic
// ... compute claimed ranges, check intersection with tr.changes
return !intersects;
```

**Important quirks:**
- Returning a boolean is correct. Returning an ARRAY of numbers is an *allowlist* (CM 6 quirk) — naive use would lock prose editing.
- Pure insertions AT a claim boundary (`fromA === toA && fromA === r.from`) are ALLOWED — that's how Enter-above-wireframe works. With `mapPos(docOffset, 1)` the frame shifts forward and the claim still owns the originally-claimed lines.
- Defensive bounds check on `f.docOffset > docLen` — legacy `createEditorStateFromText` leaves stale offsets that would crash `lineAt`.

## docOffset remapping (mapPos)

`framesField.update` runs on EVERY transaction. When `tr.docChanged`, it remaps each top-level frame's docOffset:

```typescript
result = result.map(f =>
  f.lineCount === 0 ? f : { ...f, docOffset: tr.changes.mapPos(f.docOffset, 1) }
);
```

**Associativity = 1** is critical. The default (`-1`) makes a frame's offset stay BEFORE preceding insertions; users would type a char before a frame and the frame's claim would shift INTO the new char. With `+1` the frame follows the insertion, which matches user intent.

## doLayout pipeline

`DemoV2.tsx` (`doLayout`):

1. Build `claimedLines: Set<number>` from frames using `state.doc.lineAt(f.docOffset).number - 1`.
2. Build `adjusted = preparedRef.current.map((p, i) => claimedLines.has(i) ? null : p)` — claimed entries become `null`.
3. Call `reflowLayout(adjusted, canvasW, ch, [])` — empty obstacles array (claimed lines drive layout via `null`, not obstacles).
4. Compute frame pixel Y via `lineTop` accumulator: walk doc lines, advance `lineTop` by `ch` per claimed line, by `visualLines.count * ch` per prose line. Assign `f.y = lineTop` when entering each frame's start line.

This produces a single mental model: the y-axis is divided into `ch`-tall bands; each band is either a prose line or a claimed (frame) line. Prose flows vertically; frames sit at their bands.

## syncRefsFromState

After ANY mutation, `DemoV2.tsx` calls `syncRefsFromState()`:

```typescript
function syncRefsFromState() {
  const proseText = getDoc(stateRef.current);
  proseRef.current = proseText;
  framesRef.current = getFrames(stateRef.current);
  preparedRef.current = buildPreparedCache(proseText);
}
```

This is load-bearing. Phase 6 (mutations) introduced the invariant that `unifiedDocSync` mutates the CM doc as a side-effect of frame effects. The pre-Phase-6 code only synced `framesRef` after frame effects, leaving `preparedRef` stale. Manual smoke testing surfaced the regression: typing/dragging would visually scramble because `reflowLayout` was running on a stale prepared cache.

## Round-trip serialization

`serializeUnified(doc, frames)` walks doc lines:

- For prose lines (no claiming frame), output the line verbatim.
- For claimed lines, render frame ASCII content recursively via `renderFrameRow(frame, localRow, gridCol, rowChars)`.
- Run `repairJunctions` on the resulting grid (merge `┘├` → `┤` etc. where frames touch).
- Trim trailing blank lines, join with `\n`.

`renderFrameRow` always recurses into children regardless of parent gridH. The scanner reparenter sometimes places a child text label at a `gridRow` that exceeds parent `gridH` (junction grids — labels share a row with sibling rect borders). Pruning by parent gridH skips legitimate grandchildren. Each child has its own `localRow >= 0 && localRow < gridH` check inside the recursive call, so unconditional recursion is safe.

## Key files

- `src/DemoV2.tsx` — thin canvas shell. `loadDocument`, `saveToHandle`, `doLayout`, `paint`, mouse + keyboard handlers, `__gridpad` test hooks.
- `src/editorState.ts` — CM state, `unifiedDocSync` filter, `framesField.update`, `claimFilter`, `apply*` helpers, `proseMoveUp/Down` with claimed-line skip.
- `src/serializeUnified.ts` — single-pass round-trip serializer.
- `src/frame.ts` — Frame model. `moveFrame`, `resizeFrame`, `framesFromScan`, `groupIntoContainers`, `reparentChildren` (in `autoLayout.ts`).
- `src/scanToFrames.ts` — scanner output → frames + initial docOffset/lineCount.
- `src/reflowLayout.ts` — Pretext-based prose layout, takes `(PreparedTextWithSegments | null)[]` + obstacles.
- `src/preparedCache.ts` — per-line `prepareWithSegments` cache. Empty lines map to `null`.
- `src/scanner.ts` — ASCII → shapes (rects, lines, texts). Pure parser, no editor state.
- `src/layers.ts` — layer compositing for frame content (cell-grid representation).
- `src/autoLayout.ts` — `reparentChildren`, `layoutTextChildren`.
- `e2e/harness.spec.ts` — round-trip harness with screenshots, ghost detection, prose integrity checks.

## Test layers

| Layer | Where | What it catches |
|---|---|---|
| Vitest unit | `src/*.test.ts` | Frame model invariants, CM transaction logic, individual function correctness. |
| Vitest integration | `src/diagnostic.test.ts`, `src/harness.test.ts` | Multi-step round-trips against fixture inputs. |
| Playwright e2e | `e2e/harness.spec.ts` (~125 tests) | Real browser interaction: load → mouse drag → save → reload → diff. **Authoritative source of truth for visual correctness.** |
| Manual smoke | `npm run dev -- --port 5177` then a browser | Catches what unit tests miss (stale caches, paint glitches). |

E2e harness writes artifacts to `e2e/artifacts/<test-name>/` including `input.md`, `output.md`, `tree-before.json`, `tree-after.json`, before/after PNG screenshots, ghost-detection results. **When a harness test fails, READ the artifacts first.** The bug is almost always visible in `output.md`.

## Hard rules

From `CLAUDE.md`:

1. Functions ≤60 lines, files ≤300 lines.
2. Validate exported function inputs.
3. No `any` in new code. No `// @ts-ignore`.
4. Logic in pure modules; `DemoV2.tsx` is a thin shell.
5. Parse once → mutate model → serialize on save. **Never re-scan on render.**
6. No `useEffect` for data flow — explicit calls only.
7. Playwright pixel tests use full-image scan, never sparse sampling.
8. **Grid coords are canonical.** Never store pixel positions as source of truth for wireframes. Derive pixels from grid × cellSize.
9. **No Math.round in serialize path.** Read `gridRow`/`gridCol` directly.
10. **Wireframes snap to grid.** Move/resize commit in grid units.

## What NOT to do

- **Don't revert to the split-pipeline model** (legacy `createEditorStateFromText` + `gridSerialize`). The unified-document design is the goal.
- **Don't add manual frame-shift loops** in prose Enter/Backspace handlers. `mapPos` handles it. The pre-Task-8 code had manual loops — they were redundant.
- **Don't trust `tsc --noEmit` alone.** Run `npm run build` before committing — `tsc -b` strict mode catches missing-field errors loose mode skips (especially Frame literals missing `docOffset`/`lineCount`).
- **Don't bypass the `gridRow` re-derivation** at the end of `framesField.update`. Without it, drag corrupts text.
- **Don't prune `renderFrameRow` recursion by parent gridH.** Some scanner-produced children legitimately fall outside their parent rect's bounds.
- **Don't truncate test output.** RTK tee captures the full log at `~/Library/Application Support/rtk/tee/`. Read those when console output is truncated.
