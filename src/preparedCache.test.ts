import { describe, it, expect } from "vitest";
import { buildPreparedCache, invalidateLine, splitLine, mergeLines } from "./preparedCache";

describe("preparedCache", () => {
  describe("buildPreparedCache", () => {
    it("returns one entry per source line", () => {
      const cache = buildPreparedCache("Hello\nWorld\n");
      // "Hello\nWorld\n" splits into ["Hello", "World", ""]
      expect(cache).toHaveLength(3);
    });

    it("non-empty lines have PreparedTextWithSegments, empty lines have null", () => {
      const cache = buildPreparedCache("A\n\nB");
      expect(cache[0]).not.toBeNull();
      expect(cache[1]).toBeNull(); // empty line
      expect(cache[2]).not.toBeNull();
    });

    it("empty document returns single null entry", () => {
      const cache = buildPreparedCache("");
      expect(cache).toHaveLength(1);
      expect(cache[0]).toBeNull();
    });

    it("single line without newline returns one entry", () => {
      const cache = buildPreparedCache("Hello world");
      expect(cache).toHaveLength(1);
      expect(cache[0]).not.toBeNull();
      expect(cache[0]!.segments.join("")).toBe("Hello world");
    });
  });

  describe("invalidateLine", () => {
    it("replaces a single cache entry without changing array length", () => {
      const cache = buildPreparedCache("Hello\nWorld");
      const origLen = cache.length;
      invalidateLine(cache, 0, "Hi there");
      expect(cache).toHaveLength(origLen);
      expect(cache[0]).not.toBeNull();
      expect(cache[0]!.segments.join("")).toBe("Hi there");
    });

    it("sets entry to null when new text is empty", () => {
      const cache = buildPreparedCache("Hello\nWorld");
      invalidateLine(cache, 0, "");
      expect(cache[0]).toBeNull();
    });
  });

  describe("splitLine", () => {
    it("increases cache length by 1", () => {
      const cache = buildPreparedCache("HelloWorld\nNext");
      expect(cache).toHaveLength(2);
      splitLine(cache, 0, "Hello", "World");
      expect(cache).toHaveLength(3);
    });

    it("first half replaces original, second half is inserted after", () => {
      const cache = buildPreparedCache("HelloWorld\nNext");
      splitLine(cache, 0, "Hello", "World");
      expect(cache[0]!.segments.join("")).toBe("Hello");
      expect(cache[1]!.segments.join("")).toBe("World");
      expect(cache[2]!.segments.join("")).toBe("Next"); // unchanged
    });

    it("handles split at line start (empty first half)", () => {
      const cache = buildPreparedCache("Hello");
      splitLine(cache, 0, "", "Hello");
      expect(cache).toHaveLength(2);
      expect(cache[0]).toBeNull();
      expect(cache[1]!.segments.join("")).toBe("Hello");
    });

    it("handles split at line end (empty second half)", () => {
      const cache = buildPreparedCache("Hello");
      splitLine(cache, 0, "Hello", "");
      expect(cache).toHaveLength(2);
      expect(cache[0]!.segments.join("")).toBe("Hello");
      expect(cache[1]).toBeNull();
    });
  });

  describe("mergeLines", () => {
    it("decreases cache length by 1", () => {
      const cache = buildPreparedCache("Hello\nWorld\nEnd");
      expect(cache).toHaveLength(3);
      mergeLines(cache, 1, "HelloWorld");
      expect(cache).toHaveLength(2);
    });

    it("row-1 gets merged text, remaining entries shift up", () => {
      const cache = buildPreparedCache("Hello\nWorld\nEnd");
      mergeLines(cache, 1, "HelloWorld");
      expect(cache[0]!.segments.join("")).toBe("HelloWorld");
      expect(cache[1]!.segments.join("")).toBe("End");
    });

    it("handles merge that produces empty line", () => {
      const cache = buildPreparedCache("\n");
      // cache is [null, null] — two empty lines
      expect(cache).toHaveLength(2);
      mergeLines(cache, 1, "");
      expect(cache).toHaveLength(1);
      expect(cache[0]).toBeNull();
    });
  });
});
