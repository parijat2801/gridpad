// src/gridSerialize.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { gridSerialize, rebuildOriginalGrid } from "./gridSerialize";
import { scanToFrames } from "./scanToFrames";
import type { Frame } from "./frame";
import type { ProseSegment } from "./proseSegments";

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "", fillStyle: "", textBaseline: "", fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      })) as unknown as HTMLCanvasElement["getContext"];
    }
    return el;
  });
});

const CW = 9.6;
const CH = 18.4;

/** Helper: build the proseSegmentMap from proseSegments (matches createEditorStateFromText logic) */
function buildSegmentMap(segments: ProseSegment[]): { row: number; col: number }[] {
  const seen = new Set<number>();
  const map: { row: number; col: number }[] = [];
  for (const s of segments) {
    if (!seen.has(s.row)) {
      seen.add(s.row);
      map.push({ row: s.row, col: s.col });
    }
  }
  map.sort((a, b) => a.row - b.row);
  return map;
}

/** Helper: build prose doc text from segments (matches createEditorStateFromText logic) */
function buildProseDoc(segments: ProseSegment[]): string {
  const byRow = new Map<number, string>();
  for (const seg of segments) {
    const existing = byRow.get(seg.row) ?? "";
    if (existing && seg.col > existing.length) {
      byRow.set(seg.row, existing + " ".repeat(seg.col - existing.length) + seg.text);
    } else {
      byRow.set(seg.row, existing + seg.text);
    }
  }
  const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
  return sortedRows.map(r => byRow.get(r)!).join("\n");
}

describe("gridSerialize", () => {
  it("pure prose round-trips unchanged", () => {
    const text = "Hello world\n\nSecond paragraph";
    const { frames, proseSegments, originalGrid } = scanToFrames(text, CW, CH);
    const segMap = buildSegmentMap(proseSegments);
    const prose = buildProseDoc(proseSegments);
    const result = gridSerialize(frames, prose, segMap, originalGrid, CW, CH, proseSegments);
    expect(result).toBe(text);
  });

  it("prose + wireframe round-trips unchanged", () => {
    const text = "Top prose\n\n┌────┐\n│    │\n└────┘\n\nBottom prose";
    const { frames, proseSegments, originalGrid } = scanToFrames(text, CW, CH);
    const segMap = buildSegmentMap(proseSegments);
    const prose = buildProseDoc(proseSegments);
    const result = gridSerialize(frames, prose, segMap, originalGrid, CW, CH, proseSegments);
    expect(result).toBe(text);
  });

  it("junction characters are preserved in non-dirty frames", () => {
    const text = [
      "Header",
      "",
      "┌───────────┬───────────┐",
      "│  Left     │  Right    │",
      "├───────────┼───────────┤",
      "│  Bottom L │  Bottom R │",
      "└───────────┴───────────┘",
      "",
      "Footer",
    ].join("\n");
    const { frames, proseSegments, originalGrid } = scanToFrames(text, CW, CH);
    const segMap = buildSegmentMap(proseSegments);
    const prose = buildProseDoc(proseSegments);
    const result = gridSerialize(frames, prose, segMap, originalGrid, CW, CH, proseSegments);
    expect(result).toContain("├");
    expect(result).toContain("┬");
    expect(result).toContain("┤");
    expect(result).toContain("┴");
    expect(result).toContain("┼");
    expect(result).toBe(text);
  });

  it("side-by-side boxes round-trip unchanged", () => {
    const text = [
      "Prose",
      "",
      "┌──────┐  ┌──────┐",
      "│  A   │  │  B   │",
      "└──────┘  └──────┘",
      "",
      "End",
    ].join("\n");
    const { frames, proseSegments, originalGrid } = scanToFrames(text, CW, CH);
    const segMap = buildSegmentMap(proseSegments);
    const prose = buildProseDoc(proseSegments);
    const result = gridSerialize(frames, prose, segMap, originalGrid, CW, CH, proseSegments);
    expect(result).toBe(text);
  });

  it("dirty frame writes regenerated cells", () => {
    const text = "┌──┐\n│  │\n└──┘";
    const { frames, proseSegments, originalGrid } = scanToFrames(text, CW, CH);
    // Mark frame dirty
    const dirtyFrames = frames.map(f => ({ ...f, dirty: true }));
    const segMap = buildSegmentMap(proseSegments);
    const prose = buildProseDoc(proseSegments);
    const result = gridSerialize(dirtyFrames, prose, segMap, originalGrid, CW, CH, proseSegments);
    // Should still contain box chars (regenerated from cells)
    expect(result).toContain("┌");
    expect(result).toContain("└");
  });

  it("moved dirty frame does not leave ghost at original position", () => {
    const text = "┌──┐\n│  │\n└──┘";
    const { frames, proseSegments, originalGrid } = scanToFrames(text, CW, CH);
    // Snapshot original bboxes before moving
    const origBboxes = [{ id: frames[0].id, row: 0, col: 0, w: 4, h: 3 }];
    // "Move" frame right by 4 cols — mark dirty, update position
    const movedFrames = frames.map(f => ({
      ...f, x: f.x + 4 * CW, dirty: true,
    }));
    const segMap = buildSegmentMap(proseSegments);
    const prose = buildProseDoc(proseSegments);
    const result = gridSerialize(movedFrames, prose, segMap, originalGrid, CW, CH, proseSegments, origBboxes);
    // Original position (col 0) should be blank — no ghost
    const lines = result.split("\n");
    expect(lines[0].startsWith("    ")).toBe(true); // first 4 cols are spaces
    // New position should have the box
    expect(result).toContain("┌──┐");
  });

  it("deleted frame is blanked from original position", () => {
    const text = "┌──┐\n│  │\n└──┘";
    const { frames, proseSegments, originalGrid } = scanToFrames(text, CW, CH);
    const origBboxes = [{ id: frames[0].id, row: 0, col: 0, w: 4, h: 3 }];
    // Delete the frame — pass empty frames array
    const segMap = buildSegmentMap(proseSegments);
    const prose = buildProseDoc(proseSegments);
    const result = gridSerialize([], prose, segMap, originalGrid, CW, CH, proseSegments, origBboxes);
    // Should be empty (all blanked)
    expect(result).toBe("");
  });
});

describe("rebuildOriginalGrid", () => {
  it("splits text into char arrays", () => {
    const grid = rebuildOriginalGrid("AB\nCD");
    expect(grid).toEqual([["A", "B"], ["C", "D"]]);
  });

  it("handles empty text", () => {
    expect(rebuildOriginalGrid("")).toEqual([]);
  });
});
