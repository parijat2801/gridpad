/**
 * Prototype: Can Pretext lay out monospace wireframe text?
 * 
 * Questions to answer:
 * 1. Does prepareWithSegments work with monospace box-drawing chars?
 * 2. Does layoutNextLine preserve character positions in monospace?
 * 3. Can we round-trip: string → prepare → layout → read back positions?
 * 4. What does Pretext give us that a simple string doesn't?
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  prepareWithSegments,
  layoutNextLine,
  layoutWithLines,
  type LayoutCursor,
} from "@chenglou/pretext";

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

const MONO_FONT = '16px Menlo, Monaco, "Courier New", monospace';
const LINE_HEIGHT = 18.4;

describe("prototype: Pretext with monospace wireframe text", () => {

  it("Q1: prepare box-drawing chars", () => {
    const wireframe = "┌──────┐\n│ Hello│\n└──────┘";
    const prepared = prepareWithSegments(wireframe, MONO_FONT, { whiteSpace: "pre-wrap" });
    console.log("Segments:", prepared.segments);
    console.log("Segment count:", prepared.segments.length);
    expect(prepared.segments.length).toBeGreaterThan(0);
  });

  it("Q2: layout preserves monospace positions", () => {
    const line = "┌──────┐";
    const prepared = prepareWithSegments(line, MONO_FONT);
    // Layout with very wide width so no wrapping occurs
    const result = layoutWithLines(prepared, 10000, LINE_HEIGHT);
    console.log("Lines:", result.lines.length);
    console.log("Line 0 text:", JSON.stringify(result.lines[0]?.text));
    console.log("Line 0 width:", result.lines[0]?.width);
    // The text should come back unchanged
    expect(result.lines[0]?.text).toBe(line);
  });

  it("Q3: multi-line wireframe layout", () => {
    const wireframe = [
      "┌──────┐",
      "│ Box  │",
      "└──────┘",
    ].join("\n");
    
    // Use pre-wrap to preserve newlines
    const prepared = prepareWithSegments(wireframe, MONO_FONT, { whiteSpace: "pre-wrap" });
    const result = layoutWithLines(prepared, 10000, LINE_HEIGHT);
    
    console.log("=== MULTI-LINE LAYOUT ===");
    for (let i = 0; i < result.lines.length; i++) {
      const l = result.lines[i];
      console.log(`  Line ${i}: text=${JSON.stringify(l.text)} width=${l.width}`);
    }
    
    // Should produce 3 lines
    expect(result.lines.length).toBe(3);
    expect(result.lines[0].text).toBe("┌──────┐");
    expect(result.lines[1].text).toBe("│ Box  │");
    expect(result.lines[2].text).toBe("└──────┘");
  });

  it("Q4: can we use layoutNextLine for obstacle-aware wireframe placement?", () => {
    // Simulate: prose text flowing, then a wireframe box, then more prose
    const prose = "The quick brown fox jumps over the lazy dog and keeps running across the page.";
    const prepared = prepareWithSegments(prose, '16px Inter, sans-serif');
    
    // Layout with a narrow width to force wrapping
    const maxWidth = 300;
    console.log("=== PROSE LAYOUT (width=300) ===");
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
    let lineNum = 0;
    while (true) {
      const line = layoutNextLine(prepared, cursor, maxWidth);
      if (!line) break;
      console.log(`  Line ${lineNum}: "${line.text}" (${line.width.toFixed(0)}px)`);
      cursor = line.end;
      lineNum++;
    }
    expect(lineNum).toBeGreaterThan(1);
  });

  it("Q6: round-trip — wireframe string → Pretext → back to string", () => {
    const original = [
      "┌───────────┬───────────┐",
      "│  Left     │  Right    │",
      "├───────────┼───────────┤",
      "│  Bottom L │  Bottom R │",
      "└───────────┴───────────┘",
    ].join("\n");
    
    const prepared = prepareWithSegments(original, MONO_FONT, { whiteSpace: "pre-wrap" });
    const result = layoutWithLines(prepared, 10000, LINE_HEIGHT);
    
    // Reconstruct the string from layout lines
    const reconstructed = result.lines.map(l => l.text).join("\n");
    
    console.log("=== ROUND-TRIP ===");
    console.log("Original:\n" + original);
    console.log("Reconstructed:\n" + reconstructed);
    console.log("Match:", original === reconstructed);
    
    expect(reconstructed).toBe(original);
  });

  it("Q7: what width does Pretext compute for a monospace wireframe?", () => {
    const lines = [
      "┌──────┐",
      "│ Box  │",
      "└──────┘",
    ];
    
    console.log("=== WIDTHS PER LINE ===");
    for (const line of lines) {
      const prepared = prepareWithSegments(line, MONO_FONT);
      const result = layoutWithLines(prepared, 10000, LINE_HEIGHT);
      console.log(`  "${line}" → width=${result.lines[0]?.width.toFixed(2)}px`);
    }
    
    // All lines should have the same width (monospace)
    const widths = lines.map(line => {
      const p = prepareWithSegments(line, MONO_FONT);
      const r = layoutWithLines(p, 10000, LINE_HEIGHT);
      return r.lines[0]?.width ?? 0;
    });
    
    console.log(`Widths: ${widths.map(w => w.toFixed(2)).join(", ")}`);
    // They should be equal (or very close)
    const spread = Math.max(...widths) - Math.min(...widths);
    console.log(`Spread: ${spread.toFixed(2)}px`);
  });
});
