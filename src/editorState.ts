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
import { history, undo, redo, undoDepth, redoDepth, invertedEffects } from "@codemirror/commands";
import type { Frame } from "./frame";
import { moveFrame, resizeFrame } from "./frame";
import { layoutTextChildren } from "./autoLayout";
import type { Region } from "./regions";
import { scanToFrames } from "./scanToFrames";

export { undoDepth, redoDepth };

// ── Types ──────────────────────────────────────────────────────────────────

type ToolName = "select" | "rect" | "line" | "text";

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

const addFrameEffect = StateEffect.define<Frame>();

const deleteFrameEffect = StateEffect.define<{ id: string }>();

export const setZEffect = StateEffect.define<{ id: string; z: number }>();

const setToolEffect = StateEffect.define<ToolName>();

const setRegionsEffect = StateEffect.define<Region[]>();

const setProsePartsEffect = StateEffect.define<ProsePart[]>();

export const selectFrameEffect = StateEffect.define<string | null>();

export const setTextEditEffect = StateEffect.define<{ frameId: string; col: number } | null>();

export const editTextFrameEffect = StateEffect.define<{ id: string; text: string; charWidth: number }>();

export const setTextAlignEffect = StateEffect.define<{
  id: string;
  hAlign?: { anchor: "left" | "center" | "right"; offset: number };
  vAlign?: { anchor: "top" | "center" | "bottom"; offset: number };
  charWidth: number;
  charHeight: number;
}>();

// Restore effect — used by invertedEffects for undo of frame mutations.
const restoreFramesEffect = StateEffect.define<Frame[]>();

// ── StateFields ────────────────────────────────────────────────────────────

const framesField = StateField.define<Frame[]>({
  create: () => [],
  update(frames, tr: Transaction) {
    let result = frames;
    for (const e of tr.effects) {
      if (e.is(restoreFramesEffect)) {
        return e.value;
      } else if (e.is(moveFrameEffect)) {
        const applyMove = (f: Frame): Frame => {
          if (f.id === e.value.id) return moveFrame(f, { dx: e.value.dx, dy: e.value.dy });
          if (f.children.length > 0) return { ...f, children: f.children.map(applyMove) };
          return f;
        };
        result = result.map(applyMove);
      } else if (e.is(resizeFrameEffect)) {
        const applyResize = (f: Frame): Frame => {
          if (f.id === e.value.id) return resizeFrame(f, { w: e.value.w, h: e.value.h }, e.value.charWidth, e.value.charHeight);
          if (f.children.length > 0) return { ...f, children: f.children.map(applyResize) };
          return f;
        };
        result = result.map(applyResize);
      } else if (e.is(addFrameEffect)) {
        result = [...result, e.value];
      } else if (e.is(deleteFrameEffect)) {
        const removeById = (frames: Frame[]): Frame[] => {
          const filtered = frames.filter(f => f.id !== e.value.id);
          return filtered.map(f =>
            f.children.length > 0
              ? { ...f, children: removeById(f.children) }
              : f
          );
        };
        result = removeById(result);
      } else if (e.is(setZEffect)) {
        const applyZ = (f: Frame): Frame => {
          if (f.id === e.value.id) return { ...f, z: e.value.z };
          if (f.children.length > 0) return { ...f, children: f.children.map(applyZ) };
          return f;
        };
        result = result.map(applyZ);
      } else if (e.is(editTextFrameEffect)) {
        const editFrame = (f: Frame): Frame => {
          if (f.id === e.value.id) {
            const cps = [...e.value.text];
            const cells = new Map<string, string>();
            cps.forEach((ch, i) => cells.set(`0,${i}`, ch));
            return {
              ...f,
              w: Math.max(cps.length, 1) * e.value.charWidth,
              content: f.content ? { ...f.content, text: e.value.text, cells } : { type: "text" as const, cells, text: e.value.text },
            };
          }
          if (f.children.length > 0) {
            return { ...f, children: f.children.map(editFrame) };
          }
          return f;
        };
        result = result.map(editFrame);
      } else if (e.is(setTextAlignEffect)) {
        const cw = e.value.charWidth, ch = e.value.charHeight;
        const applyAlign = (f: Frame): Frame => {
          if (f.id === e.value.id && f.content?.type === "text") {
            const hAlign = e.value.hAlign ?? f.content.hAlign;
            const vAlign = e.value.vAlign ?? f.content.vAlign;
            return { ...f, content: { ...f.content, hAlign, vAlign } };
          }
          if (f.children.length > 0) {
            const updated = { ...f, children: f.children.map(applyAlign) };
            // Relayout parent rect after child alignment change
            if (f.content?.type === "rect") return layoutTextChildren(updated, cw, ch);
            return updated;
          }
          return f;
        };
        result = result.map(applyAlign);
      }
    }
    return result;
  },
});

const toolField = StateField.define<ToolName>({
  create: () => "select",
  update(tool, tr: Transaction) {
    for (const e of tr.effects) {
      if (e.is(setToolEffect)) return e.value;
    }
    return tool;
  },
});

const regionsField = StateField.define<Region[]>({
  create: () => [],
  update(regions, tr: Transaction) {
    for (const e of tr.effects) {
      if (e.is(setRegionsEffect)) return e.value;
    }
    return regions;
  },
});

const prosePartsField = StateField.define<ProsePart[]>({
  create: () => [],
  update(parts, tr: Transaction) {
    for (const e of tr.effects) {
      if (e.is(setProsePartsEffect)) return e.value;
    }
    return parts;
  },
});

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

// ── Factory ────────────────────────────────────────────────────────────────

interface EditorStateInit {
  prose: string;
  frames: Frame[];
  regions: Region[];
  proseParts: ProsePart[];
}

export function createEditorState(init: EditorStateInit): EditorState {
  const { prose, frames, regions, proseParts } = init;
  // invertedEffects tells CM history how to undo frame mutations:
  // snapshot the frames array before the transaction and emit a
  // restoreFramesEffect that replays it on undo.
  const frameInversion = invertedEffects.of((tr) => {
    const hasFrameEffect = tr.effects.some(
      (e) =>
        e.is(moveFrameEffect) ||
        e.is(resizeFrameEffect) ||
        e.is(addFrameEffect) ||
        e.is(deleteFrameEffect) ||
        e.is(setZEffect) ||
        e.is(editTextFrameEffect) ||
        e.is(setTextAlignEffect),
    );
    if (!hasFrameEffect) return [];
    // Capture the frames BEFORE this transaction was applied
    return [restoreFramesEffect.of(tr.startState.field(framesField))];
  });

  const extensions: Extension[] = [
    history(),
    frameInversion,
    framesField.init(() => frames),
    toolField,
    selectedIdField,
    textEditField,
    regionsField.init(() => regions),
    prosePartsField.init(() => proseParts),
  ];
  return EditorState.create({ doc: prose, extensions });
}

// Convenience factory — runs scanToFrames internally.
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

export function rebuildProseParts(state: EditorState): { startRow: number; text: string }[] {
  const regions = getRegions(state);
  const doc = getDoc(state);
  const lines = doc.split("\n");
  const proseRegions = regions.filter(r => r.type === "prose");
  const parts: { startRow: number; text: string }[] = [];
  let lineOffset = 0;

  for (let i = 0; i < proseRegions.length; i++) {
    const region = proseRegions[i];
    const regionLines = region.text.split("\n").length;
    const slice = lines.slice(lineOffset, lineOffset + regionLines).join("\n");
    parts.push({ startRow: region.startRow, text: slice });
    lineOffset += regionLines;
    // Skip the \n\n separator between prose parts (adds 1 empty line in the doc)
    if (i < proseRegions.length - 1) lineOffset += 1;
  }
  return parts;
}

// ── Position converters ────────────────────────────────────────────────────
//
// CRITICAL: CM doc uses UTF-16 code unit offsets. Gridpad canvas uses
// grapheme cluster columns (what the user sees). These differ for:
//   - Emoji: 🎉 is U+1F389, 2 UTF-16 code units, 1 grapheme
//   - ZWJ sequences: 👨‍👩‍👧‍👦 = many code units, 1 grapheme
//   - Combining marks: n + U+0303 (combining tilde) = 2 code units, 1 grapheme

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

export function proseDeleteBefore(
  state: EditorState,
  cursor: CursorPos,
): EditorState {
  if (cursor.row === 0 && cursor.col === 0) return state;

  const pos = rowColToPos(state, cursor.row, cursor.col);
  const lineInfo = state.doc.lineAt(pos);
  let prevClusterStart: number;

  if (pos === lineInfo.from) {
    prevClusterStart = pos - 1;
  } else {
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

export function moveCursorTo(
  state: EditorState,
  cursor: CursorPos,
): EditorState {
  const pos = rowColToPos(state, cursor.row, cursor.col);
  return state.update({ selection: { anchor: pos } }).state;
}

export function proseMoveLeft(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.col > 0) return moveCursorTo(state, { row: cursor.row, col: cursor.col - 1 });
  if (cursor.row > 0) {
    const prevLine = state.doc.line(cursor.row); // 1-indexed; cursor.row is 0-indexed, so this gets the line above
    const graphemeCount = [...segmenter.segment(prevLine.text)].length;
    return moveCursorTo(state, { row: cursor.row - 1, col: graphemeCount });
  }
  return state;
}

export function proseMoveRight(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  const line = state.doc.line(cursor.row + 1); // current line (1-indexed)
  const graphemeCount = [...segmenter.segment(line.text)].length;
  if (cursor.col < graphemeCount) return moveCursorTo(state, { row: cursor.row, col: cursor.col + 1 });
  if (cursor.row < state.doc.lines - 1) return moveCursorTo(state, { row: cursor.row + 1, col: 0 });
  return state;
}

export function proseMoveUp(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.row === 0) return state;
  const prevLine = state.doc.line(cursor.row); // line above (1-indexed = cursor.row)
  const prevGraphemes = [...segmenter.segment(prevLine.text)].length;
  return moveCursorTo(state, { row: cursor.row - 1, col: Math.min(cursor.col, prevGraphemes) });
}

export function proseMoveDown(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.row >= state.doc.lines - 1) return state;
  const nextLine = state.doc.line(cursor.row + 2); // line below (1-indexed = cursor.row + 2)
  const nextGraphemes = [...segmenter.segment(nextLine.text)].length;
  return moveCursorTo(state, { row: cursor.row + 1, col: Math.min(cursor.col, nextGraphemes) });
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
  // Check if targetId is the deleted frame or any of its descendants
  const frameContains = (frame: Frame, targetId: string): boolean => {
    if (frame.id === targetId) return true;
    return frame.children.some(c => frameContains(c, targetId));
  };
  const deletedFrame = getFrames(state).find(f => frameContains(f, id));
  const isAffected = (targetId: string): boolean => {
    if (targetId === id) return true;
    if (!deletedFrame) return false;
    return frameContains(deletedFrame, targetId);
  };

  const effects: StateEffect<unknown>[] = [deleteFrameEffect.of({ id })];
  const selectedId = getSelectedId(state);
  if (selectedId && isAffected(selectedId)) {
    effects.push(selectFrameEffect.of(null));
  }
  const te = getTextEdit(state);
  if (te && isAffected(te.frameId)) {
    effects.push(setTextEditEffect.of(null));
  }
  return state.update({
    effects,
    annotations: Transaction.addToHistory.of(true),
  }).state;
}

export function setTool(state: EditorState, tool: ToolName): EditorState {
  return state.update({
    effects: setToolEffect.of(tool),
  }).state;
}

// ── Undo / Redo ────────────────────────────────────────────────────────────

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
