// TDD red tests for Fix 3 — reparent size guard, leaf-vs-leaf.
//
// The bug: onMouseUp's reparent decision compares `draggedFrame` against
// `hitTopLevel` (the destination's containing top-level — a band, post
// eager-bands). Bands are full-width, so the size guard
//   targetIsLarger = hitTopLevel.gridW > draggedFrame.gridW &&
//                    hitTopLevel.gridH > draggedFrame.gridH
// is always true, and equal-size siblings unintentionally nest.
//
// The fix: compare against the LEAF at the drop point (smallest-area
// frame returned by hitTestFrames), not the top-level. Reparent
// destination remains the leaf's containing top-level.
//
// This test targets a pure helper `decideReparent` that takes
// (frames, draggedId, dropPx, dropPy) and returns one of:
//   { kind: "demote"; targetTopLevelId } — drop into a different top-level
//   { kind: "promote" }                  — dropped on empty space, promote out
//   { kind: "none" }                     — guard refused (same-size or same parent)

import { describe, it, expect } from "vitest";
import {
  createEditorStateUnified,
  decideReparent,
  getFrames,
} from "./editorState";
import type { Frame } from "./frame";

const cw = 8, ch = 18;

// Two same-size top-level wireframes separated by prose.
// Each wireframe is wrapped in its own band (eager bands).
const TWO_SAME_SIZE = `Top

┌────┐
│ A  │
└────┘

Middle

┌────┐
│ B  │
└────┘

Bottom`;

// One big wireframe and one small wireframe separated by prose.
const BIG_AND_SMALL = `Above

┌────────────────────────────┐
│                            │
│                            │
│                            │
│                            │
└────────────────────────────┘

between

┌────┐
│ S  │
└────┘

Below`;

// Find a wireframe (rect frame inside a band) whose text-child label matches.
// Tree shape: band → rect(wireframe) → text("A"|"B"). Returns the rect.
function findWireframeByLabel(frames: Frame[], label: string): Frame | null {
  for (const band of frames) {
    for (const wire of band.children) {
      for (const grand of wire.children) {
        if (grand.content?.type !== "text") continue;
        if ((grand.content.text ?? "").trim() === label) return wire;
      }
    }
  }
  return null;
}


// Convert a child frame's relative x/y/w/h to absolute canvas px coords
// by walking from the top-level band downward. Returns the center of the
// frame in absolute canvas pixels.
function absCenter(frames: Frame[], id: string): { px: number; py: number } | null {
  function walk(fs: Frame[], offX: number, offY: number): { px: number; py: number } | null {
    for (const f of fs) {
      const ax = offX + f.x;
      const ay = offY + f.y;
      if (f.id === id) return { px: ax + f.w / 2, py: ay + f.h / 2 };
      const inChild = walk(f.children, ax, ay);
      if (inChild) return inChild;
    }
    return null;
  }
  return walk(frames, 0, 0);
}

describe("decideReparent (mouseup-only, no size guard)", () => {
  it("returns 'demote' when dropping a same-size frame onto another same-size frame (size guard removed)", () => {
    // Pre-revision this returned "none" (Fix 3's size guard rejected
    // same-size targets to prevent accidental nesting from "passing
    // through" during drag). The guard was wrong — decideReparent only
    // runs at mouseup, by which time the cursor is in its FINAL position;
    // a drop INSIDE another frame is unambiguous user intent. Figma
    // allows nesting frames of any relative size.
    const state = createEditorStateUnified(TWO_SAME_SIZE, cw, ch);
    const frames = getFrames(state);
    const wireA = findWireframeByLabel(frames, "A")!;
    const wireB = findWireframeByLabel(frames, "B")!;
    expect(wireA).toBeTruthy();
    expect(wireB).toBeTruthy();
    expect(wireA.gridW).toBe(wireB.gridW);
    expect(wireA.gridH).toBe(wireB.gridH);

    // Drop point: middle of wireB's leaf in absolute canvas coords.
    // Bug G: dropping inside a labeled rect's interior now demotes into
    // the rect itself (Figma-style nesting), not its band wrapper.
    const drop = absCenter(frames, wireB.id)!;
    const decision = decideReparent(frames, wireA.id, drop.px, drop.py, Number.POSITIVE_INFINITY);
    expect(decision.kind).toBe("demote");
    if (decision.kind === "demote") {
      expect(decision.targetTopLevelId).toBe(wireB.id);
    }
  });

  it("returns 'demote' with target top-level when dropping a smaller frame onto a strictly larger frame", () => {
    const state = createEditorStateUnified(BIG_AND_SMALL, cw, ch);
    const frames = getFrames(state);
    // BIG_AND_SMALL: each band wraps one rect (the wireframe). Pick by size.
    const wireframes: Frame[] = [];
    for (const band of frames) {
      for (const c of band.children) {
        if (!c.isBand && c.content?.type === "rect") wireframes.push(c);
      }
    }
    expect(wireframes.length).toBeGreaterThanOrEqual(2);
    const big = wireframes.reduce((a, b) => (a.gridW * a.gridH > b.gridW * b.gridH ? a : b));
    const small = wireframes.reduce((a, b) => (a.gridW * a.gridH < b.gridW * b.gridH ? a : b));
    expect(big.gridW).toBeGreaterThan(small.gridW);
    expect(big.gridH).toBeGreaterThan(small.gridH);

    // Drop small onto big's center (absolute coords). Bug G: target is
    // the big rect itself (Figma-style nest), not big's band wrapper.
    const drop = absCenter(frames, big.id)!;
    const decision = decideReparent(frames, small.id, drop.px, drop.py, Number.POSITIVE_INFINITY);
    expect(decision.kind).toBe("demote");
    if (decision.kind === "demote") {
      expect(decision.targetTopLevelId).toBe(big.id);
    }
  });

  it("returns 'promote' when dropping on empty (no leaf at drop point)", () => {
    const state = createEditorStateUnified(TWO_SAME_SIZE, cw, ch);
    const frames = getFrames(state);
    const wireA = findWireframeByLabel(frames, "A")!;
    expect(wireA).toBeTruthy();

    // Drop far below the doc, off any frame entirely.
    // Pass POSITIVE_INFINITY as docExtentPy so the doc-bound guard does not
    // suppress promote — this test specifically exercises the promote path.
    const dropPx = 50 * cw;
    const dropPy = 200 * ch;
    const decision = decideReparent(frames, wireA.id, dropPx, dropPy, Number.POSITIVE_INFINITY);
    expect(decision.kind).toBe("promote");
  });

  it("returns 'none' when the drop point hits the same top-level the dragged frame is already in", () => {
    const state = createEditorStateUnified(TWO_SAME_SIZE, cw, ch);
    const frames = getFrames(state);
    const wireA = findWireframeByLabel(frames, "A")!;
    expect(wireA).toBeTruthy();

    // Drop on wireA itself (same top-level → no reparent).
    const drop = absCenter(frames, wireA.id)!;
    const decision = decideReparent(frames, wireA.id, drop.px, drop.py, Number.POSITIVE_INFINITY);
    expect(decision.kind).toBe("none");
  });
});
