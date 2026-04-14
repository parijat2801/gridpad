import { describe, it, expect } from "vitest";
import { stampLine } from "./stampLine";

describe("stampLine", () => {
  it("stamps a horizontal line", () => {
    const text = "          ";
    const result = stampLine(text, 0, 2, 0, 6);
    expect(result.slice(2, 7)).toBe("─────");
  });

  it("stamps a vertical line", () => {
    const text = "     \n     \n     \n     ";
    const result = stampLine(text, 0, 2, 3, 2);
    const lines = result.split("\n");
    for (let r = 0; r <= 3; r++) expect(lines[r][2]).toBe("│");
  });

  it("constrains diagonal to dominant axis", () => {
    const text = "          \n          ";
    const result = stampLine(text, 0, 0, 1, 5);
    expect(result.split("\n")[0].slice(0, 6)).toBe("──────");
  });

  it("discards single-cell line", () => {
    const text = "     ";
    expect(stampLine(text, 0, 2, 0, 2)).toBe(text);
  });
});
