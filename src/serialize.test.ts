import { describe, it, expect, vi, beforeAll } from "vitest";
import { scan } from "./scanner";
import { detectRegions } from "./regions";
import { framesFromRegions, moveFrame } from "./frame";
import { framesToMarkdown } from "./serialize";

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as any).getContext = () => ({
        font: "",
        fillStyle: "",
        textBaseline: "",
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

const CW = 9.6, CH = 18.4;

describe("framesToMarkdown", () => {
  it("no-edit round-trip preserves region structure", () => {
    const doc = "# Hello\n\n┌──────┐\n│ Box  │\n└──────┘\n\nAfter.";
    const regions = detectRegions(scan(doc));
    const { frames, prose } = framesFromRegions(regions, CW, CH);
    const md = framesToMarkdown(frames, prose, regions, CW, CH);
    const r2 = detectRegions(scan(md));
    expect(r2.length).toBe(regions.length);
    expect(r2.map(r => r.type)).toEqual(regions.map(r => r.type));
  });

  it("no-edit round-trip preserves box-drawing chars", () => {
    const doc = "┌──────┐\n│ Box  │\n└──────┘";
    const count = (t: string) => [...t].filter(c => "┌┐└┘─│├┤┬┴┼".includes(c)).length;
    const regions = detectRegions(scan(doc));
    const { frames, prose } = framesFromRegions(regions, CW, CH);
    const md = framesToMarkdown(frames, prose, regions, CW, CH);
    expect(count(md)).toBe(count(doc));
  });

  it("after move: rect appears at new grid position", () => {
    const doc = "┌──┐\n│  │\n└──┘";
    const regions = detectRegions(scan(doc));
    const { frames, prose } = framesFromRegions(regions, CW, CH);
    const container = frames[0];
    const child = container.children.find(c => c.content?.type === "rect")!;
    const moved = moveFrame(child, { dx: 0, dy: CH });
    container.children = container.children.map(c => c.id === child.id ? moved : c);
    const md = framesToMarkdown(frames, prose, regions, CW, CH);
    const lines = md.split("\n");
    // Row 0 should be empty (rect moved down by 1 grid row)
    expect(lines[0].trim()).toBe("");
    expect(lines[1]).toContain("┌");
  });

  it("prose text preserved alongside wireframes", () => {
    const doc = "# Title\n\nSome text.\n\n┌──┐\n└──┘\n\nMore text.";
    const regions = detectRegions(scan(doc));
    const { frames, prose } = framesFromRegions(regions, CW, CH);
    const md = framesToMarkdown(frames, prose, regions, CW, CH);
    expect(md).toContain("Title");
    expect(md).toContain("Some text");
    expect(md).toContain("More text");
    expect(md).toContain("┌");
  });

  it("double round-trip is stable", () => {
    const doc = "# Hi\n\n┌────────┐\n│ Card   │\n└────────┘\n\nEnd.";
    const r1 = detectRegions(scan(doc));
    const o1 = framesFromRegions(r1, CW, CH);
    const md1 = framesToMarkdown(o1.frames, o1.prose, r1, CW, CH);
    const r2 = detectRegions(scan(md1));
    const o2 = framesFromRegions(r2, CW, CH);
    const md2 = framesToMarkdown(o2.frames, o2.prose, r2, CW, CH);
    expect(md2).toBe(md1);
  });

  it("junction chars (├┬┴┤) preserved in no-edit round-trip", () => {
    const doc = "┌────────┬────────┐\n│ Left   │ Right  │\n└────────┴────────┘";
    const regions = detectRegions(scan(doc));
    const { frames, prose } = framesFromRegions(regions, CW, CH);
    const md = framesToMarkdown(frames, prose, regions, CW, CH);
    expect(md).toContain("┬");
    expect(md).toContain("┴");
  });
});
