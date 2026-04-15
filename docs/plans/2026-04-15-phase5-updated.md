# Phase 5 Updated: DemoV2 Rewrite — Corrected Plan

> Incorporates Codex review findings and gap analysis against actual APIs.
> Supersedes the Phase 5 section in `2026-04-15-phase5-demo-rewrite.md`.

**Goal:** Replace DemoV2's 20-ref, 571-line monolith with a thin shell driven
by a single CM `EditorState`. Fix P0 cursor reliability, P0 prose-edits-lost-
on-save, and enable undo/redo for all operations.

**Branch:** `feature/architecture-refactor` (continuing current work)

**Pre-Phase 5 status:** 287 tests passing. `editorState.ts`, `canvasRenderer.ts`,
`scanToFrames.ts` all exist and are tested. Z-order model complete.

---

## Pre-requisite: Phase 5.0 — Fill API Gaps

Before rewriting DemoV2, `editorState.ts` needs APIs that the current DemoV2
uses but editorState doesn't provide yet. Without these, the rewrite will
stall.

### Task 5.0.1 — Arrow-key cursor movement helpers

**File:** `src/editorState.ts`

**Problem:** DemoV2 handles ArrowLeft/Right/Up/Down manually with line-aware
logic. editorState.ts only has `moveCursorTo(state, {row, col})` — no helpers
for relative movement.

**Add these exports:**

```typescript
export function proseMoveLeft(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.col > 0) return moveCursorTo(state, { row: cursor.row, col: cursor.col - 1 });
  if (cursor.row > 0) {
    // Jump to end of previous line
    const prevLine = state.doc.line(cursor.row); // CM is 1-indexed, cursor.row is 0-indexed
    const prevLineText = prevLine.text;
    const graphemeCount = [...segmenter.segment(prevLineText)].length;
    return moveCursorTo(state, { row: cursor.row - 1, col: graphemeCount });
  }
  return state;
}

export function proseMoveRight(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  const line = state.doc.line(cursor.row + 1);
  const graphemeCount = [...segmenter.segment(line.text)].length;
  if (cursor.col < graphemeCount) return moveCursorTo(state, { row: cursor.row, col: cursor.col + 1 });
  if (cursor.row < state.doc.lines - 1) return moveCursorTo(state, { row: cursor.row + 1, col: 0 });
  return state;
}

export function proseMoveUp(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.row === 0) return state;
  const prevLine = state.doc.line(cursor.row); // line above (CM 1-indexed)
  const prevGraphemes = [...segmenter.segment(prevLine.text)].length;
  return moveCursorTo(state, { row: cursor.row - 1, col: Math.min(cursor.col, prevGraphemes) });
}

export function proseMoveDown(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.row >= state.doc.lines - 1) return state;
  const nextLine = state.doc.line(cursor.row + 2); // line below (CM 1-indexed)
  const nextGraphemes = [...segmenter.segment(nextLine.text)].length;
  return moveCursorTo(state, { row: cursor.row + 1, col: Math.min(cursor.col, nextGraphemes) });
}
```

**Tests (RED first, then GREEN):**
- moveLeft at col 5 → col 4
- moveLeft at col 0, row 1 → end of row 0
- moveLeft at (0,0) → no-op
- moveRight at col 3 of 5-char line → col 4
- moveRight at end of line → start of next line
- moveUp preserves col, clamps to shorter line
- moveDown preserves col, clamps to shorter line

**Note:** The `segmenter` is module-scoped in editorState.ts (line 222). These
helpers need access to it — they must be in the same file.

### Task 5.0.2 — Selected frame field in EditorState

**File:** `src/editorState.ts`

**Problem:** DemoV2 tracks selection via `selectedRef`. The plan's Phase 5.3
describes adding `selectedIdField` + `selectFrameEffect`, but this isn't
implemented yet.

**Add:**

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

Add `selectedIdField` to the `createEditorState` extensions array.

**Tests:** select a frame, deselect (null), select doesn't enter undo stack.

### Task 5.0.3 — Text edit field in EditorState

**File:** `src/editorState.ts`

**Problem:** DemoV2 tracks text editing cursor via `textEditRef`. The plan's
Phase 5.6 describes `textEditField` + `setTextEditEffect` + `editTextFrameEffect`.

**Add:**

```typescript
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

export function getTextEdit(state: EditorState): { frameId: string; col: number } | null {
  return state.field(textEditField);
}

export const editTextFrameEffect = StateEffect.define<{
  id: string;
  text: string;
  charWidth: number;
}>();
```

Handle `editTextFrameEffect` in `framesField.update`:
```typescript
if (e.is(editTextFrameEffect)) {
  result = result.map(f => {
    if (f.id !== e.value.id) return f;
    const cps = [...e.value.text];
    const cells = new Map<string, string>();
    cps.forEach((ch, i) => cells.set(`0,${i}`, ch));
    return {
      ...f,
      w: Math.max(cps.length, 1) * e.value.charWidth,
      content: { ...f.content!, text: e.value.text, cells },
    };
  });
}
```

Add `editTextFrameEffect` to the `invertedEffects` detection list.
Add `textEditField` and `selectedIdField` to `createEditorState` extensions.

**Tests:** set text edit, edit text frame content, undo restores text.

### Task 5.0.4 — Prose click-to-cursor helper

**File:** `src/canvasRenderer.ts`

**Problem:** DemoV2's `proseCursorFromClick(px, py)` converts a click position
to a source-text `{row, col}` using `linesRef` and `proseRef`. After the
rewrite, DemoV2 won't have those refs. The render state has `lines` — we need
a function that maps a click to a cursor position given a RenderState.

**Add:**

```typescript
export function clickToCursor(
  rs: RenderState,
  px: number,
  py: number,
): { row: number; col: number } | null {
  if (rs.lines.length === 0) return null;

  // Find closest line by vertical distance
  let best: PositionedLine | null = null;
  let bestDist = Infinity;
  for (const pl of rs.lines) {
    const dist = Math.abs(pl.y + LH / 2 - py);
    if (dist < bestDist) { bestDist = dist; best = pl; }
  }
  if (!best) return null;

  // Map visual line back to source row
  const srcLines = rs.proseText.split("\n");
  let srcRow = 0;
  for (const pl of rs.lines) {
    if (pl === best) break;
    const srcLineText = srcLines[srcRow] ?? "";
    if (pl.text.length >= srcLineText.length) srcRow++;
  }

  // Column from horizontal offset
  const col = Math.max(0, Math.min(
    Math.round((px - best.x) / rs.charWidth),
    (srcLines[srcRow] ?? "").length,
  ));

  return { row: srcRow, col };
}
```

**Tests:** click at known coordinates returns expected {row, col}.

### Task 5.0.5 — `rebuildProseParts` for save

**File:** `src/editorState.ts`

**Problem:** `saveToHandle` currently writes `proseRef.current` as-is. After
migration, we need to reconstruct prose parts from the CM doc + regions so
`framesToMarkdown` can serialize correctly.

**Add:**

```typescript
export function rebuildProseParts(
  state: EditorState,
): { startRow: number; text: string }[] {
  const regions = getRegions(state);
  const doc = getDoc(state);
  const lines = doc.split("\n");
  const parts: { startRow: number; text: string }[] = [];
  let lineOffset = 0;

  for (const region of regions) {
    if (region.type === "prose") {
      const regionLines = region.text.split("\n").length;
      const slice = lines.slice(lineOffset, lineOffset + regionLines).join("\n");
      parts.push({ startRow: region.startRow, text: slice });
      lineOffset += regionLines;
    }
  }
  return parts;
}
```

**Tests:** create state from text, edit prose, rebuild → parts reflect edits.

---

## Phase 5 — DemoV2 Rewrite (revised order per Codex review)

**Execution order:** 5.1 → 5.3 → 5.4 → 5.5 → 5.7 → 5.2 → 5.6 → 5.8

Rationale: migrate reads before writes, frame ops before prose ops (prose is
highest risk), file I/O before prose editing so load/save is stable.

### Task 5.1 — State initialization + paint delegation

**What changes in DemoV2.tsx:**

1. Add `stateRef = useRef<EditorState>(null!)` — the single CM state.
2. Rewrite `loadDocument(text)`:
   ```typescript
   function loadDocument(text: string) {
     stateRef.current = createEditorStateFromText(text, cwRef.current, chRef.current);
     // Also keep framesRef/proseRef in sync for un-migrated code
     framesRef.current = getFrames(stateRef.current);
     proseRef.current = getDoc(stateRef.current);
   }
   ```
3. Rewrite `paint()` to build render state from CM, but keep computing
   `linesRef` for click-to-cursor (don't remove `doLayout` yet):
   ```typescript
   function paint() {
     const canvas = canvasRef.current;
     if (!canvas) return;
     const rs = buildRenderState(stateRef.current, sizeRef.current, dpr, cwRef.current, chRef.current, {
       selectedId: selectedRef.current,
       cursorVisible: blinkRef.current,
       textEdit: textEditRef.current,
       drawPreview: drawPreviewRef.current,
       textPlacement: textPlacementRef.current,
     });
     // Keep linesRef for un-migrated click-to-cursor
     linesRef.current = rs.lines;
     paintCanvas(ctx, rs);
   }
   ```

**Removes:** `preparedRef` (reflow is inside `buildRenderState`).
**Keeps (temporarily):** `framesRef`, `proseRef`, `linesRef`, all other refs.

**Verify:** App renders identically. Default document displays prose + frames.

### Task 5.3 — Frame display + drag via CM effects

**What changes:**

1. Remove `framesRef`. All frame reads use `getFrames(stateRef.current)`.
2. `onMouseDown` frame selection → `selectFrameEffect`:
   ```typescript
   stateRef.current = stateRef.current.update({
     effects: selectFrameEffect.of(hit.id)
   }).state;
   ```
3. Remove `selectedRef`. Use `getSelectedId(stateRef.current)`.
4. `onMouseMove` drag → `applyMoveFrame` with `addToHistory: false`:
   ```typescript
   stateRef.current = stateRef.current.update({
     effects: moveFrameEffect.of({ id, dx, dy }),
     annotations: [Transaction.addToHistory.of(false)],
   }).state;
   ```
5. `onMouseUp` → commit final position with history.
6. `dragRef` stays as ephemeral ref (not CM state — it's transient UI).
7. Remove `replaceFrame` helper — no longer needed.
8. Remove `findFrameById` from DemoV2 — import from `canvasRenderer.ts`
   or inline `getFrames(state).find(f => f.id === id)`.

**Verify:** Click selects frame. Drag moves frame. Cmd+Z reverts position.

### Task 5.4 — Frame resize via CM effects

**What changes:**

1. `onMouseMove` resize path → `applyResizeFrame`:
   ```typescript
   stateRef.current = applyResizeFrame(stateRef.current, id, newW, newH, cw, ch);
   ```
2. Same addToHistory pattern as drag (false during move, true on mouseUp).

**Verify:** Resize handles work. Rect cells regenerate. Cmd+Z restores size.

### Task 5.5 — Drawing tools via CM effects

**What changes:**

1. `onMouseUp` drawing-tool path → `applyAddFrame`:
   ```typescript
   const frame = createRectFrame({ ... });
   stateRef.current = applyAddFrame(stateRef.current, frame);
   ```
2. Tool state in CM via `setTool`:
   ```typescript
   stateRef.current = setTool(stateRef.current, "rect");
   ```
3. Remove `activeToolRef`. Use `getTool(stateRef.current)`.
4. `drawPreviewRef` and `textPlacementRef` stay as ephemeral refs.
5. Delete key with frame selected → `applyDeleteFrame`.

**Note on deletion:** `deleteFrameEffect` only filters top-level frames.
If nested child deletion is needed, either:
- a) Add recursive deletion in `framesField.update`, OR
- b) Only allow deleting container frames (children go with them).
Option (b) is simpler and matches current behavior.

**Verify:** Draw rect, line, text. Cmd+Z removes drawn frame.

### Task 5.7 — File I/O (save with rebuilt prose)

**What changes:**

1. `loadDocument` already creates CM state (from Task 5.1). No change.
2. `saveToHandle` → use `rebuildProseParts` + `framesToMarkdown`:
   ```typescript
   async function saveToHandle(h: FileSystemFileHandle) {
     const state = stateRef.current;
     const md = framesToMarkdown(
       getFrames(state),
       rebuildProseParts(state),
       getRegions(state),
       cwRef.current,
       chRef.current,
     );
     const w = await (h as WritableHandle).createWritable();
     await w.write(md);
     await w.close();
   }
   ```
3. Remove `proseRef` — doc text comes from `getDoc(stateRef.current)`.

**Note:** `regions` and `proseParts` StateFields are set once at load and never
recomputed. For save to work correctly after prose edits, `rebuildProseParts`
must derive parts from `doc` + `regions`. See Task 5.0.5.

**Verify:** Edit prose, save, reopen — edits preserved. Move frame, save,
reopen — frame at new position.

### Task 5.2 — Prose editing via CM transactions (HIGHEST RISK)

**What changes:**

1. Keydown handler prose branch:
   - Single char → `stateRef.current = proseInsert(stateRef.current, getCursor(stateRef.current)!, e.key)`
   - Backspace → `stateRef.current = proseDeleteBefore(stateRef.current, getCursor(stateRef.current)!)`
   - Enter → `stateRef.current = proseInsert(stateRef.current, getCursor(stateRef.current)!, "\n")`
   - ArrowLeft → `stateRef.current = proseMoveLeft(stateRef.current)`
   - ArrowRight → `stateRef.current = proseMoveRight(stateRef.current)`
   - ArrowUp → `stateRef.current = proseMoveUp(stateRef.current)`
   - ArrowDown → `stateRef.current = proseMoveDown(stateRef.current)`
   - Escape → clear cursor (moveCursorTo doesn't apply — need to handle at DemoV2 level)

2. `onMouseDown` prose click:
   - Use `clickToCursor(lastRenderState, px, py)` instead of `proseCursorFromClick`.
   - `stateRef.current = moveCursorTo(stateRef.current, cursor)`.
   - Store `lastRenderState` from the most recent `buildRenderState` call.

3. Remove `proseCursorRef` — cursor is `getCursor(stateRef.current)`.
4. Remove `proseRef` (if not already removed in 5.7).
5. Remove `linesRef` — lines come from `buildRenderState`.
6. Remove `import { insertChar, deleteChar } from "./proseCursor"`.

**Undo/redo wiring:**
- Cmd+Z → `stateRef.current = editorUndo(stateRef.current); paint();`
- Cmd+Shift+Z → `stateRef.current = editorRedo(stateRef.current); paint();`

**Verify:** Type text, backspace, arrow keys, click to place cursor. Cmd+Z
reverts text and frame operations in interleaved order.

### Task 5.6 — Text frame editing via CM effects

**What changes:**

1. Double-click text frame → `setTextEditEffect.of({ frameId, col: textLen })`.
2. Keydown in text-edit mode:
   - Char → `editTextFrameEffect.of({ id, text: newText, charWidth: cw })` +
     `setTextEditEffect.of({ frameId, col: newCol })`
   - Backspace → same pattern, removing char
   - ArrowLeft/Right → `setTextEditEffect.of({ frameId, col: newCol })`
   - Escape/Enter → `setTextEditEffect.of(null)`
3. Remove `textEditRef`. Use `getTextEdit(stateRef.current)`.
4. Remove local `buildTextCells` — logic moves to `framesField.update`.

**Verify:** Double-click text frame, type, backspace. Cmd+Z reverts.

### Task 5.8 — Line count audit + cleanup

1. `wc -l src/DemoV2.tsx` — target < 200 lines (150 is aspirational).
2. If over limit, extract:
   - `computeHandleRects` + `hitTestHandle` → `src/resizeHandles.ts`
   - DEFAULT_TEXT → `src/fixtures/defaultText.ts`
   - TOOL_BUTTONS → inline or extract to `src/Toolbar.tsx`
3. Remove any remaining dead refs.
4. Run `npm test` + `npm run build` + verify in browser.

---

## Phase 5 Acceptance Criteria

- [ ] `npm test` passes (320+ tests)
- [ ] `npm run build` passes
- [ ] Browser: open file, edit prose, move frames, draw shapes, save — all work
- [ ] Cmd+Z / Cmd+Shift+Z undo/redo works for prose + frames interleaved
- [ ] Large file (52KB) opens without crash (canvas capped to viewport)
- [ ] DemoV2.tsx < 200 lines
- [ ] State-bearing refs: `canvasRef`, `sizeRef`, `stateRef` (+ ephemeral: `dragRef`,
  `blinkRef`, `lastClickRef`, `drawPreviewRef`, `textPlacementRef`, `fileHandleRef`,
  `autosaveTimerRef`, `cwRef`, `chRef`)
- [ ] No `framesRef`, `proseRef`, `preparedRef`, `linesRef`, `selectedRef`,
  `proseCursorRef`, `textEditRef`, `activeToolRef`

---

## Risks

### R1: Arrow key movement across wrapped lines
CM cursor is source-text based but visual lines may be wrapped. Arrow up/down
moves by source line, not visual line. This matches VS Code behavior and is
acceptable for v1. Visual-line movement requires layout metadata.

### R2: Prose click-to-cursor accuracy
`clickToCursor` maps visual position to source row by walking wrapped lines.
This is approximate for long wrapped lines. Acceptable for v1.

### R3: proseParts staleness after editing
`rebuildProseParts` slices the CM doc using region line counts set at load time.
If prose edits add/remove lines that cross region boundaries, the slice will be
wrong. Acceptable for v1 — proper fix requires CM decorations tracking region
boundaries (Phase 8+).

### R4: deleteFrameEffect vs nested children
`deleteFrameEffect` filters top-level frames only. Deleting a container removes
it and its children (since children are inside the container object). This
matches current behavior.

### R5: React re-renders
`stateRef.current = ...` does not trigger React re-renders. The toolbar needs
to re-render on tool change. Use a `useState` tick counter, called only for
toolbar-visible state changes (tool, selection).
