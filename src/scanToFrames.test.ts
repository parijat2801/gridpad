import { describe, it, expect, beforeAll, vi } from "vitest";
import { scanToFrames } from "./scanToFrames";

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "",
        fillStyle: "",
        textBaseline: "",
        fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      })) as HTMLCanvasElement["getContext"];
    }
    return el;
  });
});

describe("scanToFrames", () => {
  it("pure prose returns no frames and one prose entry", () => {
    const { frames, prose, regions } = scanToFrames("Hello world", 9.6, 18.4);
    expect(frames).toHaveLength(0);
    expect(prose).toHaveLength(1);
    expect(prose[0].text).toBe("Hello world");
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("prose");
  });

  it("single rect returns one container frame with children", () => {
    const { frames, prose, regions } = scanToFrames(
      "┌─┐\n│ │\n└─┘",
      9.6, 18.4,
    );
    expect(frames).toHaveLength(1);
    expect(prose).toHaveLength(0);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("wireframe");
  });

  it("prose before and after wireframe returns frames and two prose entries", () => {
    // Need blank lines to separate prose from wireframe — scanner merges
    // adjacent rows (gap ≤ 2) into a single wireframe range.
    const text = "intro line\n\n\n┌─┐\n│ │\n└─┘\n\n\noutro line";
    const { frames, prose } = scanToFrames(text, 9.6, 18.4);
    expect(frames).toHaveLength(1);
    expect(prose).toHaveLength(2);
  });

  it("empty string returns no frames, no prose, no regions", () => {
    const { frames, prose, regions } = scanToFrames("", 9.6, 18.4);
    expect(frames).toHaveLength(0);
    expect(prose).toHaveLength(0);
    expect(regions).toHaveLength(0);
  });
});
