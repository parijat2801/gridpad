# Kill Regions — TDD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the region-based serialize/deserialize pipeline with a single-grid model where frames live at absolute grid positions and prose is segments of unclaimed text at exact grid positions.

**Architecture:** `scan(text)` produces a grid + shapes + unclaimed cells. `framesFromScan` creates frames at absolute grid positions (no region-relative rebasing). Prose segments are unclaimed character runs at exact `(row, col)`. Serialization deep-copies `originalGrid`, blanks prose/dirty-frame positions, writes current state back, flattens. The CM `proseSegmentMap` StateField tracks prose-line-to-grid-row mapping reactively via CM transactions.

**Tech Stack:** TypeScript, Vitest, CodeMirror 6 StateField/StateEffect

**Key structural difference from old model:** The old pipeline wrapped all layers in a wireframe region into a container frame (`content: null, clip: true`) with children relative to the container origin. The new pipeline produces NO containers — `framesFromScan` creates flat frames at absolute positions, then `reparentChildren` nests inner rects inside outer rects. Top-level frames always have `content !== null`. DemoV2's drill-down selection (click container → click child) works naturally with rects that have children — no behavior change needed.

---

### Task 1: `extractProseSegments` — pure function, prose extraction from scanner grid

Extracts prose segments from scanner's `unclaimedCells` map. A prose segment is a contiguous run of unclaimed characters on the same grid row. Rows with no unclaimed cells AND not covered by any frame bbox emit `{ row, col: 0, text: "" }` (blank separator preserving paragraph spacing).

**Files:**
- Create: `src/proseSegments.ts`
- Test: `src/proseSegments.test.ts`

**Step 1: Write the failing test**

```typescript
// src/proseSegments.test.ts
import { describe, it, expect } from "vitest";
import { extractProseSegments, type ProseSegment } from "./proseSegments";

describe("extractProseSegments", () => {
  it("extracts a single full-row prose segment", () => {
    // "Hello" on row 0, all unclaimed
    const unclaimed = new Map([
      ["0,0", "H"], ["0,1", "e"], ["0,2", "l"], ["0,3", "l"], ["0,4", "o"],
    ]);
    const grid = [["H", "e", "l", "l", "o"]];
    const frameBboxes: { row: number; col: number; w: number; h: number }[] = [];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    expect(result).toEqual([{ row: 0, col: 0, text: "Hello" }]);
  });

  it("extracts multiple segments on different rows", () => {
    const unclaimed = new Map([
      ["0,0", "A"], ["0,1", "B"],
      ["2,0", "C"], ["2,1", "D"],
    ]);
    const grid = [["A", "B"], [], ["C", "D"]];
    const frameBboxes: { row: number; col: number; w: number; h: number }[] = [];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    // Row 1 has no unclaimed cells and no frame coverage → blank separator
    expect(result).toEqual([
      { row: 0, col: 0, text: "AB" },
      { row: 1, col: 0, text: "" },
      { row: 2, col: 0, text: "CD" },
    ]);
  });

  it("extracts inline annotation next to wireframe", () => {
    // Row has unclaimed cells starting at col 12 (after a wireframe)
    const unclaimed = new Map([
      ["0,12", "N"], ["0,13", "o"], ["0,14", "t"], ["0,15", "e"],
    ]);
    const grid = [["└", "─", "─", "─", "─", "┘", " ", " ", " ", " ", " ", " ", "N", "o", "t", "e"]];
    const frameBboxes = [{ row: 0, col: 0, w: 6, h: 1 }];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    expect(result).toEqual([{ row: 0, col: 12, text: "Note" }]);
  });

  it("skips rows entirely covered by a frame bbox", () => {
    // Row 1 is fully inside a frame bbox — no blank separator emitted
    const unclaimed = new Map([
      ["0,0", "T"], ["0,1", "o"], ["0,2", "p"],
      ["3,0", "B"], ["3,1", "o"], ["3,2", "t"],
    ]);
    const grid = [["T", "o", "p"], ["┌", "─", "┐"], ["└", "─", "┘"], ["B", "o", "t"]];
    const frameBboxes = [{ row: 1, col: 0, w: 3, h: 2 }];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    // Rows 1-2 covered by frame → no blank separator
    expect(result).toEqual([
      { row: 0, col: 0, text: "Top" },
      { row: 3, col: 0, text: "Bot" },
    ]);
  });

  it("handles empty grid", () => {
    const result = extractProseSegments(new Map(), [], []);
    expect(result).toEqual([]);
  });

  it("handles multiple runs on same row (gap between unclaimed cells)", () => {
    // Row 0: "AB" at col 0-1, gap (claimed by frame), "CD" at col 5-6
    const unclaimed = new Map([
      ["0,0", "A"], ["0,1", "B"],
      ["0,5", "C"], ["0,6", "D"],
    ]);
    const grid = [["A", "B", "│", " ", "│", "C", "D"]];
    const frameBboxes = [{ row: 0, col: 2, w: 3, h: 1 }];
    const result = extractProseSegments(unclaimed, grid, frameBboxes);
    // Two separate runs on the same row
    expect(result).toEqual([
      { row: 0, col: 0, text: "AB" },
      { row: 0, col: 5, text: "CD" },
    ]);
  });

  it("preserves trailing spaces within a run", () => {
    const unclaimed = new Map([
      ["0,0", "H"], ["0,1", "i"], ["0,2", " "], ["0,3", " "],
    ]);
    const grid = [["H", "i", " ", " "]];
    const result = extractProseSegments(unclaimed, grid, []);
    expect(result).toEqual([{ row: 0, col: 0, text: "Hi  " }]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/proseSegments.test.ts`
Expected: FAIL — module `./proseSegments` not found

**Step 3: Write minimal implementation**

```typescript
// src/proseSegments.ts

export interface ProseSegment {
  row: number;
  col: number;
  text: string;
}

/**
 * Extract prose segments from scanner's unclaimed cells.
 * Groups consecutive unclaimed cells on the same row into runs.
 * Rows with no unclaimed cells and not covered by any frame bbox
 * emit { row, col: 0, text: "" } to preserve paragraph spacing.
 */
export function extractProseSegments(
  unclaimedCells: Map<string, string>,
  grid: string[][],
  frameBboxes: { row: number; col: number; w: number; h: number }[],
): ProseSegment[] {
  if (grid.length === 0) return [];

  // Build set of rows covered by frame bboxes
  const frameCoveredRows = new Set<number>();
  for (const bbox of frameBboxes) {
    for (let r = bbox.row; r < bbox.row + bbox.h; r++) {
      frameCoveredRows.add(r);
    }
  }

  // Group unclaimed cells by row, then sort by col within each row
  const rowMap = new Map<number, { col: number; ch: string }[]>();
  for (const [key, ch] of unclaimedCells) {
    const ci = key.indexOf(",");
    const r = Number(key.slice(0, ci));
    const c = Number(key.slice(ci + 1));
    let arr = rowMap.get(r);
    if (!arr) { arr = []; rowMap.set(r, arr); }
    arr.push({ col: c, ch });
  }

  const segments: ProseSegment[] = [];

  for (let r = 0; r < grid.length; r++) {
    const cells = rowMap.get(r);
    if (!cells || cells.length === 0) {
      // No unclaimed cells on this row
      if (!frameCoveredRows.has(r)) {
        // Not covered by frame → blank separator
        segments.push({ row: r, col: 0, text: "" });
      }
      continue;
    }

    // Sort by column
    cells.sort((a, b) => a.col - b.col);

    // Group into contiguous runs
    let runStart = cells[0].col;
    let runChars: string[] = [cells[0].ch];
    let prevCol = cells[0].col;

    for (let i = 1; i < cells.length; i++) {
      if (cells[i].col === prevCol + 1) {
        runChars.push(cells[i].ch);
        prevCol = cells[i].col;
      } else {
        segments.push({ row: r, col: runStart, text: runChars.join("") });
        runStart = cells[i].col;
        runChars = [cells[i].ch];
        prevCol = cells[i].col;
      }
    }
    segments.push({ row: r, col: runStart, text: runChars.join("") });
  }

  // Sort by row, then col
  segments.sort((a, b) => a.row - b.row || a.col - b.col);
  return segments;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/proseSegments.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/proseSegments.ts src/proseSegments.test.ts
git commit -m "feat: add extractProseSegments — prose extraction from scanner grid"
```

---

### Task 2: `framesFromScan` — replaces `framesFromRegions`

Creates frames at absolute grid positions from scanner output. Excludes `base`-type layers (those are unclaimed characters handled by prose segments). Each non-base layer becomes a frame at `x = bbox.col * cw, y = bbox.row * ch`. Reuses `reparentChildren` from `autoLayout.ts` unchanged. Unlike the old `framesFromRegions`, NO container frame is created — top-level frames always have `content !== null`. `reparentChildren` handles nesting inner rects into outer rects.

**Note:** `reparentChildren` mutates in-place and rebases child x/y to parent-relative coordinates (`child.x - parent.x`). After the call, only top-level frames remain at absolute grid positions. Children have small parent-relative x/y values. This is correct and matches the frame model.

**Files:**
- Modify: `src/frame.ts` — add `framesFromScan`, keep `framesFromRegions` temporarily
- Test: `src/frame.test.ts` (create)

**Step 1: Write the failing test**

```typescript
// src/frame.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { framesFromScan, type Frame } from "./frame";
import { scan } from "./scanner";

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

describe("framesFromScan", () => {
  it("single rect produces one frame at absolute grid position", () => {
    const scanResult = scan("┌──┐\n│  │\n└──┘");
    const frames = framesFromScan(scanResult, CW, CH);
    expect(frames).toHaveLength(1);
    // Frame at absolute position: col 0, row 0
    expect(frames[0].x).toBe(0);
    expect(frames[0].y).toBe(0);
    expect(frames[0].w).toBe(4 * CW);
    expect(frames[0].h).toBe(3 * CH);
    expect(frames[0].dirty).toBe(false);
    // No container — top-level frame has content
    expect(frames[0].content).not.toBeNull();
    expect(frames[0].content?.type).toBe("rect");
  });

  it("rect offset from origin has correct absolute position", () => {
    // 2 spaces before rect on row 2
    const text = "\n\n  ┌──┐\n  │  │\n  └──┘";
    const scanResult = scan(text);
    const frames = framesFromScan(scanResult, CW, CH);
    expect(frames).toHaveLength(1);
    expect(frames[0].x).toBe(2 * CW);
    expect(frames[0].y).toBe(2 * CH);
  });

  it("excludes base-type layers (unclaimed chars)", () => {
    // "Hello" is unclaimed text — should NOT become a frame
    const scanResult = scan("Hello\n\n┌──┐\n│  │\n└──┘");
    const frames = framesFromScan(scanResult, CW, CH);
    // Only the rect, not the prose text
    expect(frames).toHaveLength(1);
    expect(frames[0].content?.type).toBe("rect");
  });

  it("nested rects get reparented via reparentChildren", () => {
    const text = [
      "┌────────────────────────┐",
      "│  Outer                 │",
      "│  ┌──────────────────┐  │",
      "│  │  Inner            │  │",
      "│  └──────────────────┘  │",
      "└────────────────────────┘",
    ].join("\n");
    const scanResult = scan(text);
    const frames = framesFromScan(scanResult, CW, CH);
    // Outer rect is top-level with content, inner rect is reparented as child
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const outerRect = frames.find(f => f.content?.type === "rect" && f.children.length > 0);
    expect(outerRect).toBeDefined();
  });

  it("text labels become text-type frames", () => {
    const text = "┌──────────────┐\n│    Hello     │\n└──────────────┘";
    const scanResult = scan(text);
    const frames = framesFromScan(scanResult, CW, CH);
    const allFrames: Frame[] = [];
    const collectFrames = (fs: Frame[]) => {
      for (const f of fs) { allFrames.push(f); collectFrames(f.children); }
    };
    collectFrames(frames);
    const textFrame = allFrames.find(f => f.content?.type === "text");
    expect(textFrame).toBeDefined();
    expect(textFrame!.content!.text).toBe("Hello");
  });

  it("pure prose (no shapes) returns empty array", () => {
    const scanResult = scan("Just some text");
    const frames = framesFromScan(scanResult, CW, CH);
    expect(frames).toHaveLength(0);
  });

  it("side-by-side rects produce separate top-level frames", () => {
    const text = [
      "┌──────┐  ┌──────┐",
      "│  A   │  │  B   │",
      "└──────┘  └──────┘",
    ].join("\n");
    const scanResult = scan(text);
    const frames = framesFromScan(scanResult, CW, CH);
    // Should have 2 separate rect frames (not grouped into a container)
    const rectFrames = frames.filter(f => f.content?.type === "rect");
    expect(rectFrames.length).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/frame.test.ts`
Expected: FAIL — `framesFromScan` not exported

**Step 3: Write minimal implementation**

Add to `src/frame.ts` after `framesFromRegions` (around line 329):

```typescript
// ── framesFromScan ────────────────────────────────────────
// Replaces framesFromRegions. Creates frames at absolute grid positions.
// No container frames — top-level frames always have content.
// reparentChildren nests inner rects inside outer rects.

export function framesFromScan(
  scanResult: ScanResult,
  charWidth: number,
  charHeight: number,
): Frame[] {
  const allLayers = buildLayersFromScan(scanResult);
  // Exclude base-type layers — those are unclaimed chars (prose)
  const shapeLayers = allLayers.filter(l => l.type !== "base");
  if (shapeLayers.length === 0) return [];

  // Each layer becomes a frame at its absolute grid position
  const frames: Frame[] = shapeLayers.map((layer) => {
    const x = layer.bbox.col * charWidth;
    const y = layer.bbox.row * charHeight;
    const w = layer.bbox.w * charWidth;
    const h = layer.bbox.h * charHeight;

    // Rebase cells to origin (0,0)
    const rebasedCells = new Map<string, string>();
    for (const [key, val] of layer.cells) {
      const ci = key.indexOf(",");
      const r = Number(key.slice(0, ci)) - layer.bbox.row;
      const c = Number(key.slice(ci + 1)) - layer.bbox.col;
      rebasedCells.set(`${r},${c}`, val);
    }

    let content: FrameContent | null = null;
    if (layer.type === "rect" && layer.style) {
      content = { type: "rect", cells: rebasedCells, style: layer.style };
    } else if (layer.type === "line") {
      content = { type: "line", cells: rebasedCells };
    } else if (layer.type === "text") {
      content = { type: "text", cells: rebasedCells, text: layer.content ?? "" };
    } else {
      content = { type: "rect", cells: rebasedCells, style: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" } };
    }

    return {
      id: nextId(),
      x, y, w, h,
      z: 0,
      children: [],
      content,
      clip: false,
      dirty: false,
    };
  });

  // Reparent children into enclosing rects
  reparentChildren(frames, charWidth, charHeight);
  return frames;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/frame.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/frame.ts src/frame.test.ts
git commit -m "feat: add framesFromScan — absolute-position frame creation without regions"
```

---

### Task 3: `scanToFrames` new implementation — drops `detectRegions`

New signature returns `{ frames, proseSegments, originalGrid }`. No more regions.

**Files:**
- Modify: `src/scanToFrames.ts`
- Modify: `src/scanToFrames.test.ts`

**Step 1: Write the failing test**

Replace `src/scanToFrames.test.ts`:

```typescript
// src/scanToFrames.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { scanToFrames } from "./scanToFrames";

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

describe("scanToFrames (grid-based)", () => {
  it("returns originalGrid as the scanner's grid", () => {
    const { originalGrid } = scanToFrames("Hello\n┌─┐\n└─┘", 9.6, 18.4);
    expect(originalGrid).toHaveLength(3);
    expect(originalGrid[0].join("")).toBe("Hello");
  });

  it("returns proseSegments instead of prose/regions", () => {
    const result = scanToFrames("Hello world", 9.6, 18.4);
    expect(result.proseSegments).toBeDefined();
    expect(result.proseSegments[0]).toEqual({ row: 0, col: 0, text: "Hello world" });
    // Old fields should not exist
    expect((result as any).prose).toBeUndefined();
    expect((result as any).regions).toBeUndefined();
  });

  it("pure prose returns no frames", () => {
    const { frames, proseSegments } = scanToFrames("Hello world", 9.6, 18.4);
    expect(frames).toHaveLength(0);
    expect(proseSegments.length).toBeGreaterThan(0);
  });

  it("single rect returns frames at absolute positions", () => {
    const { frames, proseSegments } = scanToFrames("┌─┐\n│ │\n└─┘", 9.6, 18.4);
    expect(frames).toHaveLength(1);
    // No prose segments inside the rect
    expect(proseSegments).toHaveLength(0);
  });

  it("prose + wireframe returns both", () => {
    const text = "Hello\n\n┌──┐\n│  │\n└──┘\n\nWorld";
    const { frames, proseSegments } = scanToFrames(text, 9.6, 18.4);
    expect(frames.length).toBeGreaterThan(0);
    expect(proseSegments.some(s => s.text === "Hello")).toBe(true);
    expect(proseSegments.some(s => s.text === "World")).toBe(true);
  });

  it("empty string returns empty everything", () => {
    const { frames, proseSegments, originalGrid } = scanToFrames("", 9.6, 18.4);
    expect(frames).toHaveLength(0);
    expect(proseSegments).toHaveLength(0);
    expect(originalGrid).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/scanToFrames.test.ts`
Expected: FAIL — return type mismatch (old returns `{ frames, prose, regions }`)

**Step 3: Write minimal implementation**

Replace `src/scanToFrames.ts`:

```typescript
// src/scanToFrames.ts
import { scan } from "./scanner";
import { framesFromScan, type Frame } from "./frame";
import { extractProseSegments, type ProseSegment } from "./proseSegments";

export function scanToFrames(
  text: string,
  charWidth: number,
  charHeight: number,
): {
  frames: Frame[];
  proseSegments: ProseSegment[];
  originalGrid: string[][];
} {
  const scanResult = scan(text);
  const frames = framesFromScan(scanResult, charWidth, charHeight);

  // Collect frame bboxes for prose extraction
  const frameBboxes = scanResult.rects.map(r => ({
    row: r.row, col: r.col, w: r.w, h: r.h,
  }));
  // Also include lines that have box chars (same logic as old detectRegions)
  for (const line of scanResult.lines) {
    const minR = Math.min(line.r1, line.r2);
    const maxR = Math.max(line.r1, line.r2);
    const minC = Math.min(line.c1, line.c2);
    const maxC = Math.max(line.c1, line.c2);
    frameBboxes.push({ row: minR, col: minC, w: maxC - minC + 1, h: maxR - minR + 1 });
  }

  const proseSegments = extractProseSegments(
    scanResult.unclaimedCells,
    scanResult.grid,
    frameBboxes,
  );

  return { frames, proseSegments, originalGrid: scanResult.grid };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/scanToFrames.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/scanToFrames.ts src/scanToFrames.test.ts
git commit -m "feat: scanToFrames returns proseSegments + originalGrid, drops detectRegions"
```

---

### Task 4: `gridSerialize` — replaces `framesToMarkdown`

Four-phase serialization: (A) deep-copy grid + blank prose AND dirty/deleted frame positions, (B) write dirty frame cells, (C) write current prose segments, (D) flatten to text.

**Phase A — Prose blanking:** Only blank the *exact character positions* of each original prose segment: `(row, col)` to `(row, col + text.length)`. Do NOT blank from `col` to end-of-row — that would destroy non-dirty frame characters that share the same row (e.g., inline annotations next to wireframes).

**Phase A — Dirty/deleted frame blanking (Gemini finding #1):** The `originalGrid` retains all characters from file load. When a frame moves, its old grid position must be erased or you get ghost characters. `gridSerialize` takes an `originalFrameBboxes` parameter — the bounding boxes of all frames at the time of the last save/load. For each original bbox that either (a) belongs to a frame now marked `dirty`, or (b) no longer exists in the current frame list (deleted), blank that bbox in the working grid. This ensures moved/deleted wireframes don't leave ghosts.

**Phase C — Write prose per CM doc line.** For v1, Phase C writes full CM doc lines at `proseSegmentMap[i]` positions. This is correct for the common case (one prose segment per row). The rare case — inline annotations next to wireframes on the same row — may overwrite non-dirty frame characters with space padding. This is an acceptable v1 limitation; Phase B will restore dirty frame cells, and non-dirty frames sharing a row with prose is uncommon. A follow-up can add per-segment writing if needed.

**Files:**
- Create: `src/gridSerialize.ts`
- Create: `src/gridSerialize.test.ts`

**Step 1: Write the failing test**

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/gridSerialize.test.ts`
Expected: FAIL — module `./gridSerialize` not found

**Step 3: Write minimal implementation**

```typescript
// src/gridSerialize.ts
import type { Frame } from "./frame";
import type { ProseSegment } from "./proseSegments";

/** Bounding box in grid coordinates for tracking original frame positions. */
export interface FrameBbox {
  row: number;
  col: number;
  w: number;
  h: number;
  id: string;
}

/**
 * Grid-based serialization. Replaces framesToMarkdown.
 *
 * Phase A: Deep-copy originalGrid, blank original prose positions AND
 *          dirty/deleted frame original positions.
 * Phase B: Write dirty frame cells at their CURRENT positions.
 * Phase C: Write current prose per CM doc line at proseSegmentMap positions.
 * Phase D: Flatten grid to text.
 */
export function gridSerialize(
  frames: Frame[],
  prose: string,
  proseSegmentMap: { row: number; col: number }[],
  originalGrid: string[][],
  charWidth: number,
  charHeight: number,
  originalProseSegments: ProseSegment[],
  originalFrameBboxes?: FrameBbox[],
): string {
  // Phase A — deep-copy grid
  const grid: string[][] = originalGrid.map(row => [...row]);

  // Expand grid if any frame extends beyond original bounds
  for (const f of frames) {
    expandGridForFrame(grid, f, 0, 0, charWidth, charHeight);
  }

  // Blank original prose segment positions (exact positions only)
  for (const seg of originalProseSegments) {
    if (seg.row >= grid.length) continue;
    const chars = [...seg.text];
    for (let c = seg.col; c < seg.col + chars.length && c < grid[seg.row].length; c++) {
      grid[seg.row][c] = " ";
    }
  }

  // Blank original positions of dirty/deleted frames
  if (originalFrameBboxes) {
    // Collect current frame IDs (recursively)
    const currentIds = new Set<string>();
    const collectIds = (fs: Frame[]) => {
      for (const f of fs) { currentIds.add(f.id); collectIds(f.children); }
    };
    collectIds(frames);

    // Collect dirty frame IDs (recursively)
    const dirtyIds = new Set<string>();
    const collectDirty = (fs: Frame[]) => {
      for (const f of fs) { if (f.dirty) dirtyIds.add(f.id); collectDirty(f.children); }
    };
    collectDirty(frames);

    for (const bbox of originalFrameBboxes) {
      // Blank if frame is dirty (moved/resized) or deleted
      if (dirtyIds.has(bbox.id) || !currentIds.has(bbox.id)) {
        for (let r = bbox.row; r < bbox.row + bbox.h && r < grid.length; r++) {
          for (let c = bbox.col; c < bbox.col + bbox.w && c < grid[r].length; c++) {
            grid[r][c] = " ";
          }
        }
      }
    }
  }

  // Phase B — write dirty frame cells at CURRENT positions
  for (const f of frames) {
    writeFrameToGrid(grid, f, 0, 0, charWidth, charHeight);
  }

  // Phase C — write prose per CM doc line
  const proseLines = prose.split("\n");
  for (let i = 0; i < proseSegmentMap.length && i < proseLines.length; i++) {
    const { row, col } = proseSegmentMap[i];
    const chars = [...proseLines[i]];
    while (grid.length <= row) grid.push([]);
    while (grid[row].length < col + chars.length) grid[row].push(" ");
    for (let c = 0; c < chars.length; c++) {
      grid[row][col + c] = chars[c];
    }
  }

  // Phase D — flatten
  const lines = grid.map(row => row.join("").trimEnd());
  // Strip trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function rebuildOriginalGrid(text: string): string[][] {
  if (!text) return [];
  return text.split("\n").map(line => [...line]);
}

/** Snapshot frame bounding boxes for next save's dirty/delete detection. */
export function snapshotFrameBboxes(
  frames: Frame[],
  charWidth: number,
  charHeight: number,
): FrameBbox[] {
  const bboxes: FrameBbox[] = [];
  const collect = (fs: Frame[], offX: number, offY: number) => {
    for (const f of fs) {
      const absX = offX + f.x;
      const absY = offY + f.y;
      if (f.content) {
        bboxes.push({
          id: f.id,
          row: Math.round(absY / charHeight),
          col: Math.round(absX / charWidth),
          w: Math.round(f.w / charWidth),
          h: Math.round(f.h / charHeight),
        });
      }
      collect(f.children, absX, absY);
    }
  };
  collect(frames, 0, 0);
  return bboxes;
}

function expandGridForFrame(
  grid: string[][],
  f: Frame,
  offX: number,
  offY: number,
  cw: number,
  ch: number,
): void {
  const endRow = Math.round((offY + f.y + f.h) / ch);
  const endCol = Math.round((offX + f.x + f.w) / cw);
  while (grid.length < endRow) grid.push([]);
  for (const row of grid) {
    while (row.length < endCol) row.push(" ");
  }
  for (const child of f.children) {
    expandGridForFrame(grid, child, offX + f.x, offY + f.y, cw, ch);
  }
}

function writeFrameToGrid(
  grid: string[][],
  f: Frame,
  offX: number,
  offY: number,
  cw: number,
  ch: number,
): void {
  const absX = offX + f.x;
  const absY = offY + f.y;

  if (f.dirty && f.content) {
    // Blank the frame's CURRENT bounding box
    const startRow = Math.round(absY / ch);
    const startCol = Math.round(absX / cw);
    const endRow = Math.round((absY + f.h) / ch);
    const endCol = Math.round((absX + f.w) / cw);
    for (let r = startRow; r < endRow && r < grid.length; r++) {
      for (let c = startCol; c < endCol && c < grid[r].length; c++) {
        grid[r][c] = " ";
      }
    }

    // Write cells at current position
    const gridRow = Math.round(absY / ch);
    const gridCol = Math.round(absX / cw);
    for (const [key, ch_] of f.content.cells) {
      const ci = key.indexOf(",");
      const r = gridRow + Number(key.slice(0, ci));
      const c = gridCol + Number(key.slice(ci + 1));
      if (r >= 0 && r < grid.length && c >= 0 && c < grid[r].length) {
        grid[r][c] = ch_;
      }
    }
  }

  // Recurse into children
  for (const child of f.children) {
    writeFrameToGrid(grid, child, absX, absY, cw, ch);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/gridSerialize.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/gridSerialize.ts src/gridSerialize.test.ts
git commit -m "feat: add gridSerialize — grid-based serialization replacing framesToMarkdown"
```

---

### Task 5: `proseSegmentMapField` — CM StateField for prose line → grid position

A `StateField<Array<{ row: number; col: number }>>` that tracks which grid row each CM doc line maps to. Updated reactively via CM transactions.

**Key design decision — line-count delta approach:** Instead of iterating `tr.changes.iterChangedRanges()` and counting `\n` characters in old/new text (fragile for multi-range changes), we compare `tr.startState.doc.lines` vs `tr.state.doc.lines` to get the net delta, then find the change position to know where to splice. This handles paste, multi-line delete, undo/redo, replace-selection correctly because CM transactions are atomic.

**Files:**
- Modify: `src/editorState.ts` — add field + accessor
- Modify: `src/editorState.test.ts` — add tests

**Step 1: Write the failing test**

Add to `src/editorState.test.ts`:

```typescript
// Add import at top:
// import { getProseSegmentMap } from "./editorState";

describe("proseSegmentMapField", () => {
  it("initializes from prose segments", () => {
    const state = createEditorState({
      prose: "Hello\n\nWorld",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }],
    });
    const map = getProseSegmentMap(state);
    expect(map).toEqual([{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }]);
  });

  it("inserting newline adds entry and shifts subsequent rows", () => {
    const state = createEditorState({
      prose: "Line1\nLine2",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }, { row: 1, col: 0 }],
    });
    // Insert newline at end of line 1
    const updated = proseInsert(state, { row: 0, col: 5 }, "\n");
    const map = getProseSegmentMap(updated);
    expect(map).toHaveLength(3);
    expect(map[0]).toEqual({ row: 0, col: 0 });
    expect(map[1]).toEqual({ row: 1, col: 0 }); // new line
    expect(map[2]).toEqual({ row: 2, col: 0 }); // shifted down
  });

  it("deleting newline (line merge) removes entry and shifts rows up", () => {
    const state = createEditorState({
      prose: "Line1\nLine2\nLine3",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }],
    });
    // Delete backward at start of line 2 (merges into line 1)
    const updated = proseDeleteBefore(state, { row: 1, col: 0 });
    const map = getProseSegmentMap(updated);
    expect(map).toHaveLength(2);
    expect(map[0]).toEqual({ row: 0, col: 0 });
    expect(map[1]).toEqual({ row: 1, col: 0 }); // shifted up from row 2
  });

  it("multi-line paste adds multiple entries", () => {
    const state = createEditorState({
      prose: "Before\nAfter",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }, { row: 1, col: 0 }],
    });
    // Paste 3 lines at end of line 1
    const updated = proseInsert(state, { row: 0, col: 6 }, "\nPasted1\nPasted2");
    const map = getProseSegmentMap(updated);
    expect(map).toHaveLength(4); // Before, Pasted1, Pasted2, After
    expect(map[3]).toEqual({ row: 3, col: 0 }); // After shifted down by 2
  });

  it("no-op transaction preserves map", () => {
    const state = createEditorState({
      prose: "Hello",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }],
    });
    // Character insert (no newlines) — map stays same length
    const updated = proseInsert(state, { row: 0, col: 5 }, "!");
    const map = getProseSegmentMap(updated);
    expect(map).toHaveLength(1);
    expect(map[0]).toEqual({ row: 0, col: 0 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/editorState.test.ts`
Expected: FAIL — `getProseSegmentMap` not exported, `proseSegmentMap` not in `EditorStateInit`

**Step 3: Write minimal implementation**

In `src/editorState.ts`:

1. Add `proseSegmentMap` to `EditorStateInit`:

```typescript
interface EditorStateInit {
  prose: string;
  frames: Frame[];
  proseSegmentMap?: { row: number; col: number }[];
  // Keep regions/proseParts temporarily for backward compat during migration
  regions?: Region[];
  proseParts?: ProsePart[];
}
```

2. Add the StateField using line-count delta:

```typescript
const proseSegmentMapField = StateField.define<{ row: number; col: number }[]>({
  create: () => [],
  update(map, tr: Transaction) {
    if (!tr.docChanged) return map;

    const oldLines = tr.startState.doc.lines;
    const newLines = tr.state.doc.lines;
    const delta = newLines - oldLines;
    if (delta === 0) return map; // No line count change

    // Find the line where the change starts (0-indexed)
    let changeLine = 0;
    tr.changes.iterChangedRanges((fromA) => {
      changeLine = tr.startState.doc.lineAt(fromA).number - 1;
    });

    const result = [...map];
    if (delta > 0) {
      // Lines added — insert entries after changeLine, shift subsequent rows
      const insertAt = changeLine + 1;
      const newEntries: { row: number; col: number }[] = [];
      const baseRow = result[changeLine]?.row ?? changeLine;
      for (let i = 0; i < delta; i++) {
        newEntries.push({ row: baseRow + 1 + i, col: 0 });
      }
      result.splice(insertAt, 0, ...newEntries);
      // Shift all subsequent entries
      for (let i = insertAt + delta; i < result.length; i++) {
        result[i] = { ...result[i], row: result[i].row + delta };
      }
    } else {
      // Lines removed — remove entries, shift subsequent rows up
      const removeAt = changeLine + 1;
      const removeCount = Math.min(-delta, result.length - removeAt);
      result.splice(removeAt, removeCount);
      for (let i = removeAt; i < result.length; i++) {
        result[i] = { ...result[i], row: result[i].row + delta };
      }
    }
    return result;
  },
});

export function getProseSegmentMap(state: EditorState): { row: number; col: number }[] {
  return state.field(proseSegmentMapField);
}
```

3. Add to `createEditorState` extensions:

```typescript
if (init.proseSegmentMap) {
  extensions.push(proseSegmentMapField.init(() => init.proseSegmentMap!));
} else {
  extensions.push(proseSegmentMapField);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/editorState.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: add proseSegmentMapField — reactive prose-line-to-grid-row tracking"
```

---

### Task 6: Rewrite `createEditorStateFromText` — use new pipeline

Update to call `scanToFrames` (new shape) and construct `proseSegmentMap` from prose segments. This also stores `originalProseSegments` in a StateField so `gridSerialize` can access them for Phase A blanking.

**Files:**
- Modify: `src/editorState.ts`
- Add tests to: `src/editorState.test.ts`

**Step 1: Write the failing test**

```typescript
describe("createEditorStateFromText (grid-based)", () => {
  it("constructs state with proseSegmentMap from prose segments", () => {
    const state = createEditorStateFromText(
      "Hello\n\n┌──┐\n│  │\n└──┘\n\nWorld",
      9.6, 18.4,
    );
    const map = getProseSegmentMap(state);
    expect(map.length).toBeGreaterThan(0);
    // First prose segment should be at row 0
    expect(map[0].row).toBe(0);
  });

  it("builds CM doc from prose segments joined by newlines", () => {
    const state = createEditorStateFromText("Hello\n\nWorld", 9.6, 18.4);
    const doc = getDoc(state);
    expect(doc).toContain("Hello");
    expect(doc).toContain("World");
  });

  it("frames are at absolute grid positions", () => {
    const state = createEditorStateFromText(
      "Prose\n\n┌──┐\n│  │\n└──┘",
      9.6, 18.4,
    );
    const frames = getFrames(state);
    expect(frames.length).toBeGreaterThan(0);
    // Frame should be at absolute y = row * ch, not relative to region
    expect(frames[0].y).toBe(2 * 18.4);
  });

  it("stores originalProseSegments for serialization", () => {
    const state = createEditorStateFromText("Hello\n\nWorld", 9.6, 18.4);
    const origSegs = getOriginalProseSegments(state);
    expect(origSegs.length).toBeGreaterThan(0);
    expect(origSegs.some(s => s.text === "Hello")).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/editorState.test.ts`
Expected: FAIL — frames[0].y won't be at absolute position with old code; `getOriginalProseSegments` not exported

**Step 3: Write minimal implementation**

Add `originalProseSegmentsField` StateField and accessor:

```typescript
import type { ProseSegment } from "./proseSegments";

const originalProseSegmentsField = StateField.define<ProseSegment[]>({
  create: () => [],
  update(segs) { return segs; }, // Immutable — only set at load, reset after save
});

export function getOriginalProseSegments(state: EditorState): ProseSegment[] {
  return state.field(originalProseSegmentsField);
}
```

Add `originalProseSegments` to `EditorStateInit`:

```typescript
interface EditorStateInit {
  prose: string;
  frames: Frame[];
  proseSegmentMap?: { row: number; col: number }[];
  originalProseSegments?: ProseSegment[];
  // Keep regions/proseParts temporarily
  regions?: Region[];
  proseParts?: ProsePart[];
}
```

Add to `createEditorState` extensions:

```typescript
if (init.originalProseSegments) {
  extensions.push(originalProseSegmentsField.init(() => init.originalProseSegments!));
} else {
  extensions.push(originalProseSegmentsField);
}
```

Replace `createEditorStateFromText`:

```typescript
export function createEditorStateFromText(
  text: string,
  charWidth: number,
  charHeight: number,
): EditorState {
  const { frames, proseSegments, originalGrid } = scanToFrames(text, charWidth, charHeight);

  // Build CM doc: each prose segment row becomes a doc line
  // Group segments by row, join text within same row
  const byRow = new Map<number, string>();
  for (const seg of proseSegments) {
    const existing = byRow.get(seg.row) ?? "";
    if (existing && seg.col > existing.length) {
      byRow.set(seg.row, existing + " ".repeat(seg.col - existing.length) + seg.text);
    } else {
      byRow.set(seg.row, existing + seg.text);
    }
  }
  const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
  const proseText = sortedRows.map(r => byRow.get(r)!).join("\n");

  // Build proseSegmentMap: index = CM doc line, value = grid position
  const proseSegmentMap = sortedRows.map(r => {
    const seg = proseSegments.find(s => s.row === r);
    return { row: r, col: seg?.col ?? 0 };
  });

  return createEditorState({
    prose: proseText,
    frames,
    proseSegmentMap,
    originalProseSegments: proseSegments,
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/editorState.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: createEditorStateFromText uses grid-based pipeline"
```

---

### Task 7: New round-trip tests using `gridSerialize`

Replace the old round-trip tests that used `framesToMarkdown` + regions with the new `gridSerialize` pipeline.

**Files:**
- Rewrite: `src/roundtrip.test.ts`

**Step 1: Write the failing test**

```typescript
// src/roundtrip.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { scanToFrames } from "./scanToFrames";
import { gridSerialize, snapshotFrameBboxes } from "./gridSerialize";
import {
  createEditorStateFromText,
  getFrames,
  getProseSegmentMap,
  getOriginalProseSegments,
  getDoc,
  applyMoveFrame,
} from "./editorState";

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

/** Full round-trip using new grid pipeline */
function roundTrip(text: string): string {
  const { originalGrid } = scanToFrames(text, CW, CH);
  const state = createEditorStateFromText(text, CW, CH);
  return gridSerialize(
    getFrames(state),
    getDoc(state),
    getProseSegmentMap(state),
    originalGrid,
    CW, CH,
    getOriginalProseSegments(state),
  );
}

describe("round-trip: no edits", () => {
  it("simple box passes through unchanged", () => {
    const text = "Prose above\n\n┌──────┐\n│      │\n└──────┘\n\nProse below";
    expect(roundTrip(text)).toBe(text);
  });

  it("box with text label preserves label", () => {
    const text = "Title\n\n┌──────────────┐\n│    Hello     │\n└──────────────┘\n\nEnd";
    expect(roundTrip(text)).toBe(text);
  });

  it("junction characters ├┬┤┴┼ are preserved", () => {
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
    expect(roundTrip(text)).toBe(text);
  });

  it("nested boxes preserve both levels", () => {
    const text = [
      "Prose",
      "",
      "┌────────────────────────┐",
      "│  Outer                 │",
      "│  ┌──────────────────┐  │",
      "│  │  Inner            │  │",
      "│  └──────────────────┘  │",
      "└────────────────────────┘",
      "",
      "End",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("side-by-side boxes preserve both", () => {
    const text = [
      "Prose",
      "",
      "┌──────┐  ┌──────┐",
      "│  A   │  │  B   │",
      "└──────┘  └──────┘",
      "",
      "End",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("pure prose passes through unchanged", () => {
    const text = "Just some prose.\n\nAnother paragraph.";
    expect(roundTrip(text)).toBe(text);
  });

  it("multiple wireframe regions separated by prose", () => {
    const text = [
      "Top prose",
      "",
      "┌────┐",
      "│ A  │",
      "└────┘",
      "",
      "Middle prose",
      "",
      "┌────┐",
      "│ B  │",
      "└────┘",
      "",
      "Bottom prose",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("form with labels", () => {
    const text = [
      "Prose",
      "",
      "┌──────────────────────────┐",
      "│      Title               │",
      "├──────────────────────────┤",
      "│  Name:  ┌─────────────┐  │",
      "│         │             │  │",
      "│         └─────────────┘  │",
      "│  Email: ┌─────────────┐  │",
      "│         │             │  │",
      "│         └─────────────┘  │",
      "└──────────────────────────┘",
      "",
      "End",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });
});

describe("round-trip: after edits", () => {
  it("moving a frame marks dirty and regenerates without ghost", () => {
    const text = "Prose\n\n┌──────┐\n│      │\n└──────┘\n\nEnd";
    const { originalGrid } = scanToFrames(text, CW, CH);
    let state = createEditorStateFromText(text, CW, CH);
    // Snapshot bboxes before moving
    const origBboxes = snapshotFrameBboxes(getFrames(state), CW, CH);
    const container = getFrames(state)[0];
    state = applyMoveFrame(state, container.id, CW * 2, 0);
    const result = gridSerialize(
      getFrames(state), getDoc(state),
      getProseSegmentMap(state), originalGrid, CW, CH,
      getOriginalProseSegments(state), origBboxes,
    );
    expect(result).toContain("Prose");
    expect(result).toContain("End");
    expect(result).toContain("┌");
    expect(result).toContain("└");
    // Original position should be blanked — no ghost
    const lines = result.split("\n");
    const boxLine = lines.find(l => l.includes("┌"));
    expect(boxLine).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/roundtrip.test.ts`
Expected: FAIL (old imports reference removed functions)

**Step 3: No new implementation needed** — this rewrites tests to use already-implemented functions.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/roundtrip.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/roundtrip.test.ts
git commit -m "test: rewrite round-trip tests for grid-based pipeline"
```

---

### Task 8a: Remove `regions.ts` and old exports from `editorState.ts` and `frame.ts`

Delete the regions module and remove all region/proseParts-related code from editorState and frame.

**Files:**
- Delete: `src/regions.ts`
- Delete: `src/regions.test.ts` (if exists)
- Delete: `src/serialize.ts` (old `framesToMarkdown`)
- Delete: `src/serialize.test.ts` (old tests)
- Modify: `src/editorState.ts` — remove `regionsField`, `prosePartsField`, `setRegionsEffect`, `setProsePartsEffect`, `getRegions`, `getProseParts`, `rebuildProseParts`, `ProsePart`, `Region` import. Remove `regions`/`proseParts` from `EditorStateInit`. Remove their `.init()` from extensions.
- Modify: `src/frame.ts` — remove `framesFromRegions` and its `Region` import

**Step 1: Make changes**

Delete files:
```bash
rm src/regions.ts src/regions.test.ts src/serialize.ts src/serialize.test.ts
```

In `src/editorState.ts`, remove:
- `import type { Region } from "./regions"` (line 17)
- `setRegionsEffect` definition (line 56)
- `setProsePartsEffect` definition (line 58)
- `regionsField` (lines 199–207)
- `prosePartsField` (lines 209–217)
- `getRegions()` (lines 311–313)
- `getProseParts()` (lines 315–317)
- `rebuildProseParts()` (lines 327–345)
- `ProsePart` interface (lines 24–27)
- `regions` and `proseParts` from `EditorStateInit`
- `regionsField.init()` and `prosePartsField.init()` from extensions array in `createEditorState`

In `src/frame.ts`, remove:
- `framesFromRegions` function (lines 236–329)
- `import type { Region } from "./regions"` if present

**Step 2: Run tests**

Run: `npx vitest run src/editorState.test.ts src/frame.test.ts src/proseSegments.test.ts src/scanToFrames.test.ts src/gridSerialize.test.ts src/roundtrip.test.ts`
Expected: Some tests will fail due to removed imports — fix those in Tasks 8b/8c

**Step 3: Commit**

```bash
git add -A
git commit -m "refactor: delete regions.ts, serialize.ts, remove region/proseParts from editorState and frame"
```

---

### Task 8b: Update `DemoV2.tsx` — remove region imports, use grid pipeline

Remove all region-related imports and logic from DemoV2. Add `originalGridRef`. Update `saveToHandle` and `loadDocument`. Replace Enter/Backspace region-shift logic with frame-shift logic.

**Files:**
- Modify: `src/DemoV2.tsx`

**Step 1: Make changes**

Remove imports:
- `rebuildProseParts`, `getRegions`, `setRegionsEffect` from `./editorState`
- `framesToMarkdown` from `./serialize`

Add imports:
- `getProseSegmentMap`, `getOriginalProseSegments` from `./editorState`
- `gridSerialize`, `rebuildOriginalGrid`, `snapshotFrameBboxes`, `type FrameBbox` from `./gridSerialize`
- `scanToFrames` from `./scanToFrames`

Add refs:
```typescript
const originalGridRef = useRef<string[][]>([]);
const frameBboxSnapshotRef = useRef<FrameBbox[]>([]);
```

Update `loadDocument`:
```typescript
function loadDocument(text: string) {
  const cw = cwRef.current, ch = chRef.current;
  // Store originalGrid before creating state
  const { originalGrid } = scanToFrames(text, cw, ch);
  originalGridRef.current = originalGrid;
  stateRef.current = createEditorStateFromText(text, cw, ch);
  // Snapshot frame bboxes for dirty/delete detection on save
  frameBboxSnapshotRef.current = snapshotFrameBboxes(getFrames(stateRef.current), cw, ch);
  // ... rest unchanged
}
```

Note: `scanToFrames` is called twice (once here, once inside `createEditorStateFromText`). Accept the double scan — it only runs on file open.

Update `saveToHandle`:
```typescript
async function saveToHandle(h: FileSystemFileHandle) {
  const state = stateRef.current;
  const cw = cwRef.current, ch = chRef.current;
  const md = gridSerialize(
    getFrames(state),
    getDoc(state),
    getProseSegmentMap(state),
    originalGridRef.current,
    cw, ch,
    getOriginalProseSegments(state),
    frameBboxSnapshotRef.current,
  );
  const w = await (h as WritableHandle).createWritable();
  await w.write(md);
  await w.close();
  // Rebuild baselines from saved output
  originalGridRef.current = rebuildOriginalGrid(md);
  frameBboxSnapshotRef.current = snapshotFrameBboxes(getFrames(state), cw, ch);
  stateRef.current = applyClearDirty(stateRef.current);
  framesRef.current = getFrames(stateRef.current);
}
```

Update Enter handler — replace region-shift with frame-shift:
```typescript
if (e.key === "Enter") {
  e.preventDefault();
  const beforeRow = getCursor(stateRef.current)!.row;
  stateRef.current = proseInsert(stateRef.current, getCursor(stateRef.current)!, "\n");
  proseRef.current = getDoc(stateRef.current);
  framesRef.current = getFrames(stateRef.current);
  const firstText = stateRef.current.doc.line(beforeRow + 1).text;
  const secondText = stateRef.current.doc.line(beforeRow + 2).text;
  splitLine(preparedRef.current, beforeRow, firstText, secondText);
  // Frame shift: push frames below edit point down by one row
  const segMap = getProseSegmentMap(stateRef.current);
  const editGridRow = segMap[beforeRow]?.row ?? beforeRow;
  const ch = chRef.current;
  for (const f of framesRef.current) {
    if (f.y >= editGridRow * ch) {
      stateRef.current = stateRef.current.update({
        effects: moveFrameEffect.of({ id: f.id, dx: 0, dy: ch }),
      }).state;
    }
  }
  framesRef.current = getFrames(stateRef.current);
  proseCursorRef.current = getCursor(stateRef.current);
  scheduleAutosave(); doLayout(); blinkRef.current = true; paint(); return;
}
```

Update Backspace handler — replace region-shift with frame-shift:
```typescript
if (e.key === "Backspace") {
  e.preventDefault();
  const beforeCursor = getCursor(stateRef.current)!;
  const isLineMerge = beforeCursor.col === 0 && beforeCursor.row > 0;
  stateRef.current = proseDeleteBefore(stateRef.current, beforeCursor);
  proseRef.current = getDoc(stateRef.current);
  framesRef.current = getFrames(stateRef.current);
  const afterCursor = getCursor(stateRef.current)!;
  if (isLineMerge) {
    mergeLines(preparedRef.current, beforeCursor.row, stateRef.current.doc.line(afterCursor.row + 1).text);
    // Frame shift: pull frames below merge point up by one row
    const segMap = getProseSegmentMap(stateRef.current);
    const mergeGridRow = segMap[beforeCursor.row]?.row ?? beforeCursor.row;
    const ch = chRef.current;
    for (const f of framesRef.current) {
      if (f.y >= mergeGridRow * ch) {
        stateRef.current = stateRef.current.update({
          effects: moveFrameEffect.of({ id: f.id, dx: 0, dy: -ch }),
        }).state;
      }
    }
    framesRef.current = getFrames(stateRef.current);
  } else {
    invalidateLine(preparedRef.current, afterCursor.row, stateRef.current.doc.line(afterCursor.row + 1).text);
  }
  proseCursorRef.current = afterCursor;
  scheduleAutosave(); doLayout(); blinkRef.current = true; paint(); return;
}
```

**Step 2: Run build**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/DemoV2.tsx
git commit -m "refactor: DemoV2 uses grid pipeline — remove region imports, add frame-shift logic"
```

---

### Task 8c: Update test files — remove old imports

Fix remaining test files that import deleted modules.

**Files:**
- Modify: `src/harness.test.ts` — remove `detectRegions`/`Region` import, `framesFromRegions` import, `getLayersForRegion` helper. Replace with `framesFromScan` or direct `buildLayersFromScan` calls.
- Modify: `src/editorState.test.ts` — remove `getRegions`, `getProseParts`, `rebuildProseParts`, `ProsePart`, `Region` imports. Remove `makeRegion` helper. Update `emptyState` and all `createEditorState` calls to use `proseSegmentMap: []` instead of `regions: [], proseParts: []`. Remove test blocks that test removed functions.

**Step 1: Make changes**

In `src/editorState.test.ts`:
- Remove imports: `getRegions`, `getProseParts`, `rebuildProseParts`, `type ProsePart`
- Remove import of `Region` type
- Remove `makeRegion` helper
- Update `emptyState`: `createEditorState({ prose, frames: [], proseSegmentMap: [] })`
- Update ALL `createEditorState` calls: replace `regions: [...]` and `proseParts: [...]` with `proseSegmentMap: []`
- Remove `describe("rebuildProseParts", ...)` block and any tests that call `getRegions` or `getProseParts`

In `src/harness.test.ts`:
- Remove `import { detectRegions, type Region } from "./regions"`
- Remove `import { framesFromRegions } from "./frame"`
- Remove `getLayersForRegion` helper function
- Update tests that call `detectRegions` or `framesFromRegions` to use `framesFromScan` or `buildLayersFromScan` directly. Tests that specifically tested region detection behavior can be deleted (that logic is gone).

**Step 2: Run full suite**

Run: `npx vitest run`
Expected: PASS — all tests green

**Step 3: Commit**

```bash
git add src/harness.test.ts src/editorState.test.ts
git commit -m "test: update test files to remove region/proseParts imports"
```

---

### Task 9: Delete cascade for empty containers

When deleting a child frame, check if the parent container becomes empty. If so, delete the parent recursively.

**Files:**
- Modify: `src/editorState.ts` — update `deleteFrameEffect` handler
- Modify: `src/editorState.test.ts` — add cascade delete test

**Step 1: Write the failing test**

```typescript
describe("delete cascade", () => {
  it("deleting last child also removes empty parent container", () => {
    const child: Frame = {
      id: "child1", x: 0, y: 0, w: 100, h: 50,
      z: 0, children: [], content: { type: "rect", cells: new Map(), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } },
      clip: false, dirty: false,
    };
    const parent: Frame = {
      id: "parent1", x: 0, y: 0, w: 200, h: 100,
      z: 0, children: [child], content: null,
      clip: true, dirty: false,
    };
    const state = createEditorState({
      prose: "", frames: [parent], proseSegmentMap: [],
    });
    const updated = applyDeleteFrame(state, "child1");
    // Parent should also be gone (cascade delete)
    expect(getFrames(updated)).toHaveLength(0);
  });

  it("deleting one of two children keeps parent", () => {
    const child1: Frame = {
      id: "c1", x: 0, y: 0, w: 50, h: 50, z: 0, children: [],
      content: { type: "rect", cells: new Map(), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } },
      clip: false, dirty: false,
    };
    const child2: Frame = {
      id: "c2", x: 60, y: 0, w: 50, h: 50, z: 0, children: [],
      content: { type: "rect", cells: new Map(), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } },
      clip: false, dirty: false,
    };
    const parent: Frame = {
      id: "p1", x: 0, y: 0, w: 200, h: 100, z: 0,
      children: [child1, child2], content: null, clip: true, dirty: false,
    };
    const state = createEditorState({ prose: "", frames: [parent], proseSegmentMap: [] });
    const updated = applyDeleteFrame(state, "c1");
    const frames = getFrames(updated);
    expect(frames).toHaveLength(1); // parent still exists
    expect(frames[0].children).toHaveLength(1); // one child remains
    expect(frames[0].children[0].id).toBe("c2");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/editorState.test.ts`
Expected: FAIL — first test expects parent removed, but current code only removes child

**Step 3: Write minimal implementation**

In `src/editorState.ts`, update the `deleteFrameEffect` handler inside `framesField.update`. After `result = removeById(result);`, add cascade delete:

```typescript
// Cascade: remove empty container parents (content === null, no children)
const cascadeEmpty = (frames: Frame[]): Frame[] => {
  return frames
    .map(f => ({
      ...f,
      children: f.children.length > 0 ? cascadeEmpty(f.children) : f.children,
    }))
    .filter(f => !(f.content === null && f.children.length === 0));
};
result = cascadeEmpty(result);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/editorState.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts
git commit -m "feat: cascade delete — empty containers removed when last child deleted"
```

---

### Task 10: Refs update after save + originalProseSegments refresh

After `gridSerialize` produces output text, rebuild `originalGrid` and reset `originalProseSegments` in the CM state so the next save uses fresh baselines.

**Files:**
- Modify: `src/editorState.ts` — add `setOriginalProseSegmentsEffect`
- Modify: `src/DemoV2.tsx` — update `saveToHandle` to refresh `originalProseSegments`

**Step 1: Write the failing test**

```typescript
// Add to src/editorState.test.ts:
describe("originalProseSegments refresh", () => {
  it("setOriginalProseSegments updates the stored segments", () => {
    const state = createEditorState({
      prose: "Hello",
      frames: [],
      proseSegmentMap: [{ row: 0, col: 0 }],
      originalProseSegments: [{ row: 0, col: 0, text: "Hello" }],
    });
    const newSegs = [{ row: 0, col: 0, text: "Updated" }];
    const updated = applySetOriginalProseSegments(state, newSegs);
    expect(getOriginalProseSegments(updated)).toEqual(newSegs);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/editorState.test.ts`
Expected: FAIL — `applySetOriginalProseSegments` not exported

**Step 3: Write minimal implementation**

In `src/editorState.ts`:

```typescript
const setOriginalProseSegmentsEffect = StateEffect.define<ProseSegment[]>();

// Update originalProseSegmentsField to respond to the effect:
const originalProseSegmentsField = StateField.define<ProseSegment[]>({
  create: () => [],
  update(segs, tr) {
    for (const e of tr.effects) {
      if (e.is(setOriginalProseSegmentsEffect)) return e.value;
    }
    return segs;
  },
});

export function applySetOriginalProseSegments(
  state: EditorState,
  segments: ProseSegment[],
): EditorState {
  return state.update({
    effects: setOriginalProseSegmentsEffect.of(segments),
    annotations: Transaction.addToHistory.of(false),
  }).state;
}
```

In `DemoV2.tsx` `saveToHandle`, after `applyClearDirty`:

```typescript
// Rebuild originalProseSegments from saved output
const { proseSegments: newSegs } = scanToFrames(md, cw, ch);
stateRef.current = applySetOriginalProseSegments(stateRef.current, newSegs);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/editorState.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/editorState.ts src/editorState.test.ts src/DemoV2.tsx
git commit -m "feat: refresh originalProseSegments after save for clean baseline"
```

---

### Task 11: Integration verification — full test suite + build

Run all tests. Fix any remaining broken imports or type errors.

**Step 1: Run full suite**

Run: `npx vitest run`
Expected: PASS — all tests green

**Step 2: Run build**

Run: `npm run build`
Expected: Build succeeds with no type errors

**Step 3: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix: resolve remaining type errors and import cleanup"
```

---

**Plan complete and saved to `docs/plans/2026-04-18-kill-regions-impl.md`.**

**Two execution options:**

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
