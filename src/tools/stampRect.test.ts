import { describe, it, expect } from "vitest";
import { stampRect } from "./stampRect";

describe("stampRect", () => {
  it("stamps a 3x3 rect at origin", () => {
    const text = "          \n          \n          ";
    const result = stampRect(text, { row: 0, col: 0, w: 3, h: 3 });
    const lines = result.split("\n");
    expect(lines[0].slice(0, 3)).toBe("┌─┐");
    expect(lines[1][0]).toBe("│");
    expect(lines[1][2]).toBe("│");
    expect(lines[2].slice(0, 3)).toBe("└─┘");
  });

  it("stamps a rect at an offset", () => {
    const text = "          \n          \n          \n          ";
    const result = stampRect(text, { row: 1, col: 2, w: 4, h: 2 });
    const lines = result.split("\n");
    expect(lines[1].slice(2, 6)).toBe("┌──┐");
    expect(lines[2].slice(2, 6)).toBe("└──┘");
  });

  it("returns original text for rect < 2x2", () => {
    const text = "     ";
    expect(stampRect(text, { row: 0, col: 0, w: 1, h: 1 })).toBe(text);
  });

  it("pads only affected rows, not entire document", () => {
    const text = "ab\ncd\nef";
    const result = stampRect(text, { row: 0, col: 5, w: 3, h: 2 });
    const lines = result.split("\n");
    expect(lines[0].length).toBeGreaterThanOrEqual(8);
    expect(lines[2]).toBe("ef");
  });
});
