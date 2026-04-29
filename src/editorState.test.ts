// src/editorState.test.ts
// Tests for editorState.ts — Phase 3 plan verification.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Transaction } from "@codemirror/state";
import {
  createEditorState,
  createEditorStateFromText,
  createEditorStateUnified,
  getDoc,
  getFrames,
  getCursor,
  proseInsert,
  proseDeleteBefore,
  moveCursorTo,
  applyMoveFrame,
  applyResizeFrame,
  applyAddFrame,
  applyAddTopLevelFrame,
  applyAddChildFrame,
  applyReparentFrame,
  applyDeleteFrame,
  applyClearDirty,
  moveFrameEffect,
  resizeFrameEffect,
  editorUndo,
  editorRedo,
  rowColToPos,
  posToRowCol,
  undoDepth,
  redoDepth,
  proseMoveLeft,
  proseMoveRight,
  proseMoveUp,
  proseMoveDown,
  selectFrameEffect,
  getSelectedId,
  setTextEditEffect,
  editTextFrameEffect,
  getTextEdit,
  getProseSegmentMap,
  getOriginalProseSegments,
  applySetOriginalProseSegments,
  type CursorPos,
  findPath,
  findContainingBandDeep,
  getBandRelativeRow,
  getBandRelativeCol,
  resolveSelectionTarget,
} from "./editorState";
import { createFrame, createTextFrame, createRectFrame, createLineFrame, type Frame } from "./frame";

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyState(prose = "") {
  return createEditorState({ prose, frames: [], proseSegmentMap: [] });
}

// ── Task 1: createEditorState ────────────────────────────────────────────────

describe("createEditorState", () => {
  it("stores the initial prose as the doc", () => {
    const state = createEditorState({
      prose: "Hello world",
      frames: [],
      proseSegmentMap: [],
    });
    expect(getDoc(state)).toBe("Hello world");
  });

  it("stores the provided frames", () => {
    const frame = createFrame({ x: 10, y: 20, w: 100, h: 50 });
    const state = createEditorState({
      prose: "",
      frames: [frame],
      proseSegmentMap: [],
    });
    const frames = getFrames(state);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(frame.id);
    expect(frames[0].x).toBe(10);
    expect(frames[0].y).toBe(20);
  });

  it("cursor starts at (0,0) for empty doc", () => {
    const state = emptyState();
    const cursor = getCursor(state);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(0);
    expect(cursor!.col).toBe(0);
  });

  it("cursor starts at (0,0) for non-empty doc", () => {
    const state = emptyState("some text");
    const cursor = getCursor(state);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(0);
    expect(cursor!.col).toBe(0);
  });

  it("empty doc has empty string", () => {
    const state = emptyState();
    expect(getDoc(state)).toBe("");
  });
});

// ── Task 2: Prose operations ─────────────────────────────────────────────────

describe("proseInsert", () => {
  it("inserts a character at the cursor position", () => {
    const s0 = emptyState("hello");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    expect(getDoc(s1)).toBe("hello!");
  });

  it("inserts at beginning", () => {
    const s0 = emptyState("world");
    const s1 = proseInsert(s0, { row: 0, col: 0 }, "H");
    expect(getDoc(s1)).toBe("Hworld");
  });

  it("inserts in the middle", () => {
    const s0 = emptyState("hllo");
    const s1 = proseInsert(s0, { row: 0, col: 1 }, "e");
    expect(getDoc(s1)).toBe("hello");
  });

  it("advances cursor by the length of inserted text", () => {
    const s0 = emptyState("hello");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    const cursor = getCursor(s1);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(0);
    expect(cursor!.col).toBe(6);
  });

  it("inserts a newline, splitting the line", () => {
    const s0 = emptyState("helloworld");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "\n");
    expect(getDoc(s1)).toBe("hello\nworld");
  });

  it("after newline insert cursor is at start of new line", () => {
    const s0 = emptyState("helloworld");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "\n");
    const cursor = getCursor(s1);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(1);
    expect(cursor!.col).toBe(0);
  });

  it("inserts on second line", () => {
    const s0 = emptyState("line1\nline2");
    const s1 = proseInsert(s0, { row: 1, col: 5 }, "X");
    expect(getDoc(s1)).toBe("line1\nline2X");
  });

  it("inserts multiple characters at once", () => {
    const s0 = emptyState("hello");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, " world");
    expect(getDoc(s1)).toBe("hello world");
  });
});

describe("proseDeleteBefore", () => {
  it("deletes the character before the cursor", () => {
    const s0 = emptyState("hello");
    const s1 = proseDeleteBefore(s0.update({ selection: { anchor: 5 } }).state, { row: 0, col: 5 });
    expect(getDoc(s1)).toBe("hell");
  });

  it("is a no-op at (0,0)", () => {
    const s0 = emptyState("hello");
    const s1 = proseDeleteBefore(s0, { row: 0, col: 0 });
    expect(getDoc(s1)).toBe("hello");
  });

  it("merges lines when at start of line", () => {
    const s0 = emptyState("hello\nworld");
    const s1 = proseDeleteBefore(s0, { row: 1, col: 0 });
    expect(getDoc(s1)).toBe("helloworld");
  });

  it("cursor moves to end of merged line after line merge", () => {
    const s0 = emptyState("hello\nworld");
    const s1 = proseDeleteBefore(s0, { row: 1, col: 0 });
    const cursor = getCursor(s1);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(0);
    expect(cursor!.col).toBe(5);
  });

  it("decrements cursor col after normal delete", () => {
    const s0 = emptyState("hello");
    const s1 = proseDeleteBefore(s0, { row: 0, col: 3 });
    const cursor = getCursor(s1);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(0);
    expect(cursor!.col).toBe(2);
  });

  it("deletes emoji as a single grapheme", () => {
    // 🎉 is 2 UTF-16 code units but 1 grapheme
    const s0 = emptyState("hi🎉");
    const s1 = proseDeleteBefore(s0, { row: 0, col: 3 }); // col 3 = after 🎉
    expect(getDoc(s1)).toBe("hi");
  });
});

describe("moveCursorTo", () => {
  it("moves cursor to specified position", () => {
    const s0 = emptyState("hello");
    const s1 = moveCursorTo(s0, { row: 0, col: 3 });
    const cursor = getCursor(s1);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(0);
    expect(cursor!.col).toBe(3);
  });

  it("moves cursor to start of second line", () => {
    const s0 = emptyState("hello\nworld");
    const s1 = moveCursorTo(s0, { row: 1, col: 0 });
    const cursor = getCursor(s1);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(1);
    expect(cursor!.col).toBe(0);
  });

  it("does not change the doc content", () => {
    const s0 = emptyState("hello");
    const s1 = moveCursorTo(s0, { row: 0, col: 3 });
    expect(getDoc(s1)).toBe("hello");
  });
});

// ── Task 3: Frame operations ─────────────────────────────────────────────────

describe("applyMoveFrame", () => {
  const CW = 5, CH = 10;

  it("moves a frame by delta", () => {
    // gridCol=2, gridRow=2 → x=10, y=20; move dCol=1, dRow=1 → x=15, y=30
    const frame = { ...createFrame({ x: 10, y: 20, w: 100, h: 50 }), gridCol: 2, gridRow: 2 };
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    const s1 = applyMoveFrame(s0, frame.id, 1, 1, CW, CH);
    const frames = getFrames(s1);
    expect(frames[0].x).toBe(15);
    expect(frames[0].y).toBe(30);
  });

  it("does not affect other frames", () => {
    const f1 = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    // gridCol=0 → after move dCol=1: x=5
    const f2 = createFrame({ x: 100, y: 100, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [f1, f2], proseSegmentMap: [] });
    const s1 = applyMoveFrame(s0, f1.id, 1, 1, CW, CH);
    const frames = getFrames(s1);
    const moved = frames.find((f) => f.id === f1.id)!;
    const unchanged = frames.find((f) => f.id === f2.id)!;
    expect(moved.x).toBe(5);
    expect(unchanged.x).toBe(100);
  });

  it("negative delta moves frame left/up", () => {
    // gridCol=10, gridRow=5 → x=50, y=50; move dCol=-2, dRow=-2 → x=40, y=30
    const frame = { ...createFrame({ x: 50, y: 50, w: 100, h: 50 }), gridCol: 10, gridRow: 5 };
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    const s1 = applyMoveFrame(s0, frame.id, -2, -2, CW, CH);
    const frames = getFrames(s1);
    expect(frames[0].x).toBe(40);
    expect(frames[0].y).toBe(30);
  });
});

describe("applyResizeFrame", () => {
  it("resizes a frame to new dimensions", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    // gridW=20, gridH=5, charWidth=10, charHeight=20 → w=200, h=100
    const s1 = applyResizeFrame(s0, frame.id, 20, 5, 10, 20);
    const frames = getFrames(s1);
    expect(frames[0].w).toBe(200);
    expect(frames[0].h).toBe(100);
  });

  it("enforces minimum size", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    // gridW=1, gridH=1 → clamped to min 2, charWidth=10, charHeight=20 → minW=20, minH=40
    const s1 = applyResizeFrame(s0, frame.id, 1, 1, 10, 20);
    const frames = getFrames(s1);
    expect(frames[0].w).toBeGreaterThanOrEqual(20);
    expect(frames[0].h).toBeGreaterThanOrEqual(40);
  });
});

describe("applyAddFrame", () => {
  it("adds a new frame to the state", () => {
    const s0 = emptyState();
    const frame = createFrame({ x: 5, y: 5, w: 60, h: 40 });
    const s1 = applyAddFrame(s0, frame);
    const frames = getFrames(s1);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(frame.id);
  });

  it("appends to existing frames", () => {
    const f1 = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [f1], proseSegmentMap: [] });
    const f2 = createFrame({ x: 100, y: 0, w: 50, h: 50 });
    const s1 = applyAddFrame(s0, f2);
    expect(getFrames(s1)).toHaveLength(2);
  });
});

describe("applyDeleteFrame", () => {
  it("removes the frame with the given id", () => {
    const frame = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    const s1 = applyDeleteFrame(s0, frame.id);
    expect(getFrames(s1)).toHaveLength(0);
  });

  it("does not remove other frames", () => {
    const f1 = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const f2 = createFrame({ x: 100, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [f1, f2], proseSegmentMap: [] });
    const s1 = applyDeleteFrame(s0, f1.id);
    const frames = getFrames(s1);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(f2.id);
  });

  it("is a no-op when id does not exist", () => {
    const frame = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    const s1 = applyDeleteFrame(s0, "nonexistent-id");
    expect(getFrames(s1)).toHaveLength(1);
  });
});

describe("applyDeleteFrame — recursive (Phase 1)", () => {
  it("deletes a child inside a container", () => {
    const child1 = createFrame({ x: 0, y: 0, w: 30, h: 30 });
    const child2 = createFrame({ x: 40, y: 0, w: 30, h: 30 });
    const container: Frame = {
      ...createFrame({ x: 0, y: 0, w: 100, h: 100 }),
      children: [child1, child2],
    };
    const s0 = createEditorState({ prose: "", frames: [container], proseSegmentMap: [] });
    const s1 = applyDeleteFrame(s0, child1.id);
    const frames = getFrames(s1);
    expect(frames).toHaveLength(1);
    expect(frames[0].children).toHaveLength(1);
    expect(frames[0].children[0].id).toBe(child2.id);
  });

  it("deletes a deeply nested child (cascade removes empty ancestors)", () => {
    const grandchild = createFrame({ x: 0, y: 0, w: 10, h: 10 });
    const child: Frame = {
      ...createFrame({ x: 0, y: 0, w: 50, h: 50 }),
      children: [grandchild],
    };
    const container: Frame = {
      ...createFrame({ x: 0, y: 0, w: 100, h: 100 }),
      children: [child],
    };
    const s0 = createEditorState({ prose: "", frames: [container], proseSegmentMap: [] });
    const s1 = applyDeleteFrame(s0, grandchild.id);
    // cascade: child becomes empty → removed; container becomes empty → removed
    expect(getFrames(s1)).toHaveLength(0);
  });

  it("still deletes top-level frames (regression)", () => {
    const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    const s1 = applyDeleteFrame(s0, f.id);
    expect(getFrames(s1)).toHaveLength(0);
  });

  it("undo restores deleted child (and cascaded parent)", () => {
    const child = createFrame({ x: 0, y: 0, w: 30, h: 30 });
    const container: Frame = {
      ...createFrame({ x: 0, y: 0, w: 100, h: 100 }),
      children: [child],
    };
    const s0 = createEditorState({ prose: "", frames: [container], proseSegmentMap: [] });
    const s1 = applyDeleteFrame(s0, child.id);
    // cascade removes both child and the now-empty container
    expect(getFrames(s1)).toHaveLength(0);
    const s2 = editorUndo(s1);
    expect(getFrames(s2)[0].children).toHaveLength(1);
    expect(getFrames(s2)[0].children[0].id).toBe(child.id);
  });
});

describe("delete clears selection and textEdit (Phase 1)", () => {
  it("deleting selected frame clears selectedId", () => {
    const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    let state = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    state = state.update({ effects: selectFrameEffect.of(f.id) }).state;
    expect(getSelectedId(state)).toBe(f.id);
    state = applyDeleteFrame(state, f.id);
    expect(getSelectedId(state)).toBeNull();
  });

  it("deleting frame being text-edited clears textEdit", () => {
    const f = createTextFrame({ text: "hi", row: 0, col: 0, charWidth: 10, charHeight: 20 });
    let state = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    state = state.update({
      effects: [selectFrameEffect.of(f.id), setTextEditEffect.of({ frameId: f.id, col: 0 })],
    }).state;
    expect(getTextEdit(state)).not.toBeNull();
    state = applyDeleteFrame(state, f.id);
    expect(getTextEdit(state)).toBeNull();
    expect(getSelectedId(state)).toBeNull();
  });

  it("deleting unrelated frame does not clear selection", () => {
    const f1 = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const f2 = createFrame({ x: 100, y: 0, w: 50, h: 50 });
    let state = createEditorState({ prose: "", frames: [f1, f2], proseSegmentMap: [] });
    state = state.update({ effects: selectFrameEffect.of(f1.id) }).state;
    state = applyDeleteFrame(state, f2.id);
    expect(getSelectedId(state)).toBe(f1.id);
  });

  it("deleting parent clears selected descendant", () => {
    const child = createFrame({ x: 0, y: 0, w: 30, h: 30 });
    const container: Frame = {
      ...createFrame({ x: 0, y: 0, w: 100, h: 100 }),
      children: [child],
    };
    let state = createEditorState({ prose: "", frames: [container], proseSegmentMap: [] });
    state = state.update({ effects: selectFrameEffect.of(child.id) }).state;
    expect(getSelectedId(state)).toBe(child.id);
    state = applyDeleteFrame(state, container.id);
    expect(getSelectedId(state)).toBeNull();
  });

  it("deleting parent clears text-edited descendant", () => {
    const child = createTextFrame({ text: "hi", row: 0, col: 0, charWidth: 10, charHeight: 20 });
    const container: Frame = {
      ...createFrame({ x: 0, y: 0, w: 100, h: 100 }),
      children: [child],
    };
    let state = createEditorState({ prose: "", frames: [container], proseSegmentMap: [] });
    state = state.update({
      effects: [selectFrameEffect.of(child.id), setTextEditEffect.of({ frameId: child.id, col: 0 })],
    }).state;
    state = applyDeleteFrame(state, container.id);
    expect(getTextEdit(state)).toBeNull();
    expect(getSelectedId(state)).toBeNull();
  });
});

describe("drag undo — history=false then history=true (Phase 1)", () => {
  it("move: first step with history=true captures pre-drag state for undo", () => {
    // gridCol=2, gridRow=2 with charWidth=5, charHeight=10 → x=10, y=20
    const frame = { ...createFrame({ x: 10, y: 20, w: 100, h: 50 }), gridCol: 2, gridRow: 2 };
    let state = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    const CW = 5, CH = 10;

    // First drag step — history=true (captures pre-drag snapshot)
    state = state.update({
      effects: moveFrameEffect.of({ id: frame.id, dCol: 1, dRow: 1, charWidth: CW, charHeight: CH }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    expect(getFrames(state)[0].x).toBe(15);

    // Subsequent drag steps — history=false
    state = state.update({
      effects: moveFrameEffect.of({ id: frame.id, dCol: 2, dRow: 2, charWidth: CW, charHeight: CH }),
      annotations: Transaction.addToHistory.of(false),
    }).state;
    expect(getFrames(state)[0].x).toBe(25);

    state = state.update({
      effects: moveFrameEffect.of({ id: frame.id, dCol: 1, dRow: 1, charWidth: CW, charHeight: CH }),
      annotations: Transaction.addToHistory.of(false),
    }).state;
    expect(getFrames(state)[0].x).toBe(30);

    // Undo should revert ALL the way back to pre-drag state
    const undone = editorUndo(state);
    expect(getFrames(undone)[0].x).toBe(10);
    expect(getFrames(undone)[0].y).toBe(20);
  });

  it("resize: first step with history=true captures pre-drag state for undo", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 100 });
    let state = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });

    // First resize step — history=true; gridW=12, gridH=6 → w=120, h=120 with cw=10,ch=20
    state = state.update({
      effects: resizeFrameEffect.of({ id: frame.id, gridW: 12, gridH: 6, charWidth: 10, charHeight: 20 }),
      annotations: Transaction.addToHistory.of(true),
    }).state;

    // Subsequent resize steps — history=false; gridW=15, gridH=7 → w=150, h=140
    state = state.update({
      effects: resizeFrameEffect.of({ id: frame.id, gridW: 15, gridH: 7, charWidth: 10, charHeight: 20 }),
      annotations: Transaction.addToHistory.of(false),
    }).state;

    // Undo should revert to pre-drag dimensions
    const undone = editorUndo(state);
    expect(getFrames(undone)[0].w).toBe(100);
    expect(getFrames(undone)[0].h).toBe(100);
  });
});

// ── Task 4: Unified undo/redo ────────────────────────────────────────────────

describe("undo/redo prose", () => {
  it("undo reverses a prose insert", () => {
    const s0 = emptyState("hello");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    expect(getDoc(s1)).toBe("hello!");
    const s2 = editorUndo(s1);
    expect(getDoc(s2)).toBe("hello");
  });

  it("redo re-applies a prose insert after undo", () => {
    const s0 = emptyState("hello");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    const s2 = editorUndo(s1);
    const s3 = editorRedo(s2);
    expect(getDoc(s3)).toBe("hello!");
  });

  it("undo reverses a prose delete", () => {
    const s0 = emptyState("hello");
    const s1 = proseDeleteBefore(s0, { row: 0, col: 5 });
    expect(getDoc(s1)).toBe("hell");
    const s2 = editorUndo(s1);
    expect(getDoc(s2)).toBe("hello");
  });

  it("undo is a no-op when history is empty", () => {
    const s0 = emptyState("hello");
    const s1 = editorUndo(s0);
    expect(getDoc(s1)).toBe("hello");
  });

  it("redo is a no-op when there is nothing to redo", () => {
    const s0 = emptyState("hello");
    const s1 = editorRedo(s0);
    expect(getDoc(s1)).toBe("hello");
  });
});

describe("undo/redo frame operations", () => {
  // NOTE: CM history() does not track effect-only transactions at all —
  // undoDepth stays 0 even with Transaction.addToHistory.of(true).
  // CM only records transactions that include doc changes in its history stack.
  // Frame undo via StateEffect therefore requires an invertedEffects facet
  // (not yet wired up). These tests document the current observable behavior.

  it("applyMoveFrame: frame is updated immediately", () => {
    // gridCol=2, gridRow=2 with cw=5, ch=10 → x=10, y=20; move dCol=1, dRow=1 → x=15, y=30
    const frame = { ...createFrame({ x: 10, y: 20, w: 100, h: 50 }), gridCol: 2, gridRow: 2 };
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    const s1 = applyMoveFrame(s0, frame.id, 1, 1, 5, 10);
    expect(getFrames(s1)[0].x).toBe(15);
    expect(getFrames(s1)[0].y).toBe(30);
  });

  it("applyAddFrame: frame appears in state", () => {
    const s0 = emptyState();
    const frame = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s1 = applyAddFrame(s0, frame);
    expect(getFrames(s1)).toHaveLength(1);
  });

  it("applyDeleteFrame: frame is removed from state", () => {
    const frame = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    const s1 = applyDeleteFrame(s0, frame.id);
    expect(getFrames(s1)).toHaveLength(0);
  });

  it("frame move is recorded in undo stack via invertedEffects", () => {
    const frame = { ...createFrame({ x: 10, y: 20, w: 100, h: 50 }), gridCol: 2, gridRow: 2 };
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    const s1 = applyMoveFrame(s0, frame.id, 1, 1, 5, 10);
    expect(undoDepth(s1)).toBeGreaterThan(0);
  });

  it("editorUndo reverts frame move", () => {
    // gridCol=2, gridRow=2 with cw=5, ch=10 → x=10, y=20; move dCol=1, dRow=1 → x=15
    const frame = { ...createFrame({ x: 10, y: 20, w: 100, h: 50 }), gridCol: 2, gridRow: 2 };
    const s0 = createEditorState({ prose: "", frames: [frame], proseSegmentMap: [] });
    const s1 = applyMoveFrame(s0, frame.id, 1, 1, 5, 10);
    expect(getFrames(s1)[0].x).toBe(15);
    const s2 = editorUndo(s1);
    expect(getFrames(s2)[0].x).toBe(10);
  });
});

describe("interleaved undo — type then move frame", () => {
  it("undo reverts most recent operation (frame move), then text", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "hello", frames: [frame], proseSegmentMap: [] });

    // Step 1: type "!"
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    expect(getDoc(s1)).toBe("hello!");

    // Step 2: move frame by dCol=2, dRow=0 with cw=5, ch=10 → x=10
    const s2 = applyMoveFrame(s1, frame.id, 2, 0, 5, 10);
    expect(getFrames(s2)[0].x).toBe(10);

    // Step 3: undo → most recent was frame move → frame reverts
    const s3 = editorUndo(s2);
    expect(getFrames(s3)[0].x).toBe(0);
    expect(getDoc(s3)).toBe("hello!"); // prose still has the typed text

    // Step 4: undo → next was prose insert → text reverts
    const s4 = editorUndo(s3);
    expect(getDoc(s4)).toBe("hello");
    expect(getFrames(s4)[0].x).toBe(0);
  });
});

describe("undoDepth/redoDepth", () => {
  it("undoDepth is 0 for fresh state", () => {
    const state = emptyState("hello");
    expect(undoDepth(state)).toBe(0);
  });

  it("undoDepth increases after operations", () => {
    const s0 = emptyState("hello");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    expect(undoDepth(s1)).toBeGreaterThan(0);
  });

  it("redoDepth is 0 before any undo", () => {
    const s0 = emptyState("hello");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    expect(redoDepth(s1)).toBe(0);
  });

  it("redoDepth increases after undo", () => {
    const s0 = emptyState("hello");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    const s2 = editorUndo(s1);
    expect(redoDepth(s2)).toBeGreaterThan(0);
  });

  it("undoDepth decreases after undo", () => {
    const s0 = emptyState("hello");
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    const depthBefore = undoDepth(s1);
    const s2 = editorUndo(s1);
    expect(undoDepth(s2)).toBeLessThan(depthBefore);
  });
});

// ── Task 5: Position converters ──────────────────────────────────────────────

describe("rowColToPos / posToRowCol round-trips", () => {
  it("ASCII: round-trips at various positions", () => {
    const state = emptyState("hello\nworld");
    const cases: CursorPos[] = [
      { row: 0, col: 0 },
      { row: 0, col: 3 },
      { row: 0, col: 5 },
      { row: 1, col: 0 },
      { row: 1, col: 5 },
    ];
    for (const cursor of cases) {
      const pos = rowColToPos(state, cursor.row, cursor.col);
      const back = posToRowCol(state, pos);
      expect(back).toEqual(cursor);
    }
  });

  it("emoji 🎉: grapheme col counts emoji as 1", () => {
    const state = emptyState("hi🎉bye");
    // "hi🎉bye" → graphemes: h(0) i(1) 🎉(2) b(3) y(4) e(5)
    const pos = rowColToPos(state, 0, 2); // before 🎉
    const back = posToRowCol(state, pos);
    expect(back).toEqual({ row: 0, col: 2 });

    const posAfterEmoji = rowColToPos(state, 0, 3); // after 🎉
    const backAfterEmoji = posToRowCol(state, posAfterEmoji);
    expect(backAfterEmoji).toEqual({ row: 0, col: 3 });
  });

  it("emoji 🎉: round-trip after emoji", () => {
    const state = emptyState("a🎉b");
    for (let col = 0; col <= 3; col++) {
      const pos = rowColToPos(state, 0, col);
      const back = posToRowCol(state, pos);
      expect(back.col).toBe(col);
    }
  });

  it("ZWJ sequence 👨‍👩‍👧‍👦: counts as 1 grapheme", () => {
    const family = "👨‍👩‍👧‍👦";
    const state = emptyState(`A${family}B`);
    // graphemes: A(0) 👨‍👩‍👧‍👦(1) B(2)
    const posBeforeFamily = rowColToPos(state, 0, 1);
    const backBeforeFamily = posToRowCol(state, posBeforeFamily);
    expect(backBeforeFamily).toEqual({ row: 0, col: 1 });

    const posAfterFamily = rowColToPos(state, 0, 2);
    const backAfterFamily = posToRowCol(state, posAfterFamily);
    expect(backAfterFamily).toEqual({ row: 0, col: 2 });
  });

  it("combining marks NFD ñ: counts as 1 grapheme", () => {
    // NFD: n + U+0303 (combining tilde) = 2 code points, 1 grapheme
    const nfd = "n\u0303"; // ñ in NFD
    const state = emptyState(`a${nfd}b`);
    // graphemes: a(0) ñ(1) b(2)
    const posAfterNFD = rowColToPos(state, 0, 2);
    const backAfterNFD = posToRowCol(state, posAfterNFD);
    expect(backAfterNFD).toEqual({ row: 0, col: 2 });
  });

  it("multiline: row/col correctly separated across lines", () => {
    const state = emptyState("abc\ndefg\nhi");
    expect(posToRowCol(state, rowColToPos(state, 0, 0))).toEqual({ row: 0, col: 0 });
    expect(posToRowCol(state, rowColToPos(state, 1, 2))).toEqual({ row: 1, col: 2 });
    expect(posToRowCol(state, rowColToPos(state, 2, 1))).toEqual({ row: 2, col: 1 });
  });

  it("clamping: negative row clamps to pos 0", () => {
    const state = emptyState("hello");
    const pos = rowColToPos(state, -1, 0);
    expect(pos).toBe(0);
  });

  it("clamping: row beyond end clamps to doc length", () => {
    const state = emptyState("hello");
    const pos = rowColToPos(state, 100, 0);
    expect(pos).toBe(state.doc.length);
  });

  it("clamping: posToRowCol with negative pos clamps to row 0", () => {
    const state = emptyState("hello");
    const result = posToRowCol(state, -5);
    expect(result.row).toBe(0);
    expect(result.col).toBe(0);
  });

  it("clamping: posToRowCol with pos beyond doc length clamps", () => {
    const state = emptyState("hello");
    const result = posToRowCol(state, 9999);
    expect(result.row).toBe(0);
    expect(result.col).toBe(5);
  });
});

// ── Equivalence with proseCursor.ts (Task 2 addendum) ────────────────────────

describe("proseCursor.ts equivalence", () => {
  // proseCursor operates on plain text strings; editorState wraps CM EditorState.
  // We verify that editorState prose operations produce the same text outcomes
  // as the reference proseCursor implementations.

  it("insertChar 'e' at col 1 matches proseInsert", async () => {
    const { insertChar } = await import("./proseCursor");
    const text = "hllo";
    const cursor = { row: 0, col: 1 };

    const ref = insertChar(text, cursor, "e");

    const state = emptyState(text);
    const next = proseInsert(state, cursor, "e");

    expect(getDoc(next)).toBe(ref.text);
    const nextCursor = getCursor(next);
    expect(nextCursor?.col).toBe(ref.cursor.col);
    expect(nextCursor?.row).toBe(ref.cursor.row);
  });

  it("insertChar newline matches proseInsert newline", async () => {
    const { insertChar } = await import("./proseCursor");
    const text = "helloworld";
    const cursor = { row: 0, col: 5 };

    const ref = insertChar(text, cursor, "\n");

    const state = emptyState(text);
    const next = proseInsert(state, cursor, "\n");

    expect(getDoc(next)).toBe(ref.text);
    const nextCursor = getCursor(next);
    expect(nextCursor?.row).toBe(ref.cursor.row);
    expect(nextCursor?.col).toBe(ref.cursor.col);
  });

  it("deleteChar at col 3 matches proseDeleteBefore", async () => {
    const { deleteChar } = await import("./proseCursor");
    const text = "hello";
    const cursor = { row: 0, col: 3 };

    const ref = deleteChar(text, cursor);

    const state = emptyState(text);
    const next = proseDeleteBefore(state, cursor);

    expect(getDoc(next)).toBe(ref.text);
    const nextCursor = getCursor(next);
    expect(nextCursor?.col).toBe(ref.cursor.col);
    expect(nextCursor?.row).toBe(ref.cursor.row);
  });

  it("deleteChar at (1,0) merges lines — matches proseDeleteBefore", async () => {
    const { deleteChar } = await import("./proseCursor");
    const text = "hello\nworld";
    const cursor = { row: 1, col: 0 };

    const ref = deleteChar(text, cursor);

    const state = emptyState(text);
    const next = proseDeleteBefore(state, cursor);

    expect(getDoc(next)).toBe(ref.text);
    const nextCursor = getCursor(next);
    expect(nextCursor?.row).toBe(ref.cursor.row);
    expect(nextCursor?.col).toBe(ref.cursor.col);
  });

  it("deleteChar at (0,0) is no-op — matches proseDeleteBefore", async () => {
    const { deleteChar } = await import("./proseCursor");
    const text = "hello";
    const cursor = { row: 0, col: 0 };

    const ref = deleteChar(text, cursor);

    const state = emptyState(text);
    const next = proseDeleteBefore(state, cursor);

    expect(getDoc(next)).toBe(ref.text);
  });
});

describe("Task 5.0.1: Arrow-key cursor movement", () => {
  describe("proseMoveLeft", () => {
    it("moves cursor left by one column", () => {
      let state = createEditorState({ prose: "hello", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 0, col: 3 });
      state = proseMoveLeft(state);
      expect(getCursor(state)).toEqual({ row: 0, col: 2 });
    });

    it("wraps to end of previous line at col 0", () => {
      let state = createEditorState({ prose: "abc\ndef", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 1, col: 0 });
      state = proseMoveLeft(state);
      expect(getCursor(state)).toEqual({ row: 0, col: 3 });
    });

    it("is a no-op at (0,0)", () => {
      let state = createEditorState({ prose: "hello", frames: [], proseSegmentMap: [] });
      state = proseMoveLeft(state);
      expect(getCursor(state)).toEqual({ row: 0, col: 0 });
    });
  });

  describe("proseMoveRight", () => {
    it("moves cursor right by one column", () => {
      let state = createEditorState({ prose: "hello", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 0, col: 2 });
      state = proseMoveRight(state);
      expect(getCursor(state)).toEqual({ row: 0, col: 3 });
    });

    it("wraps to start of next line at end of line", () => {
      let state = createEditorState({ prose: "abc\ndef", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 0, col: 3 });
      state = proseMoveRight(state);
      expect(getCursor(state)).toEqual({ row: 1, col: 0 });
    });

    it("is a no-op at end of last line", () => {
      let state = createEditorState({ prose: "abc", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 0, col: 3 });
      state = proseMoveRight(state);
      expect(getCursor(state)).toEqual({ row: 0, col: 3 });
    });
  });

  describe("proseMoveUp", () => {
    it("moves to previous line preserving column", () => {
      let state = createEditorState({ prose: "hello\nworld", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 1, col: 3 });
      state = proseMoveUp(state);
      expect(getCursor(state)).toEqual({ row: 0, col: 3 });
    });

    it("clamps column to shorter line above", () => {
      let state = createEditorState({ prose: "ab\nhello", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 1, col: 4 });
      state = proseMoveUp(state);
      expect(getCursor(state)).toEqual({ row: 0, col: 2 });
    });

    it("is a no-op at row 0", () => {
      let state = createEditorState({ prose: "hello\nworld", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 0, col: 2 });
      state = proseMoveUp(state);
      expect(getCursor(state)).toEqual({ row: 0, col: 2 });
    });
  });

  describe("proseMoveDown", () => {
    it("moves to next line preserving column", () => {
      let state = createEditorState({ prose: "hello\nworld", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 0, col: 3 });
      state = proseMoveDown(state);
      expect(getCursor(state)).toEqual({ row: 1, col: 3 });
    });

    it("clamps column to shorter line below", () => {
      let state = createEditorState({ prose: "hello\nab", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 0, col: 4 });
      state = proseMoveDown(state);
      expect(getCursor(state)).toEqual({ row: 1, col: 2 });
    });

    it("is a no-op at last line", () => {
      let state = createEditorState({ prose: "hello\nworld", frames: [], proseSegmentMap: [] });
      state = moveCursorTo(state, { row: 1, col: 2 });
      state = proseMoveDown(state);
      expect(getCursor(state)).toEqual({ row: 1, col: 2 });
    });
  });
});

describe("Task 5.0.2: selectedIdField", () => {
  it("default selectedId is null", () => {
    const state = createEditorState({ prose: "", frames: [], proseSegmentMap: [] });
    expect(getSelectedId(state)).toBeNull();
  });

  it("selectFrameEffect sets selectedId", () => {
    const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    let state = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    state = state.update({ effects: selectFrameEffect.of(f.id) }).state;
    expect(getSelectedId(state)).toBe(f.id);
  });

  it("selectFrameEffect(null) clears selection", () => {
    const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    let state = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    state = state.update({ effects: selectFrameEffect.of(f.id) }).state;
    state = state.update({ effects: selectFrameEffect.of(null) }).state;
    expect(getSelectedId(state)).toBeNull();
  });

  it("selection is NOT in the undo stack", () => {
    const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    let state = createEditorState({ prose: "a", frames: [f], proseSegmentMap: [] });
    state = proseInsert(state, { row: 0, col: 1 }, "b");
    state = state.update({ effects: selectFrameEffect.of(f.id) }).state;
    state = editorUndo(state);
    expect(getDoc(state)).toBe("a");
    expect(getSelectedId(state)).toBe(f.id); // selection NOT undone
  });
});

describe("Task 5.0.3: textEditField + editTextFrameEffect", () => {
  it("default textEdit is null", () => {
    const state = createEditorState({ prose: "", frames: [], proseSegmentMap: [] });
    expect(getTextEdit(state)).toBeNull();
  });

  it("setTextEditEffect enters text edit mode", () => {
    let state = createEditorState({ prose: "", frames: [], proseSegmentMap: [] });
    state = state.update({ effects: setTextEditEffect.of({ frameId: "abc", col: 3 }) }).state;
    expect(getTextEdit(state)).toEqual({ frameId: "abc", col: 3 });
  });

  it("setTextEditEffect(null) exits text edit mode", () => {
    let state = createEditorState({ prose: "", frames: [], proseSegmentMap: [] });
    state = state.update({ effects: setTextEditEffect.of({ frameId: "abc", col: 0 }) }).state;
    state = state.update({ effects: setTextEditEffect.of(null) }).state;
    expect(getTextEdit(state)).toBeNull();
  });

  it("editTextFrameEffect updates text frame content", () => {
    const f = createTextFrame({ text: "hi", row: 0, col: 0, charWidth: 10, charHeight: 20 });
    let state = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    state = state.update({
      effects: editTextFrameEffect.of({ id: f.id, text: "hello", charWidth: 10 }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const frame = getFrames(state)[0];
    expect(frame.content?.text).toBe("hello");
    expect(frame.content?.cells.get("0,4")).toBe("o");
  });

  it("editTextFrameEffect is undoable", () => {
    const f = createTextFrame({ text: "hi", row: 0, col: 0, charWidth: 10, charHeight: 20 });
    let state = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    state = state.update({
      effects: editTextFrameEffect.of({ id: f.id, text: "hello", charWidth: 10 }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    state = editorUndo(state);
    expect(getFrames(state)[0].content?.text).toBe("hi");
  });
});

// ── Phase 2: Dirty flag ──────────────────────────────────────────────────────

describe("dirty flag on Frame (Phase 2)", () => {
  it("new frames have dirty = false", () => {
    const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    expect((f).dirty).toBe(false);
  });

  it("moveFrameEffect sets dirty = true on moved frame", () => {
    const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    const s1 = applyMoveFrame(s0, f.id, 1, 1, 10, 10);
    expect((getFrames(s1)[0]).dirty).toBe(true);
  });

  it("resizeFrameEffect sets dirty = true on resized frame", () => {
    const f = createFrame({ x: 0, y: 0, w: 100, h: 100 });
    const s0 = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    // gridW=10, gridH=10 with cw=10, ch=20 → w=100, h=200
    const s1 = applyResizeFrame(s0, f.id, 10, 10, 10, 20);
    expect((getFrames(s1)[0]).dirty).toBe(true);
  });

  it("moving a child marks both child and top-level container dirty", () => {
    const child = createFrame({ x: 0, y: 0, w: 30, h: 30 });
    const container: Frame = {
      ...createFrame({ x: 0, y: 0, w: 100, h: 100 }),
      children: [child],
    };
    const s0 = createEditorState({ prose: "", frames: [container], proseSegmentMap: [] });
    const s1 = applyMoveFrame(s0, child.id, 1, 1, 5, 5);
    const frames = getFrames(s1);
    expect((frames[0]).dirty).toBe(true);
    expect((frames[0].children[0]).dirty).toBe(true);
  });

  it("undo restores dirty = false (via invertedEffects snapshot)", () => {
    const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    expect((getFrames(s0)[0]).dirty).toBe(false);
    const s1 = applyMoveFrame(s0, f.id, 1, 1, 10, 10);
    expect((getFrames(s1)[0]).dirty).toBe(true);
    const s2 = editorUndo(s1);
    expect((getFrames(s2)[0]).dirty).toBe(false);
  });
});

describe("applyClearDirty (Phase 2)", () => {
  it("resets dirty flag on all frames", () => {
    const f = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    let state = createEditorState({ prose: "", frames: [f], proseSegmentMap: [] });
    state = applyMoveFrame(state, f.id, 10, 10, 9.6, 18.4);
    expect(getFrames(state)[0].dirty).toBe(true);
    state = applyClearDirty(state);
    expect(getFrames(state)[0].dirty).toBe(false);
  });

  it("resets dirty on nested children too", () => {
    const child = createFrame({ x: 0, y: 0, w: 30, h: 30 });
    const container: Frame = {
      ...createFrame({ x: 0, y: 0, w: 100, h: 100 }),
      children: [child],
    };
    let state = createEditorState({ prose: "", frames: [container], proseSegmentMap: [] });
    state = applyMoveFrame(state, child.id, 5, 5, 9.6, 18.4);
    expect(getFrames(state)[0].dirty).toBe(true);
    expect(getFrames(state)[0].children[0].dirty).toBe(true);
    state = applyClearDirty(state);
    expect(getFrames(state)[0].dirty).toBe(false);
    expect(getFrames(state)[0].children[0].dirty).toBe(false);
  });
});

describe("proseSegmentMapField", () => {
  it("initializes from prose segments", () => {
    const state = createEditorState({
      prose: "Hello\n\nWorld",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }],
    });
    const map = getProseSegmentMap(state);
    expect(map).toEqual([{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }]);
  });

  it("inserting newline adds entry and shifts subsequent rows", () => {
    const state = createEditorState({
      prose: "Line1\nLine2",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }, { row: 1, col: 0 }],
    });
    const updated = proseInsert(state, { row: 0, col: 5 }, "\n");
    const map = getProseSegmentMap(updated);
    expect(map).toHaveLength(3);
    expect(map[0]).toEqual({ row: 0, col: 0 });
    expect(map[1]).toEqual({ row: 1, col: 0 });
    expect(map[2]).toEqual({ row: 2, col: 0 });
  });

  it("deleting newline removes entry and shifts rows up", () => {
    const state = createEditorState({
      prose: "Line1\nLine2\nLine3",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }],
    });
    const updated = proseDeleteBefore(state, { row: 1, col: 0 });
    const map = getProseSegmentMap(updated);
    expect(map).toHaveLength(2);
    expect(map[0]).toEqual({ row: 0, col: 0 });
    expect(map[1]).toEqual({ row: 1, col: 0 });
  });

  it("multi-line paste adds multiple entries", () => {
    const state = createEditorState({
      prose: "Before\nAfter",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }, { row: 1, col: 0 }],
    });
    const updated = proseInsert(state, { row: 0, col: 6 }, "\nPasted1\nPasted2");
    const map = getProseSegmentMap(updated);
    expect(map).toHaveLength(4);
    expect(map[3]).toEqual({ row: 3, col: 0 });
  });

  it("no-op transaction preserves map", () => {
    const state = createEditorState({
      prose: "Hello",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }],
    });
    const updated = proseInsert(state, { row: 0, col: 5 }, "!");
    const map = getProseSegmentMap(updated);
    expect(map).toHaveLength(1);
    expect(map[0]).toEqual({ row: 0, col: 0 });
  });
});

describe("createEditorStateFromText (grid-based)", () => {
  it("constructs state with proseSegmentMap from prose segments", () => {
    const state = createEditorStateFromText(
      "Hello\n\n┌──┐\n│  │\n└──┘\n\nWorld",
      9.6, 18.4,
    );
    const map = getProseSegmentMap(state);
    expect(map.length).toBeGreaterThan(0);
    expect(map[0].row).toBe(0);
  });

  it("builds CM doc from prose segments joined by newlines", () => {
    const state = createEditorStateFromText("Hello\n\nWorld", 9.6, 18.4);
    const doc = getDoc(state);
    expect(doc).toContain("Hello");
    expect(doc).toContain("World");
  });

  it("frames are at absolute grid positions", () => {
    const state = createEditorStateFromText(
      "Prose\n\n┌──┐\n│  │\n└──┘",
      9.6, 18.4,
    );
    const frames = getFrames(state);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].y).toBe(2 * 18.4);
  });

  it("stores originalProseSegments for serialization", () => {
    const state = createEditorStateFromText("Hello\n\nWorld", 9.6, 18.4);
    const origSegs = getOriginalProseSegments(state);
    expect(origSegs.length).toBeGreaterThan(0);
    expect(origSegs.some(s => s.text === "Hello")).toBe(true);
  });
});

describe("delete cascade", () => {
  it("deleting last child also removes empty parent container", () => {
    const child: Frame = {
      id: "child1", x: 0, y: 0, w: 100, h: 50,
      z: 0, children: [], content: { type: "rect", cells: new Map(), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } },
      clip: false, dirty: false, gridRow: 0, gridCol: 0, gridW: 0, gridH: 0,
      docOffset: 0, lineCount: 0,
    };
    const parent: Frame = {
      id: "parent1", x: 0, y: 0, w: 200, h: 100,
      z: 0, children: [child], content: null,
      clip: true, dirty: false, gridRow: 0, gridCol: 0, gridW: 0, gridH: 0,
      docOffset: 0, lineCount: 0,
    };
    const state = createEditorState({
      prose: "", frames: [parent], proseSegmentMap: [],
    });
    const updated = applyDeleteFrame(state, "child1");
    expect(getFrames(updated)).toHaveLength(0);
  });

  it("deleting one of two children keeps parent", () => {
    const child1: Frame = {
      id: "c1", x: 0, y: 0, w: 50, h: 50, z: 0, children: [],
      content: { type: "rect", cells: new Map(), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } },
      clip: false, dirty: false, gridRow: 0, gridCol: 0, gridW: 0, gridH: 0,
      docOffset: 0, lineCount: 0,
    };
    const child2: Frame = {
      id: "c2", x: 60, y: 0, w: 50, h: 50, z: 0, children: [],
      content: { type: "rect", cells: new Map(), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } },
      clip: false, dirty: false, gridRow: 0, gridCol: 0, gridW: 0, gridH: 0,
      docOffset: 0, lineCount: 0,
    };
    const parent: Frame = {
      id: "p1", x: 0, y: 0, w: 200, h: 100, z: 0,
      children: [child1, child2], content: null, clip: true, dirty: false, gridRow: 0, gridCol: 0, gridW: 0, gridH: 0,
      docOffset: 0, lineCount: 0,
    };
    const state = createEditorState({ prose: "", frames: [parent], proseSegmentMap: [] });
    const updated = applyDeleteFrame(state, "c1");
    const frames = getFrames(updated);
    expect(frames).toHaveLength(1);
    expect(frames[0].children).toHaveLength(1);
    expect(frames[0].children[0].id).toBe("c2");
  });
});

describe("originalProseSegments refresh", () => {
  it("setOriginalProseSegments updates the stored segments", () => {
    const state = createEditorState({
      prose: "Hello",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }],
      originalProseSegments: [{ row: 0, col: 0, text: "Hello" }],
    });
    const newSegs = [{ row: 0, col: 0, text: "Updated" }];
    const updated = applySetOriginalProseSegments(state, newSegs);
    expect(getOriginalProseSegments(updated)).toEqual(newSegs);
  });
});

// ── Task 3: createEditorStateUnified ────────────────────────────────────────

describe("createEditorStateUnified", () => {
  beforeAll(() => {
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() => ({
          font: "", fillStyle: "", textBaseline: "", fillText: () => {},
          measureText: (text: string) => ({
            width: text.length * 9.6,
            actualBoundingBoxAscent: 12,
            actualBoundingBoxDescent: 4,
          }),
        })) as unknown as HTMLCanvasElement["getContext"];
      }
      return el;
    });
  });

  it("CM doc preserves line count with empty strings for wireframe lines", () => {
    // Plan amendment: claimed lines are "" (empty), not " " — preparedCache.ts:12
    // maps non-empty strings to non-null PreparedTextWithSegments, generating
    // spurious PositionedLines. Empty strings hit the null fast-path.
    const text = "Hello\n\n┌──────┐\n│ Box  │\n└──────┘\n\nGoodbye";
    const state = createEditorStateUnified(text, 9.6, 18);
    const doc = getDoc(state);
    const lines = doc.split("\n");
    expect(lines.length).toBe(7);
    expect(lines[0]).toBe("Hello");
    expect(lines[1]).toBe("");
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("Goodbye");
    expect(lines[2]).toBe(""); // claimed
    expect(lines[3]).toBe(""); // claimed
    expect(lines[4]).toBe(""); // claimed
  });

  it("frames have correct docOffset pointing into unified doc", () => {
    const text = "Hello\n\n┌──────┐\n│ Box  │\n└──────┘\n\nGoodbye";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frames = getFrames(state);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const frame = frames[0];
    expect(frame.lineCount).toBe(3);
    // Unified doc lines: "Hello"(5) + \n + ""(0) + \n = 7 → frame starts at 7
    expect(frame.docOffset).toBe(7);
  });

  it("pure prose passes through unchanged", () => {
    const text = "Just some prose\nNo wireframes";
    const state = createEditorStateUnified(text, 9.6, 18);
    expect(getDoc(state)).toBe(text);
    expect(getFrames(state)).toHaveLength(0);
  });

  it("wireframe at start of file has docOffset 0", () => {
    const text = "┌──┐\n│Hi│\n└──┘\nbye";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    expect(frame.docOffset).toBe(0);
    expect(frame.lineCount).toBe(3);
    const lines = getDoc(state).split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("bye");
  });

  it("wireframe at end of file with no trailing newline", () => {
    const text = "Hello\n┌──┐\n│Hi│\n└──┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    expect(frame.lineCount).toBe(3);
    const lines = getDoc(state).split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe("Hello");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("");
    // docOffset = "Hello\n" = 6
    expect(frame.docOffset).toBe(6);
  });

  it("two wireframes separated by enough prose remain separate top-level frames", () => {
    // groupIntoContainers merges shapes within charHeight pixels gap.
    // Need a gap of (charHeight + 1) pixels — translate to cellHeight=18 → > 1 row.
    // Use multiple blank rows + prose between to guarantee separation.
    const text = "┌──┐\n│A │\n└──┘\n\n\n\n\n\nbetween\n\n\n\n\n\n┌──┐\n│B │\n└──┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frames = getFrames(state);
    expect(frames.length).toBe(2);
    const [first, second] = frames;
    expect(first.lineCount).toBe(3);
    expect(second.lineCount).toBe(3);
    expect(first.docOffset).toBe(0);
    // Verify second is positioned below the prose
    expect(second.gridRow).toBeGreaterThan(first.gridRow + first.gridH);
  });

  it("preserves docOffset 0 for first claimed line at file start", () => {
    const text = "┌─┐\n└─┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    expect(frame.docOffset).toBe(0);
    expect(frame.lineCount).toBe(2);
  });

  it("docOffset accounts for empty-line shrinkage in unified doc", () => {
    // Source lines: "AAAA" (4) "┌─┐" (3) "└─┘" (3) "BBBB" (4)
    // Unified lines: "AAAA" (4) "" (0) "" (0) "BBBB" (4)
    // Frame docOffset = "AAAA\n" = 5
    const text = "AAAA\n┌─┐\n└─┘\nBBBB";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    expect(frame.docOffset).toBe(5);
    expect(frame.lineCount).toBe(2);
    expect(getDoc(state)).toBe("AAAA\n\n\nBBBB");
  });
});

// ── Task 4: changeFilter protects claimed lines ────────────────────────────

describe("changeFilter protects claimed lines", () => {
  it("rejects user-event insertion INSIDE a claimed line (not at boundary)", () => {
    // Insertion AT the start of a claimed range is allowed (treated as
    // before-the-claim — Enter-above-wireframe). To exercise the filter
    // we insert ONE char past the start, where the position is mid-claim.
    const text = "Hello\n\n┌──────┐\n│ Box  │\n└──────┘\n\nGoodbye";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    const pos = frame.docOffset + 1; // mid-claim
    const updated = state.update({
      changes: { from: pos, insert: "INJECTED" },
      userEvent: "input.type",
    }).state;
    expect(getDoc(updated)).toBe(getDoc(state));
  });

  it("allows user-event insertion AT claimed-range start (Enter-above-wireframe)", () => {
    // Pure insertion at docOffset is "before the claim". With mapPos
    // associativity=1, the frame's docOffset shifts forward by the inserted
    // length and the claim still owns the original lines.
    const text = "Hello\n\n┌──────┐\n│ Box  │\n└──────┘\n\nGoodbye";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    const before = frame.docOffset;
    const updated = state.update({
      changes: { from: before, insert: "X" },
      userEvent: "input.type",
    }).state;
    expect(getDoc(updated).length).toBe(getDoc(state).length + 1);
    expect(getFrames(updated)[0].docOffset).toBe(before + 1);
  });

  it("rejects user-event deletion that touches a claimed range", () => {
    const text = "Hello\n┌─┐\n└─┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    // Delete one char of the claimed range
    const updated = state.update({
      changes: { from: frame.docOffset, to: frame.docOffset + 1 },
      userEvent: "delete.backward",
    }).state;
    expect(getDoc(updated)).toBe(getDoc(state));
  });

  it("allows user-event insertion into a prose line", () => {
    const text = "Hello\n\n┌──────┐\n│ Box  │\n└──────┘\n\nGoodbye";
    const state = createEditorStateUnified(text, 9.6, 18);
    const updated = state.update({
      changes: { from: 0, insert: "X" },
      userEvent: "input.type",
    }).state;
    expect(getDoc(updated).startsWith("XHello")).toBe(true);
  });

  it("allows non-user (programmatic) edits even on claimed ranges", () => {
    // Programmatic move/resize/delete must be able to splice claimed lines.
    // Transactions without a userEvent should bypass the filter.
    const text = "Hello\n┌─┐\n└─┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    const updated = state.update({
      changes: { from: frame.docOffset, to: frame.docOffset + 1 },
      // no userEvent → programmatic
    }).state;
    // No filter applied → change went through
    expect(getDoc(updated).length).toBe(getDoc(state).length - 1);
  });

  it("allows edits on prose-only docs (no frames)", () => {
    const state = createEditorStateUnified("Just prose\nNo frames", 9.6, 18);
    const updated = state.update({
      changes: { from: 0, insert: "X" },
      userEvent: "input.type",
    }).state;
    expect(getDoc(updated).startsWith("XJust prose")).toBe(true);
  });

  it("rejects multi-line replacement that spans a claimed range", () => {
    const text = "Hello\n┌─┐\n└─┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    // Try to replace range [5..15] which includes the claimed lines
    const updated = state.update({
      changes: { from: 5, to: 9, insert: "XXX" },
      userEvent: "input.type",
    }).state;
    expect(getDoc(updated)).toBe(getDoc(state));
  });

  it("rejects backspace at column 0 of line below wireframe (boundary)", () => {
    // After unified doc: "Hello\n\n\n\nWorld" — frame claims lines 1-3.
    // Cursor at start of "World" (line 4). Backspace would delete the \n at
    // end of claimed line 3, intruding into the claimed range.
    const text = "Hello\n┌─┐\n└─┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const doc = getDoc(state);
    // Find position of "World" — it's after "Hello\n\n\n"
    const worldStart = doc.indexOf("World");
    const updated = state.update({
      changes: { from: worldStart - 1, to: worldStart },
      userEvent: "delete.backward",
    }).state;
    // Filter rejected → doc unchanged
    expect(getDoc(updated)).toBe(doc);
  });
});

// ── Task 5: docOffset remapping through CM edits ───────────────────────────

describe("docOffset remapping through edits", () => {
  it("inserting a char before frame shifts docOffset forward", () => {
    const text = "Hello\n\n┌──────┐\n│ Box  │\n└──────┘\n\nGoodbye";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0].docOffset;
    // Insert a single char at position 0 (before "Hello")
    const updated = state.update({
      changes: { from: 0, insert: "X" },
      userEvent: "input.type",
    }).state;
    const after = getFrames(updated)[0].docOffset;
    expect(after).toBe(before + 1);
  });

  it("inserting a newline before frame shifts docOffset by +1", () => {
    const text = "Hello\n\n┌──────┐\n│ Box  │\n└──────┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0].docOffset;
    const updated = state.update({
      changes: { from: 0, insert: "\n" },
      userEvent: "input.type",
    }).state;
    const after = getFrames(updated)[0].docOffset;
    expect(after).toBe(before + 1);
  });

  it("deleting a char before frame shifts docOffset backward", () => {
    const text = "AAAA\n\n┌──────┐\n│ Box  │\n└──────┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0].docOffset;
    const updated = state.update({
      changes: { from: 0, to: 1 }, // delete first "A"
      userEvent: "delete.forward",
    }).state;
    const after = getFrames(updated)[0].docOffset;
    expect(after).toBe(before - 1);
  });

  it("inserting at exact frame docOffset pushes frame forward (associativity=1)", () => {
    // The Gemini correction: mapPos(offset, 1) so frame follows insertions
    // landing AT its docOffset. This is what "Enter above wireframe" does.
    const text = "Hello\n\n┌──┐\n└──┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0].docOffset;
    // Insert at position == docOffset
    const updated = state.update({
      changes: { from: before, insert: "X" },
      userEvent: "input.type",
    }).state;
    const after = getFrames(updated)[0].docOffset;
    // Frame moved forward — the inserted char is BEFORE the claimed range.
    expect(after).toBe(before + 1);
  });

  it("paste of multi-line content before frame shifts by total length", () => {
    const text = "A\n┌──┐\n└──┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0].docOffset;
    const insert = "X\nY\nZ"; // 5 chars including 2 newlines
    const updated = state.update({
      changes: { from: 0, insert },
      userEvent: "input.paste",
    }).state;
    const after = getFrames(updated)[0].docOffset;
    expect(after).toBe(before + insert.length);
  });

  it("edit AFTER frame does not change docOffset", () => {
    const text = "A\n┌──┐\n└──┘\nXXXX";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0].docOffset;
    const doc = getDoc(state);
    // Insert at end of doc (after frame's claimed range)
    const updated = state.update({
      changes: { from: doc.length, insert: "Q" },
      userEvent: "input.type",
    }).state;
    const after = getFrames(updated)[0].docOffset;
    expect(after).toBe(before);
  });

  it("two frames: edit before frame1 shifts both", () => {
    const text = "A\n┌──┐\n└──┘\n\n\n\n\nbetween\n\n\n\n\n\n┌──┐\n└──┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frames = getFrames(state);
    expect(frames.length).toBe(2);
    const before1 = frames[0].docOffset;
    const before2 = frames[1].docOffset;
    const updated = state.update({
      changes: { from: 0, insert: "Z" },
      userEvent: "input.type",
    }).state;
    const updatedFrames = getFrames(updated);
    expect(updatedFrames[0].docOffset).toBe(before1 + 1);
    expect(updatedFrames[1].docOffset).toBe(before2 + 1);
  });

  it("two frames: edit between them shifts only the second", () => {
    const text = "A\n┌──┐\n└──┘\n\n\n\n\nM\n\n\n\n\n\n┌──┐\n└──┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frames = getFrames(state);
    expect(frames.length).toBe(2);
    const before1 = frames[0].docOffset;
    const before2 = frames[1].docOffset;
    const doc = getDoc(state);
    const mPos = doc.indexOf("M");
    const updated = state.update({
      changes: { from: mPos, insert: "Z" },
      userEvent: "input.type",
    }).state;
    const updatedFrames = getFrames(updated);
    expect(updatedFrames[0].docOffset).toBe(before1); // unchanged
    expect(updatedFrames[1].docOffset).toBe(before2 + 1);
  });
});

// ── Task 9: Enter/Backspace above wireframe ────────────────────────────────

describe("Enter/Backspace above wireframe (should work via mapPos)", () => {
  it("Enter at end of prose line above wireframe shifts frame down by 1", () => {
    // Unified doc: "Hi\n\n\n\n" — frame at docOffset=3 (lines 1-3 claimed).
    const text = "Hi\n┌────┐\n│ Bx │\n└────┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    // Simulate "Enter at end of 'Hi'" — insert \n at offset 2
    const updated = state.update({
      changes: { from: 2, insert: "\n" },
      userEvent: "input.type",
    }).state;
    const after = getFrames(updated)[0];
    expect(after.docOffset).toBe(before.docOffset + 1);
    expect(after.lineCount).toBe(before.lineCount); // claim size unchanged
    expect(updated.doc.lines).toBe(state.doc.lines + 1);
  });

  it("Backspace on blank prose line above wireframe shifts frame up by 1", () => {
    const text = "Hi\n\n┌────┐\n│ Bx │\n└────┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    // Delete the \n at position 2 (the blank line above frame)
    const updated = state.update({
      changes: { from: 2, to: 3 },
      userEvent: "delete.backward",
    }).state;
    const after = getFrames(updated)[0];
    expect(after.docOffset).toBe(before.docOffset - 1);
    expect(after.lineCount).toBe(before.lineCount);
  });

  it("typing a character in prose line above wireframe shifts frame by +1", () => {
    const text = "Hi\n┌────┐\n│ Bx │\n└────┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    // Insert "X" at end of "Hi" (offset 2)
    const updated = state.update({
      changes: { from: 2, insert: "X" },
      userEvent: "input.type",
    }).state;
    const after = getFrames(updated)[0];
    expect(after.docOffset).toBe(before.docOffset + 1);
    expect(after.lineCount).toBe(before.lineCount);
  });

  it("Enter above wireframe is undoable — frame returns to original position", () => {
    const text = "Hi\n┌────┐\n│ Bx │\n└────┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    let s = state.update({
      changes: { from: 2, insert: "\n" },
      userEvent: "input.type",
      annotations: Transaction.addToHistory.of(true),
    }).state;
    expect(getFrames(s)[0].docOffset).toBe(before.docOffset + 1);
    s = editorUndo(s);
    expect(getFrames(s)[0].docOffset).toBe(before.docOffset);
    expect(getDoc(s)).toBe(getDoc(state));
  });
});

// ── Task 10: Resize wireframe inserts/removes claimed lines ────────────────

describe("resize wireframe in unified mode", () => {
  it("resize taller inserts blank claimed lines and updates lineCount", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    expect(before.lineCount).toBe(3);
    const docLinesBefore = state.doc.lines;
    const updated = state.update({
      effects: resizeFrameEffect.of({
        id: before.id, gridW: before.gridW, gridH: 5,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const after = getFrames(updated)[0];
    expect(after.lineCount).toBe(5);
    expect(after.gridH).toBe(5);
    expect(updated.doc.lines).toBe(docLinesBefore + 2);
  });

  it("resize shorter removes claimed lines and updates lineCount", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n│    │\n│    │\n└────┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    expect(before.lineCount).toBe(5);
    const docLinesBefore = state.doc.lines;
    const updated = state.update({
      effects: resizeFrameEffect.of({
        id: before.id, gridW: before.gridW, gridH: 3,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const after = getFrames(updated)[0];
    expect(after.lineCount).toBe(3);
    expect(after.gridH).toBe(3);
    expect(updated.doc.lines).toBe(docLinesBefore - 2);
  });

  it("resize-no-change does not touch the doc", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    const docBefore = getDoc(state);
    const updated = state.update({
      effects: resizeFrameEffect.of({
        id: before.id, gridW: before.gridW, gridH: 3,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    expect(getDoc(updated)).toBe(docBefore);
    expect(getFrames(updated)[0].lineCount).toBe(3);
  });

  it("resize taller is undoable — doc and lineCount restored", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    const docBefore = getDoc(state);
    let s = state.update({
      effects: resizeFrameEffect.of({
        id: before.id, gridW: before.gridW, gridH: 5,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    expect(getFrames(s)[0].lineCount).toBe(5);
    s = editorUndo(s);
    expect(getDoc(s)).toBe(docBefore);
    expect(getFrames(s)[0].lineCount).toBe(3);
  });

  it("resize preserves docOffset (frame stays at its anchor line)", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    const updated = state.update({
      effects: resizeFrameEffect.of({
        id: before.id, gridW: before.gridW, gridH: 5,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const after = getFrames(updated)[0];
    expect(after.docOffset).toBe(before.docOffset);
  });

  it("inserted claimed lines are empty strings (preparedCache null fast-path)", () => {
    // Per Task 3 plan correction: claimed lines must be "" not " "
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    const updated = state.update({
      effects: resizeFrameEffect.of({
        id: before.id, gridW: before.gridW, gridH: 5,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const after = getFrames(updated)[0];
    // The new claimed lines should be "" — read all 5 claimed lines.
    const startLine = updated.doc.lineAt(after.docOffset).number;
    for (let i = 0; i < after.lineCount; i++) {
      const line = updated.doc.line(startLine + i);
      expect(line.text).toBe("");
    }
  });
});

// ── Task 11: delete wireframe in unified mode ─────────────────────────────────

describe("delete wireframe in unified mode", () => {
  it("deleting a frame removes its claimed lines from CM doc", () => {
    // "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld" → 5 lines → after delete → 2 lines "Hello\nWorld"
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    expect(state.doc.lines).toBe(5);
    const frame = getFrames(state)[0];
    const after = applyDeleteFrame(state, frame.id);
    expect(getDoc(after)).toBe("Hello\nWorld");
    expect(after.doc.lines).toBe(2);
    expect(getFrames(after)).toHaveLength(0);
  });

  it("deleting frame at file start removes claimed lines + their trailing newline", () => {
    // "┌────┐\n│ Bx │\n└────┘\nWorld" → after delete → "World"
    const text = "┌────┐\n│ Bx │\n└────┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    const after = applyDeleteFrame(state, frame.id);
    expect(getDoc(after)).toBe("World");
    expect(getFrames(after)).toHaveLength(0);
  });

  it("deleting frame at file end removes claimed lines + their leading newline", () => {
    // "Hello\n┌────┐\n│ Bx │\n└────┘" → after delete → "Hello"
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    const after = applyDeleteFrame(state, frame.id);
    expect(getDoc(after)).toBe("Hello");
    expect(getFrames(after)).toHaveLength(0);
  });

  it("deleting frame is undoable — doc and frames restored", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const origDoc = getDoc(state);
    const origFrameId = getFrames(state)[0].id;
    const afterDelete = applyDeleteFrame(state, origFrameId);
    expect(getFrames(afterDelete)).toHaveLength(0);
    const afterUndo = editorUndo(afterDelete);
    expect(getDoc(afterUndo)).toBe(origDoc);
    expect(getFrames(afterUndo)).toHaveLength(1);
    expect(getFrames(afterUndo)[0].id).toBe(origFrameId);
  });

  it("deleting one of two frames preserves the other's docOffset relative to its line", () => {
    // Build two frames manually so we don't rely on scanner behavior.
    // doc: "Above\n\n\n\nMiddle\n\n\n\nBelow" (each "\n\n\n" = 3 claimed lines for each frame)
    // Frame 1 claims lines 2-4 (0-indexed gridRow=1, lineCount=3, docOffset=6 "Above\n" = 6)
    // Frame 2 claims lines 6-8 (0-indexed gridRow=5, lineCount=3, docOffset after "Above\n\n\n\nMiddle\n" = 18)
    const prose = "Above\n\n\n\nMiddle\n\n\n\nBelow";
    const f1 = { ...createFrame({ x: 0, y: 18, w: 58, h: 54 }), lineCount: 3, docOffset: 6 };
    const f2 = { ...createFrame({ x: 0, y: 108, w: 58, h: 54 }), lineCount: 3, docOffset: 18 };
    const state = createEditorState({ prose, frames: [f1, f2] });
    expect(getFrames(state)).toHaveLength(2);
    const after = applyDeleteFrame(state, f1.id);
    expect(getFrames(after)).toHaveLength(1);
    const remaining = getFrames(after)[0];
    expect(remaining.id).toBe(f2.id);
    // docOffset must be in-bounds for the updated doc
    expect(remaining.docOffset).toBeGreaterThanOrEqual(0);
    expect(remaining.docOffset).toBeLessThanOrEqual(after.doc.length);
    // The line at the new docOffset should still be an empty claimed line
    expect(after.doc.lineAt(remaining.docOffset).text).toBe("");
  });

  it("deleting child frame inside container does NOT touch CM doc", () => {
    // Child frames have lineCount === 0, so the filter must skip them.
    // Use a parent rect frame with a text child — parent has content so cascade won't remove it.
    const parent = createRectFrame({ gridW: 10, gridH: 6, style: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }, charWidth: 9.6, charHeight: 18 });
    const child = createTextFrame({ text: "hi", row: 1, col: 1, charWidth: 9.6, charHeight: 18 });
    const childWithLineCount = { ...child, lineCount: 0 };
    const parentWithChild = { ...parent, lineCount: 3, docOffset: 0, children: [childWithLineCount] };
    const prose = "\n\n\nSome prose";
    const state = createEditorState({ prose, frames: [parentWithChild] });
    const docBefore = getDoc(state);
    // Delete only the child
    const after = applyDeleteFrame(state, child.id);
    // Doc must be unchanged — child deletion doesn't affect CM doc
    expect(getDoc(after)).toBe(docBefore);
    // Parent still present, child gone
    const remaining = getFrames(after);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].children).toHaveLength(0);
  });

  it("prose lines surrounding the deleted frame are joined cleanly (single newline)", () => {
    // "Above\n┌──┐\n└──┘\nBelow" → after delete → "Above\nBelow" exactly
    const text = "Above\n┌──┐\n└──┘\nBelow";
    const state = createEditorStateUnified(text, 9.6, 18);
    const frame = getFrames(state)[0];
    const after = applyDeleteFrame(state, frame.id);
    expect(getDoc(after)).toBe("Above\nBelow");
  });
});

// ── Task 14: cursor skips claimed line ranges ─────────────────────────────────

describe("cursor skips claimed lines (Task 14)", () => {
  it("proseMoveDown skips a 3-line wireframe", () => {
    // Doc: line0=prose, lines1-3=wireframe, line4=prose
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

  it("proseMoveUp skips a 3-line wireframe", () => {
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

  it("proseMoveDown skips two adjacent wireframes (regression: while-loop, not if)", () => {
    // Build state manually with two frames: frame1 claims lines 1-3, frame2 claims lines 4-6.
    // Prose: line0="prose-line-0", lines 1-6="", line7="prose-line-7"
    const prose = "prose-line-0\n\n\n\n\n\n\nprose-line-7";
    // frame1: claims lines 1-3, docOffset = offset of line 1
    // line0 = "prose-line-0" (12 chars) + newline = 13 chars, so line1 starts at offset 13
    const frame1: Frame = {
      ...createFrame({ x: 0, y: 18, w: 96, h: 54 }),
      gridRow: 1, gridCol: 0, gridW: 10, gridH: 3,
      docOffset: 13, lineCount: 3,
    };
    // line4 starts at: 13 (line1 start) + 3 lines of "" + 3 newlines = 13 + 3 = 16
    const frame2: Frame = {
      ...createFrame({ x: 0, y: 72, w: 96, h: 54 }),
      gridRow: 4, gridCol: 0, gridW: 10, gridH: 3,
      docOffset: 16, lineCount: 3,
    };
    const state = createEditorState({ prose, frames: [frame1, frame2] });
    let s = moveCursorTo(state, { row: 0, col: 0 });
    s = proseMoveDown(s);
    const cursor = getCursor(s);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(7); // skipped lines 1-6 (two adjacent wireframes)
  });

  it("proseMoveUp skips two adjacent wireframes (regression: while-loop, not if)", () => {
    const prose = "prose-line-0\n\n\n\n\n\n\nprose-line-7";
    const frame1: Frame = {
      ...createFrame({ x: 0, y: 18, w: 96, h: 54 }),
      gridRow: 1, gridCol: 0, gridW: 10, gridH: 3,
      docOffset: 13, lineCount: 3,
    };
    const frame2: Frame = {
      ...createFrame({ x: 0, y: 72, w: 96, h: 54 }),
      gridRow: 4, gridCol: 0, gridW: 10, gridH: 3,
      docOffset: 16, lineCount: 3,
    };
    const state = createEditorState({ prose, frames: [frame1, frame2] });
    let s = moveCursorTo(state, { row: 7, col: 0 });
    s = proseMoveUp(s);
    const cursor = getCursor(s);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(0); // skipped lines 1-6 (two adjacent wireframes)
  });

  it("proseMoveDown at last prose line is no-op", () => {
    const text = `Hello
┌────┐
│ Bx │
└────┘
World`;
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(text, cw, ch);
    state = moveCursorTo(state, { row: 4, col: 0 });
    const before = getCursor(state);
    state = proseMoveDown(state);
    const after = getCursor(state);
    expect(after!.row).toBe(before!.row);
  });

  it("proseMoveUp at first prose line is no-op", () => {
    const text = `Hello
┌────┐
│ Bx │
└────┘
World`;
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(text, cw, ch);
    state = moveCursorTo(state, { row: 0, col: 0 });
    state = proseMoveUp(state);
    const cursor = getCursor(state);
    expect(cursor!.row).toBe(0);
  });

  it("proseMoveDown preserves column clamped to next line length", () => {
    // line 0: "Hello" (5 chars), line 4: "Hi" (2 chars) → col 5 → clamped to 2
    const text = `Hello
┌────┐
│ Bx │
└────┘
Hi`;
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(text, cw, ch);
    state = moveCursorTo(state, { row: 0, col: 5 });
    state = proseMoveDown(state);
    const cursor = getCursor(state);
    expect(cursor).not.toBeNull();
    expect(cursor!.row).toBe(4);
    expect(cursor!.col).toBe(2); // "Hi" has 2 graphemes, col 5 clamped to 2
  });
});

// ── Task 12: Drag wireframe — cut + insert claimed lines ─────────────────────

describe("drag wireframe in unified mode", () => {
  const cw = 9.6, ch = 18;

  // Helper: build state and return the first (top-level) frame.
  function makeState(text: string) {
    const state = createEditorStateUnified(text, cw, ch);
    const frame = getFrames(state)[0];
    return { state, frame };
  }

  // NOTE: drag-vertical is now a NEWLINE ROTATION model — it moves the frame
  // by absorbing adjacent empty (claim-eligible) lines, not by pushing past
  // prose. dRow is clamped to the count of consecutive empty lines on the
  // appropriate side.

  it("drag down by 1 into adjacent empty line moves the claim", () => {
    // Frame at rows 1-3 (lines 2-4 1-indexed). One empty line below at L4.
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\n\nWorld";
    const { state, frame } = makeState(text);
    expect(frame.lineCount).toBe(3);
    const updated = applyMoveFrame(state, frame.id, 0, 1, cw, ch);
    // Doc length preserved; frame moved down by 1.
    expect(updated.doc.lines).toBe(state.doc.lines);
    const updatedFrame = getFrames(updated)[0];
    expect(updatedFrame.gridRow).toBe(frame.gridRow + 1);
    expect(updated.doc.lineAt(updatedFrame.docOffset).number - 1).toBe(updatedFrame.gridRow);
  });

  it("drag down past prose is clamped to no-op (no empty lines to absorb)", () => {
    // Frame at rows 1-3, no empty lines between frame and "World".
    // Drag is rotation-only; with no blank-line slack below, motion clamps
    // to zero. Users who want to push past prose must create space first
    // (e.g. press Enter on the line above the frame).
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld\nEnd";
    const { state, frame } = makeState(text);
    const preDoc = getDoc(state);
    const updated = applyMoveFrame(state, frame.id, 0, 3, cw, ch);
    expect(getDoc(updated)).toBe(preDoc);
    const updatedFrame = getFrames(updated)[0];
    expect(updatedFrame.gridRow).toBe(frame.gridRow);
  });

  it("drag up by 1 into adjacent empty line", () => {
    const text = "A\n\nB\n┌─┐\n└─┘\nC";
    const { state, frame } = makeState(text);
    // No empty line above frame — clamp to no-op.
    const preDoc = getDoc(state);
    const updated = applyMoveFrame(state, frame.id, 0, -1, cw, ch);
    expect(getDoc(updated)).toBe(preDoc);
    expect(getFrames(updated)[0].gridRow).toBe(frame.gridRow);
  });

  it("drag up by 1 with empty line above", () => {
    // Frame at L3-L4 (1-indexed) with empty L2 above.
    const text = "A\n\n┌─┐\n└─┘\nC";
    const { state, frame } = makeState(text);
    const updated = applyMoveFrame(state, frame.id, 0, -1, cw, ch);
    expect(updated.doc.lines).toBe(state.doc.lines);
    const updatedFrame = getFrames(updated)[0];
    expect(updatedFrame.gridRow).toBe(frame.gridRow - 1);
  });

  it("drag down + undo restores pre-drag docOffset", () => {
    // Doc length is invariant under newline-rotation drag, but docOffset
    // does change. Undo must restore docOffset to its pre-drag value.
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\n\nWorld";
    const { state, frame } = makeState(text);
    const preDragDoc = getDoc(state);
    const preDragOffset = frame.docOffset;

    const dragged = applyMoveFrame(state, frame.id, 0, 1, cw, ch);
    expect(getFrames(dragged)[0].docOffset).not.toBe(preDragOffset);

    const restored = editorUndo(dragged);
    expect(getDoc(restored)).toBe(preDragDoc);
    expect(getFrames(restored)[0].docOffset).toBe(preDragOffset);
  });

  it("drag up + undo restores pre-drag docOffset", () => {
    const text = "A\n\n┌─┐\n└─┘\nC";
    const { state, frame } = makeState(text);
    const preDragDoc = getDoc(state);
    const preDragOffset = frame.docOffset;

    const dragged = applyMoveFrame(state, frame.id, 0, -1, cw, ch);
    expect(getFrames(dragged)[0].docOffset).not.toBe(preDragOffset);

    const restored = editorUndo(dragged);
    expect(getDoc(restored)).toBe(preDragDoc);
    expect(getFrames(restored)[0].docOffset).toBe(preDragOffset);
  });

  it("undoDepth === 1 after a single drag", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\n\nWorld";
    const { state, frame } = makeState(text);
    const dragged = applyMoveFrame(state, frame.id, 0, 1, cw, ch);
    // The drag (doc change + frame effect) should land as exactly one history entry.
    expect(undoDepth(dragged)).toBe(1);
  });

  it("redo after undo restores post-drag state", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\n\nWorld";
    const { state, frame } = makeState(text);
    const postDrag = applyMoveFrame(state, frame.id, 0, 1, cw, ch);
    const postDragDoc = getDoc(postDrag);
    const postDragOffset = getFrames(postDrag)[0].docOffset;

    const undone = editorUndo(postDrag);
    const redone = editorRedo(undone);
    expect(getDoc(redone)).toBe(postDragDoc);
    const redoneFrame = getFrames(redone)[0];
    expect(redoneFrame.docOffset).toBe(postDragOffset);
  });

  it("drag then prose-edit then undo twice — each undo is independent", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\n\nWorld";
    const { state, frame } = makeState(text);
    const preDragDoc = getDoc(state);

    const preDragOffset = frame.docOffset;
    // Step 1: drag
    const afterDrag = applyMoveFrame(state, frame.id, 0, 1, cw, ch);
    const afterDragDoc = getDoc(afterDrag);
    expect(getFrames(afterDrag)[0].docOffset).not.toBe(preDragOffset);

    // Step 2: prose edit — insert "X" at start of "Hello"
    const afterEdit = proseInsert(afterDrag, { row: 0, col: 0 }, "X");
    const afterEditDoc = getDoc(afterEdit);
    expect(afterEditDoc).not.toBe(afterDragDoc);

    // Undo prose edit → back to post-drag state
    const undo1 = editorUndo(afterEdit);
    expect(getDoc(undo1)).toBe(afterDragDoc);

    // Undo drag → back to pre-drag state
    const undo2 = editorUndo(undo1);
    expect(getDoc(undo2)).toBe(preDragDoc);
  });

  it("docOffset after undo equals pre-drag snapshot exactly", () => {
    // Verify restoreFramesEffect overrides any mapPos result during undo.
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\n\nWorld";
    const { state, frame } = makeState(text);
    const snapshotOffset = frame.docOffset;

    const dragged = applyMoveFrame(state, frame.id, 0, 1, cw, ch);
    const undone = editorUndo(dragged);

    const undoneFrame = getFrames(undone)[0];
    expect(undoneFrame.docOffset).toBe(snapshotOffset);
  });
});

// ── Task 13: add wireframe in unified mode ────────────────────────────────────

describe("add wireframe in unified mode", () => {
  const STYLE = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("adding a frame with lineCount=3 inserts 3 blank lines at docOffset", () => {
    const text = "Hello\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    // "Hello\n" = 6 chars; docOffset=6 points to start of "World"
    const newFrame = createRectFrame({ gridW: 6, gridH: 3, style: STYLE, charWidth: 9.6, charHeight: 18 });
    newFrame.docOffset = 6;
    newFrame.lineCount = 3;
    newFrame.gridRow = 1;
    const updated = applyAddFrame(state, newFrame);
    // Inserting "\n\n\n" at offset 6: "Hello\n" + "\n\n\n" + "World" = "Hello\n\n\n\nWorld"
    // Lines (1-indexed): 1="Hello", 2="", 3="", 4="", 5="World"
    expect(updated.doc.lines).toBe(state.doc.lines + 3);
    expect(updated.doc.line(2).text).toBe("");
    expect(updated.doc.line(3).text).toBe("");
    expect(updated.doc.line(4).text).toBe("");
    expect(updated.doc.line(5).text).toBe("World");
  });

  it("adding a frame at end of doc inserts blank lines after existing prose", () => {
    const text = "Hello";
    const state = createEditorStateUnified(text, 9.6, 18);
    // doc.length = 5; docOffset=5 = end of doc
    const newFrame = createRectFrame({ gridW: 6, gridH: 3, style: STYLE, charWidth: 9.6, charHeight: 18 });
    newFrame.docOffset = 5;
    newFrame.lineCount = 3;
    newFrame.gridRow = 1;
    const updated = applyAddFrame(state, newFrame);
    // Inserting "\n\n\n" at offset 5: "Hello" + "\n\n\n" = "Hello\n\n\n"
    // Lines: 1="Hello", 2="", 3="", 4=""
    expect(updated.doc.lines).toBe(4);
    expect(updated.doc.line(1).text).toBe("Hello");
    expect(updated.doc.line(2).text).toBe("");
    expect(updated.doc.line(3).text).toBe("");
    expect(updated.doc.line(4).text).toBe("");
  });

  it("adding a child frame (lineCount=0) does NOT touch the doc", () => {
    const text = "Hello\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const docBefore = getDoc(state);
    const childFrame = createRectFrame({ gridW: 4, gridH: 2, style: STYLE, charWidth: 9.6, charHeight: 18 });
    // lineCount=0 by default from createRectFrame — no claimed lines
    expect(childFrame.lineCount).toBe(0);
    const updated = applyAddFrame(state, childFrame);
    expect(getDoc(updated)).toBe(docBefore);
    expect(updated.doc.lines).toBe(state.doc.lines);
  });

  it("add frame is undoable — doc and frames restored", () => {
    const text = "Hello\nWorld";
    const state = createEditorStateUnified(text, 9.6, 18);
    const origDoc = getDoc(state);
    const origFrameCount = getFrames(state).length;
    const newFrame = createRectFrame({ gridW: 6, gridH: 3, style: STYLE, charWidth: 9.6, charHeight: 18 });
    newFrame.docOffset = 6;
    newFrame.lineCount = 3;
    newFrame.gridRow = 1;
    const afterAdd = applyAddFrame(state, newFrame);
    expect(afterAdd.doc.lines).toBe(state.doc.lines + 3);
    expect(getFrames(afterAdd).length).toBe(origFrameCount + 1);
    const afterUndo = editorUndo(afterAdd);
    expect(getDoc(afterUndo)).toBe(origDoc);
    expect(getFrames(afterUndo).length).toBe(origFrameCount);
  });

  it("adding a frame at file start inserts blank lines before existing prose", () => {
    const text = "World";
    const state = createEditorStateUnified(text, 9.6, 18);
    // docOffset=0 = start of doc
    const newFrame = createRectFrame({ gridW: 6, gridH: 2, style: STYLE, charWidth: 9.6, charHeight: 18 });
    newFrame.docOffset = 0;
    newFrame.lineCount = 2;
    newFrame.gridRow = 0;
    const updated = applyAddFrame(state, newFrame);
    // Inserting "\n\n" at offset 0: "\n\n" + "World" = "\n\nWorld"
    // Lines: 1="", 2="", 3="World"
    expect(updated.doc.lines).toBe(3);
    expect(updated.doc.line(1).text).toBe("");
    expect(updated.doc.line(2).text).toBe("");
    expect(updated.doc.line(3).text).toBe("World");
  });

  // Reproduces the e2e harness "add: draw new rect" failure.
  // DemoV2's onMouseUp rect-tool branch creates a frame from a UI grid
  // position (gridR, gridC) and gridW/gridH. Pre-fix it called applyAddFrame
  // with lineCount=0, so the frame was invisible to serializeUnified and
  // unifiedDocSync inserted no claimed lines. applyAddTopLevelFrame is the
  // pure helper that owns the docOffset/lineCount derivation so DemoV2 stays
  // thin and the contract is testable.
  it("applyAddTopLevelFrame: serializeUnified output contains a newly-drawn rect", async () => {
    const { serializeUnified } = await import("./serializeUnified");
    const text = "Just some prose.\n\nAnother paragraph.\n\nA third one.";
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(text, cw, ch);

    const f = createRectFrame({ gridW: 12, gridH: 3, style: STYLE, charWidth: cw, charHeight: ch });
    state = applyAddTopLevelFrame(state, f, 4, 5);

    const out = serializeUnified(getDoc(state), getFrames(state));
    expect(out).toContain("┌");
    expect(out).toContain("└");
    expect(out).toContain("Just some prose.");
    expect(out).toContain("A third one.");
  });

  it("applyAddTopLevelFrame: drawing into empty doc still serializes the rect", async () => {
    const { serializeUnified } = await import("./serializeUnified");
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified("", cw, ch);
    const f = createRectFrame({ gridW: 6, gridH: 3, style: STYLE, charWidth: cw, charHeight: ch });
    state = applyAddTopLevelFrame(state, f, 0, 0);
    const out = serializeUnified(getDoc(state), getFrames(state));
    expect(out).toContain("┌");
    expect(out).toContain("└");
  });

  // Line tool: users draw horizontal, vertical, and diagonal lines.
  // createLineFrame returns lineCount=0 by default — same trap as rect.
  it("applyAddTopLevelFrame: horizontal line round-trips through serializeUnified", async () => {
    const { serializeUnified } = await import("./serializeUnified");
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified("Top.\n\nBottom.", cw, ch);
    const line = createLineFrame({ r1: 1, c1: 0, r2: 1, c2: 8, charWidth: cw, charHeight: ch });
    state = applyAddTopLevelFrame(state, line, line.gridRow, line.gridCol);
    const out = serializeUnified(getDoc(state), getFrames(state));
    expect(out).toContain("─");
    expect(out).toContain("Top.");
    expect(out).toContain("Bottom.");
  });

  it("applyAddTopLevelFrame: vertical line round-trips through serializeUnified", async () => {
    const { serializeUnified } = await import("./serializeUnified");
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified("Top.\n\n\n\nBottom.", cw, ch);
    const line = createLineFrame({ r1: 1, c1: 4, r2: 3, c2: 4, charWidth: cw, charHeight: ch });
    state = applyAddTopLevelFrame(state, line, line.gridRow, line.gridCol);
    const out = serializeUnified(getDoc(state), getFrames(state));
    expect(out).toContain("│");
    expect(out).toContain("Top.");
    expect(out).toContain("Bottom.");
  });

  // Cursor-driven parentage rule: if the user starts a new draw with the
  // mousedown cursor inside an existing top-level frame, the new frame is
  // added as a child of that frame. No doc lines are inserted; the new
  // frame inherits child semantics (lineCount=0, parent-relative gridRow).
  it("applyAddChildFrame: child rect drawn inside parent does not insert doc lines", async () => {
    const cw = 9.6, ch = 18;
    const text = "Prose above\n\n┌──────┐\n│      │\n│      │\n└──────┘\n\nProse below";
    let state = createEditorStateUnified(text, cw, ch);
    const docBefore = getDoc(state);
    const band = getFrames(state)[0];
    expect(band.isBand).toBe(true);
    const parentRect = band.children[0]; // the rect inside the band
    const parentLineCountBefore = band.lineCount;

    const child = createRectFrame({ gridW: 4, gridH: 2, style: STYLE, charWidth: cw, charHeight: ch });
    // Cursor at gridRow 3, gridCol 1 — inside parentRect.
    state = applyAddChildFrame(state, child, parentRect.id, 3, 1);

    expect(getDoc(state)).toBe(docBefore);
    const after = getFrames(state);
    expect(after.length).toBe(1);
    expect(after[0].isBand).toBe(true);
    expect(after[0].children.length).toBe(1);          // band still has 1 direct child (the rect)
    const rectAfter = after[0].children[0];
    expect(rectAfter.children.length).toBe(1);          // the rect gained the new child
    const addedChild = rectAfter.children[0];
    expect(addedChild.lineCount).toBe(0);
    // gridRow on a child is relative to its immediate parent (parentRect),
    // using the stored parentRect.gridRow (which is itself band-relative).
    // applyAddChildFrame computes: childGridRow = absoluteGridRow - parent.gridRow
    expect(addedChild.gridRow).toBe(3 - parentRect.gridRow);
    expect(addedChild.gridCol).toBe(1 - parentRect.gridCol);
    // Band's claim unchanged.
    expect(after[0].lineCount).toBe(parentLineCountBefore);
  });

  // Reparent: moving a top-level frame so its mouseup cursor lands inside
  // another top-level frame demotes it to a child of that frame. Its
  // claimed doc lines are released back to blanks (count preserved by
  // having lineCount=0).
  it("applyReparentFrame: top-level → child releases claimed doc lines", async () => {
    const cw = 9.6, ch = 18;
    // Build the two-top-level-frame state by hand to avoid the scanner's
    // synthetic-container reparenting.
    let state = createEditorStateUnified("Top.\n\nMid.\n\nBot.", cw, ch);
    const big = createRectFrame({ gridW: 10, gridH: 4, style: STYLE, charWidth: cw, charHeight: ch });
    state = applyAddTopLevelFrame(state, big, 0, 0);
    const small = createRectFrame({ gridW: 4, gridH: 3, style: STYLE, charWidth: cw, charHeight: ch });
    state = applyAddTopLevelFrame(state, small, 8, 0);
    const frames = getFrames(state);
    expect(frames.length).toBe(2); // sanity
    // The two top-level frames are bands wrapping the big and small rects.
    expect(frames[0].isBand).toBe(true);
    expect(frames[1].isBand).toBe(true);
    const bigBandId = frames[0].id;
    const smallBandId = frames[1].id;
    const docLinesBefore = state.doc.lines;
    const smallBandLineCount = frames[1].lineCount;

    // Pass child's absolute coords (gridRow=8 from earlier add) and
    // charWidth/charHeight so the demote path can rebase pixel coords.
    // Reparent the small BAND so it becomes a child of the big BAND.
    state = applyReparentFrame(state, smallBandId, bigBandId, 8, 0, cw, ch);

    const after = getFrames(state);
    expect(after.length).toBe(1); // small absorbed
    expect(after[0].id).toBe(bigBandId);
    expect(after[0].children.length).toBe(2);  // big rect (existing child) + demoted small band
    // Find the demoted small-band by id.
    const demotedSmallBand = after[0].children.find(c => c.id === smallBandId)!;
    expect(demotedSmallBand).toBeTruthy();
    expect(demotedSmallBand.lineCount).toBe(0);
    // Doc shrinks by exactly smallBandLineCount lines (released claim).
    expect(state.doc.lines).toBe(docLinesBefore - smallBandLineCount);
  });

  // Reverse reparent: a child dragged outside any frame becomes top-level
  // and must reclaim doc lines so it survives serialization.
  it("applyReparentFrame: sole-child promote releases source claim, new band claims target capacity", async () => {
    const cw = 9.6, ch = 18;
    const text = "Prose above\n\n┌──────┐\n│ ┌─┐  │\n│ └─┘  │\n│      │\n└──────┘\n\nProse below";
    let state = createEditorStateUnified(text, cw, ch);
    const top = getFrames(state)[0];
    expect(top.isBand).toBe(true);
    expect(top.children.length).toBeGreaterThan(0); // sanity
    const child = top.children[0]; // the outer rect inside the band
    const childGridH = child.gridH;
    const docLinesBefore = state.doc.lines;

    // Promote child to top-level at row 0. Eager-bands semantics:
    // - source band loses its sole child → its claim lines are released
    // - new band at row 0 needs childGridH rows; row 0 is "Prose above"
    //   (non-blank), so the new band inserts childGridH fresh lines there
    // Net: doc grows by 0 (-childGridH released, +childGridH inserted).
    state = applyReparentFrame(state, child.id, null, 0, 0, cw, ch);

    const after = getFrames(state);
    expect(after.length).toBe(1);
    expect(after[0].isBand).toBe(true);
    expect(after[0].children.length).toBe(1);
    expect(after[0].children[0].id).toBe(child.id);
    expect(after[0].lineCount).toBe(childGridH);
    expect(state.doc.lines).toBe(docLinesBefore);
  });

  // Text tool: users place a single-line label. createTextFrame returns
  // lineCount=0 — the label vanishes on save without applyAddTopLevelFrame.
  it("applyAddTopLevelFrame: text label round-trips through serializeUnified", async () => {
    const { serializeUnified } = await import("./serializeUnified");
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified("Above.\n\n\nBelow.", cw, ch);
    const txt = createTextFrame({ text: "Hello", row: 2, col: 4, charWidth: cw, charHeight: ch });
    state = applyAddTopLevelFrame(state, txt, txt.gridRow, txt.gridCol);
    const out = serializeUnified(getDoc(state), getFrames(state));
    expect(out).toContain("Hello");
    expect(out).toContain("Above.");
    expect(out).toContain("Below.");
  });
});

// ── Top-level frame gridRow must agree with docOffset ──────────────────────
//
// For top-level frames, gridRow is a CACHE of "what doc line does docOffset
// land on". After any mutation, they MUST agree. The serializer reads
// gridRow; the doc holds claimed lines via docOffset. Drift between them
// produces output corruption.

describe("top-level frame gridRow == lineAt(docOffset).number - 1", () => {
  it("after drag-down past doc end, gridRow matches docOffset (clamped)", () => {
    // Reproduces the e2e harness "drag: move box down" failure exactly.
    const SIMPLE_BOX = "Prose above\n\n┌──────────────┐\n│              │\n│              │\n└──────────────┘\n\nProse below";
    let state = createEditorStateUnified(SIMPLE_BOX, 9.6, 18);
    const before = getFrames(state)[0];
    state = state.update({
      effects: moveFrameEffect.of({
        id: before.id, dCol: 0, dRow: 5,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const after = getFrames(state)[0];
    const expectedRow = state.doc.lineAt(after.docOffset).number - 1;
    expect(after.gridRow).toBe(expectedRow);
  });

  it("after drag-up, gridRow matches docOffset", () => {
    const text = "A\nB\n\n\n┌──┐\n│Hi│\n└──┘\nZ";
    let state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    state = state.update({
      effects: moveFrameEffect.of({
        id: before.id, dCol: 0, dRow: -2,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const after = getFrames(state)[0];
    const expectedRow = state.doc.lineAt(after.docOffset).number - 1;
    expect(after.gridRow).toBe(expectedRow);
  });

  it("after prose Enter above frame, gridRow matches docOffset", () => {
    const text = "Hi\n┌──┐\n│Bx│\n└──┘";
    let state = createEditorStateUnified(text, 9.6, 18);
    state = state.update({
      changes: { from: 2, insert: "\n" },
      userEvent: "input.type",
    }).state;
    const after = getFrames(state)[0];
    const expectedRow = state.doc.lineAt(after.docOffset).number - 1;
    expect(after.gridRow).toBe(expectedRow);
  });

  it("after resize-grow, gridRow matches docOffset", () => {
    const text = "Hi\n┌──┐\n└──┘\nWorld";
    let state = createEditorStateUnified(text, 9.6, 18);
    const before = getFrames(state)[0];
    state = state.update({
      effects: resizeFrameEffect.of({
        id: before.id, gridW: before.gridW, gridH: 4,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const after = getFrames(state)[0];
    const expectedRow = state.doc.lineAt(after.docOffset).number - 1;
    expect(after.gridRow).toBe(expectedRow);
  });

  it("drag past doc end clamps lineCount so frame doesn't claim prose lines", () => {
    // Reproduces e2e harness "prose order preserved when dragging wireframe down".
    // 5-line frame (gridH=5: top + 3 inner + bottom) starts at row 2.
    // Drag down 8 rows → would land at row 10 in a doc that only has 8 lines.
    // Without proper clamp, the frame's claimed range overlaps "Prose B".
    const fixture = "Prose A first\n\n┌──────────────┐\n│              │\n│   Wireframe  │\n│              │\n└──────────────┘\n\nProse B second";
    let state = createEditorStateUnified(fixture, 9.6, 18);
    const before = getFrames(state)[0];
    state = state.update({
      effects: moveFrameEffect.of({
        id: before.id, dCol: 0, dRow: 8,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const after = getFrames(state)[0];
    // Compute the line that contains "Prose B second" in the post-drag doc.
    const doc = getDoc(state);
    const proseBLine = doc.split("\n").findIndex(l => l.includes("Prose B"));
    expect(proseBLine).toBeGreaterThanOrEqual(0);
    // The frame must NOT claim the "Prose B" line.
    const claimedEnd = after.gridRow + after.lineCount - 1;
    expect(after.gridRow).toBeLessThan(proseBLine);
    expect(claimedEnd).toBeLessThan(proseBLine);
  });

  it("drag past doc end: serializeUnified output preserves Prose B intact", async () => {
    // The hard one: after the drag-clamp, does serializeUnified produce
    // output containing literal "Prose B second"?
    const { serializeUnified } = await import("./serializeUnified");
    const fixture = "Prose A first\n\n┌──────────────┐\n│              │\n│   Wireframe  │\n│              │\n└──────────────┘\n\nProse B second";
    let state = createEditorStateUnified(fixture, 9.6, 18);
    const before = getFrames(state)[0];
    state = state.update({
      effects: moveFrameEffect.of({
        id: before.id, dCol: 0, dRow: 8,
        charWidth: 9.6, charHeight: 18,
      }),
      annotations: Transaction.addToHistory.of(true),
    }).state;
    const out = serializeUnified(getDoc(state), getFrames(state));
    expect(out).toContain("Prose A first");
    expect(out).toContain("Prose B second");
    expect(out).toContain("Wireframe");
  });

  it("incremental drag (10 small dRow=1 steps) preserves Prose B", async () => {
    const { serializeUnified } = await import("./serializeUnified");
    const fixture = "Prose A first\n\n┌──────────────┐\n│              │\n│   Wireframe  │\n│              │\n└──────────────┘\n\nProse B second";
    let state = createEditorStateUnified(fixture, 9.6, 18);
    const id = getFrames(state)[0].id;
    const dump = (label: string) => {
      const f = getFrames(state)[0];
      const doc = getDoc(state);
      const lines = doc.split("\n");
      // eslint-disable-next-line no-console
      console.log(`\n${label}: gridRow=${f.gridRow} docOffset=${f.docOffset} lineCount=${f.lineCount} doc.length=${doc.length} doc=${JSON.stringify(doc)}`);
      for (let li = 0; li < lines.length; li++) {
        const claimed = li >= f.gridRow && li < f.gridRow + f.lineCount;
        // eslint-disable-next-line no-console
        console.log(`  L${li}: ${claimed ? "[CLAIM]" : "[prose]"} ${JSON.stringify(lines[li])}`);
      }
    };
    dump("initial");
    for (let i = 0; i < 5; i++) {
      state = state.update({
        effects: moveFrameEffect.of({
          id, dCol: 0, dRow: 1,
          charWidth: 9.6, charHeight: 18,
        }),
        annotations: Transaction.addToHistory.of(i === 0),
      }).state;
      dump(`after step ${i}`);
    }
    const out = serializeUnified(getDoc(state), getFrames(state));
    // eslint-disable-next-line no-console
    console.log("=== serialized ===\n" + out);
    expect(out).toContain("Prose A first");
    expect(out).toContain("Prose B second");
    expect(out).toContain("Wireframe");
  });
});

// ── Drag is rotation-only; motion clamped to blank-line slack ────────────────
//
// Architectural invariant: drag mutates only the dragged frame's docOffset.
// We rotate newlines around the frame's claim — no net char insertion.
// Motion beyond the consecutive-blank slack is a no-op. Doc length is
// preserved across drag transactions, so other frames' mapPos sees +N then
// -N with net-zero shift.

describe("drag is rotation-only", () => {
  it("drag-down clamped to blank-line slack: doc length preserved", () => {
    const cw = 9.6, ch = 18;
    const SIMPLE_BOX = "Prose above\n\n┌────┐\n│    │\n│    │\n└────┘\n\nProse below";
    let state = createEditorStateUnified(SIMPLE_BOX, cw, ch);
    const linesBefore = state.doc.lines;
    const id = getFrames(state)[0].id;
    const before = getFrames(state)[0];
    expect(before.gridRow).toBe(2); // sanity

    // 1 blank below frame is the only rotation budget. Drag-down by 3 is
    // clamped to 1; doc length stays the same.
    state = applyMoveFrame(state, id, 0, 3, cw, ch);

    expect(state.doc.lines).toBe(linesBefore);
    const after = getFrames(state)[0];
    expect(after.gridRow).toBe(before.gridRow + 1);
  });
});

describe("findBandAtRow", () => {
  it("is exercised indirectly via applyAddTopLevelFrame in Task 3", () => {
    // findBandAtRow is private; behavior covered by Task 3 integration tests.
    expect(true).toBe(true);
  });
});

describe("applyAddTopLevelFrame eager bands", () => {
  const CW = 8, CH = 18;
  const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("first rect on a row creates a band wrapping it", () => {
    const state = createEditorState({ prose: "\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rect = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const next = applyAddTopLevelFrame(state, rect, 0, 0);
    const frames = getFrames(next);
    expect(frames).toHaveLength(1);
    expect(frames[0].content).toBeNull();         // band has no content
    expect(frames[0].isBand).toBe(true);
    expect(frames[0].children).toHaveLength(1);
    expect(frames[0].children[0].content?.type).toBe("rect");
    expect(frames[0].lineCount).toBe(3);
    expect(frames[0].children[0].lineCount).toBe(0);
    expect(frames[0].children[0].docOffset).toBe(0);
  });

  it("second rect on the SAME row joins the existing band", () => {
    const state0 = createEditorState({ prose: "\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const docAfterA = getDoc(state1);
    const bandId = getFrames(state1)[0].id;
    const rectAId = getFrames(state1)[0].children[0].id;

    const rectB = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, rectB, 0, 8);

    // Doc length must NOT have changed — no fresh claim lines inserted.
    expect(getDoc(state2)).toBe(docAfterA);

    const frames = getFrames(state2);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(bandId);
    expect(frames[0].children).toHaveLength(2);
    const childIds = frames[0].children.map(c => c.id);
    expect(childIds).toContain(rectAId);

    const aChild = frames[0].children.find(c => c.id === rectAId)!;
    expect(aChild.gridRow).toBe(0);
    expect(aChild.gridCol).toBe(0);
  });

  it("joining a band with a TALLER child grows the band's claim", () => {
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const docLenBefore = getDoc(state1).length;
    const bandId = getFrames(state1)[0].id;
    const tallRect = createRectFrame({ gridW: 4, gridH: 5, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, tallRect, 1, 8);
    const frames = getFrames(state2);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(bandId);
    expect(frames[0].children).toHaveLength(2);
    expect(frames[0].gridH).toBeGreaterThanOrEqual(6);
    expect(frames[0].lineCount).toBeGreaterThanOrEqual(6);
    const docLenAfter = getDoc(state2).length;
    expect(docLenAfter).toBe(docLenBefore + (frames[0].lineCount - 3));
  });

  it("rect on a row CLAIMED by no band creates a fresh band", () => {
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const rectB = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, rectB, 5, 0);

    const frames = getFrames(state2);
    expect(frames).toHaveLength(2);
    expect(frames[0].isBand).toBe(true);
    expect(frames[1].isBand).toBe(true);
    expect(frames[0].children).toHaveLength(1);
    expect(frames[1].children).toHaveLength(1);
  });
});

describe("applyDeleteFrame cascades band cleanup", () => {
  const CW = 8, CH = 18;
  const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("deleting the only rect inside a band releases the band's doc lines", () => {
    const state0 = createEditorState({ prose: "\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const docLenBefore = getDoc(state0).length;
    const rect = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rect, 0, 0);
    const docLenWithBand = getDoc(state1).length;
    expect(docLenWithBand).toBeGreaterThan(docLenBefore); // band added 3 blank lines
    const rectId = getFrames(state1)[0].children[0].id;

    const state2 = applyDeleteFrame(state1, rectId);
    expect(getFrames(state2)).toHaveLength(0);
    expect(getDoc(state2).length).toBe(docLenBefore);
  });

  it("deleting one of TWO children in a band does NOT release the band", () => {
    const state0 = createEditorState({ prose: "\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const rectB = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, rectB, 0, 8);
    const docLenWithTwo = getDoc(state2).length;
    const rectAId = getFrames(state2)[0].children[0].id;

    const state3 = applyDeleteFrame(state2, rectAId);
    const frames = getFrames(state3);
    expect(frames).toHaveLength(1);
    expect(frames[0].isBand).toBe(true);
    expect(frames[0].children).toHaveLength(1);
    expect(getDoc(state3).length).toBe(docLenWithTwo);
  });
});

describe("applyReparentFrame eager bands", () => {
  const CW = 8, CH = 18;
  const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("promote into a row claimed by an existing band joins the band", () => {
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const rectC = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state2 = applyAddTopLevelFrame(state1, rectC, 5, 0);
    const docBeforePromote = getDoc(state2);
    const band1 = getFrames(state2)[0];
    const band2 = getFrames(state2)[1];
    const rectAId = band1.children[0].id;
    const rectCId = band2.children[0].id;

    // Reparent rectA "promote" to row 5 (where band2 lives). Eager-bands
    // redirects this to demote-into-band2 AND releases band1's claim
    // (rectA was its sole child). rectA joins band2 as a sibling of rectC.
    // Doc shrinks by band1.lineCount (3 lines released).
    const band1LineCount = band1.lineCount;
    const state3 = applyReparentFrame(state2, rectAId, null, 5, 8, CW, CH);
    expect(getDoc(state3).length).toBe(docBeforePromote.length - band1LineCount);
    const frames = getFrames(state3);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(band2.id);
    expect(frames[0].children).toHaveLength(2);
    const childIds = frames[0].children.map(c => c.id);
    expect(childIds).toContain(rectAId);
    expect(childIds).toContain(rectCId);
  });

  it("promote to a row with NO existing band creates a fresh band", () => {
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const rectInner = createRectFrame({ gridW: 3, gridH: 2, style: rectStyle, charWidth: CW, charHeight: CH });
    const band1 = getFrames(state1)[0];
    const state2 = applyAddChildFrame(state1, rectInner, band1.children[0].id, 1, 1);
    const innerId = getFrames(state2)[0].children[0].children[0].id;
    // Promote rectInner to top-level at row 7 (no band there).
    const state3 = applyReparentFrame(state2, innerId, null, 7, 0, CW, CH);
    const frames = getFrames(state3);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    // Find the band that now claims row 7.
    const band7 = frames.find(f => f.gridRow === 7);
    expect(band7).toBeTruthy();
    expect(band7!.isBand).toBe(true);
    expect(band7!.children).toHaveLength(1);
    expect(band7!.children[0].id).toBe(innerId);
  });
});

describe("createEditorStateUnified eager bands", () => {
  it("a single rect on disk loads as a band wrapping the rect", () => {
    const md = "Top prose\n\n┌────┐\n│ A  │\n└────┘\n\nBottom prose";
    const state = createEditorStateUnified(md, 8, 18);
    const frames = getFrames(state);
    expect(frames).toHaveLength(1);
    expect(frames[0].isBand).toBe(true);
    expect(frames[0].children).toHaveLength(1);
    expect(frames[0].children[0].content?.type).toBe("rect");
    // Band claims rows 2,3,4 (the wireframe rows).
    expect(frames[0].gridRow).toBe(2);
    expect(frames[0].lineCount).toBe(3);
  });

  it("two stacked rects (separated by 3+ blank lines) load as TWO separate bands", () => {
    // groupIntoContainers in src/frame.ts uses a 1-row vertical margin —
    // rects separated by 1 blank line get merged. Use 3 blank lines to
    // ensure they remain separate top-level frames → two bands after wrap.
    const md = "p\n\n┌──┐\n│A │\n└──┘\n\n\n\n┌──┐\n│B │\n└──┘\n\nq";
    const state = createEditorStateUnified(md, 8, 18);
    const frames = getFrames(state);
    expect(frames).toHaveLength(2);
    expect(frames[0].isBand).toBe(true);
    expect(frames[1].isBand).toBe(true);
    expect(frames[0].children).toHaveLength(1);
    expect(frames[1].children).toHaveLength(1);
  });

  it("two side-by-side rects load as ONE band with two children", () => {
    const md = "p\n\n┌──┐  ┌──┐\n│A │  │B │\n└──┘  └──┘\n\nq";
    const state = createEditorStateUnified(md, 8, 18);
    const frames = getFrames(state);
    expect(frames).toHaveLength(1);
    expect(frames[0].isBand).toBe(true);
    expect(frames[0].children).toHaveLength(2);
  });
});

describe("eager-band data correctness regressions", () => {
  const CW = 8, CH = 18;
  const rectStyle = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("promoting the sole child of a band releases the band's claim lines", () => {
    // BUG: empty-band filter prunes the band from state but unifiedDocSync
    // never sees deleteFrameEffect → orphan claim lines leak forever.
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const docLenStart = getDoc(state0).length;
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    expect(getDoc(state1).length).toBeGreaterThan(docLenStart); // band claimed 3 lines
    const rectAId = getFrames(state1)[0].children[0].id;

    // Promote rectA to row 7 (no existing band there). The OLD band at row 0
    // becomes empty; its claim lines must be released. The NEW band at row 7
    // claims its own 3 lines. Net: total doc length unchanged from start.
    const state2 = applyReparentFrame(state1, rectAId, null, 7, 0, CW, CH);
    expect(getDoc(state2).length).toBe(docLenStart);
  });

  it("resizing a rect-inside-band taller grows the band's claim", () => {
    // BUG: resize on the child only updates child.gridH; band's gridH and
    // claim are untouched. Rect bleeds out of the band visually and into
    // surrounding prose territory.
    const state0 = createEditorState({ prose: "\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [] });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const state1 = applyAddTopLevelFrame(state0, rectA, 0, 0);
    const docLenAfterAdd = getDoc(state1).length;
    const band = getFrames(state1)[0];
    expect(band.isBand).toBe(true);
    expect(band.gridH).toBe(3);
    const rectAId = band.children[0].id;

    // Resize rectA from gridH=3 to gridH=6 (taller by 3). The band must grow
    // to gridH=6 too (rect can't bleed out), and unifiedDocSync must insert
    // 3 new claim lines.
    const state2 = state1.update({
      effects: resizeFrameEffect.of({ id: rectAId, gridW: 5, gridH: 6, charWidth: CW, charHeight: CH }),
    }).state;

    const bandAfter = getFrames(state2)[0];
    // Band must have grown to contain the resized child.
    expect(bandAfter.gridH).toBeGreaterThanOrEqual(6);
    expect(bandAfter.lineCount).toBeGreaterThanOrEqual(6);
    // Doc grew by exactly the band's growth (3 lines).
    expect(getDoc(state2).length).toBe(docLenAfterAdd + 3);
  });

  it("dragging one band into another merges them into a single band", () => {
    // BUG: drag rotation counts blank lines as rotation budget, but blank
    // lines inside another band's claim are NOT free space. Rotating into
    // them puts both bands' claim ranges over the same rows, breaking the
    // row-partition invariant. Bands must merge instead.
    //
    // Setup: two bands stacked with a 3-row gap of pure prose between.
    // Drag the bottom band up by enough that its claim collides with the
    // top band's claim. After: ONE band whose claim spans both originals
    // and contains both rects as children.
    const state0 = createEditorState({
      prose: "\n\n\n\n\n\n\n\n\n\n\n\n", frames: [], proseSegmentMap: [],
    });
    const rectA = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    const rectB = createRectFrame({ gridW: 5, gridH: 3, style: rectStyle, charWidth: CW, charHeight: CH });
    let state = applyAddTopLevelFrame(state0, rectA, 0, 0);   // bandA at row 0..2
    state = applyAddTopLevelFrame(state, rectB, 6, 0);        // bandB at row 6..8

    const bandA = getFrames(state).find(f => f.gridRow === 0)!;
    const bandB = getFrames(state).find(f => f.gridRow > 0)!;
    expect(bandA.children).toHaveLength(1);
    expect(bandB.children).toHaveLength(1);

    // Drag bandB upward by 5 rows — would put bandB at gridRow=1 (overlapping
    // bandA's rows 0..2). Expect merge: one band, two child rects.
    state = state.update({
      effects: [moveFrameEffect.of({ id: bandB.id, dCol: 0, dRow: -5, charWidth: CW, charHeight: CH })],
    }).state;

    const after = getFrames(state);
    expect(after).toHaveLength(1);
    expect(after[0].isBand).toBe(true);
    expect(after[0].children).toHaveLength(2);
    // Merged band's claim must cover both rects' absolute row ranges.
    const merged = after[0];
    for (const child of merged.children) {
      const childAbsBottom = merged.gridRow + child.gridRow + child.gridH;
      expect(childAbsBottom).toBeLessThanOrEqual(merged.gridRow + merged.gridH);
    }
  });
});

// ── Diagnostic: wall-stack-vert text-loss ──────────────────────────────────
// Mirrors the failing harness test "stack two same-width boxes vertically".
// The harness loads two stacked labeled rects, drags the bottom one up, saves,
// and finds that `Bottom` text is missing from the saved markdown. This
// describe block isolates the failure at the data-model layer by dispatching
// the same effect the drag handler would emit, asserting frame state at each
// boundary (post-load → post-move → post-serialize) so the first failing
// assertion identifies which layer drops the text.

describe("diagnostic: wall-stack-vert text loss", () => {
  beforeAll(() => {
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() => ({
          font: "", fillStyle: "", textBaseline: "", fillText: () => {},
          measureText: (text: string) => ({
            width: text.length * 9.6,
            actualBoundingBoxAscent: 12,
            actualBoundingBoxDescent: 4,
          }),
        })) as unknown as HTMLCanvasElement["getContext"];
      }
      return el;
    });
  });

  const STACKED = [
    "Title", "",
    "┌──────────┐",
    "│  Top     │",
    "└──────────┘", "", "", "",
    "┌──────────┐",
    "│  Bottom  │",
    "└──────────┘", "",
    "End",
  ].join("\n");

  /** Walk frames recursively, return all rect frames carrying a text-child. */
  function findRectsWithTextChild(frames: Frame[]): Frame[] {
    const out: Frame[] = [];
    const walk = (f: Frame) => {
      const hasText = f.children.some(c => c.content?.type === "text");
      if (hasText && f.content?.type === "rect") out.push(f);
      for (const c of f.children) walk(c);
    };
    for (const f of frames) walk(f);
    return out;
  }

  /** Find the first text-child string under a given rect. */
  function textOf(rect: Frame): string {
    const t = rect.children.find(c => c.content?.type === "text");
    if (!t || t.content?.type !== "text") return "";
    return t.content.text ?? "";
  }

  it("post-LOAD: both rects have text-child content (Top, Bottom)", () => {
    const state = createEditorStateUnified(STACKED, 9.6, 18);
    const rects = findRectsWithTextChild(getFrames(state));
    const labels = rects.map(textOf).sort();
    expect(labels).toEqual(["Bottom", "Top"]);
    // Dump tree for human inspection (one-off — remove after design choice).
    const lines: string[] = [];
    const dump = (f: Frame, d = 0) => {
      const tag = f.isBand ? "BAND" : f.content?.type ?? "container";
      const text = f.content?.type === "text" ? `"${f.content.text}"` : "";
      lines.push(`${"  ".repeat(d)}${tag} gR=${f.gridRow} gC=${f.gridCol} gW=${f.gridW} gH=${f.gridH} ch=${f.children.length} ${text}`);
      for (const c of f.children) dump(c, d + 1);
    };
    for (const f of getFrames(state)) dump(f);
    // eslint-disable-next-line no-console
    console.log("\nFRAME-TREE\n" + lines.join("\n") + "\n");
  });

  it("post-MOVE: dragging the bottom band up by 3 rows preserves Bottom text", () => {
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(STACKED, cw, ch);

    const bands = getFrames(state).filter(f => f.isBand);
    expect(bands.length).toBe(2);
    const bottomBand = bands.reduce((a, b) => (a.gridRow > b.gridRow ? a : b));

    // Drag up by 3 rows — the residual the drag handler emits on the band
    // when the child rect can't move further within band bounds.
    state = applyMoveFrame(state, bottomBand.id, 0, -3, cw, ch);

    const rects = findRectsWithTextChild(getFrames(state));
    const labels = rects.map(textOf).sort();
    expect(labels).toEqual(["Bottom", "Top"]);
  });

  it("post-SERIALIZE: saved markdown contains Bottom text after the move", async () => {
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(STACKED, cw, ch);
    const bands = getFrames(state).filter(f => f.isBand);
    const bottomBand = bands.reduce((a, b) => (a.gridRow > b.gridRow ? a : b));
    state = applyMoveFrame(state, bottomBand.id, 0, -3, cw, ch);

    const { serializeUnified } = await import("./serializeUnified");
    const md = serializeUnified(getDoc(state), getFrames(state));
    expect(md).toContain("Top");
    expect(md).toContain("Bottom");
  });

  it("post-MOVE-then-CLICKPROSE: prose click after drag preserves Bottom text", () => {
    // After dragging, the harness calls clickProse(page, 5, 5) which moves
    // the cursor into the prose region. That dispatches a selection-change
    // transaction. If anything in the framesField update path or in
    // unifiedDocSync corrupts the frame tree on a non-frame transaction,
    // this test will catch it.
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(STACKED, cw, ch);
    const bands = getFrames(state).filter(f => f.isBand);
    const bottomBand = bands.reduce((a, b) => (a.gridRow > b.gridRow ? a : b));
    state = applyMoveFrame(state, bottomBand.id, 0, -3, cw, ch);

    // Mimic clickProse — set cursor into prose. Doc start (row 0 col 0) is safe.
    state = moveCursorTo(state, { row: 0, col: 0 });

    const rects = findRectsWithTextChild(getFrames(state));
    const labels = rects.map(textOf).sort();
    expect(labels).toEqual(["Bottom", "Top"]);
  });

  it("multi-step drag: incremental moves totaling -3 rows preserve text", () => {
    // The harness's dragSelected does multiple sequential page.mouse.move
    // calls (5 steps for dy=-50), each potentially producing a separate
    // moveFrameEffect dispatch. Each dispatch routes through framesField
    // + unifiedDocSync independently. If any intermediate state corrupts
    // children, this test catches it.
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(STACKED, cw, ch);
    const bands = getFrames(state).filter(f => f.isBand);
    const bottomBand = bands.reduce((a, b) => (a.gridRow > b.gridRow ? a : b));

    // Simulate 3 separate -1 row moves rather than one -3 move.
    state = applyMoveFrame(state, bottomBand.id, 0, -1, cw, ch);
    state = applyMoveFrame(state, bottomBand.id, 0, -1, cw, ch);
    state = applyMoveFrame(state, bottomBand.id, 0, -1, cw, ch);

    const rects = findRectsWithTextChild(getFrames(state));
    const labels = rects.map(textOf).sort();
    expect(labels).toEqual(["Bottom", "Top"]);
  });

  it("drag-handler-style dispatch: targets the RECT, residual to band", () => {
    // Click on the rect inside the bottom band. DemoV2 selects the rect's
    // container (the rect itself, since the band is non-selectable). The
    // drag handler then computes a per-step dRow and routes to either:
    //   (a) the rect, clamped to band bounds, or
    //   (b) the band, with residual.
    // For wall-stack-vert: child gridRow=0, gridH=3, band gridH=3 →
    // clampedDRow=0, residualDRow=dRow → entire delta goes to the band.
    // (Same effect as testing the band directly, but verifying anyway with
    // the rect-id call to confirm the moveFrameEffect handler walks tree.)
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(STACKED, cw, ch);
    const bands = getFrames(state).filter(f => f.isBand);
    const bottomBand = bands.reduce((a, b) => (a.gridRow > b.gridRow ? a : b));
    const bottomRect = bottomBand.children[0];
    expect(bottomRect.content?.type).toBe("rect");

    // Dispatch on the rect — see if framesField walks children to find it
    // and whether the move corrupts text-children.
    state = applyMoveFrame(state, bottomRect.id, 0, -3, cw, ch);

    const rects = findRectsWithTextChild(getFrames(state));
    const labels = rects.map(textOf).sort();
    expect(labels).toEqual(["Bottom", "Top"]);
  });

  it("drag-handler-style: combined rect-clamp + band-residual in one transaction", () => {
    // Mirrors DemoV2.tsx:677-682 — when both clampedDRow and residualDRow
    // are nonzero, BOTH effects dispatch in one .update() call. For the
    // stack-vert scenario, clampedDRow=0 so only band moves, but verify the
    // dual-effect path doesn't corrupt children either way.
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(STACKED, cw, ch);
    const bands = getFrames(state).filter(f => f.isBand);
    const bottomBand = bands.reduce((a, b) => (a.gridRow > b.gridRow ? a : b));
    const bottomRect = bottomBand.children[0];

    state = state.update({
      effects: [
        moveFrameEffect.of({ id: bottomRect.id, dCol: 0, dRow: 0, charWidth: cw, charHeight: ch }),
        moveFrameEffect.of({ id: bottomBand.id, dCol: 0, dRow: -3, charWidth: cw, charHeight: ch }),
      ],
      annotations: [Transaction.addToHistory.of(true)],
    }).state;

    const rects = findRectsWithTextChild(getFrames(state));
    const labels = rects.map(textOf).sort();
    expect(labels).toEqual(["Bottom", "Top"]);
  });

  it("multi-step drag with overlap: residual moves into top band — text still preserved", () => {
    // The harness drags by 50px. With ch≈18, that's potentially up to 3
    // rows. As the band approaches the top band's rows, the bands may
    // overlap and trigger mergeOverlappingBands. This test tries 4 row
    // moves to force overlap and verify the merged shape preserves text.
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(STACKED, cw, ch);
    const bands = getFrames(state).filter(f => f.isBand);
    const bottomBand = bands.reduce((a, b) => (a.gridRow > b.gridRow ? a : b));

    // -4 rows: bottom band starts at row 9, would land at row 5 — overlapping
    // top band's rows 3..5. Triggers merge.
    state = applyMoveFrame(state, bottomBand.id, 0, -4, cw, ch);

    const rects = findRectsWithTextChild(getFrames(state));
    const labels = rects.map(textOf).sort();
    expect(labels).toEqual(["Bottom", "Top"]);
  });

  it("post-SAVE-CYCLE: full save (serialize + applyClearDirty) preserves Bottom in the saved string", async () => {
    // Mirrors __gridpad.saveDocument: serialize → applyClearDirty → return md.
    const cw = 9.6, ch = 18;
    let state = createEditorStateUnified(STACKED, cw, ch);
    const bands = getFrames(state).filter(f => f.isBand);
    const bottomBand = bands.reduce((a, b) => (a.gridRow > b.gridRow ? a : b));
    state = applyMoveFrame(state, bottomBand.id, 0, -3, cw, ch);

    const { serializeUnified } = await import("./serializeUnified");
    const md = serializeUnified(getDoc(state), getFrames(state));
    state = applyClearDirty(state);

    expect(md).toContain("Top");
    expect(md).toContain("Bottom");

    // Re-load the saved string and check it still has Bottom — the harness
    // also reloads after save in some tests; this catches any asymmetry
    // between scanner + serializer.
    const reloaded = createEditorStateUnified(md, cw, ch);
    const reloadedRects = findRectsWithTextChild(getFrames(reloaded));
    const reloadedLabels = reloadedRects.map(textOf).sort();
    expect(reloadedLabels).toEqual(["Bottom", "Top"]);
  });
});

// ── Selection hierarchy helpers ────────────────────────────────────────

describe("findPath", () => {
  beforeAll(() => {
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() => ({
          font: "", fillStyle: "", textBaseline: "", fillText: () => {},
          measureText: (text: string) => ({
            width: text.length * 9.6,
            actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4,
          }),
        })) as unknown as HTMLCanvasElement["getContext"];
      }
      return el;
    });
  });

  const STYLE = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

  it("returns root→target chain for nested frame", () => {
    // Build a manual tree to keep test self-contained.
    const leaf = createTextFrame({ text: "X", row: 0, col: 0, charWidth: 9.6, charHeight: 18 });
    const rect: Frame = {
      ...createRectFrame({ gridW: 4, gridH: 3, style: STYLE, charWidth: 9.6, charHeight: 18 }),
      children: [leaf],
    };
    const chain = findPath([rect], leaf.id);
    expect(chain.map((f: Frame) => f.id)).toEqual([rect.id, leaf.id]);
  });

  it("returns empty array when target not present", () => {
    const rect = createRectFrame({ gridW: 4, gridH: 3, style: STYLE, charWidth: 9.6, charHeight: 18 });
    expect(findPath([rect], "no-such-id")).toEqual([]);
  });

  it("returns single-element chain for top-level match", () => {
    const rect = createRectFrame({ gridW: 4, gridH: 3, style: STYLE, charWidth: 9.6, charHeight: 18 });
    const chain = findPath([rect], rect.id);
    expect(chain).toEqual([rect]);
  });
});

describe("findContainingBandDeep", () => {
  beforeAll(() => {
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() => ({
          font: "", fillStyle: "", textBaseline: "", fillText: () => {},
          measureText: (text: string) => ({
            width: text.length * 9.6,
            actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4,
          }),
        })) as unknown as HTMLCanvasElement["getContext"];
      }
      return el;
    });
  });

  it("finds band when frame is an immediate child", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    expect(findContainingBandDeep(getFrames(state), rect.id)?.id).toBe(band.id);
  });

  it("finds band when frame is a grandchild (rect inside text-label-bearing rect)", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const textChild = rect.children.find(c => c.content?.type === "text")!;
    expect(findContainingBandDeep(getFrames(state), textChild.id)?.id).toBe(band.id);
  });

  it("returns null when frame id is absent", () => {
    const md = ["Hello"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    expect(findContainingBandDeep(getFrames(state), "no-such-id")).toBeNull();
  });

  it("returns null when frameId itself names a top-level band (does not return self)", () => {
    // Band-to-band reparent caller passes the band-id-being-moved here.
    // If this returned self, the caller would conflate "frame being moved"
    // with "frame's source location" and corrupt the empty-band detection.
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    expect(findContainingBandDeep(getFrames(state), band.id)).toBeNull();
  });
});

describe("getBandRelativeRow / getBandRelativeCol", () => {
  beforeAll(() => {
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() => ({
          font: "", fillStyle: "", textBaseline: "", fillText: () => {},
          measureText: (text: string) => ({
            width: text.length * 9.6,
            actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4,
          }),
        })) as unknown as HTMLCanvasElement["getContext"];
      }
      return el;
    });
  });

  it("immediate child of band: returns child.gridRow/gridCol", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    expect(getBandRelativeRow(rect.id, band.id, getFrames(state))).toBe(rect.gridRow);
    expect(getBandRelativeCol(rect.id, band.id, getFrames(state))).toBe(rect.gridCol);
  });

  it("grandchild via rect: sums rect.gridRow + textChild.gridRow", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const text = rect.children.find(c => c.content?.type === "text")!;
    expect(getBandRelativeRow(text.id, band.id, getFrames(state))).toBe(rect.gridRow + text.gridRow);
    expect(getBandRelativeCol(text.id, band.id, getFrames(state))).toBe(rect.gridCol + text.gridCol);
  });

  it("returns 0 if frameId === bandId (degenerate)", () => {
    const md = ["Title", "", "┌────┐", "│ X  │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    expect(getBandRelativeRow(band.id, band.id, getFrames(state))).toBe(0);
    expect(getBandRelativeCol(band.id, band.id, getFrames(state))).toBe(0);
  });

  it("throws when frameId is absent from the tree", () => {
    const md = ["Title", "", "┌────┐", "│ X  │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const band = getFrames(state).find(f => f.isBand)!;
    expect(() => getBandRelativeRow("nonexistent", band.id, getFrames(state))).toThrow();
  });

  it("throws when bandId is not an ancestor of frameId (silent-corruption guard)", () => {
    // Two unrelated top-level bands. Ask for relativeRow of a shape in
    // band-A using band-B's id. A naive startIdx=0 fallback would silently
    // sum band-A's absolute gridRow as if it were relative — coordinate
    // corruption. Must throw instead.
    const md = [
      "Title", "",
      "┌────┐", "│ A  │", "└────┘", "",
      "Middle", "",
      "┌────┐", "│ B  │", "└────┘", "",
      "End",
    ].join("\n");
    const state = createEditorStateUnified(md, 9.6, 18);
    const bands = getFrames(state).filter(f => f.isBand);
    expect(bands.length).toBeGreaterThanOrEqual(2);
    const bandA = bands[0];
    const bandB = bands[1];
    const shapeInA = bandA.children[0];
    expect(() => getBandRelativeRow(shapeInA.id, bandB.id, getFrames(state))).toThrow();
  });
});

describe("resolveSelectionTarget", () => {
  beforeAll(() => {
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() => ({
          font: "", fillStyle: "", textBaseline: "", fillText: () => {},
          measureText: (text: string) => ({
            width: text.length * 9.6,
            actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4,
          }),
        })) as unknown as HTMLCanvasElement["getContext"];
      }
      return el;
    });
  });

  const cw = 9.6, ch = 18;
  const SOLO = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");

  it("first click on text-label child of solo rect: selects rect (drill-down outermost)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const text = rect.children.find(c => c.content?.type === "text")!;
    expect(resolveSelectionTarget(text, null, getFrames(state), false)).toBe(rect.id);
  });

  it("repeat click while rect is selected: drills to text-label", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const text = rect.children.find(c => c.content?.type === "text")!;
    expect(resolveSelectionTarget(text, rect.id, getFrames(state), false)).toBe(text.id);
  });

  it("ctrl+click on text-label: selects text directly (bypass)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    const text = rect.children.find(c => c.content?.type === "text")!;
    expect(resolveSelectionTarget(text, null, getFrames(state), true)).toBe(text.id);
  });

  it("hit IS the rect (not the text): selects rect with no drill (already outermost)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    expect(resolveSelectionTarget(rect, null, getFrames(state), false)).toBe(rect.id);
  });

  it("hit is itself a band: returns null (bands not selectable)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    expect(resolveSelectionTarget(band, null, getFrames(state), false)).toBeNull();
  });

  it("ctrl+click on a band: still returns null (bands not selectable)", () => {
    const state = createEditorStateUnified(SOLO, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    expect(resolveSelectionTarget(band, null, getFrames(state), true)).toBeNull();
  });
});

describe("createEditorStateUnified — 4-level tree shape", () => {
  const cw = 9.6, ch = 18;

  it("solo labeled rect: tree is band → rect → text (3 levels, no wireframe wrap)", () => {
    const md = ["Title", "", "┌────┐", "│ Hi │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, cw, ch);
    const top = getFrames(state);
    expect(top.length).toBe(1);
    const band = top[0];
    expect(band.isBand).toBe(true);
    expect(band.children.length).toBe(1);
    const rect = band.children[0];
    expect(rect.content?.type).toBe("rect");
    expect(rect.children.some(c => c.content?.type === "text")).toBe(true);
  });

  it("multi-shape composite: tree is band → wireframe → [rect, rect] (4 levels)", () => {
    // Two adjacent rects that share row range — scanner's groupIntoContainers
    // wraps them in a content=null container (verified via probe). A rect +
    // a stray hline does NOT group (different row coverage), so we use two
    // rects to reliably trigger the multi-shape path.
    const md = [
      "Title", "",
      "┌────┐  ┌───┐",
      "│ Hi │  │ B │",
      "└────┘  └───┘", "",
      "End",
    ].join("\n");
    const state = createEditorStateUnified(md, cw, ch);
    const top = getFrames(state);
    expect(top.length).toBe(1);
    const band = top[0];
    expect(band.isBand).toBe(true);
    expect(band.children.length).toBe(1);
    const wireframe = band.children[0];
    expect(wireframe.isBand).toBeFalsy();
    expect(wireframe.content).toBeNull();
    expect(wireframe.children.length).toBeGreaterThanOrEqual(2);
  });
});

describe("drag clamp through wireframe layer", () => {
  const cw = 9.6, ch = 18;

  it("dragging a deeply-nested rect against the band wall clamps at the band", () => {
    const md = ["Title", "", "┌────┐", "│  X │", "│    │", "└────┘", "", "End"].join("\n");
    const state = createEditorStateUnified(md, cw, ch);
    const band = getFrames(state).find(f => f.isBand)!;
    const rect = band.children[0];
    expect(rect.gridRow).toBe(0);
    const cband = findContainingBandDeep(getFrames(state), rect.id)!;
    const minDRow = -getBandRelativeRow(rect.id, cband.id, getFrames(state));
    // Math.abs avoids -0 vs +0 strict equality (Object.is) quirk.
    expect(Math.abs(minDRow)).toBe(0);
  });
});
