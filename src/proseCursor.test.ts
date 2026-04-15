import { describe, it, expect } from "vitest";
import { insertChar, deleteChar } from "./proseCursor";

describe("insertChar", () => {
  it("inserts at cursor position", () => {
    const result = insertChar("Hello world", { row: 0, col: 5 }, "!");
    expect(result.text).toBe("Hello! world");
    expect(result.cursor).toEqual({ row: 0, col: 6 });
  });

  it("inserts into middle of multiline text", () => {
    const result = insertChar("Line 1\nLine 2", { row: 1, col: 4 }, "!");
    expect(result.text).toBe("Line 1\nLine! 2");
    expect(result.cursor).toEqual({ row: 1, col: 5 });
  });

  it("handles newline insertion", () => {
    const result = insertChar("Hello world", { row: 0, col: 5 }, "\n");
    expect(result.text).toBe("Hello\n world");
    expect(result.cursor).toEqual({ row: 1, col: 0 });
  });

  it("inserts into empty string", () => {
    const result = insertChar("", { row: 0, col: 0 }, "A");
    expect(result.text).toBe("A");
    expect(result.cursor).toEqual({ row: 0, col: 1 });
  });

  it("inserts at end of line", () => {
    const result = insertChar("Hello", { row: 0, col: 5 }, "!");
    expect(result.text).toBe("Hello!");
    expect(result.cursor).toEqual({ row: 0, col: 6 });
  });
});

describe("deleteChar", () => {
  it("deletes char before cursor", () => {
    const result = deleteChar("Hello", { row: 0, col: 5 });
    expect(result.text).toBe("Hell");
    expect(result.cursor).toEqual({ row: 0, col: 4 });
  });

  it("merges lines on backspace at start of line", () => {
    const result = deleteChar("Line 1\nLine 2", { row: 1, col: 0 });
    expect(result.text).toBe("Line 1Line 2");
    expect(result.cursor).toEqual({ row: 0, col: 6 });
  });

  it("no-op at start of text", () => {
    const result = deleteChar("Hello", { row: 0, col: 0 });
    expect(result.text).toBe("Hello");
    expect(result.cursor).toEqual({ row: 0, col: 0 });
  });

  it("merges with empty previous line", () => {
    const result = deleteChar("Line 1\n\nLine 3", { row: 2, col: 0 });
    expect(result.text).toBe("Line 1\nLine 3");
    expect(result.cursor).toEqual({ row: 1, col: 0 });
  });

  it("deletes from middle of line", () => {
    const result = deleteChar("Hello", { row: 0, col: 3 });
    expect(result.text).toBe("Helo");
    expect(result.cursor).toEqual({ row: 0, col: 2 });
  });
});
