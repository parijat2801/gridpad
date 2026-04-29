# Handoff Prompt — eager-bands UX (drag-corruption diagnostic)

You are continuing work on **gridpad** (markdown editor where ASCII
wireframes come alive on a single HTML5 Canvas). Eager-bands is the
recent design where every top-level wireframe is wrapped in a synthetic
invisible **band** that owns doc-claim lines.

**Worktree:** `~/dev/gridpad/.claude/worktrees/unified-document`
**Branch:** `feature/add-frame-fix`
**Plan / context doc:** `HANDOFF.md` (read first; it has the full
session history and architectural calls)

## Confirm baseline before touching anything

```bash
cd ~/dev/gridpad/.claude/worktrees/unified-document
git log --oneline | head -6
# Top should be b3009f2 (HANDOFF.md) then b3009f2 → 1b869f8 → f883978 → b8931d4
npx vitest run --reporter=dot 2>&1 | tail -3
# Expected: 509 pass / 0 fail
npx playwright test e2e/harness.spec.ts --reporter=line --workers=4 2>&1 | tail -3
# Expected: 119 pass / 25 fail
npm run build 2>&1 | tail -3
# Expected: clean
```

## What's working

- `applyReparentFrame` correctly releases source band's claim when the
  rect is the sole child of a band (P1).
- Child rect resize past parent band's wall grows the band (P2 push
  physics) — implemented as a pre-pass in `unifiedDocSync`.
- Two top-level bands whose claim ranges overlap are merged by
  `mergeOverlappingBands` after every `moveFrameEffect` (P3a).
- Vitest 509/0; build clean.

## Your immediate task — Step A from the handoff

The merge-on-overlap function (`mergeOverlappingBands` in
`src/editorState.ts:1411-`) makes a unit RED test go GREEN: "dragging
one band into another merges them into a single band." But the harness
test "stack two same-width boxes vertically — bottom border meets top
border" still fails: the bottom box's `Bottom` text is missing in the
saved output.

**Hypothesis to verify (do this first, do not guess):**

There are 3 plausible explanations:

- **(a) The merge isn't firing in the harness flow.** Drag rotation is
  clamped before bands actually overlap. The `Bottom` loss is unrelated
  to overlap — it's some other drag-time corruption.
- **(b) The merge fires but a downstream transaction undoes it.**
  Possible culprits: undo-history (frameInversion), invertedEffects on
  moveFrameEffect, autosave triggering re-parse.
- **(c) The merge fires but `serializeUnified` mishandles the merged
  shape.** A merged band has children at non-zero gridRow (rebased);
  the serializer might not render text-children correctly when their
  rect is at a non-zero `gridRow` inside the band.

### Concrete steps

1. **Read** `HANDOFF.md` and `e2e/artifacts/wall-stack-vert/output.md`
   to internalize the expected vs. actual saved markdown.

2. **Add temporary instrumentation** in `src/editorState.ts`:
   - In `mergeOverlappingBands`: log when a merge happens
     (`console.log("[MERGE]", survivor.id, "absorbed", other.id, "→ new range", newStart, newEnd, "children:", merged.children.length)`).
   - In `framesField`'s docOffset remap (around line 151-157): log only
     when isBand and offset changes (`[BAND-MAPPOS] id=... old=... new=...`).

3. **Capture browser console in the harness test.** Edit
   `e2e/harness.spec.ts` `test("stack two same-width boxes vertically...")`
   to add a `page.on("console", msg => { ... })` listener that prints
   `[MERGE]` and `[BAND-MAPPOS]` lines. (See how I did it in commits
   prior to `1b869f8` — search the commit log for examples.)

4. **Run the failing test alone:**
   ```bash
   rtk proxy npx playwright test e2e/harness.spec.ts \
     -g "stack two same-width" --workers=1 --reporter=line 2>&1 \
     | grep -E "MERGE|BAND-MAPPOS|frames=" | head -30
   ```
   `rtk proxy` is needed to bypass the rtk wrapper that strips logs.

5. **Read the output and pick:**
   - **No MERGE lines** → hypothesis (a). The drag clamps before
     overlap. Find what limits maxUp/maxDown. Probably the prose
     rows between the two bands (3 blank rows in the fixture) are
     being treated as un-rotatable. Fix: allow rotation through
     blank prose rows when the destination is a band-claimed row
     (i.e., merge IS the right outcome). Or: trigger merge as a
     consequence of mouseup commit, not rotation.
   - **MERGE happens, then the doc is wrong** → hypothesis (b) or (c).
     Inspect the saved markdown's structure vs. the in-memory frames
     just before save. If frames look right but markdown is wrong, it's
     (c) — fix `serializeUnified` to handle children at non-zero
     `gridRow`. If frames look wrong, it's (b) — find which transaction
     undoes the merge.

6. **Once you've identified which hypothesis is true, fix THAT and
   only that.** Use `superpowers:test-driven-development` — confirm RED
   → fix → confirm GREEN. Don't bundle multiple fixes.

7. **Run the full harness** to see whether the fix resolves more than
   just the stack test:
   ```bash
   npx playwright test e2e/harness.spec.ts --reporter=line --workers=4
   ```
   Expected: count drops from 25 → some smaller number. The 5
   "session-introduced" failures (large-drag, drag shared-horizontal,
   stack two same-width, drag box to exact same row, prose order) all
   share a root cause and may all clear with one fix.

8. **Remove the instrumentation, commit, update HANDOFF.md.**

## Hard rules

- **TDD:** confirm RED → write fix → confirm GREEN. Don't write
  production code without a failing test first.
- **Don't dispatch agents** to "figure it out" — give them a written
  spec or a specific file to read.
- **Don't truncate test output** with `| tail` when investigating
  failures. Read the full log at
  `~/Library/Application Support/rtk/tee/<latest>_*.log`.
- **Don't bundle fixes.** One commit per logical fix.
- **No `// @ts-ignore`.** Use `// @ts-expect-error` only with
  justification.
- **Don't touch `src/frameRenderer.ts`** — there's a magenta debug
  overlay still active. Leaving it on for visual debugging. Remove
  only at end of P3+P4 work.
- **Don't fix things outside this scope.** The 19 baseline-failing
  tests are likely a mix of stale tests (no longer make sense under
  eager bands) and real downstream bugs. Triage them only after the
  merge-related fixes land.

## When stuck

After **3 failed fix attempts** on the same hypothesis, STOP. Don't
attempt a 4th. The repeated failure usually means the wrong layer is
being patched. Re-read `HANDOFF.md` "Open architectural debt" and
ask the user before proceeding.

## What success looks like

- Vitest still 509+ pass / 0 fail.
- Harness drops from 25 to ≤20 fails (ideally 19 — back to baseline).
- `npm run build` clean.
- `e2e/artifacts/wall-stack-vert/output.md` shows `Bottom` preserved.
- One new commit with clear root-cause description.
- Updated HANDOFF.md reflecting new state.

Begin with step 1 (read `HANDOFF.md`). Don't read other context files
until you've done that.
