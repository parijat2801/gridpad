// src/editorState.ts
// Single CM EditorState backing all of Gridpad's state.
// Prose in doc, frames/proseSegmentMap as StateFields.
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
import { scanToFrames } from "./scanToFrames";
import type { ProseSegment } from "./proseSegments";

export { undoDepth, redoDepth };

// ── Types ──────────────────────────────────────────────────────────────────

export interface CursorPos {
  row: number;  // 0-indexed line number
  col: number;  // 0-indexed grapheme cluster offset within that line
}

// ── StateEffects ───────────────────────────────────────────────────────────

export const moveFrameEffect = StateEffect.define<{
  id: string;
  dCol: number;
  dRow: number;
  charWidth: number;
  charHeight: number;
}>();

export const resizeFrameEffect = StateEffect.define<{
  id: string;
  gridW: number;
  gridH: number;
  charWidth: number;
  charHeight: number;
}>();

const addFrameEffect = StateEffect.define<Frame>();

const deleteFrameEffect = StateEffect.define<{ id: string }>();

export const setZEffect = StateEffect.define<{ id: string; z: number }>();

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
const clearDirtyEffect = StateEffect.define<null>();
const setOriginalProseSegmentsEffect = StateEffect.define<ProseSegment[]>();

// Mark a frame dirty by id, propagating up to ancestors.
function markDirtyById(frames: Frame[], id: string): { frames: Frame[]; found: boolean } {
  let found = false;
  const result = frames.map(f => {
    if (f.id === id) { found = true; return { ...f, dirty: true }; }
    if (f.children.length === 0) return f;
    const sub = markDirtyById(f.children, id);
    if (sub.found) { found = true; return { ...f, children: sub.frames, dirty: true }; }
    return f;
  });
  return { frames: found ? result : frames, found };
}

// ── StateFields ────────────────────────────────────────────────────────────

const framesField = StateField.define<Frame[]>({
  create: () => [],
  update(frames, tr: Transaction) {
    let result = frames;
    for (const e of tr.effects) {
      if (e.is(restoreFramesEffect)) {
        return e.value;
      } else if (e.is(clearDirtyEffect)) {
        const clearDirty = (fs: Frame[]): Frame[] =>
          fs.map(f => ({
            ...f,
            dirty: false,
            children: f.children.length > 0 ? clearDirty(f.children) : f.children,
          }));
        return clearDirty(result);
      } else if (e.is(moveFrameEffect)) {
        const applyMove = (f: Frame): Frame => {
          if (f.id === e.value.id) return moveFrame(f, { dCol: e.value.dCol, dRow: e.value.dRow, charWidth: e.value.charWidth, charHeight: e.value.charHeight });
          if (f.children.length > 0) return { ...f, children: f.children.map(applyMove) };
          return f;
        };
        result = result.map(applyMove);
        result = markDirtyById(result, e.value.id).frames;
      } else if (e.is(resizeFrameEffect)) {
        const applyResize = (f: Frame): Frame => {
          if (f.id === e.value.id) return resizeFrame(f, { gridW: e.value.gridW, gridH: e.value.gridH }, e.value.charWidth, e.value.charHeight);
          if (f.children.length > 0) return { ...f, children: f.children.map(applyResize) };
          return f;
        };
        result = result.map(applyResize);
        result = markDirtyById(result, e.value.id).frames;
      } else if (e.is(addFrameEffect)) {
        result = [...result, { ...e.value, dirty: true }];
      } else if (e.is(deleteFrameEffect)) {
        // Mark parent container dirty before removing
        const markParentDirty = (frames: Frame[]): Frame[] =>
          frames.map(f => {
            if (f.children.some(c => c.id === e.value.id)) return { ...f, dirty: true };
            if (f.children.length > 0) {
              const updated = markParentDirty(f.children);
              if (updated.some((c, i) => c !== f.children[i])) return { ...f, children: updated, dirty: true };
            }
            return f;
          });
        result = markParentDirty(result);
        const removeById = (frames: Frame[]): Frame[] => {
          const filtered = frames.filter(f => f.id !== e.value.id);
          if (filtered.length < frames.length) return filtered; // found at this level
          return frames.map(f => {
            if (f.children.length === 0) return f;
            const updated = removeById(f.children);
            return updated !== f.children ? { ...f, children: updated } : f;
          });
        };
        result = removeById(result);
        // Cascade: remove empty container parents (content === null, no children left after deletion)
        const cascadeEmpty = (frames: Frame[]): Frame[] => {
          return frames
            .map(f => {
              if (f.children.length === 0) return f;
              const updated = cascadeEmpty(f.children);
              return { ...f, children: updated };
            })
            .filter(f => !(f.content === null && f.children.length === 0 && f.dirty));
        };
        result = cascadeEmpty(result);
      } else if (e.is(setZEffect)) {
        const applyZ = (f: Frame): Frame => {
          if (f.id === e.value.id) return { ...f, z: e.value.z };
          if (f.children.length > 0) return { ...f, children: f.children.map(applyZ) };
          return f;
        };
        result = result.map(applyZ);
        result = markDirtyById(result, e.value.id).frames;
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
        result = markDirtyById(result, e.value.id).frames;
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
        result = markDirtyById(result, e.value.id).frames;
      }
    }
    return result;
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

const proseSegmentMapField = StateField.define<{ row: number; col: number }[]>({
  create: () => [],
  update(map, tr: Transaction) {
    if (!tr.docChanged) return map;
    const oldLines = tr.startState.doc.lines;
    const newLines = tr.state.doc.lines;
    const delta = newLines - oldLines;
    if (delta === 0) return map;
    let changeLine = 0;
    tr.changes.iterChangedRanges((fromA) => {
      changeLine = tr.startState.doc.lineAt(fromA).number - 1;
    });
    const result = [...map];
    if (delta > 0) {
      const insertAt = changeLine + 1;
      const newEntries: { row: number; col: number }[] = [];
      const baseRow = result[changeLine]?.row ?? changeLine;
      for (let i = 0; i < delta; i++) {
        newEntries.push({ row: baseRow + 1 + i, col: 0 });
      }
      result.splice(insertAt, 0, ...newEntries);
      for (let i = insertAt + delta; i < result.length; i++) {
        result[i] = { ...result[i], row: result[i].row + delta };
      }
    } else {
      const removeAt = changeLine + 1;
      const removeCount = Math.min(-delta, result.length - removeAt);
      result.splice(removeAt, removeCount);
      for (let i = removeAt; i < result.length; i++) {
        result[i] = { ...result[i], row: result[i].row + delta };
      }
    }
    return result;
  },
});

export function getProseSegmentMap(state: EditorState): { row: number; col: number }[] {
  return state.field(proseSegmentMapField);
}

const originalProseSegmentsField = StateField.define<ProseSegment[]>({
  create: () => [],
  update(segs, tr) {
    for (const e of tr.effects) {
      if (e.is(setOriginalProseSegmentsEffect)) return e.value;
    }
    return segs;
  },
});

export function getOriginalProseSegments(state: EditorState): ProseSegment[] {
  return state.field(originalProseSegmentsField);
}

// ── Factory ────────────────────────────────────────────────────────────────

interface EditorStateInit {
  prose: string;
  frames: Frame[];
  proseSegmentMap?: { row: number; col: number }[];
  originalProseSegments?: ProseSegment[];
}

export function createEditorState(init: EditorStateInit): EditorState {
  const { prose, frames } = init;
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
    selectedIdField,
    textEditField,
  ];

  if (init.proseSegmentMap) {
    extensions.push(proseSegmentMapField.init(() => init.proseSegmentMap!));
  } else {
    extensions.push(proseSegmentMapField);
  }

  if (init.originalProseSegments) {
    extensions.push(originalProseSegmentsField.init(() => init.originalProseSegments!));
  } else {
    extensions.push(originalProseSegmentsField);
  }

  return EditorState.create({ doc: prose, extensions });
}

// Convenience factory — runs scanToFrames internally.
export function createEditorStateFromText(
  text: string,
  charWidth: number,
  charHeight: number,
): EditorState {
  const { frames, proseSegments } = scanToFrames(text, charWidth, charHeight);
  const byRow = new Map<number, string>();
  for (const seg of proseSegments) {
    const existing = byRow.get(seg.row) ?? "";
    if (existing && seg.col > existing.length) {
      byRow.set(seg.row, existing + " ".repeat(seg.col - existing.length) + seg.text);
    } else {
      byRow.set(seg.row, existing + seg.text);
    }
  }
  const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
  const proseText = sortedRows.map(r => byRow.get(r)!).join("\n");
  const proseSegmentMap = sortedRows.map(r => {
    const seg = proseSegments.find(s => s.row === r);
    return { row: r, col: seg?.col ?? 0 };
  });
  return createEditorState({
    prose: proseText,
    frames,
    proseSegmentMap,
    originalProseSegments: proseSegments,
  });
}

// ── Accessors ──────────────────────────────────────────────────────────────

export function getDoc(state: EditorState): string {
  return state.doc.toString();
}

export function getFrames(state: EditorState): Frame[] {
  return state.field(framesField);
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

export function applyResizeFrame(
  state: EditorState,
  id: string,
  gridW: number,
  gridH: number,
  charWidth: number,
  charHeight: number,
): EditorState {
  return state.update({
    effects: resizeFrameEffect.of({ id, gridW, gridH, charWidth, charHeight }),
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

export function applyClearDirty(state: EditorState): EditorState {
  return state.update({
    effects: clearDirtyEffect.of(null),
    annotations: Transaction.addToHistory.of(false),
  }).state;
}

export function applySetOriginalProseSegments(
  state: EditorState,
  segments: ProseSegment[],
): EditorState {
  return state.update({
    effects: setOriginalProseSegmentsEffect.of(segments),
    annotations: Transaction.addToHistory.of(false),
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
