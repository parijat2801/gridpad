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
