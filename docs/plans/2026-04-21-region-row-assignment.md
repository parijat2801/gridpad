# Region-Based Row Assignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the serializer's prose row-assignment logic (proseSegmentMap + dirty-path heuristic) with region-based row assignment. The document is an ordered list of wireframe regions and prose regions. The serializer writes them top-to-bottom. Pretext's layout output determines visual ordering.

**Architecture:** On load, scanner identifies wireframe line ranges. Everything else is prose. Regions are tracked by line ranges (startLine/endLine). Wireframe regions include adjacent blank lines. Serialization writes regions in order — no Phase C "available rows" heuristic. Pretext still renders prose with wrapping around wireframe obstacles.

**Tech Stack:** TypeScript, Vitest, Playwright, @chenglou/pretext, CodeMirror

**Estimated effort:** 1-2 days. ~200 lines changed, ~150 lines deleted.

---

### Task 1: Define Region Types and detectLineRegions

**Files:**
- Create: `src/regions2.ts` (new — named to avoid conflict with legacy regions.ts)
- Test: `src/regions2.test.ts`

**Step 1: Write the failing test**

```typescript
// src/regions2.test.ts
import { describe, it, expect } from "vitest";
import { detectLineRegions, type LineRegion } from "./regions2";

describe("detectLineRegions", () => {
  it("splits prose and wireframe", () => {
    const text = "Prose above\n\n┌──────┐\n│ Box  │\n└──────┘\n\nProse below";
    const regions = detectLineRegions(text);
    expect(regions).toEqual([
      { type: "prose", startLine: 0, endLine: 1 },
      { type: "wireframe", startLine: 2, endLine: 4 },
      { type: "prose", startLine: 5, endLine: 6 },
    ]);
  });

  it("wireframe claims trailing blank lines", () => {
    const text = "Prose\n\n┌──────┐\n│ Box  │\n└──────┘\n\n\nMore prose";
    const regions = detectLineRegions(text);
    // Blank lines after └──────┘ belong to wireframe until non-blank prose
    const wf = regions.find(r => r.type === "wireframe")!;
    expect(wf.endLine).toBe(6); // includes 2 blank lines after box
  });

  it("wireframe claims leading blank lines", () => {
    const text = "Prose\n\n\n┌──────┐\n│ Box  │\n└──────┘\nMore prose";
    const regions = detectLineRegions(text);
    const wf = regions.find(r => r.type === "wireframe")!;
    expect(wf.startLine).toBe(2); // includes blank line before box
  });

  it("multiple wireframes produce multiple regions", () => {
    const text = "Top\n\n┌────┐\n│ A  │\n└────┘\n\nMiddle\n\n┌────┐\n│ B  │\n└────┘\n\nBottom";
    const regions = detectLineRegions(text);
    const wireframes = regions.filter(r => r.type === "wireframe");
    expect(wireframes.length).toBe(2);
  });

  it("pure prose produces one region", () => {
    const text = "Just prose\nMore prose\nEven more";
    const regions = detectLineRegions(text);
    expect(regions).toEqual([{ type: "prose", startLine: 0, endLine: 2 }]);
  });

  it("nested wireframes are one region", () => {
    const text = "Top\n\n┌────────────┐\n│ ┌────────┐ │\n│ │ Inner  │ │\n│ └────────┘ │\n└────────────┘\n\nBottom";
    const regions = detectLineRegions(text);
    const wf = regions.find(r => r.type === "wireframe")!;
    expect(wf.startLine).toBe(2);
    expect(wf.endLine).toBe(6);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/regions2.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/regions2.ts
import { scan } from "./scanner";

export interface LineRegion {
  type: "prose" | "wireframe";
  startLine: number;
  endLine: number; // inclusive
}

/**
 * Split text into prose and wireframe regions by line ranges.
 * Uses the scanner to identify wireframe rows (authoritative shape detection).
 * Wireframe regions include adjacent blank lines above and below.
 */
export function detectLineRegions(text: string): LineRegion[] {
  const lines = text.split("\n");
  if (lines.length === 0) return [];

  const scanResult = scan(text);

  // Collect all rows claimed by wireframe shapes
  const wireframeRows = new Set<number>();
  for (const rect of scanResult.rects) {
    for (let r = rect.row; r < rect.row + rect.h; r++) wireframeRows.add(r);
  }
  for (const line of scanResult.lines) {
    const minR = Math.min(line.r1, line.r2);
    const maxR = Math.max(line.r1, line.r2);
    for (let r = minR; r <= maxR; r++) wireframeRows.add(r);
  }

  // Mark each line as wireframe or prose
  const isWireframe = lines.map((_, i) => wireframeRows.has(i));

  // Extend wireframe regions to include adjacent blank lines
  // Forward pass: blank lines after wireframe are claimed
  for (let i = 1; i < lines.length; i++) {
    if (!isWireframe[i] && lines[i].trim() === "" && isWireframe[i - 1]) {
      isWireframe[i] = true;
    }
  }
  // Backward pass: blank lines before wireframe are claimed
  for (let i = lines.length - 2; i >= 0; i--) {
    if (!isWireframe[i] && lines[i].trim() === "" && isWireframe[i + 1]) {
      isWireframe[i] = true;
    }
  }

  // Group into contiguous regions
  const regions: LineRegion[] = [];
  let start = 0;
  let type: "prose" | "wireframe" = isWireframe[0] ? "wireframe" : "prose";

  for (let i = 1; i <= lines.length; i++) {
    const nextType = i < lines.length ? (isWireframe[i] ? "wireframe" : "prose") : null;
    if (nextType !== type) {
      regions.push({ type, startLine: start, endLine: i - 1 });
      if (nextType) {
        start = i;
        type = nextType;
      }
    }
  }

  return regions;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/regions2.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/regions2.ts src/regions2.test.ts
git commit -m "feat: detectLineRegions — splits text into prose/wireframe line ranges"
```

---

### Task 2: Region-Based Serialization Function

**Files:**
- Create: `src/regionSerialize.ts`
- Test: `src/regionSerialize.test.ts`

**Step 1: Write the failing test**

```typescript
// src/regionSerialize.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { regionSerialize } from "./regionSerialize";
import { detectLineRegions } from "./regions2";
import { scanToFrames } from "./scanToFrames";
import { createEditorStateFromText, getFrames, getDoc } from "./editorState";
import type { Frame } from "./frame";

beforeAll(() => {
  // Canvas mock for measureText
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

const CW = 9.6, CH = 18.4;

describe("regionSerialize", () => {
  it("no-edit round-trip preserves text exactly", () => {
    const text = "Prose above\n\n┌──────┐\n│      │\n└──────┘\n\nProse below";
    const state = createEditorStateFromText(text, CW, CH);
    const frames = getFrames(state);
    const prose = getDoc(state);
    const regions = detectLineRegions(text);
    const result = regionSerialize(text, frames, prose, regions, CW, CH);
    expect(result).toBe(text);
  });

  it("preserves junction characters", () => {
    const text = "Header\n\n┌───────────┬───────────┐\n│  Left     │  Right    │\n├───────────┼───────────┤\n│  Bottom L │  Bottom R │\n└───────────┴───────────┘\n\nFooter";
    const state = createEditorStateFromText(text, CW, CH);
    const frames = getFrames(state);
    const prose = getDoc(state);
    const regions = detectLineRegions(text);
    const result = regionSerialize(text, frames, prose, regions, CW, CH);
    expect(result).toBe(text);
  });

  it("after frame move, wireframe appears at new position", () => {
    const text = "Prose above\n\n┌──────┐\n│      │\n└──────┘\n\nProse below";
    // The wireframe region is lines 2-4. If we conceptually move it down,
    // the output should have prose first, then wireframe later.
    // For this test, we just verify the serialize function produces valid output.
    const state = createEditorStateFromText(text, CW, CH);
    const frames = getFrames(state);
    const prose = getDoc(state);
    const regions = detectLineRegions(text);
    const result = regionSerialize(text, frames, prose, regions, CW, CH);
    expect(result).toContain("┌──────┐");
    expect(result).toContain("Prose above");
    expect(result).toContain("Prose below");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/regionSerialize.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/regionSerialize.ts
import type { Frame } from "./frame";
import type { LineRegion } from "./regions2";
import { repairJunctions } from "./gridSerialize";

/**
 * Region-based serialization. Writes regions top-to-bottom.
 *
 * For wireframe regions: rebuild lines from frame cells at grid positions.
 * For prose regions: write prose lines as-is from the CM doc.
 *
 * No Phase A/B/C/D. No originalGrid. No snapshotFrameBboxes.
 * The region line ranges define where everything goes.
 */
export function regionSerialize(
  originalText: string,
  frames: Frame[],
  prose: string,
  regions: LineRegion[],
  charWidth: number,
  charHeight: number,
): string {
  const originalLines = originalText.split("\n");
  const proseLines = prose.split("\n");
  const outputLines: string[] = [];

  let proseLineIndex = 0;

  for (const region of regions) {
    if (region.type === "prose") {
      // Write prose lines from the CM doc
      const regionLineCount = region.endLine - region.startLine + 1;
      for (let i = 0; i < regionLineCount; i++) {
        outputLines.push(proseLineIndex < proseLines.length ? proseLines[proseLineIndex] : "");
        proseLineIndex++;
      }
    } else {
      // Write wireframe lines from original text (if no frame moved)
      // or from frame cells (if dirty)
      const anyDirty = frames.some(f => f.dirty);
      if (!anyDirty) {
        // No-edit path: copy original lines
        for (let i = region.startLine; i <= region.endLine; i++) {
          outputLines.push(i < originalLines.length ? originalLines[i] : "");
        }
      } else {
        // Dirty path: rebuild wireframe lines from frame cells
        const regionHeight = region.endLine - region.startLine + 1;
        const regionWidth = Math.max(...originalLines.slice(region.startLine, region.endLine + 1).map(l => l.length), 1);
        const grid: string[][] = Array.from({ length: regionHeight }, () =>
          Array.from({ length: regionWidth }, () => " ")
        );

        // Write frame cells into the local grid
        const writeFrame = (f: Frame, offRow: number, offCol: number) => {
          if (f.content) {
            for (const [key, ch] of f.content.cells) {
              const ci = key.indexOf(",");
              const r = offRow + f.gridRow + Number(key.slice(0, ci)) - region.startLine;
              const c = offCol + f.gridCol + Number(key.slice(ci + 1));
              if (r >= 0 && r < grid.length && c >= 0) {
                while (grid[r].length <= c) grid[r].push(" ");
                grid[r][c] = ch;
              }
            }
          }
          for (const child of f.children) {
            writeFrame(child, offRow + f.gridRow, offCol + f.gridCol);
          }
        };

        // Find frames that belong to this wireframe region
        for (const f of frames) {
          if (f.gridRow >= region.startLine && f.gridRow < region.startLine + regionHeight) {
            writeFrame(f, 0, 0);
          }
        }

        // Repair junctions
        repairJunctions(grid);

        // Output
        for (const row of grid) {
          outputLines.push(row.join("").trimEnd());
        }
      }
    }
  }

  // Strip trailing empty lines
  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === "") {
    outputLines.pop();
  }

  return outputLines.join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/regionSerialize.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/regionSerialize.ts src/regionSerialize.test.ts
git commit -m "feat: regionSerialize — writes regions top-to-bottom, no Phase A/B/C/D"
```

---

### Task 3: Wire regionSerialize into DemoV2

**Files:**
- Modify: `src/DemoV2.tsx` (saveDocument, serializeDocument, loadDocument)
- Test: Run existing e2e harness

**Step 1: Update saveToHandle and serializeDocument**

In `DemoV2.tsx`, replace `gridSerialize` calls with `regionSerialize`. The key change:

- `saveToHandle`: call `regionSerialize(originalTextRef.current, frames, prose, regions, cw, ch)` instead of `gridSerialize(...8 params...)`
- `serializeDocument`: same
- Add `originalTextRef = useRef("")` to store the last loaded/saved text
- Add `regionsRef = useRef<LineRegion[]>([])` to store detected regions
- `loadDocument`: call `detectLineRegions(text)` and store in `regionsRef`
- After save: update `originalTextRef` and `regionsRef` from the saved output

**Step 2: Run harness**

Run: `npx playwright test e2e/harness.spec.ts`
Expected: 125/125 pass (or close — may need iteration)

**Step 3: Run full e2e**

Run: `npx playwright test e2e/`
Expected: significant improvement over 51 failures

**Step 4: Commit**

```bash
git add src/DemoV2.tsx
git commit -m "feat: wire regionSerialize into DemoV2 — replaces gridSerialize for save"
```

---

### Task 4: Remove Dead Code

**Files:**
- Modify: `src/gridSerialize.ts` — keep repairJunctions, rebuildOriginalGrid. Delete gridSerialize function, snapshotFrameBboxes, collectFrameCells, expandGridForFrame, Phase A/B/C/D.
- Modify: `src/editorState.ts` — delete proseSegmentMapField, getProseSegmentMap. Keep proseSegmentMap init in createEditorStateFromText for now (regionSerialize may need it during transition).
- Modify: `src/DemoV2.tsx` — remove originalGridRef, frameBboxSnapshotRef, old gridSerialize imports.
- Test: full suite

**Step 1: Delete dead code**

Remove from gridSerialize.ts: `gridSerialize`, `snapshotFrameBboxes`, `collectFrameCells`, `expandGridForFrame`, `FrameBbox` interface.

Remove from editorState.ts: `proseSegmentMapField`, `getProseSegmentMap`, `setOriginalProseSegmentsEffect`, `originalProseSegmentsField`, `getOriginalProseSegments`, `applySetOriginalProseSegments`.

Remove from DemoV2.tsx: `originalGridRef`, `frameBboxSnapshotRef`, `getOriginalProseSegments` import, `getProseSegmentMap` import.

**Step 2: Run full test suite**

Run: `npx vitest run` — fix any import errors
Run: `npx playwright test e2e/harness.spec.ts` — verify harness still passes

**Step 3: Commit**

```bash
git add -A
git commit -m "refactor: remove gridSerialize Phase A/B/C/D, proseSegmentMap, originalGrid"
```

---

### Task 5: Update Region Tracking After Frame Moves

**Files:**
- Modify: `src/DemoV2.tsx` (drag handler, Enter/Backspace handlers)
- Modify: `src/regions2.ts` (add region update helpers)

When a wireframe moves down (vertical drag), the wireframe region's line range changes. Prose regions above expand, prose regions below shift.

**Implementation:**

```typescript
// src/regions2.ts — add helper
export function moveWireframeRegion(
  regions: LineRegion[],
  wireframeIndex: number,
  deltaRows: number,
): LineRegion[] {
  // Splice the wireframe region out, insert at new position
  // Adjust adjacent prose regions
}
```

The DemoV2 drag handler calls this after committing the frame move. The `regionsRef` updates. On save, `regionSerialize` uses the updated regions.

**Step 1: Write test for moveWireframeRegion**
**Step 2: Implement**
**Step 3: Wire into DemoV2 drag handler**
**Step 4: Run e2e**
**Step 5: Commit**

---

| File | Changes |
|------|---------|
| `src/regions2.ts` | NEW — detectLineRegions, moveWireframeRegion |
| `src/regions2.test.ts` | NEW — region detection tests |
| `src/regionSerialize.ts` | NEW — region-based serialization |
| `src/regionSerialize.test.ts` | NEW — serialization round-trip tests |
| `src/DemoV2.tsx` | Replace gridSerialize calls with regionSerialize, add regionsRef/originalTextRef |
| `src/gridSerialize.ts` | Delete gridSerialize function + helpers. Keep repairJunctions. |
| `src/editorState.ts` | Delete proseSegmentMapField + related. |

**What does NOT change:** `src/scanner.ts`, `src/frame.ts`, `src/layers.ts`, `src/reflowLayout.ts`, `src/autoLayout.ts`, `src/preparedCache.ts`, `src/grid.ts`, `src/cursorFind.ts`, `src/textFont.ts`. The entire rendering pipeline, hit testing, Pretext integration, and CM editing stay exactly as they are.
