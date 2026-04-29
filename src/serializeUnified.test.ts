// src/serializeUnified.test.ts
import { describe, it, expect, vi, beforeAll } from "vitest";
import { serializeUnified } from "./serializeUnified";
import { scanToFrames } from "./scanToFrames";
import { framesFromScan } from "./frame";
import { scan } from "./scanner";

// Canvas mock for scanner/framesFromScan
beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      // @ts-expect-error mocking canvas getContext for tests
      el.getContext = () => ({
        font: "", fillStyle: "", textBaseline: "",
        fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      });
    }
    return el;
  });
});

/** Helper: build the unified doc from original text + scanToFrames output */
function buildUnifiedDoc(original: string, cw = 9.6, ch = 18): { unifiedDoc: string; frames: ReturnType<typeof scanToFrames>["frames"] } {
  const { frames } = scanToFrames(original, cw, ch);
  const sourceLines = original.split("\n");
  const claimedLines = new Set<number>();
  for (const f of frames) {
    for (let i = f.gridRow; i < f.gridRow + f.gridH; i++) {
      claimedLines.add(i);
    }
  }
  const unifiedDoc = sourceLines
    .map((line, i) => (claimedLines.has(i) ? " " : line))
    .join("\n");
  return { unifiedDoc, frames };
}

describe("serializeUnified", () => {
  it("round-trips a simple wireframe with prose", () => {
    const original = `Hello world

┌──────┐
│ Box  │
└──────┘

Goodbye`;
    const { unifiedDoc, frames } = buildUnifiedDoc(original);
    const result = serializeUnified(unifiedDoc, frames);
    expect(result).toBe(original);
  });

  it("round-trips wireframe at start of file", () => {
    const original = `┌──────┐
│ Test │
└──────┘
Some prose`;
    const { unifiedDoc, frames } = buildUnifiedDoc(original);
    const result = serializeUnified(unifiedDoc, frames);
    expect(result).toBe(original);
  });

  it("round-trips wireframe at end of file (no trailing newline)", () => {
    const original = `Intro text
┌────┐
│ Hi │
└────┘`;
    const { unifiedDoc, frames } = buildUnifiedDoc(original);
    const result = serializeUnified(unifiedDoc, frames);
    expect(result).toBe(original);
  });

  it("round-trips two separated wireframes with prose between", () => {
    // Two blank lines of separation to avoid groupIntoContainers merging them
    const original = `First frame:
┌───┐
│ A │
└───┘

Between lines

┌───┐
│ B │
└───┘
After`;
    const { unifiedDoc, frames } = buildUnifiedDoc(original);
    const result = serializeUnified(unifiedDoc, frames);
    expect(result).toBe(original);
  });

  it("renders frame children at correct relative positions", () => {
    // Container with two side-by-side children — use framesFromScan directly
    const original = `┌──┐┌──┐
│ A││ B│
└──┘└──┘`;
    const cw = 9.6, ch = 18;
    const scanResult = scan(original);
    const frames = framesFromScan(scanResult, cw, ch);
    // Manually set docOffset + lineCount for the container
    for (const f of frames) {
      f.docOffset = 0;
      f.lineCount = f.gridH;
    }
    // Build unified doc with all lines claimed
    const allClaimed = original.split("\n").map(() => " ").join("\n");
    const result = serializeUnified(allClaimed, frames);
    // Both boxes should appear in output
    expect(result).toContain("┌──┐");
    expect(result).toContain("│ A│");
    expect(result).toContain("│ B│");
  });

  it("empty doc returns empty string", () => {
    const result = serializeUnified("", []);
    expect(result).toBe("");
  });

  it("prose-only doc passes through unchanged", () => {
    const prose = `Hello world
This is prose only
No wireframes here`;
    const result = serializeUnified(prose, []);
    expect(result).toBe(prose);
  });

  it("round-trips junction wireframe with bottom-row labels", () => {
    // Reproduces e2e harness "no-edit: junction-chars" failure.
    // The bottom-row labels "Bottom L" / "Bottom R" are missing from output
    // even though the input clearly has them.
    const original = `Header

┌───────────┬───────────┐
│  Left     │  Right    │
├───────────┼───────────┤
│  Bottom L │  Bottom R │
└───────────┴───────────┘

Footer`;
    const { unifiedDoc, frames } = buildUnifiedDoc(original);
    const result = serializeUnified(unifiedDoc, frames);
    expect(result).toContain("Bottom L");
    expect(result).toContain("Bottom R");
    expect(result).toBe(original);
  });

  it("round-trips form-layout with multi-row label/box pairs", () => {
    // Reproduces "no-edit: form-layout" failure. The "Name:" label is missing.
    const original = `Form

┌──────────────────────────┐
│      Title               │
├──────────────────────────┤
│  Name:  ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
│  Email: ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
└──────────────────────────┘

End`;
    const { unifiedDoc, frames } = buildUnifiedDoc(original);
    const result = serializeUnified(unifiedDoc, frames);
    expect(result).toContain("Name:");
    expect(result).toContain("Email:");
  });

  it("frame with lineCount === 0 is ignored", () => {
    const original = `Hello world`;
    const { frames } = scanToFrames(original, 9.6, 18);
    // Even if we hand-add a frame with lineCount 0, it should not render
    const fakeFrame = {
      id: "fake-1",
      x: 0, y: 0, w: 48, h: 54,
      z: 0,
      children: [],
      content: null,
      clip: true,
      dirty: false,
      gridRow: 0, gridCol: 0,
      gridW: 5, gridH: 3,
      docOffset: 0,
      lineCount: 0, // not placed
    };
    const result = serializeUnified(original, [...frames, fakeFrame]);
    expect(result).toBe("Hello world");
  });
});

describe("serializeUnified round-trip — multi-shape composite", () => {
  it("loading and serializing a horizontally-adjacent two-rect composite is byte-stable", () => {
    // Two boxes side-by-side on the same row range — the scanner places them
    // both in one band (same row partition), exercising the band → [rect,
    // rect] recursion path in renderFrameRow.
    const original = [
      "Title", "",
      "┌────┐  ┌────┐",
      "│ Hi │  │ Yo │",
      "└────┘  └────┘", "",
      "End",
    ].join("\n");
    const { unifiedDoc, frames } = buildUnifiedDoc(original);
    const result = serializeUnified(unifiedDoc, frames);
    expect(result).toBe(original);
  });
});
