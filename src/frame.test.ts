import { describe, it, expect } from "vitest";
import {
  type Frame,
  createFrame,
  createRectFrame,
  createTextFrame,
  createLineFrame,
  framesToObstacles,
  hitTestFrames,
  moveFrame,
  resizeFrame,
  framesFromRegions,
} from "./frame";
import { layoutTextChildren, reparentChildren, mergeAdjacentTexts } from "./autoLayout";
import { scan } from "./scanner";
import { detectRegions } from "./regions";
import { LIGHT_RECT_STYLE, buildLayersFromScan } from "./layers";

// Pixel dimensions used in tests. These match the fallback constants in
// grid.ts (FALLBACK_CHAR_WIDTH = 9.6, FALLBACK_CHAR_HEIGHT = 18.4) but we
// keep them local so the tests express intent clearly rather than coupling
// to the fallback constants.
const CHAR_W = 9.6;
const CHAR_H = 18.4;

// ── helpers ───────────────────────────────────────────────────────────────

/** Minimal Frame assertion helper */
function expectFrame(f: Frame): void {
  expect(f).toBeDefined();
  expect(typeof f.id).toBe("string");
  expect(f.id.length).toBeGreaterThan(0);
}

// ── createFrame ───────────────────────────────────────────────────────────

describe("createFrame", () => {
  it("creates a container frame with id, x, y, w, h, empty children, null content, clip: true", () => {
    const frame: Frame = createFrame({ x: 10, y: 20, w: 200, h: 100 });

    expectFrame(frame);
    expect(frame.x).toBe(10);
    expect(frame.y).toBe(20);
    expect(frame.w).toBe(200);
    expect(frame.h).toBe(100);
    expect(frame.children).toEqual([]);
    expect(frame.content).toBeNull();
    expect(frame.clip).toBe(true);
  });

  it("assigns a unique id each time", () => {
    const a = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    const b = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    expect(a.id).not.toBe(b.id);
  });
});

// ── createRectFrame ───────────────────────────────────────────────────────

describe("createRectFrame", () => {
  it("creates a frame with rect content (cells from regenerateCells, style stored)", () => {
    // 4 cols wide, 3 rows tall
    const frame: Frame = createRectFrame({
      gridW: 4,
      gridH: 3,
      style: LIGHT_RECT_STYLE,
      charWidth: CHAR_W,
      charHeight: CHAR_H,
    });

    expectFrame(frame);
    expect(frame.content).not.toBeNull();
    expect(frame.content!.type).toBe("rect");
    // style is stored on the content so resize can regenerate cells
    expect(frame.content!.style).toEqual(LIGHT_RECT_STYLE);
    // cells from regenerateCells: corners + edges, no interior
    expect(frame.content!.cells).toBeInstanceOf(Map);
    expect(frame.content!.cells.size).toBeGreaterThan(0);
    // top-left corner character should be ┌
    expect(frame.content!.cells.get("0,0")).toBe("┌");
  });

  it("bbox w/h in pixels = grid w * charWidth, grid h * charHeight", () => {
    const gridW = 5;
    const gridH = 4;
    const frame: Frame = createRectFrame({
      gridW,
      gridH,
      style: LIGHT_RECT_STYLE,
      charWidth: CHAR_W,
      charHeight: CHAR_H,
    });

    expect(frame.w).toBeCloseTo(gridW * CHAR_W);
    expect(frame.h).toBeCloseTo(gridH * CHAR_H);
  });
});

// ── createTextFrame ───────────────────────────────────────────────────────

describe("createTextFrame", () => {
  it("creates a frame with text content and correct pixel dimensions", () => {
    const text = "Hello";
    const frame: Frame = createTextFrame({
      text,
      row: 2,
      col: 3,
      charWidth: CHAR_W,
      charHeight: CHAR_H,
    });

    expectFrame(frame);
    expect(frame.content).not.toBeNull();
    expect(frame.content!.type).toBe("text");
    expect(frame.content!.text).toBe(text);
    // pixel dimensions: text length * charWidth wide, 1 row tall
    expect(frame.w).toBeCloseTo([...text].length * CHAR_W);
    expect(frame.h).toBeCloseTo(CHAR_H);
    // position: col * charWidth, row * charHeight
    expect(frame.x).toBeCloseTo(3 * CHAR_W);
    expect(frame.y).toBeCloseTo(2 * CHAR_H);
  });

  it("handles multi-codepoint text — width is measured in codepoints", () => {
    const text = "AB";
    const frame: Frame = createTextFrame({
      text,
      row: 0,
      col: 0,
      charWidth: CHAR_W,
      charHeight: CHAR_H,
    });

    expect(frame.w).toBeCloseTo(2 * CHAR_W);
  });
});

// ── createLineFrame ───────────────────────────────────────────────────────

describe("createLineFrame", () => {
  it("creates a frame with line content", () => {
    const frame: Frame = createLineFrame({
      r1: 0,
      c1: 0,
      r2: 0,
      c2: 4,
      charWidth: CHAR_W,
      charHeight: CHAR_H,
    });

    expectFrame(frame);
    expect(frame.content).not.toBeNull();
    expect(frame.content!.type).toBe("line");
  });

  it("horizontal line has correct pixel dimensions", () => {
    // 5-cell horizontal line (cols 0-4)
    const frame: Frame = createLineFrame({
      r1: 0,
      c1: 0,
      r2: 0,
      c2: 4,
      charWidth: CHAR_W,
      charHeight: CHAR_H,
    });

    expect(frame.w).toBeCloseTo(5 * CHAR_W);
    expect(frame.h).toBeCloseTo(CHAR_H);
  });

  it("vertical line has correct pixel dimensions", () => {
    // 4-row vertical line (rows 0-3)
    const frame: Frame = createLineFrame({
      r1: 0,
      c1: 2,
      r2: 3,
      c2: 2,
      charWidth: CHAR_W,
      charHeight: CHAR_H,
    });

    expect(frame.content!.type).toBe("line");
    expect(frame.w).toBeCloseTo(CHAR_W);
    expect(frame.h).toBeCloseTo(4 * CHAR_H);
  });

  it("reversed coordinates (r2 < r1 or c2 < c1) still produce positive dimensions", () => {
    const frame: Frame = createLineFrame({
      r1: 3,
      c1: 5,
      r2: 0,
      c2: 0,
      charWidth: CHAR_W,
      charHeight: CHAR_H,
    });

    expect(frame.w).toBeGreaterThan(0);
    expect(frame.h).toBeGreaterThan(0);
  });
});

// ── framesToObstacles ─────────────────────────────────────────────────────

describe("framesToObstacles", () => {
  it("returns obstacles only for top-level frames (not children)", () => {
    const parent: Frame = createFrame({ x: 0, y: 0, w: 300, h: 200 });
    const child: Frame = createFrame({ x: 10, y: 10, w: 50, h: 30 });
    const topLevel: Frame = createFrame({ x: 400, y: 0, w: 100, h: 100 });

    // Attach child to parent
    const parentWithChild: Frame = { ...parent, children: [child] };

    const obstacles = framesToObstacles([parentWithChild, topLevel]);

    // Should only have the two top-level frames as obstacles
    expect(obstacles).toHaveLength(2);
    const ids = obstacles.map((o) => o.id);
    expect(ids).toContain(parentWithChild.id);
    expect(ids).toContain(topLevel.id);
    // Child should NOT appear as an obstacle
    expect(ids).not.toContain(child.id);
  });

  it("returns {x, y, w, h} for each top-level frame", () => {
    const frame: Frame = createFrame({ x: 50, y: 60, w: 120, h: 80 });
    const obstacles = framesToObstacles([frame]);

    expect(obstacles).toHaveLength(1);
    const obs = obstacles[0];
    expect(obs.x).toBe(50);
    expect(obs.y).toBe(60);
    expect(obs.w).toBe(120);
    expect(obs.h).toBe(80);
  });
});

// ── hitTestFrames ─────────────────────────────────────────────────────────

describe("hitTestFrames", () => {
  it("hit inside a single frame returns that frame", () => {
    const frame: Frame = createFrame({ x: 10, y: 10, w: 80, h: 60 });
    const result = hitTestFrames([frame], 50, 40);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(frame.id);
  });

  it("miss outside all frames returns null", () => {
    const frame: Frame = createFrame({ x: 10, y: 10, w: 80, h: 60 });
    const result = hitTestFrames([frame], 200, 200);
    expect(result).toBeNull();
  });

  it("returns deepest child frame that contains the click point", () => {
    const child: Frame = createFrame({ x: 20, y: 20, w: 40, h: 30 });
    const parent: Frame = {
      ...createFrame({ x: 0, y: 0, w: 200, h: 150 }),
      children: [child],
    };

    // Click inside the child
    const result = hitTestFrames([parent], 30, 30);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(child.id);
  });

  it("returns parent frame if click is in parent but not in any child", () => {
    const child: Frame = createFrame({ x: 20, y: 20, w: 40, h: 30 });
    const parent: Frame = {
      ...createFrame({ x: 0, y: 0, w: 200, h: 150 }),
      children: [child],
    };

    // Click inside parent but outside child
    const result = hitTestFrames([parent], 100, 100);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(parent.id);
  });

  it("returns null if click is outside all frames", () => {
    const frame: Frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    const result = hitTestFrames([frame], 500, 500);
    expect(result).toBeNull();
  });

  it("respects frame nesting — click in nested child returns that child, not parent", () => {
    const grandchild: Frame = createFrame({ x: 10, y: 10, w: 20, h: 15 });
    const child: Frame = {
      ...createFrame({ x: 20, y: 20, w: 100, h: 80 }),
      children: [grandchild],
    };
    const parent: Frame = {
      ...createFrame({ x: 0, y: 0, w: 300, h: 200 }),
      children: [child],
    };

    // Click point (31, 31) falls inside grandchild (child-relative: 11, 11)
    // which itself is inside child (parent-relative: 31, 31) which is inside parent
    const result = hitTestFrames([parent], 31, 31);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(grandchild.id);
  });
});

// ── moveFrame ─────────────────────────────────────────────────────────────

describe("moveFrame", () => {
  it("updates frame x, y by delta", () => {
    const frame: Frame = createFrame({ x: 50, y: 100, w: 200, h: 80 });
    const moved = moveFrame(frame, { dx: 10, dy: -20 });

    expect(moved.x).toBe(60);
    expect(moved.y).toBe(80);
  });

  it("does NOT move children (they're relative to parent)", () => {
    const child: Frame = createFrame({ x: 5, y: 5, w: 30, h: 20 });
    const parent: Frame = {
      ...createFrame({ x: 0, y: 0, w: 100, h: 80 }),
      children: [child],
    };

    const moved = moveFrame(parent, { dx: 50, dy: 30 });

    // Parent moves
    expect(moved.x).toBe(50);
    expect(moved.y).toBe(30);
    // Child position unchanged (it's relative to parent)
    expect(moved.children[0].x).toBe(5);
    expect(moved.children[0].y).toBe(5);
  });

  it("returns a new frame object (immutable)", () => {
    const frame: Frame = createFrame({ x: 0, y: 0, w: 100, h: 100 });
    const moved = moveFrame(frame, { dx: 1, dy: 1 });
    expect(moved).not.toBe(frame);
  });
});

// ── resizeFrame ───────────────────────────────────────────────────────────

describe("resizeFrame", () => {
  it("updates frame w, h", () => {
    const frame: Frame = createFrame({ x: 0, y: 0, w: 100, h: 80 });
    const resized = resizeFrame(frame, { w: 200, h: 160 }, CHAR_W, CHAR_H);

    expect(resized.w).toBe(200);
    expect(resized.h).toBe(160);
  });

  it("if frame has rect content with style, regenerates cells at new grid size", () => {
    const frame: Frame = createRectFrame({
      gridW: 4,
      gridH: 3,
      style: LIGHT_RECT_STYLE,
      charWidth: CHAR_W,
      charHeight: CHAR_H,
    });

    // Resize to 6 cols × 5 rows in pixels
    const newW = 6 * CHAR_W;
    const newH = 5 * CHAR_H;
    const resized = resizeFrame(frame, { w: newW, h: newH }, CHAR_W, CHAR_H);

    expect(resized.content).not.toBeNull();
    expect(resized.content!.type).toBe("rect");
    // Cells should be regenerated for the new 6x5 grid
    // Top-right corner should now be at col 5
    expect(resized.content!.cells.get("0,5")).toBe("┐");
    expect(resized.content!.cells.get("0,0")).toBe("┌");
  });

  it("clamps minimum size to 2 cells * charSize", () => {
    const frame: Frame = createFrame({ x: 0, y: 0, w: 100, h: 80 });

    // Try to resize to 1px (less than 2 cells)
    const resized = resizeFrame(frame, { w: 1, h: 1 }, CHAR_W, CHAR_H);

    expect(resized.w).toBeGreaterThanOrEqual(2 * CHAR_W);
    expect(resized.h).toBeGreaterThanOrEqual(2 * CHAR_H);
  });
});

// ── framesFromRegions ─────────────────────────────────────────────────────

describe("framesFromRegions", () => {
  it("given regions from detectRegions, creates a frame tree", () => {
    const text = "┌──────┐\n│      │\n└──────┘";
    const scanResult = scan(text);
    const regions = detectRegions(scanResult);

    const { frames } = framesFromRegions(regions, CHAR_W, CHAR_H, scanResult);

    expect(frames).toBeDefined();
    expect(frames.length).toBeGreaterThan(0);
  });

  it("wireframe region → container frame with child frames for each layer", () => {
    // A wireframe with one rect
    const text = "┌──────┐\n│      │\n└──────┘";
    const scanResult = scan(text);
    const regions = detectRegions(scanResult);
    const { frames } = framesFromRegions(regions, CHAR_W, CHAR_H, scanResult);

    expect(frames).toHaveLength(1);
    const container = frames[0];

    // Container frame wraps the whole wireframe region
    expect(container.children.length).toBeGreaterThan(0);
    // Each layer in the region is a child frame
    const wfRegion = regions[0];
    const regionLayers = buildLayersFromScan(scanResult).filter(l => {
      const layerEndRow = l.bbox.row + l.bbox.h - 1;
      return l.bbox.row >= wfRegion.startRow && layerEndRow <= wfRegion.endRow;
    });
    expect(container.children).toHaveLength(regionLayers.length);
  });

  it("prose regions are NOT frames (just returned as prose text)", () => {
    const text = [
      "# Heading",
      "Some prose text",
      "",
      "┌──┐",
      "│  │",
      "└──┘",
      "",
      "More prose here",
    ].join("\n");

    const scanResult = scan(text);
    const regions = detectRegions(scanResult);
    const result = framesFromRegions(regions, CHAR_W, CHAR_H, scanResult);

    expect(result.frames).toHaveLength(1); // one wireframe region → one container frame
    expect(result.prose).toHaveLength(2);  // two prose regions
    expect(result.prose[0].text).toContain("Heading");
    expect(result.prose[1].text).toContain("More prose");
  });

  it("child frame positions are relative to container frame (not absolute)", () => {
    // Wireframe that starts at a non-zero row in the document. Since
    // detectRegions rebases layer coordinates to region-start, we build
    // a region directly for a rect that sits at rebased row 0.
    const text = [
      "Prose line",
      "",
      "┌──────┐",
      "│      │",
      "└──────┘",
    ].join("\n");

    const scanResult = scan(text);
    const regions = detectRegions(scanResult);
    const { frames } = framesFromRegions(regions, CHAR_W, CHAR_H, scanResult);

    // There should be exactly 1 frame (the wireframe container)
    expect(frames).toHaveLength(1);
    const container = frames[0];

    // Each child frame's position should be within [0, container.w) and
    // [0, container.h) — not using the absolute document row offsets.
    for (const child of container.children) {
      expect(child.x).toBeGreaterThanOrEqual(0);
      expect(child.y).toBeGreaterThanOrEqual(0);
      expect(child.x).toBeLessThan(container.w + 1); // allow 1px tolerance
      expect(child.y).toBeLessThan(container.h + 1);
    }
  });
});

// ── framesFromRegions return type ─────────────────────────────────────────

describe("framesFromRegions return type", () => {
  it("returns a plain object with frames and prose arrays", () => {
    const text = "Hello world\n\n┌──┐\n│  │\n└──┘\n\nGoodbye";
    const scanResult = scan(text);
    const regions = detectRegions(scanResult);
    const result = framesFromRegions(regions, CHAR_W, CHAR_H, scanResult);
    // Should be a plain object, NOT an array
    expect(Array.isArray(result)).toBe(false);
    expect(result.frames).toBeInstanceOf(Array);
    expect(result.prose).toBeInstanceOf(Array);
    expect(result.prose.length).toBeGreaterThan(0);
    expect(result.prose[0]).toHaveProperty("text");
    expect(result.prose[0]).toHaveProperty("startRow");
  });
});

// ── layoutTextChildren ────────────────────────────────────────────────────

/** Build a minimal rect frame with one text child for layoutTextChildren tests. */
function makeRectWithTextChild(params: {
  rectW: number;
  rectH: number;
  childW: number;
  childH: number;
  hAlign?: import("./autoLayout").AlignAnchor;
  vAlign?: import("./autoLayout").VAlignAnchor;
}): Frame {
  const { rectW, rectH, childW, childH, hAlign, vAlign } = params;
  const cells = new Map<string, string>();
  const child: Frame = {
    id: "child-1",
    x: 0,
    y: 0,
    w: childW,
    h: childH,
    z: 0,
    children: [],
    content: { type: "text", cells, text: "x", hAlign, vAlign },
    clip: false,
  };
  return {
    id: "rect-1",
    x: 0,
    y: 0,
    w: rectW,
    h: rectH,
    z: 0,
    children: [child],
    content: { type: "rect", cells: new Map() },
    clip: true,
  };
}

describe("layoutTextChildren", () => {
  it("positions left-aligned text child at charWidth + offset from inner left edge", () => {
    const offset = 10;
    const frame = makeRectWithTextChild({
      rectW: 20 * CHAR_W,
      rectH: 5 * CHAR_H,
      childW: 3 * CHAR_W,
      childH: CHAR_H,
      hAlign: { anchor: "left", offset },
      vAlign: { anchor: "top", offset: 0 },
    });
    const laid = layoutTextChildren(frame, CHAR_W, CHAR_H);
    expect(laid.children[0].x).toBeCloseTo(CHAR_W + offset);
  });

  it("positions center-aligned text child in the horizontal middle", () => {
    const rectW = 20 * CHAR_W;
    const childW = 3 * CHAR_W;
    const innerW = rectW - 2 * CHAR_W;
    const frame = makeRectWithTextChild({
      rectW,
      rectH: 5 * CHAR_H,
      childW,
      childH: CHAR_H,
      hAlign: { anchor: "center", offset: 0 },
      vAlign: { anchor: "top", offset: 0 },
    });
    const laid = layoutTextChildren(frame, CHAR_W, CHAR_H);
    expect(laid.children[0].x).toBeCloseTo(CHAR_W + (innerW - childW) / 2);
  });

  it("positions right-aligned text child at offset from right inner edge", () => {
    const offset = 5;
    const rectW = 20 * CHAR_W;
    const childW = 3 * CHAR_W;
    const innerW = rectW - 2 * CHAR_W;
    const frame = makeRectWithTextChild({
      rectW,
      rectH: 5 * CHAR_H,
      childW,
      childH: CHAR_H,
      hAlign: { anchor: "right", offset },
      vAlign: { anchor: "top", offset: 0 },
    });
    const laid = layoutTextChildren(frame, CHAR_W, CHAR_H);
    expect(laid.children[0].x).toBeCloseTo(CHAR_W + innerW - childW - offset);
  });

  it("clamps position to 0 when offset exceeds available space", () => {
    // Very narrow rect, large offset — should clamp at 0
    const frame = makeRectWithTextChild({
      rectW: 3 * CHAR_W,
      rectH: 3 * CHAR_H,
      childW: 2 * CHAR_W,
      childH: CHAR_H,
      hAlign: { anchor: "left", offset: -9999 },
      vAlign: { anchor: "top", offset: 0 },
    });
    const laid = layoutTextChildren(frame, CHAR_W, CHAR_H);
    expect(laid.children[0].x).toBeGreaterThanOrEqual(0);
  });

  it("returns frame unchanged if content is not a rect", () => {
    const cells = new Map<string, string>();
    const frame: Frame = {
      id: "text-frame",
      x: 0, y: 0, w: 100, h: 50, z: 0,
      children: [],
      content: { type: "text", cells, text: "hi" },
      clip: false,
    };
    const result = layoutTextChildren(frame, CHAR_W, CHAR_H);
    expect(result).toBe(frame);
  });
});

// ── reparentChildren ──────────────────────────────────────────────────────

/** Build a flat Frame[] with a rect and a text child inside it. */
function makeFlatChildren(params: {
  rectX: number;
  rectY: number;
  rectW: number;
  rectH: number;
  textX: number;
  textY: number;
  textW: number;
  textH: number;
}): Frame[] {
  const { rectX, rectY, rectW, rectH, textX, textY, textW, textH } = params;
  const rect: Frame = {
    id: "rect-flat",
    x: rectX,
    y: rectY,
    w: rectW,
    h: rectH,
    z: 0,
    children: [],
    content: { type: "rect", cells: new Map() },
    clip: false,
  };
  const text: Frame = {
    id: "text-flat",
    x: textX,
    y: textY,
    w: textW,
    h: textH,
    z: 0,
    children: [],
    content: { type: "text", cells: new Map(), text: "hi" },
    clip: false,
  };
  return [rect, text];
}

describe("reparentChildren", () => {
  it("moves text child inside enclosing rect and removes it from flat list", () => {
    // Rect: 10 cols × 5 rows at (0,0), text 2 cols at inner offset 1 col, 1 row
    const rectW = 10 * CHAR_W;
    const rectH = 5 * CHAR_H;
    const textX = CHAR_W + CHAR_W; // col 2 = charWidth (border) + charWidth (offset)
    const textY = CHAR_H;          // row 1 = charHeight (border) + 0 offset
    const textW = 2 * CHAR_W;
    const textH = CHAR_H;

    const children = makeFlatChildren({
      rectX: 0, rectY: 0, rectW, rectH,
      textX, textY, textW, textH,
    });

    reparentChildren(children, CHAR_W, CHAR_H);

    // Text should have been removed from top-level list
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe("rect-flat");

    // Text should now be a child of the rect
    const rect = children[0];
    expect(rect.children).toHaveLength(1);
    expect(rect.children[0].id).toBe("text-flat");
  });

  it("infers left alignment for text near the left edge", () => {
    const rectW = 10 * CHAR_W;
    const rectH = 5 * CHAR_H;
    // Text at x = charWidth (border only, at the very left inner edge, clearly left-aligned)
    // innerW = 8 * CHAR_W; distLeft = 0, distRight = 8*CHAR_W - 2*CHAR_W = 6*CHAR_W
    // distCenterH = |(0 - (8*CHAR_W - 2*CHAR_W)/2)| = 3*CHAR_W > 2*CHAR_W tolerance → left
    const textX = CHAR_W;
    const textY = CHAR_H;
    const textW = 2 * CHAR_W;

    const children = makeFlatChildren({
      rectX: 0, rectY: 0, rectW, rectH,
      textX, textY, textW, textH: CHAR_H,
    });

    reparentChildren(children, CHAR_W, CHAR_H);

    const reparentedText = children[0].children[0];
    expect(reparentedText.content?.hAlign?.anchor).toBe("left");
  });

  it("infers center alignment for text centered in rect", () => {
    const rectW = 10 * CHAR_W;
    const rectH = 5 * CHAR_H;
    const innerW = rectW - 2 * CHAR_W;
    const textW = 2 * CHAR_W;
    // Center: x = charWidth (border) + (innerW - textW) / 2
    const textX = CHAR_W + (innerW - textW) / 2;
    const textY = CHAR_H;

    const children = makeFlatChildren({
      rectX: 0, rectY: 0, rectW, rectH,
      textX, textY, textW, textH: CHAR_H,
    });

    reparentChildren(children, CHAR_W, CHAR_H);

    const reparentedText = children[0].children[0];
    expect(reparentedText.content?.hAlign?.anchor).toBe("center");
  });

  it("does not re-parent text that is outside the rect", () => {
    const rectW = 5 * CHAR_W;
    const rectH = 3 * CHAR_H;
    // Text is outside the rect (far to the right)
    const textX = 20 * CHAR_W;
    const textY = 0;
    const textW = 2 * CHAR_W;

    const children = makeFlatChildren({
      rectX: 0, rectY: 0, rectW, rectH,
      textX, textY, textW, textH: CHAR_H,
    });

    reparentChildren(children, CHAR_W, CHAR_H);

    // Both frames remain in flat list; rect has no children
    expect(children).toHaveLength(2);
    expect(children[0].children).toHaveLength(0);
  });

  it("re-parents rect children into enclosing rects", () => {
    // Outer rect: 20 cols × 10 rows at (0,0)
    const outerW = 20 * CHAR_W;
    const outerH = 10 * CHAR_H;
    // Inner rect: 6 cols × 4 rows, positioned inside outer rect
    const innerX = 2 * CHAR_W;
    const innerY = 2 * CHAR_H;
    const innerW = 6 * CHAR_W;
    const innerH = 4 * CHAR_H;

    const outerRect: Frame = {
      id: "outer-rect",
      x: 0, y: 0, w: outerW, h: outerH, z: 0,
      children: [],
      content: { type: "rect", cells: new Map() },
      clip: false,
    };
    const innerRect: Frame = {
      id: "inner-rect",
      x: innerX, y: innerY, w: innerW, h: innerH, z: 0,
      children: [],
      content: { type: "rect", cells: new Map() },
      clip: false,
    };
    const children: Frame[] = [outerRect, innerRect];

    reparentChildren(children, CHAR_W, CHAR_H);

    // Inner rect should be a child of outer rect
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe("outer-rect");
    expect(children[0].children).toHaveLength(1);
    expect(children[0].children[0].id).toBe("inner-rect");
    // Coordinates should be rebased relative to outer rect
    expect(children[0].children[0].x).toBeCloseTo(innerX);
    expect(children[0].children[0].y).toBeCloseTo(innerY);
  });

  it("does not re-parent a rect into itself", () => {
    // A single rect with no other frames — must not become its own child
    const rect: Frame = {
      id: "solo-rect",
      x: 0, y: 0, w: 10 * CHAR_W, h: 5 * CHAR_H, z: 0,
      children: [],
      content: { type: "rect", cells: new Map() },
      clip: false,
    };
    const children: Frame[] = [rect];

    reparentChildren(children, CHAR_W, CHAR_H);

    // Should still have exactly one element, no children added
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe("solo-rect");
    expect(children[0].children).toHaveLength(0);
  });

  it("re-parents into smallest enclosing rect", () => {
    // Outer rect: 20×10, middle rect: 8×6 inside outer, text inside middle
    const outerRect: Frame = {
      id: "outer",
      x: 0, y: 0, w: 20 * CHAR_W, h: 10 * CHAR_H, z: 0,
      children: [],
      content: { type: "rect", cells: new Map() },
      clip: false,
    };
    const middleRect: Frame = {
      id: "middle",
      x: 2 * CHAR_W, y: 2 * CHAR_H,
      w: 8 * CHAR_W, h: 6 * CHAR_H, z: 0,
      children: [],
      content: { type: "rect", cells: new Map() },
      clip: false,
    };
    // Text inside middle rect (center of middle)
    const innerW = 8 * CHAR_W - 2 * CHAR_W;
    const textW = 2 * CHAR_W;
    const textX = 2 * CHAR_W + CHAR_W + (innerW - textW) / 2; // middle.x + border + center offset
    const textY = 2 * CHAR_H + CHAR_H; // middle.y + border
    const text: Frame = {
      id: "inner-text",
      x: textX, y: textY, w: textW, h: CHAR_H, z: 0,
      children: [],
      content: { type: "text", cells: new Map(), text: "hi" },
      clip: false,
    };
    const children: Frame[] = [outerRect, middleRect, text];

    reparentChildren(children, CHAR_W, CHAR_H);

    // Middle rect should be child of outer (smallest enclosing for middle is outer)
    // Text should be child of middle (smallest enclosing for text is middle)
    const outer = children.find(c => c.id === "outer");
    expect(outer).toBeDefined();
    const middle = outer!.children.find(c => c.id === "middle");
    expect(middle).toBeDefined();
    const innerText = middle!.children.find(c => c.id === "inner-text");
    expect(innerText).toBeDefined();
  });
});

// ── mergeAdjacentTexts ────────────────────────────────────────────────────

describe("mergeAdjacentTexts", () => {
  function makeParentWithTexts(texts: Array<{ text: string; x: number; y: number }>): Frame {
    const children: Frame[] = texts.map((t, i) => {
      const codepoints = [...t.text];
      const cells = new Map<string, string>();
      codepoints.forEach((cp, ci) => cells.set(`0,${ci}`, cp));
      return {
        id: `text-${i}`,
        x: t.x,
        y: t.y,
        w: codepoints.length * CHAR_W,
        h: CHAR_H,
        z: 0,
        children: [],
        content: { type: "text", cells, text: t.text },
        clip: false,
      };
    });
    return {
      id: "parent",
      x: 0, y: 0, w: 200, h: 200, z: 0,
      children,
      content: { type: "rect", cells: new Map() },
      clip: true,
    };
  }

  it("merges two text frames on the same row separated by a space", () => {
    // "Create" at x=50, "Account" at x=50 + 6*CHAR_W + 1*CHAR_W (one space gap)
    const createW = 6 * CHAR_W;
    const accountX = 50 + createW + CHAR_W; // one char gap = exactly CHAR_W
    const parent = makeParentWithTexts([
      { text: "Create", x: 50, y: CHAR_H },
      { text: "Account", x: accountX, y: CHAR_H },
    ]);

    mergeAdjacentTexts(parent, CHAR_W, CHAR_H);

    const textChildren = parent.children.filter(c => c.content?.type === "text");
    expect(textChildren).toHaveLength(1);
    expect(textChildren[0].content!.text).toBe("Create Account");
    expect(textChildren[0].x).toBeCloseTo(50);
    // Width spans from x=50 to end of "Account"
    const expectedW = accountX + 7 * CHAR_W - 50;
    expect(textChildren[0].w).toBeCloseTo(expectedW);
  });

  it("does not merge text frames on different rows", () => {
    const parent = makeParentWithTexts([
      { text: "Line1", x: 50, y: CHAR_H },
      { text: "Line2", x: 50, y: 3 * CHAR_H }, // different row
    ]);

    mergeAdjacentTexts(parent, CHAR_W, CHAR_H);

    const textChildren = parent.children.filter(c => c.content?.type === "text");
    expect(textChildren).toHaveLength(2);
  });

  it("does not merge text frames far apart horizontally", () => {
    // "Hello" and "World" separated by 5 * CHAR_W (>> 2 * CHAR_W threshold)
    const helloW = 5 * CHAR_W;
    const worldX = 50 + helloW + 5 * CHAR_W;
    const parent = makeParentWithTexts([
      { text: "Hello", x: 50, y: CHAR_H },
      { text: "World", x: worldX, y: CHAR_H },
    ]);

    mergeAdjacentTexts(parent, CHAR_W, CHAR_H);

    const textChildren = parent.children.filter(c => c.content?.type === "text");
    expect(textChildren).toHaveLength(2);
  });
});

// ── center alignment tolerance ────────────────────────────────────────────

describe("center alignment tolerance", () => {
  it("infers center for text within 2 cells of center", () => {
    // Rect: 20 cols × 5 rows; innerW = 18 * CHAR_W
    // Text: 2 cols wide; perfect center x = CHAR_W + (18*CHAR_W - 2*CHAR_W) / 2 = CHAR_W + 8*CHAR_W
    // Off-by-1-cell from center: x = CHAR_W + 8*CHAR_W + CHAR_W (1 cell right of center)
    // distCenterH = CHAR_W, which is < 2 * CHAR_W → should be center
    const rectW = 20 * CHAR_W;
    const rectH = 5 * CHAR_H;
    const innerW = rectW - 2 * CHAR_W;
    const textW = 2 * CHAR_W;
    const centerX = CHAR_W + (innerW - textW) / 2;
    const offByOne = centerX + CHAR_W; // 1 cell right of center

    const children = makeFlatChildren({
      rectX: 0, rectY: 0, rectW, rectH,
      textX: offByOne, textY: CHAR_H, textW, textH: CHAR_H,
    });

    reparentChildren(children, CHAR_W, CHAR_H);

    const reparentedText = children[0].children[0];
    expect(reparentedText.content?.hAlign?.anchor).toBe("center");
  });

  it("infers left for text clearly near left edge", () => {
    // Rect: 20 cols × 5 rows; text at col 1 (just inside the border)
    // innerW = 18 * CHAR_W; distLeft = 0; distCenterH = 8*CHAR_W >> 2*CHAR_W → left
    const rectW = 20 * CHAR_W;
    const rectH = 5 * CHAR_H;
    const textW = 2 * CHAR_W;
    const textX = CHAR_W; // at the left inner edge (border only), relX = 0

    const children = makeFlatChildren({
      rectX: 0, rectY: 0, rectW, rectH,
      textX, textY: CHAR_H, textW, textH: CHAR_H,
    });

    reparentChildren(children, CHAR_W, CHAR_H);

    const reparentedText = children[0].children[0];
    expect(reparentedText.content?.hAlign?.anchor).toBe("left");
  });
});
