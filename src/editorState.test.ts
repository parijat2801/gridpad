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
import { createFrame, createTextFrame, type Frame } from "./frame";

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
