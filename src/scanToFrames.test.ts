// src/scanToFrames.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
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

describe("scanToFrames (grid-based)", () => {
  it("returns originalGrid as the scanner's grid", () => {
    const { originalGrid } = scanToFrames("Hello\n┌─┐\n└─┘", 9.6, 18.4);
    expect(originalGrid).toHaveLength(3);
    expect(originalGrid[0].join("")).toBe("Hello");
  });

  it("returns proseSegments instead of prose/regions", () => {
    const result = scanToFrames("Hello world", 9.6, 18.4);
    expect(result.proseSegments).toBeDefined();
    expect(result.proseSegments[0]).toEqual({ row: 0, col: 0, text: "Hello world" });
    // Old fields should not exist
    expect((result as any).prose).toBeUndefined();
    expect((result as any).regions).toBeUndefined();
  });

  it("pure prose returns no frames", () => {
    const { frames, proseSegments } = scanToFrames("Hello world", 9.6, 18.4);
    expect(frames).toHaveLength(0);
    expect(proseSegments.length).toBeGreaterThan(0);
  });

  it("single rect returns frames at absolute positions", () => {
    const { frames, proseSegments } = scanToFrames("┌─┐\n│ │\n└─┘", 9.6, 18.4);
    expect(frames).toHaveLength(1);
    // No prose segments inside the rect
    expect(proseSegments).toHaveLength(0);
  });

  it("prose + wireframe returns both", () => {
    const text = "Hello\n\n┌──┐\n│  │\n└──┘\n\nWorld";
    const { frames, proseSegments } = scanToFrames(text, 9.6, 18.4);
    expect(frames.length).toBeGreaterThan(0);
    expect(proseSegments.some(s => s.text === "Hello")).toBe(true);
    expect(proseSegments.some(s => s.text === "World")).toBe(true);
  });

  it("empty string returns empty everything", () => {
    const { frames, proseSegments, originalGrid } = scanToFrames("", 9.6, 18.4);
    expect(frames).toHaveLength(0);
    expect(proseSegments).toHaveLength(0);
    expect(originalGrid).toHaveLength(0);
  });
});
