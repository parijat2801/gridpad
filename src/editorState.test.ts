// src/editorState.test.ts
// Tests for editorState.ts — Phase 3 plan verification.

import { describe, it, expect } from "vitest";
import {
  createEditorState,
  getDoc,
  getFrames,
  getTool,
  getRegions,
  getProseParts,
  getCursor,
  proseInsert,
  proseDeleteBefore,
  moveCursorTo,
  applyMoveFrame,
  applyResizeFrame,
  applyAddFrame,
  applyDeleteFrame,
  setTool,
  editorUndo,
  editorRedo,
  rowColToPos,
  posToRowCol,
  undoDepth,
  redoDepth,
  type CursorPos,
  type ProsePart,
} from "./editorState";
import { createFrame } from "./frame";
import type { Region } from "./regions";

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyState(prose = "") {
  return createEditorState({ prose, frames: [], regions: [], proseParts: [] });
}

function makeRegion(type: "prose" | "wireframe", startRow: number, endRow: number, text = ""): Region {
  return { type, startRow, endRow, text };
}

// ── Task 1: createEditorState ────────────────────────────────────────────────

describe("createEditorState", () => {
  it("stores the initial prose as the doc", () => {
    const state = createEditorState({
      prose: "Hello world",
      frames: [],
      regions: [],
      proseParts: [],
    });
    expect(getDoc(state)).toBe("Hello world");
  });

  it("stores the provided frames", () => {
    const frame = createFrame({ x: 10, y: 20, w: 100, h: 50 });
    const state = createEditorState({
      prose: "",
      frames: [frame],
      regions: [],
      proseParts: [],
    });
    const frames = getFrames(state);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(frame.id);
    expect(frames[0].x).toBe(10);
    expect(frames[0].y).toBe(20);
  });

  it("defaults tool to 'select'", () => {
    const state = emptyState();
    expect(getTool(state)).toBe("select");
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

  it("stores regions", () => {
    const region = makeRegion("prose", 0, 2, "hello");
    const state = createEditorState({
      prose: "hello",
      frames: [],
      regions: [region],
      proseParts: [],
    });
    const regions = getRegions(state);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("prose");
    expect(regions[0].startRow).toBe(0);
  });

  it("stores proseParts", () => {
    const parts: ProsePart[] = [{ startRow: 0, text: "hello" }];
    const state = createEditorState({
      prose: "hello",
      frames: [],
      regions: [],
      proseParts: parts,
    });
    const stored = getProseParts(state);
    expect(stored).toHaveLength(1);
    expect(stored[0].startRow).toBe(0);
    expect(stored[0].text).toBe("hello");
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
  it("moves a frame by delta", () => {
    const frame = createFrame({ x: 10, y: 20, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    const s1 = applyMoveFrame(s0, frame.id, 5, 10);
    const frames = getFrames(s1);
    expect(frames[0].x).toBe(15);
    expect(frames[0].y).toBe(30);
  });

  it("does not affect other frames", () => {
    const f1 = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const f2 = createFrame({ x: 100, y: 100, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [f1, f2], regions: [], proseParts: [] });
    const s1 = applyMoveFrame(s0, f1.id, 5, 5);
    const frames = getFrames(s1);
    const moved = frames.find((f) => f.id === f1.id)!;
    const unchanged = frames.find((f) => f.id === f2.id)!;
    expect(moved.x).toBe(5);
    expect(unchanged.x).toBe(100);
  });

  it("negative delta moves frame left/up", () => {
    const frame = createFrame({ x: 50, y: 50, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    const s1 = applyMoveFrame(s0, frame.id, -10, -20);
    const frames = getFrames(s1);
    expect(frames[0].x).toBe(40);
    expect(frames[0].y).toBe(30);
  });
});

describe("applyResizeFrame", () => {
  it("resizes a frame to new dimensions", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    const s1 = applyResizeFrame(s0, frame.id, 200, 100, 10, 20);
    const frames = getFrames(s1);
    expect(frames[0].w).toBe(200);
    expect(frames[0].h).toBe(100);
  });

  it("enforces minimum size", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    // charWidth=10, charHeight=20 → minW=20, minH=40
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
    const s0 = createEditorState({ prose: "", frames: [f1], regions: [], proseParts: [] });
    const f2 = createFrame({ x: 100, y: 0, w: 50, h: 50 });
    const s1 = applyAddFrame(s0, f2);
    expect(getFrames(s1)).toHaveLength(2);
  });
});

describe("applyDeleteFrame", () => {
  it("removes the frame with the given id", () => {
    const frame = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    const s1 = applyDeleteFrame(s0, frame.id);
    expect(getFrames(s1)).toHaveLength(0);
  });

  it("does not remove other frames", () => {
    const f1 = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const f2 = createFrame({ x: 100, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [f1, f2], regions: [], proseParts: [] });
    const s1 = applyDeleteFrame(s0, f1.id);
    const frames = getFrames(s1);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(f2.id);
  });

  it("is a no-op when id does not exist", () => {
    const frame = createFrame({ x: 0, y: 0, w: 50, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    const s1 = applyDeleteFrame(s0, "nonexistent-id");
    expect(getFrames(s1)).toHaveLength(1);
  });
});

describe("setTool", () => {
  it("changes the active tool", () => {
    const s0 = emptyState();
    const s1 = setTool(s0, "rect");
    expect(getTool(s1)).toBe("rect");
  });

  it("can cycle through all tools", () => {
    let state = emptyState();
    state = setTool(state, "rect");
    expect(getTool(state)).toBe("rect");
    state = setTool(state, "line");
    expect(getTool(state)).toBe("line");
    state = setTool(state, "text");
    expect(getTool(state)).toBe("text");
    state = setTool(state, "select");
    expect(getTool(state)).toBe("select");
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
    const frame = createFrame({ x: 10, y: 20, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    const s1 = applyMoveFrame(s0, frame.id, 5, 10);
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
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    const s1 = applyDeleteFrame(s0, frame.id);
    expect(getFrames(s1)).toHaveLength(0);
  });

  it("frame move is recorded in undo stack via invertedEffects", () => {
    const frame = createFrame({ x: 10, y: 20, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    const s1 = applyMoveFrame(s0, frame.id, 5, 10);
    expect(undoDepth(s1)).toBeGreaterThan(0);
  });

  it("editorUndo reverts frame move", () => {
    const frame = createFrame({ x: 10, y: 20, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "", frames: [frame], regions: [], proseParts: [] });
    const s1 = applyMoveFrame(s0, frame.id, 5, 10);
    expect(getFrames(s1)[0].x).toBe(15);
    const s2 = editorUndo(s1);
    expect(getFrames(s2)[0].x).toBe(10);
  });
});

describe("interleaved undo — type then move frame", () => {
  it("undo reverts most recent operation (frame move), then text", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "hello", frames: [frame], regions: [], proseParts: [] });

    // Step 1: type "!"
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    expect(getDoc(s1)).toBe("hello!");

    // Step 2: move frame
    const s2 = applyMoveFrame(s1, frame.id, 10, 0);
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

// ── Task 6: Tool/regions/proseParts fields ────────────────────────────────────

describe("regions field", () => {
  it("getRegions returns the initial regions", () => {
    const r1 = makeRegion("prose", 0, 2, "line1\nline2");
    const r2 = makeRegion("wireframe", 3, 6, "+--+");
    const state = createEditorState({
      prose: "line1\nline2",
      frames: [],
      regions: [r1, r2],
      proseParts: [],
    });
    const regions = getRegions(state);
    expect(regions).toHaveLength(2);
    expect(regions[0].type).toBe("prose");
    expect(regions[1].type).toBe("wireframe");
  });

  it("regions persist across prose edits", () => {
    const region = makeRegion("prose", 0, 1, "hello");
    const s0 = createEditorState({
      prose: "hello",
      frames: [],
      regions: [region],
      proseParts: [],
    });
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    // regions are not auto-updated by prose edits — they persist
    expect(getRegions(s1)).toHaveLength(1);
    expect(getRegions(s1)[0].type).toBe("prose");
  });

  it("regions persist across undo", () => {
    const region = makeRegion("prose", 0, 1, "hello");
    const s0 = createEditorState({
      prose: "hello",
      frames: [],
      regions: [region],
      proseParts: [],
    });
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    const s2 = editorUndo(s1);
    // After undo, prose reverts but regions should still be present
    expect(getRegions(s2)).toHaveLength(1);
  });
});

describe("proseParts field", () => {
  it("getProseParts returns the initial proseParts", () => {
    const parts: ProsePart[] = [
      { startRow: 0, text: "paragraph one" },
      { startRow: 5, text: "paragraph two" },
    ];
    const state = createEditorState({
      prose: "paragraph one\n\nparagraph two",
      frames: [],
      regions: [],
      proseParts: parts,
    });
    const stored = getProseParts(state);
    expect(stored).toHaveLength(2);
    expect(stored[0].startRow).toBe(0);
    expect(stored[1].startRow).toBe(5);
  });

  it("proseParts persist across undo", () => {
    const parts: ProsePart[] = [{ startRow: 0, text: "hello" }];
    const s0 = createEditorState({
      prose: "hello",
      frames: [],
      regions: [],
      proseParts: parts,
    });
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    const s2 = editorUndo(s1);
    expect(getProseParts(s2)).toHaveLength(1);
  });
});

describe("tool NOT in undo stack", () => {
  it("setTool does not create an undo entry", () => {
    const s0 = emptyState("hello");
    // setTool should NOT add to undo history (no addToHistory annotation)
    const s1 = setTool(s0, "rect");
    const depthAfterTool = undoDepth(s1);

    // Undo should not revert the tool change
    const s2 = editorUndo(s1);
    // If tool is not in undo stack, undo has nothing to do
    expect(undoDepth(s2)).toBe(depthAfterTool);
  });

  it("tool change is NOT undone by undo (tool is never in undo stack)", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    const s0 = createEditorState({ prose: "hi", frames: [frame], regions: [], proseParts: [] });

    // Make a prose change (goes in history)
    const s1 = proseInsert(s0, { row: 0, col: 2 }, "!");
    expect(getDoc(s1)).toBe("hi!");
    const depthAfterInsert = undoDepth(s1);

    // Change tool (should NOT go in history)
    const s2 = setTool(s1, "rect");
    expect(getTool(s2)).toBe("rect");
    // tool change must not affect undoDepth
    expect(undoDepth(s2)).toBe(depthAfterInsert);

    // Undo the prose insert
    const s3 = editorUndo(s2);
    expect(getDoc(s3)).toBe("hi");

    // Tool should NOT have reverted — it was never in history
    expect(getTool(s3)).toBe("rect");
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
