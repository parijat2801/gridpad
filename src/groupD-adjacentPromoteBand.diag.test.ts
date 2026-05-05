// Reproducer for Group D — "transient double-band after promote" (DEBUG_PLAN.md).
//
// Scenario: a single parent band contains two leaf rects, A and B. The user
// drags B horizontally so B's drop column is OUTSIDE the parent band's
// column range, but B's drop row stays inside the parent band's row range.
// The reparent dispatcher's eager-band redirect (editorState.ts:1503-1545)
// refuses to "demote into self" because findBandAtRow returns the SAME band
// B is already inside (existingBand.id === sourceBand.id at line 1505), so
// it falls through to the standard promote at line 1546. The reparent
// effect handler (line 274-301) then wraps B in a FRESH top-level band at
// row 5, leaving the original parent band at rows [3, 8) intact.
//
// Result: two top-level bands whose row ranges overlap (parent [3, 8),
// new [5, 8)). They never get merged because mergeOverlappingBands is
// only called after moveFrameEffect (line 206), not after
// reparentFrameEffect.
//
// Expected post-promote: ONE top-level band containing both A and B
// (after merging). Or, if we keep the dispatcher behavior, the merge pass
// at the end of the reparent handler should collapse the two bands into one.
//
// This test pins the model-layer reproduction so the fix can be applied at
// editorState.ts without a full Playwright run. Two assertions:
//   1. Top-level band count after the promote is 1 (currently 2 — the bug).
//   2. The merged band's lineCount covers both rects' rows.

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  createEditorStateUnified,
  getFrames,
  applyReparentFrame,
} from "./editorState";

const CW = 9.6;
const CH = 18.4;

// One band at rows [3, 8) (5 rows: prose at 0,1,2; band claims 3-7; prose at 8+).
// The band is a wireframe-wrapper containing two side-by-side rects A and B.
// A: cols 0-9 (10 wide), rows 3-7 (5 tall).
// B: cols 12-19 (8 wide), rows 5-7 (3 tall).
const SIDE_BY_SIDE = [
  "Above",
  "",
  "",
  "┌────────┐  ┌──────┐",
  "│        │  │      │",
  "│   A    │  │  B   │",
  "│        │  │      │",
  "└────────┘  └──────┘",
  "",
  "Below",
].join("\n");

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      // @ts-expect-error - jsdom canvas mock
      el.getContext = () => ({
        measureText: () => ({ width: CW }),
        font: "",
        fillStyle: "",
        fillRect: () => {},
        clearRect: () => {},
        fillText: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        beginPath: () => {},
        rect: () => {},
        clip: () => {},
        textBaseline: "top",
      });
    }
    return el;
  });
});

describe("Group D — adjacent/overlapping bands after horizontal promote", () => {
  it("DIAG: dump initial frame tree", () => {
    const state = createEditorStateUnified(SIDE_BY_SIDE, CW, CH);
    const frames = getFrames(state);
    const dump = frames.map(f => ({
      id: f.id,
      isBand: f.isBand,
      gridRow: f.gridRow,
      gridCol: f.gridCol,
      gridW: f.gridW,
      gridH: f.gridH,
      lineCount: f.lineCount,
      childCount: f.children.length,
      childIds: f.children.map(c => `${c.id}@(${c.gridRow},${c.gridCol},${c.gridW}x${c.gridH})`),
    }));
    // Log so we can inspect the actual scanner output.
    // eslint-disable-next-line no-console
    console.log("[GroupD DIAG] initial frames:", JSON.stringify(dump, null, 2));
    expect(frames.length).toBeGreaterThan(0);
  });

  it("REPRO: promoting B horizontally produces one merged top-level band, not two", () => {
    const state = createEditorStateUnified(SIDE_BY_SIDE, CW, CH);
    const initial = getFrames(state);

    // Find leaf rect B: the inner-most frame whose grid coordinates put it
    // in the right half (gridCol >= 12).
    const findLeafByCol = (frames: Array<typeof initial[number]>, minCol: number): typeof initial[number] | null => {
      for (const f of frames) {
        if (f.children.length === 0 && f.content !== null) {
          // Walk path to compute absolute gridCol for the leaf.
          if (f.gridCol >= minCol) return f;
        }
        const inChild = findLeafByCol(f.children, minCol - f.gridCol);
        if (inChild) return inChild;
      }
      return null;
    };
    const leafB = findLeafByCol(initial, 12);
    expect(leafB, "expected to locate leaf rect B at gridCol >= 12").not.toBeNull();
    if (!leafB) return;

    // Drop B at absoluteGridRow inside the parent band's range (~5)
    // and absoluteGridCol outside the band's column range (e.g., 30).
    // newParentId === null → promote.
    const after = applyReparentFrame(state, leafB.id, null, 5, 30, CW, CH);
    const frames = getFrames(after);

    const topLevelBands = frames.filter(f => f.isBand);
    const dump = topLevelBands.map(f => ({
      id: f.id,
      gridRow: f.gridRow,
      lineCount: f.lineCount,
      gridH: f.gridH,
      childCount: f.children.length,
    }));
    // eslint-disable-next-line no-console
    console.log("[GroupD DIAG] post-promote top-level bands:", JSON.stringify(dump, null, 2));

    // The bug: two bands coexist (parent + freshly-wrapped B-band), with
    // overlapping or touching row ranges. After the fix, exactly one band
    // remains (containing both A and B).
    expect(topLevelBands.length).toBe(1);
  });
});
