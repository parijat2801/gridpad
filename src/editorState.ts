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
import type { Region } from "./regions";
import { scanToFrames } from "./scanToFrames";

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

export const setZEffect = StateEffect.define<{ id: string; z: number }>();

export const setToolEffect = StateEffect.define<ToolName>();

export const setRegionsEffect = StateEffect.define<Region[]>();

export const setProsePartsEffect = StateEffect.define<ProsePart[]>();

// Restore effect — used by invertedEffects for undo of frame mutations.
const restoreFramesEffect = StateEffect.define<Frame[]>();

// ── StateFields ────────────────────────────────────────────────────────────

export const framesField = StateField.define<Frame[]>({
  create: () => [],
  update(frames, tr: Transaction) {
    let result = frames;
    for (const e of tr.effects) {
      if (e.is(restoreFramesEffect)) {
        return e.value;
      } else if (e.is(moveFrameEffect)) {
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
      } else if (e.is(setZEffect)) {
        result = result.map(f => f.id === e.value.id ? { ...f, z: e.value.z } : f);
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
        e.is(setZEffect),
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
