# Grid-First Frames Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make grid coordinates `(row, col, gridW, gridH)` the canonical position for wireframe frames, eliminating all `Math.round(pixel / cellSize)` conversions from the serialization path. Pixel coordinates become derived values for rendering only.

**Architecture:** Add `gridRow`, `gridCol`, `gridW`, `gridH` fields to the `Frame` interface. All frame creation sets grid coords directly; pixel `x/y/w/h` are derived as `gridRow * ch`. Move/resize operate in grid units (integer deltas). The serializer reads grid coords directly — no rounding. `framesToObstacles` derives pixel rects at the rendering boundary. Pretext continues handling prose layout unchanged.

**Tech Stack:** TypeScript, Vitest, Playwright, @chenglou/pretext (unchanged)

---

### Task 1: Add Grid Fields to Frame Interface

**Files:**
- Modify: `src/frame.ts:27-38` (Frame interface)
- Modify: `src/frame.ts:58-76` (createFrame)
- Test: `src/frame.test.ts`

**Step 1: Write the failing test**

Add to `src/frame.test.ts`:

```typescript
describe("grid-first frames", () => {
  it("Frame interface has grid coordinate fields", () => {
    const f = createFrame({ x: 0, y: 0, w: 96, h: 36.8 });
    // New fields should exist (defaulting to 0 until set)
    expect(f).toHaveProperty("gridRow");
    expect(f).toHaveProperty("gridCol");
    expect(f).toHaveProperty("gridW");
    expect(f).toHaveProperty("gridH");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/frame.test.ts -t "Frame interface has grid coordinate fields"`
Expected: FAIL — `gridRow` property not found

**Step 3: Write minimal implementation**

In `src/frame.ts`, add 4 fields to the Frame interface at line 27:

```typescript
export interface Frame {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  children: Frame[];
  content: FrameContent | null;
  clip: boolean;
  dirty: boolean;
  // Grid coordinates — canonical position for serialization.
  // Pixel x/y/w/h are derived as gridRow * ch, gridCol * cw, etc.
  gridRow: number;
  gridCol: number;
  gridW: number;
  gridH: number;
}
```

Update `createFrame` at line 58 to include defaults:

```typescript
export function createFrame(params: {
  x: number;
  y: number;
  w: number;
  h: number;
}): Frame {
  return {
    id: nextId(),
    x: params.x,
    y: params.y,
    w: params.w,
    h: params.h,
    z: 0,
    children: [],
    content: null,
    clip: true,
    dirty: false,
    gridRow: 0,
    gridCol: 0,
    gridW: 0,
    gridH: 0,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/frame.test.ts -t "Frame interface has grid coordinate fields"`
Expected: PASS

**Step 5: Fix all TypeScript errors**

Adding 4 required fields to Frame will break every object literal that constructs a Frame. Search for `{ id:` or `{ ...f,` patterns in frame.ts, editorState.ts, and DemoV2.tsx. Add `gridRow: 0, gridCol: 0, gridW: 0, gridH: 0` defaults wherever a Frame is constructed without the fields. Key locations:

- `frame.ts:378` — `groupIntoContainers` container creation
- `editorState.ts:117` — `addFrameEffect` handler
- `editorState.ts:93-99` — `clearDirtyEffect` handler (spread `...f` already copies all fields)

Run: `npx vitest run` (full suite)
Expected: All 357+ tests pass (grid fields are present but unused — pixel values still canonical)

**Step 6: Commit**

```bash
git add src/frame.ts src/frame.test.ts src/editorState.ts
git commit -m "feat: add gridRow/gridCol/gridW/gridH fields to Frame interface"
```

---

### Task 2: Frame Constructors Set Grid Coords from Scanner Input

**Files:**
- Modify: `src/frame.ts:80-157` (createRectFrame, createTextFrame, createLineFrame)
- Modify: `src/frame.ts:241-304` (framesFromScan)
- Test: `src/frame.test.ts`

**Step 1: Write the failing test**

```typescript
it("createRectFrame sets grid coords", () => {
  const CW = 9.6, CH = 18.4;
  const f = createRectFrame({ gridW: 10, gridH: 5, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: CW, charHeight: CH });
  expect(f.gridW).toBe(10);
  expect(f.gridH).toBe(5);
  expect(f.w).toBeCloseTo(10 * CW);
  expect(f.h).toBeCloseTo(5 * CH);
});

it("createTextFrame sets grid coords from row/col", () => {
  const CW = 9.6, CH = 18.4;
  const f = createTextFrame({ text: "Hello", row: 3, col: 5, charWidth: CW, charHeight: CH });
  expect(f.gridRow).toBe(3);
  expect(f.gridCol).toBe(5);
  expect(f.gridW).toBe(5); // "Hello" is 5 chars
  expect(f.gridH).toBe(1);
});

it("createLineFrame sets grid coords", () => {
  const CW = 9.6, CH = 18.4;
  const f = createLineFrame({ r1: 2, c1: 3, r2: 2, c2: 8, charWidth: CW, charHeight: CH });
  expect(f.gridRow).toBe(2);
  expect(f.gridCol).toBe(3);
  expect(f.gridW).toBe(6); // cols 3-8 inclusive = 6 wide
  expect(f.gridH).toBe(1);
});

it("framesFromScan sets grid coords on all frames", () => {
  const CW = 9.6, CH = 18.4;
  const text = "Prose\n\n┌──────┐\n│      │\n└──────┘\n\nEnd";
  const { frames } = scanToFrames(text, CW, CH);
  // Recursively check all frames have non-zero grid coords
  const check = (fs: Frame[]) => {
    for (const f of fs) {
      if (f.content) {
        expect(f.gridW, `frame ${f.id} gridW`).toBeGreaterThan(0);
        expect(f.gridH, `frame ${f.id} gridH`).toBeGreaterThan(0);
      }
      check(f.children);
    }
  };
  check(frames);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/frame.test.ts -t "grid coords"`
Expected: FAIL — gridW is 0

**Step 3: Implement**

Update `createRectFrame` (line 80):
```typescript
export function createRectFrame(params: {
  gridW: number;
  gridH: number;
  style: RectStyle;
  charWidth: number;
  charHeight: number;
}): Frame {
  const { gridW, gridH, style, charWidth, charHeight } = params;
  const bbox: Bbox = { row: 0, col: 0, w: gridW, h: gridH };
  const cells = regenerateCells(bbox, style);
  return {
    id: nextId(),
    x: 0, y: 0,
    w: gridW * charWidth,
    h: gridH * charHeight,
    z: 0,
    children: [],
    content: { type: "rect", cells, style },
    clip: true,
    dirty: false,
    gridRow: 0, gridCol: 0,  // caller sets position
    gridW,
    gridH,
  };
}
```

Update `createTextFrame` (line 106):
```typescript
export function createTextFrame(params: {
  text: string;
  row: number;
  col: number;
  charWidth: number;
  charHeight: number;
}): Frame {
  const { text, row, col, charWidth, charHeight } = params;
  const cps = [...text];
  const cells = new Map<string, string>();
  cps.forEach((ch, i) => cells.set(`0,${i}`, ch));
  return {
    id: nextId(),
    x: col * charWidth,
    y: row * charHeight,
    w: cps.length * charWidth,
    h: charHeight,
    z: 0,
    children: [],
    content: { type: "text", cells, text },
    clip: false,
    dirty: false,
    gridRow: row,
    gridCol: col,
    gridW: cps.length,
    gridH: 1,
  };
}
```

Update `createLineFrame` (line 135):
```typescript
export function createLineFrame(params: {
  r1: number; c1: number;
  r2: number; c2: number;
  charWidth: number;
  charHeight: number;
}): Frame {
  const { r1, c1, r2, c2, charWidth, charHeight } = params;
  const { bbox, cells } = buildLineCells(r1, c1, r2, c2);
  return {
    id: nextId(),
    x: bbox.col * charWidth,
    y: bbox.row * charHeight,
    w: bbox.w * charWidth,
    h: bbox.h * charHeight,
    z: 0,
    children: [],
    content: { type: "line", cells },
    clip: true,
    dirty: false,
    gridRow: bbox.row,
    gridCol: bbox.col,
    gridW: bbox.w,
    gridH: bbox.h,
  };
}
```

Update `framesFromScan` (line 241) — after creating each frame from a layer, set grid coords:
```typescript
const x = layer.bbox.col * charWidth;
const y = layer.bbox.row * charHeight;
const w = layer.bbox.w * charWidth;
const h = layer.bbox.h * charHeight;
// ...
return {
  id: nextId(), x, y, w, h, z: 0, children: [], content, clip: true, dirty: false,
  gridRow: layer.bbox.row,
  gridCol: layer.bbox.col,
  gridW: layer.bbox.w,
  gridH: layer.bbox.h,
};
```

Update `groupIntoContainers` (line 370) — container grid coords from child union:
```typescript
const minRow = Math.min(...children.map(c => c.gridRow));
const minCol = Math.min(...children.map(c => c.gridCol));
const maxRow = Math.max(...children.map(c => c.gridRow + c.gridH));
const maxCol = Math.max(...children.map(c => c.gridCol + c.gridW));

// Rebase children grid coords to container-relative
const rebasedChildren = children.map(c => ({
  ...c,
  x: c.x - minX,
  y: c.y - minY,
  gridRow: c.gridRow - minRow,
  gridCol: c.gridCol - minCol,
}));

result.push({
  id: nextId(),
  x: minX, y: minY,
  w: maxX - minX, h: maxY - minY,
  z: 0,
  children: rebasedChildren,
  content: null,
  clip: true,
  dirty: false,
  gridRow: minRow,
  gridCol: minCol,
  gridW: maxCol - minCol,
  gridH: maxRow - minRow,
});
```

**Step 4: Run tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/frame.ts src/frame.test.ts
git commit -m "feat: frame constructors set grid coordinates from scanner input"
```

---

### Task 3: moveFrame and resizeFrame Operate in Grid Units

**Files:**
- Modify: `src/frame.ts:200-237` (moveFrame, resizeFrame)
- Modify: `src/editorState.ts:31-43,100-115` (effects + handlers)
- Modify: `src/DemoV2.tsx:584-598` (drag handler)
- Test: `src/frame.test.ts`

**Step 1: Write the failing test**

```typescript
it("moveFrame updates grid coords by cell delta", () => {
  const CW = 9.6, CH = 18.4;
  const f = createRectFrame({ gridW: 8, gridH: 4, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: CW, charHeight: CH });
  Object.assign(f, { gridRow: 5, gridCol: 3, x: 3 * CW, y: 5 * CH });

  // Move right by 2 cells, down by 1 cell
  const moved = moveFrame(f, { dCol: 2, dRow: 1, charWidth: CW, charHeight: CH });
  expect(moved.gridRow).toBe(6);
  expect(moved.gridCol).toBe(5);
  expect(moved.x).toBeCloseTo(5 * CW);
  expect(moved.y).toBeCloseTo(6 * CH);
});

it("resizeFrame updates grid dimensions", () => {
  const CW = 9.6, CH = 18.4;
  const f = createRectFrame({ gridW: 8, gridH: 4, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: CW, charHeight: CH });

  const resized = resizeFrame(f, { gridW: 10, gridH: 6 }, CW, CH);
  expect(resized.gridW).toBe(10);
  expect(resized.gridH).toBe(6);
  expect(resized.w).toBeCloseTo(10 * CW);
  expect(resized.h).toBeCloseTo(6 * CH);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/frame.test.ts -t "moveFrame updates grid|resizeFrame updates grid"`
Expected: FAIL — moveFrame doesn't accept dCol/dRow; resizeFrame doesn't accept gridW/gridH

**Step 3: Implement**

Change `moveFrame` signature to accept grid deltas:

```typescript
export function moveFrame(
  frame: Frame,
  delta: { dCol: number; dRow: number; charWidth: number; charHeight: number },
): Frame {
  return {
    ...frame,
    gridRow: frame.gridRow + delta.dRow,
    gridCol: frame.gridCol + delta.dCol,
    x: (frame.gridCol + delta.dCol) * delta.charWidth,
    y: (frame.gridRow + delta.dRow) * delta.charHeight,
  };
}
```

Change `resizeFrame` to accept grid dimensions:

```typescript
export function resizeFrame(
  frame: Frame,
  size: { gridW: number; gridH: number },
  charWidth: number,
  charHeight: number,
): Frame {
  const gridW = Math.max(2, size.gridW);
  const gridH = Math.max(2, size.gridH);
  const w = gridW * charWidth;
  const h = gridH * charHeight;

  let content = frame.content;
  if (content?.type === "rect" && content.style) {
    const bbox: Bbox = { row: 0, col: 0, w: gridW, h: gridH };
    const cells = regenerateCells(bbox, content.style);
    content = { ...content, cells };
  }

  const resized = { ...frame, w, h, gridW, gridH, content };
  if (content?.type === "rect" && frame.children.length > 0) {
    return layoutTextChildren(resized, charWidth, charHeight);
  }
  return resized;
}
```

Update `moveFrameEffect` in `editorState.ts` to carry grid deltas instead of pixel deltas:

```typescript
export const moveFrameEffect = StateEffect.define<{
  id: string;
  dCol: number;
  dRow: number;
  charWidth: number;
  charHeight: number;
}>();
```

Update the handler at line 100:
```typescript
if (e.is(moveFrameEffect)) {
  const applyMove = (f: Frame): Frame => {
    if (f.id === e.value.id) return moveFrame(f, {
      dCol: e.value.dCol, dRow: e.value.dRow,
      charWidth: e.value.charWidth, charHeight: e.value.charHeight,
    });
    if (f.children.length > 0) return { ...f, children: f.children.map(applyMove) };
    return f;
  };
  result = result.map(applyMove);
  result = markDirtyById(result, e.value.id).frames;
}
```

Update `applyMoveFrame`:
```typescript
export function applyMoveFrame(
  state: EditorState,
  id: string,
  dCol: number,
  dRow: number,
  charWidth: number,
  charHeight: number,
): EditorState {
  return state.update({
    effects: moveFrameEffect.of({ id, dCol, dRow, charWidth, charHeight }),
    annotations: Transaction.addToHistory.of(true),
  }).state;
}
```

Update DemoV2.tsx drag handler (line 584) to compute grid deltas:
```typescript
const cw = cwRef.current, ch = chRef.current;
const targetCol = Math.round(Math.max(0, drag.startFrameX + dx) / cw);
const targetRow = Math.round(Math.max(0, drag.startFrameY + dy) / ch);
const currentCol = Math.round(found.absX / cw);
const currentRow = Math.round(found.absY / ch);
const dCol = targetCol - currentCol;
const dRow = targetRow - currentRow;
if (dCol !== 0 || dRow !== 0) {
  stateRef.current = stateRef.current.update({
    effects: moveFrameEffect.of({ id: drag.frameId, dCol, dRow, charWidth: cw, charHeight: ch }),
    annotations: [Transaction.addToHistory.of(isFirstDragStep)],
  }).state;
  framesRef.current = getFrames(stateRef.current);
}
```

Update all other `moveFrameEffect.of` call sites in DemoV2.tsx (Enter handler line 1038, Backspace handler line 1010, resize handler line 576) to use `{ id, dCol, dRow, charWidth, charHeight }` format.

Update `applyMoveFrame` calls in diagnostic.test.ts to pass `(state, id, dCol, dRow, CW, CH)`.

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/frame.ts src/frame.test.ts src/editorState.ts src/DemoV2.tsx src/diagnostic.test.ts
git commit -m "feat: moveFrame/resizeFrame operate in grid units, pixel coords derived"
```

---

### Task 4: Serializer Reads Grid Coords Directly

**Files:**
- Modify: `src/gridSerialize.ts` (gridSerialize, snapshotFrameBboxes, collectFrameCells, expandGridForFrame)
- Test: `src/roundtrip.test.ts`, `src/diagnostic.test.ts`

**Step 1: Write the failing test**

```typescript
it("gridSerialize uses grid coords, not Math.round", () => {
  // Create a frame with grid coords that DON'T match Math.round(pixel/ch)
  // This proves the serializer reads grid coords, not pixels
  const text = "Prose\n\n┌──────┐\n│      │\n└──────┘\n\nEnd";
  const { originalGrid } = scanToFrames(text, CW, CH);
  let state = createEditorStateFromText(text, CW, CH);
  const origBboxes = snapshotFrameBboxes(getFrames(state), CW, CH);

  // Move by 3 grid cells right (should serialize at col 3, not at any rounded pixel value)
  state = applyMoveFrame(state, getFrames(state)[0].id, 3, 0, CW, CH);
  const result = gridSerialize(
    getFrames(state), getDoc(state),
    getProseSegmentMap(state), originalGrid, CW, CH,
    getOriginalProseSegments(state), origBboxes,
  );

  // The box should start at column 3 exactly
  const boxLine = result.split("\n").find(l => l.includes("┌"));
  expect(boxLine).toBeDefined();
  const indent = boxLine!.indexOf("┌");
  expect(indent).toBe(3);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/roundtrip.test.ts -t "gridSerialize uses grid coords"`
Expected: May pass already if pixel snapping is exact. If so, add a test with fractional charWidth that would cause Math.round mismatch.

**Step 3: Implement**

Replace all `Math.round(absY / ch)` in gridSerialize.ts with direct grid coord reads. The key change is that `collectFrameCells` and `snapshotFrameBboxes` read `f.gridRow`, `f.gridCol`, `f.gridW`, `f.gridH` instead of computing from pixels.

`snapshotFrameBboxes` becomes trivial:
```typescript
export function snapshotFrameBboxes(frames: Frame[]): FrameBbox[] {
  const bboxes: FrameBbox[] = [];
  const collect = (fs: Frame[], offRow: number, offCol: number) => {
    for (const f of fs) {
      const absRow = offRow + f.gridRow;
      const absCol = offCol + f.gridCol;
      if (f.content || f.children.length > 0) {
        bboxes.push({
          id: f.id,
          row: absRow,
          col: absCol,
          w: f.gridW,
          h: f.gridH,
        });
      }
      collect(f.children, absRow, absCol);
    }
  };
  collect(frames, 0, 0);
  return bboxes;
}
```

Note: `snapshotFrameBboxes` no longer needs `charWidth`/`charHeight` parameters. Update all call sites (DemoV2.tsx lines 228, 243, 670; diagnostic.test.ts).

`collectFrameCells` reads grid coords:
```typescript
function collectFrameCells(
  f: Frame,
  offRow: number,
  offCol: number,
  ancestorDirty: boolean,
  clipRect: ClipRect,
  bboxesToBlank: { r1: number; c1: number; r2: number; c2: number }[],
  cellsToWrite: Map<string, string>,
): void {
  const absRow = offRow + f.gridRow;
  const absCol = offCol + f.gridCol;
  // ... (no Math.round anywhere)
  const r1 = absRow;
  const c1 = absCol;
  const r2 = absRow + f.gridH;
  const c2 = absCol + f.gridW;
  // ... rest of function uses r1,c1,r2,c2 directly
}
```

`expandGridForFrame` reads grid coords:
```typescript
function expandGridForFrame(grid: string[][], f: Frame, offRow: number, offCol: number): void {
  const endRow = offRow + f.gridRow + f.gridH;
  const endCol = offCol + f.gridCol + f.gridW;
  while (grid.length < endRow) grid.push([]);
  for (const row of grid) while (row.length < endCol) row.push(" ");
  for (const child of f.children) expandGridForFrame(grid, child, offRow + f.gridRow, offCol + f.gridCol);
}
```

The dirty-path prose reflow (line 222-226) reads grid coords:
```typescript
const frameRows = new Set<number>();
for (const f of frames) {
  for (let r = f.gridRow; r < f.gridRow + f.gridH; r++) frameRows.add(r);
}
```

`gridSerialize` signature drops `charWidth`/`charHeight` since they're no longer needed for grid conversion. But keep them if prose reflow or other logic still needs them. Actually, the wire-char margin blanking in Phase A still needs pixel→grid for the bbox expansion — but the bboxes are now already in grid coords, so no conversion needed. Remove `charWidth`/`charHeight` from `gridSerialize` and `snapshotFrameBboxes`.

Update the `gridSerialize` call signature and all call sites (DemoV2.tsx lines 212-217, 645-650, 657-662; diagnostic.test.ts fullSave helper).

**Step 4: Run full test suite + e2e harness**

Run: `npx vitest run` — all unit tests pass
Run: `npx playwright test e2e/harness.spec.ts` — all 125 pass

**Step 5: Commit**

```bash
git add src/gridSerialize.ts src/DemoV2.tsx src/roundtrip.test.ts src/diagnostic.test.ts
git commit -m "feat: serializer reads grid coords directly — no Math.round in serialize path"
```

---

### Task 5: Update Ghost Detector and Run Full E2E

**Files:**
- Modify: `e2e/test-utils.ts:142-161` (computeFrameGridBboxes)
- Test: `e2e/sweep.spec.ts`, full e2e suite

**Step 1: Update ghost detector to read grid coords**

The `computeFrameGridBboxes` in `e2e/test-utils.ts` currently computes bboxes from pixel positions using `Math.round(absY / ch)`. Update it to read grid coords from the frame tree. The `__gridpad.getFrameTree()` API in DemoV2.tsx needs to expose `gridRow`, `gridCol`, `gridW`, `gridH` in addition to `absX`/`absY`/`w`/`h`.

Update DemoV2.tsx `getFrameTree` (line 684) to include grid coords:
```typescript
getFrameTree: () => {
  const collect = (fs: Frame[], offX: number, offY: number, offRow: number, offCol: number): unknown[] =>
    fs.map(f => ({
      id: f.id,
      absX: offX + f.x, absY: offY + f.y,
      w: f.w, h: f.h,
      gridRow: offRow + f.gridRow,
      gridCol: offCol + f.gridCol,
      gridW: f.gridW,
      gridH: f.gridH,
      contentType: f.content?.type ?? "container",
      text: f.content?.text ?? null,
      dirty: f.dirty,
      childCount: f.children.length,
      children: collect(f.children, offX + f.x, offY + f.y, offRow + f.gridRow, offCol + f.gridCol),
    }));
  return collect(framesRef.current, 0, 0, 0, 0);
},
```

Update `computeFrameGridBboxes` in `e2e/test-utils.ts`:
```typescript
export function computeFrameGridBboxes(
  tree: Array<{ gridRow?: number; gridCol?: number; gridW?: number; gridH?: number; absX: number; absY: number; w: number; h: number; children?: any[] }>,
  cw: number, ch: number,
): Array<{ row: number; col: number; w: number; h: number }> {
  const bboxes: Array<{ row: number; col: number; w: number; h: number }> = [];
  const collect = (nodes: any[]) => {
    for (const n of nodes) {
      // Prefer grid coords if available, fall back to pixel conversion
      if (n.gridRow !== undefined && n.gridW !== undefined) {
        bboxes.push({
          row: n.gridRow,
          col: n.gridCol,
          w: Math.max(1, n.gridW),
          h: Math.max(1, n.gridH),
        });
      } else {
        const r1 = Math.round(n.absY / ch);
        const c1 = Math.round(n.absX / cw);
        const r2 = Math.round((n.absY + n.h) / ch);
        const c2 = Math.round((n.absX + n.w) / cw);
        bboxes.push({ row: r1, col: c1, w: Math.max(1, c2 - c1), h: Math.max(1, r2 - r1) });
      }
      if (n.children) collect(n.children);
    }
  };
  collect(tree);
  return bboxes;
}
```

**Step 2: Run full e2e suite**

Run: `npx playwright test e2e/harness.spec.ts` — 125 tests pass
Run: `npx playwright test e2e/` — measure improvement from 53 failures

**Step 3: Commit**

```bash
git add e2e/test-utils.ts src/DemoV2.tsx
git commit -m "feat: ghost detector reads grid coords — eliminates rounding mismatches"
```

---

### Task 6: Clean Up — Remove Dead Pixel Conversion Code

**Files:**
- Modify: `src/gridSerialize.ts` — remove wire-char margin blanking (no longer needed), simplify
- Modify: `src/frame.ts` — remove `snapToGrid` export (no longer needed)
- Test: full suite

**Step 1: Remove the wire-char margin blanking**

In `gridSerialize.ts` Phase A, the 3-cell margin blanking for orphaned wire chars was a workaround for rounding mismatches. With grid-first coords, the bboxes exactly cover all frame cells. Remove the margin code (lines ~155-170).

**Step 2: Run full test suite**

Run: `npx vitest run` — all pass
Run: `npx playwright test e2e/` — same or better than Task 5

**Step 3: Commit**

```bash
git add src/gridSerialize.ts src/frame.ts
git commit -m "refactor: remove pixel→grid rounding workarounds — grid coords are canonical"
```

---

| File | Changes |
|------|---------|
| `src/frame.ts` | Add `gridRow/gridCol/gridW/gridH` to Frame; constructors set them; moveFrame/resizeFrame operate in grid units |
| `src/editorState.ts` | moveFrameEffect carries grid deltas (dCol, dRow, cw, ch); handler calls updated moveFrame |
| `src/gridSerialize.ts` | Read grid coords directly; drop cw/ch params from snapshotFrameBboxes; remove margin workaround |
| `src/DemoV2.tsx` | Drag handler computes grid deltas; getFrameTree exposes grid coords; save drops cw/ch from snapshot |
| `e2e/test-utils.ts` | Ghost detector reads grid coords from frame tree |
| `src/frame.test.ts` | Grid coord tests for constructors, move, resize |
| `src/roundtrip.test.ts` | Grid-first serialization test |
| `src/diagnostic.test.ts` | Update fullLoad/fullSave helpers for new signatures |

**What does NOT change:** `src/scanner.ts`, `src/layers.ts`, `src/reflowLayout.ts`, `src/preparedCache.ts`, `src/cursorFind.ts`, `src/textFont.ts`, `src/proseSegments.ts`, `src/autoLayout.ts`. Pretext integration is unchanged — `framesToObstacles` still derives pixel rects from grid coords × cell size for prose reflow.
