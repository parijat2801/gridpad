# Phase 5–7 Detailed Plan: DemoV2 Rewrite + Z-order + Cleanup

**Branch:** `feature/demo-rewrite` (Phase 5), `feature/z-order` (Phase 6–7)
**Depends on:** Phase 3 (`editorState.ts` merged), Phase 4 (`canvasRenderer.ts` merged)
**Goal:** Replace the 609-line, 20-ref, 13-mutation-site DemoV2 monolith with a
~150-line shell driven by a single CM `EditorState`. Add z-order. Delete dead code.

**State model:** No zustand anywhere. `DemoV2` holds one
`stateRef: React.MutableRefObject<EditorState>`. Every mutation is:

```typescript
stateRef.current = stateRef.current.update({ changes, effects }).state;
```

Undo/redo: CM's built-in `@codemirror/commands` history. One stack for everything.
Accessors: `getFrames(state)`, `getDoc(state)`, `getCursor(state)`, etc. from
`editorState.ts`. Frame mutations: `StateEffect`s defined in `editorState.ts`.

---

## Phase 4: Canvas Renderer Extraction

**Branch:** `feature/canvas-renderer`
**Depends on:** Phase 3 (`editorState.ts` merged)
**Goal:** Extract all paint logic out of `DemoV2.tsx` into a pure, headlessly-testable
`canvasRenderer.ts`. Phase 5 agents depend on `buildRenderState` and `paintCanvas`
existing here.

### `RenderState` interface

```typescript
// src/canvasRenderer.ts

import type { EditorState } from "@codemirror/state";
import type { Frame } from "./frame";
import type { ProsePart } from "./editorState";

export interface Viewport {
  w: number;
  h: number;
}

export interface RenderState {
  // Canvas geometry
  viewport: Viewport;
  dpr: number;
  scrollTop: number;

  // Prose
  proseText: string;
  proseParts: ProsePart[];

  // Frames (sorted by ascending z — back to front)
  framesInZOrder: Frame[];

  // Selection
  selectedId: string | null;

  // Cell dimensions (needed by paint to convert grid coords → pixels)
  charWidth: number;
  charHeight: number;

  // Cursor (null if no prose cursor active)
  cursor: { row: number; col: number } | null;
}
```

### Task 4.1 — Extract `RenderState` interface and `buildRenderState`

**File:** `src/canvasRenderer.ts` (new)

**Failing test** (`src/canvasRenderer.test.ts` — new):

```typescript
import { describe, it, expect } from "vitest";
import { buildRenderState } from "./canvasRenderer";
import { createEditorState } from "./editorState";

it("buildRenderState extracts prose text", () => {
  const state = createEditorState({ prose: "hello", frames: [], regions: [], proseParts: [] });
  const rs = buildRenderState(state, 0, { w: 800, h: 600 }, 1);
  expect(rs.proseText).toBe("hello");
});

it("buildRenderState exposes charWidth and charHeight", () => {
  const state = createEditorState({ prose: "", frames: [], regions: [], proseParts: [] });
  const rs = buildRenderState(state, 0, { w: 800, h: 600 }, 1);
  expect(rs.charWidth).toBeGreaterThan(0);
  expect(rs.charHeight).toBeGreaterThan(0);
});

it("buildRenderState sorts frames by ascending z", () => {
  const frameA = { ...makeTestFrame(), z: 5, id: "a" };
  const frameB = { ...makeTestFrame(), z: 1, id: "b" };
  const state = createEditorState({ prose: "", frames: [frameA, frameB], regions: [], proseParts: [] });
  const rs = buildRenderState(state, 0, { w: 800, h: 600 }, 1);
  expect(rs.framesInZOrder[0].id).toBe("b");
  expect(rs.framesInZOrder[1].id).toBe("a");
});
```

**Implementation:**

```typescript
export function buildRenderState(
  state: EditorState,
  scrollTop: number,
  viewport: Viewport,
  dpr: number,
): RenderState {
  const frames = getFrames(state);
  return {
    viewport,
    dpr,
    scrollTop,
    proseText: getDoc(state).toString(),
    proseParts: getProseParts(state),
    framesInZOrder: [...frames].sort((a, b) => a.z - b.z),
    selectedId: getSelectedId(state),
    charWidth: DEFAULT_CHAR_WIDTH,   // read from a module-level constant or arg
    charHeight: DEFAULT_CHAR_HEIGHT,
    cursor: getCursor(state),
  };
}
```

Note: `charWidth`/`charHeight` are not stored in CM state — they come from the
canvas measurement at init time. Pass them as additional parameters to
`buildRenderState` (or read from module-level defaults) so `paintCanvas` never
needs to access refs directly.

**Revised signature:**
```typescript
export function buildRenderState(
  state: EditorState,
  scrollTop: number,
  viewport: Viewport,
  dpr: number,
  charWidth: number,
  charHeight: number,
): RenderState
```

In DemoV2:
```typescript
const rs = buildRenderState(stateRef.current, scrollTop, sizeRef.current, dpr, cwRef.current, chRef.current);
```

**Commit:** `feat: scaffold canvasRenderer.ts with RenderState interface and buildRenderState`

---

### Task 4.2 — Extract `paintCanvas`

**File:** `src/canvasRenderer.ts`

Move all draw logic currently in `DemoV2.tsx`'s `paint()` into:

```typescript
export function paintCanvas(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
): void {
  // 1. Clear
  // 2. Apply DPR transform
  // 3. Paint prose text (using rs.proseText, rs.charWidth, rs.charHeight, rs.cursor)
  // 4. Paint frames in z-order (rs.framesInZOrder)
  // 5. Paint selection outline on top (rs.selectedId)
}
```

`paintCanvas` is a pure function: same inputs → same canvas output. No refs, no
closures over DemoV2 state.

**Commit:** `feat: extract paintCanvas into canvasRenderer.ts — pure paint function`

---

### Task 4.3 — Tests with mock canvas context

Use the shared `makeMockCtx()` from `src/test-utils.ts` (created in Phase 7 Task 7.2,
but stub it here for Phase 4 tests — Task 7.2 will consolidate later).

```typescript
it("paintCanvas calls fillRect for each frame", () => {
  const ctx = makeMockCtx();
  const frame = { ...makeTestFrame(), x: 0, y: 0, w: 90, h: 54, z: 0 };
  const rs: RenderState = {
    viewport: { w: 800, h: 600 },
    dpr: 1,
    scrollTop: 0,
    proseText: "",
    proseParts: [],
    framesInZOrder: [frame],
    selectedId: null,
    charWidth: 9,
    charHeight: 18,
    cursor: null,
  };
  paintCanvas(ctx as unknown as CanvasRenderingContext2D, rs);
  const fillCalls = ctx.__calls.filter(c => c.method === "fillRect");
  expect(fillCalls.length).toBeGreaterThan(0);
});
```

**Verify:** `npm test src/canvasRenderer.test.ts` — all pass.

**Commit:** `test: canvasRenderer mock-ctx tests for buildRenderState and paintCanvas`

---

### Phase 4 acceptance criteria

- [ ] `src/canvasRenderer.ts` exists with `RenderState`, `buildRenderState`, `paintCanvas`.
- [ ] `src/canvasRenderer.test.ts` exists with at least 3 passing tests.
- [ ] `DemoV2.tsx` `paint()` delegates entirely to `buildRenderState` + `paintCanvas`.
- [ ] `npm test` passes.
- [ ] No paint logic remains in `DemoV2.tsx` (only the `paint()` wrapper function).

---

## Phase 5: DemoV2 Rewrite

### Overview of current pain points (from reading DemoV2.tsx)

| Problem | Lines | Fix |
|---------|-------|-----|
| 20 refs — framesRef, proseRef, preparedRef, metaRef, selectedRef, dragRef, cwRef, chRef, sizeRef, activeToolRef, proseCursorRef, blinkRef, textEditRef, lastClickRef, drawPreviewRef, textPlacementRef, fileHandleRef, autosaveTimerRef, regionsRef, prosePartsRef | 75–98 | All state moves into CM `EditorState` or stays as truly ephemeral UI refs (drag delta, blink timer) |
| `loadDocument` writes to 7 refs directly | 119–137 | Returns a new `EditorState`, stored in one ref |
| `paint()` reads from 10+ refs | 152–243 | Reads from `buildRenderState(stateRef.current, ...)` |
| `saveToHandle` passes stale `prosePartsRef` | 101–111 | Rebuild prose from CM doc at save time |
| `framesRef.current = replaceFrame(...)` at 5+ sites | 388, 392, 408, 411, 501, 514 | Single `stateRef.current = stateRef.current.update({effects: [...]}).state` |
| `proseRef.current = ...` on every keystroke | 548, 554, 561 | CM transaction on doc |

### Target architecture for DemoV2.tsx

```
DemoV2 (~150 lines)
├── Refs (3 state-bearing): canvasRef, sizeRef, stateRef (EditorState)
├── Ephemeral UI refs (not in CM): dragRef, blinkRef, lastClickRef,
│   drawPreviewRef, textPlacementRef
├── useEffect[]: measureCellSize → loadDocument → paint
├── useEffect[]: resize listener → paint
├── useEffect[]: blink interval → paint
├── useEffect[]: keydown → dispatch CM transaction or effect
├── onMouseDown: hit test → start drag or select or prose click
├── onMouseMove: drag → dispatch moveFrame/resizeFrame effect
├── onMouseUp: commit drag (final position already in CM state)
├── paint(): buildRenderState(stateRef.current, ...) → paintCanvas(ctx, rs)
└── JSX: toolbar + canvas + scroll spacer
```

---

### Task 5.1 — Prose display (read-only rendering from CM doc)

**Failing test first** (`src/canvasRenderer.test.ts` — should already exist from Phase 4):

```typescript
it("renders prose text from CM EditorState", () => {
  const state = createEditorState({ prose: "hello world", frames: [], regions: [], proseParts: [] });
  const rs = buildRenderState(state, 0, { w: 800, h: 600 }, 1);
  expect(rs.proseText).toBe("hello world");
  expect(rs.frames).toHaveLength(0);
});
```

**Implementation steps:**

1. In `src/DemoV2.tsx`, replace `proseRef`, `preparedRef`, `metaRef`, `regionsRef`,
   `prosePartsRef` with `stateRef: React.MutableRefObject<EditorState>`.

2. Rewrite `loadDocument(text: string)`:
   ```typescript
   function loadDocument(text: string) {
     stateRef.current = createEditorStateFromText(text, cwRef.current, chRef.current);
     // createEditorStateFromText internally runs scanToFrames + detectRegions +
     // framesFromRegions and populates all StateFields.
   }
   ```

3. Rewrite `paint()`:
   ```typescript
   function paint() {
     const canvas = canvasRef.current;
     if (!canvas) return;
     const scrollTop = canvas.parentElement?.scrollTop ?? 0;
     const dpr = window.devicePixelRatio || 1;
     const rs = buildRenderState(stateRef.current, scrollTop, sizeRef.current, dpr);
     const ctx = canvas.getContext("2d")!;
     paintCanvas(ctx, rs);
   }
   ```

4. `doLayout()` is absorbed into `buildRenderState` in `canvasRenderer.ts`.
   Remove `doLayout` from DemoV2.

**Verify:** `npm test` passes. Open dev server — default document renders prose
and frames correctly.

**Commit:** `feat: DemoV2 reads prose and frames from CM EditorState (display only)`

---

### Task 5.2 — Prose editing (insert/delete/cursor via CM transactions)

**Failing test** (`src/editorState.test.ts` — should exist from Phase 3):

```typescript
it("proseInsert advances cursor and updates doc", () => {
  const s0 = createEditorStateFromText("hello", 9, 18);
  const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
  expect(getDoc(s1).toString()).toBe("hello!");
  expect(getCursor(s1)).toEqual({ row: 0, col: 6 });
});

it("proseDelete removes char before cursor", () => {
  const s0 = createEditorStateFromText("hello", 9, 18);
  const s1 = proseDelete(s0, { row: 0, col: 5 });
  expect(getDoc(s1).toString()).toBe("hell");
  expect(getCursor(s1)).toEqual({ row: 0, col: 4 });
});
```

**Implementation steps:**

1. In the `keydown` handler, replace the prose cursor branch:

   Before:
   ```typescript
   const r = insertChar(proseRef.current, cursor, e.key);
   proseRef.current = r.text;
   proseCursorRef.current = r.cursor;
   preparedRef.current = prepareWithSegments(proseRef.current, FONT, { whiteSpace: "pre-wrap" });
   ```

   After:
   ```typescript
   stateRef.current = proseInsert(stateRef.current, getCursor(stateRef.current), e.key);
   ```

2. Backspace: `stateRef.current = proseDelete(stateRef.current, getCursor(stateRef.current))`.

3. Arrow keys: call `proseMoveLeft`, `proseMoveRight`, `proseMoveUp`, `proseMoveDown`
   from `editorState.ts`.

4. `proseCursorFromClick(px, py)` — now returns `{ row, col }` and dispatches:
   ```typescript
   stateRef.current = proseSetCursor(stateRef.current, result);
   ```

5. Remove `proseCursorRef` — cursor is `getCursor(stateRef.current)`.
6. Remove `proseRef` — prose text is `getDoc(stateRef.current).toString()`.
7. Remove `preparedRef` — `buildRenderState` calls `prepareWithSegments` internally.

**Verify:** Type into prose. Cursor blinks. Backspace removes chars. Arrow keys move.
Cmd+Z reverts text edits.

**Commit:** `feat: prose editing via CM transactions, remove proseCursorRef/proseRef`

---

### Task 5.3 — Frame display + drag via CM StateEffects

**Failing test** (`src/editorState.test.ts`):

```typescript
it("moveFrameEffect updates frame position", () => {
  const frame = createRectFrame({ gridW: 5, gridH: 3, style: LIGHT_STYLE, charWidth: 9, charHeight: 18 });
  const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
  const s1 = s0.update({
    effects: [moveFrameEffect.of({ id: frame.id, dx: 10, dy: 20 })]
  }).state;
  expect(getFrames(s1)[0].x).toBe(frame.x + 10);
  expect(getFrames(s1)[0].y).toBe(frame.y + 20);
});
```

**Implementation steps:**

1. Replace `framesRef` reads with `getFrames(stateRef.current)`.

2. Add `selectedIdField: StateField<string | null>` in `editorState.ts`:
   ```typescript
   export const selectFrameEffect = StateEffect.define<string | null>();
   const selectedIdField = StateField.define<string | null>({
     create: () => null,
     update(val, tr) {
       for (const e of tr.effects) {
         if (e.is(selectFrameEffect)) return e.value;
       }
       return val;
     },
   });
   export function getSelectedId(state: EditorState): string | null {
     return state.field(selectedIdField);
   }
   ```

3. In `onMouseDown`: when a frame is hit, dispatch `selectFrameEffect.of(hit.id)`.
   When clicking empty space, dispatch `selectFrameEffect.of(null)`.

4. `dragRef` stays as an ephemeral ref — holds in-flight drag delta, not frame
   position. Shape:
   ```typescript
   interface DragState {
     frameId: string;
     startX: number; startY: number;
     startFrameX: number; startFrameY: number;
     startFrameW: number; startFrameH: number;
     hasMoved: boolean;
     resizeHandle?: ResizeHandle;
   }
   ```

5. In `onMouseMove` (drag path):
   - Compute `dx, dy` from drag start.
   - Dispatch `moveFrameEffect` WITHOUT adding to history (intermediate frames):
     ```typescript
     stateRef.current = stateRef.current.update({
       effects: [moveFrameEffect.of({ id: drag.frameId, dx, dy })],
       annotations: [Transaction.addToHistory.of(false)],
     }).state;
     ```

6. In `onMouseUp`:
   - Dispatch final position WITH history (completed drag = one undo step):
     ```typescript
     stateRef.current = stateRef.current.update({
       effects: [moveFrameEffect.of({ id: drag.frameId, dx: finalDx, dy: finalDy })],
       // addToHistory defaults to true
     }).state;
     ```
   - Set `dragRef.current = null`.

7. Remove `findFrameById` — replaced by `getFrames(state).find(f => f.id === id)`.
   If the frame model from Phase 2 remains hierarchical (container + children),
   write a flat-finder helper in `editorState.ts` that recurses if needed.

8. Remove `replaceFrame` — mutation is via CM effects.

**Verify:** Frames render. Click selects (blue outline). Drag moves frame. Cmd+Z
reverts position. Frame position survives prose edits in same undo stack.

**Commit:** `feat: frame drag and selection via CM StateEffects, remove framesRef`

---

### Task 5.4 — Frame resize via CM StateEffects

**Failing test:**

```typescript
it("resizeFrameEffect updates frame dimensions", () => {
  const frame = createRectFrame({ gridW: 5, gridH: 3, style: LIGHT_STYLE, charWidth: 9, charHeight: 18 });
  const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
  const s1 = s0.update({
    effects: [resizeFrameEffect.of({ id: frame.id, w: 90, h: 54, charWidth: 9, charHeight: 18 })]
  }).state;
  expect(getFrames(s1)[0].w).toBe(90);
  expect(getFrames(s1)[0].h).toBe(54);
});
```

**Implementation** (`src/editorState.ts`):

`resizeFrameEffect` is already defined in Phase 3 with `charWidth` and `charHeight`
in the payload — no new definition needed here.

In `framesField.update`, handle `resizeFrameEffect` by calling
`resizeFrame(frame, { w, h }, charWidth, charHeight)` (from `frame.ts`).

In `onMouseMove` (resize handle path), dispatch both effects in one transaction:

```typescript
stateRef.current = stateRef.current.update({
  effects: [
    resizeFrameEffect.of({ id, w: newW, h: newH, charWidth: cwRef.current, charHeight: chRef.current }),
    moveFrameEffect.of({ id, dx: newDx, dy: newDy }),
  ],
  annotations: [Transaction.addToHistory.of(false)],
}).state;
```

`computeHandleRects` and `hitTestHandle` stay as pure functions. Extract to
`src/resizeHandles.ts` if DemoV2 still exceeds 150 lines after all tasks.

**Verify:** Resize handle drag changes frame size. Rect frames rebuild glyph cells.
Cmd+Z restores original size.

**Commit:** `feat: frame resize via CM resizeFrameEffect`

---

### Task 5.5 — Drawing tools (rect/line/text) via CM addFrame effect

**Failing test:**

```typescript
it("addFrameEffect appends a frame", () => {
  const s0 = createEditorState({ prose: "", frames: [], regions: [], proseParts: [] });
  const frame = createRectFrame({ gridW: 5, gridH: 3, style: LIGHT_STYLE, charWidth: 9, charHeight: 18 });
  const s1 = s0.update({ effects: [addFrameEffect.of(frame)] }).state;
  expect(getFrames(s1)).toHaveLength(1);
  expect(getFrames(s1)[0].id).toBe(frame.id);
});
```

**Implementation** (`src/editorState.ts`):

```typescript
export const addFrameEffect = StateEffect.define<Frame>();
```

In `framesField.update`:
```typescript
if (e.is(addFrameEffect)) {
  frames = [...frames, e.value];
}
```

In `onMouseUp` (drawing tool path):

Before:
```typescript
framesRef.current = [...framesRef.current, { ...f, x: x1, y: y1 }];
```

After:
```typescript
stateRef.current = stateRef.current.update({
  effects: [addFrameEffect.of({ ...f, x: x1, y: y1 })]
}).state;
```

**Tool state in CM:**

Add `toolField: StateField<ToolName>` in `editorState.ts`:
```typescript
export const setToolEffect = StateEffect.define<ToolName>();
const toolField = StateField.define<ToolName>({
  create: () => "select",
  update(val, tr) {
    for (const e of tr.effects) {
      if (e.is(setToolEffect)) return e.value;
    }
    return val;
  },
});
export function getTool(state: EditorState): ToolName {
  return state.field(toolField);
}
```

`setTool(t)` in DemoV2 becomes:
```typescript
function setTool(t: ToolName) {
  stateRef.current = stateRef.current.update({
    effects: [setToolEffect.of(t)]
  }).state;
  drawPreviewRef.current = null;
  textPlacementRef.current = null;
  forceUpdate(n => n + 1);  // toolbar re-render
}
```

Remove `activeToolRef` and `useState<ToolName>` pair. Use `getTool(stateRef.current)`
in the toolbar render. Trigger React re-renders for toolbar via the tick counter
described in the risks section.

`drawPreviewRef` and `textPlacementRef` remain as ephemeral refs — they are purely
visual feedback, not meaningful to persist in undo history.

**Verify:** Draw rect with R-drag. Draw line with L-drag. Type T then click to
place text. Cmd+Z removes newly drawn frame.

**Commit:** `feat: drawing tools dispatch addFrameEffect, tool state in CM toolField`

---

### Task 5.6 — Text frame editing via CM effects

**Failing test:**

```typescript
it("editTextFrameEffect updates text content and rebuilds cells", () => {
  const frame = createTextFrame({ text: "hello", row: 0, col: 0, charWidth: 9, charHeight: 18 });
  const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
  const s1 = s0.update({
    effects: [editTextFrameEffect.of({ id: frame.id, text: "hello!", charWidth: 9 })]
  }).state;
  const f = getFrames(s1)[0];
  expect(f.content?.text).toBe("hello!");
  expect(f.content?.cells.get("0,5")).toBe("!");
});
```

**Implementation** (`src/editorState.ts`):

```typescript
export const editTextFrameEffect = StateEffect.define<{ id: string; text: string }>();
export const setTextEditEffect = StateEffect.define<{ frameId: string; col: number } | null>();

const textEditField = StateField.define<{ frameId: string; col: number } | null>({
  create: () => null,
  update(val, tr) {
    for (const e of tr.effects) {
      if (e.is(setTextEditEffect)) return e.value;
    }
    return val;
  },
});
export function getTextEdit(state: EditorState) {
  return state.field(textEditField);
}
```

In `framesField.update`, handle `editTextFrameEffect`:
```typescript
if (e.is(editTextFrameEffect)) {
  frames = frames.map(f => {
    if (f.id !== e.value.id) return f;
    const cps = [...e.value.text];
    const cells = new Map<string, string>();
    cps.forEach((ch, i) => cells.set(`0,${i}`, ch));
    // charWidth is passed in the effect payload — no cellSizeField needed
    const cw = e.value.charWidth;
    return {
      ...f,
      w: Math.max(cps.length, 1) * cw,
      content: { ...f.content!, text: e.value.text, cells },
    };
  });
}
```

Note: `charWidth` is carried in the `editTextFrameEffect` payload
(`{ id: string; text: string; charWidth: number }`). No `cellSizeField` is needed.

In DemoV2 `keydown` text-edit branch:
```typescript
const te = getTextEdit(stateRef.current);
if (te) {
  const frames = getFrames(stateRef.current);
  const frame = frames.find(f => f.id === te.frameId);
  const oldText = frame?.content?.text ?? "";
  const cps = [...oldText];
  // insert/delete logic identical to current code
  const newText = /* ... */;
  const newCol = /* ... */;
  stateRef.current = stateRef.current.update({
    effects: [
      editTextFrameEffect.of({ id: te.frameId, text: newText, charWidth: cwRef.current }),
      setTextEditEffect.of({ frameId: te.frameId, col: newCol }),
    ]
  }).state;
}
```

Remove `textEditRef` — cursor col is `getTextEdit(state)?.col`.
Remove `buildTextCells` from DemoV2 — logic moves into `framesField.update`.

**Verify:** Double-click a text frame. Type chars. Backspace removes. Escape exits.
Cmd+Z reverts text changes.

**Commit:** `feat: text frame editing via CM effects, remove textEditRef`

---

### Task 5.7 — File I/O (open/save with rebuilt prose)

**Key fix for P0 bug R6 (prose edits lost on save):**

`saveToHandle` currently passes `prosePartsRef.current` which is set once at load
and never updated when the user types. In the new architecture, prose parts are
derived at save time from the CM doc + region boundaries stored in `regionsField`.

**Implementation** (`src/editorState.ts`):

```typescript
/**
 * Rebuild prose parts from the current CM doc and region layout.
 * Regions are stored as-scanned; prose text is the living CM doc.
 * The CM doc contains ONLY prose text — wireframe lines are not stored in the doc.
 * Walk regions: for each prose region, advance lineOffset and extract from doc.
 * Skip wireframe regions entirely when counting lines in the CM doc.
 */
export function rebuildProseParts(
  state: EditorState
): { startRow: number; text: string }[] {
  const regions = getRegions(state);
  const doc = getDoc(state);
  const lines = doc.toString().split("\n");
  const parts: { startRow: number; text: string }[] = [];
  let lineOffset = 0;

  for (const region of regions) {
    if (region.type === "prose") {
      const regionLines = region.text.split("\n").length;
      const slice = lines.slice(lineOffset, lineOffset + regionLines).join("\n");
      parts.push({ startRow: region.startRow, text: slice });
      lineOffset += regionLines;
      // wireframe regions do NOT advance lineOffset — they have no lines in the CM doc
    }
  }
  return parts;
}
```

In DemoV2 `saveToHandle`:

```typescript
async function saveToHandle(h: FileSystemFileHandle) {
  const state = stateRef.current;
  const md = framesToMarkdown(
    getFrames(state),
    rebuildProseParts(state),   // rebuilt from CM doc, not stale ref
    getRegions(state),
    cwRef.current,
    chRef.current,
  );
  const w = await (h as WritableHandle).createWritable();
  await w.write(md);
  await w.close();
}
```

`scheduleAutosave` and file open handler — structure unchanged.

**Verify:** Open a .md file. Edit prose. Save. Reopen — prose changes persisted.
Move a wireframe. Save. Reopen — wireframe at new position.

**Commit:** `fix: rebuild prose parts from CM doc at save time — fixes R6 stale data bug`

---

### Task 5.8 — Final DemoV2 line-count audit

After Tasks 5.1–5.7, check:

```bash
wc -l src/DemoV2.tsx
```

Target: < 150 lines.

Remaining refs in DemoV2:
- State-bearing (3): `canvasRef`, `sizeRef`, `stateRef`
- Ephemeral UI (5 — not CM): `dragRef`, `blinkRef`, `lastClickRef`,
  `drawPreviewRef`, `textPlacementRef`

If still over 150 lines, extract:
- `computeHandleRects` + `hitTestHandle` → `src/resizeHandles.ts`
- `DEFAULT_TEXT` → `src/fixtures/defaultText.ts`
- Toolbar JSX → `src/Toolbar.tsx`

**Commit:** `refactor: DemoV2 final trim to <150 lines`

---

### Phase 5 acceptance criteria

- [ ] `npm test` passes (400+ tests).
- [ ] `npx playwright test` passes.
- [ ] `DemoV2.tsx` is < 150 lines.
- [ ] `DemoV2.tsx` has exactly 3 state-bearing refs: `canvasRef`, `sizeRef`, `stateRef`.
- [ ] Cmd+Z / Cmd+Y undo/redo works for prose edits, frame moves, frame draws.
- [ ] Prose edits are saved correctly (R6 fix verified).
- [ ] No `framesRef`, `proseRef`, `preparedRef`, `metaRef`, `regionsRef`,
  `prosePartsRef`, `proseCursorRef`, `textEditRef`, or `activeToolRef` in DemoV2.tsx.

---

## Phase 6: Z-order + Overlap

### Overview

Currently frames have no z-order. Overlapping frames produce character soup because
render order is array order and hit testing uses forward scan. This phase:

1. Adds `z: number` to `Frame`.
2. Adds `setZEffect` StateEffect.
3. Sorts by z in renderer (lowest z first = back layer).
4. Hit tests in reverse z-order (highest z first = topmost wins).
5. Adds a solid background `fillRect` per frame so overlapping frames are readable.
6. Adds `]` / `[` keyboard shortcuts for send-forward / send-backward.

---

### Task 6.1 — Add `z` field to Frame type

**File:** `src/frame.ts`

**Failing test** (`src/frame.test.ts`):

```typescript
it("createRectFrame has z = 0 by default", () => {
  const f = createRectFrame({ gridW: 3, gridH: 2, style: LIGHT_STYLE, charWidth: 9, charHeight: 18 });
  expect(f.z).toBe(0);
});

it("createTextFrame has z = 0 by default", () => {
  const f = createTextFrame({ text: "hi", row: 0, col: 0, charWidth: 9, charHeight: 18 });
  expect(f.z).toBe(0);
});
```

**Implementation:**

Add `z: number` to the `Frame` interface:

```typescript
export interface Frame {
  id: string;
  x: number;
  y: number;
  z: number;   // <-- new: render/hit-test order, 0 = back
  w: number;
  h: number;
  children: Frame[];
  content: FrameContent | null;
  clip: boolean;
}
```

Update all `Frame` constructors (`createFrame`, `createRectFrame`, `createTextFrame`,
`createLineFrame`) to include `z: 0`.

Update `framesFromRegions` to set `z: 0` on all created frames (both container and
children).

Verify `moveFrame` and `resizeFrame` preserve `z` in their spreads — both use
`{ ...frame, ... }` so `z` is preserved automatically. No change needed.

**Verify:** `npm test` — all existing tests pass with `z: 0` default.

**Commit:** `feat: add z field to Frame type, default 0`

---

### Task 6.2 — `setZEffect` StateEffect in editorState.ts

**Failing test** (`src/editorState.test.ts`):

```typescript
it("setZEffect updates frame z value", () => {
  const frame = createRectFrame({ gridW: 5, gridH: 3, style: LIGHT_STYLE, charWidth: 9, charHeight: 18 });
  const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
  const s1 = s0.update({
    effects: [setZEffect.of({ id: frame.id, z: 3 })],
    annotations: [Transaction.addToHistory.of(true)],
  }).state;
  expect(getFrames(s1)[0].z).toBe(3);
});

it("setZEffect is undoable", () => {
  const frame = createRectFrame({ gridW: 5, gridH: 3, style: LIGHT_STYLE, charWidth: 9, charHeight: 18 });
  const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
  const s1 = s0.update({
    effects: [setZEffect.of({ id: frame.id, z: 5 })],
    annotations: [Transaction.addToHistory.of(true)],
  }).state;
  const s2 = editorUndo(s1);
  expect(getFrames(s2)[0].z).toBe(0);
});
```

**Implementation** (`src/editorState.ts`):

```typescript
export const setZEffect = StateEffect.define<{ id: string; z: number }>();
```

In `framesField.update`:

```typescript
if (e.is(setZEffect)) {
  frames = frames.map(f =>
    f.id === e.value.id ? { ...f, z: e.value.z } : f
  );
}
```

**Commit:** `feat: setZEffect changes frame z in framesField, undoable`

---

### Task 6.3 — Sort by z in canvasRenderer.ts

**Failing test** (`src/canvasRenderer.test.ts`):

```typescript
it("framesInZOrder sorts lowest z first", () => {
  const frameA = { ...makeTestFrame(), z: 2, id: "a" };
  const frameB = { ...makeTestFrame(), z: 0, id: "b" };
  const s = createEditorState({ prose: "", frames: [frameA, frameB], regions: [], proseParts: [] });
  const rs = buildRenderState(s, 0, { w: 800, h: 600 }, 1);
  expect(rs.framesInZOrder[0].id).toBe("b");  // z=0 renders first (back)
  expect(rs.framesInZOrder[1].id).toBe("a");  // z=2 renders last (front)
});
```

**Implementation** (`src/canvasRenderer.ts`):

In `buildRenderState`:

```typescript
const frames = getFrames(state);
const framesInZOrder = [...frames].sort((a, b) => a.z - b.z);
return { ..., framesInZOrder };
```

In `paintCanvas`, iterate `rs.framesInZOrder` instead of `rs.frames` for frame
rendering. Selection outline renders last (after all frames) regardless of z-order —
it should always be on top.

**Commit:** `feat: render frames in z-order, lowest z at back`

---

### Task 6.4 — Background fill per frame

**Failing test** (`src/canvasRenderer.test.ts`):

```typescript
it("fills each frame background with BG color before drawing glyphs", () => {
  const ctx = makeMockCtx();
  const frame = { ...makeTestFrame(), z: 0, x: 10, y: 20, w: 100, h: 50 };
  const s = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
  const rs = buildRenderState(s, 0, { w: 800, h: 600 }, 1);
  paintCanvas(ctx as unknown as CanvasRenderingContext2D, rs);
  // Find fillRect calls that match the frame dimensions
  const frameBgCall = ctx.__calls.find(
    c => c.method === "fillRect" &&
    c.args[0] === frame.x && c.args[1] === frame.y
  );
  expect(frameBgCall).toBeDefined();
});
```

**Implementation** (`src/frameRenderer.ts`):

In `renderFrame`, add background fill before content:

```typescript
const BG_COLOR = "#1e1e2e";

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  parentX: number,
  parentY: number,
  charWidth: number,
  charHeight: number,
): void {
  const x = parentX + frame.x;
  const y = parentY + frame.y;

  // Solid background — prevents character soup when frames overlap
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(x, y, frame.w, frame.h);

  if (frame.clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, frame.w, frame.h);
    ctx.clip();
  }

  if (frame.content) {
    renderContent(ctx, frame.content.cells, x, y, charWidth, charHeight);
  }

  for (const child of frame.children) {
    renderFrame(ctx, child, x, y, charWidth, charHeight);
  }

  if (frame.clip) {
    ctx.restore();
  }
}
```

**Verify:** Drag one wireframe on top of another. Top frame's background covers
bottom frame's glyphs in the overlap zone. No character soup.

**Commit:** `feat: solid background fill per frame before glyph render`

---

### Task 6.5 — Hit test in reverse z-order

**Failing test** (`src/frame.test.ts`):

```typescript
it("hitTestFrames picks highest-z frame on overlap", () => {
  const base: Omit<Frame, "id" | "z"> = {
    x: 0, y: 0, w: 100, h: 100,
    children: [], content: null, clip: true,
  };
  const frameA = { ...base, id: "a", z: 0 };   // back
  const frameB = { ...base, id: "b", z: 5 };   // front
  const hit = hitTestFrames([frameA, frameB], 50, 50);
  expect(hit?.id).toBe("b");  // highest z wins
});

it("hitTestFrames returns lower-z frame when higher-z does not overlap click", () => {
  const frameA = { x: 0, y: 0, w: 100, h: 100, z: 0, id: "a", children: [], content: null, clip: true };
  const frameB = { x: 200, y: 200, w: 100, h: 100, z: 5, id: "b", children: [], content: null, clip: true };
  const hit = hitTestFrames([frameA, frameB], 50, 50);
  expect(hit?.id).toBe("a");
});
```

**Implementation** (`src/frame.ts`):

```typescript
export function hitTestFrames(frames: Frame[], px: number, py: number): Frame | null {
  // Descending z-order: highest z tested first (topmost frame wins)
  const sorted = [...frames].sort((a, b) => b.z - a.z);
  for (const frame of sorted) {
    const hit = hitTestOne(frame, px, py);
    if (hit) return hit;
  }
  return null;
}
```

**Commit:** `feat: hitTestFrames iterates in reverse z-order, topmost frame wins`

---

### Task 6.6 — `]` / `[` keyboard shortcuts for z-order

**Failing test** (Playwright `e2e/zorder.spec.ts`):

```typescript
test("] key sends selected frame forward one z-level", async ({ page }) => {
  await page.goto("http://localhost:5173");
  // Draw two overlapping frames, select the back one, press ]
  // ... use page.keyboard / page.mouse
  // Verify via screenshot that the previously-back frame now appears on top
});
```

**Implementation** (`src/DemoV2.tsx` keydown handler):

```typescript
if (e.key === "]" && !mod) {
  const selectedId = getSelectedId(stateRef.current);
  if (selectedId) {
    const frame = getFrames(stateRef.current).find(f => f.id === selectedId);
    if (frame) {
      stateRef.current = stateRef.current.update({
        effects: [setZEffect.of({ id: selectedId, z: frame.z + 1 })],
        annotations: [Transaction.addToHistory.of(true)],
      }).state;
      paint();
    }
  }
  return;
}
if (e.key === "[" && !mod) {
  const selectedId = getSelectedId(stateRef.current);
  if (selectedId) {
    const frame = getFrames(stateRef.current).find(f => f.id === selectedId);
    if (frame) {
      stateRef.current = stateRef.current.update({
        effects: [setZEffect.of({ id: selectedId, z: Math.max(0, frame.z - 1) })],
        annotations: [Transaction.addToHistory.of(true)],
      }).state;
      paint();
    }
  }
  return;
}
```

**Verify:** Select a frame. Press `]` — frame moves to front (covers others).
Press `[` — frame moves to back. Cmd+Z restores previous z value.

**Commit:** `feat: ] and [ keys adjust frame z-order with undo support`

---

### Phase 6 acceptance criteria

- [ ] `npm test` passes.
- [ ] `npx playwright test` passes.
- [ ] `Frame` interface has `z: number`, default `0`.
- [ ] Frames render back-to-front by ascending z.
- [ ] Each frame has a solid background fill before glyphs — no character soup.
- [ ] Hit test returns the highest-z frame at the clicked position.
- [ ] `]` / `[` adjust z with undo support via CM history.

---

## Phase 7: Cleanup

### Task 7.1 — Delete proseCursor.ts + proseCursor.test.ts

**Precondition:** Task 5.2 complete (prose editing fully via CM).

**Steps:**

1. Verify no remaining imports:

   ```bash
   grep -r "proseCursor" src/
   ```

   Expected: zero results (DemoV2 no longer imports `insertChar`, `deleteChar`,
   `CursorPos` from proseCursor).

2. Delete:
   - `src/proseCursor.ts`
   - `src/proseCursor.test.ts`

3. `npm test` — confirm no broken imports.

**Commit:** `chore: delete proseCursor.ts — replaced by CM EditorState cursor`

---

### Task 7.2 — Extract shared canvas mock to test-utils.ts

**Problem:** Multiple test files duplicate a `makeMockCtx()` helper that creates a
fake `CanvasRenderingContext2D` recording draw calls. Duplication causes drift.

**Steps:**

1. Search for existing duplicates:

   ```bash
   grep -rl "makeMockCtx\|__calls" src/
   ```

2. Create `src/test-utils.ts`:

   ```typescript
   // Shared test utilities for canvas-rendering tests.
   // Import from this file — do not define local makeMockCtx copies.

   export interface CanvasCall {
     method: string;
     args: unknown[];
   }

   export interface MockCtx {
     __calls: CanvasCall[];
     fillRect: CanvasRenderingContext2D["fillRect"];
     strokeRect: CanvasRenderingContext2D["strokeRect"];
     fillText: CanvasRenderingContext2D["fillText"];
     beginPath: CanvasRenderingContext2D["beginPath"];
     moveTo: CanvasRenderingContext2D["moveTo"];
     lineTo: CanvasRenderingContext2D["lineTo"];
     stroke: CanvasRenderingContext2D["stroke"];
     save: CanvasRenderingContext2D["save"];
     restore: CanvasRenderingContext2D["restore"];
     clip: CanvasRenderingContext2D["clip"];
     rect: CanvasRenderingContext2D["rect"];
     setTransform: CanvasRenderingContext2D["setTransform"];
     translate: CanvasRenderingContext2D["translate"];
     fillStyle: string | CanvasGradient | CanvasPattern;
     strokeStyle: string | CanvasGradient | CanvasPattern;
     lineWidth: number;
     font: string;
     textBaseline: CanvasTextBaseline;
   }

   export function makeMockCtx(): MockCtx {
     const calls: CanvasCall[] = [];
     const track =
       (method: string) =>
       (...args: unknown[]) => {
         calls.push({ method, args });
       };
     return {
       __calls: calls,
       fillRect: track("fillRect") as MockCtx["fillRect"],
       strokeRect: track("strokeRect") as MockCtx["strokeRect"],
       fillText: track("fillText") as MockCtx["fillText"],
       beginPath: track("beginPath") as MockCtx["beginPath"],
       moveTo: track("moveTo") as MockCtx["moveTo"],
       lineTo: track("lineTo") as MockCtx["lineTo"],
       stroke: track("stroke") as MockCtx["stroke"],
       save: track("save") as MockCtx["save"],
       restore: track("restore") as MockCtx["restore"],
       clip: track("clip") as MockCtx["clip"],
       rect: track("rect") as MockCtx["rect"],
       setTransform: track("setTransform") as MockCtx["setTransform"],
       translate: track("translate") as MockCtx["translate"],
       fillStyle: "",
       strokeStyle: "",
       lineWidth: 1,
       font: "",
       textBaseline: "top",
     };
   }
   ```

3. Update all test files that define local mock ctx to import from `test-utils.ts`.
   Delete the local definitions.

4. `npm test` — all pass.

**Commit:** `refactor: extract shared MockCtx to src/test-utils.ts`

---

### Task 7.3 — Delete _crash.test.ts if it exists

**Steps:**

1. Check: `ls src/_crash.test.ts 2>/dev/null`

2. If it exists: read it. If it contains only crash-to-verify-error-boundary tests
   with no real business logic coverage, delete it.

3. `npm test`.

**Commit:** `chore: delete _crash.test.ts` (only if file exists)

---

### Task 7.4 — Fix serialize.ts: detect horizontal-only frame moves

**Problem (R5 from master plan):** `childrenHaveMoved` only checks `minRow > 0`.
A horizontal-only drag (dx > 0, dy = 0) sets `minRow = 0` → returns `false` →
frame serialized at original position → drag silently reverts on save.

**Failing test** (`src/serialize.test.ts`):

```typescript
it("detects horizontal-only frame move as a mutation", () => {
  // Build a frame from a region starting at col 0.
  // Move it right by 3 cols (dx = 3*charWidth, dy = 0).
  // Expect framesToMarkdown to write the new position.
  const cw = 9, ch = 18;
  // ... (construct frame and region, call framesToMarkdown, assert output
  //      contains the frame content at new column position)
});
```

**Implementation:** Add `originalX` and `originalY` to `Frame`:

```typescript
// src/frame.ts
export interface Frame {
  id: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  originalX?: number;  // set by framesFromRegions; undefined for user-drawn frames
  originalY?: number;
  children: Frame[];
  content: FrameContent | null;
  clip: boolean;
}
```

In `framesFromRegions`, set `originalX: containerX, originalY: containerY` on the
container frame. Children do not need `originalX/Y` — only top-level containers
are compared against region positions.

Update `childrenHaveMoved` in `serialize.ts`:

```typescript
function childrenHaveMoved(container: Frame): boolean {
  // Explicit stored original position — covers horizontal-only moves
  if (container.originalX !== undefined && container.x !== container.originalX) return true;
  if (container.originalY !== undefined && container.y !== container.originalY) return true;

  // Fallback heuristic for user-drawn frames (no originalX/Y)
  // ... existing minRow check ...
}
```

`moveFrame` and `resizeFrame` must preserve `originalX`/`originalY` in their
spreads — `{ ...frame, x: ..., y: ... }` preserves `originalX`/`originalY`
automatically since they are separate fields.

**Verify:** Move a wireframe left/right only. Save. Reopen. Frame at new column.

**Commit:** `fix: serialize detects horizontal-only frame moves via originalX/Y`

---

### Task 7.5 — Final line count audit

```bash
wc -l src/*.ts src/*.tsx | sort -rn | head -20
```

Targets (project rules):
- `DemoV2.tsx` < 150 lines
- Every other file ≤ 300 lines
- Total source < 2,000 lines

If any file exceeds its target, split it before closing Phase 7. Common splits:
- `editorState.ts` may grow large — split into `editorState.ts` (API) +
  `editorEffects.ts` (effect/field definitions).
- `frameRenderer.ts` is currently 107 lines — should stay under 300.
- `canvasRenderer.ts` (new) — watch its size.

**Commit:** `chore: final line-count audit — all files within limits`

---

### Task 7.6 — Full suite + Playwright green

```bash
npm test
npx playwright test
npm run build
```

All must pass. TypeScript build must be clean (no `@ts-expect-error` without
justification comment, no `any` in new code).

**Commit:** `chore: Phase 7 complete — all tests green, build clean`

---

### Phase 7 acceptance criteria

- [ ] `src/proseCursor.ts` and `src/proseCursor.test.ts` deleted.
- [ ] `src/test-utils.ts` exists and is imported by canvas test files.
- [ ] `_crash.test.ts` deleted or confirmed absent.
- [ ] Horizontal-only frame moves serialize correctly (R5 fix verified).
- [ ] All source files ≤ 300 lines. `DemoV2.tsx` ≤ 150 lines.
- [ ] `npm test` — 400+ tests, all green.
- [ ] `npx playwright test` — all green.
- [ ] `npm run build` — clean, no errors.

---

## Summary: files changed across Phase 5–7

### Modified
- `src/DemoV2.tsx` — rewritten to ~150 lines, 3 state-bearing refs
- `src/frame.ts` — add `z: number`, `originalX?`, `originalY?` fields
- `src/frameRenderer.ts` — solid background `fillRect` before glyph render
- `src/editorState.ts` — add `setZEffect`, `addFrameEffect`, `deleteFrameEffect`,
  `editTextFrameEffect`, `setTextEditEffect`, `setToolEffect`, `selectFrameEffect`,
  `selectedIdField`, `textEditField`, `toolField`, `rebuildProseParts`,
  `getSelectedId`, `getTextEdit`, `getTool`
- `src/canvasRenderer.ts` — sort by z in `buildRenderState`
- `src/serialize.ts` — fix `childrenHaveMoved` with `originalX/Y` comparison

### Created
- `src/test-utils.ts` — shared `makeMockCtx()`
- `e2e/zorder.spec.ts` — Playwright z-order test

### Deleted
- `src/proseCursor.ts`
- `src/proseCursor.test.ts`
- `src/_crash.test.ts` (if it exists)

---

## Risks and mitigations specific to Phase 5–7

### R1: Live-drag history pollution

Dispatching `moveFrameEffect` on every `mousemove` (60 fps) creates one CM
transaction per pixel. Without annotation, Cmd+Z steps through every pixel.

**Mitigation (required):** Annotate all intermediate drag transactions:
```typescript
annotations: [Transaction.addToHistory.of(false)]
```
On `mouseUp`, dispatch the final position without this annotation
(`addToHistory` defaults to `true`). The completed drag is one undo step.

### R2: Ephemeral refs vs CM state boundary

The dividing line: **if Cmd+Z should NOT affect it, keep it as a React ref.**

Stays as refs: `dragRef` (in-flight drag delta), `blinkRef` (cursor blink phase),
`lastClickRef` (double-click detection), `drawPreviewRef` (dashed preview box),
`textPlacementRef` (T-tool character accumulator).

Goes into CM: frame positions, frame selection, active tool, prose cursor, text
edit cursor col — all of these are undoable state.

### R3: React re-renders from CM mutations

`stateRef.current = state.update(...).state` does NOT trigger React re-renders.
The toolbar needs to re-render when tool changes.

**Mitigation:** One `useState<number>` tick counter in DemoV2:
```typescript
const [, forceUpdate] = useState(0);
```

Call `forceUpdate(n => n + 1)` only when React-visible state changes (active tool,
selection for toolbar state). Do NOT call it on every mousemove or keydown — that
causes 60fps React renders. The canvas is imperative via `paint()` and does not
need React to re-render.

### R4: `getDoc(state)` returns CM Text, not string

`getDoc(state)` from `@codemirror/state` returns a `Text` object.
Use `.toString()` to get a plain string:
```typescript
const text = getDoc(state).toString();
```
Do not compare a CM `Text` with `===` to a string literal.

### R5: Frame model may be hierarchical (container + children)

Current `framesFromRegions` produces container frames with `children: Frame[]`.
The CM `framesField` stores this tree. `getFrames(state)` returns top-level
containers. Some operations (e.g., finding a frame by id, hit-testing deep inside
a container) need to recurse into children.

Before removing `findFrameById` from DemoV2 in Task 5.3, verify whether the new
Phase 2/3 frame model is flat or hierarchical. If hierarchical, add a
`findFrameById(frames: Frame[], id: string)` helper in `editorState.ts` and export
it. Do not inline the recursion in DemoV2.

### R6: `rebuildProseParts` line offset counting

`rebuildProseParts` slices the CM doc using `region.text.split("\n").length` to
advance `lineOffset` for prose regions only. Wireframe regions are skipped
entirely — the CM doc contains only prose text, not wireframe lines.

This assumes prose edits only change content within existing prose regions, not
region count or order. If a prose edit adds a newline that crosses a region
boundary (e.g., the user types Enter at the very end of a prose region),
`lineOffset` will be wrong.

**Mitigation for Phase 5:** Accept this edge case for the initial rewrite. Track
it as a known limitation. A proper fix (Phase 8+) would store region boundaries
as CM decorations that update as the doc grows, not as static line counts.
