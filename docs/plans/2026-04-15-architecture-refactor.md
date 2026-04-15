# Gridpad Architecture Refactor — Master Plan

**Goal:** Replace DemoV2's 20-ref, 13-mutation-site, 609-line monolith with a
testable state machine backed by CodeMirror 6. Fix all P0–P3 issues from the
codebase audit. Delete ~1800 lines of dead code.

**End state:** Single CM `EditorState` (prose as doc, frames as StateField,
undo via built-in history) → thin React shell → canvas.

---

## Current State (what we're starting from)

```
3,127 lines source | 6,107 lines tests | 376 passing tests
~1,800 lines dead code (layers.ts, diff.ts, identity.ts + tests)
DemoV2: 609 lines, 20 refs, 13 mutation sites, no undo
```

### What works well (don't touch)
- Scanner (ASCII box tracing) — 527 lines, 544 lines of tests
- Pretext reflow (reflowMetadata, paintVisibleLines) — 174 lines
- Frame model (frame.ts) — 293 lines, 438 lines of tests
- Canvas rendering (frameRenderer.ts) — 106 lines
- Serialize (framesToMarkdown) — 183 lines
- Virtual scroll — just shipped on feature/virtual-scroll

### What's broken (the audit)
- P0: Cursor unreliable, editing flaky (DemoV2 complexity)
- P0: Prose edits lost on save (prosePartsRef never updated after typing)
- P1: No z-order, no background fill, overlap = character soup
- P2: ~1800 lines dead Layer code (replaced by Frame, never deleted)
- P3: DemoV2 too large, no undo, no state management

---

## Architecture Decision: Single CM State (Option C)

After review by three independent reviewers (Claude sonnet, Claude opus
consistency checker, Gemini staff engineer), the original plan (CM for prose +
zustand for frames + action log for undo coordination) was rejected.

**Problem with split-brain:** Two undo stacks (CM history + zundo) cannot be
coordinated reliably. An action log to track ordering is fragile and will
desync on batched keystrokes, failed transactions, or mixed operations.

**Solution — Option C:** Use CM `StateField` and `StateEffect` to store frame
state inside the same `EditorState`. One undo stack for everything.

```
EditorState
├── doc: Text                        ← prose (built-in)
├── selection: EditorSelection       ← cursor/selection (built-in)
├── history                          ← undo/redo (built-in via @codemirror/commands)
├── framesField: StateField<Frame[]> ← frames (custom StateField)
├── toolField: StateField<ToolName>  ← active tool (custom StateField)
├── regionsField: StateField<Region[]> ← regions for serialization
└── prosePartsField: StateField<...> ← prose parts for serialization
```

**How frame operations become undoable:**

```typescript
// Define a state effect for frame moves
const moveFrameEffect = StateEffect.define<{ id: string; dx: number; dy: number }>();

// Frame state field — updates when it sees moveFrameEffect
const framesField = StateField.define<Frame[]>({
  create: () => [],
  update(frames, tr) {
    for (const e of tr.effects) {
      if (e.is(moveFrameEffect)) {
        // apply the move, return new frames array
      }
    }
    return frames;
  },
});

// To move a frame — it's a CM transaction, tracked in history:
const tr = state.update({
  effects: moveFrameEffect.of({ id: "abc", dx: 20, dy: 30 })
});
// Cmd+Z undoes this automatically alongside text edits
```

**What this eliminates:**
- zustand (not needed)
- zundo (not needed)
- Action log / timestamp coordination (not needed)
- Split-brain desync risk (impossible — one state tree)

---

## New Libraries

| Library | Version | Size | Purpose |
|---------|---------|------|---------|
| `@codemirror/state` | 6.6.0 | 142KB | Full editor state: doc, selection, StateField, StateEffect |
| `@codemirror/commands` | 6.8.0 | 85KB | history() extension for undo/redo |

That's it. Two libraries. Both verified to work headlessly (no DOM).

---

## Phases

### Phase 1: Dead Code Deletion (P2)

**Risk: Zero.** Only deletes unreachable code.

1. Delete `diff.ts`, `diff.test.ts` — 632 lines. Only imported by its own tests.
2. Delete `identity.ts`, `identity.test.ts` — 143 lines. Only imported by diff.ts.
3. Remove dead exports from `layers.ts`. Keep only: `regenerateCells`,
   `buildLineCells`, `buildLayersFromScan`, `LIGHT_RECT_STYLE`, `Layer`,
   `LayerType`, `RectStyle`.
4. Remove dead tests from `layers.test.ts`.
5. Remove `munkres-js` from dependencies.
6. Run full suite — confirm green.

**Lines deleted:** ~1,800 (production + tests)
**Detailed plan:** `docs/plans/2026-04-15-phase1-dead-code.md`

### Phase 2: Merge detectRegions + framesFromRegions (P2 cont.)

**Risk: Low-Medium.** Refactor with tests as safety net. Must rewrite
`framesFromRegions` to not depend on `Region.layers`.

1. Rewrite `framesFromRegions` to build frames from scan data directly
   (not from pre-built Layer objects). This is the E3 fix.
2. Create `scanToFrames(text, cw, ch)` that combines the full pipeline.
3. Remove `Region.layers` field.
4. Update `harness.test.ts` and `corpus.test.ts` to use frame cells
   instead of `region.layers` + `compositeLayers`.
5. Delete `buildLayersFromScan`, `compositeLayers`, remaining Layer code.
6. Run full suite.

**Detailed plan:** `docs/plans/2026-04-15-phase1-dead-code.md` (Tasks 2.x)

### Phase 3: EditorState module (P3)

**Risk: Medium.** New CM integration. All headlessly testable.

Create `src/editorState.ts` — single module wrapping CM:

1. **State creation:** `createEditorState(prose, frames, regions, proseParts)`
   → `EditorState` with history, framesField, regionsField, prosePartsField
2. **Prose operations:** `proseInsert`, `proseDelete` → CM transactions
3. **Frame operations:** `moveFrame`, `resizeFrame`, `addFrame`, `deleteFrame`
   → CM transactions with StateEffects
4. **Position converters:** `rowColToPos` / `posToRowCol` — must be
   **grapheme-aware** (not just `line.from + col`). Use Pretext's segment
   info or iterate grapheme clusters.
5. **Undo/redo:** `editorUndo` / `editorRedo` → CM history. One stack for all.
6. **Accessors:** `getFrames(state)`, `getDoc(state)`, `getCursor(state)`,
   `getRegions(state)`, `getProseParts(state)`, `getTool(state)`

Write `src/editorState.test.ts`:
- Prose insert/delete/cursor movement
- Frame move/resize + undo restores position
- Mixed operations: type → move frame → undo → frame reverts → undo → text reverts
- Position mapping round-trips (including emoji/multi-codepoint chars)
- Equivalence tests against current `proseCursor.ts` behavior

### Phase 4: Canvas renderer extraction

**Risk: Low.** Pure function extraction from DemoV2.

Extract `src/canvasRenderer.ts`:
- `paintCanvas(ctx, renderState)` — pure function, no side effects
- `RenderState` interface: everything `paint()` currently reads from refs
- `buildRenderState(editorState, scrollTop, viewport, dpr)` — converts
  CM state to render state

Write `src/canvasRenderer.test.ts`:
- Mock canvas context, verify correct draw calls

### Phase 5: DemoV2 rewrite (P3)

**Risk: High.** The big swap.

Rewrite `src/DemoV2.tsx` (~150 lines target):
- `useRef` only for: `canvasRef`, `sizeRef`
- `editorStateRef` holds the CM `EditorState`
- All mutations go through `editorState.ts` functions → new CM state
- `paint()` calls `buildRenderState` → `paintCanvas`
- Mouse events → compute action → call editorState function
- Keyboard events → compute action → call editorState function
- File I/O stays simple (loadDocument → create new state, save → serialize)

Migration order (one interaction at a time):
1. Prose display (read-only) — CM doc renders on canvas
2. Prose editing (insert/delete/cursor)
3. Frame display + drag
4. Frame resize + draw tools
5. File open/save
6. Text frame editing

Each step is verified before the next begins.

### Phase 6: Z-order + overlap (P1)

**Risk: Low.** Feature on clean architecture.

1. Add `z: number` to Frame
2. `setZEffect` StateEffect + update in framesField
3. Sort by z in renderer, reverse z in hit test
4. Background `fillRect` per frame
5. `]` / `[` keyboard shortcuts for z-order

### Phase 7: Cleanup (P4)

1. Delete `proseCursor.ts` + `proseCursor.test.ts` (replaced by CM)
2. Extract shared canvas mock to `src/test-utils.ts`
3. Delete `_crash.test.ts` if it exists
4. Fix save path: update `prosePartsField` when prose is edited
5. Final line count audit

---

## Execution Strategy

- **Phase 1–2:** Pure deletion + refactor. Branch: `feature/dead-code-cleanup`
- **Phase 3–4:** New modules alongside DemoV2 (shadow, don't replace).
  Branch: `feature/editor-state`
- **Phase 5:** The big swap. Branch: `feature/demo-rewrite`
- **Phase 6–7:** Features + polish. Branch: `feature/z-order`

Each phase is independently mergeable. Phase 3 depends on Phase 1–2 being
merged. Phase 5 depends on Phase 3–4.

---

## Success Criteria

| Metric | Before | After |
|--------|--------|-------|
| Source lines | 3,127 | <2,000 |
| DemoV2 lines | 609 | <150 |
| Mutation sites | 13 (fire-and-forget) | 0 (all via CM transactions) |
| Refs in DemoV2 | 20 | 2 (canvasRef, sizeRef) |
| Undo/redo | None | Full (single CM history stack) |
| Cursor reliability | Flaky | Solid (CM-backed) |
| Dead code | ~1,800 lines | 0 |
| Test count | 376 | 400+ (new state tests) |
| Libraries added | — | 2 (@codemirror/state, @codemirror/commands) |
| Libraries removed | — | 1 (munkres-js) |

---

## Known Risks + Mitigations

### R1: Grapheme vs code unit mismatch
CM uses UTF-16 code unit offsets. Pretext uses grapheme clusters. Position
converters must iterate grapheme clusters, not assume `pos = line.from + col`.
**Mitigation:** Test with emoji (👨‍👩‍👧‍👦), CJK, combining marks in Phase 3.

### R2: Save path data staleness
`prosePartsRef` is never updated after typing. Serialization uses stale data.
**Mitigation:** Phase 7 task 4 — update prosePartsField on prose edits. Or
rebuild proseParts from doc + regions at save time.

### R3: Phase 5.3 has no intermediate testable state
Wiring CM → render requires all connections at once.
**Mitigation:** Phase 5 step 1 is read-only display. Step 2 adds editing.
Two checkpoints instead of one.

### R4: Spatial vs linear mismatch on save
Dragging wireframe to new position doesn't update region ordering.
Markdown is linear (top-to-bottom), frames are absolute-positioned.
If a user drags a wireframe from top to bottom, the `regions` array
order never updates — saved Markdown still shows wireframe at original
position.
**Mitigation:** `framesToMarkdown` must re-sort by absolute Y before
serializing. Rebuild the linear document from spatial positions.

### R5: `childrenHaveMoved` heuristic is weak (Gemini finding)
`serialize.ts` uses `childrenHaveMoved` to detect mutations. It checks
if `minRow > 0` — this gives false negatives for horizontal-only moves
(moving a box left/right without changing Y). Dragged frames may silently
revert to their original position on save.
**Mitigation:** Compare frame positions against original region positions
stored in `regionsField`, not just child row offsets.

### R6: Prose edits lost on save (Gemini finding)
`DemoV2.saveToHandle` passes `prosePartsRef.current` to `framesToMarkdown`.
But `prosePartsRef` is set once on `loadDocument` and never updated when
the user types. All prose edits are silently lost on save.
**Mitigation:** In the new architecture, `prosePartsField` must be
rebuilt from `doc` on every prose edit, OR rebuilt at save time from
the CM doc + region boundaries.

### R7: `framesFromRegions` depends on `Region.layers` (confirmed by all reviewers)
Phase 2 removes `Region.layers`, but `framesFromRegions` reads
`region.layers ?? []` (frame.ts line ~229). Without rewriting this
function, Phase 2 breaks all wireframe rendering.
**Mitigation:** Phase 2 must rewrite `framesFromRegions` to construct
frames from scan data (rects, lines, texts) rather than pre-built layers.
This is the single hardest task in Phase 1-2.

---

## Review History

- **v1:** CM for prose + zustand for frames + action log for undo
- **Sonnet consistency review:** Found 7 errata (E1-E7), circular dependency
  in Phase 2, missing stores for regions/proseParts
- **Gemini staff review:** Rejected split-brain undo, flagged grapheme bug,
  flagged save path data loss, recommended single state tree
- **v2 (this document):** Option C — single CM state with StateField/StateEffect
  for frames. No zustand. Two libraries total.
