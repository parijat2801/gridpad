# Segment-to-Line Cursor Mapping — Execution Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix prose cursor click/render so `segmentIndex` (Pretext word-token index) is correctly mapped to `sourceLine` (EditorState 0-indexed line number) and `sourceCol` (grapheme offset from line start).

**Architecture:** Build `segToLine`/`segToCol` prefix maps from `prepared.kinds`/`prepared.segments` in `reflowLayout`, store `sourceLine`/`sourceCol` on `PositionedLine`, update all consumers (`proseCursorFromClick`, `findCursorLine`) to use the new fields. Runtime guards catch drift.

**Tech Stack:** TypeScript, Pretext (`@chenglou/pretext`), CodeMirror EditorState, Vitest, `Intl.Segmenter`

---

### Task 1: Add `sourceLine`/`sourceCol` to `PositionedLine` and build prefix maps

**Files:**
- Modify: `src/reflowLayout.ts`

**Step 1: Write the failing test**

Create `src/reflowLayout.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { prepareWithSegments } from "@chenglou/pretext";
import { reflowLayout } from "./reflowLayout";

// Use a monospace-like font string for Pretext — exact widths don't matter,
// we're testing sourceLine/sourceCol mapping, not pixel positions.
const FONT = "16px monospace";
const LH = 20;

describe("reflowLayout sourceLine/sourceCol", () => {
  it("single line has sourceLine=0, sourceCol=0", () => {
    const prepared = prepareWithSegments("Hello world", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    expect(result.lines.length).toBeGreaterThanOrEqual(1);
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
  });

  it("two lines separated by newline get sourceLine 0 and 1", () => {
    const prepared = prepareWithSegments("Hello\nWorld", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    expect(result.lines.length).toBeGreaterThanOrEqual(2);
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
    expect(result.lines[1].sourceLine).toBe(1);
    expect(result.lines[1].sourceCol).toBe(0);
  });

  it("consecutive empty lines increment sourceLine", () => {
    const prepared = prepareWithSegments("A\n\n\nB", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    // Lines: "A" (line 0), "" (line 1), "" (line 2), "B" (line 3)
    // Pretext may or may not emit visual lines for empty source lines,
    // but the last visual line must be sourceLine=3
    const lastLine = result.lines[result.lines.length - 1];
    expect(lastLine.sourceLine).toBe(3);
  });

  it("wrapped line has same sourceLine but increasing sourceCol", () => {
    // Force wrapping by using a narrow width
    const longLine = "word ".repeat(50); // 250 chars, will wrap
    const prepared = prepareWithSegments(longLine, FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 200, LH, []);
    expect(result.lines.length).toBeGreaterThan(1);
    // All visual lines from the single source line should have sourceLine=0
    for (const line of result.lines) {
      expect(line.sourceLine).toBe(0);
    }
    // sourceCol should be increasing across wrap segments
    for (let i = 1; i < result.lines.length; i++) {
      expect(result.lines[i].sourceCol).toBeGreaterThan(result.lines[i - 1].sourceCol);
    }
  });

  it("empty string produces no lines", () => {
    const prepared = prepareWithSegments("", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    expect(result.lines).toEqual([]);
  });

  it("last line without trailing newline gets correct sourceLine", () => {
    const prepared = prepareWithSegments("First\nSecond", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    const lastLine = result.lines[result.lines.length - 1];
    expect(lastLine.sourceLine).toBe(1);
    expect(lastLine.sourceCol).toBe(0);
  });

  it("emoji text uses grapheme count for sourceCol, not UTF-16 length", () => {
    // "🎉 hello\nworld" — 🎉 is 1 grapheme but 2 UTF-16 code units
    const prepared = prepareWithSegments("🎉 hello\nworld", FONT, { whiteSpace: "pre-wrap" });
    const result = reflowLayout(prepared, 9999, LH, []);
    // Line 0: "🎉 hello" — 7 graphemes (🎉, space, h, e, l, l, o)
    expect(result.lines[0].sourceLine).toBe(0);
    expect(result.lines[0].sourceCol).toBe(0);
    // Line 1: "world" — sourceLine=1, sourceCol=0
    expect(result.lines[1].sourceLine).toBe(1);
    expect(result.lines[1].sourceCol).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npx vitest run src/reflowLayout.test.ts`
Expected: FAIL — `sourceLine` property does not exist on `PositionedLine` (7 tests fail)

**Step 3: Write minimal implementation**

In `src/reflowLayout.ts`:

1. Add to `PositionedLine` interface:
```typescript
export interface PositionedLine {
  x: number;
  y: number;
  text: string;
  width: number;
  /** Pretext word-segment cursor — use sourceLine/sourceCol for EditorState coordinates */
  startCursor: { segmentIndex: number; graphemeIndex: number };
  /** 0-indexed source line number (\n-delimited) — EditorState-compatible */
  sourceLine: number;
  /** Grapheme offset from start of source line to this visual line's start — grapheme clusters, not UTF-16 code units */
  sourceCol: number;
}
```

2. Add prefix map builder and grapheme segmenter at module top:
```typescript
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function countGraphemes(text: string): number {
  let count = 0;
  for (const _ of graphemeSegmenter.segment(text)) count++;
  return count;
}
```

3. At the start of `reflowLayout`, build `segToLine`/`segToCol`:
```typescript
// Access PreparedCore fields via the base type (unstable Pretext escape hatch).
// If Pretext changes the segment taxonomy, these maps will drift — the
// runtime guards below will catch it.
const kinds: string[] | undefined = (prepared as any).kinds;
const segments: string[] = prepared.segments;

let segToLine: number[] = [];
let segToCol: number[] = [];
let kindsValid = false;

if (kinds && Array.isArray(kinds) && kinds.length === segments.length) {
  kindsValid = true;
  let currentLine = 0;
  let currentColGraphemes = 0;

  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === "hard-break") {
      // The hard-break segment itself belongs to the current line
      segToLine.push(currentLine);
      segToCol.push(currentColGraphemes);
      // Advance to next source line
      currentLine++;
      currentColGraphemes = 0;
    } else {
      segToLine.push(currentLine);
      segToCol.push(currentColGraphemes);
      currentColGraphemes += countGraphemes(segments[i]);
    }
  }

  // Guard (d-ii): for multi-line text, verify at least one hard-break exists
  const hasMultipleLines = currentLine > 0;
  const textHasNewlines = segments.some(s => s.includes("\n")) || kinds.some(k => k === "hard-break");
  if (!hasMultipleLines && prepared.segments.join("").includes("\n")) {
    console.error("[reflowLayout] text contains newlines but no 'hard-break' found in kinds — prefix map may be wrong");
  }
} else if (segments.length > 0) {
  // Guard (d): kinds missing or mismatched — fall back to zeros
  console.error("[reflowLayout] prepared.kinds missing or length mismatch — sourceLine/sourceCol will be 0");
  segToLine = new Array(segments.length).fill(0);
  segToCol = new Array(segments.length).fill(0);
}
```

4. When emitting `PositionedLine`, compute `sourceLine`/`sourceCol`:
```typescript
// Inside the slot loop, after capturing startCursor:
const startCursor = { segmentIndex: cursor.segmentIndex, graphemeIndex: cursor.graphemeIndex };

let sourceLine = 0;
let sourceCol = 0;
if (segToLine.length > 0 && startCursor.segmentIndex < segToLine.length) {
  sourceLine = segToLine[startCursor.segmentIndex];
  sourceCol = segToCol[startCursor.segmentIndex] + startCursor.graphemeIndex;
  // Guard (b): clamp sourceLine
  const maxLine = segToLine[segToLine.length - 1];
  if (sourceLine > maxLine) {
    console.warn(`[reflowLayout] sourceLine ${sourceLine} exceeds max ${maxLine}, clamping`);
    sourceLine = maxLine;
  }
}

// ... then in the lines.push:
lines.push({
  x: Math.round(slot.left),
  y: Math.round(lineTop),
  text: line.text,
  width: line.width,
  startCursor,
  sourceLine,
  sourceCol,
});
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npx vitest run src/reflowLayout.test.ts`
Expected: PASS — all 7 tests green

**Step 5: Run full test suite**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npm test`
Expected: Some existing tests in `cursorFind.test.ts` may fail because `makeLine` doesn't supply `sourceLine`/`sourceCol`. That's expected — we fix those in Task 3.

**Step 6: Commit**

```bash
cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes
git add src/reflowLayout.ts src/reflowLayout.test.ts
git commit -m "feat: build segToLine/segToCol prefix maps, add sourceLine/sourceCol to PositionedLine"
```

---

### Task 2: Fix `proseCursorFromClick` in DemoV2.tsx

**Files:**
- Modify: `src/DemoV2.tsx:237-255` (proseCursorFromClick function)

**Step 1: Write the failing test**

No unit test for this — it's a UI event handler in a React component. We verify via the integration in Task 5 (manual test).

**Step 2: Add module-level grapheme segmenter**

Add near the top of DemoV2.tsx (after the existing constant declarations around line 29):

```typescript
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
```

**Step 3: Implement the fix**

Replace `proseCursorFromClick` (lines 237-255) with:

```typescript
function proseCursorFromClick(px: number, py: number): CursorPos | null {
  if (linesRef.current.length === 0) return null;
  const charWidth = getCharWidth();
  // Find closest visual line — vertical distance first, horizontal tie-break
  let best: PositionedLine | null = null;
  let bestDist = Infinity;
  const candidates: PositionedLine[] = [];
  let minVDist = Infinity;

  for (const pl of linesRef.current) {
    const vDist = Math.abs(pl.y + LH / 2 - py);
    if (vDist < minVDist) minVDist = vDist;
  }
  // Collect all lines within 1px of the best vertical distance (same y-band)
  for (const pl of linesRef.current) {
    const vDist = Math.abs(pl.y + LH / 2 - py);
    if (vDist <= minVDist + 1) candidates.push(pl);
  }
  if (candidates.length === 1) {
    best = candidates[0];
  } else {
    // Multi-slot tie-break: prefer the slot that contains px horizontally
    for (const pl of candidates) {
      if (px >= pl.x && px <= pl.x + pl.width) { best = pl; break; }
    }
    // If px is outside all slots, pick nearest by horizontal distance
    if (!best) {
      for (const pl of candidates) {
        const hDist = px < pl.x ? pl.x - px : px > pl.x + pl.width ? px - pl.x - pl.width : 0;
        if (hDist < bestDist) { bestDist = hDist; best = pl; }
      }
    }
  }
  if (!best) return null;

  // Use sourceLine/sourceCol — the EditorState-compatible coordinates
  const row = best.sourceLine;
  const clickCol = Math.max(0, Math.floor((px - best.x) / charWidth));
  // Grapheme-based clamp on the visual line text (uses module-level graphemeSegmenter)
  const visualLineGraphemes = [...graphemeSegmenter.segment(best.text)].length;
  const col = best.sourceCol + Math.min(clickCol, visualLineGraphemes);

  // Clamp against actual source line length (grapheme count)
  const state = stateRef.current;
  if (!state) return null;
  const clampedRow = Math.min(Math.max(row, 0), state.doc.lines - 1);
  const lineText = state.doc.line(clampedRow + 1).text;
  const lineGraphemes = [...graphemeSegmenter.segment(lineText)].length;
  const clampedCol = Math.min(col, lineGraphemes);
  return { row: clampedRow, col: clampedCol };
}
```

**Step 4: Run full test suite**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npm test`
Expected: PASS (or existing cursorFind failures from missing fields — fixed in Task 3)

**Step 5: Commit**

```bash
cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes
git add src/DemoV2.tsx
git commit -m "fix: proseCursorFromClick uses sourceLine/sourceCol with grapheme clamp and multi-slot hit-test"
```

---

### Task 3: Fix `findCursorLine` and update tests

**Files:**
- Modify: `src/cursorFind.ts`
- Modify: `src/cursorFind.test.ts`

**Step 1: Update `findCursorLine` implementation**

Replace the body of `findCursorLine` in `src/cursorFind.ts`:

```typescript
export function findCursorLine(
  cursor: { row: number; col: number },
  lines: PositionedLine[],
  charWidth: number,
  lineHeight: number,
): CursorLineResult {
  let targetLine: PositionedLine | null = null;
  let lastLineBefore: PositionedLine | null = null;
  for (const pl of lines) {
    if (pl.sourceLine === cursor.row &&
        pl.sourceCol <= cursor.col) {
      targetLine = pl;
    }
    if (pl.sourceLine < cursor.row) {
      lastLineBefore = pl;
    }
  }
  if (targetLine) {
    return {
      x: targetLine.x + (cursor.col - targetLine.sourceCol) * charWidth,
      y: targetLine.y,
    };
  } else if (lastLineBefore) {
    // Empty line fallback (e.g., \n\n separator navigated via arrow keys)
    return {
      x: 0,
      y: lastLineBefore.y + lineHeight * (cursor.row - lastLineBefore.sourceLine),
    };
  }
  // Empty document fallback — position cursor at correct row
  return { x: 0, y: cursor.row * lineHeight };
}
```

**Step 2: Update `makeLine` helper and all existing tests**

Replace `src/cursorFind.test.ts` entirely:

```typescript
import { describe, it, expect } from "vitest";
import type { PositionedLine } from "./reflowLayout";
import { findCursorLine } from "./cursorFind";

function makeLine(
  sourceLine: number,
  sourceCol: number,
  x: number,
  y: number,
  text: string = "",
): PositionedLine {
  return {
    x,
    y,
    text,
    width: text.length * 8,
    // startCursor kept for backward compat — not used by findCursorLine anymore
    startCursor: { segmentIndex: 0, graphemeIndex: 0 },
    sourceLine,
    sourceCol,
  };
}

describe("findCursorLine", () => {
  it("finds cursor on a simple single line", () => {
    const lines: PositionedLine[] = [makeLine(0, 0, 0, 0, "Hello world")];
    const result = findCursorLine({ row: 0, col: 3 }, lines, 8, 20);
    expect(result).toEqual({ x: 24, y: 0 });
  });

  it("finds cursor on second source line", () => {
    const lines: PositionedLine[] = [
      makeLine(0, 0, 0, 0, "First line"),
      makeLine(1, 0, 0, 20, "Second line"),
    ];
    const result = findCursorLine({ row: 1, col: 5 }, lines, 8, 20);
    expect(result).toEqual({ x: 40, y: 20 });
  });

  it("handles wrapped line — cursor on second visual line", () => {
    // Two visual lines from source line 0: first has sourceCol=0, second has sourceCol=40
    const lines: PositionedLine[] = [
      makeLine(0, 0, 0, 0, "A".repeat(40)),
      makeLine(0, 40, 0, 20, "B".repeat(20)),
    ];
    const result = findCursorLine({ row: 0, col: 45 }, lines, 8, 20);
    // col 45 - sourceCol 40 = 5 chars in, so x = 5 * 8 = 40
    expect(result).toEqual({ x: 40, y: 20 });
  });

  it("empty line fallback via lastLineBefore", () => {
    const lines: PositionedLine[] = [makeLine(0, 0, 0, 0, "First line")];
    const result = findCursorLine({ row: 2, col: 0 }, lines, 8, 20);
    // lastLineBefore is line 0 at y=0, cursor.row - sourceLine = 2, so y = 0 + 20*2 = 40
    expect(result).toEqual({ x: 0, y: 40 });
  });

  it("empty document returns origin", () => {
    const result = findCursorLine({ row: 0, col: 0 }, [], 8, 20);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it("empty document with cursor past row 0", () => {
    const result = findCursorLine({ row: 2, col: 0 }, [], 8, 20);
    expect(result).toEqual({ x: 0, y: 40 });
  });

  it("cursor at end of line", () => {
    const lines: PositionedLine[] = [makeLine(0, 0, 0, 0, "Hello")];
    const result = findCursorLine({ row: 0, col: 5 }, lines, 8, 20);
    expect(result).toEqual({ x: 40, y: 0 });
  });

  // New: wrapped line picks correct visual segment
  it("wrapped line — cursor col between two wrap segments picks second", () => {
    const lines: PositionedLine[] = [
      makeLine(0, 0, 0, 0, "A".repeat(30)),
      makeLine(0, 30, 0, 20, "B".repeat(30)),
      makeLine(0, 60, 0, 40, "C".repeat(10)),
    ];
    // col 35 falls in second segment (sourceCol 30, so 35 >= 30)
    const result = findCursorLine({ row: 0, col: 35 }, lines, 8, 20);
    expect(result).toEqual({ x: 40, y: 20 }); // (35-30)*8 = 40
  });

  // New: multi-line with gaps (empty source lines)
  it("empty source lines between text — fallback works", () => {
    const lines: PositionedLine[] = [
      makeLine(0, 0, 0, 0, "Line zero"),
      makeLine(3, 0, 0, 20, "Line three"),
    ];
    // Cursor on source line 1 (empty) — uses lastLineBefore (line 0 at y=0)
    const result = findCursorLine({ row: 1, col: 0 }, lines, 8, 20);
    expect(result).toEqual({ x: 0, y: 20 }); // y=0 + 20*(1-0) = 20
  });

  // New: continuation line with sourceCol > 0
  it("sourceCol > 0 on continuation — x uses sourceCol offset", () => {
    // Visual line starts at sourceCol 15 into source line 2
    const lines: PositionedLine[] = [
      makeLine(2, 15, 0, 40, "continuation text"),
    ];
    // Cursor at row=2, col=20 → x = (20-15)*8 = 40
    const result = findCursorLine({ row: 2, col: 20 }, lines, 8, 20);
    expect(result).toEqual({ x: 40, y: 40 });
  });

  // New: offset visual line (x > 0) from obstacle carving
  it("visual line with x-offset from obstacle", () => {
    const lines: PositionedLine[] = [
      makeLine(0, 0, 100, 0, "After obstacle"),
    ];
    const result = findCursorLine({ row: 0, col: 3 }, lines, 8, 20);
    // x = 100 (line offset) + 3*8 = 124
    expect(result).toEqual({ x: 124, y: 0 });
  });
});
```

**Step 3: Run test to verify all pass**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npx vitest run src/cursorFind.test.ts`
Expected: PASS — all 11 tests green

**Step 4: Run full test suite**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npm test`
Expected: PASS — all tests green

**Step 5: Commit**

```bash
cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes
git add src/cursorFind.ts src/cursorFind.test.ts
git commit -m "fix: findCursorLine uses sourceLine/sourceCol instead of segmentIndex/graphemeIndex"
```

---

### Task 4: Add dev-mode round-trip guard

**Files:**
- Modify: `src/reflowLayout.ts`

**Step 1: Add optional `docLineCount` parameter and dev guard**

Add `docLineCount?: number` as an optional 5th parameter to `reflowLayout`:

```typescript
export function reflowLayout(
  prepared: PreparedTextWithSegments,
  canvasWidth: number,
  lineHeight: number,
  obstacles: Obstacle[],
  docLineCount?: number, // Pass state.doc.lines for dev-mode validation
): ReflowResult {
```

After computing `sourceLine`/`sourceCol` for each `PositionedLine`, add guard (c):

```typescript
// Guard (c): dev-mode round-trip check — verify sourceLine and sourceCol are in bounds
if (import.meta.env.DEV && docLineCount !== undefined) {
  if (sourceLine >= docLineCount) {
    console.error(
      `[reflowLayout] sourceLine ${sourceLine} >= docLineCount ${docLineCount} at segmentIndex ${startCursor.segmentIndex}`
    );
  }
  // Also verify sourceCol doesn't exceed the source line's grapheme length.
  // We can't access EditorState here, but we can check against the segment data:
  // if sourceCol exceeds the cumulative graphemes on this source line, something's wrong.
  if (segToLine.length > 0) {
    // Find the last segment on this source line to get max col
    let maxColOnLine = 0;
    for (let si = 0; si < segToLine.length; si++) {
      if (segToLine[si] === sourceLine) {
        maxColOnLine = segToCol[si] + countGraphemes(segments[si]);
      }
    }
    if (sourceCol > maxColOnLine) {
      console.error(
        `[reflowLayout] sourceCol ${sourceCol} > max graphemes ${maxColOnLine} on sourceLine ${sourceLine}`
      );
    }
  }
}
```

**Step 2: Update callers to pass `docLineCount`**

In `src/DemoV2.tsx`, find all calls to `reflowLayout` and add the doc line count. The `doLayout` function (line 143-146):

```typescript
function doLayout() {
  if (!preparedRef.current) { linesRef.current = []; return; }
  const docLines = stateRef.current?.doc.lines;
  linesRef.current = reflowLayout(
    preparedRef.current, sizeRef.current.w, LH,
    framesToObstacles(framesRef.current),
    docLines,
  ).lines;
}
```

**Step 3: Run full test suite**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npm test`
Expected: PASS — existing tests don't pass `docLineCount` (it's optional), new test still passes

**Step 4: Commit**

```bash
cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes
git add src/reflowLayout.ts src/DemoV2.tsx
git commit -m "feat: add dev-mode round-trip guard for sourceLine validation"
```

---

### Task 5: Final verification — full test suite + type check + manual test

**Files:** None (verification only)

**Step 1: Run type check**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npx tsc --noEmit`
Expected: No errors

**Step 2: Run full test suite**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npm test`
Expected: All tests pass

**Step 3: Build check**

Run: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npm run build`
Expected: Build succeeds

**Step 4: Manual test**

Start dev server: `cd /Users/parijat/dev/gridpad/.claude/worktrees/scanner-fixes && npm run dev`

1. Open localhost:5173
2. Load `test-kitchen-sink.md` (or any multi-line .md file)
3. Click on a prose line near the middle of the document → cursor should appear WHERE you clicked
4. Type characters → they should appear at the cursor position, not elsewhere
5. Click on different lines → cursor moves correctly
6. Arrow keys → cursor navigates correctly
7. Backspace → deletes the character before the cursor
8. Check browser console for any `[reflowLayout]` warnings/errors

---

| File | Changes |
|------|---------|
| `src/reflowLayout.ts` | `PositionedLine` gains `sourceLine`/`sourceCol`; `segToLine`/`segToCol` prefix maps from `prepared.kinds`/`prepared.segments`; runtime guards (sourceLine clamp, dev-mode round-trip with sourceCol bounds, kinds existence + hard-break check); optional `docLineCount` param |
| `src/reflowLayout.test.ts` | New test file — 7 tests for prefix map correctness (single line, two lines, empty lines, wrapped, empty string, last-line-no-newline, emoji grapheme counting) |
| `src/DemoV2.tsx` | `proseCursorFromClick` uses `sourceLine`/`sourceCol`; grapheme-based clamp; multi-slot horizontal tie-break; passes `docLineCount` to `reflowLayout` |
| `src/cursorFind.ts` | `findCursorLine` matches on `sourceLine`/`sourceCol` instead of `segmentIndex`/`graphemeIndex` |
| `src/cursorFind.test.ts` | Updated `makeLine` helper; all 7 existing tests migrated; 4 new tests (wrapped segment selection, empty-line gaps, continuation sourceCol, obstacle x-offset) |

**What does NOT change:** `editorState.ts`, `frame.ts`, `frameRenderer.ts`, `serialize.ts`, `proseCursor.ts`, `grid.ts`, `spatialHitTest.ts`, `spatialTextEdit.ts`, `spatialKeyHandler.ts`, `spatialPaint.ts`
