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

Also add 4 hooks to `__gridpad` in DemoV2.tsx: `getCursorPosition`, `getToolMode`, `isDirty`, `setTextEditMode`.

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
- **Real** (5): DEFAULT_TEXT, EMOJI, ASYMMETRIC_SHARED, WITH_CHILDREN, plus a "messy" fixture with trailing spaces, mixed blank lines, prose flush against wire chars
- **Generated** (built at test time): `generateFixture({ boxes: N, width: W, height: H, nesting: D, sharedWalls: S, proseLines: P })` for key parameter combinations. ~20 generated fixtures covering the interesting corners of the space.

**3c. Operation set:**

```typescript
const OPERATIONS = [
  { name: "drag-right-50", run: async (p) => { await clickFrame(p, 0); await dragSelected(p, 50, 0); await clickProse(p, 5, 5); } },
  { name: "drag-down-80", run: ... },
  { name: "drag-left-50", run: ... },
  { name: "resize-wider-40", run: ... },
  { name: "resize-smaller-30", run: ... },
  { name: "type-5-chars", run: async (p) => { await clickProse(p, 5, 5); await p.keyboard.type("HELLO"); } },
  { name: "enter-above", run: async (p) => { await clickProse(p, 5, 5); await p.keyboard.press("Enter"); } },
  { name: "delete-frame", run: async (p) => { await clickFrame(p, 0); await p.keyboard.press("Delete"); } },
  { name: "undo-after-drag", run: async (p) => { await clickFrame(p, 0); await dragSelected(p, 50, 0); await clickProse(p, 5, 5); await p.keyboard.press("Meta+z"); } },
];
```

**3d. The matrix:**

```typescript
for (const fixture of ALL_FIXTURES) {
  // No-edit round-trip
  test(`sweep: ${fixture.name} no-edit`, async ({ page }) => {
    await sweep(page, fixture, null, results);
  });
  // Each operation
  for (const op of OPERATIONS) {
    test(`sweep: ${fixture.name} + ${op.name}`, async ({ page }) => {
      await sweep(page, fixture, op, results);
    });
  }
}
```

Total: ~38 fixtures × (1 no-edit + 9 operations) = ~380 test cases. With 4 workers at ~2s each: ~3 minutes.

**3e. Multi-cycle convergence:**

For 10 selected fixtures, run 3 edit→save→reload cycles:

```typescript
test(`multi-cycle: ${fixture.name}`, async ({ page }) => {
  let md = fixture.md;
  for (let cycle = 0; cycle < 3; cycle++) {
    await load(page, md);
    await clickFrame(page, 0); await dragSelected(page, 20, 0); await clickProse(page, 5, 5);
    md = await save(page);
    expect(await findGhostsFromPage(page, md)).toEqual([]);
  }
  // Final convergence check
  await load(page, md);
  const final = await save(page);
  expect(final).toBe(md);
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

| Component | Tests | Runtime (4 workers) |
|-----------|-------|---------------------|
| Existing harness | 125 | ~2 min |
| Workflows | 10 | ~15s |
| Sweep: no-edit | ~38 | ~20s |
| Sweep: operations | ~342 | ~3 min |
| Sweep: multi-cycle | 10 | ~30s |
| Sweep: chaos | 5 | ~25s |
| P0 coverage | 7 | ~15s |
| **Total** | **~537** | **~7 min** |

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
