// Tests for proseRange.ts — selection ordering, extraction, band-aware
// range deletion, highlight geometry, word expansion.

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  createEditorStateUnified,
  getDoc,
  getFrames,
  getCursor,
  editorUndo,
} from "./editorState";
import {
  cmpPos,
  orderRange,
  rangeText,
  rangeTextSerialized,
  claimedRows,
  applyDeleteRange,
  selectionRects,
  wordRangeAt,
} from "./proseRange";
import type { PositionedLine } from "./reflowLayout";

beforeAll(() => {
  const orig = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = orig(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "", fillStyle: "", textBaseline: "", fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4,
        }),
      })) as unknown as HTMLCanvasElement["getContext"];
    }
    return el;
  });
});

const cw = 9.6, ch = 18;

const PROSE_ONLY = ["Alpha beta gamma", "", "Second line here", "Third"].join("\n");

const WITH_BOX = [
  "Above",
  "",
  "┌────┐",
  "│ Hi │",
  "└────┘",
  "",
  "Below",
].join("\n");

describe("orderRange / cmpPos", () => {
  it("orders forward and backward ranges the same", () => {
    const a = { row: 0, col: 3 }, b = { row: 2, col: 1 };
    expect(orderRange(a, b)).toEqual({ from: a, to: b });
    expect(orderRange(b, a)).toEqual({ from: a, to: b });
    expect(cmpPos(a, a)).toBe(0);
  });
});

describe("rangeText", () => {
  it("extracts within a single line", () => {
    const s = createEditorStateUnified(PROSE_ONLY, cw, ch);
    expect(rangeText(s, { row: 0, col: 6 }, { row: 0, col: 10 })).toBe("beta");
  });

  it("extracts across lines (either direction)", () => {
    const s = createEditorStateUnified(PROSE_ONLY, cw, ch);
    const fwd = rangeText(s, { row: 0, col: 6 }, { row: 2, col: 6 });
    const bwd = rangeText(s, { row: 2, col: 6 }, { row: 0, col: 6 });
    expect(fwd).toBe("beta gamma\n\nSecond");
    expect(bwd).toBe(fwd);
  });
});

describe("rangeTextSerialized", () => {
  const SERIALIZED = ["Above", "", "┌────┐", "│ Hi │", "└────┘", "", "Below"].join("\n");

  it("slices a single line by grapheme columns", () => {
    expect(rangeTextSerialized(SERIALIZED, { row: 3, col: 2 }, { row: 3, col: 4 })).toBe("Hi");
  });

  it("includes wireframe glyph rows when the range spans them", () => {
    const out = rangeTextSerialized(SERIALIZED, { row: 0, col: 0 }, { row: 6, col: 5 });
    expect(out).toBe(SERIALIZED);
  });

  it("orders reversed ranges", () => {
    expect(rangeTextSerialized(SERIALIZED, { row: 6, col: 5 }, { row: 6, col: 0 })).toBe("Below");
  });

  it("snaps endpoint cols to whole rows on band-claimed rows", () => {
    // Endpoint at col 0 of the bottom-border row (blank in the raw doc)
    // must still capture the full glyph row.
    const claimed = new Set([2, 3, 4]);
    const out = rangeTextSerialized(SERIALIZED, { row: 0, col: 0 }, { row: 4, col: 0 }, claimed);
    expect(out.endsWith("└────┘")).toBe(true);
  });
});

describe("applyDeleteRange", () => {
  it("deletes within a single line, cursor lands at from", () => {
    const s0 = createEditorStateUnified(PROSE_ONLY, cw, ch);
    const s1 = applyDeleteRange(s0, { row: 0, col: 6 }, { row: 0, col: 11 });
    expect(getDoc(s1).split("\n")[0]).toBe("Alpha gamma");
    expect(getCursor(s1)).toEqual({ row: 0, col: 6 });
  });

  it("deletes across prose lines", () => {
    const s0 = createEditorStateUnified(PROSE_ONLY, cw, ch);
    const s1 = applyDeleteRange(s0, { row: 0, col: 5 }, { row: 2, col: 6 });
    expect(getDoc(s1).split("\n")[0]).toBe("Alpha line here");
  });

  it("collapsed range is a no-op", () => {
    const s0 = createEditorStateUnified(PROSE_ONLY, cw, ch);
    expect(applyDeleteRange(s0, { row: 1, col: 0 }, { row: 1, col: 0 })).toBe(s0);
  });

  it("range spanning a wireframe deletes the frame and joins the prose", () => {
    const s0 = createEditorStateUnified(WITH_BOX, cw, ch);
    expect(getFrames(s0).length).toBeGreaterThan(0);
    const lastRow = getDoc(s0).split("\n").length - 1;
    const s1 = applyDeleteRange(s0, { row: 0, col: 5 }, { row: lastRow, col: 0 });
    const doc1 = getDoc(s1);
    expect(doc1).toContain("Above");
    expect(doc1).not.toContain("┌");
    expect(doc1).toContain("Below");
    expect(getFrames(s1).filter(f => f.lineCount > 0)).toHaveLength(0);
  });

  it("refuses when an endpoint sits on a band-claimed row", () => {
    const s0 = createEditorStateUnified(WITH_BOX, cw, ch);
    const band = getFrames(s0).find(f => f.lineCount > 0)!;
    const s1 = applyDeleteRange(s0, { row: 0, col: 0 }, { row: band.gridRow, col: 0 });
    expect(s1).toBe(s0);
  });

  it("undo restores the deleted prose span", () => {
    const s0 = createEditorStateUnified(PROSE_ONLY, cw, ch);
    const s1 = applyDeleteRange(s0, { row: 0, col: 0 }, { row: 2, col: 6 });
    const s2 = editorUndo(s1);
    expect(getDoc(s2)).toBe(getDoc(s0));
  });
});

describe("claimedRows", () => {
  it("collects each claiming frame's row span", () => {
    const s = createEditorStateUnified(WITH_BOX, cw, ch);
    const rows = claimedRows(getFrames(s));
    const band = getFrames(s).find(f => f.lineCount > 0)!;
    for (let r = band.gridRow; r < band.gridRow + band.lineCount; r++) {
      expect(rows.has(r)).toBe(true);
    }
    expect(rows.has(0)).toBe(false);
  });
});

describe("selectionRects", () => {
  const measure = (t: string) => t.length * 10;
  const lines: PositionedLine[] = [
    { x: 0, y: 0, text: "Hello world", width: 110, slotWidth: 110, startCursor: { segmentIndex: 0, graphemeIndex: 0 }, endCursor: { segmentIndex: 0, graphemeIndex: 0 }, sourceLine: 0, sourceCol: 0 },
    { x: 0, y: 20, text: "Second", width: 60, slotWidth: 60, startCursor: { segmentIndex: 0, graphemeIndex: 0 }, endCursor: { segmentIndex: 0, graphemeIndex: 0 }, sourceLine: 1, sourceCol: 0 },
  ];

  it("single-line partial selection", () => {
    const rects = selectionRects({ row: 0, col: 6 }, { row: 0, col: 11 }, lines, measure, 20);
    expect(rects).toEqual([{ x: 60, y: 0, w: 50, h: 20 }]);
  });

  it("multi-line selection covers line tail and head", () => {
    const rects = selectionRects({ row: 0, col: 6 }, { row: 1, col: 3 }, lines, measure, 20);
    expect(rects).toEqual([
      { x: 60, y: 0, w: 50, h: 20 },
      { x: 0, y: 20, w: 30, h: 20 },
    ]);
  });

  it("collapsed selection has no rects", () => {
    expect(selectionRects({ row: 0, col: 3 }, { row: 0, col: 3 }, lines, measure, 20)).toEqual([]);
  });

  it("wrapped visual lines of one source line each get their overlap", () => {
    const wrapped: PositionedLine[] = [
      { ...lines[0], text: "Hello ", sourceLine: 0, sourceCol: 0 },
      { ...lines[0], y: 20, text: "world", sourceLine: 0, sourceCol: 6 },
    ];
    const rects = selectionRects({ row: 0, col: 3 }, { row: 0, col: 9 }, wrapped, measure, 20);
    expect(rects).toEqual([
      { x: 30, y: 0, w: 30, h: 20 },
      { x: 0, y: 20, w: 30, h: 20 },
    ]);
  });
});

describe("wordRangeAt", () => {
  it("expands over a word", () => {
    expect(wordRangeAt("Alpha beta gamma", 0, 7)).toEqual({ from: { row: 0, col: 6 }, to: { row: 0, col: 10 } });
  });

  it("selects the single grapheme on non-word chars", () => {
    expect(wordRangeAt("a b", 3, 1)).toEqual({ from: { row: 3, col: 1 }, to: { row: 3, col: 2 } });
  });

  it("returns null for empty line", () => {
    expect(wordRangeAt("", 0, 0)).toBeNull();
  });

  it("clamps col past end of line to the last grapheme", () => {
    expect(wordRangeAt("word", 0, 99)).toEqual({ from: { row: 0, col: 0 }, to: { row: 0, col: 4 } });
  });
});
