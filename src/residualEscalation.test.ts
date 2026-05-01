// TDD red tests for Fix 5 — residual escalation guard.
//
// The bug: when a child rect inside a band is at the band's edge
// (clampedDRow === 0) but the user keeps dragging past it (residualDRow
// !== 0), the current code escalates the residual to a band-level
// moveFrameEffect, rotating the band. That's wrong when the user's
// intent is "move within band, hit edge, stop".
//
// The fix: only escalate residual when the gesture has had at least one
// tick with clampedDRow !== 0 (meaningful clamped motion). If the rect
// was at the wall from tick 1, drop the residual silently.
//
// Targets a pure helper:
//   shouldEscalateResidual(clampedDRow, residualDRow, gestureHadClampedMotion): boolean

import { describe, it, expect } from "vitest";
import { shouldEscalateResidual } from "./editorState";

describe("shouldEscalateResidual — Fix 5", () => {
  it("returns false when there is no residual at all", () => {
    expect(shouldEscalateResidual(2, 0, false, 3, 1)).toBe(false);
    expect(shouldEscalateResidual(0, 0, false, 3, 1)).toBe(false);
    expect(shouldEscalateResidual(2, 0, true, 3, 1)).toBe(false);
  });

  it("returns false for single-rect band with slack when clampedDRow=0 AND no prior clamped motion (rect at wall from start)", () => {
    expect(shouldEscalateResidual(0, 5, false, 3, 1)).toBe(false);
    expect(shouldEscalateResidual(0, -5, false, 3, 1)).toBe(false);
  });

  it("returns true when current tick has clamped motion and residual exists (user dragging past edge mid-gesture)", () => {
    expect(shouldEscalateResidual(2, 3, false, 3, 1)).toBe(true);
    expect(shouldEscalateResidual(-1, -2, false, 3, 1)).toBe(true);
  });

  it("returns true when gesture has had clamped motion previously, even if this tick clampedDRow=0 (continued drag past edge)", () => {
    expect(shouldEscalateResidual(0, 3, true, 3, 1)).toBe(true);
    expect(shouldEscalateResidual(0, -3, true, 3, 1)).toBe(true);
  });

  it("returns true unconditionally when bandSlackRows === 0 AND bandSiblings === 1 (single-wireframe band)", () => {
    // A top-level wireframe wrapped in its own band has zero slack: the
    // rect fills the band exactly, so clampedDRow is always 0 and all
    // motion arrives as residual. Without this branch, the user couldn't
    // drag a top-level frame at all.
    expect(shouldEscalateResidual(0, 5, false, 0, 1)).toBe(true);
    expect(shouldEscalateResidual(0, -5, false, 0, 1)).toBe(true);
    expect(shouldEscalateResidual(0, 1, true, 0, 1)).toBe(true);
  });

  it("returns false for multi-child band even when bandSlackRows === 0 (siblings must stay independent)", () => {
    // Side-by-side rects in one band: the band has 2+ children, each
    // filling the band vertically. A drag of one rect past the wall
    // must NOT rotate the band — that would move the sibling.
    expect(shouldEscalateResidual(0, 5, false, 0, 2)).toBe(false);
    expect(shouldEscalateResidual(0, -5, false, 0, 2)).toBe(false);
    expect(shouldEscalateResidual(0, 5, true, 0, 2)).toBe(false);
    expect(shouldEscalateResidual(0, 5, false, 0, 3)).toBe(false);
  });
});
