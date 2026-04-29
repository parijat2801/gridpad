// TDD red tests for Strategy A — Fix 1 in DEBUG_PLAN.md.
//
// The bug: onMouseDown re-runs resolveSelectionTarget on every mouse-down,
// including the one that starts a drag, silently retargeting the drag from
// the user's selected frame to a deeper descendant.
//
// Strategy A: distinguish drag-start from discrete click via mouse motion.
// On mouse-down, if hit is current selection or descendant, KEEP the
// selection (don't re-resolve). On mouse-up with no movement, drill via
// resolveSelectionTarget. On mouse-down on something unrelated, run the
// rule immediately (existing behavior).
//
// These tests target two pure helpers:
//   isAncestorInTree(frames, ancestorId, descendantId) — strict ancestor
//   decideSelectionForMouseDown(hit, currentSelectedId, frames, ctrlHeld)
//     → { kind: "preserveSelection"; frameId } when hit is current selection
//        or descendant (drag-start should keep current selection)
//     → { kind: "applyRule"; frameId | null } otherwise (run resolveSelectionTarget)

import { describe, it, expect } from "vitest";
import {
  createEditorStateUnified,
  getFrames,
  isAncestorInTree,
  decideSelectionForMouseDown,
  findPath,
} from "./editorState";
import type { Frame } from "./frame";

const cw = 8, ch = 18;

const JUNCTION = `Header

┌───────────┬───────────┐
│  Left     │  Right    │
├───────────┼───────────┤
│  Bottom L │  Bottom R │
└───────────┴───────────┘

Footer`;

const TWO_SEPARATE = `┌──────┐  ┌──────┐
│  A   │  │  B   │
└──────┘  └──────┘`;

function firstLeafShape(frames: Frame[]): Frame | null {
  for (const f of frames) {
    if (!f.isBand && f.content !== null) return f;
    const inChild = firstLeafShape(f.children);
    if (inChild) return inChild;
  }
  return null;
}

// All non-band shape frames in tree order.
function allLeaves(frames: Frame[]): Frame[] {
  const out: Frame[] = [];
  const walk = (fs: Frame[]) => {
    for (const f of fs) {
      if (!f.isBand && f.content !== null) out.push(f);
      walk(f.children);
    }
  };
  walk(frames);
  return out;
}

describe("isAncestorInTree", () => {
  it("returns true when ancestorId is a strict ancestor of descendantId in the band→wireframe→leaf chain", () => {
    const frames = getFrames(createEditorStateUnified(JUNCTION, cw, ch));
    const leaf = firstLeafShape(frames)!;
    const path = findPath(frames, leaf.id);
    // path: [band, wireframe, leaf]. Wireframe is a strict ancestor.
    const wireframe = path.find(f => !f.isBand && f.content === null)!;
    expect(isAncestorInTree(frames, wireframe.id, leaf.id)).toBe(true);
  });

  it("returns false for a frame compared against itself (strict ancestor)", () => {
    const frames = getFrames(createEditorStateUnified(JUNCTION, cw, ch));
    const leaf = firstLeafShape(frames)!;
    expect(isAncestorInTree(frames, leaf.id, leaf.id)).toBe(false);
  });

  it("returns false for siblings (no ancestor relation)", () => {
    const frames = getFrames(createEditorStateUnified(JUNCTION, cw, ch));
    const leaves = allLeaves(frames);
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    const a = leaves[0], b = leaves[1];
    expect(isAncestorInTree(frames, a.id, b.id)).toBe(false);
  });
});

describe("decideSelectionForMouseDown — Strategy A", () => {
  it("drag of currently-selected frame keeps selection on the selected frame", () => {
    // Tree: band → wireframe → rect (JUNCTION first quadrant).
    // Pre-select wireframe. mouse-down hits the rect.
    // Expect: preserveSelection on wireframe.id (NOT drill to rect.id).
    const frames = getFrames(createEditorStateUnified(JUNCTION, cw, ch));
    const leaf = firstLeafShape(frames)!;
    const path = findPath(frames, leaf.id);
    const wireframe = path.find(f => !f.isBand && f.content === null)!;
    // hit = leaf (mouse-down lands inside the inner rect)
    // currentSelectedId = wireframe.id (the user's prior selection)
    const decision = decideSelectionForMouseDown(leaf, wireframe.id, frames, false);
    expect(decision).toEqual({ kind: "preserveSelection", frameId: wireframe.id });
  });

  it("drag of currently-selected leaf (hit === current selection) preserves selection on the leaf", () => {
    const frames = getFrames(createEditorStateUnified(JUNCTION, cw, ch));
    const leaf = firstLeafShape(frames)!;
    // currentSelectedId === hit.id — strictly equal, not a strict ancestor.
    const decision = decideSelectionForMouseDown(leaf, leaf.id, frames, false);
    expect(decision).toEqual({ kind: "preserveSelection", frameId: leaf.id });
  });

  it("click on a sibling frame replaces selection by running the rule (no preserve)", () => {
    // Pre-select rect A (TWO_SEPARATE has two siblings, each its own band/wireframe).
    // Click rect B → not a descendant of A → rule runs.
    const frames = getFrames(createEditorStateUnified(TWO_SEPARATE, cw, ch));
    const leaves = allLeaves(frames);
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    const a = leaves[0], b = leaves[1];
    const decision = decideSelectionForMouseDown(b, a.id, frames, false);
    expect(decision.kind).toBe("applyRule");
    // applyRule must call resolveSelectionTarget, which on a fresh click
    // (currentSelectedId not in chain of B) returns chain[0] (parent-first).
    // The decision's frameId is a non-null id rooted at B's chain.
    expect(decision.frameId).not.toBeNull();
    // Specifically, it must NOT preserve a (sibling, unrelated).
    expect(decision.frameId).not.toBe(a.id);
  });

  it("click with no current selection runs the rule (parent-first per Figma)", () => {
    // No prior selection. Click leaf in JUNCTION. Rule returns chain[0] = wireframe.
    const frames = getFrames(createEditorStateUnified(JUNCTION, cw, ch));
    const leaf = firstLeafShape(frames)!;
    const decision = decideSelectionForMouseDown(leaf, null, frames, false);
    expect(decision.kind).toBe("applyRule");
    // Parent-first: frameId is the wireframe (chain[0] of band→wireframe→leaf
    // after band filter).
    const path = findPath(frames, leaf.id);
    const wireframe = path.find(f => !f.isBand && f.content === null)!;
    expect(decision.frameId).toBe(wireframe.id);
  });

  it("ctrl/cmd-held click bypasses preserve and selects the deepest hit directly", () => {
    // Even with a "would-preserve" geometry (current selection is ancestor of
    // hit), ctrl-held must run the rule (which returns hit.id under ctrl).
    const frames = getFrames(createEditorStateUnified(JUNCTION, cw, ch));
    const leaf = firstLeafShape(frames)!;
    const path = findPath(frames, leaf.id);
    const wireframe = path.find(f => !f.isBand && f.content === null)!;
    const decision = decideSelectionForMouseDown(leaf, wireframe.id, frames, true);
    expect(decision.kind).toBe("applyRule");
    expect(decision.frameId).toBe(leaf.id);
  });
});
