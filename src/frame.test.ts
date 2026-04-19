// src/frame.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { framesFromScan, type Frame } from "./frame";
import { scan } from "./scanner";

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
