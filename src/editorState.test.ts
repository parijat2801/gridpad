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
} from "./editorState";
import { createFrame, createTextFrame, createRectFrame, type Frame } from "./frame";

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

  it("drag down by 3 relocates claimed lines, updates docOffset", () => {
    // Frame at doc lines 2-4 (docOffset=6, lineCount=3), drag down past "World"
    // Expected result: "Hello\nWorld\n\n\n\nEnd"
    // Frame ends up at doc lines 3-5 (from=12)
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld\nEnd";
    const { state, frame } = makeState(text);
    expect(frame.lineCount).toBe(3);
    expect(state.doc.lines).toBe(6);

    const updated = applyMoveFrame(state, frame.id, 0, 3, cw, ch);

    // Line count preserved
    expect(updated.doc.lines).toBe(state.doc.lines);
    // Doc matches expected layout
    expect(getDoc(updated)).toBe("Hello\nWorld\n\n\n\nEnd");
    // Frame docOffset points to start of first claimed line in new position
    const updatedFrame = getFrames(updated)[0];
    expect(updatedFrame.docOffset).toBe(12);
    // Verify doc.lineAt(docOffset) is an empty line (still claimed)
    expect(updated.doc.lineAt(updatedFrame.docOffset).text).toBe("");
  });

  it("drag up by 1 relocates claimed lines, updates docOffset", () => {
    // Frame at doc lines 3-4 (docOffset=4, lineCount=2), drag up by 1
    // Expected result: "A\n\n\nB\nC"
    // Frame ends up at doc lines 2-3 (from=2)
    const text = "A\nB\n┌─┐\n└─┘\nC";
    const { state, frame } = makeState(text);
    expect(frame.lineCount).toBe(2);
    expect(state.doc.lines).toBe(5);

    const updated = applyMoveFrame(state, frame.id, 0, -1, cw, ch);

    expect(updated.doc.lines).toBe(state.doc.lines);
    expect(getDoc(updated)).toBe("A\n\n\nB\nC");
    const updatedFrame = getFrames(updated)[0];
    expect(updatedFrame.docOffset).toBe(2);
    expect(updated.doc.lineAt(updatedFrame.docOffset).text).toBe("");
  });

  it("drag down + undo restores pre-drag doc and docOffset", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld\nEnd";
    const { state, frame } = makeState(text);
    const preDragDoc = getDoc(state);
    const preDragOffset = frame.docOffset;

    const dragged = applyMoveFrame(state, frame.id, 0, 3, cw, ch);
    expect(getDoc(dragged)).not.toBe(preDragDoc);

    const restored = editorUndo(dragged);
    expect(getDoc(restored)).toBe(preDragDoc);
    const restoredFrame = getFrames(restored)[0];
    expect(restoredFrame.docOffset).toBe(preDragOffset);
  });

  it("drag up + undo restores pre-drag doc and docOffset", () => {
    const text = "A\nB\n┌─┐\n└─┘\nC";
    const { state, frame } = makeState(text);
    const preDragDoc = getDoc(state);
    const preDragOffset = frame.docOffset;

    const dragged = applyMoveFrame(state, frame.id, 0, -1, cw, ch);
    expect(getDoc(dragged)).not.toBe(preDragDoc);

    const restored = editorUndo(dragged);
    expect(getDoc(restored)).toBe(preDragDoc);
    const restoredFrame = getFrames(restored)[0];
    expect(restoredFrame.docOffset).toBe(preDragOffset);
  });

  it("undoDepth === 1 after a single drag", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld\nEnd";
    const { state, frame } = makeState(text);
    const dragged = applyMoveFrame(state, frame.id, 0, 3, cw, ch);
    // The drag (doc change + frame effect) should land as exactly one history entry.
    expect(undoDepth(dragged)).toBe(1);
  });

  it("redo after undo restores post-drag state", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld\nEnd";
    const { state, frame } = makeState(text);
    const postDrag = applyMoveFrame(state, frame.id, 0, 3, cw, ch);
    const postDragDoc = getDoc(postDrag);

    const undone = editorUndo(postDrag);
    const redone = editorRedo(undone);
    expect(getDoc(redone)).toBe(postDragDoc);
    const redoneFrame = getFrames(redone)[0];
    expect(redoneFrame.docOffset).toBe(12);
  });

  it("drag then prose-edit then undo twice — each undo is independent", () => {
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld\nEnd";
    const { state, frame } = makeState(text);
    const preDragDoc = getDoc(state);

    // Step 1: drag
    const afterDrag = applyMoveFrame(state, frame.id, 0, 3, cw, ch);
    const afterDragDoc = getDoc(afterDrag);

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
    const text = "Hello\n┌────┐\n│ Bx │\n└────┘\nWorld\nEnd";
    const { state, frame } = makeState(text);
    const snapshotOffset = frame.docOffset; // 6

    const dragged = applyMoveFrame(state, frame.id, 0, 3, cw, ch);
    const undone = editorUndo(dragged);

    const undoneFrame = getFrames(undone)[0];
    // Must match the exact snapshot — restoreFramesEffect overrides mapPos.
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
});
