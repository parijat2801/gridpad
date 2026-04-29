# Selection Hierarchy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore the four-level selection model (band → wireframe → shape → child) under eager bands. Fix the regression where clicking a labeled rect's center selects the inner text-label instead of the rect, and add ctrl/cmd+click to bypass the drill-down hierarchy.

**Architecture:** `createEditorStateUnified` keeps scanner-produced multi-shape containers as `WIREFRAME` frames inside the band (single shapes wrap directly — Figma-style). Selection drill-down is a pure function of (hit, current-selection, ancestor chain, ctrl-held). Mutation paths use a deep `findContainingBandDeep` ancestor walk and a band-relative coordinate helper instead of assuming the immediate parent IS the band. A post-pass `recomputeWireframeBounds` keeps wireframe bboxes tight as children move/resize.

**Tech Stack:** TypeScript, React 19, CodeMirror 6 state management, Vite, Vitest, Playwright. Test setup at `src/editorState.test.ts` already mocks `document.createElement('canvas')` for headless runs.

**Design doc:** `docs/plans/2026-04-29-selection-hierarchy.md` (reviewed twice by Gemini, GO with refinements).

**Working directory:** `~/dev/gridpad/.claude/worktrees/unified-document`

**Branch:** `feature/add-frame-fix` (continue committing here).

**Commands:**
- `npx vitest run --reporter=dot` — unit tests
- `npx vitest run src/editorState.test.ts -t "PATTERN"` — single test by name
- `npx playwright test e2e/harness.spec.ts -g "PATTERN" --workers=1` — single harness test
- `npm run build` — typecheck + production build

**Baseline before starting:** vitest 518/0 (drifted up from the planned 509), build clean, harness 119 pass / 25 fail.

---

## Phase boundaries (for `/clear` between phases)

This plan executes in **three phases** with a context clear between each. The skill (`tdd-plan-executor`) runs once per phase: Gemini reviews the plan slice → sonnet writes failing tests → review tests → sonnet implements → verify GREEN → Gemini reviews diff → fix findings → commit. **One Gemini-diff-review per phase, not per task.**

### Phase A — pure helpers (Tasks 1-4)

`findPath`, `findContainingBandDeep`, `getBandRelativeRow/Col`, `resolveSelectionTarget`. All exported pure functions. No callers changed yet. Strictly additive — existing tests stay green.

**Exit criteria:** vitest ≥ 534 PASS / 0 FAIL. Build clean. 4 commits on `feature/add-frame-fix`.

**Handoff to Phase B:** memory `phase_a_complete.md` records the 4 helper signatures and the new vitest count.

### Phase B — wire selection + restore wireframe layer (Tasks 5-8)

Click handler uses `resolveSelectionTarget`; drag clamp uses band-relative coords; `createEditorStateUnified` keeps multi-shape containers as inner WIREFRAME frames; fix tests broken by the layer change. **This is the structural-break phase** — Task 7 explicitly breaks tests that Task 8 then fixes.

**Exit criteria:** vitest ≥ 537 PASS / 0 FAIL (Task 8 brings count back up). Build clean. Harness ≤ 22 fail (down from 25 — at minimum the 5 session-introduced failures clear). Commits per task.

**Handoff to Phase C:** memory `phase_b_complete.md` records the new tree shape (`band → wireframe → [shape, ...]` for multi-shape, `band → shape` for solo) and the harness delta.

### Phase C — nested-mutation paths + verification (Tasks 9-15)

`recomputeWireframeBounds` post-pass; push physics uses band-relative; reparent cascades through wireframes; `applyAddChildFrame` band-grow; `getFrameRects` triple-sum; round-trip serialization test; final harness sweep.

**Exit criteria:** vitest ≥ 545 PASS / 0 FAIL. Build clean. Harness ≤ 20 fail. Update `HANDOFF.md`.

**Handoff to optional Phase D:** memory `phase_c_complete.md` records final harness count + which baseline failures remain. Phase D is Task 16 (cleanup) — only run after Phase C confirms the suite is stable.

### Phase D — cleanup (Task 16, optional)

Remove magenta debug overlay, `?fixture=` URL loader, investigative diagnostic tests, factor canvas mock to `testSetup.ts`. Each sub-step is a separate commit so reverts are surgical.

**Exit criteria:** vitest count drops by ~9 (diagnostic tests removed), all green. Build clean.

---

## Resuming after `/clear`

When a new conversation begins mid-plan:

1. Read `~/.claude/projects/-Users-parijat-dev-gridpad/memory/MEMORY.md` for the latest `phase_*_complete` pointer.
2. Open this file (`docs/plans/2026-04-29-selection-hierarchy-impl.md`) and jump to the next phase's task range.
3. Working directory: `~/dev/gridpad/.claude/worktrees/unified-document`. Branch: `feature/add-frame-fix`.
4. Run `npx vitest run --reporter=dot 2>&1 | tail -3` to confirm the baseline matches the previous phase's exit criteria before starting.

---

## Task 1: `findPath` helper (top-down DFS returning ancestor chain)

**Files:**
- Modify: `src/editorState.ts` — add helper near `findContainingBand` at line 1402.
- Test: `src/editorState.test.ts` — append a new `describe` block at end.

**Why this first:** every later task consumes `findPath`. Build the bedrock once.

**Step 1: Write the failing test**

Append at end of `src/editorState.test.ts` (after the closing `});` on line ~2891):

```typescript
// ── Selection hierarchy helpers ────────────────────────────────────────

describe("findPath", () => {
  beforeAll(() => {
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() => ({
          font: "", fillStyle: "", textBaseline: "", fillText: () => {},
          measureText: (text: string) => ({
            width: text.length * 9.6,
            actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4,
          }),
        })) as unknown as HTMLCanvasElement["getContext"];
      }
      return el;
    });
  });

  it("returns root→target chain for nested frame", () => {
    const text = "T", "", "┌──┐", "│ X│", "└──┘", "", "End"].join("\n").replace(/^/, "Title");
    // Build a manual tree to keep test self-contained.
    const leaf = createTextFrame({ text: "X", row: 0, col: 0, charWidth: 9.6, charHeight: 18 });
    const rect: Frame = {
      ...createRectFrame({ gridW: 4, gridH: 3, style: "single", charWidth: 9.6, charHeight: 18 }),
      children: [leaf],
    };
    const chain = findPath([rect], leaf.id);
    expect(chain.map(f => f.id)).toEqual([rect.id, leaf.id]);
  });

  it("returns empty array when target not present", () => {
    const rect = createRectFrame({ gridW: 4, gridH: 3, style: "single", charWidth: 9.6, charHeight: 18 });
    expect(findPath([rect], "no-such-id")).toEqual([]);
  });

  it("returns single-element chain for top-level match", () => {
    const rect = createRectFrame({ gridW: 4, gridH: 3, style: "single", charWidth: 9.6, charHeight: 18 });
    const chain = findPath([rect], rect.id);
    expect(chain).toEqual([rect]);
  });
});
```

Add `findPath` to the `import` block at the top:

```typescript
// existing imports from "./editorState" — add findPath:
import {
  // ... existing names ...
  findPath,
} from "./editorState";
```

**Step 2: Run the test to verify it fails**

```bash
cd ~/dev/gridpad/.claude/worktrees/unified-document
npx vitest run src/editorState.test.ts -t "findPath" --reporter=verbose 2>&1 | tail -20
```

Expected: 3 FAIL with `findPath is not defined` or import error.

**Step 3: Write minimal implementation**

In `src/editorState.ts`, add immediately above `findContainingBand` (line ~1402):

```typescript
/** Top-down DFS returning the ancestor chain root→target (inclusive on both
 * ends), or `[]` if `targetId` is not in the tree. Reused by selection-target
 * resolution and band-relative coordinate accumulation. */
export function findPath(frames: Frame[], targetId: string): Frame[] {
  for (const f of frames) {
    if (f.id === targetId) return [f];
    if (f.children.length > 0) {
      const inChild = findPath(f.children, targetId);
      if (inChild.length > 0) return [f, ...inChild];
    }
  }
  return [];
}
```

**Step 4: Run the test to verify it passes**

```bash
npx vitest run src/editorState.test.ts -t "findPath" --reporter=verbose 2>&1 | tail -10
```

Expected: 3 PASS, 0 FAIL.

**Step 5: Confirm full suite still green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: 512 PASS / 0 FAIL (was 509; +3 from this task).

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: findPath helper for ancestor-chain lookup

$(cat <<'EOF'
Top-down DFS returning the root→target ancestor chain. Reused next by
resolveSelectionTarget (drill-down) and getBandRelativeRow/Col (coord math
across nested wireframe layers).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `findContainingBandDeep` (recursive ancestor walk)

**Files:**
- Modify: `src/editorState.ts:1402-1408` — replace `findContainingBand`.
- Test: `src/editorState.test.ts` — extend the helpers describe block.

**Step 1: Write the failing test**

In `src/editorState.test.ts`, add to the existing helpers `describe`:

```typescript
describe("findContainingBandDeep", () => {
  beforeAll(() => {
    // (canvas mock — same as findPath block; OK to copy or factor out)
  });

  it("finds band when frame is an immediate child", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    expect(findContainingBandDeep(getFrames(state), rect.id)?.id).toBe(band.id);
  });

  it("finds band when frame is a grandchild (rect inside text-label-bearing rect)", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const textChild = rect.children.find(c => c.content?.type === "text")!;
    expect(findContainingBandDeep(getFrames(state), textChild.id)?.id).toBe(band.id);
  });

  it("returns null when frame id is absent", () => {
    const md = ["Hello"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    expect(findContainingBandDeep(getFrames(state), "no-such-id")).toBeNull();
  });
});
```

Add `findContainingBandDeep` to the imports.

**Step 2: Run the test to verify it fails**

```bash
npx vitest run src/editorState.test.ts -t "findContainingBandDeep" --reporter=verbose 2>&1 | tail -20
```

Expected: 3 FAIL with `findContainingBandDeep is not defined`.

**Step 3: Write minimal implementation**

In `src/editorState.ts`, REPLACE lines 1402-1408 entirely:

```typescript
/** Find the band ancestor of `frameId`, walking the full tree (any depth).
 * Replaces the immediate-children-only `findContainingBand`. */
export function findContainingBandDeep(frames: Frame[], frameId: string): Frame | null {
  const path = findPath(frames, frameId);
  for (const f of path) {
    if (f.isBand) return f;
  }
  return null;
}
```

Search for any other callers of the old `findContainingBand` and update them:

```bash
grep -n "findContainingBand[^D]" src/editorState.ts
```

Expected callers:
- editorState.ts:613 (resize push physics — `findContainingBand(startFrames, e.value.id)`)
- editorState.ts:1341 (`applyReparentFrame` — `findContainingBand(getFrames(state), frameId)`)

Replace each `findContainingBand` call with `findContainingBandDeep`.

**Step 4: Run the test to verify it passes**

```bash
npx vitest run src/editorState.test.ts -t "findContainingBandDeep" --reporter=verbose 2>&1 | tail -10
```

Expected: 3 PASS.

**Step 5: Confirm full suite still green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: 515 PASS / 0 FAIL.

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "refactor: findContainingBand → findContainingBandDeep (recursive)

$(cat <<'EOF'
The single-level findContainingBand assumed shape's parent IS the band.
The 4-level model (band → wireframe → shape → child) breaks that — fix
the lookup to walk the full ancestor chain via findPath.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `getBandRelativeRow` / `getBandRelativeCol` helpers

**Files:**
- Modify: `src/editorState.ts` — add helpers near `findContainingBandDeep`.
- Test: `src/editorState.test.ts` — extend helpers describe block.

**Step 1: Write the failing test**

```typescript
describe("getBandRelativeRow / getBandRelativeCol", () => {
  // (canvas mock)

  it("immediate child of band: returns child.gridRow/gridCol", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    expect(getBandRelativeRow(rect.id, band.id, getFrames(state))).toBe(rect.gridRow);
    expect(getBandRelativeCol(rect.id, band.id, getFrames(state))).toBe(rect.gridCol);
  });

  it("grandchild via rect: sums rect.gridRow + textChild.gridRow", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const text = rect.children.find(c => c.content?.type === "text")!;
    expect(getBandRelativeRow(text.id, band.id, getFrames(state))).toBe(rect.gridRow + text.gridRow);
    expect(getBandRelativeCol(text.id, band.id, getFrames(state))).toBe(rect.gridCol + text.gridCol);
  });

  it("returns 0 if frameId === bandId (degenerate)", () => {
    const md = ["Title", "", "┌────┐", "│ X  │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    expect(getBandRelativeRow(band.id, band.id, getFrames(state))).toBe(0);
    expect(getBandRelativeCol(band.id, band.id, getFrames(state))).toBe(0);
  });

  it("throws when bandId is not an ancestor of frameId", () => {
    const md = ["Title", "", "┌────┐", "│ X  │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    expect(() => getBandRelativeRow("nonexistent", band.id, getFrames(state))).toThrow();
  });
});
```

Add `getBandRelativeRow`, `getBandRelativeCol` to the imports.

**Step 2: Run the test to verify it fails**

```bash
npx vitest run src/editorState.test.ts -t "getBandRelative" --reporter=verbose 2>&1 | tail -20
```

Expected: 4 FAIL with `getBandRelativeRow is not defined`.

**Step 3: Write minimal implementation**

In `src/editorState.ts`, add immediately below `findContainingBandDeep`:

```typescript
/** Sum gridRow offsets along the path from `bandId` (exclusive) to `frameId`
 * (inclusive). Throws if `frameId` is not in the tree. Returns 0 when
 * `frameId === bandId`. Used by drag clamp + push physics to compute a
 * shape's true band-relative position through any number of intermediate
 * wireframe layers. */
export function getBandRelativeRow(
  frameId: string,
  bandId: string,
  frames: Frame[],
): number {
  if (frameId === bandId) return 0;
  const path = findPath(frames, frameId);
  if (path.length === 0) {
    throw new Error(`getBandRelativeRow: frame ${frameId} not found`);
  }
  const bandIdx = path.findIndex(f => f.id === bandId);
  // If band not on path, sum from root (treat as if shape lives directly
  // under the band — caller's responsibility to ensure the band is an ancestor).
  const startIdx = bandIdx >= 0 ? bandIdx + 1 : 0;
  let sum = 0;
  for (let i = startIdx; i < path.length; i++) sum += path[i].gridRow;
  return sum;
}

export function getBandRelativeCol(
  frameId: string,
  bandId: string,
  frames: Frame[],
): number {
  if (frameId === bandId) return 0;
  const path = findPath(frames, frameId);
  if (path.length === 0) {
    throw new Error(`getBandRelativeCol: frame ${frameId} not found`);
  }
  const bandIdx = path.findIndex(f => f.id === bandId);
  const startIdx = bandIdx >= 0 ? bandIdx + 1 : 0;
  let sum = 0;
  for (let i = startIdx; i < path.length; i++) sum += path[i].gridCol;
  return sum;
}
```

**Step 4: Run the test to verify it passes**

```bash
npx vitest run src/editorState.test.ts -t "getBandRelative" --reporter=verbose 2>&1 | tail -10
```

Expected: 4 PASS.

**Step 5: Confirm full suite still green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: 519 PASS / 0 FAIL.

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: getBandRelativeRow/Col coord helpers

$(cat <<'EOF'
gridRow/gridCol are parent-relative (wrapAsBand rebases children). With a
wireframe layer between band and shape, comparisons against band bounds
must first sum the chain of relative offsets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `resolveSelectionTarget` (selection drill-down rule)

**Files:**
- Modify: `src/editorState.ts` — add helper near `findPath`.
- Test: `src/editorState.test.ts` — extend helpers describe block.

**Step 1: Write the failing test**

```typescript
describe("resolveSelectionTarget", () => {
  // (canvas mock)
  const cw = 9.6, ch = 18;
  const SOLO = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");

  it("first click on text-label child of solo rect: selects rect (drill-down outermost)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const text = rect.children.find(c => c.content?.type === "text")!;
    expect(resolveSelectionTarget(text, null, getFrames(state), false)).toBe(rect.id);
  });

  it("repeat click while rect is selected: drills to text-label", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const text = rect.children.find(c => c.content?.type === "text")!;
    expect(resolveSelectionTarget(text, rect.id, getFrames(state), false)).toBe(text.id);
  });

  it("ctrl+click on text-label: selects text directly (bypass)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const text = rect.children.find(c => c.content?.type === "text")!;
    expect(resolveSelectionTarget(text, null, getFrames(state), true)).toBe(text.id);
  });

  it("hit IS the rect (not the text): selects rect with no drill (already outermost)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    expect(resolveSelectionTarget(rect, null, getFrames(state), false)).toBe(rect.id);
  });

  it("hit is itself a band: returns null (bands not selectable)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    expect(resolveSelectionTarget(band, null, getFrames(state), false)).toBeNull();
  });

  it("ctrl+click on a band: still returns null (bands not selectable)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    expect(resolveSelectionTarget(band, null, getFrames(state), true)).toBeNull();
  });
});
```

Add `resolveSelectionTarget` to the imports.

**Step 2: Run the test to verify it fails**

```bash
npx vitest run src/editorState.test.ts -t "resolveSelectionTarget" --reporter=verbose 2>&1 | tail -20
```

Expected: 6 FAIL with `resolveSelectionTarget is not defined`.

**Step 3: Write minimal implementation**

In `src/editorState.ts`, add below the `findPath` helper:

```typescript
/** Compute the selection target for a click hit, given the current
 * selection and whether ctrl/cmd is held.
 *
 * Rules:
 * - Bands are never selectable; if `hit` is a band → return null.
 * - With ctrl/cmd held → return `hit.id` directly (bypass drill-down).
 * - Otherwise build the non-band ancestor chain `[outermost, ..., hit]`
 *   and: if `currentSelectedId` is one of `chain[0..n-2]`, drill one level
 *   deeper (return `chain[indexOf+1].id`); else return `chain[0].id`.
 */
export function resolveSelectionTarget(
  hit: Frame,
  currentSelectedId: string | null,
  frames: Frame[],
  ctrlHeld: boolean,
): string | null {
  if (hit.isBand) return null;
  if (ctrlHeld) return hit.id;
  const path = findPath(frames, hit.id);
  const chain = path.filter(f => !f.isBand);
  if (chain.length === 0) return null;
  if (currentSelectedId !== null) {
    const idx = chain.findIndex(f => f.id === currentSelectedId);
    if (idx >= 0 && idx < chain.length - 1) {
      return chain[idx + 1].id;
    }
  }
  return chain[0].id;
}
```

**Step 4: Run the test to verify it passes**

```bash
npx vitest run src/editorState.test.ts -t "resolveSelectionTarget" --reporter=verbose 2>&1 | tail -10
```

Expected: 6 PASS.

**Step 5: Confirm full suite still green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: 525 PASS / 0 FAIL.

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: resolveSelectionTarget — drill-down + ctrl+click bypass

$(cat <<'EOF'
First click selects the outermost non-band ancestor of the hit; repeat
clicks drill one level deeper; ctrl/cmd+click bypasses drill-down and
selects whatever is directly under the cursor. Bands are never selectable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Click handler uses `resolveSelectionTarget`

**Files:**
- Modify: `src/DemoV2.tsx:482, 529-540` — replace `hitContainer` logic with the new resolver.

**Step 1: Write a failing harness test that reproduces the wall-stack-vert bug**

The existing `e2e/harness.spec.ts:2357` ("stack two same-width boxes vertically") already fails. We use it as our RED. Verify:

```bash
npx playwright test e2e/harness.spec.ts -g "stack two same-width" --workers=1 --reporter=line 2>&1 | tail -10
```

Expected: FAIL with "expected 'Bottom' to be in saved markdown".

**Step 2: Update click handler**

In `src/DemoV2.tsx`, edit imports near line 19 to include the new helper:

```typescript
import {
  // ... existing names ...
  resolveSelectionTarget,
} from "./editorState";
```

Then replace `src/DemoV2.tsx:529-540` (the `hitContainer` / `wouldDrillDown` / `targetId` block):

```typescript
// Resolve selection target via the drill-down rule. Ctrl/cmd held →
// bypass drill-down and select the deepest hit directly. Bands are
// never selectable; resolveSelectionTarget returns null in that case.
const ctrlHeld = e.ctrlKey || e.metaKey;
const targetId = hit
  ? resolveSelectionTarget(hit, currentSelectedId, framesRef.current, ctrlHeld)
  : null;
const wouldDrillDown = false; // drill-down is now handled inside resolveSelectionTarget
```

The `wouldDrillDown` flag was only consumed by the deferred-drill-down branch in `onMouseUp` (DemoV2.tsx:702). With drill-down baked into `resolveSelectionTarget`, that branch becomes dead. Remove its uses:

In `src/DemoV2.tsx:562`, remove `pendingDrillDownId: wouldDrillDown ? hit.id : undefined,` — keep the surrounding `dragRef.current = { ... }` assignment but drop that one field.

In `src/DemoV2.tsx:701-707`, remove the `if (!dragRef.current.hasMoved && dragRef.current.pendingDrillDownId) { ... }` block entirely.

In the `DragState` type (search for `pendingDrillDownId`), remove the field.

**Step 3: Re-run the failing harness test**

```bash
npx playwright test e2e/harness.spec.ts -g "stack two same-width" --workers=1 --reporter=line 2>&1 | tail -10
```

Expected: PASS (or at least NEW failure mode — the click now selects the rect, drag moves the rect, but other issues from later tasks may surface).

**Step 4: Confirm vitest still green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: 525 PASS / 0 FAIL.

**Step 5: Confirm typecheck/build clean**

```bash
npm run build 2>&1 | tail -5
```

Expected: clean (no TS errors from removed `pendingDrillDownId`).

**Step 6: Commit**

```bash
git add src/DemoV2.tsx
git commit -m "feat: click handler uses resolveSelectionTarget

$(cat <<'EOF'
First click on a shape selects the outermost non-band ancestor; repeat
clicks drill one level deeper; ctrl/cmd+click selects the deepest hit
directly. Removes the pendingDrillDownId mechanism — drill-down is now
synchronous in resolveSelectionTarget, no need to defer to mouseup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Drag clamp uses band-relative coords + deep band lookup

**Files:**
- Modify: `src/DemoV2.tsx:664-682` — replace `parent.isBand` clamp.

**Step 1: Write a failing test**

Append to `src/editorState.test.ts`:

```typescript
describe("drag clamp through wireframe layer", () => {
  // (canvas mock)
  const cw = 9.6, ch = 18;

  it("dragging a deeply-nested rect against the band wall clamps at the band", () => {
    // band(gH=4) → rect (gridRow=0, gridH=4) → text-child
    // Drag the rect dRow=-3 (would go above band): clamped to 0.
    const md = ["Title", "", "┌────┐", "│  X │", "│    │", "└────┘", "", "End"].join("\n");
    let state = createEditorStateUnified(md, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];

    // Pre-condition: rect is at gridRow=0 inside band.
    expect(rect.gridRow).toBe(0);

    // Apply move with would-be dRow=-3. Drag clamp logic should clamp
    // this to 0 because rect is already at band's top.
    const cband = findContainingBandDeep(getFrames(state), rect.id)!;
    const minDRow = -getBandRelativeRow(rect.id, cband.id, getFrames(state));
    expect(minDRow).toBe(0);
  });
});
```

**Step 2: Run the test to verify it passes (sanity)**

```bash
npx vitest run src/editorState.test.ts -t "drag clamp through wireframe" --reporter=verbose 2>&1 | tail -10
```

Expected: PASS — this test only verifies the helper math, not the full handler. The handler change happens next.

**Step 3: Update drag handler in `src/DemoV2.tsx:664-682`**

Replace:

```typescript
const parent = findParentFrame(framesRef.current, drag.frameId);
const effects: StateEffect<unknown>[] = [];
if (parent && parent.isBand) {
  const child = found.frame;
  const minDRow = -child.gridRow;
  const maxDRow = parent.gridH - child.gridH - child.gridRow;
  const minDCol = -child.gridCol;
  const maxDCol = parent.gridW - child.gridW - child.gridCol;
  // ...
```

With (band-relative coordinates):

```typescript
const containingBand = findContainingBandDeep(framesRef.current, drag.frameId);
const effects: StateEffect<unknown>[] = [];
if (containingBand) {
  const child = found.frame;
  const bandRow = getBandRelativeRow(drag.frameId, containingBand.id, framesRef.current);
  const bandCol = getBandRelativeCol(drag.frameId, containingBand.id, framesRef.current);
  const minDRow = -bandRow;
  const maxDRow = containingBand.gridH - child.gridH - bandRow;
  const minDCol = -bandCol;
  const maxDCol = containingBand.gridW - child.gridW - bandCol;
  // ...
```

The rest of the block (`clampedDRow`, `residualDRow`, the `effects.push(moveFrameEffect.of({ id: parent.id, ... }))`) needs `parent.id` updated to `containingBand.id`:

```typescript
if (residualDRow !== 0) {
  effects.push(moveFrameEffect.of({ id: containingBand.id, dCol: 0, dRow: residualDRow, charWidth: cw, charHeight: ch }));
}
```

Add `findContainingBandDeep`, `getBandRelativeRow`, `getBandRelativeCol` to the import from `./editorState` if not already there.

**Step 4: Run the wall-stack-vert harness test**

```bash
npx playwright test e2e/harness.spec.ts -g "stack two same-width" --workers=1 --reporter=line 2>&1 | tail -10
```

Expected: PASS.

**Step 5: Run vitest**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: 526 PASS / 0 FAIL.

**Step 6: Run full harness suite**

```bash
npx playwright test e2e/harness.spec.ts --reporter=line --workers=4 2>&1 | tail -5
```

Expected: 119+ PASS, ≤25 FAIL — should be ≤20 if multiple session-introduced failures clear together.

**Step 7: Commit**

```bash
git add src/DemoV2.tsx src/editorState.test.ts
git commit -m "feat: drag clamp uses band-relative coords

$(cat <<'EOF'
With a wireframe layer between band and shape, the drag clamp must
compute bounds against the band, not the immediate parent. Switch from
parent.isBand check to findContainingBandDeep + getBandRelativeRow/Col.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Restore wireframe layer in `createEditorStateUnified`

**Files:**
- Modify: `src/editorState.ts:889-965` — keep `content === null` containers as inner WIREFRAME frames.
- Test: `src/editorState.test.ts` — add tree-shape-after-load tests.

**Step 1: Write a failing test**

Append to `src/editorState.test.ts`:

```typescript
describe("createEditorStateUnified — 4-level tree shape", () => {
  // (canvas mock)
  const cw = 9.6, ch = 18;

  it("solo labeled rect: tree is band → rect → text (3 levels, no wireframe wrap)", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, cw, ch);
    const top = getFrames(state);
    expect(top.length).toBe(1);
    const band = top[0];
    expect(band.isBand).toBe(true);
    expect(band.children.length).toBe(1);
    const rect = band.children[0];
    expect(rect.content?.type).toBe("rect");
    // CRITICAL: rect is a direct child of the band — NO wireframe wrap.
    expect(rect.children.some(c => c.content?.type === "text")).toBe(true);
  });

  it("multi-shape composite: tree is band → wireframe → [rect, line] (4 levels)", () => {
    // Two adjacent shapes that scanner groups via groupIntoContainers.
    // Format: a rect with a line directly beside it, scanner emits a
    // container.
    const md = [
      "Title", "",
      "┌────┐  ───────",
      "│ Hi │",
      "└────┘", "",
      "End",
    ].join("\n");
    const state = createEditorStateUnified(md, cw, ch);
    const top = getFrames(state);
    expect(top.length).toBe(1);
    const band = top[0];
    expect(band.isBand).toBe(true);
    // Band's children should be a single wireframe container, not
    // [rect, line] siblings directly.
    expect(band.children.length).toBe(1);
    const wireframe = band.children[0];
    expect(wireframe.isBand).toBeFalsy();
    expect(wireframe.content).toBeNull(); // wireframe = content-null container
    expect(wireframe.children.length).toBeGreaterThanOrEqual(2);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
npx vitest run src/editorState.test.ts -t "4-level tree shape" --reporter=verbose 2>&1 | tail -15
```

Expected: 1 PASS (solo case already correct), 1 FAIL (multi-shape: band's children are [rect, line], not a wireframe).

**Step 3: Modify `createEditorStateUnified` (editorState.ts:936-962)**

Replace the `wrapped` map block:

```typescript
const wrapped: Frame[] = frames.map((f) => {
  if (f.content === null) {
    // Multi-shape composite: keep `f` as the wireframe layer, and wrap
    // it inside a band. Children stay parent-relative to the wireframe;
    // the band's geometry comes from f's bounds.
    const wireframe: Frame = {
      ...f,
      gridRow: 0,                    // wireframe is at band-relative 0,0
      gridCol: 0,
      x: 0,
      y: 0,
      docOffset: 0,                  // band owns the claim, not wireframe
      lineCount: 0,
    };
    // wrapAsBand will set docOffset/lineCount on the band itself.
    const band = wrapAsBand([{ ...f }], charWidth, charHeight, docWidthCols);
    band.children = [wireframe];     // replace flat-children layout
    band.docOffset = f.docOffset;
    band.lineCount = f.lineCount > 0 ? f.lineCount : band.gridH;
    return band;
  }
  // Solo claiming frame — wrap as a band with this frame as the only
  // child. (Unchanged from previous behavior.)
  const band = wrapAsBand([f], charWidth, charHeight, docWidthCols);
  if (f.lineCount > 0) band.lineCount = f.lineCount;
  if (f.docOffset > 0 && band.docOffset === 0) band.docOffset = f.docOffset;
  return band;
});
```

Hmm — `wrapAsBand([{...f}])` rebases f's children with `f.gridRow - minRow`. For our wireframe layer we want the wireframe at band-relative (0,0) and its children at wireframe-relative coords matching their original parent-relative-to-f positions. The cleanest path: don't go through `wrapAsBand` at all for this case. Instead build the band manually:

```typescript
const wrapped: Frame[] = frames.map((f) => {
  if (f.content === null) {
    // Multi-shape composite: build band-around-wireframe manually so the
    // wireframe stays as the layer-2 container.
    const minRow = f.gridRow;
    const wireframe: Frame = {
      ...f,
      gridRow: 0,
      gridCol: 0,
      x: 0,
      y: 0,
      docOffset: 0,
      lineCount: 0,
    };
    const band: Frame = {
      id: nextFrameId(),  // need to import nextFrameId from frame.ts
      x: 0,
      y: minRow * charHeight,
      w: docWidthCols * charWidth,
      h: f.gridH * charHeight,
      z: 0,
      children: [wireframe],
      content: null,
      clip: true,
      dirty: true,
      isBand: true,
      gridRow: minRow,
      gridCol: 0,
      gridW: docWidthCols,
      gridH: f.gridH,
      docOffset: f.docOffset,
      lineCount: f.lineCount > 0 ? f.lineCount : f.gridH,
    };
    return band;
  }
  // Solo claiming frame — unchanged.
  const band = wrapAsBand([f], charWidth, charHeight, docWidthCols);
  if (f.lineCount > 0) band.lineCount = f.lineCount;
  if (f.docOffset > 0 && band.docOffset === 0) band.docOffset = f.docOffset;
  return band;
});
```

**You'll need `nextFrameId` exported from `src/frame.ts`.** Check:

```bash
grep -n "nextId\|nextFrameId\|export.*Id" src/frame.ts
```

If the existing helper is `nextId`, export it: in `src/frame.ts`, change `function nextId()` to `export function nextId()`. Then import as `import { nextId, wrapAsBand } from "./frame";` in editorState.ts.

**Step 4: Re-run the test**

```bash
npx vitest run src/editorState.test.ts -t "4-level tree shape" --reporter=verbose 2>&1 | tail -10
```

Expected: 2 PASS.

**Step 5: Run vitest full suite — many existing tests will break**

```bash
npx vitest run --reporter=dot 2>&1 | tail -5
```

Expected: SOME FAILS — existing tests that assumed `band.children = [rect, line]` directly will now find `band.children = [wireframe]` and fail traversal. Note the count and which describe blocks fail — they need updating in Task 8 (don't try to fix them inline; capture the list).

**Step 6: Commit (with known regressions)**

```bash
git add src/editorState.ts src/frame.ts src/editorState.test.ts
git commit -m "feat: restore wireframe layer in createEditorStateUnified

$(cat <<'EOF'
Multi-shape composites now keep groupIntoContainers' wireframe as a
layer-2 frame inside the band: band → wireframe → [shape, shape, ...].
Solo shapes wrap directly (band → shape) — Figma-style, no implicit
wireframe wrap.

Existing tests that traverse band.children directly will need updating
in the next task (band.children is now [wireframe], not flat shapes).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Fix existing tests that traverse band.children

**Files:**
- Modify: tests in `src/editorState.test.ts` that fail after Task 7.

**Step 1: List the failing tests**

```bash
npx vitest run src/editorState.test.ts --reporter=verbose 2>&1 | grep "×" | head -30
```

Capture the list.

**Step 2: For each failing test, decide:**

- If the test was specifically asserting old "flat band.children = [rect, line]" → update it to traverse via `band.children[0].children` (the wireframe) for multi-shape cases.
- If the test creates frames manually with `{ children: [...] }` and doesn't go through `createEditorStateUnified` → no change needed (manual fixtures are independent of the loader change).

For each fix, apply minimum change. Common transforms:

```typescript
// Before:
const rects = band.children;

// After (multi-shape case):
const wireframe = band.children[0];
const rects = wireframe.children;
```

**Step 3: Run vitest to confirm green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: all PASS (no new test count, just fixes).

**Step 4: Commit**

```bash
git add src/editorState.test.ts
git commit -m "test: update band.children traversal for layer-2 wireframe

$(cat <<'EOF'
Multi-shape band traversal now goes through the wireframe container:
band.children[0].children instead of band.children directly. Solo-shape
cases remain band.children[0] = rect.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `recomputeWireframeBounds` post-pass

**Files:**
- Modify: `src/editorState.ts` — add helper + call from framesField reducer.
- Test: `src/editorState.test.ts`.

**Step 1: Write the failing test**

```typescript
describe("recomputeWireframeBounds", () => {
  // (canvas mock)
  const cw = 9.6, ch = 18;

  it("shrinks wireframe bbox when child moves closer to origin", () => {
    // Build a band → wireframe → [rect at gridCol=10] manually.
    const inner = createRectFrame({ gridW: 4, gridH: 3, style: "single", charWidth: cw, charHeight: ch });
    inner.gridCol = 10;
    inner.x = 10 * cw;
    const wireframe: Frame = {
      ...createRectFrame({ gridW: 14, gridH: 3, style: "single", charWidth: cw, charHeight: ch }),
      content: null,
      gridCol: 0,
      gridW: 14,
      children: [inner],
    };
    const recomputed = recomputeWireframeBounds([wireframe]);
    // Wireframe should now have gridCol=10, gridW=4 (matches child).
    expect(recomputed[0].gridCol).toBe(10);
    expect(recomputed[0].gridW).toBe(4);
    // Child is rebased to wireframe-relative gridCol=0.
    expect(recomputed[0].children[0].gridCol).toBe(0);
  });

  it("grows wireframe bbox when child grows past current extent", () => {
    const inner = createRectFrame({ gridW: 20, gridH: 3, style: "single", charWidth: cw, charHeight: ch });
    inner.gridCol = 0;
    const wireframe: Frame = {
      ...createRectFrame({ gridW: 4, gridH: 3, style: "single", charWidth: cw, charHeight: ch }),
      content: null,
      gridW: 4,
      children: [inner],
    };
    const recomputed = recomputeWireframeBounds([wireframe]);
    expect(recomputed[0].gridW).toBeGreaterThanOrEqual(20);
  });
});
```

Add `recomputeWireframeBounds` to imports.

**Step 2: Run the test to verify it fails**

```bash
npx vitest run src/editorState.test.ts -t "recomputeWireframeBounds" --reporter=verbose 2>&1 | tail -15
```

Expected: 2 FAIL with `recomputeWireframeBounds is not defined`.

**Step 3: Write minimal implementation**

In `src/editorState.ts`, add near the other helpers:

```typescript
/** Walk the tree and recompute every wireframe (`content === null && !isBand`)
 * frame's bbox to be the bounding union of its children's absolute extents.
 * Children are rebased to keep their absolute screen positions stable (same
 * delta-rebase logic as wrapAsBand). Required because hitTestOne's strict
 * bounds check would otherwise make children that grew past the wireframe
 * un-clickable. */
export function recomputeWireframeBounds(frames: Frame[]): Frame[] {
  const recompute = (f: Frame): Frame => {
    // Recompute children first (depth-first), then this frame.
    const newChildren = f.children.map(recompute);
    if (f.isBand || f.content !== null || newChildren.length === 0) {
      return newChildren === f.children ? f : { ...f, children: newChildren };
    }
    // Wireframe: union of children's bounds.
    let minRow = Infinity, minCol = Infinity, maxRow = 0, maxCol = 0;
    for (const c of newChildren) {
      if (c.gridRow < minRow) minRow = c.gridRow;
      if (c.gridCol < minCol) minCol = c.gridCol;
      if (c.gridRow + c.gridH > maxRow) maxRow = c.gridRow + c.gridH;
      if (c.gridCol + c.gridW > maxCol) maxCol = c.gridCol + c.gridW;
    }
    if (minRow === f.gridRow && minCol === f.gridCol
        && maxRow - minRow === f.gridH && maxCol - minCol === f.gridW) {
      return newChildren === f.children ? f : { ...f, children: newChildren };
    }
    // Derive cell sizes from any rect child (children retain w/gridW).
    let cw = 0, ch = 0;
    for (const c of newChildren) {
      if (c.gridW > 0) { cw = c.w / c.gridW; break; }
    }
    for (const c of newChildren) {
      if (c.gridH > 0) { ch = c.h / c.gridH; break; }
    }
    const rebasedChildren = newChildren.map(c => ({
      ...c,
      gridRow: c.gridRow - minRow,
      gridCol: c.gridCol - minCol,
      x: (c.gridCol - minCol) * cw,
      y: (c.gridRow - minRow) * ch,
    }));
    return {
      ...f,
      gridRow: f.gridRow + minRow,    // shift parent-relative position by the rebase
      gridCol: f.gridCol + minCol,
      gridW: maxCol - minCol,
      gridH: maxRow - minRow,
      x: (f.gridCol + minCol) * cw,
      y: (f.gridRow + minRow) * ch,
      w: (maxCol - minCol) * cw,
      h: (maxRow - minRow) * ch,
      children: rebasedChildren,
    };
  };
  return frames.map(recompute);
}
```

**Step 4: Run the recompute tests**

```bash
npx vitest run src/editorState.test.ts -t "recomputeWireframeBounds" --reporter=verbose 2>&1 | tail -10
```

Expected: 2 PASS.

**Step 5: Wire it into the framesField reducer**

In `src/editorState.ts:158+` (the `framesField.update`), find the end of the loop that handles effects (after `mergeOverlappingBands` is called for `moveFrameEffect`, and at the corresponding bottom for other effects). The cleanest wiring: at the very end of the `update` method, just before `return result;`, add:

```typescript
// Recompute wireframe bboxes whenever any effect changed the tree.
if (result !== frames) {
  result = recomputeWireframeBounds(result);
}
return result;
```

**Step 6: Run vitest full suite**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: all PASS.

**Step 7: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: recomputeWireframeBounds post-pass keeps wireframe bboxes tight

$(cat <<'EOF'
Without explicit recompute, dragging or resizing a child past its
wireframe's bbox makes the child un-hittable (hitTestOne rejects clicks
outside the parent's frame.x/y/w/h before recursing). Run a post-pass
after every effect resolves to keep wireframes tight.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Push physics uses band-relative coords

**Files:**
- Modify: `src/editorState.ts:613-642` — push physics resize handler.

**Step 1: Write the failing test**

```typescript
describe("nested resize grows band through wireframe", () => {
  // (canvas mock)
  const cw = 9.6, ch = 18;

  it("resizing a rect inside a wireframe grows the band when child overflows", () => {
    // A multi-shape wireframe. Resize the inner rect tall.
    const md = [
      "Title", "",
      "┌────┐  ───────",
      "│ Hi │",
      "└────┘", "",
      "End",
    ].join("\n");
    let state = createEditorStateUnified(md, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const wireframe = band.children[0];
    const rect = wireframe.children.find(c => c.content?.type === "rect")!;
    const oldBandH = band.gridH;

    // Resize rect's gridH past the band's current height.
    state = applyResizeFrame(state, rect.id, rect.gridW, oldBandH + 5, cw, ch);

    const after = getFrames(state).find(f => f.isBand)!;
    expect(after.gridH).toBeGreaterThan(oldBandH);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
npx vitest run src/editorState.test.ts -t "nested resize grows band" --reporter=verbose 2>&1 | tail -15
```

Expected: FAIL — band's `gridH` doesn't grow because push physics uses `target.gridRow + gridH` against `parent.gridH` (parent is the wireframe, not the band).

**Step 3: Update push physics in `src/editorState.ts:613-642`**

Replace `target.gridRow` and `target.gridCol` references with band-relative versions:

```typescript
// At top of the for-loop block:
const childBandRow = getBandRelativeRow(e.value.id, parent.id, startFrames);
const childBandCol = getBandRelativeCol(e.value.id, parent.id, startFrames);
const childBottomAfter = childBandRow + Math.max(2, e.value.gridH);
const childRightAfter = childBandCol + Math.max(2, e.value.gridW);
```

(The variable names `childBottomAfter` and `childRightAfter` already exist; just rebind them with the correct values.)

**Step 4: Run the test to verify it passes**

```bash
npx vitest run src/editorState.test.ts -t "nested resize grows band" --reporter=verbose 2>&1 | tail -10
```

Expected: PASS.

**Step 5: Confirm full suite green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: all PASS.

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "fix: push physics uses band-relative child position

$(cat <<'EOF'
Resize push-physics compared target.gridRow against parent.gridH — but
under the 4-level model parent is the wireframe, not the band. Sum the
chain via getBandRelativeRow/Col so the comparison is meaningful.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Cascade-prune empty wireframes in reparent

**Files:**
- Modify: `src/editorState.ts:236-239` (reparent reducer's empty-band prune).
- Modify: `src/editorState.ts:1335-1399` (`applyReparentFrame`'s `sourceBandWillEmpty`).

**Step 1: Write the failing test**

```typescript
describe("reparent cascade-prunes empty wireframes and bands", () => {
  // (canvas mock)
  const cw = 9.6, ch = 18;

  it("dragging the only rect out of a wireframe prunes both wireframe and band", () => {
    const md = [
      "Title", "",
      "┌────┐  ───────",
      "│ Hi │",
      "└────┘", "",
      "End",
    ].join("\n");
    let state = createEditorStateUnified(md, cw, ch);
    let band = getFrames(state).find(f => f.isBand)!;
    let wireframe = band.children[0];
    expect(wireframe.children.length).toBeGreaterThanOrEqual(2);

    // Promote one shape out — wireframe still has the other shape, no prune.
    const firstShape = wireframe.children[0];
    state = applyReparentFrame(state, firstShape.id, null, 30, 0, cw, ch);

    band = getFrames(state).find(f => f.gridRow < 5)!; // original band (top)
    wireframe = band.children[0];
    expect(wireframe.children.length).toBe(1);

    // Promote the LAST remaining shape out — wireframe (and band) should be gone.
    const lastShape = wireframe.children[0];
    state = applyReparentFrame(state, lastShape.id, null, 50, 0, cw, ch);

    const remainingTop = getFrames(state).filter(f => f.gridRow < 5);
    // Top band should be gone — promoted shapes live elsewhere now.
    expect(remainingTop.length).toBe(0);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
npx vitest run src/editorState.test.ts -t "reparent cascade" --reporter=verbose 2>&1 | tail -15
```

Expected: FAIL — last-shape extraction leaves an empty wireframe under the band, which keeps the band alive.

**Step 3: Update the reparent reducer (editorState.ts:236-239)**

Replace:

```typescript
// Prune any synthetic bands that became empty after the extraction.
result = result.filter(f => !(f.isBand && f.children.length === 0));
```

With:

```typescript
// Prune empty wireframes (any depth) first, then empty bands. A wireframe
// emptying may now leave the band empty too — order matters.
const pruneEmptyWireframes = (frames: Frame[]): Frame[] =>
  frames
    .map(f => f.children.length > 0
      ? { ...f, children: pruneEmptyWireframes(f.children) }
      : f)
    .filter(f => !(f.content === null && !f.isBand && f.children.length === 0));
result = pruneEmptyWireframes(result);
result = result.filter(f => !(f.isBand && f.children.length === 0));
```

**Step 4: Update `sourceBandWillEmpty` in `applyReparentFrame`**

Find the `sourceBandWillEmpty` calculation in `src/editorState.ts:1335-1399` (search for "sourceBandWillEmpty"). The current logic checks `sourceBand.children.length === 1 && sourceBand.children[0].id === frameId`. Update to handle the wireframe-in-between case:

```typescript
const sourceBandWillEmpty = sourceBand
  ? (() => {
      // Direct child: band has only this shape.
      if (sourceBand.children.length === 1 && sourceBand.children[0].id === frameId) {
        return true;
      }
      // Wireframe child: band's only direct child is a wireframe whose
      // only direct child is the dragged shape.
      if (sourceBand.children.length === 1
          && sourceBand.children[0].content === null
          && !sourceBand.children[0].isBand
          && sourceBand.children[0].children.length === 1
          && sourceBand.children[0].children[0].id === frameId) {
        return true;
      }
      return false;
    })()
  : false;
```

**Step 5: Run the test to verify it passes**

```bash
npx vitest run src/editorState.test.ts -t "reparent cascade" --reporter=verbose 2>&1 | tail -10
```

Expected: PASS.

**Step 6: Confirm full suite green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: all PASS.

**Step 7: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "fix: cascade-prune empty wireframes + deep sourceBandWillEmpty

$(cat <<'EOF'
Reparent reducer now prunes empty wireframes (content=null, !isBand, no
children) at any depth before pruning empty bands — a wireframe-emptying
may leave the band empty. applyReparentFrame's sourceBandWillEmpty
detects the wireframe-in-between case so the band's claim lines are
properly released.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `applyAddChildFrame` band-grow

**Files:**
- Modify: `src/editorState.ts:1285+`.

**Step 1: Write the failing test**

```typescript
describe("applyAddChildFrame band-grow when nesting deep", () => {
  // (canvas mock)
  const cw = 9.6, ch = 18;

  it("adding a child rect to a wireframe grows the containing band when child overflows", () => {
    const md = [
      "Title", "",
      "┌────┐",
      "│ Hi │",
      "└────┘", "",
      "End",
    ].join("\n");
    let state = createEditorStateUnified(md, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0]; // solo case — band → rect
    const oldBandH = band.gridH;

    // Add a tall child INSIDE the rect that would overflow the band.
    const newChild = createRectFrame({ gridW: 2, gridH: oldBandH + 5, style: "single", charWidth: cw, charHeight: ch });
    state = applyAddChildFrame(state, newChild, rect.id, /*absRow*/2, /*absCol*/0);

    const after = getFrames(state).find(f => f.isBand)!;
    expect(after.gridH).toBeGreaterThan(oldBandH);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
npx vitest run src/editorState.test.ts -t "applyAddChildFrame band-grow" --reporter=verbose 2>&1 | tail -15
```

Expected: FAIL — band's `gridH` unchanged because `applyAddChildFrame` doesn't auto-grow.

**Step 3: Update `applyAddChildFrame` in `src/editorState.ts:1285+`**

Find the function. Wrap the `addChildFrameEffect.of(...)` dispatch with a band-grow check:

```typescript
// (inside applyAddChildFrame, before dispatching addChildFrameEffect)
const containingBand = findContainingBandDeep(getFrames(state), parentId);
const effects: StateEffect<unknown>[] = [];
if (containingBand) {
  // Compute the new child's absolute bottom in band-relative coords.
  const parentBandRow = getBandRelativeRow(parentId, containingBand.id, getFrames(state));
  const childAbsBottom = parentBandRow + (absoluteGridRow - findFrameInList(getFrames(state), parentId)!.gridRow) + frame.gridH;
  // (absoluteGridRow is band-absolute already if caller passes absolute coords;
  //  see the existing usage in applyAddTopLevelFrame for parity.)
  if (childAbsBottom > containingBand.gridH) {
    effects.push(resizeFrameEffect.of({
      id: containingBand.id,
      gridW: containingBand.gridW,
      gridH: childAbsBottom,
      charWidth,
      charHeight,
    }));
  }
}
effects.push(addChildFrameEffect.of({ parentId, frame: childFrame }));
return state.update({
  effects,
  annotations: Transaction.addToHistory.of(true),
}).state;
```

(Refine signature to match — read the existing function carefully and adapt.)

**Step 4: Run the test to verify it passes**

```bash
npx vitest run src/editorState.test.ts -t "applyAddChildFrame band-grow" --reporter=verbose 2>&1 | tail -10
```

Expected: PASS.

**Step 5: Confirm full suite green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: all PASS.

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "fix: applyAddChildFrame grows containing band on overflow

$(cat <<'EOF'
Parity with applyAddTopLevelFrame: drawing a shape into a deep nesting
target grows the containing band if the new child's band-relative bottom
exceeds the band's current gridH.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `getFrameRects` triple-sum (DemoV2.tsx test hook)

**Files:**
- Modify: `src/DemoV2.tsx:808-833`.

**Step 1: Write the failing harness test**

The existing harness test for multi-shape wireframes implicitly checks this — find one or add a sanity check. Quick verification: load a multi-shape fixture and assert the harness `getFrames(page)` returns rect bounding boxes at the correct absolute coordinates (`band.x + wireframe.x + rect.x`, all summed).

For now, rely on the existing harness suite — many tests will fail incorrectly until this is fixed. We'll move on and detect via the suite.

**Step 2: Update `getFrameRects` in `src/DemoV2.tsx:808-833`**

Replace:

```typescript
getFrameRects: () => {
  const out: Array<{ ... }> = [];
  for (const f of framesRef.current) {
    if (f.isBand) {
      for (const c of f.children) {
        out.push({
          id: c.id,
          x: f.x + c.x, y: f.y + c.y, w: c.w, h: c.h,
          // ...
        });
      }
      continue;
    }
    // ...
  }
  return out;
},
```

With:

```typescript
getFrameRects: () => {
  const out: Array<{ ... }> = [];
  // Walk into wireframe containers (content === null && !isBand) to surface
  // user-visible shapes; accumulate x/y offsets at each level so the
  // returned coords are absolute (band.x + wireframe.x + shape.x).
  const collect = (frame: Frame, offX: number, offY: number) => {
    const absX = offX + frame.x;
    const absY = offY + frame.y;
    if (frame.isBand || (frame.content === null && !frame.isBand)) {
      // Container: recurse into children, do not emit.
      for (const c of frame.children) collect(c, absX, absY);
      return;
    }
    // User-visible shape (content !== null) — emit.
    out.push({
      id: frame.id,
      x: absX, y: absY, w: frame.w, h: frame.h,
      hasChildren: frame.children.length > 0,
      contentType: frame.content?.type ?? "container",
    });
  };
  for (const f of framesRef.current) collect(f, 0, 0);
  return out;
},
```

**Step 3: Run vitest + full harness**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
npx playwright test e2e/harness.spec.ts --reporter=line --workers=4 2>&1 | tail -5
```

Expected: vitest all green; harness ≤20 fails (down from 25).

**Step 4: Commit**

```bash
git add src/DemoV2.tsx
git commit -m "fix: getFrameRects accumulates offsets through wireframes

$(cat <<'EOF'
Under the 4-level model, a leaf shape's absolute screen position is
band.x + wireframe.x + shape.x — triple sum, not double. Recurse into
container frames and emit only at content !== null leaves.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Round-trip serialization test for multi-shape wireframe

**Files:**
- Modify: `src/serializeUnified.test.ts`.

**Step 1: Write the round-trip test**

Append to `src/serializeUnified.test.ts`:

```typescript
describe("serializeUnified round-trip — multi-shape wireframe", () => {
  // (canvas mock)
  const cw = 9.6, ch = 18;

  it("loading and serializing a multi-shape composite is byte-stable", () => {
    const md = [
      "Title", "",
      "┌────┐  ───────",
      "│ Hi │",
      "└────┘", "",
      "End",
    ].join("\n");
    const state = createEditorStateUnified(md, cw, ch);
    const out = serializeUnified(getDoc(state), getFrames(state));
    expect(out).toBe(md);
  });
});
```

**Step 2: Run the test**

```bash
npx vitest run src/serializeUnified.test.ts -t "round-trip — multi-shape" --reporter=verbose 2>&1 | tail -10
```

Expected: PASS (serializer recursion is depth-agnostic, so this should already work).

**Step 3: Commit**

```bash
git add src/serializeUnified.test.ts
git commit -m "test: round-trip serialization for multi-shape wireframe

$(cat <<'EOF'
Confirms renderFrameRow's recursion is depth-agnostic and the new
wireframe layer doesn't disturb byte-stability.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Final verification + harness sweep

**Files:** none (verification only).

**Step 1: Run full vitest suite**

```bash
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: all PASS, count ≥ 530 (was 509 + 21+ new tests).

**Step 2: Run full harness suite**

```bash
npx playwright test e2e/harness.spec.ts --reporter=line --workers=4 2>&1 | tail -10
```

Expected: ≤20 fails (down from 25). The 5 session-introduced failures should ALL now pass:

- `drag: move box down, no ghosts`
- `move-then-enter: move frame down, then Enter above it`
- `large-drag: drag first wireframe past second, no collision`
- `drag shared-horizontal box down, no ghosts`
- `stack two same-width boxes vertically`
- `drag box to exact same row as another`
- `prose order preserved when dragging wireframe down`

**Step 3: Run typecheck/build**

```bash
npm run build 2>&1 | tail -5
```

Expected: clean.

**Step 4: Update HANDOFF.md**

Append a section noting:
- Selection hierarchy restored (4 levels).
- Ctrl+click bypass added.
- Harness count: 119+N pass / ≤20 fail.

```bash
git add HANDOFF.md
git commit -m "docs: handoff update — selection hierarchy restored"
```

**Step 5: Triage remaining harness failures**

If the count is still > 20, document which of the 19 baseline failures remain in the HANDOFF for next session. They're not in scope here — that's a separate triage.

---

## Task 16: Cleanup pass

**Run only after Task 15 confirms harness ≤20 fail and vitest fully green.** Each sub-step is a separate small commit so reverts are surgical if anything goes wrong.

**Files:**
- Modify: `src/frameRenderer.ts:20-34` — remove magenta band overlay.
- Modify: `src/DemoV2.tsx:~782-800` — remove `?fixture=wall-stack-vert` URL loader.
- Modify: `src/editorState.test.ts:~2899-end` — remove diagnostic `wall-stack-vert text loss` describe block.
- Modify: `src/testSetup.ts` — extract shared canvas mock.

**Step 1: Remove magenta band-debug overlay**

In `src/frameRenderer.ts`, delete lines 24-34 (the `if (frame.isBand) { ctx.save(); ... ctx.restore(); }` block plus the two-line comment above it).

Run: `npm run build && npx vitest run --reporter=dot 2>&1 | tail -3`
Expected: clean build, all tests pass.

Commit:

```bash
git add src/frameRenderer.ts
git commit -m "chore: remove magenta band-debug overlay

$(cat <<'EOF'
The pink tint on synthetic bands was a temporary debug aid for the
eager-bands refactor. Now that the selection hierarchy is restored and
the harness passes, the overlay is just visual noise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Step 2: Remove the `?fixture=wall-stack-vert` URL loader**

In `src/DemoV2.tsx`, find the block added during this session (look for `URLSearchParams` and `FIXTURES`). Replace:

```typescript
const fixtureName = new URLSearchParams(window.location.search).get("fixture");
const FIXTURES: Record<string, string> = {
  "wall-stack-vert": [/* ... */].join("\n"),
};
const initialText = (fixtureName && FIXTURES[fixtureName]) || DEFAULT_TEXT;
loadDocument(initialText); setReady(true);
```

With the original:

```typescript
loadDocument(DEFAULT_TEXT); setReady(true);
```

Run: `npm run build 2>&1 | tail -3`
Expected: clean build.

Commit:

```bash
git add src/DemoV2.tsx
git commit -m "chore: remove ?fixture URL loader

$(cat <<'EOF'
Added during interactive debugging to load wall-stack-vert by hand.
No longer needed now that the harness is green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Step 3: Remove diagnostic `wall-stack-vert text loss` describe block**

In `src/editorState.test.ts`, find the `describe("diagnostic: wall-stack-vert text loss", ...)` block (added during this session, ~9 tests). Delete the whole block. The new tests in Tasks 1-14 supersede this investigative coverage.

Run: `npx vitest run --reporter=dot 2>&1 | tail -3`
Expected: test count drops by ~9, all pass.

Commit:

```bash
git add src/editorState.test.ts
git commit -m "chore: remove investigative wall-stack-vert diagnostic tests

$(cat <<'EOF'
The 9 boundary tests added while debugging selection were investigative,
not regression coverage. The 4-level-tree-shape and resolveSelectionTarget
tests added in this plan provide proper regression coverage for the
underlying behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Step 4: Factor out the canvas mock into `src/testSetup.ts`**

Read the current `src/testSetup.ts`:

```bash
cat src/testSetup.ts
```

Add (or extend if it exists) a helper:

```typescript
import { vi } from "vitest";

/** Mocks document.createElement('canvas') to return a noop 2D context.
 * Required for any test that touches frame layout (canvas measureText). */
export function mockCanvas(): void {
  const orig = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = orig(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "", fillStyle: "", textBaseline: "", fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      })) as unknown as HTMLCanvasElement["getContext"];
    }
    return el;
  });
}
```

Then in each `describe` block added by Tasks 1-14, replace the verbose `beforeAll(() => { ... canvas mock ... })` with:

```typescript
import { mockCanvas } from "./testSetup";

describe("...", () => {
  beforeAll(mockCanvas);
  // ...
});
```

Run: `npx vitest run --reporter=dot 2>&1 | tail -3`
Expected: all PASS, test count unchanged.

Commit:

```bash
git add src/testSetup.ts src/editorState.test.ts src/serializeUnified.test.ts
git commit -m "chore: factor canvas mock into testSetup.ts

$(cat <<'EOF'
The Tasks 1-14 describe blocks each duplicated the canvas-mock beforeAll
block. Extract to testSetup.ts as mockCanvas() and reuse.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Step 5: Final harness sweep + HANDOFF triage**

```bash
npx playwright test e2e/harness.spec.ts --reporter=line --workers=4 2>&1 | tail -5
```

Capture the remaining failure list. Update `HANDOFF.md` with:
- Final pass/fail count.
- Which of the original 19 baseline failures cleared incidentally.
- Which still fail — flag as next-session triage.

Commit:

```bash
git add HANDOFF.md
git commit -m "docs: HANDOFF — selection hierarchy complete; remaining triage list"
```

---

## Notes for the executor

- **Test mock factor-out:** the `beforeAll` canvas-mock block is repeated across multiple `describe` blocks. After all tasks land, refactor into a shared helper (`src/testSetup.ts` already exists — extend it). Don't do this mid-task; do it as a final polish if there's time.

- **Magenta debug overlay** in `src/frameRenderer.ts` stays. The plan does not touch it (per the plan's scope rule).

- **`pendingDrillDownId` removal in Task 5** ripples through the `DragState` type definition — search for it. The compiler will tell you everywhere it lives.

- **Backwards-compat shims:** none needed. Don't introduce `findContainingBand` as an alias for `findContainingBandDeep` — use the new name everywhere.

- **No `// @ts-ignore`. Use `// @ts-expect-error` only with justification.**

- **3 failed fix attempts on a single task → STOP and ask.** The plan was reviewed twice; if a task seems impossible, the architecture might be wrong.
