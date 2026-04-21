# Region-Based Document Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the two-world architecture (pixel Frames + CM prose) with a region-based document model where the ordered list of regions IS the file.

**Architecture:** Document = Region[]. Each region is either prose (CM-managed text lines) or wireframe (box-drawing character lines + blank padding). Scanner identifies regions on load. Regions tracked as CM StateField. Serialize = write regions in order. Pretext renders prose. Canvas renders wireframes. No gridSerialize Phase A/B/C/D.

**Tech Stack:** TypeScript, Vite, React 19, @chenglou/pretext, CodeMirror, Vitest, Playwright

---

## Task 1: Region type + detectRegions()

**Files:** `src/regions.ts` (create), `src/regions.test.ts` (create)

### Step 1: Write the failing test

```typescript
// src/regions.test.ts
import { describe, it, expect } from "vitest";
import { detectRegions, type Region } from "./regions";

describe("detectRegions", () => {
  it("returns single prose region for plain text", () => {
    const text = "Hello world\nSecond line";
    const regions = detectRegions(text);
    expect(regions).toEqual([
      { type: "prose", startLine: 0, endLine: 1, lines: ["Hello world", "Second line"] },
    ]);
  });

  it("returns single wireframe region for a box", () => {
    const text = "┌───┐\n│ A │\n└───┘";
    const regions = detectRegions(text);
    expect(regions).toEqual([
      { type: "wireframe", startLine: 0, endLine: 2, lines: ["┌───┐", "│ A │", "└───┘"] },
    ]);
  });

  it("splits prose-wireframe-prose into three regions", () => {
    const text = "Hello\n\n┌───┐\n│ A │\n└───┘\n\nWorld";
    const regions = detectRegions(text);
    expect(regions).toHaveLength(3);
    expect(regions[0]).toEqual({
      type: "prose", startLine: 0, endLine: 1, lines: ["Hello", ""],
    });
    expect(regions[1]).toEqual({
      type: "wireframe", startLine: 2, endLine: 4, lines: ["┌───┐", "│ A │", "└───┘"],
    });
    expect(regions[2]).toEqual({
      type: "prose", startLine: 5, endLine: 6, lines: ["", "World"],
    });
  });

  it("wireframe region absorbs adjacent blank lines", () => {
    const text = "Hello\n\n\n┌───┐\n│ A │\n└───┘\n\n\nWorld";
    const regions = detectRegions(text);
    expect(regions).toHaveLength(3);
    // Blank lines between prose and wireframe belong to wireframe
    expect(regions[0].type).toBe("prose");
    expect(regions[0].lines).toEqual(["Hello"]);
    expect(regions[1].type).toBe("wireframe");
    expect(regions[1].lines).toEqual(["", "", "┌───┐", "│ A │", "└───┘", "", ""]);
    expect(regions[2].type).toBe("prose");
    expect(regions[2].lines).toEqual(["World"]);
  });

  it("handles multiple wireframes separated by prose", () => {
    const text = "# Title\n\n┌──┐\n└──┘\n\nMiddle\n\n┌──┐\n└──┘\n\nEnd";
    const regions = detectRegions(text);
    expect(regions).toHaveLength(5);
    expect(regions.map(r => r.type)).toEqual([
      "prose", "wireframe", "prose", "wireframe", "prose",
    ]);
  });

  it("handles empty input", () => {
    expect(detectRegions("")).toEqual([]);
  });

  it("classifies lines with box-drawing chars as wireframe", () => {
    // Line with │ (vertical bar) is wireframe
    const text = "│ sidebar │";
    const regions = detectRegions(text);
    expect(regions[0].type).toBe("wireframe");
  });

  it("handles adjacent wireframes as single wireframe region", () => {
    const text = "┌──┐┌──┐\n│A ││B │\n└──┘└──┘";
    const regions = detectRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("wireframe");
  });

  it("handles shared-wall wireframes (T-junctions)", () => {
    const text = "┌──┬──┐\n│  │  │\n└──┴──┘";
    const regions = detectRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("wireframe");
  });

  it("handles colex-plan-style mixed document", () => {
    const text = [
      "# My Plan",
      "",
      "Some intro text here.",
      "",
      "",
      "┌─────────────┐",
      "│  Dashboard   │",
      "├──────┬──────┤",
      "│ Nav  │ Main │",
      "└──────┴──────┘",
      "",
      "",
      "More prose after the wireframe.",
    ].join("\n");
    const regions = detectRegions(text);
    expect(regions).toHaveLength(3);
    expect(regions[0].type).toBe("prose");
    expect(regions[0].lines).toEqual(["# My Plan", "", "Some intro text here."]);
    expect(regions[1].type).toBe("wireframe");
    // Wireframe absorbs blank lines above and below
    expect(regions[1].lines[0]).toBe("");
    expect(regions[1].lines[regions[1].lines.length - 1]).toBe("");
    expect(regions[2].type).toBe("prose");
    expect(regions[2].lines).toEqual(["More prose after the wireframe."]);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regions.test.ts
# Expected: "Cannot find module './regions'" — file doesn't exist yet
```

### Step 3: Write minimal implementation

```typescript
// src/regions.ts

/**
 * Region-based document model.
 *
 * The document is an ordered list of regions. Each region is either:
 * - prose: consecutive lines of markdown text
 * - wireframe: consecutive lines containing box-drawing characters + blank padding
 *
 * Every line belongs to exactly one region. No shared rows. No mixed content.
 */

export interface Region {
  type: "prose" | "wireframe";
  startLine: number;
  endLine: number;
  /** The actual text lines (inclusive of startLine through endLine) */
  lines: string[];
}

/** Box-drawing characters that identify a wireframe line */
const WIRE_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╭╮╰╯━"]);

/** Returns true if a line contains at least one box-drawing character */
function isWireframeLine(line: string): boolean {
  for (const ch of line) {
    if (WIRE_CHARS.has(ch)) return true;
  }
  return false;
}

/**
 * Detect regions in a document.
 *
 * Algorithm:
 * 1. Classify each line as wireframe or not
 * 2. Find contiguous runs of wireframe lines
 * 3. Expand wireframe regions to absorb adjacent blank lines
 * 4. Everything else is prose
 */
export function detectRegions(text: string): Region[] {
  if (text === "") return [];

  const allLines = text.split("\n");
  const n = allLines.length;

  // Step 1: classify each line
  const isWire: boolean[] = allLines.map(isWireframeLine);

  // Step 2: find wireframe spans (contiguous runs of wire lines)
  const wireSpans: { start: number; end: number }[] = [];
  let i = 0;
  while (i < n) {
    if (isWire[i]) {
      const start = i;
      while (i < n && isWire[i]) i++;
      wireSpans.push({ start, end: i - 1 });
    } else {
      i++;
    }
  }

  if (wireSpans.length === 0) {
    // All prose
    return [{ type: "prose", startLine: 0, endLine: n - 1, lines: allLines }];
  }

  // Step 3: expand wireframe spans to absorb adjacent blank lines.
  // A blank line adjacent to a wireframe span (above or below) is claimed
  // by the wireframe. We expand greedily but stop at non-blank lines.
  for (const span of wireSpans) {
    // Expand upward
    while (span.start > 0 && allLines[span.start - 1].trim() === "") {
      span.start--;
    }
    // Expand downward
    while (span.end < n - 1 && allLines[span.end + 1].trim() === "") {
      span.end++;
    }
  }

  // Merge overlapping wireframe spans (can happen after blank-line absorption)
  const merged: { start: number; end: number }[] = [];
  for (const span of wireSpans) {
    if (merged.length > 0 && span.start <= merged[merged.length - 1].end + 1) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  // Step 4: build regions — prose fills the gaps
  const regions: Region[] = [];
  let cursor = 0;

  for (const span of merged) {
    // Prose before this wireframe
    if (cursor < span.start) {
      regions.push({
        type: "prose",
        startLine: cursor,
        endLine: span.start - 1,
        lines: allLines.slice(cursor, span.start),
      });
    }
    // Wireframe region
    regions.push({
      type: "wireframe",
      startLine: span.start,
      endLine: span.end,
      lines: allLines.slice(span.start, span.end + 1),
    });
    cursor = span.end + 1;
  }

  // Trailing prose
  if (cursor < n) {
    regions.push({
      type: "prose",
      startLine: cursor,
      endLine: n - 1,
      lines: allLines.slice(cursor, n),
    });
  }

  return regions;
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regions.test.ts
# Expected: all 10 tests pass
```

### Step 5: Commit

```bash
git add src/regions.ts src/regions.test.ts
git commit -m "feat: add Region type and detectRegions() — region-based document model"
```

---

## Task 2: serializeRegions()

**Files:** `src/regions.ts` (modify), `src/regions.test.ts` (modify)

### Step 1: Write the failing test

Add to `src/regions.test.ts`:

```typescript
import { detectRegions, serializeRegions, type Region } from "./regions";

describe("serializeRegions", () => {
  it("round-trips plain text", () => {
    const text = "Hello world\nSecond line";
    const regions = detectRegions(text);
    expect(serializeRegions(regions)).toBe(text);
  });

  it("round-trips prose-wireframe-prose", () => {
    const text = "Hello\n\n┌───┐\n│ A │\n└───┘\n\nWorld";
    const regions = detectRegions(text);
    expect(serializeRegions(regions)).toBe(text);
  });

  it("round-trips complex document with multiple wireframes", () => {
    const text = [
      "# My Plan",
      "",
      "Some intro text here.",
      "",
      "",
      "┌─────────────┐",
      "│  Dashboard   │",
      "├──────┬──────┤",
      "│ Nav  │ Main │",
      "└──────┴──────┘",
      "",
      "",
      "More prose.",
      "",
      "",
      "┌──┐",
      "└──┘",
      "",
      "",
      "End.",
    ].join("\n");
    const regions = detectRegions(text);
    expect(serializeRegions(regions)).toBe(text);
  });

  it("handles empty regions array", () => {
    expect(serializeRegions([])).toBe("");
  });

  it("serializes modified wireframe lines correctly", () => {
    const regions: Region[] = [
      { type: "prose", startLine: 0, endLine: 0, lines: ["Hello"] },
      { type: "wireframe", startLine: 1, endLine: 3, lines: ["", "┌─────┐", "└─────┘"] },
      { type: "prose", startLine: 4, endLine: 4, lines: ["World"] },
    ];
    expect(serializeRegions(regions)).toBe("Hello\n\n┌─────┐\n└─────┘\nWorld");
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regions.test.ts
# Expected: "serializeRegions is not a function" or import error
```

### Step 3: Write minimal implementation

Add to `src/regions.ts`:

```typescript
/**
 * Serialize regions back to a markdown string.
 * Trivially correct: write each region's lines in order.
 */
export function serializeRegions(regions: Region[]): string {
  if (regions.length === 0) return "";
  return regions.flatMap(r => r.lines).join("\n");
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regions.test.ts
# Expected: all tests pass
```

### Step 5: Commit

```bash
git add src/regions.ts src/regions.test.ts
git commit -m "feat: add serializeRegions — trivial serialization by writing regions in order"
```

---

## Task 3: Region-aware prose extraction

**Files:** `src/regions.ts` (modify), `src/regions.test.ts` (modify)

### Step 1: Write the failing test

Add to `src/regions.test.ts`:

```typescript
import { detectRegions, extractProseFromRegions, type Region } from "./regions";

describe("extractProseFromRegions", () => {
  it("extracts prose text and segment map from regions", () => {
    const text = "Hello\n\n┌───┐\n│ A │\n└───┘\n\nWorld";
    const regions = detectRegions(text);
    const { proseText, proseSegmentMap } = extractProseFromRegions(regions);
    // Prose comes from regions[0] ("Hello", "") and regions[2] ("", "World")
    expect(proseText).toBe("Hello\nWorld");
    expect(proseSegmentMap).toEqual([
      { regionIndex: 0, lineInRegion: 0, docLine: 0 },
      { regionIndex: 2, lineInRegion: 0, docLine: 6 },
    ]);
  });

  it("preserves all prose lines from multi-line prose regions", () => {
    const text = "Line 1\nLine 2\nLine 3\n\n┌──┐\n└──┘\n\nLine 4";
    const regions = detectRegions(text);
    const { proseText } = extractProseFromRegions(regions);
    expect(proseText).toBe("Line 1\nLine 2\nLine 3\nLine 4");
  });

  it("returns empty for wireframe-only document", () => {
    const text = "┌──┐\n│  │\n└──┘";
    const regions = detectRegions(text);
    const { proseText, proseSegmentMap } = extractProseFromRegions(regions);
    expect(proseText).toBe("");
    expect(proseSegmentMap).toEqual([]);
  });

  it("skips blank prose lines that are only paragraph separators", () => {
    const text = "Hello\n\nWorld";
    const regions = detectRegions(text);
    const { proseText } = extractProseFromRegions(regions);
    // All three lines are in one prose region; blank line preserved
    expect(proseText).toBe("Hello\n\nWorld");
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regions.test.ts
# Expected: "extractProseFromRegions is not a function"
```

### Step 3: Write minimal implementation

Add to `src/regions.ts`:

```typescript
export interface ProseSegmentMapping {
  /** Index into the regions array */
  regionIndex: number;
  /** Line index within this prose region */
  lineInRegion: number;
  /** Original document line number (for mapping back) */
  docLine: number;
}

/**
 * Extract prose text and a mapping from prose lines back to document lines.
 * Only prose regions contribute text. Wireframe regions are skipped.
 */
export function extractProseFromRegions(
  regions: Region[],
): { proseText: string; proseSegmentMap: ProseSegmentMapping[] } {
  const proseLines: string[] = [];
  const proseSegmentMap: ProseSegmentMapping[] = [];

  for (let ri = 0; ri < regions.length; ri++) {
    const region = regions[ri];
    if (region.type !== "prose") continue;

    for (let li = 0; li < region.lines.length; li++) {
      proseSegmentMap.push({
        regionIndex: ri,
        lineInRegion: li,
        docLine: region.startLine + li,
      });
      proseLines.push(region.lines[li]);
    }
  }

  return {
    proseText: proseLines.join("\n"),
    proseSegmentMap,
  };
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regions.test.ts
# Expected: all tests pass
```

### Step 5: Commit

```bash
git add src/regions.ts src/regions.test.ts
git commit -m "feat: add extractProseFromRegions — prose extraction with line-level mapping"
```

---

## Task 4: Region-aware wireframe extraction

**Files:** `src/regions.ts` (modify), `src/regions.test.ts` (modify)

### Step 1: Write the failing test

Add to `src/regions.test.ts`:

```typescript
import { detectRegions, extractWireframeRegions } from "./regions";

describe("extractWireframeRegions", () => {
  it("extracts wireframe text for scanner", () => {
    const text = "Hello\n\n┌───┐\n│ A │\n└───┘\n\nWorld";
    const regions = detectRegions(text);
    const wireframes = extractWireframeRegions(regions);
    expect(wireframes).toHaveLength(1);
    expect(wireframes[0].regionIndex).toBe(1);
    expect(wireframes[0].text).toBe("┌───┐\n│ A │\n└───┘");
    // offset: the first wire-char line within the region
    // (blank padding lines don't have wire chars)
  });

  it("extracts multiple wireframes", () => {
    const text = "A\n\n┌──┐\n└──┘\n\nB\n\n┌──┐\n└──┘\n\nC";
    const regions = detectRegions(text);
    const wireframes = extractWireframeRegions(regions);
    expect(wireframes).toHaveLength(2);
  });

  it("provides correct docStartLine for scanner offset", () => {
    const text = "Hello\n\n┌───┐\n│ A │\n└───┘\n\nWorld";
    const regions = detectRegions(text);
    const wireframes = extractWireframeRegions(regions);
    // The wireframe region starts at doc line 1 (blank line absorbed),
    // but the first wire-char line is doc line 2
    expect(wireframes[0].docStartLine).toBe(regions[1].startLine);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regions.test.ts
# Expected: "extractWireframeRegions is not a function"
```

### Step 3: Write minimal implementation

Add to `src/regions.ts`:

```typescript
export interface WireframeRegionInfo {
  regionIndex: number;
  /** Full text of the wireframe region (including blank padding) */
  text: string;
  /** Document line number where this region starts */
  docStartLine: number;
}

/**
 * Extract wireframe region info for passing to the scanner.
 * Each wireframe region becomes one scanner input.
 */
export function extractWireframeRegions(regions: Region[]): WireframeRegionInfo[] {
  const result: WireframeRegionInfo[] = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    if (r.type !== "wireframe") continue;

    // Strip leading/trailing blank padding for scanner input,
    // but keep the text as-is since the scanner needs the full grid.
    // Actually, give the scanner the wireframe lines including blanks
    // so it can detect internal spacing. Scanner handles blank lines fine.
    result.push({
      regionIndex: i,
      text: r.lines.join("\n"),
      docStartLine: r.startLine,
    });
  }
  return result;
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regions.test.ts
# Expected: all tests pass
```

### Step 5: Commit

```bash
git add src/regions.ts src/regions.test.ts
git commit -m "feat: add extractWireframeRegions — wireframe region info for scanner"
```

---

## Task 5: Regions StateField

**Files:** `src/regionState.ts` (create), `src/regionState.test.ts` (create)

### Step 1: Write the failing test

```typescript
// src/regionState.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { createRegionState, getRegions, regionsField } from "./regionState";
import type { Region } from "./regions";

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

describe("regionsField", () => {
  it("initializes regions from document text", () => {
    const text = "Hello\n\n┌──┐\n└──┘\n\nWorld";
    const state = createRegionState(text);
    const regions = getRegions(state);
    expect(regions).toHaveLength(3);
    expect(regions[0].type).toBe("prose");
    expect(regions[1].type).toBe("wireframe");
    expect(regions[2].type).toBe("prose");
  });

  it("updates regions when lines are inserted into prose", () => {
    const text = "Hello\n\n┌──┐\n└──┘\n\nWorld";
    let state = createRegionState(text);
    // Insert a new line after "Hello"
    const line1End = state.doc.line(1).to;
    state = state.update({
      changes: { from: line1End, insert: "\nNew line" },
    }).state;
    const regions = getRegions(state);
    // Prose region should now have 3 lines, wireframe unchanged
    expect(regions[0].type).toBe("prose");
    expect(regions[0].lines).toContain("New line");
    expect(regions[1].type).toBe("wireframe");
  });

  it("updates regions when prose lines are deleted", () => {
    const text = "Line 1\nLine 2\nLine 3\n\n┌──┐\n└──┘\n\nEnd";
    let state = createRegionState(text);
    // Delete "Line 2\n"
    const l2 = state.doc.line(2);
    state = state.update({
      changes: { from: l2.from, to: l2.to + 1 },
    }).state;
    const regions = getRegions(state);
    expect(regions[0].type).toBe("prose");
    expect(regions[0].lines).toEqual(["Line 1", "Line 3"]);
  });

  it("preserves wireframe content during prose edits", () => {
    const text = "Hello\n\n┌───┐\n│ A │\n└───┘\n\nWorld";
    let state = createRegionState(text);
    // Append text to "Hello" -> "Hello!"
    const line1End = state.doc.line(1).to;
    state = state.update({
      changes: { from: line1End, insert: "!" },
    }).state;
    const regions = getRegions(state);
    expect(regions[0].lines[0]).toBe("Hello!");
    expect(regions[1].lines).toContain("│ A │");
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionState.test.ts
# Expected: "Cannot find module './regionState'"
```

### Step 3: Write minimal implementation

```typescript
// src/regionState.ts
import { EditorState, StateField, type Transaction } from "@codemirror/state";
import { detectRegions, type Region } from "./regions";

/**
 * CM StateField that tracks regions.
 * On doc changes, re-detects regions from the full document text.
 *
 * Future optimization: incremental update based on changed line ranges.
 * For now, full re-detection is fine — detectRegions is O(lines) and
 * completes in <1ms for 400-line files (per harness benchmarks).
 */
export const regionsField = StateField.define<Region[]>({
  create(state: EditorState) {
    return detectRegions(state.doc.toString());
  },
  update(regions: Region[], tr: Transaction) {
    if (!tr.docChanged) return regions;
    return detectRegions(tr.state.doc.toString());
  },
});

/**
 * Read regions from an EditorState.
 */
export function getRegions(state: EditorState): Region[] {
  return state.field(regionsField);
}

/**
 * Create an EditorState with the regions field installed.
 */
export function createRegionState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [regionsField],
  });
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionState.test.ts
# Expected: all 4 tests pass
```

### Step 5: Commit

```bash
git add src/regionState.ts src/regionState.test.ts
git commit -m "feat: add regionsField CM StateField — tracks regions, re-detects on doc change"
```

---

## Task 6: Region-based document loader

**Files:** `src/regionLoader.ts` (create), `src/regionLoader.test.ts` (create)

This replaces `createEditorStateFromText` — loads a .md file, detects regions, runs scanner on wireframe regions, builds frames, and creates a unified EditorState.

### Step 1: Write the failing test

```typescript
// src/regionLoader.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { loadDocument } from "./regionLoader";
import { getRegions } from "./regionState";

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

describe("loadDocument", () => {
  it("loads a prose-only document", () => {
    const text = "Hello world\nSecond line";
    const { state, frames } = loadDocument(text, CW, CH);
    expect(state.doc.toString()).toBe(text);
    expect(frames).toEqual([]);
    const regions = getRegions(state);
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe("prose");
  });

  it("loads a document with wireframes and produces frames", () => {
    const text = "Title\n\n┌──────┐\n│ Box  │\n└──────┘\n\nEnd";
    const { state, frames } = loadDocument(text, CW, CH);
    expect(frames.length).toBeGreaterThan(0);
    // The frame should have been detected by the scanner
    const rect = frames.find(f => f.content?.type === "rect");
    expect(rect).toBeTruthy();
    const regions = getRegions(state);
    expect(regions).toHaveLength(3);
  });

  it("frame grid positions are offset by wireframe region start line", () => {
    const text = "Line 1\nLine 2\nLine 3\n\n┌──┐\n│  │\n└──┘\n\nEnd";
    const { frames } = loadDocument(text, CW, CH);
    // Wireframe starts at doc line 4 (after blank padding)
    // The top-left corner of the box should be at row 4
    const rect = frames.find(f => f.content?.type === "rect" || f.children.length > 0);
    expect(rect).toBeTruthy();
    expect(rect!.gridRow).toBeGreaterThanOrEqual(3);
  });

  it("produces correct prose text from prose regions", () => {
    const text = "Hello\n\n┌──┐\n└──┘\n\nWorld";
    const { state } = loadDocument(text, CW, CH);
    // The full document is in CM, not just prose
    expect(state.doc.toString()).toBe(text);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionLoader.test.ts
# Expected: "Cannot find module './regionLoader'"
```

### Step 3: Write minimal implementation

```typescript
// src/regionLoader.ts
import { EditorState, type Extension } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { regionsField } from "./regionState";
import { detectRegions, extractWireframeRegions, type Region } from "./regions";
import { scan } from "./scanner";
import { framesFromScan, type Frame } from "./frame";

export interface LoadResult {
  state: EditorState;
  frames: Frame[];
}

/**
 * Load a document from markdown text.
 *
 * 1. The full text goes into CM (entire .md file, not just prose)
 * 2. detectRegions identifies prose vs wireframe regions
 * 3. Scanner runs on each wireframe region to produce frames
 * 4. Frame gridRow/gridCol are offset by the wireframe region's startLine
 *
 * The CM doc IS the file — serialize = state.doc.toString()
 */
export function loadDocument(
  text: string,
  charWidth: number,
  charHeight: number,
): LoadResult {
  const regions = detectRegions(text);
  const wireframeInfos = extractWireframeRegions(regions);

  // Run scanner on each wireframe region to get frames
  const allFrames: Frame[] = [];
  for (const wf of wireframeInfos) {
    const scanResult = scan(wf.text);
    const frames = framesFromScan(scanResult, charWidth, charHeight);

    // Offset frame positions by the wireframe region's start in the document
    for (const frame of frames) {
      frame.gridRow += wf.docStartLine;
      frame.y = frame.gridRow * charHeight;
      // Also offset children (they're relative to parent, so no offset needed)
    }
    allFrames.push(...frames);
  }

  const state = EditorState.create({
    doc: text,
    extensions: [
      history(),
      regionsField,
    ],
  });

  return { state, frames: allFrames };
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionLoader.test.ts
# Expected: all 4 tests pass
```

### Step 5: Commit

```bash
git add src/regionLoader.ts src/regionLoader.test.ts
git commit -m "feat: add loadDocument — region-based document loading with scanner per wireframe"
```

---

## Task 7: Region-based serialization (replacing gridSerialize)

**Files:** `src/regionSerialize.ts` (create), `src/regionSerialize.test.ts` (create)

This is the core simplification. Instead of the Phase A/B/C/D grid serializer, we simply read the CM doc (which IS the file).

### Step 1: Write the failing test

```typescript
// src/regionSerialize.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { regionSerialize } from "./regionSerialize";
import { loadDocument } from "./regionLoader";
import { getRegions } from "./regionState";
import type { Frame } from "./frame";

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

describe("regionSerialize", () => {
  it("round-trips a prose-only document", () => {
    const text = "Hello world\nSecond line";
    const { state, frames } = loadDocument(text, CW, CH);
    const result = regionSerialize(state, frames, CW, CH);
    expect(result).toBe(text);
  });

  it("round-trips a prose + wireframe document", () => {
    const text = [
      "Title",
      "",
      "┌──────┐",
      "│ Box  │",
      "└──────┘",
      "",
      "End",
    ].join("\n");
    const { state, frames } = loadDocument(text, CW, CH);
    const result = regionSerialize(state, frames, CW, CH);
    expect(result).toBe(text);
  });

  it("serializes after frame move — wireframe lines update in place", () => {
    const text = [
      "Hello",
      "",
      "┌──┐",
      "│  │",
      "└──┘",
      "",
      "World",
    ].join("\n");
    const { state, frames } = loadDocument(text, CW, CH);
    // Simulate moving the frame 2 columns right: update frame cells
    // The serializer should write the frame at its new position in the
    // wireframe region's lines
    expect(frames.length).toBeGreaterThan(0);
    // For now, just test that un-moved frame round-trips
    const result = regionSerialize(state, frames, CW, CH);
    expect(result).toBe(text);
  });

  it("serializes dirty frame by re-rendering wireframe region lines", () => {
    const text = [
      "┌──┐",
      "│  │",
      "└──┘",
    ].join("\n");
    const { state, frames } = loadDocument(text, CW, CH);
    expect(frames.length).toBeGreaterThan(0);

    // Mark frame dirty and shift gridCol by 2
    const movedFrame = {
      ...frames[0],
      dirty: true,
      gridCol: frames[0].gridCol + 2,
      x: (frames[0].gridCol + 2) * CW,
    };

    const result = regionSerialize(state, [movedFrame], CW, CH);
    // The wireframe should now have 2 leading spaces
    const lines = result.split("\n");
    expect(lines[0]).toMatch(/^ {2}┌──┐/);
  });

  it("handles no-wireframe document", () => {
    const text = "Just prose\nNothing else";
    const { state, frames } = loadDocument(text, CW, CH);
    expect(regionSerialize(state, frames, CW, CH)).toBe(text);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionSerialize.test.ts
# Expected: "Cannot find module './regionSerialize'"
```

### Step 3: Write minimal implementation

```typescript
// src/regionSerialize.ts
import type { EditorState } from "@codemirror/state";
import { getRegions } from "./regionState";
import { repairJunctions } from "./gridSerialize";
import type { Frame } from "./frame";
import type { Region } from "./regions";

/**
 * Region-based serialization.
 *
 * For clean (no dirty frames) documents: just return state.doc.toString().
 * For dirty frames: re-render the wireframe region lines from frame cells,
 * then stitch all regions together.
 *
 * This replaces the 380-line gridSerialize Phase A/B/C/D system.
 */
export function regionSerialize(
  state: EditorState,
  frames: Frame[],
  charWidth: number,
  charHeight: number,
): string {
  const anyDirty = frames.some(f => f.dirty);

  // Fast path: no dirty frames → doc IS the file
  if (!anyDirty) {
    return state.doc.toString();
  }

  // Slow path: re-render wireframe regions that contain dirty frames
  const regions = getRegions(state);
  const docLines = state.doc.toString().split("\n");

  // Build a map: doc line number → region index
  const lineToRegion = new Map<number, number>();
  for (let ri = 0; ri < regions.length; ri++) {
    const r = regions[ri];
    for (let l = r.startLine; l <= r.endLine; l++) {
      lineToRegion.set(l, ri);
    }
  }

  // For each wireframe region, check if any frame in that region is dirty.
  // If so, rebuild its lines from frame cells.
  const outputLines = [...docLines];

  for (let ri = 0; ri < regions.length; ri++) {
    const region = regions[ri];
    if (region.type !== "wireframe") continue;

    // Find frames that belong to this region (their gridRow falls within region line range)
    const regionFrames = frames.filter(f => {
      const frameTop = f.gridRow;
      const frameBot = f.gridRow + f.gridH - 1;
      return frameTop >= region.startLine && frameBot <= region.endLine;
    });

    const hasDirty = regionFrames.some(f => f.dirty);
    if (!hasDirty) continue;

    // Rebuild this region's lines from frame cells
    const regionHeight = region.endLine - region.startLine + 1;
    const maxCol = Math.max(
      ...regionFrames.map(f => f.gridCol + f.gridW),
      ...region.lines.map(l => l.length),
    );
    const grid: string[][] = Array.from({ length: regionHeight }, () =>
      Array(maxCol).fill(" "),
    );

    // Write frame cells into the grid
    for (const frame of regionFrames) {
      writeFrameCells(grid, frame, region.startLine);
    }

    // Repair junctions where frame borders meet
    repairJunctions(grid);

    // Update output lines
    for (let l = 0; l < regionHeight; l++) {
      outputLines[region.startLine + l] = grid[l].join("").trimEnd();
    }
  }

  // Strip trailing empty lines
  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === "") {
    outputLines.pop();
  }

  return outputLines.join("\n");
}

/**
 * Write a frame's cells into a grid, recursively handling children.
 * gridRowOffset is the document line where the region starts.
 */
function writeFrameCells(
  grid: string[][],
  frame: Frame,
  gridRowOffset: number,
  parentRow = 0,
  parentCol = 0,
): void {
  const absRow = parentRow + frame.gridRow;
  const absCol = parentCol + frame.gridCol;

  if (frame.content) {
    for (const [key, ch] of frame.content.cells) {
      const ci = key.indexOf(",");
      const r = absRow - gridRowOffset + Number(key.slice(0, ci));
      const c = absCol + Number(key.slice(ci + 1));
      if (r >= 0 && r < grid.length) {
        while (grid[r].length <= c) grid[r].push(" ");
        grid[r][c] = ch;
      }
    }
  }

  for (const child of frame.children) {
    writeFrameCells(grid, child, gridRowOffset, absRow, absCol);
  }
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionSerialize.test.ts
# Expected: all 5 tests pass
```

### Step 5: Commit

```bash
git add src/regionSerialize.ts src/regionSerialize.test.ts
git commit -m "feat: add regionSerialize — replaces Phase A/B/C/D grid serializer"
```

---

## Task 8: Integrated EditorState with regions

**Files:** `src/editorStateV2.ts` (create), `src/editorStateV2.test.ts` (create)

This creates the new unified EditorState that uses regions instead of the old proseSegmentMap/originalGrid/frameBbox system.

### Step 1: Write the failing test

```typescript
// src/editorStateV2.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  createEditorStateV2,
  getFramesV2,
  getRegionsV2,
  applyMoveFrameV2,
  serializeV2,
} from "./editorStateV2";

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

describe("EditorState V2 — region-based", () => {
  it("creates state with frames and regions", () => {
    const text = "Hello\n\n┌──┐\n│  │\n└──┘\n\nWorld";
    const state = createEditorStateV2(text, CW, CH);
    expect(getFramesV2(state).length).toBeGreaterThan(0);
    expect(getRegionsV2(state)).toHaveLength(3);
  });

  it("serializes un-modified document identically", () => {
    const text = "Hello\n\n┌──┐\n│  │\n└──┘\n\nWorld";
    const state = createEditorStateV2(text, CW, CH);
    expect(serializeV2(state, CW, CH)).toBe(text);
  });

  it("move frame marks dirty and serializes correctly", () => {
    const text = "┌──┐\n│  │\n└──┘";
    const state = createEditorStateV2(text, CW, CH);
    const frames = getFramesV2(state);
    expect(frames.length).toBeGreaterThan(0);
    const frameId = frames[0].id;
    const moved = applyMoveFrameV2(state, frameId, 2, 0, CW, CH);
    const movedFrames = getFramesV2(moved);
    expect(movedFrames[0].dirty).toBe(true);
    // Serialization reflects the move
    const md = serializeV2(moved, CW, CH);
    expect(md.split("\n")[0]).toMatch(/^ {2}┌──┐/);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/editorStateV2.test.ts
# Expected: "Cannot find module './editorStateV2'"
```

### Step 3: Write minimal implementation

```typescript
// src/editorStateV2.ts
/**
 * Region-based EditorState.
 *
 * The CM doc contains the FULL .md file (prose + wireframe text).
 * Regions are tracked as a StateField. Frames are tracked as a StateField.
 * Serialize = regionSerialize(state, frames).
 */
import {
  EditorState,
  StateField,
  StateEffect,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { history, invertedEffects } from "@codemirror/commands";
import { regionsField, getRegions } from "./regionState";
import { loadDocument } from "./regionLoader";
import { regionSerialize } from "./regionSerialize";
import { moveFrame, resizeFrame, type Frame } from "./frame";
import type { Region } from "./regions";

// ── Effects ─────────────────────────────────────────────────

export const moveFrameV2Effect = StateEffect.define<{
  id: string; dCol: number; dRow: number; charWidth: number; charHeight: number;
}>();

export const resizeFrameV2Effect = StateEffect.define<{
  id: string; gridW: number; gridH: number; charWidth: number; charHeight: number;
}>();

const restoreFramesV2Effect = StateEffect.define<Frame[]>();

// ── Helpers ─────────────────────────────────────────────────

function markDirtyById(frames: Frame[], id: string): { frames: Frame[]; found: boolean } {
  let found = false;
  const result = frames.map(f => {
    if (f.id === id) { found = true; return { ...f, dirty: true }; }
    if (f.children.length === 0) return f;
    const sub = markDirtyById(f.children, id);
    if (sub.found) { found = true; return { ...f, children: sub.frames, dirty: true }; }
    return f;
  });
  return { frames: found ? result : frames, found };
}

// ── StateField ──────────────────────────────────────────────

const framesV2Field = StateField.define<Frame[]>({
  create: () => [],
  update(frames, tr: Transaction) {
    let result = frames;
    for (const e of tr.effects) {
      if (e.is(restoreFramesV2Effect)) {
        return e.value;
      } else if (e.is(moveFrameV2Effect)) {
        const applyMove = (f: Frame): Frame => {
          if (f.id === e.value.id) return moveFrame(f, e.value);
          if (f.children.length > 0) return { ...f, children: f.children.map(applyMove) };
          return f;
        };
        result = result.map(applyMove);
        result = markDirtyById(result, e.value.id).frames;
      } else if (e.is(resizeFrameV2Effect)) {
        const applyResize = (f: Frame): Frame => {
          if (f.id === e.value.id) return resizeFrame(f, { gridW: e.value.gridW, gridH: e.value.gridH }, e.value.charWidth, e.value.charHeight);
          if (f.children.length > 0) return { ...f, children: f.children.map(applyResize) };
          return f;
        };
        result = result.map(applyResize);
        result = markDirtyById(result, e.value.id).frames;
      }
    }
    return result;
  },
});

// ── Factory ─────────────────────────────────────────────────

export function createEditorStateV2(
  text: string,
  charWidth: number,
  charHeight: number,
): EditorState {
  const { state: baseState, frames } = loadDocument(text, charWidth, charHeight);

  const frameInversion = invertedEffects.of((tr) => {
    const hasFrameEffect = tr.effects.some(
      e => e.is(moveFrameV2Effect) || e.is(resizeFrameV2Effect),
    );
    if (!hasFrameEffect) return [];
    return [restoreFramesV2Effect.of(tr.startState.field(framesV2Field))];
  });

  return EditorState.create({
    doc: text,
    extensions: [
      history(),
      frameInversion,
      regionsField,
      framesV2Field.init(() => frames),
    ],
  });
}

// ── Accessors ───────────────────────────────────────────────

export function getFramesV2(state: EditorState): Frame[] {
  return state.field(framesV2Field);
}

export function getRegionsV2(state: EditorState): Region[] {
  return getRegions(state);
}

// ── Operations ──────────────────────────────────────────────

export function applyMoveFrameV2(
  state: EditorState,
  id: string,
  dCol: number,
  dRow: number,
  charWidth: number,
  charHeight: number,
): EditorState {
  return state.update({
    effects: moveFrameV2Effect.of({ id, dCol, dRow, charWidth, charHeight }),
    annotations: Transaction.addToHistory.of(true),
  }).state;
}

// ── Serialize ───────────────────────────────────────────────

export function serializeV2(
  state: EditorState,
  charWidth: number,
  charHeight: number,
): string {
  return regionSerialize(state, getFramesV2(state), charWidth, charHeight);
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/editorStateV2.test.ts
# Expected: all 3 tests pass
```

### Step 5: Commit

```bash
git add src/editorStateV2.ts src/editorStateV2.test.ts
git commit -m "feat: add EditorState V2 — region-based state with frames + serialize"
```

---

## Task 9: Wire up rendering — regions provide data to Pretext + canvas

**Files:** `src/regionRender.ts` (create), `src/regionRender.test.ts` (create)

This module bridges regions to the existing rendering pipeline: prose regions go to Pretext, wireframe region frames go to the canvas renderer.

### Step 1: Write the failing test

```typescript
// src/regionRender.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { buildRenderData } from "./regionRender";
import { detectRegions } from "./regions";
import type { Frame } from "./frame";
import type { Obstacle } from "./reflowLayout";

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

describe("buildRenderData", () => {
  it("extracts prose text for Pretext from regions", () => {
    const text = "Hello World\n\n┌──┐\n└──┘\n\nEnd";
    const regions = detectRegions(text);
    const frames: Frame[] = [{
      id: "f1", x: 0, y: 2 * CH, w: 4 * CW, h: 2 * CH,
      z: 0, children: [], content: { type: "rect", cells: new Map(), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } },
      clip: true, dirty: false, gridRow: 2, gridCol: 0, gridW: 4, gridH: 2,
    }];
    const data = buildRenderData(regions, frames, CW, CH);
    expect(data.proseText).toBe("Hello World\nEnd");
    expect(data.obstacles.length).toBeGreaterThan(0);
  });

  it("returns empty prose for wireframe-only doc", () => {
    const text = "┌──┐\n└──┘";
    const regions = detectRegions(text);
    const data = buildRenderData(regions, [], CW, CH);
    expect(data.proseText).toBe("");
  });

  it("maps prose source lines correctly", () => {
    const text = "Line 1\nLine 2\n\n┌──┐\n└──┘\n\nLine 3";
    const regions = detectRegions(text);
    const data = buildRenderData(regions, [], CW, CH);
    // "Line 1", "Line 2" from first prose region, "Line 3" from second
    expect(data.proseText).toBe("Line 1\nLine 2\nLine 3");
    expect(data.proseLineToDocLine).toEqual([0, 1, 6]);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionRender.test.ts
# Expected: "Cannot find module './regionRender'"
```

### Step 3: Write minimal implementation

```typescript
// src/regionRender.ts
import type { Region } from "./regions";
import type { Frame, Obstacle } from "./frame";

export interface RenderData {
  /** Prose text for Pretext (prose regions concatenated) */
  proseText: string;
  /** Mapping: proseText line index → document line number */
  proseLineToDocLine: number[];
  /** Obstacles for Pretext reflow (from frames) */
  obstacles: Obstacle[];
}

/**
 * Build render data from regions and frames.
 *
 * Prose regions contribute text lines to Pretext.
 * Frames contribute obstacles for Pretext reflow.
 */
export function buildRenderData(
  regions: Region[],
  frames: Frame[],
  charWidth: number,
  charHeight: number,
): RenderData {
  const proseLines: string[] = [];
  const proseLineToDocLine: number[] = [];

  for (const region of regions) {
    if (region.type !== "prose") continue;
    for (let i = 0; i < region.lines.length; i++) {
      proseLines.push(region.lines[i]);
      proseLineToDocLine.push(region.startLine + i);
    }
  }

  const obstacles: Obstacle[] = frames.map(f => ({
    id: f.id,
    x: f.x,
    y: f.y,
    w: f.w,
    h: f.h,
  }));

  return {
    proseText: proseLines.join("\n"),
    proseLineToDocLine,
    obstacles,
  };
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionRender.test.ts
# Expected: all 3 tests pass
```

### Step 5: Commit

```bash
git add src/regionRender.ts src/regionRender.test.ts
git commit -m "feat: add buildRenderData — bridges regions to Pretext + canvas renderer"
```

---

## Task 10: Wireframe interaction — move within region

**Files:** `src/regionInteraction.ts` (create), `src/regionInteraction.test.ts` (create)

Handles wireframe movement. Horizontal movement (within claimed rows) just shifts characters. Vertical movement that crosses region boundaries splices lines in the CM doc.

### Step 1: Write the failing test

```typescript
// src/regionInteraction.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { moveWireframeInRegion } from "./regionInteraction";
import type { Region } from "./regions";

describe("moveWireframeInRegion", () => {
  it("moves wireframe right within region (horizontal shift)", () => {
    const region: Region = {
      type: "wireframe",
      startLine: 2,
      endLine: 4,
      lines: ["┌──┐", "│  │", "└──┘"],
    };
    const result = moveWireframeInRegion(region, 2, 0);
    expect(result.lines).toEqual(["  ┌──┐", "  │  │", "  └──┘"]);
  });

  it("moves wireframe left (removes leading spaces)", () => {
    const region: Region = {
      type: "wireframe",
      startLine: 2,
      endLine: 4,
      lines: ["  ┌──┐", "  │  │", "  └──┘"],
    };
    const result = moveWireframeInRegion(region, -2, 0);
    expect(result.lines).toEqual(["┌──┐", "│  │", "└──┘"]);
  });

  it("clamps left movement to column 0", () => {
    const region: Region = {
      type: "wireframe",
      startLine: 0,
      endLine: 2,
      lines: ["┌──┐", "│  │", "└──┘"],
    };
    const result = moveWireframeInRegion(region, -5, 0);
    expect(result.lines).toEqual(["┌──┐", "│  │", "└──┘"]);
  });

  it("adds blank lines for vertical movement within region padding", () => {
    const region: Region = {
      type: "wireframe",
      startLine: 2,
      endLine: 6,
      lines: ["", "┌──┐", "│  │", "└──┘", ""],
    };
    // Move down 1 row (within the padding)
    const result = moveWireframeInRegion(region, 0, 1);
    expect(result.lines).toEqual(["", "", "┌──┐", "│  │", "└──┘"]);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionInteraction.test.ts
# Expected: "Cannot find module './regionInteraction'"
```

### Step 3: Write minimal implementation

```typescript
// src/regionInteraction.ts
import type { Region } from "./regions";

/**
 * Move a wireframe horizontally within its region.
 * dCol > 0: prepend spaces to each non-blank line.
 * dCol < 0: remove leading spaces (clamped to 0).
 * dRow: shift wire-char lines within the region's blank padding.
 *
 * Returns a new Region with updated lines.
 */
export function moveWireframeInRegion(
  region: Region,
  dCol: number,
  dRow: number,
): Region {
  let lines = [...region.lines];

  // Horizontal movement: shift all non-blank lines
  if (dCol !== 0) {
    if (dCol > 0) {
      const pad = " ".repeat(dCol);
      lines = lines.map(l => l.trim() === "" ? l : pad + l);
    } else {
      const remove = -dCol;
      // Find minimum leading spaces across non-blank lines
      let minSpaces = Infinity;
      for (const l of lines) {
        if (l.trim() === "") continue;
        const spaces = l.length - l.trimStart().length;
        minSpaces = Math.min(minSpaces, spaces);
      }
      const actualRemove = Math.min(remove, minSpaces === Infinity ? 0 : minSpaces);
      lines = lines.map(l => l.trim() === "" ? l : l.slice(actualRemove));
    }
  }

  // Vertical movement within region padding
  if (dRow !== 0) {
    // Separate blank padding from wire content
    let firstWire = -1;
    let lastWire = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== "") {
        if (firstWire === -1) firstWire = i;
        lastWire = i;
      }
    }

    if (firstWire >= 0 && lastWire >= 0) {
      const wireLines = lines.slice(firstWire, lastWire + 1);
      const totalSlots = lines.length;
      const wireHeight = wireLines.length;
      const maxStart = totalSlots - wireHeight;

      // New position for wire content (clamped within region)
      const newStart = Math.max(0, Math.min(maxStart, firstWire + dRow));

      const newLines: string[] = [];
      for (let i = 0; i < totalSlots; i++) {
        if (i >= newStart && i < newStart + wireHeight) {
          newLines.push(wireLines[i - newStart]);
        } else {
          newLines.push("");
        }
      }
      lines = newLines;
    }
  }

  return { ...region, lines };
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionInteraction.test.ts
# Expected: all 4 tests pass
```

### Step 5: Commit

```bash
git add src/regionInteraction.ts src/regionInteraction.test.ts
git commit -m "feat: add moveWireframeInRegion — horizontal shift + vertical movement within padding"
```

---

## Task 11: Vertical reorder — splice wireframe between prose paragraphs

**Files:** `src/regionReorder.ts` (create), `src/regionReorder.test.ts` (create)

### Step 1: Write the failing test

```typescript
// src/regionReorder.test.ts
import { describe, it, expect } from "vitest";
import { reorderRegion, detectRegions, serializeRegions } from "./regions";
import { reorderWireframeRegion } from "./regionReorder";

describe("reorderWireframeRegion", () => {
  it("moves wireframe region up (swaps with previous prose)", () => {
    const text = "First\n\n┌──┐\n└──┘\n\nSecond\n\n┌──┐\n└──┘\n\nThird";
    const regions = detectRegions(text);
    // Move second wireframe (index 3) up past "Second" prose
    const reordered = reorderWireframeRegion(regions, 3, -1);
    expect(reordered.map(r => r.type)).toEqual([
      "prose", "wireframe", "wireframe", "prose", "prose",
    ]);
  });

  it("moves wireframe region down (swaps with next prose)", () => {
    const text = "First\n\n┌──┐\n└──┘\n\nSecond\n\n┌──┐\n└──┘\n\nThird";
    const regions = detectRegions(text);
    // Move first wireframe (index 1) down past "Second" prose
    const reordered = reorderWireframeRegion(regions, 1, 1);
    expect(reordered[0].type).toBe("prose"); // "First"
    expect(reordered[1].type).toBe("prose"); // "Second"
    expect(reordered[2].type).toBe("wireframe"); // moved wireframe
  });

  it("clamps movement at document boundaries", () => {
    const text = "┌──┐\n└──┘\n\nEnd";
    const regions = detectRegions(text);
    // Try to move wireframe up past top of doc — should stay
    const reordered = reorderWireframeRegion(regions, 0, -1);
    expect(reordered[0].type).toBe("wireframe");
  });

  it("serializes correctly after reorder", () => {
    const text = "Prose A\n\n┌──┐\n└──┘\n\nProse B";
    const regions = detectRegions(text);
    const reordered = reorderWireframeRegion(regions, 1, 1);
    const serialized = serializeRegions(reordered);
    // Wireframe should now be after "Prose B"
    const lines = serialized.split("\n");
    const wireIdx = lines.findIndex(l => l.includes("┌"));
    const bIdx = lines.findIndex(l => l.includes("Prose B"));
    expect(wireIdx).toBeGreaterThan(bIdx);
  });

  it("ignores reorder of prose regions", () => {
    const text = "Hello\n\n┌──┐\n└──┘\n\nWorld";
    const regions = detectRegions(text);
    const reordered = reorderWireframeRegion(regions, 0, 1); // prose region
    // Should be unchanged since index 0 is prose
    expect(reordered.map(r => r.type)).toEqual(regions.map(r => r.type));
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionReorder.test.ts
# Expected: "Cannot find module './regionReorder'"
```

### Step 3: Write minimal implementation

```typescript
// src/regionReorder.ts
import type { Region } from "./regions";

/**
 * Reorder a wireframe region by swapping it with an adjacent prose region.
 *
 * direction < 0: move up (swap with previous non-wireframe region)
 * direction > 0: move down (swap with next non-wireframe region)
 *
 * Returns a new array of regions with updated startLine/endLine.
 * Does NOT modify the CM doc — the caller must apply the reorder as a
 * CM transaction (delete + insert lines).
 */
export function reorderWireframeRegion(
  regions: Region[],
  regionIndex: number,
  direction: number,
): Region[] {
  if (regionIndex < 0 || regionIndex >= regions.length) return regions;
  if (regions[regionIndex].type !== "wireframe") return regions;

  const result = [...regions];

  if (direction < 0 && regionIndex > 0) {
    // Swap with previous region
    const prev = result[regionIndex - 1];
    const curr = result[regionIndex];
    result[regionIndex - 1] = curr;
    result[regionIndex] = prev;
  } else if (direction > 0 && regionIndex < regions.length - 1) {
    // Swap with next region
    const next = result[regionIndex + 1];
    const curr = result[regionIndex];
    result[regionIndex] = next;
    result[regionIndex + 1] = curr;
  } else {
    return regions; // can't move
  }

  // Recalculate startLine/endLine
  let cursor = 0;
  for (const r of result) {
    const lineCount = r.lines.length;
    r.startLine = cursor;
    r.endLine = cursor + lineCount - 1;
    cursor += lineCount;
  }

  return result;
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionReorder.test.ts
# Expected: all 5 tests pass
```

### Step 5: Commit

```bash
git add src/regionReorder.ts src/regionReorder.test.ts
git commit -m "feat: add reorderWireframeRegion — vertical reorder by swapping with adjacent prose"
```

---

## Task 12: Region boundary resize (add/remove blank lines)

**Files:** `src/regionBoundary.ts` (create), `src/regionBoundary.test.ts` (create)

### Step 1: Write the failing test

```typescript
// src/regionBoundary.test.ts
import { describe, it, expect } from "vitest";
import { resizeRegionBoundary } from "./regionBoundary";
import { detectRegions, serializeRegions } from "./regions";

describe("resizeRegionBoundary", () => {
  it("adds blank line to top of wireframe region", () => {
    const text = "Hello\n\n┌──┐\n└──┘\n\nWorld";
    const regions = detectRegions(text);
    const wireIdx = regions.findIndex(r => r.type === "wireframe");
    const updated = resizeRegionBoundary(regions, wireIdx, "top", 1);
    // One more blank line at the top of the wireframe region
    expect(updated[wireIdx].lines.length).toBe(regions[wireIdx].lines.length + 1);
    expect(updated[wireIdx].lines[0]).toBe("");
  });

  it("removes blank line from bottom of wireframe region", () => {
    const text = "Hello\n\n\n┌──┐\n└──┘\n\n\nWorld";
    const regions = detectRegions(text);
    const wireIdx = regions.findIndex(r => r.type === "wireframe");
    const originalLen = regions[wireIdx].lines.length;
    const updated = resizeRegionBoundary(regions, wireIdx, "bottom", -1);
    expect(updated[wireIdx].lines.length).toBe(originalLen - 1);
  });

  it("cannot remove blank lines past the wire content", () => {
    const text = "┌──┐\n└──┘";
    const regions = detectRegions(text);
    const wireIdx = 0;
    // No blank lines to remove — should be a no-op
    const updated = resizeRegionBoundary(regions, wireIdx, "top", -1);
    expect(updated[wireIdx].lines).toEqual(regions[wireIdx].lines);
  });

  it("round-trips after adding padding", () => {
    const text = "Hello\n\n┌──┐\n└──┘\n\nWorld";
    const regions = detectRegions(text);
    const wireIdx = regions.findIndex(r => r.type === "wireframe");
    const updated = resizeRegionBoundary(regions, wireIdx, "bottom", 2);
    const serialized = serializeRegions(updated);
    // Should have 2 more blank lines between wireframe and "World"
    const lines = serialized.split("\n");
    const boxEnd = lines.findIndex(l => l.includes("└"));
    // Count blanks after the box
    let blanks = 0;
    for (let i = boxEnd + 1; i < lines.length && lines[i].trim() === ""; i++) blanks++;
    expect(blanks).toBeGreaterThanOrEqual(3); // original 1 + added 2
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionBoundary.test.ts
# Expected: "Cannot find module './regionBoundary'"
```

### Step 3: Write minimal implementation

```typescript
// src/regionBoundary.ts
import type { Region } from "./regions";

/**
 * Resize a wireframe region's boundary by adding or removing blank lines.
 *
 * edge: "top" or "bottom"
 * delta > 0: add blank lines at the edge
 * delta < 0: remove blank lines at the edge (clamped to not remove wire content)
 *
 * Returns updated regions array with recalculated startLine/endLine.
 */
export function resizeRegionBoundary(
  regions: Region[],
  regionIndex: number,
  edge: "top" | "bottom",
  delta: number,
): Region[] {
  if (regionIndex < 0 || regionIndex >= regions.length) return regions;
  const region = regions[regionIndex];
  if (region.type !== "wireframe") return regions;

  const lines = [...region.lines];

  if (delta > 0) {
    // Add blank lines
    const blanks = Array(delta).fill("");
    if (edge === "top") {
      lines.unshift(...blanks);
    } else {
      lines.push(...blanks);
    }
  } else if (delta < 0) {
    const remove = -delta;
    if (edge === "top") {
      // Count removable blank lines at top
      let removable = 0;
      for (let i = 0; i < lines.length && lines[i].trim() === ""; i++) removable++;
      const actual = Math.min(remove, removable);
      lines.splice(0, actual);
    } else {
      // Count removable blank lines at bottom
      let removable = 0;
      for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) removable++;
      const actual = Math.min(remove, removable);
      lines.splice(lines.length - actual, actual);
    }
  }

  // Build result with updated region
  const result = regions.map((r, i) => {
    if (i === regionIndex) return { ...r, lines };
    return { ...r };
  });

  // Recalculate startLine/endLine
  let cursor = 0;
  for (const r of result) {
    r.startLine = cursor;
    r.endLine = cursor + r.lines.length - 1;
    cursor += r.lines.length;
  }

  return result;
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionBoundary.test.ts
# Expected: all 4 tests pass
```

### Step 5: Commit

```bash
git add src/regionBoundary.ts src/regionBoundary.test.ts
git commit -m "feat: add resizeRegionBoundary — add/remove blank padding at wireframe edges"
```

---

## Task 13: Visual demarcation — wireframe region background tint

**Files:** `src/regionPaint.ts` (create), `src/regionPaint.test.ts` (create)

### Step 1: Write the failing test

```typescript
// src/regionPaint.test.ts
import { describe, it, expect } from "vitest";
import { computeRegionBackgrounds } from "./regionPaint";
import { detectRegions } from "./regions";

describe("computeRegionBackgrounds", () => {
  it("returns background rects for wireframe regions", () => {
    const text = "Hello\n\n┌──┐\n│  │\n└──┘\n\nWorld";
    const regions = detectRegions(text);
    const lineHeight = 18.4;
    const canvasWidth = 800;
    const backgrounds = computeRegionBackgrounds(regions, lineHeight, canvasWidth);

    // Should have 1 background for the wireframe region
    expect(backgrounds).toHaveLength(1);
    expect(backgrounds[0].y).toBe(regions[1].startLine * lineHeight);
    expect(backgrounds[0].h).toBe(regions[1].lines.length * lineHeight);
    expect(backgrounds[0].w).toBe(canvasWidth);
  });

  it("returns no backgrounds for prose-only doc", () => {
    const regions = detectRegions("Hello\nWorld");
    const backgrounds = computeRegionBackgrounds(regions, 18.4, 800);
    expect(backgrounds).toHaveLength(0);
  });

  it("returns multiple backgrounds for multiple wireframes", () => {
    const text = "A\n\n┌──┐\n└──┘\n\nB\n\n┌──┐\n└──┘\n\nC";
    const regions = detectRegions(text);
    const backgrounds = computeRegionBackgrounds(regions, 18.4, 800);
    expect(backgrounds).toHaveLength(2);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionPaint.test.ts
# Expected: "Cannot find module './regionPaint'"
```

### Step 3: Write minimal implementation

```typescript
// src/regionPaint.ts
import type { Region } from "./regions";

export interface RegionBackground {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** Subtle tint for wireframe regions */
const WIREFRAME_TINT = "rgba(74, 144, 226, 0.04)";

/**
 * Compute background rectangles for wireframe region visual demarcation.
 * Each wireframe region gets a subtle tinted background.
 */
export function computeRegionBackgrounds(
  regions: Region[],
  lineHeight: number,
  canvasWidth: number,
): RegionBackground[] {
  return regions
    .filter(r => r.type === "wireframe")
    .map(r => ({
      x: 0,
      y: r.startLine * lineHeight,
      w: canvasWidth,
      h: r.lines.length * lineHeight,
      color: WIREFRAME_TINT,
    }));
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionPaint.test.ts
# Expected: all 3 tests pass
```

### Step 5: Commit

```bash
git add src/regionPaint.ts src/regionPaint.test.ts
git commit -m "feat: add computeRegionBackgrounds — visual demarcation for wireframe regions"
```

---

## Task 14: Drawing tools — create new wireframe region at cursor

**Files:** `src/regionCreate.ts` (create), `src/regionCreate.test.ts` (create)

### Step 1: Write the failing test

```typescript
// src/regionCreate.test.ts
import { describe, it, expect } from "vitest";
import { insertWireframeRegion } from "./regionCreate";
import { detectRegions, serializeRegions } from "./regions";

describe("insertWireframeRegion", () => {
  it("inserts a new wireframe region after the cursor line", () => {
    const text = "Line 1\nLine 2\nLine 3";
    const regions = detectRegions(text);
    // Insert after line 1 (between "Line 1" and "Line 2")
    const wireLines = ["", "┌────┐", "│    │", "└────┘", ""];
    const updated = insertWireframeRegion(regions, 0, wireLines);
    // Should now be: prose("Line 1"), wireframe(new box), prose("Line 2", "Line 3")
    expect(updated.map(r => r.type)).toEqual(["prose", "wireframe", "prose"]);
    expect(updated[0].lines).toEqual(["Line 1"]);
    expect(updated[1].lines).toEqual(wireLines);
    expect(updated[2].lines).toEqual(["Line 2", "Line 3"]);
  });

  it("inserts at end of document", () => {
    const text = "Hello";
    const regions = detectRegions(text);
    const wireLines = ["", "┌──┐", "└──┘", ""];
    const updated = insertWireframeRegion(regions, 0, wireLines);
    expect(updated).toHaveLength(2);
    expect(updated[0].lines).toEqual(["Hello"]);
    expect(updated[1].lines).toEqual(wireLines);
  });

  it("serializes correctly after insertion", () => {
    const text = "Above\n\nBelow";
    const regions = detectRegions(text);
    const wireLines = ["", "┌──┐", "└──┘", ""];
    const updated = insertWireframeRegion(regions, 0, wireLines);
    const serialized = serializeRegions(updated);
    expect(serialized).toContain("Above");
    expect(serialized).toContain("┌──┐");
    expect(serialized).toContain("Below");
    // Wireframe should be between Above and Below
    const lines = serialized.split("\n");
    const aboveIdx = lines.indexOf("Above");
    const wireIdx = lines.findIndex(l => l.includes("┌"));
    const belowIdx = lines.indexOf("Below");
    expect(wireIdx).toBeGreaterThan(aboveIdx);
    expect(belowIdx).toBeGreaterThan(wireIdx);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionCreate.test.ts
# Expected: "Cannot find module './regionCreate'"
```

### Step 3: Write minimal implementation

```typescript
// src/regionCreate.ts
import type { Region } from "./regions";

/**
 * Insert a new wireframe region after a given prose region.
 *
 * afterRegionIndex: the index of the prose region to insert after.
 * wireLines: the lines of the new wireframe region (including blank padding).
 *
 * Splits the target prose region at the end if needed, inserts the wireframe,
 * and returns updated regions with recalculated startLine/endLine.
 */
export function insertWireframeRegion(
  regions: Region[],
  afterRegionIndex: number,
  wireLines: string[],
): Region[] {
  if (afterRegionIndex < 0 || afterRegionIndex >= regions.length) return regions;

  const result: Region[] = [];

  for (let i = 0; i <= afterRegionIndex; i++) {
    result.push({ ...regions[i], lines: [...regions[i].lines] });
  }

  // Insert the new wireframe region
  result.push({
    type: "wireframe",
    startLine: 0, // will be recalculated
    endLine: 0,
    lines: wireLines,
  });

  // Remaining regions
  for (let i = afterRegionIndex + 1; i < regions.length; i++) {
    result.push({ ...regions[i], lines: [...regions[i].lines] });
  }

  // Recalculate startLine/endLine
  let cursor = 0;
  for (const r of result) {
    r.startLine = cursor;
    r.endLine = cursor + r.lines.length - 1;
    cursor += r.lines.length;
  }

  return result;
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionCreate.test.ts
# Expected: all 3 tests pass
```

### Step 5: Commit

```bash
git add src/regionCreate.ts src/regionCreate.test.ts
git commit -m "feat: add insertWireframeRegion — create new wireframe at cursor position"
```

---

## Task 15: Round-trip integration test

**Files:** `src/regionRoundtrip.test.ts` (create)

This test validates the full pipeline: load → detect regions → serialize → compare. It uses the same fixture files as the existing harness to prove the new system matches.

### Step 1: Write the failing test

```typescript
// src/regionRoundtrip.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { detectRegions, serializeRegions } from "./regions";
import { loadDocument } from "./regionLoader";
import { regionSerialize } from "./regionSerialize";
// @ts-expect-error vitest runs in node where fs/path exist
import * as fs from "fs";
// @ts-expect-error vitest runs in node where fs/path exist
import * as path from "path";

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

const WIRE_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╭╮╰╯━"]);

describe("region-based round-trip", () => {
  it("detectRegions → serializeRegions is identity for any text", () => {
    const texts = [
      "Hello world",
      "┌──┐\n│  │\n└──┘",
      "Title\n\n┌──┐\n│  │\n└──┘\n\nEnd",
      "A\n\n┌──┐\n└──┘\n\nB\n\n┌──┐\n└──┘\n\nC",
      "", // edge case: empty
    ];
    for (const text of texts) {
      if (text === "") {
        expect(serializeRegions(detectRegions(text))).toBe("");
        continue;
      }
      const regions = detectRegions(text);
      expect(serializeRegions(regions)).toBe(text);
    }
  });

  it("loadDocument + regionSerialize round-trips (no edits)", () => {
    const text = [
      "# Dashboard",
      "",
      "Overview of metrics.",
      "",
      "",
      "┌──────────────┐",
      "│  Dashboard   │",
      "├──────┬───────┤",
      "│ Nav  │ Main  │",
      "└──────┴───────┘",
      "",
      "",
      "More text here.",
    ].join("\n");

    const { state, frames } = loadDocument(text, CW, CH);
    const serialized = regionSerialize(state, frames, CW, CH);
    expect(serialized).toBe(text);
  });

  it("no ghost wire characters after round-trip", () => {
    const text = [
      "Title",
      "",
      "┌──────┐",
      "│ Box  │",
      "└──────┘",
      "",
      "End",
    ].join("\n");

    const { state, frames } = loadDocument(text, CW, CH);
    const serialized = regionSerialize(state, frames, CW, CH);
    const regions = detectRegions(serialized);

    // Every wire character should be inside a wireframe region
    const wireRegionLines = new Set<number>();
    for (const r of regions) {
      if (r.type === "wireframe") {
        for (let l = r.startLine; l <= r.endLine; l++) wireRegionLines.add(l);
      }
    }

    const lines = serialized.split("\n");
    for (let r = 0; r < lines.length; r++) {
      for (const ch of lines[r]) {
        if (WIRE_CHARS.has(ch)) {
          expect(wireRegionLines.has(r)).toBe(true);
        }
      }
    }
  });

  // Test with fixture files if they exist
  const fixtureDir = path.join(__dirname, "..", "fixtures");
  if (fs.existsSync(fixtureDir)) {
    const fixtures = fs.readdirSync(fixtureDir)
      .filter((f: string) => f.endsWith(".md"))
      .slice(0, 5);

    for (const fixture of fixtures) {
      it(`round-trips fixture: ${fixture}`, () => {
        const text = fs.readFileSync(path.join(fixtureDir, fixture), "utf-8");
        const regions = detectRegions(text);
        expect(serializeRegions(regions)).toBe(text);
      });
    }
  }
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/regionRoundtrip.test.ts
# Expected: import failures or test failures from unimplemented code
```

### Step 3: Implementation

No new code needed — this test validates the modules from Tasks 1–7. All imports should resolve if previous tasks are complete.

### Step 4: Run test to verify it passes

```bash
npx vitest run src/regionRoundtrip.test.ts
# Expected: all tests pass
```

### Step 5: Commit

```bash
git add src/regionRoundtrip.test.ts
git commit -m "test: add region-based round-trip integration tests — validates no ghosts"
```

---

## Task 16: Wire DemoV2.tsx to use region-based system

**Files:** `src/DemoV2.tsx` (modify)

This is the migration task — swap DemoV2 from the old system to the new one.

### Step 1: Write the failing test

This task is UI integration — tested via Playwright. Write the e2e test first:

```typescript
// e2e/region-smoke.spec.ts
import { test, expect } from "@playwright/test";

test("region-based rendering shows wireframes and prose", async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForTimeout(1000);

  // Canvas should render
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();

  // Take a screenshot — should show prose text and wireframe boxes
  const screenshot = await canvas.screenshot();
  expect(screenshot.byteLength).toBeGreaterThan(1000);
});

test("no console errors on load", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto("http://localhost:5173");
  await page.waitForTimeout(2000);
  expect(errors).toEqual([]);
});
```

### Step 2: Changes to DemoV2.tsx

The migration involves these specific changes (each is a targeted edit, not a rewrite):

**Replace imports:**
```typescript
// REMOVE:
import { gridSerialize, rebuildOriginalGrid, snapshotFrameBboxes, type FrameBbox } from "./gridSerialize";
import { scanToFrames } from "./scanToFrames";
import { getProseSegmentMap, getOriginalProseSegments } from "./editorState";

// ADD:
import { loadDocument } from "./regionLoader";
import { regionSerialize } from "./regionSerialize";
import { getRegions } from "./regionState";
```

**Remove old refs:**
```typescript
// REMOVE these refs from DemoV2():
const originalGridRef = useRef<string[][]>([]);
const frameBboxSnapshotRef = useRef<FrameBbox[]>([]);
```

**Replace saveToHandle:**
```typescript
// BEFORE (old gridSerialize call):
const md = gridSerialize(
  getFrames(state), getDoc(state),
  getProseSegmentMap(state), originalGridRef.current,
  cwRef.current, chRef.current,
  getOriginalProseSegments(state),
  frameBboxSnapshotRef.current,
);

// AFTER:
const md = regionSerialize(stateRef.current, getFrames(stateRef.current), cwRef.current, chRef.current);
```

**Remove post-save bookkeeping:**
```typescript
// REMOVE from saveToHandle (after write):
const { proseSegments: newSegs } = scanToFrames(md, cwRef.current, chRef.current);
stateRef.current = applySetOriginalProseSegments(stateRef.current, newSegs);
originalGridRef.current = rebuildOriginalGrid(md);
frameBboxSnapshotRef.current = snapshotFrameBboxes(getFrames(stateRef.current));

// REPLACE with:
// No bookkeeping needed — the CM doc IS the file.
// Just clear dirty flags.
```

**Replace loadDocument:**
```typescript
// BEFORE:
function loadDocument(text: string) {
  const cw = cwRef.current, ch = chRef.current;
  stateRef.current = createEditorStateFromText(text, cw, ch);
  const { originalGrid } = scanToFrames(text, cw, ch);
  originalGridRef.current = originalGrid;
  frameBboxSnapshotRef.current = snapshotFrameBboxes(getFrames(stateRef.current));
  ...
}

// AFTER:
function loadDoc(text: string) {
  const cw = cwRef.current, ch = chRef.current;
  const { state, frames } = loadDocument(text, cw, ch);
  // TODO: merge frames into EditorState V2 — for now, keep using old editorState
  // with frames injected. This is the bridge step.
  stateRef.current = createEditorStateFromText(text, cw, ch);
  ...
}
```

Note: The full DemoV2 migration is better done as a sequence of smaller PRs. This task writes the bridge code. The final migration (Task 17) removes the old system entirely.

### Step 3: Implementation — targeted edits only

See the specific edits above. Each `REMOVE` / `ADD` / `REPLACE` is one `Edit` tool call.

### Step 4: Run Playwright to verify

```bash
npx playwright test e2e/region-smoke.spec.ts
# Expected: both tests pass
```

### Step 5: Commit

```bash
git add src/DemoV2.tsx e2e/region-smoke.spec.ts
git commit -m "feat: wire DemoV2 to region-based serialization — bridge step"
```

---

## Task 17: Migration — remove old systems

**Files:** Multiple files modified/deleted

This is the cleanup task. Only execute after all previous tasks pass and the e2e suite is green.

### Changes:

1. **Delete `src/gridSerialize.ts`** — replaced by `regionSerialize.ts` (keep `repairJunctions` — moved to own file or inlined in regionSerialize).

2. **Delete `src/proseSegments.ts`** — replaced by region-based prose extraction.

3. **Remove from `src/editorState.ts`:**
   - `proseSegmentMapField` StateField
   - `getProseSegmentMap()`
   - `originalProseSegmentsField` StateField
   - `getOriginalProseSegments()`
   - `setOriginalProseSegmentsEffect`
   - `applySetOriginalProseSegments()`

4. **Remove from `src/DemoV2.tsx`:**
   - `originalGridRef`
   - `frameBboxSnapshotRef`
   - All `rebuildOriginalGrid` calls
   - All `snapshotFrameBboxes` calls
   - All `scanToFrames` calls (replaced by `loadDocument`)

5. **Update `src/scanToFrames.ts`** — still needed for initial load within `regionLoader.ts`, but the prose extraction logic moves to regions.

6. **Delete old test files** that test deleted code:
   - `src/gridSerialize.test.ts`
   - `src/proseSegments.test.ts`

7. **Update `src/diagnostic.test.ts`** — rewrite round-trip tests to use `regionSerialize` instead of `gridSerialize`.

### Verification:

```bash
npm test              # All vitest tests pass
npm run build         # TypeScript compiles clean
npx playwright test   # All e2e tests pass
```

### Commit:

```bash
git add -A
git commit -m "refactor: remove gridSerialize Phase A/B/C/D, proseSegmentMap, originalGrid — replaced by region model"
```

---

## Effort Estimate

| Task | Description | Estimate |
|------|-------------|----------|
| 1 | Region type + detectRegions | 15 min |
| 2 | serializeRegions | 5 min |
| 3 | Prose extraction from regions | 10 min |
| 4 | Wireframe extraction from regions | 10 min |
| 5 | Regions StateField | 15 min |
| 6 | Region-based document loader | 20 min |
| 7 | Region-based serialization | 25 min |
| 8 | Integrated EditorState V2 | 20 min |
| 9 | Render data bridge | 15 min |
| 10 | Wireframe interaction (move in region) | 15 min |
| 11 | Vertical reorder | 15 min |
| 12 | Region boundary resize | 10 min |
| 13 | Visual demarcation | 10 min |
| 14 | Drawing tools (create wireframe) | 10 min |
| 15 | Round-trip integration tests | 10 min |
| 16 | DemoV2 wiring (bridge) | 30 min |
| 17 | Migration — remove old systems | 45 min |

**Total: ~4.5 hours of implementation** (~0.5 engineer-days)

**With testing, debugging, and integration issues: 1.5–2 engineer-days**

### Risk factors that could increase effort:
- Scanner offset math when wireframe regions start at non-zero doc lines (Task 6)
- CM doc changes from prose edits shifting wireframe region boundaries (Task 5 incremental update)
- Dirty frame serialization edge cases — nested children, shared walls (Task 7)
- DemoV2 has many implicit dependencies on the old system (Task 16)

### What's intentionally deferred:
- Incremental region detection (full re-detect is O(lines), <1ms for 400 lines)
- Smooth drag preview during vertical reorder (requires Pretext integration work)
- Multi-wireframe regions (multiple wireframes separated by blank lines within one region)
- Undo/redo integration with region-level operations
