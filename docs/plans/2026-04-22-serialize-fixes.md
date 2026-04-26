# Fix 48 Sweep Serialization Failures

**Goal:** Patch 4 specific bugs in the scanner→serializer pipeline that cascade into 30 ghost, 13 non-convergent, and 5 frame-count failures — without rewriting the serializer architecture.

## Context

Static round-trip passes 17/19 fixtures. Failures appear only after interactive operations (drag, resize) set frames dirty. The bugs are interconnected but largely independent: Problem 1 feeds ghost creation through Phase C; Problem 2 erases valid sibling edges; Problem 3 causes dirty/prose mismatch; Problem 4 drops partially-overflowing children. Fixing in dependency order (1 → 3 → 4 → 2 → 5) prevents cascading regressions.

## The Fixes

1. **Stop wire chars leaking into prose** (`scanner.ts:359`). The scanner's `detectTexts` emits any unclaimed non-space run as `ScannedText`, including isolated wire chars (`│`, `─`) — the guard is just `ch !== " " && ch !== "" && !isClaimed` at scanner.ts:359. These wire-only text runs flow into `scanToFrames` where the prose exclusion filter (`t.col + t.content.length <= bbox.col + bbox.w`) passes them through because drifted cells sit 1 col outside the rect bbox. Fix: in `detectTexts`, skip pushing a text run if every character is a wire char (`┌┐└┘│─├┤┬┴┼`). Do NOT expand the bbox tolerance in `scanToFrames.ts` — that risks dropping legitimate user text adjacent to wireframes. Mixed runs like `"│foo"` still pass through; acceptable risk since these are rare in practice.

2. **Delete Phase B.6, contingent on test results** (`gridSerialize.ts:203-222`). Phase B.6 blanks every wire char on any row touched by a dirty frame that isn't in `cellsToWrite`. This is too destructive: it scans the FULL row width (not just inside bboxes), so valid sibling wireframe edges (`─`) on the same row get erased. Gemini argued bbox-scoped narrowing is dead code (Pass 2a already blanks bbox cells, 2b writes them back). This is true for cells INSIDE bboxes, but B.6's real effect is on cells OUTSIDE bboxes on the same row — stale wire chars from the original grid. After Fixes 1 and 4, the main sources of stale wire (prose resurrection and clip bailout orphans) should be gone. Delete B.6 (lines 203-222), run sweep tests. If ghost failures increase, replace with a narrower heuristic: only blank wire chars on dirty rows that are outside ALL frame bboxes (current and original).

3. **Recurse dirty detection and prose row occupancy through the full frame tree** (`gridSerialize.ts:227`, `gridSerialize.ts:244-246`). `anyDirty` checks only top-level frames (`frames.some(f => f.dirty)`), but `collectFrameCells` recurses into children and writes dirty child cells at line 386. A dirty child inside a non-dirty container causes Phase B to write cells while Phase C takes the "no-edit" prose path — prose lands on stale positions while frame content has moved. Fix: (a) `anyDirty` must use a recursive helper matching `snapshotFrameBboxes` traversal pattern (gridSerialize.ts:288); (b) `frameRows` at line 244 must walk the full tree computing absolute row ranges using offset accumulation; (c) dirty prose reflow (lines 242-268) must use a monotonic reflow algorithm to preserve vertical text ordering — iterate `proseLines`, track `minRow` (initially 0), for each line set candidate to `Math.max(origRow, minRow)`, skip rows in `frameRows`, assign, set `minRow = assigned + 1`. This prevents text reordering when some original rows are blocked and others aren't.

4. **Clip cells, not entire frames** (`gridSerialize.ts:352-355`). `collectFrameCells` skips a child frame entirely if its bbox overflows the parent clip rect by even 1 cell. Change to per-cell clipping with three coordinated changes: (a) remove the frame-level early return at line 352-355; (b) intersect the bbox with `clipRect` before pushing to `bboxesToBlank` — if the intersection is empty, don't push; (c) gate each cell write by BOTH the frame's own bbox AND the ancestor `clipRect` (the existing check at line 366 only tests frame bbox, not clipRect). No two-pass compositor conflict if both bbox clipping and cell clipping happen together.

5. **Tighten container sizing** (`frame.ts:440-453`). Lower priority — attempt after fixes 1-4 only if FRAME_COUNT failures persist. Strengthen the orphan line filter in `framesFromScan` (`frame.ts:368`, inside `isOrphanLine`) to catch multi-cell lines that extend past their adjacent rect's boundary.

## Execution Order

Fix 1 → Fix 3 → Fix 4 → Fix 2 → Fix 5. Fix 4 must land before Fix 2 because the clip bailout creates stale wire chars that B.6 currently masks — removing B.6 before fixing clipping would reintroduce visible leftovers. Run `npx playwright test e2e/sweep.spec.ts --workers=8` after each fix to measure progress.

## Files

| File | Change |
|------|--------|
| `src/scanner.ts` | `detectTexts` (~line 370): skip text runs where every char is a wire char |
| `src/gridSerialize.ts` | Delete B.6 (lines 203-222); recurse `anyDirty` (line 227) and `frameRows` (line 244); monotonic prose reflow; per-cell clipping in `collectFrameCells` (lines 352-366) |
| `src/frame.ts` | (Fix 5 only) Tighten orphan line filter in `isOrphanLine` (~line 368) |

**What does NOT change:** `src/scanToFrames.ts`, `src/scanner.ts` rect detection/claiming logic, `src/proseSegments.ts`, `src/DemoV2.tsx`, `src/editorState.ts`, `src/reflowLayout.ts`, e2e test infrastructure. The serializer's 4-phase architecture (copy grid → blank → write frames → write prose → flatten) is preserved.

## Review notes

**Codex GPT-5.4:** All line numbers verified correct. Identified the `anyDirty` top-level-only bug as a 6th problem. Recommended reusing `snapshotFrameBboxes` traversal pattern for recursive helpers.

**Gemini 3-pro:** Caught that bbox-scoped B.6 narrowing is dead code — delete B.6 entirely instead. Recommended skipping Fix 1(b) (bbox tolerance expansion) to avoid dropping legitimate adjacent text. Designed monotonic prose reflow algorithm to prevent text reordering in Fix 3.
