# Scanner Fixes & Save Round-Trip Implementation Plan

> **For Claude:** Use TDD plan executor with Codex sidekick for reviews.

**Goal:** Make Gridpad handle real agent-authored wireframes (arrow-edge boxes, misaligned content) and persist wireframe edits through save/reopen.

**Architecture:** Scanner tolerance changes (H_EDGE/V_EDGE sets + fuzzy traceDown), then Frame→markdown serialization wired into DemoV2 save path.

**Tech Stack:** TypeScript, Vitest, @chenglou/pretext

---

### Task 1: Add ▼►◄▲ to scanner edge sets

**Files:**
- Modify: `src/scanner.ts:72-73` (H_EDGE and V_EDGE sets)
- Modify: `src/corpus.test.ts` (update KNOWN GAP tests, add new tests)

**Step 1: Write failing tests**

In `src/corpus.test.ts`, in the "corpus: arrow-edge boxes" describe block, change the KNOWN GAP test and add new tests:

```typescript
it("box with ▼ in top edge IS detected as rect", () => {
  const arrowTop = "┌─────▼──────────────────────┐\n│  Executor                  │\n│  Runs the task             │\n└─────┬──────────────────────┘";
  expect(scan(arrowTop).rects.length).toBeGreaterThanOrEqual(1);
});

it("box with ► in left vertical edge IS detected as rect", () => {
  const arrowLeft = "┌──────┐\n│ Box  │\n►      │\n│ End  │\n└──────┘";
  expect(scan(arrowLeft).rects.length).toBeGreaterThanOrEqual(1);
});

it("box with ▲ in bottom edge IS detected as rect", () => {
  const arrowBot = "┌────────────────┐\n│  Result        │\n└───────▲────────┘";
  expect(scan(arrowBot).rects.length).toBeGreaterThanOrEqual(1);
});

it("vertical flow diagram (section 2) detects all 3 boxes", () => {
  const flow = [
    "┌────────────────────────────┐",
    "│  API: POST /start-task     │",
    "└─────┬──────────────────────┘",
    "      │",
    "┌─────▼──────────────────────┐",
    "│  Executor                  │",
    "└─────┬──────────────────────┘",
    "      │",
    "┌─────▼──────────────────────┐",
    "│  Evaluation Pipeline       │",
    "└────────────────────────────┘",
  ].join("\n");
  expect(scan(flow).rects.length).toBeGreaterThanOrEqual(3);
});
```

**Step 2: Run tests, verify they fail**

Run: `npx vitest run src/corpus.test.ts -t "arrow-edge"`
Expected: FAIL — ▼ not in H_EDGE, ► not in V_EDGE

**Step 3: Implement**

In `src/scanner.ts` line 72-73, add the arrow chars:

```typescript
const H_EDGE = new Set(["─", "━", "═", "┬", "┴", "┼", "╤", "╧", "╪", "-", "▼", "▲"]);
const V_EDGE = new Set(["│", "║", "├", "┤", "┼", "╟", "╢", "╫", "|", "►", "◄"]);
```

**Step 4: Run tests, verify they pass**

Run: `npx vitest run src/corpus.test.ts`
Expected: All arrow-edge tests PASS

**Step 5: Remove/update KNOWN GAP tests**

The test "KNOWN GAP: ▼ in top edge breaks rect detection for 2nd/3rd boxes" should be removed or updated since it's no longer a gap.

The test in "corpus: vertical flow diagram" > "detects the first box" should be updated to expect all 3 boxes.

**Step 6: Run full suite, commit**

Run: `npx vitest run`
Expected: All tests pass

---

### Task 2: Fuzzy ±1 column tolerance in traceDown

**Files:**
- Modify: `src/scanner.ts:118-142,146-158,160-210` (traceDown, verifyBottomEdge, detectRectangles)
- Modify: `src/corpus.test.ts` (update KNOWN GAP tests, add new tests)

**Step 1: Write failing tests**

In `src/corpus.test.ts`, update the "agent misalignment" describe block:

```typescript
it("misaligned box (content 1 char wider) IS detected as rect", () => {
  const misaligned = "┌─────────┐\n│ Check A  │\n│ (Form)   │\n└─────────┘";
  expect(scan(misaligned).rects.length).toBeGreaterThanOrEqual(1);
});

it("label overflow (middle row wider) IS detected as rect", () => {
  const overflow = "┌────────────────────────────┐\n│  Runs the task to completion│\n└────────────────────────────┘";
  expect(scan(overflow).rects.length).toBeGreaterThanOrEqual(1);
});

it("box with content 2+ chars wider is NOT detected (only ±1 tolerance)", () => {
  const tooWide = "┌────┐\n│ Too wide │\n└────┘";
  expect(scan(tooWide).rects.length).toBe(0);
});

it("random pipe nearby does not cause false positive", () => {
  const noPipe = "┌──┐\n└──┘  │";
  // The │ is 2 cols away from ┐, should not be misinterpreted
  const rects = scan(noPipe).rects;
  expect(rects.length).toBe(1);
  expect(rects[0].w).toBe(4); // 4-wide box, not extended to the pipe
});
```

**Step 2: Run tests, verify they fail**

Run: `npx vitest run src/corpus.test.ts -t "agent misalignment"`
Expected: First two tests FAIL (misaligned boxes not detected)

**Step 3: Implement**

Modify `traceDown` in `src/scanner.ts` to return `{row, col}` instead of just `row`, and try col±1 when exact col fails:

```typescript
interface TraceResult { row: number; col: number; }

function traceDown(
  grid: string[][],
  startRow: number,
  col: number,
  expectCorner: (ch: string) => boolean,
): TraceResult | null {
  let currentCol = col;
  for (let r = startRow + 1; r < grid.length; r++) {
    const ch = getCell(grid, r, currentCol);
    if (expectCorner(ch)) return { row: r, col: currentCol };
    if (isVEdge(ch)) continue;
    // Fuzzy: try ±1
    if (isVEdge(getCell(grid, r, currentCol + 1)) || expectCorner(getCell(grid, r, currentCol + 1))) {
      currentCol = currentCol + 1;
      if (expectCorner(getCell(grid, r, currentCol))) return { row: r, col: currentCol };
      continue;
    }
    if (isVEdge(getCell(grid, r, currentCol - 1)) || expectCorner(getCell(grid, r, currentCol - 1))) {
      currentCol = currentCol - 1;
      if (expectCorner(getCell(grid, r, currentCol))) return { row: r, col: currentCol };
      continue;
    }
    return null;
  }
  return null;
}
```

Update `detectRectangles` to use the new return type:
- `traceDown` for BL now returns `{row, col}` — use `bl.col` for bottom edge start
- `traceDown` for BR now returns `{row, col}` — use `br.col` for bottom edge end
- `verifyBottomEdge` uses actual BL and BR columns

**Step 4: Run tests, verify they pass**

Run: `npx vitest run src/corpus.test.ts`

**Step 5: Update KNOWN GAP tests**

Remove/update the tests that asserted `rects.length === 0` for misaligned boxes.

**Step 6: Run full suite, commit**

Run: `npx vitest run`

---

### Task 3: Frame→markdown serialization + save path

**Files:**
- Create: `src/serialize.ts` (framesToMarkdown function)
- Create: `src/serialize.test.ts` (tests)
- Modify: `src/DemoV2.tsx:95-96` (saveToHandle uses new serialization)
- Modify: `src/journey.test.ts` (update round-trip tests)

**Step 1: Write failing tests**

Create `src/serialize.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { framesToMarkdown } from "./serialize";
import { scan } from "./scanner";
import { detectRegions } from "./regions";
import { framesFromRegions } from "./frame";

const CW = 9.6, CH = 18.4;

describe("framesToMarkdown", () => {
  it("round-trip: open → serialize → reopen preserves region structure", () => {
    const doc = "# Hello\n\n┌──────┐\n│ Box  │\n└──────┘\n\nAfter.";
    const regions = detectRegions(scan(doc));
    const { frames, prose } = framesFromRegions(regions, CW, CH);
    const md = framesToMarkdown(frames, prose, regions, CW, CH);
    const r2 = detectRegions(scan(md));
    expect(r2.length).toBe(regions.length);
    expect(r2.map(r => r.type)).toEqual(regions.map(r => r.type));
  });

  it("round-trip preserves box-drawing char count", () => {
    const doc = "┌──────┐\n│ Box  │\n└──────┘";
    const regions = detectRegions(scan(doc));
    const { frames, prose } = framesFromRegions(regions, CW, CH);
    const md = framesToMarkdown(frames, prose, regions, CW, CH);
    const count = (t: string) => [...t].filter(c => "┌┐└┘─│├┤┬┴┼".includes(c)).length;
    expect(count(md)).toBe(count(doc));
  });

  it("after move: serialized text has rect at new grid position", () => {
    // Open, move rect down by 1 row, serialize, verify
    const doc = "┌──┐\n│  │\n└──┘";
    const regions = detectRegions(scan(doc));
    const { frames, prose } = framesFromRegions(regions, CW, CH);
    // Move the child frame down by 1 char height
    const container = frames[0];
    const child = container.children[0];
    child.y += CH; // move down 1 grid row
    const md = framesToMarkdown(frames, prose, regions, CW, CH);
    // The ┌ should now be on row 1 instead of row 0
    const lines = md.split("\n");
    expect(lines[0].trim()).toBe(""); // row 0 is empty
    expect(lines[1]).toContain("┌");
  });
});
```

**Step 2: Run tests, verify they fail**

Run: `npx vitest run src/serialize.test.ts`
Expected: FAIL — module `./serialize` doesn't exist

**Step 3: Implement**

Create `src/serialize.ts`:

```typescript
import type { Frame } from "./frame";
import type { Region } from "./regions";

export function framesToMarkdown(
  frames: Frame[],
  prose: { startRow: number; text: string }[],
  regions: Region[],
  charWidth: number,
  charHeight: number,
): string {
  let proseIdx = 0;
  let frameIdx = 0;
  const parts: string[] = [];

  for (const region of regions) {
    if (region.type === "prose") {
      parts.push(prose[proseIdx]?.text ?? "");
      proseIdx++;
    } else {
      const frame = frames[frameIdx];
      frameIdx++;
      if (!frame) { parts.push(region.text); continue; }

      // Determine grid dimensions from region text
      const origLines = region.text.split("\n");
      const maxRows = Math.max(origLines.length,
        ...frame.children.map(c => Math.round(c.y / charHeight) + Math.round(c.h / charHeight)));
      const maxCols = Math.max(
        ...origLines.map(l => [...l].length),
        ...frame.children.map(c => Math.round(c.x / charWidth) + Math.round(c.w / charWidth)));

      // Initialize grid with spaces
      const grid: string[][] = [];
      for (let r = 0; r < maxRows; r++) {
        grid.push(new Array(maxCols).fill(" "));
      }

      // Write each child frame's cells
      for (const child of frame.children) {
        if (!child.content) continue;
        const gridRow = Math.round(child.y / charHeight);
        const gridCol = Math.round(child.x / charWidth);
        for (const [key, ch] of child.content.cells) {
          const ci = key.indexOf(",");
          const r = gridRow + Number(key.slice(0, ci));
          const c = gridCol + Number(key.slice(ci + 1));
          if (r >= 0 && r < grid.length && c >= 0 && c < grid[r].length) {
            grid[r][c] = ch;
          }
        }
      }

      parts.push(grid.map(row => row.join("").trimEnd()).join("\n"));
    }
  }

  return parts.join("\n\n");
}
```

**Step 4: Run tests, verify they pass**

**Step 5: Wire into DemoV2.tsx saveToHandle**

Change line 96 from writing `proseRef.current` to writing the full serialized markdown.

**Step 6: Update journey.test.ts round-trip tests**

**Step 7: Run full suite, commit**
