# Phase 3: EditorState Module

**Goal:** Create `src/editorState.ts` — a single headlessly-testable module that
wraps CodeMirror 6's `EditorState`. Prose text lives in the CM doc. Frames, tool,
regions, and proseParts live as `StateField`s inside the same `EditorState`. All
operations are CM transactions so a single `history()` extension gives one undo
stack for everything: prose edits and frame mutations.

**Architecture:**

```
EditorState
├── doc: Text                               ← prose text (CM built-in)
├── selection: EditorSelection              ← cursor + selection (CM built-in)
├── history (extension)                    ← undo/redo (CM built-in via @codemirror/commands)
├── framesField: StateField<Frame[]>        ← wireframe positions (custom)
├── toolField: StateField<ToolName>         ← active tool (custom)
├── regionsField: StateField<Region[]>      ← scan regions for save (custom)
└── prosePartsField: StateField<ProsePart[]> ← prose parts for save (custom)
```

Frame operations are dispatched as CM `StateEffect`s inside a transaction.
`history()` treats effects as part of the transaction, so Cmd+Z undoes frame
moves alongside text deletions — one stack, no coordination needed.

**Tech Stack:**
- `@codemirror/state` 6.6.x — `EditorState`, `StateField`, `StateEffect`, `Text`, `Transaction`
- `@codemirror/commands` 6.8.x — `history`, `undo`, `redo`
- Vitest (already installed) — all tests run headlessly, no DOM required

**Branch:** `feature/editor-state`
**Prerequisite:** Phases 1–2 complete (dead code deleted, `scanToFrames` merged)

> **Phase 2 ordering note:** `framesFromRegions` must be rewritten in Phase 2
> BEFORE `scanToFrames` is created. `scanToFrames` (used by
> `createEditorStateFromText` in Phase 3) depends on the rewritten
> `framesFromRegions` being in place. Do not start Phase 3 Task 1 until
> Phase 2 is fully complete.

---

## Task 1: Install CM dependencies and scaffold `editorState.ts`

### 1.1 Install

```bash
npm install @codemirror/state@6.6.0 @codemirror/commands@6.8.0
```

Verify both appear in `package.json` under `dependencies` (not `devDependencies`
— they are needed at runtime, not just in tests).

### 1.2 Create `src/editorState.ts`

This module exports:
- All `StateEffect` definitions (one per mutation type)
- All `StateField` definitions
- `createEditorState` — factory function (takes `{ prose, frames, regions, proseParts }`)
- `createEditorStateFromText` — convenience factory (takes `text, charWidth, charHeight`; runs `scanToFrames` internally)
- Prose operations: `proseInsert`, `proseDeleteBefore`, `moveCursorTo`
- Frame operations: `applyMoveFrame`, `applyResizeFrame`, `applyAddFrame`, `applyDeleteFrame`
- Tool setter: `setTool`
- Undo/redo: `editorUndo`, `editorRedo`
- Accessors: `getDoc`, `getCursor`, `getFrames`, `getTool`, `getRegions`, `getProseParts`
- Position converters: `rowColToPos`, `posToRowCol`

**Complete implementation (`src/editorState.ts`):**

```typescript
// src/editorState.ts
// Single CM EditorState backing all of Gridpad's state.
// Prose in doc, frames/tool/regions/proseParts as StateFields.
// One history stack for everything — no zustand, no zundo.

import {
  EditorState,
  StateField,
  StateEffect,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { history, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import type { Frame } from "./frame";
import { moveFrame, resizeFrame } from "./frame";
import type { Region } from "./regions";
import { scanToFrames } from "./scanner";

export { undoDepth, redoDepth };

// ── Types ──────────────────────────────────────────────────────────────────

export type ToolName = "select" | "rect" | "line" | "text";

export interface ProsePart {
  startRow: number;
  text: string;
}

export interface CursorPos {
  row: number;  // 0-indexed line number
  col: number;  // 0-indexed grapheme cluster offset within that line
}

// ── StateEffects ───────────────────────────────────────────────────────────

export const moveFrameEffect = StateEffect.define<{
  id: string;
  dx: number;
  dy: number;
}>();

export const resizeFrameEffect = StateEffect.define<{
  id: string;
  w: number;
  h: number;
  charWidth: number;
  charHeight: number;
}>();

export const addFrameEffect = StateEffect.define<Frame>();

export const deleteFrameEffect = StateEffect.define<{ id: string }>();

export const setToolEffect = StateEffect.define<ToolName>();

export const setRegionsEffect = StateEffect.define<Region[]>();

export const setProsePartsEffect = StateEffect.define<ProsePart[]>();

// ── StateFields ────────────────────────────────────────────────────────────

export const framesField = StateField.define<Frame[]>({
  create: () => [],
  update(frames, tr: Transaction) {
    let result = frames;
    for (const e of tr.effects) {
      if (e.is(moveFrameEffect)) {
        result = result.map((f) =>
          f.id === e.value.id
            ? moveFrame(f, { dx: e.value.dx, dy: e.value.dy })
            : f,
        );
      } else if (e.is(resizeFrameEffect)) {
        result = result.map((f) =>
          f.id === e.value.id
            ? resizeFrame(
                f,
                { w: e.value.w, h: e.value.h },
                e.value.charWidth,
                e.value.charHeight,
              )
            : f,
        );
      } else if (e.is(addFrameEffect)) {
        result = [...result, e.value];
      } else if (e.is(deleteFrameEffect)) {
        result = result.filter((f) => f.id !== e.value.id);
      }
    }
    return result;
  },
});

export const toolField = StateField.define<ToolName>({
  create: () => "select",
  update(tool, tr: Transaction) {
    for (const e of tr.effects) {
      if (e.is(setToolEffect)) return e.value;
    }
    return tool;
  },
});

export const regionsField = StateField.define<Region[]>({
  create: () => [],
  update(regions, tr: Transaction) {
    for (const e of tr.effects) {
      if (e.is(setRegionsEffect)) return e.value;
    }
    return regions;
  },
});

export const prosePartsField = StateField.define<ProsePart[]>({
  create: () => [],
  update(parts, tr: Transaction) {
    for (const e of tr.effects) {
      if (e.is(setProsePartsEffect)) return e.value;
    }
    return parts;
  },
});

// ── Factory ────────────────────────────────────────────────────────────────

export interface EditorStateInit {
  prose: string;
  frames: Frame[];
  regions: Region[];
  proseParts: ProsePart[];
}

export function createEditorState(init: EditorStateInit): EditorState {
  const { prose, frames, regions, proseParts } = init;
  const extensions: Extension[] = [
    history(),
    framesField.init(() => frames),    toolField,
    regionsField.init(() => regions),
    prosePartsField.init(() => proseParts),
  ];
  return EditorState.create({ doc: prose, extensions });
}

// Convenience factory — runs scanToFrames internally.
// Used by Phase 5/6 callers that have raw text + cell dimensions.
export function createEditorStateFromText(
  text: string,
  charWidth: number,
  charHeight: number,
): EditorState {
  const { frames, prose, regions } = scanToFrames(text, charWidth, charHeight);
  const proseText = prose.map((p) => p.text).join("\n\n");
  return createEditorState({ prose: proseText, frames, regions, proseParts: prose });
}

// ── Accessors ──────────────────────────────────────────────────────────────

export function getDoc(state: EditorState): string {
  return state.doc.toString();
}

export function getFrames(state: EditorState): Frame[] {
  return state.field(framesField);
}

export function getTool(state: EditorState): ToolName {
  return state.field(toolField);
}

export function getRegions(state: EditorState): Region[] {
  return state.field(regionsField);
}

export function getProseParts(state: EditorState): ProsePart[] {
  return state.field(prosePartsField);
}

// getCursor returns the cursor as grapheme {row, col}.
// Returns null if the selection is a range (not a collapsed cursor).
export function getCursor(state: EditorState): CursorPos | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  return posToRowCol(state, sel.from);
}

// ── Position converters ────────────────────────────────────────────────────
//
// CRITICAL: CM doc uses UTF-16 code unit offsets. Gridpad canvas uses
// grapheme cluster columns (what the user sees). These differ for:
//   - Emoji: 🎉 is U+1F389, 2 UTF-16 code units, 1 grapheme
//   - ZWJ sequences: 👨‍👩‍👧‍👦 = many code units, 1 grapheme
//   - Combining marks: n + U+0303 (combining tilde) = 2 code units, 1 grapheme
//
// rowColToPos: grapheme (row, col) → CM code unit offset
// posToRowCol: CM code unit offset → grapheme (row, col)
//
// Implementation uses Intl.Segmenter (available in Node 16+, all modern browsers).

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Sum UTF-16 code unit lengths of the first `col` grapheme clusters in `lineText`.
function graphemeColToCodeUnits(lineText: string, col: number): number {
  let codeUnits = 0;
  let count = 0;
  for (const seg of segmenter.segment(lineText)) {
    if (count >= col) break;
    codeUnits += seg.segment.length;
    count++;
  }
  return codeUnits;
}

// Convert grapheme-column position to CM code unit offset.
// row: 0-indexed line number. col: 0-indexed grapheme cluster offset within that line.
export function rowColToPos(state: EditorState, row: number, col: number): number {
  if (row < 0) return 0;
  if (row >= state.doc.lines) return state.doc.length;

  const line = state.doc.line(row + 1); // CM lines are 1-indexed
  const codeUnits = graphemeColToCodeUnits(line.text, col);
  return line.from + codeUnits;
}

// Convert CM code unit offset to grapheme (row, col).
export function posToRowCol(state: EditorState, pos: number): CursorPos {
  const clampedPos = Math.max(0, Math.min(pos, state.doc.length));
  const lineInfo = state.doc.lineAt(clampedPos);
  const row = lineInfo.number - 1; // convert to 0-indexed
  const offsetInLine = clampedPos - lineInfo.from;

  // Count grapheme clusters up to offsetInLine code units
  let col = 0;
  let codeUnits = 0;
  for (const seg of segmenter.segment(lineInfo.text)) {
    if (codeUnits >= offsetInLine) break;
    codeUnits += seg.segment.length;
    col++;
  }
  return { row, col };
}

// ── Prose operations ───────────────────────────────────────────────────────

// Insert `text` at the grapheme cursor position. Returns new EditorState.
export function proseInsert(
  state: EditorState,
  cursor: CursorPos,
  text: string,
): EditorState {
  const pos = rowColToPos(state, cursor.row, cursor.col);
  return state.update({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input",
  }).state;
}

// Delete one grapheme cluster before the cursor (Backspace). Returns new EditorState.
export function proseDeleteBefore(
  state: EditorState,
  cursor: CursorPos,
): EditorState {
  if (cursor.row === 0 && cursor.col === 0) return state;

  const pos = rowColToPos(state, cursor.row, cursor.col);
  const lineInfo = state.doc.lineAt(pos);
  let prevClusterStart: number;

  if (pos === lineInfo.from) {
    // At line start: delete the preceding newline (merge with previous line)
    prevClusterStart = pos - 1;
  } else {
    // Find start of the grapheme cluster immediately before pos
    const textBefore = lineInfo.text.slice(0, pos - lineInfo.from);
    const clusters = [...segmenter.segment(textBefore)];
    const lastCluster = clusters[clusters.length - 1];
    prevClusterStart = pos - lastCluster.segment.length;
  }

  return state.update({
    changes: { from: prevClusterStart, to: pos },
    selection: { anchor: prevClusterStart },
    userEvent: "delete.backward",
  }).state;
}

// Move cursor to the given grapheme position without modifying the doc.
export function moveCursorTo(
  state: EditorState,
  cursor: CursorPos,
): EditorState {
  const pos = rowColToPos(state, cursor.row, cursor.col);
  return state.update({ selection: { anchor: pos } }).state;
}

// ── Frame operations ───────────────────────────────────────────────────────

export function applyMoveFrame(
  state: EditorState,
  id: string,
  dx: number,
  dy: number,
): EditorState {
  return state.update({
    effects: moveFrameEffect.of({ id, dx, dy }),
    annotations: Transaction.addToHistory.of(true),
  }).state;
}

export function applyResizeFrame(
  state: EditorState,
  id: string,
  w: number,
  h: number,
  charWidth: number,
  charHeight: number,
): EditorState {
  return state.update({
    effects: resizeFrameEffect.of({ id, w, h, charWidth, charHeight }),
    annotations: Transaction.addToHistory.of(true),
  }).state;
}

export function applyAddFrame(state: EditorState, frame: Frame): EditorState {
  return state.update({
    effects: addFrameEffect.of(frame),
    annotations: Transaction.addToHistory.of(true),
  }).state;
}

export function applyDeleteFrame(state: EditorState, id: string): EditorState {
  return state.update({
    effects: deleteFrameEffect.of({ id }),
    annotations: Transaction.addToHistory.of(true),
  }).state;
}

export function setTool(state: EditorState, tool: ToolName): EditorState {
  // No addToHistory — tool changes are transient UI state, not undoable.
  return state.update({
    effects: setToolEffect.of(tool),
  }).state;
}

// ── Undo / Redo ────────────────────────────────────────────────────────────
//
// CM's `undo`/`redo` from @codemirror/commands are designed to take an
// EditorView (which has `.state` and `.dispatch`). We have no view in headless
// tests. The fake view approach satisfies the `CommandTarget` interface
// (which requires only `{ state, dispatch }`), and is the standard pattern
// used in CM's own headless test suite.
//
// If undo/redo finds nothing to apply, dispatch is never called and `next`
// returns unchanged — correctly a no-op.

export function editorUndo(state: EditorState): EditorState {
  let next = state;
  const fakeView = {
    state,
    dispatch(tr: Transaction) {
      next = tr.state;
    },
  };
  undo(fakeView as Parameters<typeof undo>[0]);
  return next;
}

export function editorRedo(state: EditorState): EditorState {
  let next = state;
  const fakeView = {
    state,
    dispatch(tr: Transaction) {
      next = tr.state;
    },
  };
  redo(fakeView as Parameters<typeof redo>[0]);
  return next;
}
```

### 1.3 Write failing tests first — scaffold

**File:** `src/editorState.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  createEditorState,
  getDoc,
  getFrames,
  getTool,
  getCursor,
  getRegions,
  getProseParts,
  proseInsert,
  proseDeleteBefore,
  moveCursorTo,
  rowColToPos,
  posToRowCol,
  applyMoveFrame,
  applyResizeFrame,
  applyAddFrame,
  applyDeleteFrame,
  setTool,
  editorUndo,
  editorRedo,
  undoDepth,
  redoDepth,
  setRegionsEffect,
  setProsePartsEffect,
  type ProsePart,
} from "./editorState";
import { createFrame } from "./frame";
import type { Region } from "./regions";
```

Run: `npm test -- src/editorState.test.ts`
Expected: compiles and imports succeed. (No test bodies yet — just ensure
no TypeScript errors and the module resolves.)

### 1.4 Add Task 1 tests to the file

```typescript
describe("Task 1: createEditorState", () => {
  it("creates state with prose doc", () => {
    const state = createEditorState({
      prose: "hello world",
      frames: [],
      regions: [],
      proseParts: [],
    });
    expect(getDoc(state)).toBe("hello world");
  });

  it("stores initial frames", () => {
    const f = createFrame({ x: 10, y: 20, w: 100, h: 50 });
    const state = createEditorState({
      prose: "",
      frames: [f],
      regions: [],
      proseParts: [],
    });
    expect(getFrames(state)).toHaveLength(1);
    expect(getFrames(state)[0].id).toBe(f.id);
  });

  it("default tool is select", () => {
    const state = createEditorState({
      prose: "",
      frames: [],
      regions: [],
      proseParts: [],
    });
    expect(getTool(state)).toBe("select");
  });

  it("fresh state cursor is at (0,0)", () => {
    const state = createEditorState({
      prose: "abc",
      frames: [],
      regions: [],
      proseParts: [],
    });
    expect(getCursor(state)).toEqual({ row: 0, col: 0 });
  });
});
```

Run: `npm test -- src/editorState.test.ts` — all 4 pass.

### 1.5 Commit

```bash
npm test -- src/editorState.test.ts
git add src/editorState.ts src/editorState.test.ts package.json package-lock.json
git commit -m "feat: install @codemirror/state + commands, scaffold editorState.ts with StateField/StateEffect"
```

---

## Task 2: Prose operations (insert, delete, cursor movement)

### 2.1 Add failing tests

Append to the `describe` blocks in `src/editorState.test.ts`:

```typescript
describe("Task 2: Prose operations", () => {
  describe("proseInsert", () => {
    it("inserts characters at cursor position", () => {
      let state = createEditorState({ prose: "hello", frames: [], regions: [], proseParts: [] });
      state = proseInsert(state, { row: 0, col: 5 }, " world");
      expect(getDoc(state)).toBe("hello world");
    });

    it("inserts at middle of line", () => {
      let state = createEditorState({ prose: "hllo", frames: [], regions: [], proseParts: [] });
      state = proseInsert(state, { row: 0, col: 1 }, "e");
      expect(getDoc(state)).toBe("hello");
    });

    it("inserts a newline splitting the line", () => {
      let state = createEditorState({ prose: "ab", frames: [], regions: [], proseParts: [] });
      state = proseInsert(state, { row: 0, col: 1 }, "\n");
      expect(getDoc(state)).toBe("a\nb");
    });

    it("advances cursor to end of inserted text", () => {
      let state = createEditorState({ prose: "hello", frames: [], regions: [], proseParts: [] });
      state = proseInsert(state, { row: 0, col: 5 }, "!");
      expect(getCursor(state)).toEqual({ row: 0, col: 6 });
    });

    it("cursor after newline insert lands on new line col 0", () => {
      let state = createEditorState({ prose: "ab", frames: [], regions: [], proseParts: [] });
      state = proseInsert(state, { row: 0, col: 1 }, "\n");
      expect(getCursor(state)).toEqual({ row: 1, col: 0 });
    });
  });

  describe("proseDeleteBefore", () => {
    it("deletes char before cursor", () => {
      let state = createEditorState({ prose: "hello", frames: [], regions: [], proseParts: [] });
      state = proseDeleteBefore(state, { row: 0, col: 5 });
      expect(getDoc(state)).toBe("hell");
    });

    it("merges lines when cursor is at start of line", () => {
      let state = createEditorState({ prose: "a\nb", frames: [], regions: [], proseParts: [] });
      state = proseDeleteBefore(state, { row: 1, col: 0 });
      expect(getDoc(state)).toBe("ab");
      expect(getCursor(state)).toEqual({ row: 0, col: 1 });
    });

    it("does nothing at (0,0) — beginning of doc", () => {
      let state = createEditorState({ prose: "hello", frames: [], regions: [], proseParts: [] });
      const before = getDoc(state);
      state = proseDeleteBefore(state, { row: 0, col: 0 });
      expect(getDoc(state)).toBe(before);
    });

    it("moves cursor back one grapheme after delete", () => {
      let state = createEditorState({ prose: "abc", frames: [], regions: [], proseParts: [] });
      state = proseDeleteBefore(state, { row: 0, col: 3 });
      expect(getCursor(state)).toEqual({ row: 0, col: 2 });
    });
  });

  describe("moveCursorTo", () => {
    it("sets cursor without changing doc", () => {
      let state = createEditorState({ prose: "hello\nworld", frames: [], regions: [], proseParts: [] });
      state = moveCursorTo(state, { row: 1, col: 3 });
      expect(getDoc(state)).toBe("hello\nworld");
      expect(getCursor(state)).toEqual({ row: 1, col: 3 });
    });
  });

  // NOTE: These equivalence tests are deleted in Phase 7 when proseCursor.ts is removed.
  describe("equivalence with proseCursor.ts behavior", () => {
    it("proseInsert matches insertChar result on ASCII text", async () => {
      const { insertChar } = await import("./proseCursor");
      const text = "hello world";
      const cursor = { row: 0, col: 5 };

      const old = insertChar(text, cursor, "!");
      let state = createEditorState({ prose: text, frames: [], regions: [], proseParts: [] });
      state = proseInsert(state, cursor, "!");
      const newCursor = getCursor(state);

      expect(getDoc(state)).toBe(old.text);
      expect(newCursor).toEqual(old.cursor);
    });

    it("proseDeleteBefore matches deleteChar result on ASCII text", async () => {
      const { deleteChar } = await import("./proseCursor");
      const text = "hello world";
      const cursor = { row: 0, col: 5 };

      const old = deleteChar(text, cursor);
      let state = createEditorState({ prose: text, frames: [], regions: [], proseParts: [] });
      state = proseDeleteBefore(state, cursor);
      const newCursor = getCursor(state);

      expect(getDoc(state)).toBe(old.text);
      expect(newCursor).toEqual(old.cursor);
    });

    it("proseDeleteBefore at line start matches deleteChar line-merge", async () => {
      const { deleteChar } = await import("./proseCursor");
      const text = "foo\nbar";
      const cursor = { row: 1, col: 0 };

      const old = deleteChar(text, cursor);
      let state = createEditorState({ prose: text, frames: [], regions: [], proseParts: [] });
      state = proseDeleteBefore(state, cursor);

      expect(getDoc(state)).toBe(old.text);
      expect(getCursor(state)).toEqual(old.cursor);
    });
  });
});
```

Run: `npm test -- src/editorState.test.ts` — all pass.

### 2.2 Commit

```bash
npm test -- src/editorState.test.ts
git add src/editorState.test.ts
git commit -m "test: prose insert/delete/cursor with equivalence checks against proseCursor.ts"
```

---

## Task 3: Frame operations via StateEffect

### 3.1 Add failing tests

Append to `src/editorState.test.ts`:

```typescript
describe("Task 3: Frame operations", () => {
  const CHAR_W = 10;
  const CHAR_H = 20;

  function stateWithFrame() {
    const f = createFrame({ x: 100, y: 200, w: 80, h: 40 });
    const state = createEditorState({
      prose: "some prose",
      frames: [f],
      regions: [],
      proseParts: [],
    });
    return { state, frame: f };
  }

  describe("applyMoveFrame", () => {
    it("moves a frame by delta", () => {
      const { state, frame } = stateWithFrame();
      const next = applyMoveFrame(state, frame.id, 10, -20);
      expect(getFrames(next)[0].x).toBe(110);
      expect(getFrames(next)[0].y).toBe(180);
    });

    it("leaves other frames unchanged", () => {
      const f1 = createFrame({ x: 0, y: 0, w: 50, h: 50 });
      const f2 = createFrame({ x: 100, y: 100, w: 50, h: 50 });
      const state = createEditorState({ prose: "", frames: [f1, f2], regions: [], proseParts: [] });
      const next = applyMoveFrame(state, f1.id, 5, 5);
      expect(getFrames(next)[1].x).toBe(100);
      expect(getFrames(next)[1].y).toBe(100);
    });

    it("does nothing for an unknown frame id", () => {
      const { state } = stateWithFrame();
      const next = applyMoveFrame(state, "nonexistent", 10, 10);
      expect(getFrames(next)).toEqual(getFrames(state));
    });
  });

  describe("applyResizeFrame", () => {
    it("resizes a frame to new dimensions", () => {
      const { state, frame } = stateWithFrame();
      const next = applyResizeFrame(state, frame.id, 200, 100, CHAR_W, CHAR_H);
      expect(getFrames(next)[0].w).toBe(200);
      expect(getFrames(next)[0].h).toBe(100);
    });

    it("enforces minimum size (2 chars × 2 chars)", () => {
      const { state, frame } = stateWithFrame();
      // minW = 2 * CHAR_W = 20, minH = 2 * CHAR_H = 40
      const next = applyResizeFrame(state, frame.id, 5, 5, CHAR_W, CHAR_H);
      expect(getFrames(next)[0].w).toBe(20);
      expect(getFrames(next)[0].h).toBe(40);
    });

    it("does not change position, only size", () => {
      const { state, frame } = stateWithFrame();
      const next = applyResizeFrame(state, frame.id, 200, 100, CHAR_W, CHAR_H);
      expect(getFrames(next)[0].x).toBe(frame.x);
      expect(getFrames(next)[0].y).toBe(frame.y);
    });
  });

  describe("applyAddFrame", () => {
    it("appends a frame to an empty list", () => {
      const state = createEditorState({ prose: "", frames: [], regions: [], proseParts: [] });
      const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
      const next = applyAddFrame(state, f);
      expect(getFrames(next)).toHaveLength(1);
      expect(getFrames(next)[0].id).toBe(f.id);
    });

    it("appends to existing frames without replacing them", () => {
      const f1 = createFrame({ x: 0, y: 0, w: 50, h: 50 });
      const state = createEditorState({ prose: "", frames: [f1], regions: [], proseParts: [] });
      const f2 = createFrame({ x: 100, y: 100, w: 50, h: 50 });
      const next = applyAddFrame(state, f2);
      expect(getFrames(next)).toHaveLength(2);
      expect(getFrames(next)[0].id).toBe(f1.id);
      expect(getFrames(next)[1].id).toBe(f2.id);
    });
  });

  describe("applyDeleteFrame", () => {
    it("removes a frame by id", () => {
      const { state, frame } = stateWithFrame();
      const next = applyDeleteFrame(state, frame.id);
      expect(getFrames(next)).toHaveLength(0);
    });

    it("does nothing for an unknown id", () => {
      const { state } = stateWithFrame();
      const next = applyDeleteFrame(state, "unknown-id");
      expect(getFrames(next)).toHaveLength(1);
    });
  });

  describe("setTool", () => {
    it("changes the active tool", () => {
      const state = createEditorState({ prose: "", frames: [], regions: [], proseParts: [] });
      const next = setTool(state, "rect");
      expect(getTool(next)).toBe("rect");
    });

    it("changing tool does not affect frames", () => {
      const { state, frame } = stateWithFrame();
      const next = setTool(state, "line");
      expect(getFrames(next)[0].id).toBe(frame.id);
    });
  });
});
```

Run: `npm test -- src/editorState.test.ts` — all pass.

### 3.2 Commit

```bash
git add src/editorState.test.ts
git commit -m "test: frame move/resize/add/delete/setTool tests against editorState.ts"
```

---

## Task 4: Unified undo/redo — single stack for prose AND frames

This is the architectural proof test. It verifies the core promise: one CM
`history()` extension undoes both text edits and frame mutations in the order
they were applied, with no coordination layer needed.

### 4.1 Add failing tests

Append to `src/editorState.test.ts`:

```typescript
describe("Task 4: Unified undo/redo", () => {
  it("undoes a prose insert", () => {
    let state = createEditorState({ prose: "hello", frames: [], regions: [], proseParts: [] });
    state = proseInsert(state, { row: 0, col: 5 }, " world");
    expect(getDoc(state)).toBe("hello world");
    state = editorUndo(state);
    expect(getDoc(state)).toBe("hello");
  });

  it("redoes a prose insert after undo", () => {
    let state = createEditorState({ prose: "hello", frames: [], regions: [], proseParts: [] });
    state = proseInsert(state, { row: 0, col: 5 }, " world");
    state = editorUndo(state);
    state = editorRedo(state);
    expect(getDoc(state)).toBe("hello world");
  });

  it("undoes a frame move, restoring original position", () => {
    const f = createFrame({ x: 100, y: 200, w: 80, h: 40 });
    let state = createEditorState({ prose: "", frames: [f], regions: [], proseParts: [] });
    state = applyMoveFrame(state, f.id, 50, 50);
    expect(getFrames(state)[0].x).toBe(150);
    state = editorUndo(state);
    expect(getFrames(state)[0].x).toBe(100);
    expect(getFrames(state)[0].y).toBe(200);
  });

  it("undo chain: add frame → move frame → undo move → undo add", () => {
    const f = createFrame({ x: 0, y: 0, w: 80, h: 40 });
    let state = createEditorState({ prose: "", frames: [], regions: [], proseParts: [] });
    state = applyAddFrame(state, f);          // history item 1: add
    state = applyMoveFrame(state, f.id, 50, 50); // history item 2: move
    expect(getFrames(state)[0].x).toBe(50);

    state = editorUndo(state); // undo move
    expect(getFrames(state)[0].x).toBe(0);
    expect(getFrames(state)).toHaveLength(1); // still exists

    state = editorUndo(state); // undo add
    expect(getFrames(state)).toHaveLength(0);
  });

  // THE KEY TEST — this is the core architectural promise:
  // type text → move frame → Cmd+Z undoes frame → Cmd+Z undoes text
  it("interleaved: type text → move frame → undo frame → undo text → redo both", () => {
    const f = createFrame({ x: 100, y: 200, w: 80, h: 40 });
    let state = createEditorState({
      prose: "initial",
      frames: [f],
      regions: [],
      proseParts: [],
    });

    // Step 1: type " text" appended to prose
    state = proseInsert(state, { row: 0, col: 7 }, " text");
    expect(getDoc(state)).toBe("initial text");

    // Step 2: move the frame
    state = applyMoveFrame(state, f.id, 40, 0);
    expect(getFrames(state)[0].x).toBe(140);
    expect(getDoc(state)).toBe("initial text"); // prose unchanged

    // Step 3: Cmd+Z — most recent operation was frame move → frame reverts
    state = editorUndo(state);
    expect(getFrames(state)[0].x).toBe(100); // frame reverted to x=100
    expect(getDoc(state)).toBe("initial text"); // prose still has the typed text

    // Step 4: Cmd+Z again — next most recent was prose insert → text reverts
    state = editorUndo(state);
    expect(getDoc(state)).toBe("initial");
    expect(getFrames(state)[0].x).toBe(100); // frame still at original

    // Step 5: Cmd+Shift+Z — redo prose insert
    state = editorRedo(state);
    expect(getDoc(state)).toBe("initial text");
    expect(getFrames(state)[0].x).toBe(100); // frame at original (only redid text)

    // Step 6: Cmd+Shift+Z — redo frame move
    state = editorRedo(state);
    expect(getFrames(state)[0].x).toBe(140);
    expect(getDoc(state)).toBe("initial text");
  });

  it("undoDepth is 0 on fresh state, >0 after an edit", () => {
    let state = createEditorState({ prose: "a", frames: [], regions: [], proseParts: [] });
    expect(undoDepth(state)).toBe(0);
    state = proseInsert(state, { row: 0, col: 1 }, "b");
    expect(undoDepth(state)).toBeGreaterThan(0);
  });

  it("redoDepth is 0 initially, >0 after undo", () => {
    let state = createEditorState({ prose: "a", frames: [], regions: [], proseParts: [] });
    state = proseInsert(state, { row: 0, col: 1 }, "b");
    expect(redoDepth(state)).toBe(0);
    state = editorUndo(state);
    expect(redoDepth(state)).toBeGreaterThan(0);
  });

  it("undo is a no-op when the stack is empty", () => {
    const state = createEditorState({ prose: "hello", frames: [], regions: [], proseParts: [] });
    const next = editorUndo(state);
    expect(getDoc(next)).toBe("hello");
  });

  it("redo is a no-op when nothing has been undone", () => {
    let state = createEditorState({ prose: "hello", frames: [], regions: [], proseParts: [] });
    state = proseInsert(state, { row: 0, col: 5 }, "!");
    const next = editorRedo(state); // nothing to redo yet
    expect(getDoc(next)).toBe("hello!");
  });
});
```

Run: `npm test -- src/editorState.test.ts` — all pass.

### 4.2 Commit

```bash
npm test -- src/editorState.test.ts
git add src/editorState.test.ts
git commit -m "test: unified undo/redo stack covers prose + frame operations in interleaved order"
```

---

## Task 5: Position converters — grapheme-aware

These tests are the safety net against R1 from the master plan's risk register
(grapheme vs code unit mismatch). Failures here would cause cursor drift with
emoji, CJK text, or text with combining characters.

### 5.1 Add failing tests

Append to `src/editorState.test.ts`:

```typescript
describe("Task 5: Position converters — grapheme-aware", () => {
  describe("rowColToPos / posToRowCol round-trip", () => {
    it("round-trips on pure ASCII text", () => {
      const state = createEditorState({
        prose: "hello\nworld",
        frames: [],
        regions: [],
        proseParts: [],
      });
      // Check every (row, col) combination
      for (const [row, len] of [[0, 5], [1, 5]] as const) {
        for (let col = 0; col <= len; col++) {
          const pos = rowColToPos(state, row, col);
          const back = posToRowCol(state, pos);
          expect(back).toEqual({ row, col });
        }
      }
    });

    it("handles basic emoji — 🎉 is 1 grapheme, 2 UTF-16 code units", () => {
      // "a🎉b": col 0='a', col 1='🎉', col 2='b', col 3=end
      const state = createEditorState({ prose: "a🎉b", frames: [], regions: [], proseParts: [] });

      expect(rowColToPos(state, 0, 0)).toBe(0); // before 'a'
      expect(rowColToPos(state, 0, 1)).toBe(1); // after 'a' (1 code unit)
      expect(rowColToPos(state, 0, 2)).toBe(3); // after '🎉' (2 code units for surrogate pair)
      expect(rowColToPos(state, 0, 3)).toBe(4); // after 'b'

      expect(posToRowCol(state, 0)).toEqual({ row: 0, col: 0 });
      expect(posToRowCol(state, 1)).toEqual({ row: 0, col: 1 });
      expect(posToRowCol(state, 3)).toEqual({ row: 0, col: 2 });
      expect(posToRowCol(state, 4)).toEqual({ row: 0, col: 3 });
    });

    it("handles ZWJ emoji sequence — 👨‍👩‍👧‍👦 is 1 grapheme, many code units", () => {
      // Family emoji: multiple code points joined by ZWJ (U+200D), all 1 grapheme
      const family = "👨\u200D👩\u200D👧\u200D👦";
      const familyCodeUnits = family.length; // UTF-16 length (varies by emoji)
      const state = createEditorState({
        prose: `${family}x`,
        frames: [],
        regions: [],
        proseParts: [],
      });

      // col 0 = family emoji (1 grapheme), col 1 = 'x'
      expect(rowColToPos(state, 0, 0)).toBe(0);
      expect(rowColToPos(state, 0, 1)).toBe(familyCodeUnits);
      expect(rowColToPos(state, 0, 2)).toBe(familyCodeUnits + 1);

      expect(posToRowCol(state, 0)).toEqual({ row: 0, col: 0 });
      expect(posToRowCol(state, familyCodeUnits)).toEqual({ row: 0, col: 1 });
    });

    it("handles combining marks — NFD ñ is 1 grapheme, 2 code units", () => {
      // n (U+006E) + combining tilde (U+0303) = 2 code units but 1 grapheme
      const nNFD = "n\u0303";
      // "aÑb" in NFD form: 'a'=1 cu, 'ñ'=2 cu, 'b'=1 cu
      const state = createEditorState({
        prose: `a${nNFD}b`,
        frames: [],
        regions: [],
        proseParts: [],
      });

      // col 0='a', col 1='ñ'(NFD), col 2='b'
      expect(rowColToPos(state, 0, 0)).toBe(0);
      expect(rowColToPos(state, 0, 1)).toBe(1); // after 'a'
      expect(rowColToPos(state, 0, 2)).toBe(3); // after NFD ñ (2 code units)
      expect(rowColToPos(state, 0, 3)).toBe(4); // after 'b'

      expect(posToRowCol(state, 0)).toEqual({ row: 0, col: 0 });
      expect(posToRowCol(state, 1)).toEqual({ row: 0, col: 1 });
      expect(posToRowCol(state, 3)).toEqual({ row: 0, col: 2 });
    });

    it("handles multiline doc with emoji on multiple lines", () => {
      const state = createEditorState({
        prose: "🎉\nhello\n🌍world",
        frames: [],
        regions: [],
        proseParts: [],
      });
      // Line 0: "🎉"       — 1 grapheme, 2 code units
      // Line 1: "hello"    — 5 graphemes
      // Line 2: "🌍world"  — 6 graphemes (🌍=1, world=5), 7 code units (🌍=2)

      const cursor = { row: 2, col: 3 }; // after '🌍wo'
      const pos = rowColToPos(state, cursor.row, cursor.col);
      const back = posToRowCol(state, pos);
      expect(back).toEqual(cursor);
    });

    it("clamps row below 0 to start of doc", () => {
      const state = createEditorState({ prose: "abc", frames: [], regions: [], proseParts: [] });
      expect(rowColToPos(state, -1, 0)).toBe(0);
    });

    it("clamps row beyond last line to end of doc", () => {
      const state = createEditorState({ prose: "abc", frames: [], regions: [], proseParts: [] });
      expect(rowColToPos(state, 999, 0)).toBe(3);
    });

    it("clamps col beyond line length to end of line", () => {
      const state = createEditorState({ prose: "abc", frames: [], regions: [], proseParts: [] });
      const pos = rowColToPos(state, 0, 999);
      expect(pos).toBe(3);
    });
  });

  describe("emoji round-trips through proseInsert/proseDeleteBefore", () => {
    it("inserts text after emoji without corrupting doc", () => {
      let state = createEditorState({ prose: "🎉", frames: [], regions: [], proseParts: [] });
      // cursor at col 1 — after the emoji (which is 2 UTF-16 code units)
      state = proseInsert(state, { row: 0, col: 1 }, "!");
      expect(getDoc(state)).toBe("🎉!");
      expect(getCursor(state)).toEqual({ row: 0, col: 2 });
    });

    it("backspace after emoji removes the entire grapheme, not half a surrogate", () => {
      let state = createEditorState({ prose: "a🎉b", frames: [], regions: [], proseParts: [] });
      // cursor at col 2 — between '🎉' and 'b'
      state = proseDeleteBefore(state, { row: 0, col: 2 });
      expect(getDoc(state)).toBe("ab");
      expect(getCursor(state)).toEqual({ row: 0, col: 1 });
    });

    it("backspace after ZWJ family emoji removes entire sequence", () => {
      const family = "👨\u200D👩\u200D👧\u200D👦";
      let state = createEditorState({ prose: family, frames: [], regions: [], proseParts: [] });
      // cursor at col 1 — after the family emoji
      state = proseDeleteBefore(state, { row: 0, col: 1 });
      expect(getDoc(state)).toBe("");
      expect(getCursor(state)).toEqual({ row: 0, col: 0 });
    });

    it("proseInsert on second line respects row offset", () => {
      let state = createEditorState({
        prose: "line one\nline two",
        frames: [],
        regions: [],
        proseParts: [],
      });
      state = proseInsert(state, { row: 1, col: 4 }, "X");
      expect(getDoc(state)).toBe("line one\nlineX two");
    });
  });
});
```

Run: `npm test -- src/editorState.test.ts` — all pass.

### 5.2 Commit

```bash
npm test -- src/editorState.test.ts
git add src/editorState.test.ts
git commit -m "test: grapheme-aware position converter tests — emoji, ZWJ sequences, combining marks"
```

---

## Task 6: Tool, regions, proseParts StateFields

### 6.1 Add failing tests

Append to `src/editorState.test.ts`:

```typescript
describe("Task 6: Tool, regions, proseParts StateFields", () => {
  const mockRegion: Region = {
    type: "prose",
    startRow: 0,
    endRow: 2,
    text: "hello",
  };

  const mockProsePart: ProsePart = { startRow: 0, text: "hello" };

  describe("regionsField", () => {
    it("stores initial regions from createEditorState", () => {
      const state = createEditorState({
        prose: "",
        frames: [],
        regions: [mockRegion],
        proseParts: [],
      });
      expect(getRegions(state)).toHaveLength(1);
      expect(getRegions(state)[0]).toEqual(mockRegion);
    });

    it("setRegionsEffect replaces all regions", () => {
      const state = createEditorState({
        prose: "",
        frames: [],
        regions: [mockRegion],
        proseParts: [],
      });
      const newRegion: Region = {
        type: "wireframe",
        startRow: 3,
        endRow: 6,
        text: "┌─┐\n│ │\n└─┘",
      };
      const next = state.update({ effects: setRegionsEffect.of([newRegion]) }).state;
      expect(getRegions(next)).toHaveLength(1);
      expect(getRegions(next)[0].type).toBe("wireframe");
    });
  });

  describe("prosePartsField", () => {
    it("stores initial proseParts from createEditorState", () => {
      const state = createEditorState({
        prose: "",
        frames: [],
        regions: [],
        proseParts: [mockProsePart],
      });
      expect(getProseParts(state)).toHaveLength(1);
      expect(getProseParts(state)[0]).toEqual(mockProsePart);
    });

    it("setProsePartsEffect replaces all parts", () => {
      const state = createEditorState({
        prose: "a",
        frames: [],
        regions: [],
        proseParts: [{ startRow: 0, text: "a" }],
      });
      const updated: ProsePart[] = [
        { startRow: 0, text: "a" },
        { startRow: 5, text: "b" },
      ];
      const next = state.update({ effects: setProsePartsEffect.of(updated) }).state;
      expect(getProseParts(next)).toHaveLength(2);
    });
  });

  describe("toolField via setTool", () => {
    it("cycles through all tool types correctly", () => {
      let state = createEditorState({ prose: "", frames: [], regions: [], proseParts: [] });
      for (const tool of ["rect", "line", "text", "select"] as const) {
        state = setTool(state, tool);
        expect(getTool(state)).toBe(tool);
      }
    });

    it("tool change is NOT in the undo stack — undoing a text edit does not revert tool", () => {
      // Tool is transient UI state. Cmd+Z should not switch your tool back.
      let state = createEditorState({ prose: "a", frames: [], regions: [], proseParts: [] });
      state = proseInsert(state, { row: 0, col: 1 }, "b"); // undoable
      state = setTool(state, "rect");                       // NOT undoable
      state = editorUndo(state);                            // should undo text, not tool
      expect(getDoc(state)).toBe("a");
      expect(getTool(state)).toBe("rect"); // tool stays as rect — it was not undone
    });
  });

  describe("regions and proseParts persist across undo", () => {
    it("prose undo does not reset regions", () => {
      const state = createEditorState({
        prose: "hello",
        frames: [],
        regions: [mockRegion],
        proseParts: [mockProsePart],
      });
      let next = proseInsert(state, { row: 0, col: 5 }, " world");
      next = editorUndo(next);
      // Regions and proseParts are set by setRegionsEffect / setProsePartsEffect,
      // not by text transactions, so they are NOT affected by undo.
      expect(getRegions(next)).toHaveLength(1);
      expect(getProseParts(next)).toHaveLength(1);
    });
  });
});
```

Run: `npm test -- src/editorState.test.ts` — all pass.

### 6.2 Commit

```bash
npm test -- src/editorState.test.ts
git add src/editorState.test.ts
git commit -m "test: tool/regions/proseParts StateField tests — tool not in undo stack"
```

---

## Task 7: Full suite regression check

```bash
npm test
```

All 376 pre-existing tests must still pass. The new `editorState.test.ts` adds
~55 tests. Target: 430+ total passing, 0 failing, 0 skipped.

If any test in `harness.test.ts` or `corpus.test.ts` fails:
1. Check whether `@codemirror/state` imported in the test environment affects globals.
   It should not — both CM packages are pure ES modules with no side effects.
2. If TypeScript errors arise from `Transaction` being used as a type in the
   fake view, add `// @ts-expect-error — CommandTarget interface requires EditorView but our fake suffices`
   with a justification comment. Do NOT use `@ts-ignore`.

Final commit:

```bash
git add -A
git commit -m "feat: Phase 3 complete — editorState.ts with CM StateField/StateEffect, unified undo stack"
```

---

## Acceptance Criteria

| Criterion | How verified |
|-----------|-------------|
| `@codemirror/state` and `@codemirror/commands` installed | `package.json` `dependencies` |
| `createEditorState` works headlessly (no DOM) | Task 1 tests pass via `npm test` |
| Prose insert/delete match `proseCursor.ts` behavior | Equivalence tests in Task 2 |
| Frame move/resize/add/delete work | Task 3 tests pass |
| `setTool` changes tool without entering undo stack | Task 6 test for tool persistence |
| Single undo stack: type text → move frame → undo frame → undo text | Interleaved test in Task 4 |
| Emoji insert/backspace doesn't corrupt the doc | Task 5 emoji round-trip tests |
| ZWJ emoji sequence treated as 1 grapheme | Task 5 ZWJ backspace test |
| Combining mark (NFD ñ) treated as 1 grapheme | Task 5 combining mark test |
| regions/proseParts survive prose undo | Task 6 persistence test |
| Full test suite remains green | `npm test` — 0 failures |

---

## Architecture Notes

### Why `Transaction.addToHistory.of(true)` on frame effects

CM's `history()` extension records transactions in two conditions:
1. The transaction has `userEvent` annotation in the `"input"` or `"delete"` family
2. The transaction is explicitly annotated with `Transaction.addToHistory.of(true)`

Frame operations (move, resize, add, delete) do not have a `userEvent` that CM
recognizes as a history-worthy event by default. The explicit annotation ensures
they appear in the undo stack. Without it, `undoDepth` would not increase after
a frame move, and Cmd+Z would skip over frame mutations.

### Why `resizeFrameEffect` carries `charWidth`/`charHeight` in the payload

`resizeFrameEffect` includes `charWidth` and `charHeight` directly in the effect
payload rather than reading them from a separate `cellSizeField`. This is simpler:
the effect is self-contained, the `framesField` update handler reads them from
`e.value`, and there is no dependency between StateFields that could introduce
ordering issues. A separate `cellSizeField` would add complexity for no benefit —
callers always know the cell dimensions at the call site.

### Why tool changes are NOT in the undo stack

`setTool` dispatches a transaction with only a `setToolEffect` and no
`Transaction.addToHistory` annotation. CM history ignores transactions that
neither touch the doc nor carry the annotation. This is intentional: activating
the rect tool and then pressing Cmd+Z should undo your last edit, not switch
you back to the select tool.

### Headless undo/redo via fake view

CM's `undo`/`redo` commands accept a `CommandTarget` — an object with
`{ state: EditorState, dispatch: (tr: Transaction) => void }`. No DOM is
required. The fake view captures the dispatched transaction and returns the
resulting state. This is the standard pattern used in CM's own headless test
suite (`@codemirror/state/test/`).

### `Intl.Segmenter` for grapheme clusters

`Intl.Segmenter` is available in:
- Node.js 16+
- All modern browsers (Chrome 87+, Firefox 78+, Safari 14.1+)
- Vitest's jsdom environment (which uses Node.js)

It correctly handles:
- ASCII (trivial)
- BMP emoji (U+1F300–U+1FFFF): 2 UTF-16 code units, 1 grapheme
- ZWJ sequences (multiple emoji joined by U+200D): many code units, 1 grapheme
- Combining marks (NFD text): base + combining code point = 1 grapheme
- Regional indicator pairs (flag emoji): 2 code points, 1 grapheme

---

## Files changed in Phase 3

| File | Action |
|------|--------|
| `package.json` | Add `@codemirror/state` and `@codemirror/commands` to `dependencies` |
| `package-lock.json` | Updated by npm |
| `src/editorState.ts` | Create — 250 lines, all StateField/StateEffect/operations |
| `src/editorState.test.ts` | Create — ~55 TDD tests covering all operations |

No existing files are modified in Phase 3. `DemoV2.tsx`, `proseCursor.ts`, and
all other source files are untouched — Phase 5 does the swap.
