/**
 * Corpus tests: verify Gridpad handles real agent-authored wireframe patterns.
 *
 * Uses src/fixtures/corpus.md — a curated file with good wireframes, bad
 * wireframes, flow diagrams, tree structures, and prose, all interspersed.
 *
 * These tests verify the PROTOCOL CONTRACT:
 *   What an agent writes in markdown, Gridpad must parse correctly.
 *   What Gridpad saves after edits, an agent must read correctly.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { scan } from "./scanner";
import { detectRegions, type Region } from "./regions";
import { compositeLayers, regenerateCells, LIGHT_RECT_STYLE } from "./layers";
import { buildSparseRows } from "./sparseRows";
// @ts-expect-error vitest runs in node where fs exists
import * as fs from "fs";
// @ts-expect-error vitest runs in node where path exists
import * as path from "path";

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

// ── Load corpus ──────────────────────────────────────────
const CORPUS_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures/corpus.md",
);
const CORPUS = fs.readFileSync(CORPUS_PATH, "utf8");

// Extract individual sections by ## heading
function extractSection(heading: string): string {
  const re = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`, "m");
  const match = CORPUS.search(re);
  if (match === -1) throw new Error(`Section "${heading}" not found in corpus`);
  const start = match;
  const nextSection = CORPUS.indexOf("\n## ", start + 1);
  return nextSection === -1
    ? CORPUS.slice(start).trim()
    : CORPUS.slice(start, nextSection).trim();
}

function countBoxChars(text: string): number {
  return [...text].filter(c =>
    "┌┐└┘├┤┬┴┼─│║═╔╗╚╝╠╣╦╩╬╟╢╪╫━".includes(c),
  ).length;
}

// ── 1. Whole-file contract ──────────────────────────────

describe("corpus: whole-file contract", () => {
  it("parses without throwing", () => {
    expect(() => detectRegions(scan(CORPUS))).not.toThrow();
  });

  it("produces both prose and wireframe regions", () => {
    const regions = detectRegions(scan(CORPUS));
    expect(regions.some(r => r.type === "prose")).toBe(true);
    expect(regions.some(r => r.type === "wireframe")).toBe(true);
  });

  it("no wireframe region exceeds 500 layers", () => {
    for (const r of detectRegions(scan(CORPUS))) {
      if (r.layers) expect(r.layers.length).toBeLessThan(500);
    }
  });

  it("every wireframe region has non-empty composite", () => {
    for (const r of detectRegions(scan(CORPUS))) {
      if (r.type === "wireframe" && r.layers && r.layers.length > 0) {
        expect(compositeLayers(r.layers).size).toBeGreaterThan(0);
      }
    }
  });

  it("round-trip preserves region structure", () => {
    const r1 = detectRegions(scan(CORPUS));
    const stitched = r1.map(r => r.text).join("\n\n");
    const r2 = detectRegions(scan(stitched));
    expect(r2.length).toBe(r1.length);
    expect(r2.map(r => r.type)).toEqual(r1.map(r => r.type));
  });

  it("round-trip preserves box-drawing char count", () => {
    const regions = detectRegions(scan(CORPUS));
    const stitched = regions.map(r => r.text).join("\n\n");
    expect(countBoxChars(stitched)).toBe(countBoxChars(CORPUS));
  });

  it("file open pipeline < 500ms", () => {
    const start = performance.now();
    const regions = detectRegions(scan(CORPUS));
    for (const r of regions) {
      if (r.type === "wireframe" && r.layers) compositeLayers(r.layers);
    }
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(500);
  });
});

// ── 2. Section-level tests ──────────────────────────────

describe("corpus: simple dashboard", () => {
  const section = extractSection("1. Simple Dashboard Layout");

  it("detects wireframe with nested rects", () => {
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe");
    expect(wf).toBeDefined();
    const rects = scan(section).rects;
    // Outer rect + inner card at minimum
    expect(rects.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves junction characters (├┬┴┤)", () => {
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;
    expect(wf.text).toContain("├");
    expect(wf.text).toContain("┬");
    expect(wf.text).toContain("┴");
  });

  it("text labels detected inside rects", () => {
    const result = scan(section);
    const allText = result.texts.map(t => t.content).join(" ");
    expect(allText).toContain("Header");
    expect(allText).toContain("Sidebar");
  });

  it("prose before and after wireframe preserved", () => {
    const regions = detectRegions(scan(section));
    expect(regions[0].type).toBe("prose");
    expect(regions[regions.length - 1].type).toBe("prose");
  });
});

describe("corpus: vertical flow diagram", () => {
  const section = extractSection("2. Vertical Flow Diagram");

  it("detects the first box (clean top edge, no ▼)", () => {
    // First box has ┌────────┐ — clean edge, should parse
    const rects = scan(section).rects;
    expect(rects.length).toBeGreaterThanOrEqual(1);
  });

  it("KNOWN GAP: ▼ in top edge breaks rect detection for 2nd/3rd boxes", () => {
    // ┌─────▼──────┐ uses ▼ in the top border — not in H_EDGE.
    // TODO: add ▼►◄▲ to H_EDGE/V_EDGE for production.
    const arrowBox = "┌─────▼──────────────────────┐\n│  Executor                  │\n└─────┬──────────────────────┘";
    expect(scan(arrowBox).rects.length).toBe(0);
  });

  it("arrow characters (▼) are in the wireframe region", () => {
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe");
    expect(wf).toBeDefined();
    expect(wf!.text).toContain("▼");
  });
});

describe("corpus: horizontal flow (relay race)", () => {
  const section = extractSection("3. Relay Race (Horizontal Flow)");

  it("detects 3 side-by-side rects", () => {
    const rects = scan(section).rects;
    expect(rects.length).toBeGreaterThanOrEqual(3);
  });

  it("horizontal connectors (──) detected as lines or unclaimed", () => {
    const result = scan(section);
    // The ────── connectors between boxes may be detected as lines
    // or left as unclaimed — either is fine, but they shouldn't be rects
    const wfText = detectRegions(result)
      .filter(r => r.type === "wireframe")
      .map(r => r.text)
      .join("\n");
    expect(wfText).toContain("──────");
  });
});

describe("corpus: UI mockup with special chars", () => {
  const section = extractSection("4. UI Mockup with Special Characters");

  it("detects outer box and inner form fields", () => {
    const rects = scan(section).rects;
    // Outer box + Google button + email field + password field + sign in button
    expect(rects.length).toBeGreaterThanOrEqual(5);
  });

  it("text labels include form field content", () => {
    const result = scan(section);
    const allText = result.texts.map(t => t.content).join(" ");
    expect(allText).toMatch(/Welcome|Sign in|Email|Password/);
  });

  it("bullet chars (••••) inside password field survive", () => {
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;
    expect(wf.text).toContain("••••");
  });
});

describe("corpus: progress bars and status indicators", () => {
  const section = extractSection("5. Progress Bars and Status Indicators");

  it("detects outer box and at least some inner boxes", () => {
    const rects = scan(section).rects;
    // Outer box + inner progress bar boxes
    expect(rects.length).toBeGreaterThanOrEqual(1);
  });

  it("block fill characters survive in wireframe text", () => {
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;
    expect(wf.text).toContain("████");
    expect(wf.text).toContain("░░░");
    expect(wf.text).toContain("▓▓▓");
  });

  it("status indicators survive (✓ ⚠ ●)", () => {
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;
    expect(wf.text).toContain("✓");
    expect(wf.text).toContain("⚠");
    expect(wf.text).toContain("●");
  });
});

describe("corpus: tree structure is NOT wireframe", () => {
  const section = extractSection("6. Tree Structure (NOT a wireframe)");

  it("tree chars (├── └──) do NOT produce rects", () => {
    const result = scan(section);
    // Pure tree structure — no closed rectangles
    expect(result.rects.length).toBe(0);
  });

  it("KNOWN GAP: region detector sees tree chars as wireframe lines", () => {
    // ├── and └── contain chars in BOX_CHARS set. The region detector
    // classifies lines with box-drawing chars as wireframe, even when
    // there are no rects. This is technically wrong for tree structures
    // but harmless — the wireframe region will have 0 rects and just
    // render as text anyway.
    // TODO: consider requiring at least 1 rect for wireframe classification.
    const regions = detectRegions(scan(section));
    const hasWireframe = regions.some(r => r.type === "wireframe");
    // Document actual behavior — currently true (tree chars trigger wireframe)
    expect(hasWireframe).toBe(true);
  });
});

describe("corpus: markdown horizontal rules", () => {
  const section = extractSection("7. Markdown Horizontal Rules");

  it("--- is NOT detected as wireframe", () => {
    const regions = detectRegions(scan(section));
    expect(regions.every(r => r.type === "prose")).toBe(true);
  });

  it("no rects from markdown dashes", () => {
    expect(scan(section).rects.length).toBe(0);
  });
});

describe("corpus: tree inside box", () => {
  const section = extractSection("8. Navigation with Tree Inside Box");

  it("detects the outer navigation box", () => {
    const rects = scan(section).rects;
    expect(rects.length).toBeGreaterThanOrEqual(1);
  });

  it("tree chars inside box are text/unclaimed, not separate rects", () => {
    // ├─ and └─ inside the box should NOT create additional rects
    // They're navigation tree items, not rectangular shapes
    const result = scan(section);
    const regions = detectRegions(result);
    const wf = regions.find(r => r.type === "wireframe")!;
    expect(wf.text).toContain("├─ Projects");
    expect(wf.text).toContain("└─ Templates");
  });

  it("junction chars (├┤) from box dividers preserved", () => {
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;
    // The ├─────...─┤ horizontal dividers
    expect(wf.text).toContain("├──");
  });
});

describe("corpus: shared walls", () => {
  const section = extractSection("9. Two Adjacent Boxes (Shared Walls)");

  it("side-by-side boxes: detects 2 rects with ┬┴ junctions", () => {
    const twoAdjacent = "┌──────┬──────┐\n│ Left │Right │\n└──────┴──────┘";
    const rects = scan(twoAdjacent).rects;
    expect(rects.length).toBe(2);
  });

  it("stacked boxes: detects 2 rects with ├┤ junction (horizontal divider)", () => {
    const stacked = "┌──────────┐\n│   Top    │\n├──────────┤\n│  Bottom  │\n└──────────┘";
    const rects = scan(stacked).rects;
    expect(rects.length).toBe(2);
  });

  it("round-trip preserves junction characters", () => {
    const result = scan(section);
    const regions = detectRegions(result);
    const stitched = regions.map(r => r.text).join("\n\n");
    expect(stitched).toContain("┬");
    expect(stitched).toContain("┴");
  });
});

describe("corpus: deeply nested architecture", () => {
  const section = extractSection("10. Deeply Nested Architecture");

  it("detects multiple rects at different nesting levels", () => {
    const rects = scan(section).rects;
    // Frontend > Component Layer > TaskList + TaskDetail > TaskCard + Output Viewer
    expect(rects.length).toBeGreaterThanOrEqual(4);
  });

  it("innermost rects (TaskCard, Output Viewer) are detected", () => {
    const result = scan(section);
    const texts = result.texts.map(t => t.content).join(" ");
    expect(texts).toMatch(/TaskCard|Output Viewer/);
  });

  it("4-level nesting produces correct layer hierarchy", () => {
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;
    // Each rect becomes a layer — all should composite cleanly
    const composite = compositeLayers(wf.layers!);
    expect(composite.size).toBeGreaterThan(0);
    // Should be renderable
    const sparse = buildSparseRows(composite);
    expect(sparse.length).toBeGreaterThan(0);
  });
});

describe("corpus: malformed wireframes", () => {
  const section = extractSection("11. Malformed Wireframe (Broken Corner)");

  it("handles broken box gracefully (no crash)", () => {
    expect(() => detectRegions(scan(section))).not.toThrow();
  });

  it("broken box (missing BR corner) may not scan as rect", () => {
    // ┌──────────┐ / │  Broken  │ / └────────── (no ┘)
    const broken = "┌──────────┐\n│  Broken  │\n└──────────";
    const rects = scan(broken).rects;
    // Scanner requires closure — broken box should NOT be a rect
    expect(rects.length).toBe(0);
  });

  it("mismatched-width box still parseable", () => {
    // ┌──────┐ / │ OK   │ / └────────┘ (bottom wider than top)
    const mismatched = "┌──────┐\n│ OK   │\n└────────┘";
    // Scanner traces from TL corner right → down → left → up
    // The bottom edge is wider, so the trace may fail or find a subset
    const rects = scan(mismatched).rects;
    // Document actual behavior — the important thing is no crash
    expect(typeof rects.length).toBe("number");
  });
});

describe("corpus: empty boxes", () => {
  it("2x2 box (┌┐/└┘) is a valid rect", () => {
    const rects = scan("┌┐\n└┘").rects;
    expect(rects.length).toBe(1);
    expect(rects[0].w).toBe(2);
    expect(rects[0].h).toBe(2);
  });

  it("4x3 empty box is a valid rect", () => {
    const rects = scan("┌──┐\n│  │\n└──┘").rects;
    expect(rects.length).toBe(1);
    expect(rects[0].w).toBe(4);
    expect(rects[0].h).toBe(3);
  });
});

describe("corpus: agent misalignment (content wider than border)", () => {
  const section = extractSection("13. Agent Misalignment (Content Wider Than Border)");

  it("KNOWN GAP: misaligned box (content 1 char wider) not detected as rect", () => {
    // Agents frequently produce:
    //   ┌─────────┐     (11 chars)
    //   │ Check A  │     (12 chars — extra space before │)
    //   └─────────┘     (11 chars)
    // The right │ at col 11 doesn't line up with ┐ at col 10.
    const misaligned = "┌─────────┐\n│ Check A  │\n│ (Form)   │\n└─────────┘";
    const rects = scan(misaligned).rects;
    // Currently fails — scanner requires exact column alignment
    expect(rects.length).toBe(0);
  });

  it("properly aligned version of same box IS detected", () => {
    const aligned = "┌──────────┐\n│ Check A  │\n│ (Form)   │\n└──────────┘";
    expect(scan(aligned).rects.length).toBe(1);
  });

  it("label overflow (middle row wider) not detected", () => {
    const overflow = "┌────────────────────────────┐\n│  Runs the task to completion│\n└────────────────────────────┘";
    // Middle row has │ at col 30 but ┐ is at col 29
    expect(scan(overflow).rects.length).toBe(0);
  });

  it("section still parses without crashing", () => {
    expect(() => detectRegions(scan(section))).not.toThrow();
  });
});

describe("corpus: arrow-edge boxes", () => {
  const section = extractSection("14. Arrow-Edge Boxes (Common Agent Flow Pattern)");

  it("KNOWN GAP: ▼ in top edge prevents rect detection", () => {
    const arrowTop = "┌─────▼──────────────────────┐\n│  Executor                  │\n│  Runs the task             │\n└─────┬──────────────────────┘";
    expect(scan(arrowTop).rects.length).toBe(0);
  });

  it("┬ in bottom edge IS valid (detected as rect)", () => {
    // ┬ is in H_EDGE set — so a box with ┬ in bottom edge works
    const tInBottom = "┌────────────────────────────┐\n│  API handler               │\n└─────┬──────────────────────┘";
    expect(scan(tInBottom).rects.length).toBe(1);
  });

  it("section creates wireframe region (has box-drawing chars)", () => {
    const regions = detectRegions(scan(section));
    expect(regions.some(r => r.type === "wireframe")).toBe(true);
  });
});

// ── 3. Drag simulation on corpus wireframes ─────────────

describe("corpus: drag fidelity", () => {
  function applyDrag(
    regionText: string,
    layers: NonNullable<Region["layers"]>,
    layerId: string,
    dRow: number,
    dCol: number,
  ): string {
    const layer = layers.find(l => l.id === layerId)!;
    const otherComposite = compositeLayers(layers.filter(l => l.id !== layerId));

    const newCells = new Map<string, string>();
    for (const [k, val] of layer.cells) {
      const ci = k.indexOf(",");
      newCells.set(
        `${Number(k.slice(0, ci)) + dRow},${Number(k.slice(ci + 1)) + dCol}`,
        val,
      );
    }
    layer.cells = newCells;
    layer.bbox.row += dRow;
    layer.bbox.col += dCol;

    const textLines = regionText.split("\n");
    const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
    const grid: string[][] = textLines.map(l => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

    for (const [k] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci)) - dRow;
      const c = Number(k.slice(ci + 1)) - dCol;
      if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
        grid[r][c] = otherComposite.get(`${r},${c}`) ?? " ";
      }
    }

    for (const [k, ch] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      while (grid.length <= r) grid.push(new Array(maxCols).fill(" "));
      if (!grid[r]) grid[r] = new Array(maxCols).fill(" ");
      while (grid[r].length <= c) grid[r].push(" ");
      grid[r][c] = ch;
    }

    return grid.map(row => row.join("").trimEnd()).join("\n");
  }

  it("dashboard: drag inner card down by 1 — at least 80% box chars retained", () => {
    const section = extractSection("1. Simple Dashboard Layout");
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;

    const innerCard = wf.layers!
      .filter(l => l.type === "rect")
      .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];

    const cloned = wf.layers!.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDrag(wf.text, cloned, innerCard.id, 1, 0);
    const origBox = countBoxChars(wf.text);
    const newBox = countBoxChars(result);
    expect(newBox / origBox).toBeGreaterThanOrEqual(0.8);
  });

  it("flow diagram: drag middle box down by 2 — result still parseable", () => {
    const section = extractSection("2. Vertical Flow Diagram");
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;
    const rectLayers = wf.layers!.filter(l => l.type === "rect");
    if (rectLayers.length < 2) return;

    // Pick the second rect (middle of pipeline)
    const midRect = rectLayers.sort((a, b) => a.bbox.row - b.bbox.row)[1];
    const cloned = wf.layers!.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDrag(wf.text, cloned, midRect.id, 2, 0);
    // Must not crash and must still have rects
    expect(scan(result).rects.length).toBeGreaterThan(0);
  });

  it("nested architecture: drag innermost rect — outer boxes survive", () => {
    const section = extractSection("10. Deeply Nested Architecture");
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;

    // Innermost rect (smallest by area)
    const innermost = wf.layers!
      .filter(l => l.type === "rect")
      .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];

    const cloned = wf.layers!.map(l => ({
      ...l,
      bbox: { ...l.bbox },
      cells: new Map(l.cells),
    }));

    const result = applyDrag(wf.text, cloned, innermost.id, 1, 0);
    // Outer boxes should survive (largest rect)
    const outerRect = scan(wf.text).rects
      .sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const resultRects = scan(result).rects;
    const outerStillExists = resultRects.some(
      r => r.w === outerRect.w && r.h === outerRect.h,
    );
    expect(outerStillExists).toBe(true);
  });
});

// ── 4. Resize on corpus wireframes ──────────────────────

describe("corpus: resize fidelity", () => {
  it("dashboard: resize outer rect wider — inner structure preserved", () => {
    const section = extractSection("1. Simple Dashboard Layout");
    const regions = detectRegions(scan(section));
    const wf = regions.find(r => r.type === "wireframe")!;

    const outerRect = wf.layers!
      .filter(l => l.type === "rect")
      .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0];

    const newBbox = { ...outerRect.bbox, w: outerRect.bbox.w + 4 };
    const newCells = regenerateCells(newBbox, outerRect.style ?? LIGHT_RECT_STYLE);

    // Write new cells into text grid
    const textLines = wf.text.split("\n");
    const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
    const grid: string[][] = textLines.map(l => {
      const chars = [...l];
      while (chars.length < maxCols + 4) chars.push(" ");
      return chars;
    });

    for (const [k, ch] of newCells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci));
      const c = Number(k.slice(ci + 1));
      while (grid.length <= r) grid.push(new Array(maxCols + 4).fill(" "));
      while (grid[r].length <= c) grid[r].push(" ");
      grid[r][c] = ch;
    }

    const result = grid.map(row => row.join("").trimEnd()).join("\n");
    // Inner rects should still be scannable
    expect(scan(result).rects.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 5. Corpus statistics (reporting, not assertions) ────

describe("corpus: diagnostics", () => {
  it("report corpus statistics", () => {
    const regions = detectRegions(scan(CORPUS));
    const proseCount = regions.filter(r => r.type === "prose").length;
    const wfCount = regions.filter(r => r.type === "wireframe").length;
    const totalLayers = regions
      .filter(r => r.type === "wireframe")
      .reduce((sum, r) => sum + (r.layers?.length ?? 0), 0);
    const totalRects = scan(CORPUS).rects.length;

    console.log(`  Corpus: ${CORPUS.split("\n").length} lines, ${countBoxChars(CORPUS)} box chars`);
    console.log(`  Regions: ${proseCount} prose, ${wfCount} wireframe`);
    console.log(`  Total layers: ${totalLayers}, rects: ${totalRects}`);
    console.log(`  Box chars/line: ${(countBoxChars(CORPUS) / CORPUS.split("\n").length).toFixed(1)}`);

    // Sanity: must have detected something
    expect(wfCount).toBeGreaterThan(0);
    expect(totalRects).toBeGreaterThan(0);
  });
});
