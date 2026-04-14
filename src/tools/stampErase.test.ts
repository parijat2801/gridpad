import { describe, it, expect } from "vitest";
import { stampErase } from "./stampErase";

describe("stampErase", () => {
  it("replaces characters with spaces", () => {
    const text = "Hello\nWorld";
    const cells = [{ row: 0, col: 1 }, { row: 0, col: 2 }];
    expect(stampErase(text, cells).split("\n")[0]).toBe("H  lo");
  });

  it("no-ops on out-of-bounds cells", () => {
    expect(stampErase("Hi", [{ row: 5, col: 5 }])).toBe("Hi");
  });

  it("no-ops on empty cell list", () => {
    expect(stampErase("Hello", [])).toBe("Hello");
  });
});
