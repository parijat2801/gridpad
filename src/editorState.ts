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

// addChildFrameEffect — add frame as a child of parentId. Frame's gridRow/
// gridCol are parent-relative. lineCount is forced to 0 (children don't claim
// doc lines). No doc surgery happens for this effect.
const addChildFrameEffect = StateEffect.define<{ parentId: string; frame: Frame }>();

// reparentFrameEffect — change a frame's parent. newParentId === null promotes
// to top-level (caller must supply absoluteGridRow/Col). newParentId === string
// demotes to child of that frame (gridRow/Col become parent-relative).
// unifiedDocSync handles doc surgery: demote releases claimed lines; promote
// inserts blank claim lines.
const reparentFrameEffect = StateEffect.define<{
  frameId: string;
  newParentId: string | null;
  absoluteGridRow?: number;
  absoluteGridCol?: number;
  charWidth: number;
  charHeight: number;
}>();

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

// relocateFrameEffect — emitted by unifiedDocSync when a drag repositions a
// top-level frame in the CM doc. Updates docOffset to the new claimed-line
// start so framesField stays in sync with the doc change in the same transaction.
const relocateFrameEffect = StateEffect.define<{ id: string; newDocOffset: number }>();

// Mark a frame dirty by id, propagating up to ancestors.
/** Recursively find a frame by id in a frame tree (incl. children). */
function findFrameInList(frames: Frame[], id: string): Frame | null {
  for (const f of frames) {
    if (f.id === id) return f;
    const found = findFrameInList(f.children, id);
    if (found) return found;
  }
  return null;
}

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
    // Remap docOffset on every doc-changing transaction. Use associativity=1
    // so frames follow preceding insertions (Enter-above-wireframe pushes
    // frame down). Also re-runs on undo, where the inverted ChangeSet maps
    // offsets back; restoreFramesEffect (below) overrides this for frame
    // mutations, but pure prose edits land here exclusively.
    if (tr.docChanged) {
      result = result.map((f) =>
        f.lineCount === 0
          ? f
          : { ...f, docOffset: tr.changes.mapPos(f.docOffset, 1) },
      );
    }
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
      } else if (e.is(relocateFrameEffect)) {
        // Update docOffset to the new claimed-line start after drag.
        result = result.map(f =>
          f.id === e.value.id ? { ...f, docOffset: e.value.newDocOffset } : f,
        );
      } else if (e.is(resizeFrameEffect)) {
        const applyResize = (f: Frame): Frame => {
          if (f.id === e.value.id) return resizeFrame(f, { gridW: e.value.gridW, gridH: e.value.gridH }, e.value.charWidth, e.value.charHeight);
          if (f.children.length > 0) return { ...f, children: f.children.map(applyResize) };
          return f;
        };
        result = result.map(applyResize);
        result = markDirtyById(result, e.value.id).frames;
        // Sync lineCount with new gridH for top-level frames that claim doc lines.
        result = result.map(f =>
          f.id === e.value.id && f.lineCount > 0
            ? { ...f, lineCount: Math.max(2, e.value.gridH) }
            : f,
        );
      } else if (e.is(addFrameEffect)) {
        result = [...result, { ...e.value, dirty: true }];
      } else if (e.is(addChildFrameEffect)) {
        // Append the new frame to parentId's children. lineCount is forced
        // to 0 — children never claim doc lines. Parent is marked dirty.
        const child: Frame = { ...e.value.frame, lineCount: 0, docOffset: 0, dirty: true };
        const addToParent = (frames: Frame[]): Frame[] =>
          frames.map(f => {
            if (f.id === e.value.parentId) {
              return { ...f, children: [...f.children, child], dirty: true };
            }
            if (f.children.length > 0) {
              const updated = addToParent(f.children);
              if (updated !== f.children) return { ...f, children: updated };
            }
            return f;
          });
        result = addToParent(result);
      } else if (e.is(reparentFrameEffect)) {
        // Find and remove the frame from its current location.
        let extracted: Frame | null = null;
        const removeAndCapture = (frames: Frame[]): Frame[] => {
          const out: Frame[] = [];
          for (const f of frames) {
            if (f.id === e.value.frameId) { extracted = f; continue; }
            if (f.children.length > 0) {
              out.push({ ...f, children: removeAndCapture(f.children), dirty: true });
            } else {
              out.push(f);
            }
          }
          return out;
        };
        result = removeAndCapture(result);
        if (!extracted) continue;
        const orig: Frame = extracted;
        const cw = e.value.charWidth;
        const ch = e.value.charHeight;
        if (e.value.newParentId === null) {
          // Promote to top-level. Caller must supply absolute coords.
          const aRow = e.value.absoluteGridRow ?? orig.gridRow;
          const aCol = e.value.absoluteGridCol ?? orig.gridCol;
          // Compute docOffset to match unifiedDocSync's insertion point.
          // unifiedDocSync inserts gridH newlines at:
          //   line(min(aRow, oldDoc.lines-1) + 1).from   (in old doc coords)
          // That same character position in the NEW doc is still the start
          // of the inserted blanks (insertion was AT that position).
          const oldLines = tr.startState.doc.lines;
          const targetLineOld = Math.min(Math.max(aRow, 0), oldLines - 1) + 1;
          const docOffset = tr.startState.doc.line(targetLineOld).from;
          // Re-derive aRow from the new doc — clamping in unifiedDocSync may
          // have shifted where the frame actually lands.
          const lineNum = tr.newDoc.lineAt(docOffset).number - 1;
          // Use caller-supplied charWidth/charHeight for pixel coords —
          // dividing orig.w / orig.gridW blows up for line frames whose
          // gridW or gridH can be 0.
          const promoted: Frame = {
            ...orig,
            gridRow: lineNum,
            gridCol: aCol,
            x: aCol * cw,
            y: lineNum * ch,
            lineCount: orig.gridH,
            docOffset,
            dirty: true,
          };
          result = [...result, promoted];
        } else {
          // Demote to child of newParentId. Find parent in current result.
          let parentRef: Frame | null = null;
          const findParent = (frames: Frame[]): void => {
            for (const f of frames) {
              if (f.id === e.value.newParentId) { parentRef = f; return; }
              if (f.children.length > 0) findParent(f.children);
            }
          };
          findParent(result);
          if (!parentRef) {
            // Parent not found — abort, restore frame at top-level to avoid loss.
            result = [...result, orig];
            continue;
          }
          const p: Frame = parentRef;
          // Use caller-supplied absolute coords if available — falling back
          // to orig.gridRow only works when orig was already top-level. For
          // a child being moved to a different parent, orig.gridRow is
          // already parent-relative to the OLD parent, so subtracting the
          // NEW parent's absolute gridRow produces garbage.
          const aRow = e.value.absoluteGridRow ?? orig.gridRow;
          const aCol = e.value.absoluteGridCol ?? orig.gridCol;
          const childGridRow = aRow - p.gridRow;
          const childGridCol = aCol - p.gridCol;
          const child: Frame = {
            ...orig,
            gridRow: childGridRow,
            gridCol: childGridCol,
            // Rebase pixel coords to local-to-parent. The renderer composes
            // child.x with parent.absX; child.x must be the child's offset
            // INSIDE the parent, not its absolute screen position.
            x: childGridCol * cw,
            y: childGridRow * ch,
            lineCount: 0,
            docOffset: 0,
            dirty: true,
          };
          const addToParent = (frames: Frame[]): Frame[] =>
            frames.map(f => {
              if (f.id === e.value.newParentId) {
                return { ...f, children: [...f.children, child], dirty: true };
              }
              if (f.children.length > 0) {
                return { ...f, children: addToParent(f.children) };
              }
              return f;
            });
          result = addToParent(result);
        }
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
    // gridRow sync: for top-level claiming frames (lineCount > 0), gridRow is
    // a CACHE of "what doc line does docOffset land on". moveFrame() updates
    // gridRow blindly by dRow; unifiedDocSync may clamp the doc-side
    // position. The doc is the single source of truth — re-derive gridRow
    // here so the serializer (which reads gridRow) never sees drift.
    // Child frames (lineCount === 0) keep their parent-relative gridRow.
    const docLen = tr.newDoc.length;
    const docLines = tr.newDoc.lines;
    result = result.map(f => {
      if (f.lineCount === 0) return f;
      if (f.docOffset < 0 || f.docOffset > docLen) return f;
      const lineNum = tr.newDoc.lineAt(f.docOffset).number - 1; // 0-indexed
      if (lineNum === f.gridRow) return f;
      // Clamp lineCount so gridRow + lineCount stays within doc.
      const maxLineCount = Math.max(1, docLines - lineNum);
      const lineCount = Math.min(f.lineCount, maxLineCount);
      return { ...f, gridRow: lineNum, lineCount };
    });
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
    // Include restoreFramesEffect so that undo-of-undo (= redo) replays the
    // correct frames: when the undo transaction carries restoreFramesEffect,
    // we snapshot the pre-undo (= post-forward) frames and store them as the
    // "redo effects". This is especially important for drag (Task 12) because
    // the redo transaction has no original effects — only doc changes.
    const hasFrameEffect = tr.effects.some(
      (e) =>
        e.is(moveFrameEffect) ||
        e.is(relocateFrameEffect) ||
        e.is(restoreFramesEffect) ||
        e.is(resizeFrameEffect) ||
        e.is(addFrameEffect) ||
        e.is(addChildFrameEffect) ||
        e.is(reparentFrameEffect) ||
        e.is(deleteFrameEffect) ||
        e.is(setZEffect) ||
        e.is(editTextFrameEffect) ||
        e.is(setTextAlignEffect),
    );
    if (!hasFrameEffect) return [];
    // Capture the frames BEFORE this transaction was applied
    return [restoreFramesEffect.of(tr.startState.field(framesField))];
  });

  // changeFilter: reject user-initiated edits that touch any frame-claimed
  // line range. Programmatic transactions (no userEvent) are bypassed so the
  // mutation transactionFilter (Tasks 10-13) can splice claimed lines on
  // move/resize/delete. Note: when a transactionFilter returns an array of
  // specs, CM merges them via resolveTransaction(state, filtered, false) —
  // the `false` skips re-applying changeFilter, so this is consistent.
  const claimFilter = EditorState.changeFilter.of((tr) => {
    if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) return true;
    const frames = tr.startState.field(framesField);
    if (frames.length === 0) return true;
    const claimed: Array<{ from: number; to: number }> = [];
    const docLen = tr.startState.doc.length;
    for (const f of frames) {
      if (f.lineCount === 0) continue;
      // Defensive: a frame's docOffset is only meaningful in the unified-doc
      // factory. Other factories (the legacy prose-only path) leave docOffset
      // pointing into the longer source text; skip those rather than crash.
      if (f.docOffset < 0 || f.docOffset > docLen) continue;
      const startLine = tr.startState.doc.lineAt(f.docOffset);
      const endLineNum = Math.min(
        startLine.number + f.lineCount - 1,
        tr.startState.doc.lines,
      );
      const endLine = tr.startState.doc.line(endLineNum);
      claimed.push({ from: startLine.from, to: endLine.to });
    }
    let intersects = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      for (const r of claimed) {
        // Pure insertion (fromA === toA) AT a claimed-range boundary is
        // BEFORE the claim (associativity=1 will push the frame forward).
        // Allow these so "Enter at end of prose line above wireframe" works.
        if (fromA === toA && (fromA === r.from || fromA === r.to + 1)) continue;
        if (fromA <= r.to && toA >= r.from) {
          intersects = true;
          break;
        }
      }
    });
    return !intersects;
  });

  // unifiedDocSync: intercept frame mutation effects and add doc changes
  // that keep the CM doc in sync with the frame model. Empty-string lines
  // (per Task 3 audit correction) are inserted/removed as the frame grows
  // or shrinks. When this filter returns an array of specs, CM merges them
  // via resolveTransaction(state, filtered, false), so changeFilter does
  // not re-fire on the merged transaction (programmatic edits go through).
  const unifiedDocSync = EditorState.transactionFilter.of((tr) => {
    for (const e of tr.effects) {
      if (e.is(moveFrameEffect) && e.value.dRow !== 0) {
        const frames = tr.startState.field(framesField);
        const frame = findFrameInList(frames, e.value.id);
        if (!frame || frame.lineCount === 0) continue;

        const doc = tr.startState.doc;
        const startLine = doc.lineAt(frame.docOffset);
        const endLineNum = startLine.number + frame.lineCount - 1;
        if (endLineNum > doc.lines) continue; // claim is malformed; skip
        const endLine = doc.line(endLineNum);

        // Vertical drag = swap newlines at the frame's boundaries.
        // Drag down by 1 = delete \n above frame, insert \n below.
        // Drag up by 1 = inverse. Net char count is 0; the frame's claimed
        // empty lines stay empty; surrounding prose is untouched.
        //
        // For dRow=N, we rotate N newlines across the boundary.

        const dRow = e.value.dRow;
        const changes: Array<{ from: number; to: number; insert?: string }> = [];

        // Count consecutive EMPTY lines around the frame — these are the
        // "rotation budget" that lets the frame move without changing doc
        // length. When motion exceeds the budget, drag-down also INSERTS the
        // deficit as new blank lines below the frame so the frame ends up
        // where the user dropped it (matches Figma-style direct manipulation).
        let maxDown = 0;
        for (let n = endLineNum + 1; n <= doc.lines; n++) {
          const ln = doc.line(n);
          if (ln.length === 0) maxDown++;
          else break;
        }
        let maxUp = 0;
        for (let n = startLine.number - 1; n >= 1; n--) {
          const ln = doc.line(n);
          if (ln.length === 0) maxUp++;
          else break;
        }

        if (dRow > 0) {
          // Drag down by dRow rows.
          // - Rotation: take min(dRow, maxDown) newlines from after the frame
          //   and move them above. Doc length preserved over this part.
          // - Extra: if dRow > maxDown, insert (dRow - maxDown) extra newlines
          //   above the frame. Doc grows. Frame still moves the full dRow.
          const rotateBy = Math.min(dRow, maxDown);
          const extra = dRow - rotateBy;
          const deleteFrom = endLine.to;
          const deleteTo = endLine.to + rotateBy;
          if (deleteTo > doc.length) continue; // defensive
          const insertAtTop = "\n".repeat(rotateBy + extra);
          // Delete `rotateBy` chars after frame, insert `dRow` newlines before.
          if (rotateBy > 0) changes.push({ from: deleteFrom, to: deleteTo });
          if (insertAtTop.length > 0) changes.push({ from: startLine.from, to: startLine.from, insert: insertAtTop });
          if (changes.length === 0) continue;
        } else {
          // Drag up by |dRow|. Symmetric to drag-down's rotation: pull
          // newlines from above, push them below. We do NOT grow the doc on
          // drag-up — pushing prose above off the top of the doc isn't
          // meaningful, so motion clamps to maxUp.
          const n = -dRow;
          const rotateBy = Math.min(n, maxUp);
          if (rotateBy === 0) continue;
          const deleteFrom2 = startLine.from - rotateBy;
          const deleteTo2 = startLine.from;
          if (deleteFrom2 < 0) continue;
          const movedChars = doc.sliceString(deleteFrom2, deleteTo2);
          changes.push({ from: deleteFrom2, to: deleteTo2 });
          changes.push({ from: endLine.to, to: endLine.to, insert: movedChars });
        }

        // newDocOffset for drag-down: dRow newlines are inserted at
        // startLine.from, shifting the frame's start to startLine.from + dRow.
        // For drag-up: rotateBy chars are deleted before startLine, so
        // docOffset shifts to startLine.from - rotateBy.
        const rotateByForOffset = dRow > 0
          ? dRow
          : Math.min(-dRow, maxUp);
        const newDocOffset = dRow > 0
          ? startLine.from + rotateByForOffset
          : startLine.from - rotateByForOffset;
        return [
          {
            effects: [...tr.effects, relocateFrameEffect.of({ id: frame.id, newDocOffset })],
            changes,
          },
        ];
      }
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
          // Insert `delta` empty lines AFTER the current claimed range.
          // Each new line is just "\n" (empty string content).
          const insert = "\n".repeat(delta);
          return [tr, { changes: { from: endLine.to, insert }, sequential: true }];
        } else {
          // Remove `-delta` lines from the end of the claimed range.
          // endLineNum + delta + 1 is the first line to keep at the bottom.
          // Delete from end of (endLineNum + delta) through end of endLine.
          const keepLastNum = endLineNum + delta; // last claimed line we keep
          const keepLast = tr.startState.doc.line(keepLastNum);
          return [tr, { changes: { from: keepLast.to, to: endLine.to }, sequential: true }];
        }
      }
      if (e.is(deleteFrameEffect)) {
        const frames = tr.startState.field(framesField);
        const frame = findFrameInList(frames, e.value.id);
        // Skip child frames (lineCount===0) — they don't claim doc lines.
        if (!frame || frame.lineCount === 0) continue;

        const startLine = tr.startState.doc.lineAt(frame.docOffset);
        const endLineNum = startLine.number + frame.lineCount - 1;
        const endLine = tr.startState.doc.line(endLineNum);
        const docLength = tr.startState.doc.length;

        // Delete exactly ONE newline (the boundary separator), not both.
        // Frame at file start: trailing newline is the only separator → from=0, to=endLine.to + 1
        // Frame elsewhere: leading newline is the separator → from=startLine.from - 1, to=endLine.to
        const from = startLine.from > 0 ? startLine.from - 1 : 0;
        const to = startLine.from > 0 ? endLine.to : Math.min(endLine.to + 1, docLength);
        return [tr, { changes: { from, to }, sequential: true }];
      }
      if (e.is(addFrameEffect)) {
        const newFrame = e.value;
        // Child frames (lineCount===0) don't claim doc lines — skip.
        if (newFrame.lineCount === 0) continue;

        const doc = tr.startState.doc;
        const offset = Math.max(0, Math.min(newFrame.docOffset, doc.length));
        // Insert `lineCount` newlines at `offset`. Each "\n" creates one
        // new empty line. The inserted chars become the claimed blank lines.
        // Empty content (not " ") satisfies preparedCache null fast-path.
        const insert = "\n".repeat(newFrame.lineCount);
        return [tr, { changes: { from: offset, insert }, sequential: true }];
      }
      if (e.is(reparentFrameEffect)) {
        const frames = tr.startState.field(framesField);
        const frame = findFrameInList(frames, e.value.frameId);
        if (!frame) continue;
        const doc = tr.startState.doc;

        if (e.value.newParentId === null) {
          // Promote: insert lineCount blank lines at the absolute target row.
          // Skip if frame was already top-level (lineCount > 0) — nothing to add.
          if (frame.lineCount > 0) continue;
          const aRow = e.value.absoluteGridRow ?? 0;
          const targetLine = Math.min(Math.max(aRow, 0), doc.lines - 1);
          const offset = doc.line(targetLine + 1).from;
          const insert = "\n".repeat(frame.gridH);
          return [tr, { changes: { from: offset, insert }, sequential: true }];
        } else {
          // Demote: release the claimed lines (mirror deleteFrameEffect).
          if (frame.lineCount === 0) continue; // already a child
          const startLine = doc.lineAt(frame.docOffset);
          const endLineNum = startLine.number + frame.lineCount - 1;
          if (endLineNum > doc.lines) continue;
          const endLine = doc.line(endLineNum);
          const docLength = doc.length;
          const from = startLine.from > 0 ? startLine.from - 1 : 0;
          const to = startLine.from > 0 ? endLine.to : Math.min(endLine.to + 1, docLength);
          return [tr, { changes: { from, to }, sequential: true }];
        }
      }
    }
    return tr;
  });

  const extensions: Extension[] = [
    history(),
    frameInversion,
    claimFilter,
    unifiedDocSync,
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
// Legacy path: builds a CM doc with prose only (wireframe lines stripped).
// Frame.docOffset values from scanToFrames refer to the FULL source text,
// not this shrunken prose doc — clear them so the unified-doc claimFilter
// (which sees lineCount=0) treats these frames as non-claiming.
export function createEditorStateFromText(
  text: string,
  charWidth: number,
  charHeight: number,
): EditorState {
  const { frames, proseSegments } = scanToFrames(text, charWidth, charHeight);
  for (const f of frames) { f.docOffset = 0; f.lineCount = 0; }
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

/**
 * Unified document factory — CM doc holds the FULL .md text with claimed
 * (wireframe) lines replaced by empty strings. Frames track which lines they
 * own via docOffset (CM character offset of first claimed line) + lineCount.
 *
 * Empty strings (not " ") are used so preparedCache.ts maps them to the
 * null fast-path and reflowLayout skips them as obstacle-bands instead of
 * generating spurious PositionedLines.
 */
export function createEditorStateUnified(
  text: string,
  charWidth: number,
  charHeight: number,
): EditorState {
  const { frames } = scanToFrames(text, charWidth, charHeight);

  // Build set of source lines claimed by any top-level frame.
  const claimedLines = new Set<number>();
  for (const f of frames) {
    for (let i = f.gridRow; i < f.gridRow + f.gridH; i++) {
      claimedLines.add(i);
    }
  }

  // Build unified doc: prose lines preserved, claimed lines → empty string.
  const sourceLines = text.split("\n");
  const unifiedLines = sourceLines.map((line, i) =>
    claimedLines.has(i) ? "" : line,
  );
  const unifiedText = unifiedLines.join("\n");

  // Recompute docOffset for each frame in the unified doc (line lengths shrank).
  const lineOffsets: number[] = [];
  {
    let offset = 0;
    for (let i = 0; i < unifiedLines.length; i++) {
      lineOffsets.push(offset);
      offset += unifiedLines[i].length + 1;
    }
  }
  for (const f of frames) {
    if (f.gridRow >= 0 && f.gridRow < lineOffsets.length) {
      f.docOffset = lineOffsets[f.gridRow];
    }
  }

  return createEditorState({ prose: unifiedText, frames });
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

/** Find the claimed-line range covering `lineNum` (0-indexed), or null. */
function getClaimedLineRange(
  state: EditorState,
  lineNum: number,
): { start: number; end: number } | null {
  const frames = state.field(framesField);
  for (const f of frames) {
    if (f.lineCount === 0) continue;
    if (f.docOffset < 0 || f.docOffset > state.doc.length) continue;
    const startLine = state.doc.lineAt(f.docOffset).number - 1; // 0-indexed
    const endLine = startLine + f.lineCount - 1;
    if (lineNum >= startLine && lineNum <= endLine) {
      return { start: startLine, end: endLine };
    }
  }
  return null;
}

export function proseMoveUp(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.row === 0) return state;
  let targetRow = cursor.row - 1;
  let claimed = getClaimedLineRange(state, targetRow);
  while (claimed) {
    targetRow = claimed.start - 1;
    if (targetRow < 0) return state;
    claimed = getClaimedLineRange(state, targetRow);
  }
  const prevLine = state.doc.line(targetRow + 1); // 1-indexed
  const prevGraphemes = [...segmenter.segment(prevLine.text)].length;
  return moveCursorTo(state, { row: targetRow, col: Math.min(cursor.col, prevGraphemes) });
}

export function proseMoveDown(state: EditorState): EditorState {
  const cursor = getCursor(state);
  if (!cursor) return state;
  if (cursor.row >= state.doc.lines - 1) return state;
  let targetRow = cursor.row + 1;
  let claimed = getClaimedLineRange(state, targetRow);
  while (claimed) {
    targetRow = claimed.end + 1;
    if (targetRow >= state.doc.lines) return state;
    claimed = getClaimedLineRange(state, targetRow);
  }
  const nextLine = state.doc.line(targetRow + 1); // 1-indexed
  const nextGraphemes = [...segmenter.segment(nextLine.text)].length;
  return moveCursorTo(state, { row: targetRow, col: Math.min(cursor.col, nextGraphemes) });
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

/**
 * Add a top-level (claiming) frame at a UI-derived grid position.
 * Pure helper that owns the docOffset/lineCount derivation so callers
 * (DemoV2 draw-rect handler, tests) don't have to know the unified-doc
 * invariants. Frames added via this path are visible to serializeUnified
 * and trigger unifiedDocSync's empty-line insertion.
 */
export function applyAddTopLevelFrame(
  state: EditorState,
  frame: Frame,
  gridRow: number,
  gridCol: number,
): EditorState {
  // Clamp gridRow into the existing doc — drawing past doc end places the
  // frame at the last line. Padding the doc to honor far-below positions
  // is a UX choice we're explicitly NOT making here; harness rect tests
  // draw within or at the doc tail, so this is sufficient.
  const targetLine = Math.min(Math.max(gridRow, 0), state.doc.lines - 1);
  const docOffset = state.doc.line(targetLine + 1).from; // 1-indexed
  const charWidth = frame.gridW > 0 ? frame.w / frame.gridW : 0;
  const charHeight = frame.gridH > 0 ? frame.h / frame.gridH : 0;
  const prepared: Frame = {
    ...frame,
    x: gridCol * charWidth,
    y: gridRow * charHeight,
    gridRow,
    gridCol,
    docOffset,
    lineCount: frame.gridH,
  };
  return applyAddFrame(state, prepared);
}

/**
 * Add a frame as a child of an existing parent (Figma-style nest-on-draw).
 * Caller-supplied gridRow/gridCol are absolute; helper rebases them
 * parent-relative so children stay visually anchored as parent moves.
 * No doc lines are inserted (children don't claim doc lines).
 */
export function applyAddChildFrame(
  state: EditorState,
  frame: Frame,
  parentId: string,
  absoluteGridRow: number,
  absoluteGridCol: number,
): EditorState {
  const parent = findFrameInList(getFrames(state), parentId);
  if (!parent) return state;
  const charWidth = frame.gridW > 0 ? frame.w / frame.gridW : 0;
  const charHeight = frame.gridH > 0 ? frame.h / frame.gridH : 0;
  const childGridRow = absoluteGridRow - parent.gridRow;
  const childGridCol = absoluteGridCol - parent.gridCol;
  const prepared: Frame = {
    ...frame,
    x: childGridCol * charWidth,
    y: childGridRow * charHeight,
    gridRow: childGridRow,
    gridCol: childGridCol,
    lineCount: 0,
    docOffset: 0,
  };
  return state.update({
    effects: addChildFrameEffect.of({ parentId, frame: prepared }),
    annotations: Transaction.addToHistory.of(true),
  }).state;
}

/**
 * Move a frame to a new parent (Figma drag-into / drag-out semantics).
 * newParentId === null → promote to top-level. absoluteGridRow/Col set
 * the placement and unifiedDocSync inserts blank claim lines.
 * newParentId === string → demote to child. unifiedDocSync releases the
 * frame's currently-claimed doc lines.
 */
export function applyReparentFrame(
  state: EditorState,
  frameId: string,
  newParentId: string | null,
  absoluteGridRow: number,
  absoluteGridCol: number,
  charWidth: number,
  charHeight: number,
): EditorState {
  return state.update({
    effects: reparentFrameEffect.of({
      frameId, newParentId, absoluteGridRow, absoluteGridCol, charWidth, charHeight,
    }),
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
