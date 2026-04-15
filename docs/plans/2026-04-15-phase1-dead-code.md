# Phase 1-2: Dead Code Deletion + Pipeline Merge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Delete ~1300 lines of dead Layer/diff/identity code, remove munkres-js dependency, merge detectRegions+framesFromRegions into scanToFrames.

**Branch:** `feature/dead-code-cleanup` (branch from `main`)

**Test baseline:** 376 passing, 1 skipped (377 total) across 14 test files.

**Commit strategy:** One commit per task. Each task must leave the suite green before
committing.

---

## Critical findings from the audit

Before reading the tasks, internalize these:

1. **`compositeLayers` is NOT fully dead.** `harness.test.ts` imports it and calls it
   directly on `region.layers` in ~15 places. It cannot be deleted in Phase 1 — it
   stays until Phase 2 removes `Region.layers`.

2. **`compositeLayersWithOwnership`** is only in `layers.test.ts`. Safe to delete in
   Phase 1.

3. **`buildTextCells`** (from `layers.ts`) is only in `layers.test.ts`. `DemoV2.tsx`
   has its own local copy at line 263. Safe to delete in Phase 1.

4. **`recomputeBbox`** is only in `layers.test.ts`. Safe to delete in Phase 1.

5. **`munkres.d.ts`** at `src/munkres.d.ts` must be deleted alongside `diff.ts`.

6. **`identity.ts` exports `randomId`** which is not used anywhere except
   `identity.test.ts`. The whole file is dead.

7. **Phase 2 complication:** Once `Region.layers` is removed, `harness.test.ts` must
   be updated to get composited cells a different way. The plan addresses this.

---

## Phase 1 — Dead Code Deletion

### Task 1.1 — Delete diff.ts + diff.test.ts + munkres.d.ts (~630 lines)

**Time estimate:** 3 minutes

**Verify nothing imports diff.ts outside test files:**
```
grep -rn "from.*['\"]./diff['\"]" src/ --include="*.ts" --include="*.tsx"
```
Expected: only `src/diff.test.ts` (and possibly `src/identity.test.ts` transitively
via diff.test.ts). Confirm zero production imports.

**Steps:**

1. Delete files:
   ```
   rm src/diff.ts src/diff.test.ts src/munkres.d.ts
   ```

2. Run tests:
   ```
   npm test
   ```

3. Expected: 376 - 30 passing tests removed (30 `it()` blocks in diff.test.ts).
   Actual count to verify: diff.test.ts has approximately 30 test cases.
   Suite must show no errors, only fewer tests.

4. Commit:
   ```
   git add -A
   git commit -m "chore: delete diff.ts, diff.test.ts, munkres.d.ts (unreachable dead code)"
   ```

---

### Task 1.2 — Delete identity.ts + identity.test.ts (~140 lines)

**Time estimate:** 3 minutes

**Verify nothing imports identity.ts outside test files and diff.ts (now deleted):**
```
grep -rn "from.*['\"]./identity['\"]" src/ --include="*.ts" --include="*.tsx"
```
Expected: only `src/identity.test.ts`. `diff.ts` was the only production importer,
and it was just deleted.

**Steps:**

1. Delete files:
   ```
   rm src/identity.ts src/identity.test.ts
   ```

2. Run tests:
   ```
   npm test
   ```

3. Expected: suite still green, approximately 13 fewer tests (identity.test.ts had
   13 `it()` blocks).

4. Commit:
   ```
   git add -A
   git commit -m "chore: delete identity.ts, identity.test.ts (only used by diff.ts, now deleted)"
   ```

---

### Task 1.3 — Remove munkres-js from package.json

**Time estimate:** 2 minutes

`diff.ts` was the only file importing `munkres-js`. It has been deleted.

**Steps:**

1. Edit `/Users/parijat/dev/gridpad/package.json` — remove the line:
   ```
   "munkres-js": "^1.2.2",
   ```
   from the `"dependencies"` section.

2. Run:
   ```
   npm install
   ```
   This regenerates `package-lock.json` without munkres-js.

3. Run tests:
   ```
   npm test
   ```
   Expected: suite still green (same count as after Task 1.2).

4. Verify removal:
   ```
   grep -r "munkres" node_modules/ 2>/dev/null | head -5
   ```
   Expected: empty output (package no longer installed).

5. Commit:
   ```
   git add package.json package-lock.json
   git commit -m "chore: remove munkres-js dependency (was only used by deleted diff.ts)"
   ```

---

### Task 1.4 — Delete dead exports from layers.ts: mutations + compositing (except compositeLayers)

**Time estimate:** 5 minutes

**What to delete from `src/layers.ts`:**

| Function | Lines | Reason safe to delete |
|----------|-------|----------------------|
| `compositeLayersWithOwnership` | 296–322 | Only `layers.test.ts` imports it |
| `isEffectivelyVisible` | 334–347 | Only `layers.test.ts` imports it |
| `layerToText` | 356–383 | Only `layers.test.ts` imports it |
| `collectDescendants` (private) | 387–406 | Only used by mutation fns being deleted |
| `moveLayer` | 413–429 | Only `layers.test.ts` imports it |
| `moveLayerCascading` | 444–456 | Only `layers.test.ts` imports it |
| `deleteLayer` | 463–467 | Only `layers.test.ts` imports it |
| `toggleVisible` | 474–479 | Only `layers.test.ts` imports it |
| `recomputeBbox` | 483–494 | Only `layers.test.ts` imports it |
| `buildTextCells` | 532–549 | Only `layers.test.ts`; DemoV2 has its own local copy |

**What to KEEP in `src/layers.ts`:**

| Export | Used by |
|--------|---------|
| `LIGHT_RECT_STYLE` | `harness.test.ts`, `corpus.test.ts`, `DemoV2.tsx` (via frame.ts) |
| `RectStyle` (re-export) | `frame.ts`, `regions.ts`, `layers.test.ts` |
| `LayerType` | `layers.test.ts` (via Layer type) |
| `Layer` interface | `regions.ts`, `frame.ts`, `harness.test.ts`, `layers.test.ts` |
| `regenerateCells` | `frame.ts` (createRectFrame, resizeFrame), `harness.test.ts`, `corpus.test.ts` |
| `buildLayersFromScan` | `regions.ts` |
| `buildLineCells` | `frame.ts` (createLineFrame) |
| `compositeLayers` | `harness.test.ts`, `corpus.test.ts`, `layers.test.ts` — NOT deleted until Phase 2 |

**The section comment `// ── Text rendering ─────────────────────────────────────────`**
must also be deleted (it only precedes `layerToText`).

**The section comment `// ── Layer mutations (immutable) ────────────────────────────`**
must also be deleted (it only precedes the deleted mutation functions).

**The section comment `// ── Compositing ────────────────────────────────────────────`**
stays (it precedes `compositeLayers` which is kept).

After deletion, `layers.ts` should be approximately 250 lines (down from 549).

**Steps:**

1. Edit `src/layers.ts` — delete the following line ranges (use the line numbers from
   the current file; verify them with `grep -n` first if needed):
   - Lines 251–322: `// ── Compositing ─...` section header through end of
     `compositeLayersWithOwnership`. STOP before `isEffectivelyVisible` — wait,
     `compositeLayers` (265–289) MUST be kept.

   **Correct delete ranges (verify with Read before editing):**
   - Lines 291–322: `compositeLayersWithOwnership` (including its preceding comment)
   - Lines 324–383: `isEffectivelyVisible` + section comment `// ── Text rendering` + `layerToText`
   - Lines 385–494: section comment `// ── Layer mutations` + `collectDescendants` + `moveLayer` + `moveLayerCascading` + `deleteLayer` + `toggleVisible` + `recomputeBbox`
   - Lines 529–549: `buildTextCells` (including its preceding comment)

2. Verify the file compiles:
   ```
   npx tsc --noEmit
   ```

3. Run tests:
   ```
   npm test
   ```
   Expected: test count drops because `layers.test.ts` tests for the deleted
   functions will now fail to compile. Proceed to Task 1.5.

   > **Note:** Do NOT commit until Task 1.5 also completes — the test file still
   > imports the deleted functions. Tasks 1.4 and 1.5 must be committed together.

---

### Task 1.5 — Remove deleted-function tests from layers.test.ts

**Time estimate:** 5 minutes

The following `describe` blocks in `src/layers.test.ts` test functions deleted in
Task 1.4. Delete them entirely.

**Import line to update** (lines 1–18 of layers.test.ts):

Remove these names from the import:
- `compositeLayersWithOwnership`
- `deleteLayer`
- `isEffectivelyVisible`
- `layerToText`
- `moveLayer`
- `moveLayerCascading`
- `recomputeBbox`
- `buildTextCells`
- `toggleVisible`

Keep these names in the import:
- `buildLayersFromScan`
- `compositeLayers`
- `regenerateCells`
- `buildLineCells`
- `LIGHT_RECT_STYLE`
- `type Layer`

**`describe` blocks to delete entirely:**

1. `describe("layerToText", () => {` at line ~167 — delete to its closing `})` at
   line ~207.

2. `describe("moveLayer", () => {` at line ~208 — delete to its closing `})` at
   line ~258.

3. `describe("non-destructive layering", () => {` at line ~259 — delete to its
   closing `})` at line ~317. (This block uses `moveLayer` + `compositeLayers`.)

4. `describe("compositeLayers DFS with groups", () => {` at line ~396 — delete to
   its closing `})` at line ~444. (Tests group behavior that only matters for
   the deleted mutation functions. `compositeLayers` itself is tested in the
   `describe("layers")` block above.)

5. `describe("isEffectivelyVisible", () => {` at line ~446 — delete to closing `})`.

6. `describe("moveLayerCascading", () => {` at line ~474 — delete to closing `})`.

7. `describe("deleteLayer", () => {` at line ~501 — delete to closing `})`.

8. `describe("toggleVisible", () => {` at line ~530 — delete to closing `})`.

9. `describe("recomputeBbox", () => {` at line ~556 — delete to closing `})`.

10. `describe("buildTextCells", () => {` at line ~622 — delete to closing `})`.

11. `describe("compositeLayersWithOwnership", () => {` at line ~656 — delete to
    closing `})`.

12. `describe("layerToText", () => {` at line ~832 — delete to closing `})`. (This
    is a second `layerToText` describe block near the end of the file.)

**Also delete the inner `describe("verbatim character preservation")` and
`describe("round-trip invariant")` blocks** (lines ~318–395) — these call
`buildLayersFromScan` but then pass layers to `layerToText`. Since `layerToText` is
deleted, these must go too.

After deletion, `layers.test.ts` should be approximately 350 lines (down from 846),
containing tests for: `buildLayersFromScan`, `compositeLayers`, `LIGHT_RECT_STYLE`,
`buildLineCells`, `regenerateCells`.

**Steps:**

1. Edit `src/layers.test.ts` as described above.

2. Verify the file compiles:
   ```
   npx tsc --noEmit
   ```

3. Run tests:
   ```
   npm test
   ```
   Expected: suite green. Test count should be approximately 376 - 30 (diff) - 13
   (identity) - 50 (deleted layers tests) = ~283 passing. The exact count will vary
   slightly — what matters is zero failures, zero TypeScript errors.

4. Commit tasks 1.4 + 1.5 together:
   ```
   git add src/layers.ts src/layers.test.ts
   git commit -m "chore: delete dead layer mutation/compositing exports and their tests"
   ```

---

## Phase 2 — Pipeline Merge

### Task 2.1 — Create `scanToFrames` in a new file

**Time estimate:** 5 minutes

Create `/Users/parijat/dev/gridpad/src/scanToFrames.ts` containing a single exported
function that replaces the `scan → detectRegions → framesFromRegions` call sequence
with one call. This is a pure extraction; no logic changes.

**Signature:**
```typescript
export function scanToFrames(
  text: string,
  charWidth: number,
  charHeight: number,
): {
  frames: Frame[];
  prose: { startRow: number; text: string }[];
  regions: Region[];
}
```

**Implementation:** Call `scan(text)`, then `detectRegions(scanResult)`, then
`framesFromRegions(regions, charWidth, charHeight)`. Return `{ frames, prose, regions }`.
The `regions` field is included because `DemoV2.tsx` stores regions for layout.

**Steps:**

1. Write `src/scanToFrames.ts`:
   ```typescript
   import { scan } from "./scanner";
   import { detectRegions, type Region } from "./regions";
   import { framesFromRegions, type Frame } from "./frame";

   export function scanToFrames(
     text: string,
     charWidth: number,
     charHeight: number,
   ): {
     frames: Frame[];
     prose: { startRow: number; text: string }[];
     regions: Region[];
   } {
     const scanResult = scan(text);
     const regions = detectRegions(scanResult);
     const { frames, prose } = framesFromRegions(regions, charWidth, charHeight);
     return { frames, prose, regions };
   }
   ```

2. Write `src/scanToFrames.test.ts` — write tests FIRST (TDD):
   ```typescript
   import { describe, it, expect, beforeAll, vi } from "vitest";
   import { scanToFrames } from "./scanToFrames";

   // Same canvas mock as other test files
   beforeAll(() => { /* canvas mock */ });

   describe("scanToFrames", () => {
     it("pure prose returns no frames and one prose entry", () => {
       const { frames, prose, regions } = scanToFrames("Hello world", 9.6, 18.4);
       expect(frames).toHaveLength(0);
       expect(prose).toHaveLength(1);
       expect(prose[0].text).toBe("Hello world");
       expect(regions).toHaveLength(1);
       expect(regions[0].type).toBe("prose");
     });

     it("single rect returns one container frame with children", () => {
       const { frames, prose, regions } = scanToFrames(
         "┌─┐\n│ │\n└─┘",
         9.6, 18.4,
       );
       expect(frames).toHaveLength(1);
       expect(prose).toHaveLength(0);
       expect(regions).toHaveLength(1);
       expect(regions[0].type).toBe("wireframe");
     });

     it("prose before and after wireframe returns frames and two prose entries", () => {
       const text = "intro\n┌─┐\n│ │\n└─┘\noutro";
       const { frames, prose } = scanToFrames(text, 9.6, 18.4);
       expect(frames).toHaveLength(1);
       expect(prose).toHaveLength(2);
     });

     it("empty string returns no frames, no prose, no regions", () => {
       const { frames, prose, regions } = scanToFrames("", 9.6, 18.4);
       expect(frames).toHaveLength(0);
       expect(prose).toHaveLength(0);
       expect(regions).toHaveLength(0);
     });
   });
   ```

3. Run tests (they should fail because `scanToFrames.ts` does not exist yet):
   ```
   npm test -- src/scanToFrames.test.ts
   ```

4. Write `src/scanToFrames.ts` (the implementation above).

5. Run tests again — expect green.

6. Commit:
   ```
   git add src/scanToFrames.ts src/scanToFrames.test.ts
   git commit -m "feat: add scanToFrames — single entry point replacing scan+detectRegions+framesFromRegions"
   ```

---

### Task 2.2 — Update callers to use `scanToFrames`

**Time estimate:** 5 minutes

There are two production callers of the three-step pipeline. Update them to use
`scanToFrames`. Tests are the safety net — run after each change.

**Callers to update:**

1. `/Users/parijat/dev/gridpad/src/DemoV2.tsx` — lines 121–122:
   ```typescript
   // BEFORE:
   const regions = detectRegions(scan(text));
   const { frames, prose } = framesFromRegions(regions, cw, ch);

   // AFTER:
   const { frames, prose, regions } = scanToFrames(text, cw, ch);
   ```
   Also update imports: remove `scan`, `detectRegions`, `framesFromRegions` from
   their respective imports (if they are no longer used elsewhere in the file).
   Add `import { scanToFrames } from "./scanToFrames";`.

   **Verify:** Search `DemoV2.tsx` for other uses of `scan`, `detectRegions`,
   `framesFromRegions` before removing their imports.
   ```
   grep -n "scan\|detectRegions\|framesFromRegions" src/DemoV2.tsx
   ```

2. No other production callers — `serialize.test.ts`, `frame.test.ts`,
   `journey.test.ts`, `_crash.test.ts`, `harness.test.ts`, `corpus.test.ts` call
   `detectRegions` and `framesFromRegions` individually. These test files call the
   low-level functions directly and should NOT be changed in this task — they are
   the safety net.

**Steps:**

1. Edit `src/DemoV2.tsx` as described.

2. Run tests:
   ```
   npm test
   ```
   Expected: all green (same count as end of Phase 1).

3. Commit:
   ```
   git add src/DemoV2.tsx
   git commit -m "refactor: DemoV2 uses scanToFrames instead of scan+detectRegions+framesFromRegions"
   ```

---

### Task 2.3 — Remove `Region.layers` and update harness.test.ts

**Time estimate:** 10 minutes

This is the most involved task. `Region.layers?: Layer[]` is the only field that
keeps the `Layer` type alive in runtime code. Once we remove it:
- `regions.ts` no longer imports `Layer` or `buildLayersFromScan`
- `harness.test.ts` must stop calling `compositeLayers(region.layers)` and instead
  use the frame's cells directly via `framesFromRegions`
- `compositeLayers` becomes unused in production code (only in remaining test files)

**Step A: Update `harness.test.ts` to not use `region.layers`**

The tests in `harness.test.ts` that call `compositeLayers(wf.layers!)` do so to
assert that specific characters appear at specific grid positions. The same
information is available from the `Frame` children produced by `framesFromRegions`.

For each occurrence of:
```typescript
const composite = compositeLayers(wf.layers!);
```

Replace with:
```typescript
import { framesFromRegions } from "./frame";
// ...
const { frames } = framesFromRegions([wf], CHAR_W, CHAR_H);
// build a composite from frame cells for assertion purposes
const composite = framesToComposite(frames);
```

However, this requires a helper. A simpler approach: keep `compositeLayers` exported
from `layers.ts` (it's still used in `layers.test.ts`) and instead update `harness.test.ts`
to call `framesFromRegions` for the regions it needs, then assert on `Frame.content.cells`
directly.

**Alternative (preferred) — add a test helper in harness.test.ts:**

Add this helper at the top of `harness.test.ts`:
```typescript
import { framesFromRegions } from "./frame";

/** Convert a wireframe region to a composite cell map for assertion.
 * Replaces compositeLayers(region.layers) after Region.layers is removed. */
function wireframeToComposite(
  region: Region,
  charWidth: number,
  charHeight: number,
): Map<string, string> {
  const { frames } = framesFromRegions([region], charWidth, charHeight);
  const composite = new Map<string, string>();
  for (const container of frames) {
    for (const child of container.children) {
      if (!child.content) continue;
      const baseRow = Math.round(child.y / charHeight);
      const baseCol = Math.round(child.x / charWidth);
      for (const [k, ch] of child.content.cells) {
        const i = k.indexOf(",");
        const r = Number(k.slice(0, i)) + baseRow;
        const c = Number(k.slice(i + 1)) + baseCol;
        composite.set(`${r},${c}`, ch);
      }
    }
  }
  return composite;
}
```

Then replace each `compositeLayers(wf.layers!)` with `wireframeToComposite(wf, CW, CH)`.

**Before doing this**, count and list every occurrence:
```
grep -n "compositeLayers" src/harness.test.ts
```

**Step B: Update `regions.ts` — remove `layers` field from Region**

In `src/regions.ts`:

1. Remove the import: `import { buildLayersFromScan } from "./layers";`
2. Remove the import: `import type { Layer } from "./layers";`
3. Remove `layers?: Layer[];` from the `Region` interface.
4. In `detectRegions`, remove the line `const allLayers = buildLayersFromScan(scanResult);`
5. In the wireframe region construction block, remove the `layers: buildLayersForRegion(allLayers, wf.start, wf.end),` field.
6. Delete the `buildLayersForRegion` function (lines 153–168) — no longer called.
7. Delete the `rebaseCellRows` function (lines 170–182) — only used by `buildLayersForRegion`.

After these deletions, `regions.ts` should be ~130 lines (down from 182).

**Step C: Remove the `layers` field from corpus.test.ts**

```
grep -n "r\.layers\|\.layers" src/corpus.test.ts
```

Any code that accesses `region.layers` in `corpus.test.ts` must be updated
similarly to harness.test.ts. Check and update.

**Step D: Run TypeScript check**
```
npx tsc --noEmit
```

Fix any remaining type errors. `Region` no longer has `layers`, so any code
that accesses `.layers` will be a compile error — which is what we want to find.

**Step E: Run tests**
```
npm test
```
Expected: green. The `region.layers` field is gone; all tests use frame-based
assertions or direct detectRegions output.

**Step F: Commit**
```
git add src/regions.ts src/harness.test.ts src/corpus.test.ts
git commit -m "refactor: remove Region.layers — harness tests use frame cells instead"
```

---

### Task 2.4 — Delete `buildLayersFromScan` and clean up layers.ts imports

**Time estimate:** 3 minutes

After Task 2.3, `buildLayersFromScan` is no longer called by `regions.ts`.
Verify it has no other callers:
```
grep -rn "buildLayersFromScan" src/ --include="*.ts" --include="*.tsx"
```
Expected: only `src/layers.ts` (definition) and `src/layers.test.ts` (tests).

**Steps:**

1. Delete from `src/layers.ts`:
   - The `getGridCell` function (lines 55–60 — private, only used by `buildLayersFromScan`)
   - The `lineCells` function (lines 117–135 — private, only used by `buildLayersFromScan`)
   - The `textCells` function (lines 137–150 — private, only used by `buildLayersFromScan`)
   - The `buildLayersFromScan` export (lines 159–249)

   Also remove the now-unnecessary `import type { Bbox } from "./types";` if `Bbox`
   is no longer used in `layers.ts`. Check: `buildLineCells` still uses `Bbox`, so
   keep it.

   Also remove the `// ── Layer construction ─────────────────────────────────────`
   section comment (around line 47).

2. Delete from `src/layers.test.ts`:
   - `buildLayersFromScan` from the import statement.
   - `describe("buildLayersFromScan", () => { ... })` block (lines ~34–107).

3. Verify:
   ```
   npx tsc --noEmit
   npm test
   ```
   Expected: green.

4. Commit:
   ```
   git add src/layers.ts src/layers.test.ts
   git commit -m "chore: delete buildLayersFromScan and private helpers (no longer called after Region.layers removal)"
   ```

---

### Task 2.5 — Delete `compositeLayers` from layers.ts

**Time estimate:** 3 minutes

After Task 2.4, verify `compositeLayers` is no longer called except in `layers.test.ts`:
```
grep -rn "compositeLayers" src/ --include="*.ts" --include="*.tsx"
```
Expected: only `src/layers.ts` (definition) and `src/layers.test.ts`.
If `harness.test.ts` or `corpus.test.ts` still reference it, go back and fix those first.

**Steps:**

1. Delete from `src/layers.ts`:
   - The `// ── Compositing ─────────────────────────────────────────` section comment
   - The `compositeLayers` function (lines 265–289 in the original; renumbered after
     prior deletions — find by searching for `export function compositeLayers`)
   - The `parseKey` private function (lines 42–45 — only used by `compositeLayers`
     and the deleted `layerToText`/`recomputeBbox`). Double-check it isn't used by
     anything remaining.

2. Delete from `src/layers.test.ts`:
   - `compositeLayers` from the import statement.
   - `describe("compositeLayers", () => { ... })` at line ~109.

3. Verify:
   ```
   npx tsc --noEmit
   npm test
   ```

4. Commit:
   ```
   git add src/layers.ts src/layers.test.ts
   git commit -m "chore: delete compositeLayers — last caller (Region.layers) removed in prior task"
   ```

---

### Task 2.6 — Assess whether Layer type and layers.ts can be deleted entirely

**Time estimate:** 3 minutes

After all prior tasks, check what remains exported from `layers.ts`:

Expected survivors:
- `LIGHT_RECT_STYLE` — used by `harness.test.ts`, `corpus.test.ts`, `frame.ts` (implicitly via scanner)
- `RectStyle` (re-export from scanner) — used by `frame.ts`, `regions.ts` (if still needed)
- `LayerType` — check if still used
- `Layer` interface — check if still used anywhere
- `regenerateCells` — used by `frame.ts`
- `buildLineCells` — used by `frame.ts`

Run:
```
grep -rn "from.*['\"]./layers['\"]" src/ --include="*.ts" --include="*.tsx"
```

If `Layer` and `LayerType` are no longer imported anywhere outside `layers.test.ts`,
delete them from `layers.ts` and clean up `layers.test.ts`.

If `layers.ts` ends up containing only `LIGHT_RECT_STYLE`, `regenerateCells`, and
`buildLineCells`, consider whether to keep it as-is (it serves as a cell utilities
module), rename it to `cellUtils.ts`, or inline the two functions into `frame.ts`.

**Decision rule:**
- If `layers.ts` is ≤60 lines after all deletions: rename to `cellUtils.ts` and
  update imports. One additional commit.
- If `layers.ts` is >60 lines: leave as-is. The name is slightly misleading but the
  code is clean and the file is within size limits.

**Steps:**

1. Run the grep above and assess.

2. If renaming: `git mv src/layers.ts src/cellUtils.ts` and update all imports.

3. Commit:
   ```
   git add -A
   git commit -m "chore: clean up Layer/LayerType remnants after full dead-code removal"
   ```

---

## Completion checklist

Run the following before opening a PR:

```bash
# TypeScript clean compile
npx tsc --noEmit

# Full test suite — must be green, count should be ~283-310 (exact TBD)
npm test

# Build — must succeed
npm run build

# Line count audit
wc -l src/layers.ts src/regions.ts src/diff.ts src/identity.ts 2>/dev/null || true
# diff.ts and identity.ts should report "no such file"
# layers.ts should be <200 lines
# regions.ts should be ~130 lines

# Verify munkres-js is gone
grep -r "munkres" package.json package-lock.json | head -3
# Expected: no matches in package.json; package-lock.json match is OK if
# it only appears in the integrity/resolved fields of other packages' metadata
# (it should not appear at all after npm install)
```

---

## What this does NOT change

- `src/scanner.ts` — untouched
- `src/frame.ts` — untouched (but `framesFromRegions` stays; it is NOT deleted)
- `src/regions.ts` — simplified (Region.layers removed), but `detectRegions` stays
- `src/DemoV2.tsx` — one call site updated (Task 2.2), no logic change
- All Playwright tests — untouched (no behavioral change)
- `npm run dev` behavior — identical to before

---

## Line deletion summary

| File | Before | After | Delta |
|------|--------|-------|-------|
| `src/diff.ts` | 275 | deleted | −275 |
| `src/diff.test.ts` | 357 | deleted | −357 |
| `src/identity.ts` | 47 | deleted | −47 |
| `src/identity.test.ts` | 96 | deleted | −96 |
| `src/munkres.d.ts` | ~5 | deleted | −5 |
| `src/layers.ts` | 549 | ~120 | −429 |
| `src/layers.test.ts` | 846 | ~280 | −566 |
| `src/regions.ts` | 182 | ~130 | −52 |
| `src/harness.test.ts` | 1842 | ~1800 | −42 |
| **Total** | | | **~−1869** |
