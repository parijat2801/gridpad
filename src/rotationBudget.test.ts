// TDD red tests for Fix 14 — no crossing prose lines.
//
// Bug: when dragging a wireframe down past a non-blank prose line or
// another band's claim, the rotation handler should clamp at the wall.
// Currently it stops only at non-blank prose; another band's claim is
// not treated as a wall, so dragging across produces ghosts/merges.
//
// computeRotationBudget(frames, doc, frameId) → { maxUp, maxDown }
//
// Walks doc lines around the frame's claim, stops at the first row that
// is EITHER non-blank OR claimed by a different top-level band. Returns
// the max number of rows the frame can rotate up/down before hitting a
// wall.

import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import {
  createEditorStateUnified,
  getFrames,
  getDoc,
  computeRotationBudget,
} from "./editorState";

const cw = 9.6, ch = 18;

describe("computeRotationBudget — Fix 14", () => {
  it("blank lines above and below give symmetric budget", () => {
    // 2 blanks above, 2 blanks below.
    const FIX = "Top\n\n\n┌────┐\n│    │\n└────┘\n\n\nBottom";
    const state = createEditorStateUnified(FIX, cw, ch);
    const frames = getFrames(state);
    const id = frames[0].id;
    const doc = Text.of(getDoc(state).split("\n"));
    const { maxUp, maxDown } = computeRotationBudget(frames, doc, id);
    expect(maxUp).toBe(2);
    expect(maxDown).toBe(2);
  });

  it("non-blank prose line directly adjacent gives zero budget", () => {
    // No blank lines between Prose and the wireframe.
    const FIX = "Prose above\n┌────┐\n│    │\n└────┘\nProse below";
    const state = createEditorStateUnified(FIX, cw, ch);
    const frames = getFrames(state);
    const id = frames[0].id;
    const doc = Text.of(getDoc(state).split("\n"));
    const { maxUp, maxDown } = computeRotationBudget(frames, doc, id);
    expect(maxUp).toBe(0);
    expect(maxDown).toBe(0);
  });

  it("blank then prose: budget = blank-line count, prose is the wall", () => {
    // 1 blank, then "Middle", then 1 blank, then second wireframe.
    const FIX = "Top\n\n┌────┐\n│ A  │\n└────┘\n\nMiddle\n\n┌────┐\n│ B  │\n└────┘\n\nBottom";
    const state = createEditorStateUnified(FIX, cw, ch);
    const frames = getFrames(state);
    const idA = frames[0].id;
    const doc = Text.of(getDoc(state).split("\n"));
    const { maxUp, maxDown } = computeRotationBudget(frames, doc, idA);
    expect(maxUp, "1 blank above 'Top' line — but 'Top' is non-blank → 1").toBe(1);
    expect(maxDown, "1 blank below A, then 'Middle' wall → 1").toBe(1);
  });

  it("another band's claim acts as a wall (no crossing)", () => {
    // Two wireframes separated only by blank lines. Without prose between,
    // the budget for A's down-motion should still be bounded by where B's
    // claim starts — A must not enter B's rows.
    const FIX = "Top\n\n┌────┐\n│ A  │\n└────┘\n\n\n┌────┐\n│ B  │\n└────┘\n\nBottom";
    const state = createEditorStateUnified(FIX, cw, ch);
    const frames = getFrames(state);
    const idA = frames[0].id;
    const doc = Text.of(getDoc(state).split("\n"));
    const { maxDown } = computeRotationBudget(frames, doc, idA);
    // Lines 5, 6 are blank; line 7 starts B's claim. Budget = 2 blanks.
    expect(maxDown, "stops at B's claim, not eats it").toBe(2);
  });

  it("doc start acts as a wall for upward rotation", () => {
    // Wireframe starts immediately at line 0 (no header).
    const FIX = "┌────┐\n│    │\n└────┘\n\nProse";
    const state = createEditorStateUnified(FIX, cw, ch);
    const frames = getFrames(state);
    const id = frames[0].id;
    const doc = Text.of(getDoc(state).split("\n"));
    const { maxUp } = computeRotationBudget(frames, doc, id);
    expect(maxUp).toBe(0);
  });

  it("doc end acts as a wall for downward rotation", () => {
    // Wireframe is the last block — no trailing blanks.
    const FIX = "Header\n\n┌────┐\n│    │\n└────┘";
    const state = createEditorStateUnified(FIX, cw, ch);
    const frames = getFrames(state);
    const id = frames[0].id;
    const doc = Text.of(getDoc(state).split("\n"));
    const { maxDown } = computeRotationBudget(frames, doc, id);
    expect(maxDown).toBe(0);
  });

  it("returns 0/0 for non-claiming frame (lineCount=0)", () => {
    // Defensive: a child rect inside a band has lineCount=0. The helper
    // is only meaningful for top-level claiming frames; for children it
    // should return zero budget so callers don't accidentally rotate them.
    const FIX = "Top\n\n┌──┐\n│A │\n└──┘\n\nBottom";
    const state = createEditorStateUnified(FIX, cw, ch);
    const frames = getFrames(state);
    // Find a child rect (not the band itself).
    const band = frames[0];
    expect(band.children.length).toBeGreaterThan(0);
    const childId = band.children[0].id;
    const doc = Text.of(getDoc(state).split("\n"));
    const { maxUp, maxDown } = computeRotationBudget(frames, doc, childId);
    expect(maxUp).toBe(0);
    expect(maxDown).toBe(0);
  });
});
