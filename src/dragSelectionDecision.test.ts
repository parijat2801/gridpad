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

// All rect-typed (non-band, non-wireframe) frames in tree order — but
// only those WITHOUT a content text label. Used to pick true siblings
// (text-content children of a rect would otherwise pollute the list).
function allRectShapes(frames: Frame[]): Frame[] {
  const out: Frame[] = [];
  const walk = (fs: Frame[]) => {
    for (const f of fs) {
      if (!f.isBand && f.content?.type === "rect") out.push(f);
      walk(f.children);
    }
  };
  walk(frames);
  return out;
}

// Direct children of a wireframe — these are guaranteed siblings.
function siblingsUnderWireframe(frames: Frame[]): Frame[] {
  const find = (fs: Frame[]): Frame[] | null => {
    for (const f of fs) {
      if (!f.isBand && f.content === null && f.children.length >= 2) {
        return f.children;
      }
      const inChild = find(f.children);
      if (inChild) return inChild;
    }
    return null;
  };
  return find(frames) ?? [];
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
    const sibs = siblingsUnderWireframe(frames);
    expect(sibs.length).toBeGreaterThanOrEqual(2);
    const a = sibs[0], b = sibs[1];
    expect(isAncestorInTree(frames, a.id, b.id)).toBe(false);
    expect(isAncestorInTree(frames, b.id, a.id)).toBe(false);
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
    // TWO_SEPARATE collapses (eager bands) into band → wireframe → [rectA, rectB].
    // Rects share wireframe parent — they are siblings. Pre-select rectA, click
    // rectB. Decision must be applyRule (not preserve), because rectA is not
    // ancestor of rectB.
    const frames = getFrames(createEditorStateUnified(TWO_SEPARATE, cw, ch));
    const rects = allRectShapes(frames);
    expect(rects.length).toBeGreaterThanOrEqual(2);
    const a = rects[0], b = rects[1];
    const decision = decideSelectionForMouseDown(b, a.id, frames, false);
    expect(decision.kind).toBe("applyRule");
    expect(decision.frameId).not.toBeNull();
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
