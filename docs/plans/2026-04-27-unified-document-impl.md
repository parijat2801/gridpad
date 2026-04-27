# Unified Document Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the split prose/wireframe architecture with a unified CM doc where wireframe lines are claimed by Frames, Pretext's lineTop positions everything, and serialization is a single-pass line walk.

**Architecture:** The CM doc holds the full .md file content. Wireframe lines are replaced with single-space lines that Frames claim via `docOffset` (CM character offset) + `lineCount`. A `changeFilter` prevents edits to claimed ranges. `reflowLayout` skips claimed lines (advancing lineTop by `lineCount * lineHeight`). Serialization walks CM doc lines: prose lines output directly, claimed lines render frame content as ASCII. No `originalGrid`, no `proseSegmentMap`, no `frameBboxes`.

**Tech Stack:** CodeMirror 6 (`@codemirror/state` ^6.6.0, `@codemirror/view`), Pretext, Vitest, React 19

**Design doc:** `docs/plans/2026-04-27-unified-document.md`

---

## Phase 1: Frame model — add docOffset/lineCount alongside gridRow (incremental)

### Task 1: Add docOffset + lineCount to Frame interface

**Files:**
- Modify: `src/frame.ts:14-44` (Frame interface)
- Modify: `src/frame.ts:64-86` (createFrame)
- Modify: `src/frame.ts:90-115` (createRectFrame)
- Test: `src/frame.test.ts`

**Step 1: Write the failing test**

In `src/frame.test.ts`, add:

```typescript
import { createFrame, createRectFrame } from "./frame";

describe("Frame docOffset/lineCount", () => {
  it("createFrame includes docOffset and lineCount defaults", () => {
    const f = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    expect(f.docOffset).toBe(0);
    expect(f.lineCount).toBe(0);
  });

  it("createRectFrame includes docOffset and lineCount defaults", () => {
    const f = createRectFrame({ gridW: 10, gridH: 5, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: 9.6, charHeight: 18 });
    expect(f.docOffset).toBe(0);
    expect(f.lineCount).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/frame.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `docOffset` property doesn't exist on Frame

**Step 3: Write minimal implementation**

In `src/frame.ts`, add to the `Frame` interface (after `gridH: number;` on line 43):

```typescript
  /** CM doc character offset — start of first claimed line. 0 = not yet placed. */
  docOffset: number;
  /** Number of lines this frame claims in the CM doc. 0 = not yet placed. */
  lineCount: number;
```

Add `docOffset: 0, lineCount: 0` to the return object in every Frame factory function:
- `createFrame` (line 70-86)
- `createRectFrame` (line 96-115)
- `createTextFrame` (line 119-148)
- `createLineFrame` (line 152-178)
- `groupIntoContainers` (line 467, container creation)

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/frame.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Run full test suite to verify no regressions**

Run: `npm test 2>&1 | tail -20`
Expected: All existing tests pass (the new fields default to 0, which doesn't affect existing behavior)

**Step 6: Commit**

```bash
git add src/frame.ts src/frame.test.ts
git commit -m "feat: add docOffset + lineCount to Frame interface (unified doc)"
```

---

### Task 2: Compute docOffset + lineCount in scanToFrames

When the scanner runs on file open, we know which source lines each wireframe occupies (from `gridRow` and `gridH`). We can compute `docOffset` from the source text.

**Files:**
- Modify: `src/scanToFrames.ts:43-87` (scanToFrames function)
- Test: `src/scanToFrames.test.ts`

**Step 1: Write the failing test**

In `src/scanToFrames.test.ts`, add:

```typescript
describe("scanToFrames docOffset/lineCount", () => {
  it("sets docOffset and lineCount for a simple wireframe", () => {
    const text = `Hello world

┌──────┐
│ Box  │
└──────┘

Goodbye`;
    const cw = 9.6, ch = 18;
    const result = scanToFrames(text, cw, ch);
    const frames = result.frames;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const rect = frames[0];
    expect(rect.lineCount).toBe(3);
    // docOffset = character offset of start of line 2 in source text
    // "Hello world\n\n" = 12 + 1 = 13
    expect(rect.docOffset).toBe(13);
  });

  it("sets docOffset for wireframe not at start of file", () => {
    const text = `Line one
Line two
Line three
┌────┐
│ Hi │
└────┘`;
    const cw = 9.6, ch = 18;
    const result = scanToFrames(text, cw, ch);
    const frames = result.frames;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const rect = frames[0];
    expect(rect.lineCount).toBe(3);
    // Lines 0-2: "Line one\nLine two\nLine three\n" = 9+9+11 = 29 chars
    expect(rect.docOffset).toBe(29);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/scanToFrames.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `docOffset` is 0, `lineCount` is 0

**Step 3: Write minimal implementation**

In `src/scanToFrames.ts`, after `const frames = framesFromScan(scanResult, charWidth, charHeight);` (line 53), add:

```typescript
  // Compute docOffset + lineCount from source text line offsets.
  const sourceLines = text.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (let i = 0; i < sourceLines.length; i++) {
    lineOffsets.push(offset);
    offset += sourceLines[i].length + 1; // +1 for \n
  }

  // Set docOffset + lineCount on each top-level frame.
  // A frame's gridRow is its 0-indexed source line number.
  for (const f of frames) {
    const startLine = f.gridRow;
    if (startLine >= 0 && startLine < lineOffsets.length) {
      f.docOffset = lineOffsets[startLine];
      f.lineCount = f.gridH;
    }
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/scanToFrames.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/scanToFrames.ts src/scanToFrames.test.ts
git commit -m "feat: compute docOffset + lineCount in scanToFrames"
```

---

## Phase 2: Unified CM doc — full .md with space-filled wireframe lines

### Task 3: New createEditorStateUnified — CM doc holds full .md

Today `createEditorStateFromText` (in `editorState.ts:340-367`) strips wireframe lines and puts only prose in the CM doc. We add a new factory `createEditorStateUnified` that keeps the full .md text in the CM doc, replacing wireframe line content with single spaces.

**Files:**
- Modify: `src/editorState.ts` (add new factory function)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

In `src/editorState.test.ts`, add:

```typescript
import { createEditorStateUnified, getDoc, getFrames } from "./editorState";

describe("createEditorStateUnified", () => {
  it("CM doc preserves line count with spaces for wireframe lines", () => {
    const text = `Hello

┌──────┐
│ Box  │
└──────┘

Goodbye`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const doc = getDoc(state);
    const lines = doc.split("\n");
    // Original has 7 lines, unified doc should also have 7 lines
    expect(lines.length).toBe(7);
    // Prose lines preserved as-is
    expect(lines[0]).toBe("Hello");
    expect(lines[1]).toBe("");
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("Goodbye");
    // Wireframe lines replaced with single space
    expect(lines[2]).toBe(" ");
    expect(lines[3]).toBe(" ");
    expect(lines[4]).toBe(" ");
  });

  it("frames have correct docOffset pointing into unified doc", () => {
    const text = `Hello

┌──────┐
│ Box  │
└──────┘

Goodbye`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frames = getFrames(state);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const frame = frames[0];
    expect(frame.lineCount).toBe(3);
    // docOffset in the UNIFIED doc (with spaces), not original text.
    // "Hello\n\n" = 6 + 1 = 7 chars. Line 2 starts at offset 7.
    expect(frame.docOffset).toBe(7);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/editorState.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `createEditorStateUnified` doesn't exist

**Step 3: Write minimal implementation**

In `src/editorState.ts`, add after the existing `createEditorStateFromText` function:

```typescript
/**
 * Unified document factory — CM doc holds full .md with spaces on wireframe lines.
 * Frames claim line ranges via docOffset + lineCount.
 */
export function createEditorStateUnified(
  text: string,
  charWidth: number,
  charHeight: number,
): EditorState {
  const { frames } = scanToFrames(text, charWidth, charHeight);

  // Build set of source lines claimed by any frame.
  const claimedLines = new Set<number>();
  for (const f of frames) {
    for (let i = f.gridRow; i < f.gridRow + f.gridH; i++) {
      claimedLines.add(i);
    }
  }

  // Build unified doc: prose lines preserved, wireframe lines → single space.
  const sourceLines = text.split("\n");
  const unifiedLines = sourceLines.map((line, i) =>
    claimedLines.has(i) ? " " : line
  );
  const unifiedText = unifiedLines.join("\n");

  // Recompute docOffset for each frame in the unified doc.
  const lineOffsets: number[] = [];
  let offset = 0;
  for (let i = 0; i < unifiedLines.length; i++) {
    lineOffsets.push(offset);
    offset += unifiedLines[i].length + 1;
  }
  for (const f of frames) {
    if (f.gridRow >= 0 && f.gridRow < lineOffsets.length) {
      f.docOffset = lineOffsets[f.gridRow];
    }
  }

  return createEditorState({ prose: unifiedText, frames });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/editorState.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: All tests pass (new function, no existing code changed)

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: createEditorStateUnified — CM doc holds full .md"
```

---

### Task 4: changeFilter to protect claimed lines

A CM `changeFilter` that returns suppressed ranges for all frame-claimed lines. This prevents the user from typing into wireframe line ranges.

**Files:**
- Modify: `src/editorState.ts` (add changeFilter to createEditorState extensions)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

```typescript
describe("changeFilter protects claimed lines", () => {
  it("rejects insertion into a claimed line", () => {
    const text = `Hello

┌──────┐
│ Box  │
└──────┘

Goodbye`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frames = getFrames(state);
    const frame = frames[0];
    const pos = frame.docOffset;
    const updated = state.update({
      changes: { from: pos, insert: "INJECTED" },
    }).state;
    // Change should be suppressed — doc unchanged at that position
    expect(getDoc(updated)).toBe(getDoc(state));
  });

  it("allows insertion into prose lines", () => {
    const text = `Hello

┌──────┐
│ Box  │
└──────┘

Goodbye`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const updated = state.update({
      changes: { from: 0, insert: "X" },
    }).state;
    expect(getDoc(updated).startsWith("XHello")).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/editorState.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — "INJECTED" appears in the doc (no filter yet)

**Step 3: Write minimal implementation**

In `src/editorState.ts`, in the `createEditorState` function, add to the extensions array before the `return EditorState.create(...)`:

```typescript
  // changeFilter: suppress edits that touch frame-claimed line ranges.
  const claimFilter = EditorState.changeFilter.of((tr) => {
    const frames = tr.startState.field(framesField);
    if (frames.length === 0) return true;
    const dominated: number[] = [];
    for (const f of frames) {
      if (f.lineCount === 0) continue;
      const startLine = tr.startState.doc.lineAt(f.docOffset);
      const endLineNum = startLine.number + f.lineCount - 1;
      if (endLineNum > tr.startState.doc.lines) continue;
      const endLine = tr.startState.doc.line(endLineNum);
      dominated.push(startLine.from, endLine.to);
    }
    return dominated.length > 0 ? dominated : true;
  });
  extensions.push(claimFilter);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/editorState.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: All tests pass. Existing tests use `createEditorStateFromText` which produces frames with `lineCount: 0`, so the filter returns `true` — no regression.

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: changeFilter protects frame-claimed lines from edits"
```

---

### Task 5: docOffset remapping through CM edits (mapPos)

When the user types prose, CM changes the document. Each frame's `docOffset` must be remapped so it continues pointing to the correct line.

**Files:**
- Modify: `src/editorState.ts:87-202` (framesField update function)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

```typescript
describe("docOffset remapping through edits", () => {
  it("inserting a line above wireframe shifts docOffset", () => {
    const text = `Hello

┌──────┐
│ Box  │
└──────┘

Goodbye`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frameBefore = getFrames(state)[0];
    const offsetBefore = frameBefore.docOffset;
    // Insert a newline at end of line 0 ("Hello") — position 5
    const updated = state.update({
      changes: { from: 5, insert: "\nNew line" },
    }).state;
    const frameAfter = getFrames(updated)[0];
    expect(frameAfter.docOffset).toBe(offsetBefore + "\nNew line".length);
    expect(frameAfter.lineCount).toBe(frameBefore.lineCount);
  });

  it("deleting text above wireframe shifts docOffset back", () => {
    const text = `Hello

┌──────┐
│ Box  │
└──────┘

Goodbye`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frameBefore = getFrames(state)[0];
    const offsetBefore = frameBefore.docOffset;
    // Delete "Hello" (positions 0-5)
    const updated = state.update({
      changes: { from: 0, to: 5 },
    }).state;
    const frameAfter = getFrames(updated)[0];
    expect(frameAfter.docOffset).toBe(offsetBefore - 5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/editorState.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — docOffset stays the same after edits

**Step 3: Write minimal implementation**

In `src/editorState.ts`, in the `framesField.update` function (line 89), add docOffset remapping at the top, before effect processing:

```typescript
  update(frames, tr: Transaction) {
    let result = frames;
    // Remap docOffset through document changes (unified doc mode).
    if (tr.docChanged) {
      result = result.map(f => {
        if (f.lineCount === 0) return f; // not a unified-doc frame
        const newOffset = tr.changes.mapPos(f.docOffset);
        return newOffset !== f.docOffset ? { ...f, docOffset: newOffset } : f;
      });
    }
    for (const e of tr.effects) {
      // ... existing effect handling unchanged
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/editorState.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: All tests pass. Existing frames have `lineCount: 0` so the mapPos branch is skipped.

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: remap frame docOffset through CM document changes"
```

---

## Phase 3: Layout — reflowLayout skips claimed lines

### Task 6: Verify reflowLayout handles null (claimed) lines

`reflowLayout` already treats `null` entries in `preparedLines` as empty lines that advance lineTop by lineHeight (line 98-107 of reflowLayout.ts). In unified mode, wireframe source lines are `null` and no obstacles are passed. Verify this works.

**Files:**
- Test: `src/reflowLayout.test.ts`

**Step 1: Write the verification test**

```typescript
describe("reflowLayout with claimed lines (null entries)", () => {
  it("null lines advance lineTop by lineHeight", () => {
    // 5 source lines: all null (simulates: all wireframe, no prose)
    const preparedLines = [null, null, null, null, null];
    const result = reflowLayout(preparedLines, 500, 20, []);
    expect(result.lines.length).toBe(0); // no text output
    expect(result.totalHeight).toBe(100); // 5 * 20
  });
});
```

**Step 2: Run test**

Run: `npx vitest run src/reflowLayout.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS — existing null-line behavior handles this. No code change needed.

**Step 3: Commit (test only)**

```bash
git add src/reflowLayout.test.ts
git commit -m "test: verify reflowLayout handles null (claimed) lines correctly"
```

---

## Phase 4: Serialization — single-pass line walk

### Task 7: New serializeUnified function

A new serializer that walks CM doc lines: prose lines output directly, claimed lines render frame content as ASCII box-drawing characters.

**Files:**
- Create: `src/serializeUnified.ts`
- Create: `src/serializeUnified.test.ts`

**Step 1: Write the failing test**

Create `src/serializeUnified.test.ts`:

```typescript
import { describe, it, expect, vi, beforeAll } from "vitest";
import { serializeUnified } from "./serializeUnified";
import { scanToFrames } from "./scanToFrames";

// Canvas mock for scanner/framesFromScan
beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      // @ts-expect-error mocking canvas getContext for tests
      el.getContext = () => ({
        font: "", fillStyle: "", textBaseline: "",
        fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      });
    }
    return el;
  });
});

describe("serializeUnified", () => {
  it("round-trips a simple wireframe with prose", () => {
    const original = `Hello world

┌──────┐
│ Box  │
└──────┘

Goodbye`;
    const cw = 9.6, ch = 18;
    const { frames } = scanToFrames(original, cw, ch);

    // Build unified doc (prose preserved, wireframe lines → " ")
    const sourceLines = original.split("\n");
    const claimedLines = new Set<number>();
    for (const f of frames) {
      for (let i = f.gridRow; i < f.gridRow + f.gridH; i++)
        claimedLines.add(i);
    }
    const unifiedDoc = sourceLines.map((line, i) =>
      claimedLines.has(i) ? " " : line
    ).join("\n");

    const result = serializeUnified(unifiedDoc, frames);
    expect(result).toBe(original);
  });

  it("round-trips wireframe at start of file", () => {
    const original = `┌──────┐
│ Test │
└──────┘
Some prose`;
    const cw = 9.6, ch = 18;
    const { frames } = scanToFrames(original, cw, ch);
    const sourceLines = original.split("\n");
    const claimedLines = new Set<number>();
    for (const f of frames) {
      for (let i = f.gridRow; i < f.gridRow + f.gridH; i++)
        claimedLines.add(i);
    }
    const unifiedDoc = sourceLines.map((line, i) =>
      claimedLines.has(i) ? " " : line
    ).join("\n");

    const result = serializeUnified(unifiedDoc, frames);
    expect(result).toBe(original);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/serializeUnified.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/serializeUnified.ts`:

```typescript
// src/serializeUnified.ts
// Single-pass serialization for the unified document model.

import type { Frame } from "./frame";
import { repairJunctions } from "./gridSerialize";

/**
 * Serialize the unified CM doc back to a .md file.
 *
 * @param doc - The CM doc text (prose + space-filled wireframe lines)
 * @param frames - Top-level frames with docOffset + lineCount set
 * @returns The reconstructed .md text
 */
export function serializeUnified(doc: string, frames: Frame[]): string {
  const docLines = doc.split("\n");

  // Build line-start offset table for the doc.
  const lineOffsets: number[] = [];
  let pos = 0;
  for (let i = 0; i < docLines.length; i++) {
    lineOffsets.push(pos);
    pos += docLines[i].length + 1;
  }

  // Map: source line number → frames claiming that line.
  const lineToFrames = new Map<number, Frame[]>();
  for (const f of frames) {
    if (f.lineCount === 0) continue;
    // Find 0-indexed line number from docOffset.
    let lineNum = 0;
    for (let i = 0; i < lineOffsets.length; i++) {
      if (lineOffsets[i] === f.docOffset) { lineNum = i; break; }
      if (lineOffsets[i] > f.docOffset) { lineNum = i - 1; break; }
    }
    for (let i = 0; i < f.lineCount; i++) {
      const ln = lineNum + i;
      if (!lineToFrames.has(ln)) lineToFrames.set(ln, []);
      lineToFrames.get(ln)!.push(f);
    }
  }

  // Build output lines.
  const outputLines: string[] = [];
  for (let i = 0; i < docLines.length; i++) {
    const claimingFrames = lineToFrames.get(i);
    if (!claimingFrames || claimingFrames.length === 0) {
      outputLines.push(docLines[i]);
      continue;
    }

    // Wireframe line — render frame cells at this row.
    const rowChars: string[] = [];
    for (const f of claimingFrames) {
      let frameStartLine = 0;
      for (let ln = 0; ln < lineOffsets.length; ln++) {
        if (lineOffsets[ln] === f.docOffset) { frameStartLine = ln; break; }
        if (lineOffsets[ln] > f.docOffset) { frameStartLine = ln - 1; break; }
      }
      const localRow = i - frameStartLine;
      renderFrameRow(f, localRow, f.gridCol, rowChars);
    }
    outputLines.push(rowChars.join("").trimEnd());
  }

  // Repair junctions where frame borders meet
  const grid = outputLines.map(line => [...line]);
  repairJunctions(grid);

  const result = grid.map(row => row.join("").trimEnd());
  while (result.length > 0 && result[result.length - 1] === "") result.pop();
  return result.join("\n");
}

/**
 * Render one row of a frame (and its children) into the rowChars array.
 */
function renderFrameRow(
  frame: Frame,
  localRow: number,
  colOffset: number,
  rowChars: string[],
): void {
  if (localRow < 0 || localRow >= frame.gridH) return;

  if (frame.content) {
    for (const [key, ch] of frame.content.cells) {
      const ci = key.indexOf(",");
      const cellRow = Number(key.slice(0, ci));
      const cellCol = Number(key.slice(ci + 1));
      if (cellRow === localRow) {
        const absCol = colOffset + cellCol;
        while (rowChars.length <= absCol) rowChars.push(" ");
        if (ch !== " " || rowChars[absCol] === " ") {
          rowChars[absCol] = ch;
        }
      }
    }
  }

  for (const child of frame.children) {
    const childLocalRow = localRow - child.gridRow;
    renderFrameRow(child, childLocalRow, colOffset + child.gridCol, rowChars);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/serializeUnified.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/serializeUnified.ts src/serializeUnified.test.ts
git commit -m "feat: serializeUnified — single-pass line-walk serializer"
```

---

## Phase 5: Wire up DemoV2 (the flip)

### Task 8: DemoV2 uses createEditorStateUnified + serializeUnified

This is the integration task. DemoV2 switches from the old pipeline to the unified one.

**Files:**
- Modify: `src/DemoV2.tsx`

**Step 1: Change imports**

Replace:
```typescript
import { gridSerialize, rebuildOriginalGrid, snapshotFrameBboxes, framesToProseGaps, type FrameBbox } from "./gridSerialize";
```
with:
```typescript
import { serializeUnified } from "./serializeUnified";
```

Add `createEditorStateUnified` to the editorState import. Remove `getProseSegmentMap`, `getOriginalProseSegments`, `applySetOriginalProseSegments`.

**Step 2: Change initialization**

Replace `createEditorStateFromText(text, cw, ch)` with `createEditorStateUnified(text, cw, ch)`.

Remove any code that calls `rebuildOriginalGrid`, `snapshotFrameBboxes`, or sets `originalProseSegments`.

**Step 3: Change doLayout**

Replace the `doLayout` function body. The key change: instead of computing obstacles from `gridRow * ch`, pass claimed lines as `null` in preparedLines and pass no obstacles. Then compute frame pixel Y from lineTop.

```typescript
function doLayout() {
  if (!stateRef.current) { linesRef.current = []; return; }
  const ch = chRef.current;
  const frames = getFrames(stateRef.current);

  // Build set of claimed line numbers
  const claimedLines = new Set<number>();
  for (const f of frames) {
    if (f.lineCount === 0) continue;
    const startLine = stateRef.current.doc.lineAt(f.docOffset).number - 1;
    for (let i = 0; i < f.lineCount; i++) claimedLines.add(startLine + i);
  }

  // Build preparedLines: null for claimed lines, prepared text for prose
  const prepared = preparedRef.current;
  const adjusted = prepared.map((p, i) => claimedLines.has(i) ? null : p);

  // No obstacles in unified mode
  linesRef.current = reflowLayout(adjusted, sizeRef.current.w, ch, []).lines;

  // Set frame pixel Y from lineTop accumulator
  let lineTop = 0;
  const doc = stateRef.current.doc;
  for (let i = 0; i < doc.lines; i++) {
    if (claimedLines.has(i)) {
      for (const f of frames) {
        if (f.lineCount === 0) continue;
        const startLine = doc.lineAt(f.docOffset).number - 1;
        if (i === startLine) {
          f.y = lineTop;
          f.x = f.gridCol * cwRef.current;
        }
      }
      lineTop += ch;
    } else {
      const visualLines = linesRef.current.filter(l => l.sourceLine === i);
      lineTop += Math.max(visualLines.length, 1) * ch;
    }
  }
}
```

**Step 4: Change save/serialize**

Replace `gridSerialize(...)` call with:
```typescript
const serialized = serializeUnified(getDoc(stateRef.current), getFrames(stateRef.current));
```

Remove refs/state for `originalGrid`, `originalProseSegments`, `frameBboxes`.

**Step 5: Test manually**

Run: `npm run dev`
Verify wireframes render, prose works, save produces correct .md.

**Step 6: Run e2e tests**

Run: `npx playwright test e2e/harness.spec.ts 2>&1 | tail -30`
Some pixel-position failures expected — wireframe Y comes from lineTop now.

**Step 7: Commit**

```bash
git add src/DemoV2.tsx
git commit -m "feat: DemoV2 uses unified document pipeline"
```

---

## Phase 6: Mutation operations

### Task 9: Verify Enter/Backspace above wireframe (should already work)

**Files:**
- Test: `src/editorState.test.ts`

**Step 1: Write verification tests**

```typescript
describe("Enter/Backspace above wireframe", () => {
  it("Enter above wireframe shifts frame down", () => {
    const text = `Hi
┌────┐
│ Bx │
└────┘`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frameBefore = getFrames(state)[0];
    const updated = state.update({
      changes: { from: 2, insert: "\n" },
    }).state;
    const frameAfter = getFrames(updated)[0];
    expect(frameAfter.docOffset).toBe(frameBefore.docOffset + 1);
    expect(frameAfter.lineCount).toBe(frameBefore.lineCount);
    expect(updated.doc.lines).toBe(state.doc.lines + 1);
  });

  it("Backspace above wireframe shifts frame up", () => {
    const text = `Hi

┌────┐
│ Bx │
└────┘`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frameBefore = getFrames(state)[0];
    const updated = state.update({
      changes: { from: 2, to: 3 },
    }).state;
    const frameAfter = getFrames(updated)[0];
    expect(frameAfter.docOffset).toBe(frameBefore.docOffset - 1);
  });
});
```

**Step 2: Run test — should PASS if Tasks 4-5 are correct**

Run: `npx vitest run src/editorState.test.ts --reporter=verbose 2>&1 | tail -20`

**Step 3: Commit**

```bash
git add src/editorState.test.ts
git commit -m "test: verify Enter/Backspace above wireframe shifts docOffset"
```

---

### Task 10: Resize wireframe — insert/remove claimed lines

**Files:**
- Modify: `src/editorState.ts` (add transactionFilter for resize doc sync)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

```typescript
import { resizeFrameEffect } from "./editorState";
import { Transaction } from "@codemirror/state";

describe("resize wireframe in unified mode", () => {
  it("resize taller inserts blank lines and updates lineCount", () => {
    const text = `Hello
┌────┐
│ Bx │
└────┘
World`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frameBefore = getFrames(state)[0];
    expect(frameBefore.lineCount).toBe(3);
    const docLinesBefore = state.doc.lines;
    const updated = state.update({
      effects: resizeFrameEffect.of({
        id: frameBefore.id, gridW: frameBefore.gridW, gridH: 5,
        charWidth: cw, charHeight: ch,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const frameAfter = getFrames(updated)[0];
    expect(frameAfter.lineCount).toBe(5);
    expect(frameAfter.gridH).toBe(5);
    expect(updated.doc.lines).toBe(docLinesBefore + 2);
  });

  it("resize shorter removes blank lines and updates lineCount", () => {
    const text = `Hello
┌────┐
│ Bx │
│    │
│    │
└────┘
World`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frameBefore = getFrames(state)[0];
    const docLinesBefore = state.doc.lines;
    const updated = state.update({
      effects: resizeFrameEffect.of({
        id: frameBefore.id, gridW: frameBefore.gridW, gridH: 3,
        charWidth: cw, charHeight: ch,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const frameAfter = getFrames(updated)[0];
    expect(frameAfter.lineCount).toBe(3);
    expect(updated.doc.lines).toBe(docLinesBefore - 2);
  });
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL — lineCount doesn't change, doc lines unchanged

**Step 3: Write minimal implementation**

Add a helper to find a frame by id in the frame tree:

```typescript
function findFrameInList(frames: Frame[], id: string): Frame | null {
  for (const f of frames) {
    if (f.id === id) return f;
    const found = findFrameInList(f.children, id);
    if (found) return found;
  }
  return null;
}
```

Add a `transactionFilter` in `createEditorState` that intercepts resize effects and adds doc changes:

```typescript
const unifiedDocSync = EditorState.transactionFilter.of((tr) => {
  for (const e of tr.effects) {
    if (e.is(resizeFrameEffect)) {
      const frames = tr.startState.field(framesField);
      const frame = findFrameInList(frames, e.value.id);
      if (!frame || frame.lineCount === 0) continue;

      const newGridH = Math.max(2, e.value.gridH);
      const delta = newGridH - frame.lineCount;
      if (delta === 0) continue;

      const startLine = tr.startState.doc.lineAt(frame.docOffset);
      const endLineNum = startLine.number + frame.lineCount - 1;
      const endLine = tr.startState.doc.line(endLineNum);

      if (delta > 0) {
        const insert = "\n ".repeat(delta);
        return [tr, { changes: { from: endLine.to, insert }, sequential: true }];
      } else {
        const removeStartLine = tr.startState.doc.line(endLineNum + delta + 1);
        const removeFrom = removeStartLine.from - 1;
        return [tr, { changes: { from: removeFrom, to: endLine.to }, sequential: true }];
      }
    }
  }
  return tr;
});
extensions.push(unifiedDocSync);
```

In the `resizeFrameEffect` handler inside `framesField.update`, after the resize, update lineCount:

```typescript
// After: result = result.map(applyResize); result = markDirtyById(...)
result = result.map(f =>
  f.id === e.value.id && f.lineCount > 0 ? { ...f, lineCount: Math.max(2, e.value.gridH) } : f
);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/editorState.test.ts --reporter=verbose 2>&1 | tail -20`

**Step 5: Run full test suite**

Run: `npm test 2>&1 | tail -20`

**Step 6: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: resize wireframe inserts/removes claimed lines in CM doc"
```

---

### Task 11: Delete wireframe — remove claimed lines from CM doc

**Files:**
- Modify: `src/editorState.ts` (extend transactionFilter for delete)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

```typescript
describe("delete wireframe in unified mode", () => {
  it("deleting a frame removes its claimed lines from CM doc", () => {
    const text = `Hello
┌────┐
│ Bx │
└────┘
World`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frame = getFrames(state)[0];
    expect(frame.lineCount).toBe(3);
    const linesBefore = state.doc.lines;
    const updated = applyDeleteFrame(state, frame.id);
    expect(getFrames(updated).length).toBe(0);
    expect(updated.doc.lines).toBe(linesBefore - 3);
    expect(getDoc(updated)).toBe("Hello\nWorld");
  });
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL — doc lines unchanged

**Step 3: Write minimal implementation**

Extend the `unifiedDocSync` transactionFilter to also handle `deleteFrameEffect`:

```typescript
if (e.is(deleteFrameEffect)) {
  const frames = tr.startState.field(framesField);
  const frame = findFrameInList(frames, e.value.id);
  if (!frame || frame.lineCount === 0) continue;

  const startLine = tr.startState.doc.lineAt(frame.docOffset);
  const endLineNum = startLine.number + frame.lineCount - 1;
  const endLine = tr.startState.doc.line(endLineNum);
  const from = startLine.from > 0 ? startLine.from - 1 : startLine.from;
  const to = endLine.to < tr.startState.doc.length ? endLine.to + 1 : endLine.to;
  return [tr, { changes: { from, to }, sequential: true }];
}
```

**Step 4-6: Standard verify + commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: delete wireframe removes claimed lines from CM doc"
```

---

### Task 12: Drag wireframe — cut + insert claimed lines

**Files:**
- Modify: `src/editorState.ts` (extend transactionFilter for move)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

```typescript
describe("drag wireframe in unified mode", () => {
  it("moving frame down relocates claimed lines", () => {
    const text = `Hello
┌────┐
│ Bx │
└────┘
World
End`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const frame = getFrames(state)[0];
    expect(frame.lineCount).toBe(3);
    const updated = state.update({
      effects: moveFrameEffect.of({
        id: frame.id, dCol: 0, dRow: 2, charWidth: cw, charHeight: ch,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const frameAfter = getFrames(updated)[0];
    expect(updated.doc.lines).toBe(state.doc.lines);
    const startLine = updated.doc.lineAt(frameAfter.docOffset).number - 1;
    expect(startLine).toBe(3); // moved from line 1 to line 3
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Write minimal implementation**

Add a `relocateFrameEffect` to explicitly set docOffset after a drag:

```typescript
const relocateFrameEffect = StateEffect.define<{ id: string; newDocOffset: number }>();
```

In `framesField.update`, handle it:

```typescript
if (e.is(relocateFrameEffect)) {
  result = result.map(f =>
    f.id === e.value.id ? { ...f, docOffset: e.value.newDocOffset } : f
  );
}
```

In the `unifiedDocSync` transactionFilter, handle `moveFrameEffect`:

```typescript
if (e.is(moveFrameEffect) && e.value.dRow !== 0) {
  const frames = tr.startState.field(framesField);
  const frame = findFrameInList(frames, e.value.id);
  if (!frame || frame.lineCount === 0) continue;

  const doc = tr.startState.doc;
  const startLine = doc.lineAt(frame.docOffset);
  const endLineNum = startLine.number + frame.lineCount - 1;
  const endLine = doc.line(endLineNum);

  const claimedContent = doc.sliceString(startLine.from, endLine.to);

  const targetLineNum = Math.max(1, Math.min(doc.lines, startLine.number + e.value.dRow));

  const deleteFrom = startLine.from > 0 ? startLine.from - 1 : startLine.from;
  const deleteTo = endLine.to < doc.length ? endLine.to + 1 : endLine.to;
  const deleteIncludesLeadingNewline = startLine.from > 0;

  const targetLine = doc.line(targetLineNum);
  const insertAt = targetLine.from;

  return [
    {
      effects: [...tr.effects, relocateFrameEffect.of({ id: frame.id, newDocOffset: insertAt })],
      changes: { from: deleteFrom, to: deleteTo },
    },
    {
      changes: {
        from: insertAt,
        insert: (deleteIncludesLeadingNewline ? "\n" : "") + claimedContent + (deleteIncludesLeadingNewline ? "" : "\n"),
      },
      sequential: true,
    },
  ];
}
```

Note: the exact offset arithmetic for cut+insert needs careful testing. The `sequential` flag means the second change's positions refer to the doc after the first change. The `relocateFrameEffect` explicitly sets the new docOffset.

**Step 4-6: Standard verify + commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: drag wireframe relocates claimed lines in CM doc"
```

---

### Task 13: Add new wireframe — insert blank lines + create frame

**Files:**
- Modify: `src/editorState.ts`
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

```typescript
import { createRectFrame } from "./frame";

describe("add wireframe in unified mode", () => {
  it("adding a frame inserts blank lines at insertion point", () => {
    const text = `Hello
World`;
    const cw = 9.6, ch = 18;
    const state = createEditorStateUnified(text, cw, ch);
    const linesBefore = state.doc.lines;
    const newFrame = createRectFrame({
      gridW: 6, gridH: 3,
      style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
      charWidth: cw, charHeight: ch,
    });
    newFrame.docOffset = 6; // start of line 1 ("World")
    newFrame.lineCount = 3;
    const updated = applyAddFrame(state, newFrame);
    expect(updated.doc.lines).toBe(linesBefore + 3);
    expect(updated.doc.line(1).text).toBe("Hello");
    expect(updated.doc.line(2).text).toBe(" ");
    expect(updated.doc.line(3).text).toBe(" ");
    expect(updated.doc.line(4).text).toBe(" ");
    expect(updated.doc.line(5).text).toBe("World");
  });
});
```

**Step 2-3: Extend transactionFilter for addFrameEffect**

In the `unifiedDocSync` filter, handle `addFrameEffect`:

```typescript
if (e.is(addFrameEffect) && e.value.lineCount > 0) {
  const insertAt = e.value.docOffset;
  const insert = (" \n").repeat(e.value.lineCount);
  return [tr, { changes: { from: insertAt, insert }, sequential: true }];
}
```

**Step 4-6: Standard verify + commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: add wireframe inserts blank lines into CM doc"
```

---

## Phase 7: Cursor behavior

### Task 14: Arrow keys skip claimed line ranges

**Files:**
- Modify: `src/editorState.ts` (proseMoveUp, proseMoveDown)
- Test: `src/editorState.test.ts`

**Step 1: Write the failing test**

```typescript
describe("cursor skips claimed lines", () => {
  it("proseMoveDown skips wireframe lines", () => {
    const text = `Hello
┌────┐
│ Bx │
└────┘
World`;
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(text, cw, ch);
    state = moveCursorTo(state, { row: 0, col: 5 });
    state = proseMoveDown(state);
    const cursor = getCursor(state);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(4); // skipped lines 1-3
  });

  it("proseMoveUp skips wireframe lines", () => {
    const text = `Hello
┌────┐
│ Bx │
└────┘
World`;
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(text, cw, ch);
    state = moveCursorTo(state, { row: 4, col: 0 });
    state = proseMoveUp(state);
    const cursor = getCursor(state);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(0); // skipped lines 1-3
  });
});
```

**Step 2: Run test — should FAIL**

**Step 3: Write minimal implementation**

Add a helper in `editorState.ts`:

```typescript
function getClaimedLineRange(state: EditorState, lineNum: number): { start: number; end: number } | null {
  const frames = state.field(framesField);
  for (const f of frames) {
    if (f.lineCount === 0) continue;
    const startLine = state.doc.lineAt(f.docOffset).number - 1;
    const endLine = startLine + f.lineCount - 1;
    if (lineNum >= startLine && lineNum <= endLine) {
      return { start: startLine, end: endLine };
    }
  }
  return null;
}
```

Modify `proseMoveDown`:

```typescript
export function proseMoveDown(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.row >= state.doc.lines - 1) return state;
  let targetRow = cursor.row + 1;
  const claimed = getClaimedLineRange(state, targetRow);
  if (claimed) targetRow = claimed.end + 1;
  if (targetRow >= state.doc.lines) return state;
  const nextLine = state.doc.line(targetRow + 1);
  const nextGraphemes = [...segmenter.segment(nextLine.text)].length;
  return moveCursorTo(state, { row: targetRow, col: Math.min(cursor.col, nextGraphemes) });
}
```

Modify `proseMoveUp` similarly:

```typescript
export function proseMoveUp(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.row === 0) return state;
  let targetRow = cursor.row - 1;
  const claimed = getClaimedLineRange(state, targetRow);
  if (claimed) targetRow = claimed.start - 1;
  if (targetRow < 0) return state;
  const prevLine = state.doc.line(targetRow + 1);
  const prevGraphemes = [...segmenter.segment(prevLine.text)].length;
  return moveCursorTo(state, { row: targetRow, col: Math.min(cursor.col, prevGraphemes) });
}
```

**Step 4-6: Standard verify + commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: arrow keys skip wireframe-claimed line ranges"
```

---

## Phase 8: Cleanup — delete old pipeline

### Task 15: Remove old pipeline code

**Files:**
- Delete: `src/proseSegments.ts`
- Delete: `src/proseSegments.test.ts`
- Modify: `src/editorState.ts` — remove `proseSegmentMapField`, `originalProseSegmentsField`, `getProseSegmentMap`, `getOriginalProseSegments`, `applySetOriginalProseSegments`, `setOriginalProseSegmentsEffect`
- Modify: `src/scanToFrames.ts` — remove `buildProseCells`, `extractProseSegments` import, prose extraction; return only `{ frames }`
- Modify: `src/gridSerialize.ts` — remove `framesToProseGaps`, `rebuildOriginalGrid`, `snapshotFrameBboxes`, `FrameBbox`, `gridSerialize`. Keep `repairJunctions` (used by serializeUnified).
- Modify: `src/DemoV2.tsx` — remove all old-pipeline references
- Modify: `src/frame.ts` — remove `gridRow` from Frame interface (replaced by docOffset). Keep `gridCol`, `gridW`, `gridH`.

**Step 1: Use TypeScript compiler to find dead references**

Run: `npx tsc --noEmit 2>&1 | head -40`
Fix all errors iteratively.

**Step 2: Delete dead files**

Delete `src/proseSegments.ts` and `src/proseSegments.test.ts`.

**Step 3: Run full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: All tests pass

**Step 4: Run e2e tests**

Run: `npx playwright test e2e/ 2>&1 | tail -30`

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove old split-pipeline code (proseSegments, gridRow, etc.)"
```

---

## Phase 9: Verification

### Task 16: Full round-trip verification

**Files:**
- Existing test files

**Step 1: Run round-trip tests**

Run: `npx vitest run src/roundtrip.test.ts --reporter=verbose 2>&1 | tail -30`
Run: `npx vitest run src/harness.test.ts --reporter=verbose 2>&1 | tail -30`

**Step 2: Run e2e harness**

Run: `npx playwright test e2e/harness.spec.ts 2>&1 | tail -30`

**Step 3: Fix any failures**

Most will be due to: gridRow references not fully removed, pixel position differences, serialization edge cases.

**Step 4: Final commit**

```bash
git add -A
git commit -m "test: verify unified document pipeline passes all round-trip tests"
```

---

## Summary

| Phase | Tasks | What it does |
|-------|-------|-------------|
| 1 | 1-2 | Add docOffset/lineCount to Frame, compute in scanToFrames |
| 2 | 3-5 | Unified CM doc factory, changeFilter, mapPos remapping |
| 3 | 6 | Verify reflowLayout handles null (claimed) lines |
| 4 | 7 | New single-pass serializer |
| 5 | 8 | Wire up DemoV2 |
| 6 | 9-13 | Mutation operations (Enter, resize, delete, drag, add) |
| 7 | 14 | Cursor skips claimed lines |
| 8 | 15 | Delete old pipeline code |
| 9 | 16 | Full verification |

Total: 16 tasks. Phases 1-4 are fully incremental — no existing behavior changes. Phase 5 is the flip. Phases 6-9 complete the model and clean up.
