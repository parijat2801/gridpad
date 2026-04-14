import { describe, it, expect, vi, beforeAll } from "vitest";
import { prepareWithSegments } from "@chenglou/pretext";
import { reflowLayout, type Obstacle } from "./reflowLayout";

// ── Canvas mock for Pretext ──────────────────────────────
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

const FONT = "16px monospace";
const LINE_HEIGHT = 20;
const CANVAS_WIDTH = 600;

// Enough text to produce several lines at 600px wide
const SAMPLE_TEXT =
  "The quick brown fox jumps over the lazy dog. " +
  "Pack my box with five dozen liquor jugs. " +
  "How valiantly did brave Xerxes display his fondness for jam. " +
  "The five boxing wizards jump quickly. ";

describe("reflowLayout", () => {
  it("text with no obstacles fills full width", () => {
    const prepared = prepareWithSegments(SAMPLE_TEXT, FONT);
    const result = reflowLayout(prepared, CANVAS_WIDTH, LINE_HEIGHT, []);

    expect(result.lines.length).toBeGreaterThan(0);
    // Every line should start at x=0 (full canvas width, no obstacles)
    for (const line of result.lines) {
      expect(line.x).toBe(0);
    }
    expect(result.totalHeight).toBeGreaterThan(0);
  });

  it("text flows around a rect obstacle", () => {
    // Obstacle at x=100, y=20, w=200, h=40 — spans y=20 to y=60
    const obstacle: Obstacle = { x: 100, y: 20, w: 200, h: 40 };
    const prepared = prepareWithSegments(SAMPLE_TEXT, FONT);
    const result = reflowLayout(prepared, CANVAS_WIDTH, LINE_HEIGHT, [obstacle]);

    expect(result.lines.length).toBeGreaterThan(0);

    // Lines whose y-band overlaps [20, 60): bandTop in [20, 40)
    // These lines should be in slots that don't start at x=0 (obstacle at 100)
    // or have reduced effective width (split slots).
    const affectedLines = result.lines.filter((line) => {
      const bandTop = line.y;
      const bandBottom = line.y + LINE_HEIGHT;
      return bandBottom > obstacle.y && bandTop < obstacle.y + obstacle.h;
    });

    expect(affectedLines.length).toBeGreaterThan(0);

    // At least one affected line should start at x != 0 (right of obstacle)
    // or start at 0 with width < full canvas (left slot before obstacle)
    const hasNarrowedSlot = affectedLines.some(
      (line) => line.x !== 0 || line.width < CANVAS_WIDTH - 1,
    );
    expect(hasNarrowedSlot).toBe(true);
  });

  it("text wraps to below obstacle — returns to full width", () => {
    // Small obstacle at top of canvas, only covers first couple of lines
    const obstacle: Obstacle = { x: 0, y: 0, w: 300, h: 40 };
    const prepared = prepareWithSegments(SAMPLE_TEXT, FONT);
    const result = reflowLayout(prepared, CANVAS_WIDTH, LINE_HEIGHT, [obstacle]);

    // Lines below the obstacle (y >= 40) should start at x=0 with full width
    const belowObstacle = result.lines.filter((line) => line.y >= obstacle.y + obstacle.h);
    expect(belowObstacle.length).toBeGreaterThan(0);

    for (const line of belowObstacle) {
      expect(line.x).toBe(0);
    }
  });

  it("empty text produces no lines", () => {
    const prepared = prepareWithSegments("", FONT);
    const result = reflowLayout(prepared, CANVAS_WIDTH, LINE_HEIGHT, []);

    expect(result.lines).toHaveLength(0);
  });

  it("obstacle covering full width skips that line band", () => {
    // Obstacle covers the entire canvas width for one line band
    const obstacle: Obstacle = { x: 0, y: 0, w: CANVAS_WIDTH, h: LINE_HEIGHT };
    const prepared = prepareWithSegments(SAMPLE_TEXT, FONT);
    const result = reflowLayout(prepared, CANVAS_WIDTH, LINE_HEIGHT, [obstacle]);

    // No lines should appear in the first line band (y=0)
    const firstBandLines = result.lines.filter((line) => line.y === 0);
    expect(firstBandLines).toHaveLength(0);

    // Lines should still appear below the obstacle
    const belowLines = result.lines.filter((line) => line.y >= LINE_HEIGHT);
    expect(belowLines.length).toBeGreaterThan(0);
  });
});
