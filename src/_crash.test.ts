import { describe, it, expect, vi, beforeAll } from "vitest";
import { scan } from "./scanner";
import { detectRegions } from "./regions";
import { framesFromRegions } from "./frame";
import * as fs from "fs";

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as any).getContext = () => ({
        font: "", fillStyle: "", textBaseline: "", fillText: () => {},
        measureText: (text: string) => ({ width: text.length * 9.6, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 }),
      });
    }
    return el;
  });
});

describe("crash file", () => {
  it("loads without crashing", () => {
    const text = fs.readFileSync("/Users/parijat/dev/colex-platform/docs/plans/2026-03-17-garden-db-pr3-evaluation-pipeline.md", "utf8");
    console.log("Lines:", text.split("\n").length);
    
    const t0 = performance.now();
    const result = scan(text);
    console.log("Scan:", (performance.now()-t0).toFixed(1), "ms, rects:", result.rects.length, "texts:", result.texts.length);
    
    const t1 = performance.now();
    const regions = detectRegions(result);
    console.log("Regions:", (performance.now()-t1).toFixed(1), "ms, count:", regions.length);
    
    const maxLayers = Math.max(0, ...regions.filter(r=>r.layers).map(r=>r.layers!.length));
    console.log("Max layers/region:", maxLayers);
    
    const t2 = performance.now();
    const { frames } = framesFromRegions(regions, 9.6, 18.4);
    console.log("Frames:", (performance.now()-t2).toFixed(1), "ms, count:", frames.length);
    if (frames.length > 0) console.log("Max children:", Math.max(...frames.map(f=>f.children.length)));
    
    expect(regions.length).toBeGreaterThan(0);
  });
});
