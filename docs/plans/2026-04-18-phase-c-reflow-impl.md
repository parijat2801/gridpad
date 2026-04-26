# Phase C Rewrite — Serialize Prose from reflowLayout Positions

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the dual-path Phase C (anyDirty split) with a single path that writes prose at the pixel positions `reflowLayout` already computed — same coordinates the canvas uses.

**Architecture:** `reflowLayout` produces `PositionedLine[]` with `(x, y, text)` for every prose line, already carved around frame obstacles. Phase C converts each line's pixel position to grid coordinates `(row = round(y/ch), col = round(x/cw))` and writes the text there. No `anyDirty` check, no `availableRows` computation, no `proseSegmentMap` lookup in Phase C.

**Tech Stack:** TypeScript, Vitest, Playwright

---

### Task 1: Add `renderedLines` parameter to `gridSerialize`

**Files:**
- Modify: `src/gridSerialize.ts:23-31` (signature)
- Test: `src/gridSerialize.test.ts`

**Step 1: Write the failing test**

Add to `src/gridSerialize.test.ts`:

```typescript
it("Phase C uses renderedLines positions instead of proseSegmentMap", () => {
  const text = "Prose above\n\n┌──────┐\n│      │\n└──────┘\n\nProse below";
  const { frames, proseSegments, originalGrid } = scanToFrames(text, CW, CH);
  const segMap = buildSegmentMap(proseSegments);
  const prose = buildProseDoc(proseSegments);

  // Simulate renderedLines — prose at specific pixel positions
  const renderedLines = [
    { x: 0, y: 0, text: "Prose above" },
    { x: 0, y: 18.4, text: "" },
    { x: 0, y: 92, text: "" },
    { x: 0, y: 110.4, text: "Prose below" },
  ];

  const result = gridSerialize(
    frames, prose, segMap, originalGrid, CW, CH,
    proseSegments, undefined, renderedLines,
  );
  expect(result).toContain("Prose above");
  expect(result).toContain("Prose below");
  expect(result).toContain("┌──────┐");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/gridSerialize.test.ts`
Expected: FAIL — `gridSerialize` doesn't accept `renderedLines` parameter yet

**Step 3: Write minimal implementation**

In `src/gridSerialize.ts`, change the signature at line 23:

```typescript
export function gridSerialize(
  frames: Frame[],
  prose: string,
  proseSegmentMap: { row: number; col: number }[],
  originalGrid: string[][],
  charWidth: number,
  charHeight: number,
  originalProseSegments: ProseSegment[],
  originalFrameBboxes?: FrameBbox[],
  renderedLines?: Array<{ x: number; y: number; text: string }>,
): string {
```

Replace Phase C (lines 90-137) with:

```typescript
  // Phase C — write prose at rendered positions.
  // If renderedLines provided (from reflowLayout), use those pixel positions.
  // Otherwise fall back to proseSegmentMap (for vitest without browser).
  if (renderedLines && renderedLines.length > 0) {
    for (const line of renderedLines) {
      if (!line.text) continue; // skip empty lines
      const row = Math.round(line.y / charHeight);
      const col = Math.round(line.x / charWidth);
      const chars = [...line.text];
      while (grid.length <= row) grid.push([]);
      while (grid[row].length < col + chars.length) grid[row].push(" ");
      for (let c = 0; c < chars.length; c++) {
        grid[row][col + c] = chars[c];
      }
    }
  } else {
    // Fallback: use proseSegmentMap (no browser context)
    const proseLines = prose.split("\n");
    for (let i = 0; i < proseSegmentMap.length && i < proseLines.length; i++) {
      const { row, col } = proseSegmentMap[i];
      const chars = [...proseLines[i]];
      while (grid.length <= row) grid.push([]);
      while (grid[row].length < col + chars.length) grid[row].push(" ");
      for (let c = 0; c < chars.length; c++) {
        grid[row][col + c] = chars[c];
      }
    }
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/gridSerialize.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gridSerialize.ts src/gridSerialize.test.ts
git commit -m "feat: gridSerialize accepts renderedLines for Phase C prose positioning"
```

---

### Task 2: Pass `linesRef.current` from DemoV2

**Files:**
- Modify: `src/DemoV2.tsx:208-218` (saveToHandle)
- Modify: `src/DemoV2.tsx:653-672` (saveDocument test hook)

**Step 1: No unit test needed** — this is wiring. The Playwright harness tests this end-to-end.

**Step 2: Update `saveToHandle`**

At `src/DemoV2.tsx:212`, add `linesRef.current` as the last argument:

```typescript
const md = gridSerialize(
  getFrames(state), getDoc(state),
  getProseSegmentMap(state), originalGridRef.current,
  cwRef.current, chRef.current,
  getOriginalProseSegments(state),
  frameBboxSnapshotRef.current,
  linesRef.current,  // ← NEW: prose positions from reflowLayout
);
```

**Step 3: Update `saveDocument` test hook**

At `src/DemoV2.tsx:657`, add `linesRef.current`:

```typescript
const md = gridSerialize(
  getFrames(state), getDoc(state),
  getProseSegmentMap(state), originalGridRef.current,
  cw, ch,
  getOriginalProseSegments(state),
  frameBboxSnapshotRef.current,
  linesRef.current,  // ← NEW
);
```

**Step 4: Verify build passes**

Run: `npm run build`
Expected: No type errors

**Step 5: Commit**

```bash
git add src/DemoV2.tsx
git commit -m "feat: pass reflowLayout lines to gridSerialize for prose positioning"
```

---

### Task 3: Run Playwright harness — verify improvements

**Step 1: Run the full harness**

Run: `npx playwright test e2e/harness.spec.ts --workers=1`

Expected: More tests pass than before (especially prose stability, prose teleportation).

**Step 2: Check specific critical tests**

Run: `npx playwright test e2e/harness.spec.ts -g "prose stability|prose order" --workers=1`

Expected:
- "prose stability: sub-char frame move should not scramble distant prose" — PASS
- "prose order preserved when dragging wireframe down" — should improve
- "prose order preserved when dragging wireframe up" — should improve

**Step 3: Review artifacts**

```bash
cat e2e/artifacts/crit-prose-stability/summary.txt
diff e2e/artifacts/crit-prose-stability/input.md e2e/artifacts/crit-prose-stability/output.md
```

**Step 4: Commit if tests improve**

```bash
git add e2e/artifacts/
git commit -m "test: harness results after Phase C reflow rewrite"
```

---

### Task 4: Handle blank lines in renderedLines

`reflowLayout` doesn't emit entries for blank lines — those are gaps in the prose. But blank lines are significant in markdown (paragraph separators). Phase C must write blank lines to the grid at their correct positions.

**Files:**
- Modify: `src/gridSerialize.ts` (Phase C renderedLines path)
- Test: `src/gridSerialize.test.ts`

**Step 1: Write the failing test**

```typescript
it("blank lines between prose paragraphs are preserved", () => {
  const text = "Paragraph one\n\nParagraph two";
  const { frames, proseSegments, originalGrid } = scanToFrames(text, CW, CH);
  const segMap = buildSegmentMap(proseSegments);
  const prose = buildProseDoc(proseSegments);
  const renderedLines = [
    { x: 0, y: 0, text: "Paragraph one" },
    // No entry for blank line at y=18.4
    { x: 0, y: 36.8, text: "Paragraph two" },
  ];
  const result = gridSerialize(
    frames, prose, segMap, originalGrid, CW, CH,
    proseSegments, undefined, renderedLines,
  );
  expect(result).toBe(text); // blank line must survive
});
```

**Step 2: If test fails, fix Phase C**

The fix: after writing all renderedLines, scan the `prose` string for blank lines. For each CM doc line that's empty, find its grid row from the surrounding non-empty lines' positions and ensure that row is blank in the grid.

Alternative simpler fix: always write ALL CM doc lines, using `renderedLines` positions for non-empty lines and `proseSegmentMap` positions for empty lines. This hybrid approach preserves blank line positions without needing to infer them from gaps.

```typescript
if (renderedLines && renderedLines.length > 0) {
  // Build a map: sourceLine → rendered position
  const linePositions = new Map<number, { row: number; col: number }>();
  for (const line of renderedLines) {
    const row = Math.round(line.y / charHeight);
    const col = Math.round(line.x / charWidth);
    // Use sourceLine if available, else derive from y position
    const srcLine = (line as any).sourceLine;
    if (srcLine !== undefined) linePositions.set(srcLine, { row, col });
  }

  // Write all CM doc lines
  const proseLines = prose.split("\n");
  for (let i = 0; i < proseLines.length; i++) {
    const pos = linePositions.get(i) ?? proseSegmentMap[i];
    if (!pos) continue;
    const chars = [...proseLines[i]];
    if (chars.length === 0) continue; // blank line — already blank in grid
    while (grid.length <= pos.row) grid.push([]);
    while (grid[pos.row].length < pos.col + chars.length) grid[pos.row].push(" ");
    for (let c = 0; c < chars.length; c++) {
      grid[pos.row][pos.col + c] = chars[c];
    }
  }
}
```

**Step 3: Run test**

Run: `npx vitest run src/gridSerialize.test.ts`
Expected: PASS

**Step 4: Run Playwright harness**

Run: `npx playwright test e2e/harness.spec.ts --workers=1`

**Step 5: Commit**

```bash
git add src/gridSerialize.ts src/gridSerialize.test.ts
git commit -m "fix: preserve blank lines in renderedLines Phase C path"
```

---

| File | Changes |
|------|---------|
| `src/gridSerialize.ts:23-31` | Add `renderedLines` param to signature |
| `src/gridSerialize.ts:90-137` | Replace dual-path Phase C with renderedLines path + fallback |
| `src/gridSerialize.test.ts` | Add renderedLines test + blank lines test |
| `src/DemoV2.tsx:212` | Pass `linesRef.current` to `gridSerialize` in `saveToHandle` |
| `src/DemoV2.tsx:657` | Pass `linesRef.current` to `gridSerialize` in `saveDocument` hook |

**What does NOT change:** `src/scanToFrames.ts`, `src/frame.ts`, `src/editorState.ts`, `src/proseSegments.ts`, `src/reflowLayout.ts`, `src/preparedCache.ts`. The rendering path, frame model, CM state, and reflow engine are untouched.
