// TDD red tests for Fix 10 — Home / End keys in prose mode.
//
// Probe (INV3 in DEBUG_PLAN.md): pressing Home in prose mode does not
// move the prose cursor. The Home handler in DemoV2.tsx targets text-
// edit mode (inside a text frame), but there's no Home handler for
// the prose cursor. So `clickProse(5, y) → Home → Backspace` fires
// Backspace at the click column, not at column 0 — deleting the wrong
// character.
//
// These tests target two pure helpers:
//   proseMoveToLineStart(state) — move cursor to col=0 of current row
//   proseMoveToLineEnd(state)   — move cursor to last col of current row

import { describe, it, expect } from "vitest";
import {
  createEditorStateUnified,
  proseMoveToLineStart,
  proseMoveToLineEnd,
  getCursor,
  moveCursorTo,
} from "./editorState";

describe("proseMoveToLineStart — Fix 10", () => {
  it("moves cursor from mid-line to col=0 of same row", () => {
    let state = createEditorStateUnified("hello\nworld", 8, 18);
    state = moveCursorTo(state, { row: 1, col: 3 });
    expect(getCursor(state)).toEqual({ row: 1, col: 3 });
    state = proseMoveToLineStart(state);
    expect(getCursor(state)).toEqual({ row: 1, col: 0 });
  });

  it("is a no-op when cursor is already at col=0", () => {
    let state = createEditorStateUnified("hello\nworld", 8, 18);
    state = moveCursorTo(state, { row: 0, col: 0 });
    state = proseMoveToLineStart(state);
    expect(getCursor(state)).toEqual({ row: 0, col: 0 });
  });

  it("moves to col=0 on the same row, not previous row's end", () => {
    let state = createEditorStateUnified("abc\ndef", 8, 18);
    state = moveCursorTo(state, { row: 1, col: 2 });
    state = proseMoveToLineStart(state);
    expect(getCursor(state)).toEqual({ row: 1, col: 0 });
  });
});

describe("proseMoveToLineEnd — Fix 10", () => {
  it("moves cursor to the last col of current row", () => {
    let state = createEditorStateUnified("hello\nworld", 8, 18);
    state = moveCursorTo(state, { row: 0, col: 0 });
    state = proseMoveToLineEnd(state);
    expect(getCursor(state)).toEqual({ row: 0, col: 5 });
  });

  it("on a blank line, stays at col=0", () => {
    let state = createEditorStateUnified("a\n\nb", 8, 18);
    state = moveCursorTo(state, { row: 1, col: 0 });
    state = proseMoveToLineEnd(state);
    expect(getCursor(state)).toEqual({ row: 1, col: 0 });
  });
});
