import { describe, it, expect } from "vitest";
import { detectRegions } from "./regions";
import { scan } from "./scanner";

describe("detectRegions", () => {
  it("pure prose file → single prose region", () => {
    const text = "Hello world\nThis is prose\nMore text";
    const result = scan(text);
    const regions = detectRegions(result);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("prose");
    expect(regions[0].text).toBe(text);
  });

  it("pure wireframe → single wireframe region", () => {
    const text = "┌──┐\n│  │\n└──┘";
    const result = scan(text);
    const regions = detectRegions(result);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("wireframe");
    expect(regions[0].startRow).toBe(0);
    expect(regions[0].endRow).toBe(2);
  });

  it("prose then wireframe then prose → three regions", () => {
    const text = [
      "# Title",
      "Some description",
      "",
      "┌──────┐",
      "│ Box  │",
      "└──────┘",
      "",
      "More prose below",
    ].join("\n");
    const result = scan(text);
    const regions = detectRegions(result);
    expect(regions).toHaveLength(3);
    expect(regions[0].type).toBe("prose");
    expect(regions[1].type).toBe("wireframe");
    expect(regions[2].type).toBe("prose");
    // 1-row margin around rect at rows 3-5 → wireframe region is rows 2-6
    expect(regions[1].startRow).toBe(2);
    expect(regions[1].endRow).toBe(6);
  });

  it("adjacent wireframes within 2 rows merge into one region", () => {
    const text = [
      "┌──┐",
      "└──┘",
      "",
      "┌──┐",
      "└──┘",
    ].join("\n");
    const result = scan(text);
    const regions = detectRegions(result);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("wireframe");
  });

  it("empty input → empty regions", () => {
    const result = scan("");
    const regions = detectRegions(result);
    expect(regions).toHaveLength(0);
  });

  it("prose regions carry their original text slice", () => {
    const text = "Line one\nLine two\n\n┌─┐\n└─┘\n\nLine six";
    const result = scan(text);
    const regions = detectRegions(result);
    const proseRegions = regions.filter(r => r.type === "prose");
    expect(proseRegions.length).toBe(2);
    expect(proseRegions[0].text).toContain("Line one");
    expect(proseRegions[1].text).toContain("Line six");
  });

  it("markdown --- (ASCII dashes) is NOT treated as wireframe", () => {
    const text = "# Title\n---\nSome prose";
    const result = scan(text);
    const regions = detectRegions(result);
    // --- uses ASCII dash, not box-drawing ─, so entire file is prose
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("prose");
  });
});
