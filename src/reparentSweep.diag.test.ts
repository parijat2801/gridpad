// Diagnostic sweep: does drag-based reparent ACTUALLY work?
//
// User report (2026-05-06): "The only way to parent something right now is to
// draw in an existing frame. There is no RE parenting at all." After the
// Bug F fix (commit 7c235be), decideReparent should return
// `kind: "demote"` for any drop on a sibling wireframe in the same band, and
// applyReparentFrame should nest the dragged frame as a child. This test
// verifies both halves of that pipeline across multiple geometries to find
// where the chain is broken.
//
// Each scenario:
//   1. Build an editor state from an ASCII fixture.
//   2. Pick a "dragged" leaf and a "drop point" (px, py) inside the target
//      wireframe's bbox.
//   3. Call decideReparent — verify kind === "demote" and targetTopLevelId
//      points at the intended container.
//   4. Call applyReparentFrame — verify the dragged frame ends up as a
//      child of the target container in the resulting frame tree.
//
// Diagnostic dumps print decideReparent's output and the post-apply frame
// tree so the failing layer is obvious.

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  createEditorStateUnified,
  getFrames,
  applyReparentFrame,
  decideReparent,
  findFrameInList,
} from "./editorState";
import type { Frame } from "./frame";

const CW = 9.6;
const CH = 18.4;

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

// Walk the tree and find the rect frame whose grid-coord bbox matches the
// requested signature. A "rect frame" is any frame with content?.type ===
// "rect" — including ones that carry text-label children (the scanner
// emits Login-rect with a "Login" text child). Excluded: bands, empty
// wireframes, text-only frames.
function findLeafByGrid(
  frames: Frame[],
  pred: (absRow: number, absCol: number, gridH: number, gridW: number) => boolean,
): { frame: Frame; absRow: number; absCol: number } | null {
  const walk = (
    fs: Frame[],
    parentRow: number,
    parentCol: number,
  ): { frame: Frame; absRow: number; absCol: number } | null => {
    for (const f of fs) {
      const absRow = parentRow + f.gridRow;
      const absCol = parentCol + f.gridCol;
      if (f.content?.type === "rect" && !f.isBand) {
        if (pred(absRow, absCol, f.gridH, f.gridW)) return { frame: f, absRow, absCol };
      }
      const inChild = walk(f.children, absRow, absCol);
      if (inChild) return inChild;
    }
    return null;
  };
  return walk(frames, 0, 0);
}

// Pretty-print frame tree for diagnostic output.
function dumpTree(frames: Frame[], indent = ""): string[] {
  const out: string[] = [];
  for (const f of frames) {
    const kind = f.isBand ? "band" : (f.content === null ? "wireframe" : "leaf");
    out.push(
      `${indent}${kind} ${f.id} grid=(${f.gridRow},${f.gridCol},${f.gridW}x${f.gridH}) lc=${f.lineCount} children=${f.children.length}`,
    );
    if (f.children.length > 0) {
      out.push(...dumpTree(f.children, indent + "  "));
    }
  }
  return out;
}

// Walk the full tree and find the absolute parent (immediate) of frameId.
function findParentOf(frames: Frame[], frameId: string): Frame | null {
  for (const f of frames) {
    if (f.children.some(c => c.id === frameId)) return f;
    const inChild = findParentOf(f.children, frameId);
    if (inChild) return inChild;
  }
  return null;
}

describe("Reparent sweep: drag-based reparent across geometries", () => {
  // Fixture 1: User-flow row — 4 leaf rects connected by horizontal lines,
  // all inside ONE top-level band (the line glyphs make them siblings).
  const USER_FLOW = [
    "Above",
    "",
    "┌─────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐",
    "│  Login  ├────┤ Dashboard ├────┤ Settings ├────┤  Logout  │",
    "└─────────┘    └───────────┘    └──────────┘    └──────────┘",
    "",
    "Below",
  ].join("\n");

  // Fixture 2: Two side-by-side standalone wireframes (no connecting lines).
  // Two top-level wireframes share a band, no children inside either.
  const SIDE_BY_SIDE = [
    "Above",
    "",
    "",
    "┌────────┐  ┌──────────┐",
    "│        │  │          │",
    "│   A    │  │    B     │",
    "│        │  │          │",
    "└────────┘  └──────────┘",
    "",
    "Below",
  ].join("\n");

  // Fixture 3: One small box and one BIG empty wireframe in the same band.
  // Drag the small one onto the big empty wireframe — Figma-style nesting.
  const SMALL_INTO_BIG = [
    "Above",
    "",
    "┌──────────────────────────────┐",
    "│                              │",
    "│                              │",
    "│                              │   ┌──────┐",
    "│                              │   │ tiny │",
    "│                              │   └──────┘",
    "│                              │",
    "└──────────────────────────────┘",
    "",
    "Below",
  ].join("\n");

  it("DIAG: dump initial frame tree for each fixture", async () => {
    const fs = await import("fs");
    const lines: string[] = [];
    for (const [name, src] of [
      ["USER_FLOW", USER_FLOW] as const,
      ["SIDE_BY_SIDE", SIDE_BY_SIDE] as const,
      ["SMALL_INTO_BIG", SMALL_INTO_BIG] as const,
    ]) {
      const state = createEditorStateUnified(src, CW, CH);
      const frames = getFrames(state);
      lines.push(`=== ${name} initial tree ===`);
      lines.push(...dumpTree(frames));
      lines.push("");
    }
    fs.writeFileSync("/tmp/reparent-sweep-dump.txt", lines.join("\n"));
    expect(true).toBe(true);
  });

  it("USER_FLOW: drag Login onto Dashboard → expect Login to become child of Dashboard's container", () => {
    const state = createEditorStateUnified(USER_FLOW, CW, CH);
    const frames = getFrames(state);

    // Login is the leftmost leaf rect (absCol around 0). Dashboard is the
    // second leaf (absCol around 15).
    const login = findLeafByGrid(frames, (_r, c, _h, w) => c < 12 && w >= 9);
    const dashboard = findLeafByGrid(frames, (_r, c, _h, w) => c >= 13 && c < 30 && w >= 11);
    expect(login, "Login leaf").not.toBeNull();
    expect(dashboard, "Dashboard leaf").not.toBeNull();
    if (!login || !dashboard) return;

    // Drop point: center of Dashboard.
    const dropPx = (dashboard.absCol + dashboard.frame.gridW / 2) * CW;
    const dropPy = (dashboard.absRow + dashboard.frame.gridH / 2) * CH;
    const docExtentPy = state.doc.lines * CH;
    const draggedGridH = login.frame.gridH;
    const proseRows = new Set<number>();
    for (let i = 1; i <= state.doc.lines; i++) {
      if (state.doc.line(i).length > 0) proseRows.add(i - 1);
    }
    const decision = decideReparent(
      frames, login.frame.id, dropPx, dropPy, docExtentPy,
      { aRow: dashboard.absRow, gridH: draggedGridH, proseRows },
      { aRow: dashboard.absRow, gridH: draggedGridH },
    );

    // eslint-disable-next-line no-console
    console.log("[Sweep DIAG] USER_FLOW decideReparent:", JSON.stringify(decision));

    expect(decision.kind, "decideReparent should return 'demote'").toBe("demote");
    if (decision.kind !== "demote") return;

    const after = applyReparentFrame(
      state, login.frame.id, decision.targetTopLevelId, dashboard.absRow, dashboard.absCol, CW, CH,
    );
    const afterFrames = getFrames(after);
    // eslint-disable-next-line no-console
    console.log(`[Sweep DIAG] USER_FLOW post-apply:\n${dumpTree(afterFrames).join("\n")}`);

    // Assertion: Login must now be inside the target container.
    const loginParent = findParentOf(afterFrames, login.frame.id);
    expect(loginParent, "Login must have a parent in the new tree").not.toBeNull();
    expect(loginParent?.id, `Login's parent must be the demote target ${decision.targetTopLevelId}`).toBe(decision.targetTopLevelId);
  });

  it("SIDE_BY_SIDE: drag A's leaf onto B's wireframe → A's leaf becomes child of B's wireframe", () => {
    const state = createEditorStateUnified(SIDE_BY_SIDE, CW, CH);
    const frames = getFrames(state);

    const leafA = findLeafByGrid(frames, (_r, c, _h, w) => c < 8 && w >= 8);
    const leafB = findLeafByGrid(frames, (_r, c, _h, w) => c >= 10 && w >= 10);
    expect(leafA, "leaf A").not.toBeNull();
    expect(leafB, "leaf B").not.toBeNull();
    if (!leafA || !leafB) return;

    const dropPx = (leafB.absCol + leafB.frame.gridW / 2) * CW;
    const dropPy = (leafB.absRow + leafB.frame.gridH / 2) * CH;
    const docExtentPy = state.doc.lines * CH;
    const draggedGridH = leafA.frame.gridH;
    const proseRows = new Set<number>();
    for (let i = 1; i <= state.doc.lines; i++) {
      if (state.doc.line(i).length > 0) proseRows.add(i - 1);
    }
    const decision = decideReparent(
      frames, leafA.frame.id, dropPx, dropPy, docExtentPy,
      { aRow: leafB.absRow, gridH: draggedGridH, proseRows },
      { aRow: leafB.absRow, gridH: draggedGridH },
    );
    // eslint-disable-next-line no-console
    console.log("[Sweep DIAG] SIDE_BY_SIDE decideReparent:", JSON.stringify(decision));

    expect(decision.kind).toBe("demote");
    if (decision.kind !== "demote") return;

    const after = applyReparentFrame(
      state, leafA.frame.id, decision.targetTopLevelId, leafB.absRow, leafB.absCol, CW, CH,
    );
    const afterFrames = getFrames(after);
    // eslint-disable-next-line no-console
    console.log(`[Sweep DIAG] SIDE_BY_SIDE post-apply:\n${dumpTree(afterFrames).join("\n")}`);

    const aParent = findParentOf(afterFrames, leafA.frame.id);
    expect(aParent?.id).toBe(decision.targetTopLevelId);
  });

  it("SMALL_INTO_BIG: drag tiny rect into the big rect → tiny becomes child of big rect (Bug G)", () => {
    const state = createEditorStateUnified(SMALL_INTO_BIG, CW, CH);
    const frames = getFrames(state);

    // Big labeled rect: ~30 wide, ~7 tall, abs col 0. The scanner emits
    // this as a content?.type === "rect" leaf — Bug G's fix lets it act
    // as a drop target for nested children.
    const big = findLeafByGrid(frames, (_r, c, h, w) => c < 5 && w >= 28 && h >= 6);
    const tiny = findLeafByGrid(frames, (_r, c, _h, w) => c >= 30 && w <= 8);
    expect(big, "big rect").not.toBeNull();
    expect(tiny, "tiny rect").not.toBeNull();
    if (!big || !tiny) return;

    // Drop point: center of the big rect's interior.
    const dropPx = (big.absCol + big.frame.gridW / 2) * CW;
    const dropPy = (big.absRow + big.frame.gridH / 2) * CH;
    const docExtentPy = state.doc.lines * CH;
    const draggedGridH = tiny.frame.gridH;
    const proseRows = new Set<number>();
    for (let i = 1; i <= state.doc.lines; i++) {
      if (state.doc.line(i).length > 0) proseRows.add(i - 1);
    }
    const decision = decideReparent(
      frames, tiny.frame.id, dropPx, dropPy, docExtentPy,
      { aRow: big.absRow + 1, gridH: draggedGridH, proseRows },
      { aRow: big.absRow + 1, gridH: draggedGridH },
    );
    // eslint-disable-next-line no-console
    console.log("[Sweep DIAG] SMALL_INTO_BIG decideReparent:", JSON.stringify(decision));

    expect(decision.kind).toBe("demote");
    if (decision.kind !== "demote") return;
    expect(decision.targetTopLevelId, "target should be the big rect itself, not its outer wireframe wrapper").toBe(big.frame.id);

    const after = applyReparentFrame(
      state, tiny.frame.id, decision.targetTopLevelId, big.absRow + 1, big.absCol + 2, CW, CH,
    );
    const afterFrames = getFrames(after);
    // eslint-disable-next-line no-console
    console.log(`[Sweep DIAG] SMALL_INTO_BIG post-apply:\n${dumpTree(afterFrames).join("\n")}`);

    // tiny should be a descendant of big.
    const tinyParent = findParentOf(afterFrames, tiny.frame.id);
    expect(tinyParent, "tiny should have a parent").not.toBeNull();
    // Either tiny is direct child of big, OR child of a wireframe inside big.
    const findInTree = (f: Frame, targetId: string): boolean => {
      if (f.id === targetId) return true;
      for (const c of f.children) {
        if (findInTree(c, targetId)) return true;
      }
      return false;
    };
    const bigInAfter = findFrameInList(afterFrames, big.frame.id);
    expect(bigInAfter, "big wireframe should still exist").not.toBeNull();
    if (!bigInAfter) return;
    const tinyIsInsideBig = findInTree(bigInAfter, tiny.frame.id);
    expect(tinyIsInsideBig, "tiny must end up inside big wireframe's subtree").toBe(true);
  });

  it("Bug G clamp: edge-flush drop into rect parent insets child by ≥1 cell from each border", () => {
    // Drop tiny rect at the EXACT top-left corner of big rect's bbox. The
    // clamp in applyReparentFrame's demote branch must inset the child so
    // its top-left lands at parent-relative (1, 1), not (0, 0). Otherwise
    // the inner rect's top-left ┌ glyph would overwrite the outer rect's
    // border.
    const state = createEditorStateUnified(SMALL_INTO_BIG, CW, CH);
    const frames = getFrames(state);

    const big = findLeafByGrid(frames, (_r, c, h, w) => c < 5 && w >= 28 && h >= 6);
    const tiny = findLeafByGrid(frames, (_r, c, _h, w) => c >= 30 && w <= 8);
    expect(big, "big rect").not.toBeNull();
    expect(tiny, "tiny rect").not.toBeNull();
    if (!big || !tiny) return;

    // Drop coords requesting the top-left CORNER of big (flush against
    // border).  Without the clamp, child would be placed at (0, 0).
    const flushAbsRow = big.absRow;
    const flushAbsCol = big.absCol;

    const after = applyReparentFrame(
      state, tiny.frame.id, big.frame.id, flushAbsRow, flushAbsCol, CW, CH,
    );
    const afterFrames = getFrames(after);
    // eslint-disable-next-line no-console
    console.log(`[Sweep DIAG] CLAMP post-apply:\n${dumpTree(afterFrames).join("\n")}`);

    const bigAfter = findFrameInList(afterFrames, big.frame.id);
    expect(bigAfter, "big rect should still exist").not.toBeNull();
    if (!bigAfter) return;
    const tinyChild = bigAfter.children.find(c => c.id === tiny.frame.id);
    expect(tinyChild, "tiny must be a direct child of big after demote").not.toBeUndefined();
    if (!tinyChild) return;

    // Top-left padding ≥ 1 cell.
    expect(tinyChild.gridRow, "child gridRow must be ≥ 1 (top border padding)").toBeGreaterThanOrEqual(1);
    expect(tinyChild.gridCol, "child gridCol must be ≥ 1 (left border padding)").toBeGreaterThanOrEqual(1);
    // Bottom-right padding ≥ 1 cell: child's far edge must leave the
    // parent's border row/col untouched.
    expect(tinyChild.gridRow + tinyChild.gridH, "child bottom must leave ≥1 cell before parent bottom border")
      .toBeLessThanOrEqual(bigAfter.gridH - 1);
    expect(tinyChild.gridCol + tinyChild.gridW, "child right must leave ≥1 cell before parent right border")
      .toBeLessThanOrEqual(bigAfter.gridW - 1);
  });
});
