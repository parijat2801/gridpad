import { describe, it, expect, vi, beforeAll } from "vitest";
import { buildGlyphAtlas } from "./grid";

// jsdom doesn't support canvas 2d context. Mock it.
beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as any).getContext = () => ({
        font: "",
        fillStyle: "",
        textBaseline: "",
        fillText: () => {},
        measureText: () => ({ width: 0 }),
      });
    }
    return el;
  });
});

describe("buildGlyphAtlas", () => {
  it("creates atlas with all printable ASCII and box-drawing chars", () => {
    const atlas = buildGlyphAtlas(10, 18);
    expect(atlas.canvas).toBeDefined();
    expect(atlas.cellWidth).toBe(10);
    expect(atlas.cellHeight).toBe(18);
    // Printable ASCII
    expect(atlas.glyphs.has("A")).toBe(true);
    expect(atlas.glyphs.has(" ")).toBe(true);
    expect(atlas.glyphs.has("~")).toBe(true);
    // Box-drawing
    expect(atlas.glyphs.has("\u250C")).toBe(true);
    expect(atlas.glyphs.has("\u2500")).toBe(true);
    expect(atlas.glyphs.has("\u2502")).toBe(true);
    // Each glyph has sx, sy coordinates
    const a = atlas.glyphs.get("A")!;
    expect(typeof a.sx).toBe("number");
    expect(typeof a.sy).toBe("number");
  });

  it("total glyph count = 95 ASCII + 128 box-drawing = 223", () => {
    const atlas = buildGlyphAtlas(10, 18);
    expect(atlas.glyphs.size).toBe(223);
  });
});
