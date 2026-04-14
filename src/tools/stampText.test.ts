import { describe, it, expect } from "vitest";
import { stampText } from "./stampText";

describe("stampText", () => {
  it("writes characters at cursor position", () => {
    const text = "          \n          ";
    const result = stampText(text, 0, 3, "Hello");
    expect(result.split("\n")[0].slice(3, 8)).toBe("Hello");
  });

  it("overwrites existing characters", () => {
    const text = "XXXXXXXXXX";
    expect(stampText(text, 0, 2, "Hi")).toBe("XXHiXXXXXX");
  });

  it("pads row if text extends beyond current width", () => {
    const text = "ab";
    const result = stampText(text, 0, 5, "XY");
    expect(result.length).toBeGreaterThanOrEqual(7);
    expect(result[5]).toBe("X");
    expect(result[6]).toBe("Y");
  });

  it("rejects empty buffer", () => {
    const text = "Hello";
    expect(stampText(text, 0, 0, "")).toBe(text);
  });
});
