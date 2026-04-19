# Comprehensive E2E: Sweep Engine + Tiered Oracles

**Goal:** Replace hand-picked test points with a matrix sweep that covers `fixtures × operations × oracles` systematically. The primitives already exist (`roundTrip()`, `clickFrame()`, `findGhosts()`). What's missing is the loop.

## Architecture

```
e2e/
  harness-helpers.ts       ← extracted helpers, fixtures, oracle functions
  harness.spec.ts          ← existing 125 tests (import from helpers)
  sweep.spec.ts            ← matrix sweep engine
  workflows.spec.ts        ← 10 hand-written "first 30 seconds" scenarios
  corpus/
    canonical/             ← fixtures that must byte-round-trip
    real/                  ← bug repros, default doc, messy user docs
    generated/             ← parameter-sweep fixtures (built at test time)
  results/
    snapshot.json           ← latest sweep results (checked into git)
```

## The Oracle Tiers

Every fixture × operation combination is judged by the strongest oracle it satisfies:

| Tier | Name | What it checks | When to use |
|------|------|----------------|-------------|
| T1 | Byte identity | `save(load(md)) === md` | No-edit canonical fixtures |
| T2 | Semantic equivalence | Same frame tree shape, same prose content, same positions (±1 cell) | After edits |
| T3 | Convergence | `save → reload → save` stabilizes within 1 cycle | All operations |
| T4 | Invariants | No ghosts, no crashes, valid frame tree, prose present, no prose-frame overlap | Always |

Every test checks T4. Canonical no-edit tests also check T1. Edited tests check T2+T3.

## The Failure Taxonomy

Classify every failure by pipeline stage:

| Stage | Failures |
|-------|----------|
| Parse | Missed frame, hallucinated frame, wrong nesting, text↔structure misclassification |
| Geometry | Position drift, size drift, off-by-one, child displacement |
| Topology | Junction loss/wrong upgrade, shared wall split, disconnected border, broken closure |
| Prose | Corruption, reorder, disappearance, duplication, label detachment |
| Serialize | Ghost chars, under-blanking, over-blanking, whitespace churn, trailing-line regression |
| Interaction | Selection miss, z-order bug, mode stuck, drag without motion |
| History | Undo loses content, redo diverges, cumulative drift across cycles |
| Robustness | Crash, console error, invalid invariant, non-determinism |

The sweep engine tags each failure with `(stage, symptom)` in the result JSON.

## Tasks

### Task 1 — Extract helpers to `e2e/harness-helpers.ts`

Move all helpers, fixtures, oracle functions, and the `roundTrip` runner from `harness.spec.ts` into a shared module. Update `harness.spec.ts` to import. All 125 existing tests pass unchanged.

Also:
- Add 4 hooks to `__gridpad` in DemoV2.tsx: `getCursorPosition`, `getToolMode`, `isDirty`, `setTextEditMode`.
- Extend `resizeSelected(page, dw, dh, handle?)` to accept an optional handle parameter (default `"br"`). The handle determines which anchor point to drag from:

```typescript
// Handle positions relative to frame:
// tl=(x, y)  tm=(x+w/2, y)  tr=(x+w, y)
// ml=(x, y+h/2)              mr=(x+w, y+h/2)
// bl=(x, y+h) bm=(x+w/2, y+h) br=(x+w, y+h)
```

**Verify:** `npx playwright test e2e/harness.spec.ts` — 125/125.

### Task 2 — Hand-written workflow tests (`e2e/workflows.spec.ts`)

10 tests simulating real user workflows. These exist because the sweep engine can't test multi-step interaction sequences with visual intent (e.g., "drag to rearrange two wireframes"):

1. Open default doc → drag dashboard right → save → reload → all content intact
2. Pure prose → draw box → add label → save → reload → box with label
3. SIMPLE_BOX → type 3 lines above → wireframe pushed down → save round-trips
4. SIMPLE_BOX → resize wider → add label → save → both persist
5. TWO_SEPARATE → drag A past B → drag B up → save → order swapped, both intact
6. LABELED_BOX → drag → type prose → undo prose → undo drag → redo drag → save
7. SIMPLE_BOX → delete → type "replaced" → save → no wire chars
8. NESTED → drill-down to inner → drag inner → drag outer → save → both offset
9. Default doc → save → byte-identical (full default round-trip)
10. Default doc → type new section between wireframes → save → all original + new content

**Verify:** 10/10 pass.

### Task 3 — Sweep engine (`e2e/sweep.spec.ts`)

The core: a function that takes `(fixture, operation, oracleTier)` and runs the test.

**3a. The sweep function:**

```typescript
async function sweep(
  page: Page,
  fixture: { name: string; md: string; tier: "canonical" | "real" | "generated" },
  operation: { name: string; run: (page: Page) => Promise<void> } | null,
  record: SweepRecord[],
) {
  await load(page, fixture.md);
  if (operation) await operation.run(page);
  const output = await save(page);

  // T4: Invariants (always)
  const ghosts = await findGhostsFromPage(page, output);
  const tree = await getFrameTree(page);
  const invariants = checkInvariants(tree);

  // T1: Byte identity (canonical no-edit only)
  const byteExact = !operation && output === fixture.md;

  // T3: Convergence (always)
  await load(page, output);
  const output2 = await save(page);
  const converged = output === output2;

  // T2: Semantic equivalence (edited fixtures)
  // Compare frame count, prose content, position deltas
  const tree2 = await getFrameTree(page);
  const semanticMatch = flattenTree(tree).length === flattenTree(tree2).length;

  record.push({
    fixture: fixture.name,
    operation: operation?.name ?? "none",
    byteExact, semanticMatch, converged,
    ghosts: ghosts.length,
    invariantFailures: invariants.length,
    tier: fixture.tier,
  });

  // Assertions — gate CI
  expect(invariants, `Invariants failed for ${fixture.name}+${operation?.name}`).toEqual([]);
  expect(ghosts, `Ghosts in ${fixture.name}+${operation?.name}`).toEqual([]);
  expect(converged, `Non-convergent: ${fixture.name}+${operation?.name}`).toBe(true);
  if (!operation && fixture.tier === "canonical") {
    expect(byteExact, `Byte mismatch for canonical ${fixture.name}`).toBe(true);
  }
}
```

**3b. Fixture corpus:**

- **Canonical** (13): SIMPLE_BOX, LABELED_BOX, JUNCTION, NESTED, SIDE_BY_SIDE, TWO_SEPARATE, FORM, PURE_PROSE, SHARED_HORIZONTAL, SHARED_VERTICAL, THREE_IN_ROW, GRID_3X2, DASHES_NOT_WIREFRAME
- **Real** (7): DEFAULT_TEXT, EMOJI, ASYMMETRIC_SHARED, WITH_CHILDREN, plus:
  - `MESSY` — trailing spaces, mixed blank lines, prose flush against wire chars
  - `INDENTED` — wireframe at column 5 (not col 0)
  - `INLINE_ANNOTATION` — prose on same row as wireframe: `└────┘  Some note here`
- **Generated** (~18, built at test time): `generateFixture(params)` for key corners:
  - Box count: 1, 3, 5
  - Width: 4 (tiny), 20 (normal), 50 (wide)
  - Nesting: 0, 1, 2 levels
  - Shared walls: none, horizontal, vertical
  - Prose: none, 1 line, 5 lines wrapping
  - Blank lines between prose/wire: 0, 1, 3
  - Special: empty doc, single-char prose "X", no-blank-line adjacency
- **Bug repros** (locked fixtures from fixed bugs): every fixture that triggered a real bug gets added here as a regression test. Currently: `WITH_CHILDREN` (orphaned │), `THREE_IN_ROW` (junction loss), the default doc dashboard drag.

**3c. Operation set (tiered density):**

Three tiers control which operations run in CI vs full sweep:

```typescript
// Tier A (CI — always): 8 representative operations
const TIER_A_OPS = [
  // Drag: 4 directions + extremes
  { name: "drag-right-50",    run: drag(50, 0) },
  { name: "drag-down-80",     run: drag(0, 80) },
  { name: "drag-diagonal-50", run: drag(50, 50) },
  { name: "drag-left-50",     run: drag(-50, 0) },
  // Resize
  { name: "resize-larger",    run: resize(40, 20) },
  { name: "resize-smaller",   run: resize(-30, -20) },
  // Prose
  { name: "type-5-chars",     run: typeAtProse("HELLO") },
  // Delete
  { name: "delete-frame",     run: deleteFirst() },
];

// Tier B (PR — branches): +12 more operations
const TIER_B_OPS = [
  // More drag directions
  { name: "drag-up-50",          run: drag(0, -50) },
  { name: "drag-to-bottom-2000", run: drag(0, 2000) },
  { name: "drag-past-left-500",  run: drag(-500, 0) },
  { name: "drag-sub-pixel-1",    run: drag(1, 0) },
  // Prose operations
  { name: "enter-above",         run: enterAtProse() },
  { name: "backspace-merge",     run: backspaceAtLineStart() },
  { name: "type-50-chars",       run: typeAtProse("A".repeat(50)) },
  { name: "paste-multiline",     run: typeAtProse("line1\nline2\nline3") },
  // Undo/redo
  { name: "undo-after-drag",     run: dragThenUndo(50, 0) },
  { name: "undo-after-type",     run: typeThenUndo("XYZ") },
  // Sequences
  { name: "drag-then-type",      run: dragThenType(50, 0, "MOVED") },
  { name: "type-then-drag",      run: typeThenDrag("TYPED", 50, 0) },
];

// Tier C (full sweep — manual/nightly): +10 more
const TIER_C_OPS = [
  // Circular movement (back to start)
  { name: "circular-drag",       run: circularDrag(50) },
  // Resize extremes
  { name: "resize-to-minimum",   run: resize(-500, -500) },
  { name: "resize-very-large",   run: resize(200, 100) },
  // Shrink then expand back (idempotency)
  { name: "resize-shrink-expand", run: resizeThenResize(-30, -20, 30, 20) },
  // Resize from all 8 handles (app supports tl/tm/tr/ml/mr/bl/bm/br)
  { name: "resize-from-tl",     run: resizeFromHandle("tl", 20, 20) },
  { name: "resize-from-tm",     run: resizeFromHandle("tm", 0, -20) },
  { name: "resize-from-tr",     run: resizeFromHandle("tr", 20, -20) },
  { name: "resize-from-ml",     run: resizeFromHandle("ml", -20, 0) },
  { name: "resize-from-mr",     run: resizeFromHandle("mr", 20, 0) },
  { name: "resize-from-bl",     run: resizeFromHandle("bl", -20, 20) },
  { name: "resize-from-bm",     run: resizeFromHandle("bm", 0, 20) },
  // br already covered by Tier A resize-larger
  // Multiple drags (accumulation)
  { name: "drag-5x-small",       run: repeatDrag(5, 10, 0) },
  // Operation chains
  { name: "drag-resize-type",    run: dragResizeType(50, 0, 30, 20, "COMBO") },
  { name: "delete-undo-drag",    run: deleteUndoThenDrag(50, 0) },
  // Text edit inside frame
  { name: "edit-label-append",   run: editLabelAppend("!") },
  // Multi-frame: operate on second frame
  { name: "drag-second-frame",   run: dragNth(1, 50, 0) },
  // Undo depth
  { name: "undo-3x-redo-2x",    run: multiUndoRedo(3, 2) },
];
```

**Tier selection at runtime:**

```typescript
const ops = TIER_A_OPS;
if (process.env.SWEEP_TIER !== "A") ops.push(...TIER_B_OPS);
if (process.env.SWEEP_TIER === "C") ops.push(...TIER_C_OPS);
```

**3d. The matrix:**

```typescript
for (const fixture of ALL_FIXTURES) {
  test(`sweep: ${fixture.name} no-edit`, async ({ page }) => {
    await sweep(page, fixture, null, results);
  });
  for (const op of ops) {
    test(`sweep: ${fixture.name} + ${op.name}`, async ({ page }) => {
      await sweep(page, fixture, op, results);
    });
  }
}
```

**3d-extra. Enhanced sweep function assertions:**

Beyond the 4 oracle tiers, the sweep function also checks:
- **Frame count preserved** (unless operation is delete): `flattenTree(treeBefore).length === flattenTree(treeAfter).length`
- **Prose order preserved**: prose fragments appear in same relative order before and after
- **Console errors**: `page.on("pageerror")` captures uncaught exceptions — fail if any
- **Position delta correctness** (for drag ops): frame moved by approximately `(dx, dy)` in pixel space

Totals by tier:

| Tier | Fixtures | Operations | Total tests | Runtime (4 workers) |
|------|----------|------------|-------------|---------------------|
| A (CI) | 38 | 8 + no-edit = 9 | 342 | ~3 min |
| B (PR) | 38 | 20 + no-edit = 21 | 798 | ~7 min |
| C (full) | 38 | 30 + no-edit = 31 | 1,178 | ~10 min |

**3e. Multi-cycle convergence:**

For 10 selected fixtures, run multiple edit→save→reload cycles. Three variants:

**Same-operation cycle** (drift detection):
```typescript
test(`multi-cycle-same: ${fixture.name}`, async ({ page }) => {
  let md = fixture.md;
  for (let cycle = 0; cycle < 3; cycle++) {
    await load(page, md);
    await clickFrame(page, 0); await dragSelected(page, 20, 0); await clickProse(page, 5, 5);
    md = await save(page);
    expect(await findGhostsFromPage(page, md)).toEqual([]);
  }
  // Convergence: one more save without edits must be identical
  await load(page, md);
  const final = await save(page);
  expect(final).toBe(md);
});
```

**Different-operation cycle** (state accumulation):
```typescript
test(`multi-cycle-mixed: ${fixture.name}`, async ({ page }) => {
  const ops = [
    async () => { await clickFrame(page, 0); await dragSelected(page, 30, 0); await clickProse(page, 5, 5); },
    async () => { await clickProse(page, 5, 5); await page.keyboard.type("ADDED"); },
    async () => { await clickFrame(page, 0); await resizeSelected(page, 20, 10); await clickProse(page, 5, 5); },
  ];
  let md = fixture.md;
  for (let cycle = 0; cycle < ops.length; cycle++) {
    await load(page, md);
    await ops[cycle]();
    md = await save(page);
    expect(await findGhostsFromPage(page, md)).toEqual([]);
    const tree = await getFrameTree(page);
    expect(checkInvariants(tree)).toEqual([]);
  }
  // Convergence
  await load(page, md);
  expect(await save(page)).toBe(md);
});
```

**Undo across save boundary** (real user footgun):
```typescript
test(`multi-cycle-undo-across-save: ${fixture.name}`, async ({ page }) => {
  await load(page, fixture.md);
  await clickFrame(page, 0); await dragSelected(page, 50, 0); await clickProse(page, 5, 5);
  const afterDrag = await save(page); // save flushes state
  // Now undo — does it undo the drag, or is save a checkpoint?
  await page.keyboard.press("Meta+z");
  const afterUndo = await save(page);
  // Either behavior is acceptable, but it must not crash or corrupt
  expect(await findGhostsFromPage(page, afterUndo)).toEqual([]);
  const tree = await getFrameTree(page);
  expect(checkInvariants(tree)).toEqual([]);
});
```

**3f. Seeded chaos:**

```typescript
test(`chaos: seed-${seed}`, async ({ page }) => {
  const rng = seedRandom(seed);
  const fixture = pick(rng, ALL_FIXTURES);
  await load(page, fixture.md);

  for (let i = 0; i < 15; i++) {
    const op = pick(rng, weightedOps(page)); // bias toward meaningful ops
    try { await op.run(page); } catch { /* some ops may fail gracefully */ }
    // Invariant check after EACH step
    const tree = await getFrameTree(page);
    expect(checkInvariants(tree)).toEqual([]);
  }

  const output = await save(page);
  expect(await findGhostsFromPage(page, output)).toEqual([]);

  // Convergence
  await load(page, output);
  const output2 = await save(page);
  expect(output).toBe(output2);
});
```

Run 5 seeds. Each ~5s. Total chaos: ~25s.

**3g. Results snapshot:**

After all sweep tests complete, write `e2e/results/snapshot.json`:

```json
{
  "timestamp": "2026-04-20T...",
  "total": 380,
  "passed": 378,
  "failures": [
    { "fixture": "...", "operation": "...", "stage": "topology", "symptom": "junction loss" }
  ]
}
```

Check this file into git. Future runs diff against it. New failures = regressions.

**Verify:** All sweep tests pass. Snapshot written.

### Task 4 — P0 gap tests (`e2e/coverage.spec.ts`)

7 specific interaction tests that can't be expressed as fixture×operation sweeps because they test sub-operation behavior (click targeting, cursor movement, mode transitions):

1. Click frame border pixel → selected (hitTest at exact border coords)
2. Click empty canvas → prose cursor set (getCursorPosition non-null)
3. Escape clears prose cursor (getCursorPosition returns null)
4. Click elsewhere exits text edit (getTextEdit returns null, edits preserved)
5. Arrow keys maintain column across prose wraps
6. Type with frame selected → prose unchanged
7. Emoji grapheme navigation (arrow right across 🎉 = 1 step)

**Verify:** 7/7 pass.

## Summary

| Component | Tests (Tier A) | Tests (Tier B) | Tests (Tier C) |
|-----------|----------------|----------------|----------------|
| Existing harness | 125 | 125 | 125 |
| Workflows | 10 | 10 | 10 |
| Sweep: no-edit | 38 | 38 | 38 |
| Sweep: operations | 304 | 760 | 1,140 |
| Sweep: multi-cycle | 30 | 30 | 30 |
| Sweep: chaos (5 seeds) | 5 | 5 | 5 |
| P0 coverage | 7 | 7 | 7 |
| **Total** | **~519** | **~975** | **~1,355** |
| **Runtime (4 workers)** | **~5 min** | **~9 min** | **~12 min** |

Default CI runs Tier A. PRs run Tier B. Full sweep on demand with `SWEEP_TIER=C`.

| File | Changes |
|------|---------|
| `e2e/harness-helpers.ts` | New — extracted helpers, fixtures, oracles |
| `e2e/harness.spec.ts` | Import from helpers (no test changes) |
| `e2e/workflows.spec.ts` | New — 10 workflow tests |
| `e2e/sweep.spec.ts` | New — sweep engine + matrix + chaos + multi-cycle |
| `e2e/coverage.spec.ts` | New — 7 P0 gap tests |
| `e2e/results/snapshot.json` | New — sweep results snapshot |
| `src/DemoV2.tsx` | Add 4 test hooks |

**Execution order:** Task 1 → verify 125/125 → Task 2 → verify 135/135 → Task 3 → verify ~510/~510 → Task 4 → verify ~537/~537. Each task is a commit. Any regression stops the pipeline.
