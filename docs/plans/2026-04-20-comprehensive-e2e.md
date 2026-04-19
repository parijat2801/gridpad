# Comprehensive E2E Test Plan — Final

**Agreed with Codex (GPT-5.4) after 3 rounds of debate.**

**Existing:** 125 tests in harness.spec.ts. Keep as-is. No refactor.

**New: 59 tests across 4 files. ~2 minutes with 4 workers.**

## File 1: `e2e/workflows.spec.ts` — 10 tests

Hand-written multi-step user scenarios. These test what a user does in their first 30 seconds.

1. Default doc → drag dashboard right → save → reload → all content intact
2. Pure prose → draw box → add label → save → round-trip
3. SIMPLE_BOX → type 3 lines above → wireframe pushed down → save
4. SIMPLE_BOX → resize wider → add label → both persist
5. TWO_SEPARATE → drag A past B → drag B up → order swapped, both intact
6. LABELED_BOX → drag → type → undo → undo → redo → save
7. SIMPLE_BOX → delete → type "replaced" → no wire chars
8. NESTED → drill to inner → drag inner → drag outer → both offset
9. Default doc → save → byte-identical (full default round-trip)
10. Default doc → type between wireframes → all original + new content preserved

## File 2: `e2e/sweep.spec.ts` — 36 tests

Loop: 6 fixtures × 6 operations. Each op chosen because it exercises a code path that has already broken.

**Fixtures (6):**
- SIMPLE_BOX — basic case
- LABELED_BOX — text child inside frame
- JUNCTION — shared walls with ┬├┼┤┴
- NESTED — parent-child hierarchy
- WITH_CHILDREN — outer+inner+text labels
- DEFAULT_TEXT — the full default document (most complex)

**Operations (6):**
- `drag-right-50` — basic horizontal movement
- `drag-down-80` — vertical movement, scroll behavior
- `drag-left-50` — negative clamp at x=0
- `resize-larger(40,20)` — cell regeneration, grid expansion
- `resize-smaller(-30,-20)` — blanking, shrink behavior
- `type-5-chars` — prose + frame interaction, reflow

**Each test does:**
```
load → operate → save → reload → save again →
assert: no ghosts, invariants pass, convergence (save2 === save1), frame count preserved
```

**Why these ops, not others:**
- `drag-diagonal` dropped: lower-frequency, no distinct code path from right+down individually
- `delete-frame` dropped: covered in workflows (#7) and coverage (#8)
- `drag-up` dropped: similar to drag-down, scroll-up case less common

## File 3: `e2e/convergence.spec.ts` — 5 tests

For the 5 highest-risk fixtures, do edit→save→reload up to 5 cycles. Assert stabilization.

1. JUNCTION + drag (shared walls drift)
2. NESTED + drag child (parent-child dirty propagation)
3. WITH_CHILDREN + resize parent (child rewrite)
4. DEFAULT_TEXT + drag dashboard (complex multi-frame)
5. SHARED_HORIZONTAL + drag (horizontal divider)

**Each test:**
```typescript
let md = fixture.md;
for (let cycle = 0; cycle < 5; cycle++) {
  await load(page, md);
  await operate(page);
  const next = await save(page);
  if (next === md) break; // stabilized
  expect(await findGhostsFromPage(page, next)).toEqual([]);
  md = next;
}
// Must have stabilized by cycle 5
await load(page, md);
expect(await save(page)).toBe(md);
```

## File 4: `e2e/coverage.spec.ts` — 8 tests

P0/P1 interaction tests using `__gridpad` hooks for assertions (not pixel clicks).

1. `hitTest` at frame center → returns frame ID
2. `hitTest` at empty space → returns null
3. Escape clears prose cursor (`getCursorPosition` returns null)
4. Redo frame move (drag → undo → redo → position matches dragged state)
5. Delete container cascades to children (outer deleted → inner also gone)
6. Drag parent moves all children (child absX/absY shifted by same delta)
7. Resize from top-left handle (x/y increase, w/h decrease)
8. Click frame after prose typing → selection works (scroll-aware — this bug was real)

**New hooks needed in DemoV2.tsx `__gridpad`:**
- `getCursorPosition()` → `proseCursorRef.current`
- `isDirty()` → `frames.some(f => f.dirty)`

## What we cut

| Cut | Reason |
|-----|--------|
| Generated fixtures (`generateFixture`) | Move to unit tests around gridSerialize |
| Chaos test in CI | Keep as local-only script |
| Helper extraction refactor | Not blocking, risky for no new signal |
| Snapshot JSON | No consumer, yak-shaving |
| Failure taxonomy tagging | Over-engineered for e2e |
| Tier B/C expansions | 36 sweep tests is enough |
| 8-handle resize permutations | Cover 2 (br in sweep, tl in coverage) |
| Border-pixel click tests | Flaky across OS/DPI |
| drag-diagonal in sweep | No distinct code path |
| delete in sweep | Covered elsewhere |

## What we deferred to unit tests (future)

- Parameter sweep of gridSerialize with generated fixtures
- Scanner edge cases (malformed input, CRLF, tabs, unclosed boxes)
- PreparedCache invalidation
- ProseSegmentMap consistency
- Emoji grapheme navigation

## Summary

| File | Tests | Purpose |
|------|-------|---------|
| harness.spec.ts (existing) | 125 | Regression backbone |
| workflows.spec.ts | 10 | Real user scenarios |
| sweep.spec.ts | 36 | Systematic fixture×op coverage |
| convergence.spec.ts | 5 | Multi-cycle stabilization |
| coverage.spec.ts | 8 | Interaction edge cases via hooks |
| **Total** | **184** | **~3.5 min with 4 workers** |

## Execution order

1. Add 2 hooks to DemoV2.tsx (`getCursorPosition`, `isDirty`)
2. Write `workflows.spec.ts` → verify 10/10
3. Write `sweep.spec.ts` → verify 36/36
4. Write `convergence.spec.ts` → verify 5/5
5. Write `coverage.spec.ts` → verify 8/8
6. Run full suite: 184/184

Each step is a commit. Any regression stops the pipeline.

## Imports

New test files import helpers by duplicating a small `e2e/test-utils.ts` with just the needed functions (`load`, `save`, `clickFrame`, `dragSelected`, `getFrames`, `getFrameTree`, `findGhostsFromPage`, `checkInvariants`, `getSelectedId`, `getRenderedLines`, `clickProse`, `resizeSelected`, `flattenTree`, `toViewport`, `getScrollState`, `getCharDims`, `writeArtifact`, `ensureDir`, `ARTIFACTS`). This is ~200 lines of copied helpers, not a refactor of the 3200-line harness.
