// src/frame.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { framesFromScan, createFrame, createRectFrame, createTextFrame, createLineFrame, moveFrame, resizeFrame, type Frame } from "./frame";
import { scan } from "./scanner";
import { scanToFrames } from "./scanToFrames";

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "", fillStyle: "", textBaseline: "", fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      })) as unknown as HTMLCanvasElement["getContext"];
    }
    return el;
  });
});

const CW = 9.6;
const CH = 18.4;

describe("framesFromScan", () => {
  it("single rect produces one frame at absolute grid position (no container)", () => {
    const scanResult = scan("┌──┐\n│  │\n└──┘");
    const frames = framesFromScan(scanResult, CW, CH);
    expect(frames).toHaveLength(1);
    // Single rect is NOT wrapped in a container
    expect(frames[0].x).toBe(0);
    expect(frames[0].y).toBe(0);
    expect(frames[0].w).toBe(4 * CW);
    expect(frames[0].h).toBe(3 * CH);
    expect(frames[0].dirty).toBe(false);
    expect(frames[0].content).not.toBeNull();
    expect(frames[0].content?.type).toBe("rect");
  });

  it("rect offset from origin has correct absolute position", () => {
    const text = "\n\n  ┌──┐\n  │  │\n  └──┘";
    const scanResult = scan(text);
    const frames = framesFromScan(scanResult, CW, CH);
    expect(frames).toHaveLength(1);
    expect(frames[0].x).toBe(2 * CW);
    expect(frames[0].y).toBe(2 * CH);
  });

  it("excludes base-type layers (unclaimed chars)", () => {
    const scanResult = scan("Hello\n\n┌──┐\n│  │\n└──┘");
    const frames = framesFromScan(scanResult, CW, CH);
    expect(frames).toHaveLength(1);
    expect(frames[0].content?.type).toBe("rect");
  });

  it("nested rects get reparented via reparentChildren", () => {
    const text = [
      "┌────────────────────────┐",
      "│  Outer                 │",
      "│  ┌──────────────────┐  │",
      "│  │  Inner           │  │",
      "│  └──────────────────┘  │",
      "└────────────────────────┘",
    ].join("\n");
    const scanResult = scan(text);
    const frames = framesFromScan(scanResult, CW, CH);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const outerRect = frames.find(f => f.content?.type === "rect" && f.children.length > 0);
    expect(outerRect).toBeDefined();
  });

  it("text labels become text-type frames", () => {
    const text = "┌──────────────┐\n│    Hello     │\n└──────────────┘";
    const scanResult = scan(text);
    const frames = framesFromScan(scanResult, CW, CH);
    const allFrames: Frame[] = [];
    const collectFrames = (fs: Frame[]) => {
      for (const f of fs) { allFrames.push(f); collectFrames(f.children); }
    };
    collectFrames(frames);
    const textFrame = allFrames.find(f => f.content?.type === "text");
    expect(textFrame).toBeDefined();
    expect(textFrame!.content!.text).toBe("Hello");
  });

  it("pure prose (no shapes) returns empty array", () => {
    const scanResult = scan("Just some text");
    const frames = framesFromScan(scanResult, CW, CH);
    expect(frames).toHaveLength(0);
  });

  it("side-by-side rects are grouped into a container", () => {
    const text = [
      "┌──────┐  ┌──────┐",
      "│  A   │  │  B   │",
      "└──────┘  └──────┘",
    ].join("\n");
    const scanResult = scan(text);
    const frames = framesFromScan(scanResult, CW, CH);
    // Side-by-side rects on same rows → grouped into one container
    expect(frames).toHaveLength(1);
    expect(frames[0].content).toBeNull(); // container
    expect(frames[0].clip).toBe(true);
    // Children are the two rects
    const rectChildren = frames[0].children.filter(c => c.content?.type === "rect");
    expect(rectChildren.length).toBe(2);
  });
});

describe("grid-first frames", () => {
  it("Frame has grid coordinate fields", () => {
    const f = createFrame({ x: 0, y: 0, w: 96, h: 36.8 });
    expect(f).toHaveProperty("gridRow");
    expect(f).toHaveProperty("gridCol");
    expect(f).toHaveProperty("gridW");
    expect(f).toHaveProperty("gridH");
    expect(typeof f.gridRow).toBe("number");
    expect(typeof f.gridCol).toBe("number");
    expect(typeof f.gridW).toBe("number");
    expect(typeof f.gridH).toBe("number");
  });

  it("createRectFrame sets gridW and gridH", () => {
    const CW = 9.6, CH = 18.4;
    const f = createRectFrame({ gridW: 10, gridH: 5, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: CW, charHeight: CH });
    expect(f.gridW).toBe(10);
    expect(f.gridH).toBe(5);
    expect(f.gridRow).toBe(0);
    expect(f.gridCol).toBe(0);
  });

  it("createTextFrame sets grid coords from row/col", () => {
    const CW = 9.6, CH = 18.4;
    const f = createTextFrame({ text: "Hello", row: 3, col: 5, charWidth: CW, charHeight: CH });
    expect(f.gridRow).toBe(3);
    expect(f.gridCol).toBe(5);
    expect(f.gridW).toBe(5);
    expect(f.gridH).toBe(1);
  });

  it("createLineFrame sets grid coords from bbox", () => {
    const CW = 9.6, CH = 18.4;
    const f = createLineFrame({ r1: 2, c1: 3, r2: 2, c2: 8, charWidth: CW, charHeight: CH });
    expect(f.gridRow).toBe(2);
    expect(f.gridCol).toBe(3);
    expect(f.gridW).toBe(6);
    expect(f.gridH).toBe(1);
  });

  it("framesFromScan sets grid coords on all content frames", () => {
    const CW = 9.6, CH = 18.4;
    const { frames } = scanToFrames("Prose\n\n┌──────┐\n│      │\n└──────┘\n\nEnd", CW, CH);
    const check = (fs: Frame[]) => {
      for (const f of fs) {
        if (f.content) {
          expect(f.gridW, `frame ${f.id} gridW`).toBeGreaterThan(0);
          expect(f.gridH, `frame ${f.id} gridH`).toBeGreaterThan(0);
        }
        check(f.children);
      }
    };
    check(frames);
  });

  it("groupIntoContainers sets container grid coords from children union", () => {
    const CW = 9.6, CH = 18.4;
    const text = "Header\n\n┌───────────┬───────────┐\n│  Left     │  Right    │\n├───────────┼───────────┤\n│  Bottom L │  Bottom R │\n└───────────┴───────────┘\n\nFooter";
    const { frames } = scanToFrames(text, CW, CH);
    // Junction produces a container wrapping multiple rects
    const container = frames.find(f => !f.content && f.children.length > 0);
    expect(container).toBeDefined();
    expect(container!.gridW).toBeGreaterThan(0);
    expect(container!.gridH).toBeGreaterThan(0);
    expect(container!.gridRow).toBeGreaterThanOrEqual(0);
    expect(container!.gridCol).toBeGreaterThanOrEqual(0);
  });

  it("moveFrame updates grid coords by cell delta", () => {
    const f = createRectFrame({ gridW: 8, gridH: 4, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: CW, charHeight: CH });
    const placed = { ...f, gridRow: 5, gridCol: 3, x: 3 * CW, y: 5 * CH };
    const moved = moveFrame(placed, { dCol: 2, dRow: 1, charWidth: CW, charHeight: CH });
    expect(moved.gridRow).toBe(6);
    expect(moved.gridCol).toBe(5);
    expect(moved.x).toBeCloseTo(5 * CW);
    expect(moved.y).toBeCloseTo(6 * CH);
  });

  it("resizeFrame updates grid dimensions", () => {
    const f = createRectFrame({ gridW: 8, gridH: 4, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: CW, charHeight: CH });
    const resized = resizeFrame(f, { gridW: 10, gridH: 6 }, CW, CH);
    expect(resized.gridW).toBe(10);
    expect(resized.gridH).toBe(6);
    expect(resized.w).toBeCloseTo(10 * CW);
    expect(resized.h).toBeCloseTo(6 * CH);
  });
});
