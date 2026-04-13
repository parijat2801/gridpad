import { describe, it, expect } from "vitest";
import type { LayerType } from "./layers";
import {
  BASE_LAYER_ID,
  fnv32hex,
  contentAddressedId,
  randomId,
} from "./identity";

describe("BASE_LAYER_ID", () => {
  it('is the literal string "base"', () => {
    expect(BASE_LAYER_ID).toBe("base");
  });
});

describe("fnv32hex", () => {
  it("is deterministic and returns a lowercase hex string of length 8", () => {
    const result = fnv32hex("hello");
    expect(result).toBe(fnv32hex("hello"));
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('fnv32hex("") returns "811c9dc5" (FNV-32a offset basis)', () => {
    expect(fnv32hex("")).toBe("811c9dc5");
  });

  it('fnv32hex("r0c0w3h3") matches 8-char hex format (implementation to pin exact value in GREEN)', () => {
    // RED phase: confirm format only; implementer pins exact value in GREEN phase
    expect(fnv32hex("r0c0w3h3")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("contentAddressedId", () => {
  it("returns rect:<8 hex chars> for a rect, deterministically", () => {
    const proposal = { type: "rect" as const, bbox: { row: 0, col: 0, w: 3, h: 3 } };
    const id1 = contentAddressedId(proposal);
    const id2 = contentAddressedId(proposal);
    expect(id1).toMatch(/^rect:[0-9a-f]{8}$/);
    expect(id1).toBe(id2);
  });

  it("produces different IDs for rects with different bboxes", () => {
    const a = contentAddressedId({ type: "rect" as const, bbox: { row: 0, col: 0, w: 3, h: 3 } });
    const b = contentAddressedId({ type: "rect" as const, bbox: { row: 1, col: 0, w: 3, h: 3 } });
    expect(a).not.toBe(b);
  });

  it("produces different IDs for rect vs line with same bbox (due to type prefix)", () => {
    const bbox = { row: 0, col: 0, w: 3, h: 3 };
    const rectId = contentAddressedId({ type: "rect" as const, bbox });
    const lineId = contentAddressedId({ type: "line" as const, bbox });
    expect(rectId).not.toBe(lineId);
  });

  it('returns the literal "base" (BASE_LAYER_ID) for a base layer', () => {
    const id = contentAddressedId({ type: "base" as const, bbox: { row: 0, col: 0, w: 10, h: 5 } });
    expect(id).toBe("base");
    expect(id).toBe(BASE_LAYER_ID);
  });

  it('returns "" for a group layer (groups use randomId, not content addressing)', () => {
    const id = contentAddressedId({ type: "group" as LayerType, bbox: { row: 0, col: 0, w: 5, h: 5 } });
    expect(id).toBe("");
  });

  it("produces the same ID for a line with the same bbox (bbox-derived keys work for axis-aligned lines)", () => {
    const bbox = { row: 0, col: 0, w: 6, h: 1 };
    const id1 = contentAddressedId({ type: "line" as const, bbox });
    const id2 = contentAddressedId({ type: "line" as const, bbox });
    expect(id1).toBe(id2);
  });

  it("produces different IDs for text layers with same bbox but different content", () => {
    const bbox = { row: 2, col: 4, w: 3, h: 1 };
    const fooId = contentAddressedId({ type: "text" as const, bbox, content: "foo" });
    const barId = contentAddressedId({ type: "text" as const, bbox, content: "bar" });
    expect(fooId).not.toBe(barId);
  });
});

describe("contentAddressedId determinism", () => {
  it("contentAddressedId is deterministic (pure function: same proposal → same ID)", () => {
    const proposal = { type: "rect" as const, bbox: { row: 0, col: 0, w: 3, h: 3 } };
    expect(contentAddressedId(proposal)).toBe(contentAddressedId(proposal));
  });
});

describe("randomId", () => {
  it("returns a string and two calls return different strings", () => {
    const id1 = randomId();
    const id2 = randomId();
    expect(typeof id1).toBe("string");
    expect(typeof id2).toBe("string");
    expect(id1).not.toBe(id2);
  });
});
