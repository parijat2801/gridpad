# Layers as Source of Truth — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Drawing tools create layers directly (no scanner round-trip), eraser removes cells from existing layers, composite is memoized — scanner only runs on file import.

**Architecture:** Tools call `store.addLayer()` which appends a new Layer with `randomId()` and computed z-order. Eraser calls `store.eraseCells()` which builds a cell→owner map via DFS compositing, then clones+mutates affected layers. `compositeLayers` is wrapped in `useMemo` in KonvaCanvas. `loadFromText` (scanner path) is unchanged but only called on file open/reload.

**Tech Stack:** TypeScript, Zustand, Vitest, react-konva

---

### Task 1: Add `recomputeBbox` helper to `src/layers.ts`

**Files:**
- Modify: `src/layers.ts` (add function at end)
- Test: `src/layers.test.ts`

**Step 1: Write the failing test**

Add to `src/layers.test.ts` at the end:

```typescript
import {
  // existing imports...
  recomputeBbox,
} from "./layers";

describe("recomputeBbox", () => {
  it("computes tight bbox from cell keys", () => {
    const cells = new Map([["2,3", "x"], ["5,7", "y"], ["2,7", "z"]]);
    const bbox = recomputeBbox(cells);
    expect(bbox).toEqual({ row: 2, col: 3, w: 5, h: 4 });
  });

  it("returns zero bbox for empty map", () => {
    const bbox = recomputeBbox(new Map());
    expect(bbox).toEqual({ row: 0, col: 0, w: 0, h: 0 });
  });

  it("single cell", () => {
    const cells = new Map([["10,20", "a"]]);
    const bbox = recomputeBbox(cells);
    expect(bbox).toEqual({ row: 10, col: 20, w: 1, h: 1 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/layers.test.ts -t "recomputeBbox"`
Expected: FAIL — `recomputeBbox` is not exported from `./layers`

**Step 3: Write minimal implementation**

Add to the end of `src/layers.ts`, before the last line or after the existing exports:

```typescript
/** Recompute a tight bounding box from a cell map's keys.
 * Returns { row:0, col:0, w:0, h:0 } for empty maps. */
export function recomputeBbox(cells: Map<string, string>): Bbox {
  if (cells.size === 0) return { row: 0, col: 0, w: 0, h: 0 };
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const k of cells.keys()) {
    const [r, c] = parseKey(k);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }
  return { row: minR, col: minC, w: maxC - minC + 1, h: maxR - minR + 1 };
}
```

Note: `parseKey` and `Bbox` are already available in `src/layers.ts` (parseKey is a private function at line 37, Bbox is imported from `./types` at line 57).

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/layers.test.ts -t "recomputeBbox"`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/layers.ts src/layers.test.ts
git commit -m "feat: add recomputeBbox helper to layers.ts"
```

---

### Task 2: Add `buildLineCells` helper to `src/layers.ts`

**Files:**
- Modify: `src/layers.ts` (add function)
- Test: `src/layers.test.ts`

**Step 1: Write the failing test**

Add to `src/layers.test.ts`:

```typescript
import {
  // existing imports...
  buildLineCells,
} from "./layers";

describe("buildLineCells", () => {
  it("horizontal line left-to-right", () => {
    const result = buildLineCells(0, 0, 0, 4);
    expect(result.bbox).toEqual({ row: 0, col: 0, w: 5, h: 1 });
    expect(result.cells.size).toBe(5);
    for (let c = 0; c <= 4; c++) {
      expect(result.cells.get(`0,${c}`)).toBe("─");
    }
  });

  it("vertical line top-to-bottom", () => {
    const result = buildLineCells(0, 0, 4, 0);
    expect(result.bbox).toEqual({ row: 0, col: 0, w: 1, h: 5 });
    expect(result.cells.size).toBe(5);
    for (let r = 0; r <= 4; r++) {
      expect(result.cells.get(`${r},0`)).toBe("│");
    }
  });

  it("constrains to dominant axis — diagonal biased horizontal", () => {
    const result = buildLineCells(0, 0, 1, 5);
    // dCol (5) >= dRow (1) → horizontal at r1's row
    expect(result.bbox).toEqual({ row: 0, col: 0, w: 6, h: 1 });
    expect(result.cells.get("0,0")).toBe("─");
    expect(result.cells.get("0,5")).toBe("─");
  });

  it("constrains to dominant axis — diagonal biased vertical", () => {
    const result = buildLineCells(0, 0, 5, 1);
    // dRow (5) > dCol (1) → vertical at c1's col
    expect(result.bbox).toEqual({ row: 0, col: 0, w: 1, h: 6 });
    expect(result.cells.get("0,0")).toBe("│");
    expect(result.cells.get("5,0")).toBe("│");
  });

  it("reversed coordinates work (right-to-left)", () => {
    const result = buildLineCells(3, 7, 3, 2);
    expect(result.bbox).toEqual({ row: 3, col: 2, w: 6, h: 1 });
    expect(result.cells.size).toBe(6);
  });

  it("degenerate single-point (r1===r2, c1===c2) returns one horizontal cell", () => {
    const result = buildLineCells(3, 5, 3, 5);
    expect(result.bbox).toEqual({ row: 3, col: 5, w: 1, h: 1 });
    expect(result.cells.size).toBe(1);
    expect(result.cells.get("3,5")).toBe("─");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/layers.test.ts -t "buildLineCells"`
Expected: FAIL — `buildLineCells` is not exported

**Step 3: Write minimal implementation**

Add to `src/layers.ts`:

```typescript
/** Build cells for a straight line between two points.
 * Constrains to dominant axis (same logic as stampLine).
 * Returns { bbox, cells } with "─" or "│" characters. */
export function buildLineCells(
  r1: number, c1: number, r2: number, c2: number,
): { bbox: Bbox; cells: Map<string, string> } {
  const dRow = Math.abs(r2 - r1);
  const dCol = Math.abs(c2 - c1);
  const isH = dCol >= dRow;

  const cells = new Map<string, string>();
  let minR: number, maxR: number, minC: number, maxC: number;

  if (isH) {
    // Horizontal: lock to r1's row
    minR = r1; maxR = r1;
    minC = Math.min(c1, c2); maxC = Math.max(c1, c2);
    for (let c = minC; c <= maxC; c++) {
      cells.set(key(minR, c), "─");
    }
  } else {
    // Vertical: lock to c1's col
    minC = c1; maxC = c1;
    minR = Math.min(r1, r2); maxR = Math.max(r1, r2);
    for (let r = minR; r <= maxR; r++) {
      cells.set(key(r, minC), "│");
    }
  }

  return {
    bbox: { row: minR, col: minC, w: maxC - minC + 1, h: maxR - minR + 1 },
    cells,
  };
}
```

Note: `key` is the private helper at line 33 of `src/layers.ts`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/layers.test.ts -t "buildLineCells"`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/layers.ts src/layers.test.ts
git commit -m "feat: add buildLineCells helper to layers.ts"
```

---

### Task 3: Add `buildTextCells` helper to `src/layers.ts`

**Files:**
- Modify: `src/layers.ts` (add function)
- Test: `src/layers.test.ts`

**Step 1: Write the failing test**

Add to `src/layers.test.ts`:

```typescript
import {
  // existing imports...
  buildTextCells,
} from "./layers";

describe("buildTextCells", () => {
  it("basic ASCII string", () => {
    const result = buildTextCells(2, 5, "Hello");
    expect(result.bbox).toEqual({ row: 2, col: 5, w: 5, h: 1 });
    expect(result.content).toBe("Hello");
    expect(result.cells.size).toBe(5);
    expect(result.cells.get("2,5")).toBe("H");
    expect(result.cells.get("2,6")).toBe("e");
    expect(result.cells.get("2,9")).toBe("o");
  });

  it("filters non-printable characters", () => {
    const result = buildTextCells(0, 0, "A\x01B\x02C");
    expect(result.content).toBe("ABC");
    expect(result.cells.size).toBe(3);
    expect(result.cells.get("0,0")).toBe("A");
    expect(result.cells.get("0,1")).toBe("B");
    expect(result.cells.get("0,2")).toBe("C");
  });

  it("allows box-drawing characters", () => {
    const result = buildTextCells(0, 0, "─│┌");
    expect(result.content).toBe("─│┌");
    expect(result.cells.size).toBe(3);
  });

  it("empty after filtering returns empty cells", () => {
    const result = buildTextCells(0, 0, "\x01\x02");
    expect(result.content).toBe("");
    expect(result.cells.size).toBe(0);
    expect(result.bbox).toEqual({ row: 0, col: 0, w: 0, h: 1 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/layers.test.ts -t "buildTextCells"`
Expected: FAIL — `buildTextCells` is not exported

**Step 3: Write minimal implementation**

Add to `src/layers.ts`:

```typescript
/** Build cells for a text label at (row, col).
 * Filters to printable ASCII (32-126) and box-drawing (U+2500-U+257F).
 * Returns { bbox, cells, content } where content is the filtered string. */
export function buildTextCells(
  row: number, col: number, buffer: string,
): { bbox: Bbox; cells: Map<string, string>; content: string } {
  const filtered = [...buffer].filter((ch) => {
    const code = ch.codePointAt(0)!;
    return (code >= 32 && code <= 126) || (code >= 0x2500 && code <= 0x257f);
  });
  const content = filtered.join("");
  const cells = new Map<string, string>();
  for (let i = 0; i < filtered.length; i++) {
    cells.set(key(row, col + i), filtered[i]);
  }
  return {
    bbox: { row, col, w: filtered.length, h: 1 },
    cells,
    content,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/layers.test.ts -t "buildTextCells"`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/layers.ts src/layers.test.ts
git commit -m "feat: add buildTextCells helper to layers.ts"
```

---

### Task 4: Add `compositeLayersWithOwnership` to `src/layers.ts`

**Files:**
- Modify: `src/layers.ts` (add function)
- Test: `src/layers.test.ts`

**Step 1: Write the failing test**

Add to `src/layers.test.ts`:

```typescript
import {
  // existing imports...
  compositeLayersWithOwnership,
} from "./layers";

describe("compositeLayersWithOwnership", () => {
  it("returns empty map for no layers", () => {
    const result = compositeLayersWithOwnership([]);
    expect(result.size).toBe(0);
  });

  it("single layer — all cells owned by that layer", () => {
    const l = makeLayer("r1", {
      z: 1, cells: new Map([["0,0", "A"], ["0,1", "B"]]),
    });
    const result = compositeLayersWithOwnership([l]);
    expect(result.get("0,0")).toEqual({ char: "A", layerId: "r1" });
    expect(result.get("0,1")).toEqual({ char: "B", layerId: "r1" });
  });

  it("higher z wins ownership at overlapping cell", () => {
    const low = makeLayer("low", {
      z: 1, cells: new Map([["0,0", "A"]]),
    });
    const high = makeLayer("high", {
      z: 2, cells: new Map([["0,0", "B"]]),
    });
    const result = compositeLayersWithOwnership([low, high]);
    expect(result.get("0,0")).toEqual({ char: "B", layerId: "high" });
  });

  it("hidden layer is not included", () => {
    const l = makeLayer("r1", {
      z: 1, visible: false, cells: new Map([["0,0", "X"]]),
    });
    const result = compositeLayersWithOwnership([l]);
    expect(result.size).toBe(0);
  });

  it("hidden group hides children", () => {
    const group = makeLayer("g1", {
      type: "group", parentId: null, visible: false, z: 0, cells: new Map(),
    });
    const child = makeLayer("r1", {
      parentId: "g1", z: 0, cells: new Map([["0,0", "X"]]),
    });
    const result = compositeLayersWithOwnership([group, child]);
    expect(result.size).toBe(0);
  });

  it("child in visible group is owned correctly", () => {
    const group = makeLayer("g1", {
      type: "group", parentId: null, visible: true, z: 0, cells: new Map(),
    });
    const child = makeLayer("r1", {
      parentId: "g1", z: 0, cells: new Map([["5,5", "X"]]),
    });
    const result = compositeLayersWithOwnership([group, child]);
    expect(result.get("5,5")).toEqual({ char: "X", layerId: "r1" });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/layers.test.ts -t "compositeLayersWithOwnership"`
Expected: FAIL — `compositeLayersWithOwnership` is not exported

**Step 3: Write minimal implementation**

Add to `src/layers.ts` right after the existing `compositeLayers` function:

```typescript
/**
 * Like compositeLayers but returns ownership info: each cell maps to
 * { char, layerId } indicating which layer is visually topmost.
 * Same DFS walk as compositeLayers — one pass, O(total cells).
 */
export function compositeLayersWithOwnership(
  layers: Layer[],
): Map<string, { char: string; layerId: string }> {
  const result = new Map<string, { char: string; layerId: string }>();
  const byParent = new Map<string | null, Layer[]>();
  for (const l of layers) {
    const pid = l.parentId ?? null;
    const arr = byParent.get(pid) ?? [];
    arr.push(l);
    byParent.set(pid, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.z - b.z);

  function walk(parentId: string | null): void {
    for (const l of byParent.get(parentId) ?? []) {
      if (!l.visible) continue;
      if (l.type === "group") {
        walk(l.id);
      } else {
        for (const [k, ch] of l.cells) result.set(k, { char: ch, layerId: l.id });
        walk(l.id);
      }
    }
  }
  walk(null);
  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/layers.test.ts -t "compositeLayersWithOwnership"`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add src/layers.ts src/layers.test.ts
git commit -m "feat: add compositeLayersWithOwnership to layers.ts"
```

---

### Task 5: Export `LIGHT_RECT_STYLE` from `src/layers.ts`

**Files:**
- Modify: `src/layers.ts` (add constant)
- Test: `src/layers.test.ts`

**Step 1: Write the failing test**

Add to `src/layers.test.ts`:

```typescript
import {
  // existing imports...
  LIGHT_RECT_STYLE,
} from "./layers";

describe("LIGHT_RECT_STYLE", () => {
  it("has correct Unicode light box-drawing characters", () => {
    expect(LIGHT_RECT_STYLE).toEqual({
      tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│",
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/layers.test.ts -t "LIGHT_RECT_STYLE"`
Expected: FAIL — `LIGHT_RECT_STYLE` is not exported

**Step 3: Write minimal implementation**

Add to `src/layers.ts`, near the top (after the import of `RectStyle`):

```typescript
/** Canonical Unicode light box-drawing style. Used by drawing tools. */
export const LIGHT_RECT_STYLE: RectStyle = {
  tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│",
};
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/layers.test.ts -t "LIGHT_RECT_STYLE"`
Expected: PASS (1 test)

**Step 5: Commit**

```bash
git add src/layers.ts src/layers.test.ts
git commit -m "feat: export LIGHT_RECT_STYLE constant"
```

---

### Task 6: Add `addLayer` action to `src/store.ts`

**Files:**
- Modify: `src/store.ts`
- Test: `src/store.test.ts`

**Step 1: Write the failing test**

Add to `src/store.test.ts`:

```typescript
describe("addLayer", () => {
  beforeEach(() => useEditorStore.getState().reset());

  it("appends a new layer with generated id and z", () => {
    const cells = new Map([["0,0", "┌"], ["0,1", "─"], ["0,2", "┐"],
      ["1,0", "│"], ["1,2", "│"], ["2,0", "└"], ["2,1", "─"], ["2,2", "┘"]]);
    useEditorStore.getState().addLayer({
      type: "rect",
      bbox: { row: 0, col: 0, w: 3, h: 3 },
      cells,
      visible: true,
      style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
    });
    const { layers } = useEditorStore.getState();
    expect(layers).toHaveLength(1);
    expect(layers[0].id).toBeTruthy();
    expect(layers[0].z).toBe(1);
    expect(layers[0].parentId).toBeNull();
    expect(layers[0].type).toBe("rect");
    expect(layers[0].cells).toBe(cells);
  });

  it("z is computed among root siblings", () => {
    // Add two layers — second should get z = 2
    useEditorStore.getState().addLayer({
      type: "rect", bbox: { row: 0, col: 0, w: 3, h: 3 },
      cells: new Map(), visible: true,
    });
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 5, col: 5, w: 3, h: 1 },
      cells: new Map(), visible: true, content: "Hi",
    });
    const { layers } = useEditorStore.getState();
    expect(layers[0].z).toBe(1);
    expect(layers[1].z).toBe(2);
  });

  it("zundo captures addLayer for undo", () => {
    useEditorStore.temporal.getState().clear();
    useEditorStore.getState().addLayer({
      type: "rect", bbox: { row: 0, col: 0, w: 3, h: 3 },
      cells: new Map(), visible: true,
    });
    expect(useEditorStore.temporal.getState().pastStates.length).toBe(1);
    useEditorStore.temporal.getState().undo();
    expect(useEditorStore.getState().layers).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/store.test.ts -t "addLayer"`
Expected: FAIL — `addLayer` is not a function on the store

**Step 3: Write minimal implementation**

In `src/store.ts`:

1. Add to the `EditorState` interface (around line 46, after `setActiveTool`):
```typescript
  addLayer: (layer: Omit<Layer, "id" | "z" | "parentId">) => void;
```

2. Add the implementation inside the `temporal` callback (after `setActiveTool`):
```typescript
    addLayer: (layer: Omit<Layer, "id" | "z" | "parentId">) => {
      const layers = get().layers;
      const rootSiblings = layers.filter((l) => (l.parentId ?? null) === null);
      const maxZ = rootSiblings.reduce((m, l) => Math.max(m, l.z), 0);
      const newLayer: Layer = {
        ...layer,
        id: randomId(),
        z: maxZ + 1,
        parentId: null,
      };
      set({ layers: [...layers, newLayer] });
    },
```

Note: `randomId` is already imported from `./identity` at line 25 of `src/store.ts`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/store.test.ts -t "addLayer"`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat: add addLayer store action"
```

---

### Task 7: Add `eraseCells` action to `src/store.ts`

**Files:**
- Modify: `src/store.ts`
- Test: `src/store.test.ts`

This is the most complex action. It builds ownership, clones affected layers, deletes cells, recomputes bboxes, recomputes text content, and removes empty layers.

**Step 1: Write the failing test**

Add to `src/store.test.ts`:

```typescript
import { regenerateCells, LIGHT_RECT_STYLE, buildTextCells } from "./layers";

describe("eraseCells", () => {
  beforeEach(() => useEditorStore.getState().reset());

  it("erases a cell from the topmost owning layer", () => {
    const cells = regenerateCells({ row: 0, col: 0, w: 3, h: 3 }, LIGHT_RECT_STYLE);
    useEditorStore.getState().addLayer({
      type: "rect", bbox: { row: 0, col: 0, w: 3, h: 3 },
      cells, visible: true, style: LIGHT_RECT_STYLE,
    });
    const id = useEditorStore.getState().layers[0].id;
    // Erase top-left corner
    useEditorStore.getState().eraseCells(["0,0"]);
    const layer = useEditorStore.getState().layers.find((l: Layer) => l.id === id)!;
    expect(layer.cells.has("0,0")).toBe(false);
    // Other cells still there
    expect(layer.cells.has("0,1")).toBe(true);
  });

  it("removes layer with zero cells after erase", () => {
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 1, h: 1 },
      cells: new Map([["0,0", "A"]]), visible: true, content: "A",
    });
    expect(useEditorStore.getState().layers).toHaveLength(1);
    useEditorStore.getState().eraseCells(["0,0"]);
    expect(useEditorStore.getState().layers).toHaveLength(0);
  });

  it("recomputes bbox after partial erase", () => {
    // 5-char text layer, erase first and last
    const { cells, content, bbox } = buildTextCells(0, 0, "ABCDE");
    useEditorStore.getState().addLayer({
      type: "text", bbox, cells, visible: true, content,
    });
    useEditorStore.getState().eraseCells(["0,0", "0,4"]);
    const layer = useEditorStore.getState().layers[0];
    expect(layer.bbox).toEqual({ row: 0, col: 1, w: 3, h: 1 });
  });

  it("recomputes text content after erase", () => {
    const { cells, content, bbox } = buildTextCells(0, 0, "ABCDE");
    useEditorStore.getState().addLayer({
      type: "text", bbox, cells, visible: true, content,
    });
    // Erase "A" at col 0
    useEditorStore.getState().eraseCells(["0,0"]);
    const layer = useEditorStore.getState().layers[0];
    expect(layer.content).toBe("BCDE");
  });

  it("does not mutate original layer object (clone before mutating)", () => {
    const origCells = new Map([["0,0", "A"], ["0,1", "B"]]);
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 2, h: 1 },
      cells: origCells, visible: true, content: "AB",
    });
    const layerBefore = useEditorStore.getState().layers[0];
    const cellsBefore = layerBefore.cells;
    useEditorStore.getState().eraseCells(["0,0"]);
    // Original layer's cells Map must not have been mutated
    expect(cellsBefore.has("0,0")).toBe(true);
    expect(cellsBefore.size).toBe(2);
  });

  it("zundo captures eraseCells for undo", () => {
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 2, h: 1 },
      cells: new Map([["0,0", "A"], ["0,1", "B"]]), visible: true, content: "AB",
    });
    useEditorStore.temporal.getState().clear();
    useEditorStore.getState().eraseCells(["0,0"]);
    expect(useEditorStore.temporal.getState().pastStates.length).toBe(1);
    useEditorStore.temporal.getState().undo();
    const layer = useEditorStore.getState().layers[0];
    expect(layer.cells.has("0,0")).toBe(true);
    expect(layer.content).toBe("AB");
  });

  it("erasing top-layer cell reveals underlying layer cell", () => {
    // Two layers overlapping at cell "0,0"
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 1, h: 1 },
      cells: new Map([["0,0", "A"]]), visible: true, content: "A",
    });
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 1, h: 1 },
      cells: new Map([["0,0", "B"]]), visible: true, content: "B",
    });
    // "B" is on top (higher z), erase it
    useEditorStore.getState().eraseCells(["0,0"]);
    // The top layer ("B") should be removed (zero cells)
    // The bottom layer ("A") should still be there
    expect(useEditorStore.getState().layers).toHaveLength(1);
    expect(useEditorStore.getState().layers[0].cells.get("0,0")).toBe("A");
  });

  it("erasing cells not owned by any layer is a no-op", () => {
    useEditorStore.getState().addLayer({
      type: "text", bbox: { row: 0, col: 0, w: 1, h: 1 },
      cells: new Map([["0,0", "A"]]), visible: true, content: "A",
    });
    const before = useEditorStore.getState().layers;
    useEditorStore.getState().eraseCells(["5,5"]);
    expect(useEditorStore.getState().layers).toBe(before);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/store.test.ts -t "eraseCells"`
Expected: FAIL — `eraseCells` is not a function on the store

**Step 3: Write minimal implementation**

In `src/store.ts`:

1. Update imports at top of file — add to the `layers` import:
```typescript
import {
  deleteLayer as deleteLayerPure,
  layerToText,
  moveLayerCascading,
  regenerateCells,
  toggleVisible as toggleVisiblePure,
  compositeLayersWithOwnership,
  recomputeBbox,
  type Layer,
} from "./layers";
```

2. Add to the `EditorState` interface:
```typescript
  eraseCells: (cellKeys: string[]) => void;
```

3. Add the implementation inside the `temporal` callback:
```typescript
    eraseCells: (cellKeys: string[]) => {
      const layers = get().layers;
      const ownership = compositeLayersWithOwnership(layers);

      // Find which layers are affected
      const affectedCells = new Map<string, string[]>(); // layerId -> cellKeys to erase
      for (const ck of cellKeys) {
        const owner = ownership.get(ck);
        if (!owner) continue;
        const arr = affectedCells.get(owner.layerId) ?? [];
        arr.push(ck);
        affectedCells.set(owner.layerId, arr);
      }

      if (affectedCells.size === 0) return; // no-op

      const next = layers.map((l) => {
        const toErase = affectedCells.get(l.id);
        if (!toErase) return l;

        // Clone layer and its cells Map (preserves zundo snapshots)
        const newCells = new Map(l.cells);
        for (const ck of toErase) {
          newCells.delete(ck);
        }

        const newBbox = recomputeBbox(newCells);

        // For text layers, recompute content from remaining cells sorted by column
        let newContent = l.content;
        if (l.type === "text") {
          const entries = [...newCells.entries()].sort((a, b) => {
            const [, ca] = a[0].split(",").map(Number);
            const [, cb] = b[0].split(",").map(Number);
            return ca - cb;
          });
          newContent = entries.map(([, ch]) => ch).join("");
        }

        return {
          ...l,
          cells: newCells,
          bbox: newBbox,
          ...(l.type === "text" ? { content: newContent } : {}),
        };
      }).filter((l) => l.cells.size > 0);

      set({ layers: next });
    },
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/store.test.ts -t "eraseCells"`
Expected: PASS (7 tests)

**Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat: add eraseCells store action"
```

---

### Task 8: Wire `useToolHandlers` to use `addLayer`/`eraseCells` instead of stamp+loadFromText

**Files:**
- Modify: `src/useToolHandlers.tsx`
- Test: manual verification (this is a wiring change — the unit tests for addLayer/eraseCells already cover correctness)

**Step 1: Update imports**

In `src/useToolHandlers.tsx`, replace the stamp imports (lines 7-10):

```typescript
// Remove these:
// import { stampRect } from "./tools/stampRect";
// import { stampLine } from "./tools/stampLine";
// import { stampText } from "./tools/stampText";
// import { stampErase } from "./tools/stampErase";

// Add these:
import { regenerateCells, LIGHT_RECT_STYLE, buildLineCells, buildTextCells } from "./layers";
```

**Step 2: Replace rect tool onMouseUp**

Replace the rect tool block in `onMouseUp` (lines 177-189):

```typescript
    if (activeTool === "rect" && rectPreview) {
      if (rectPreview.w >= 2 && rectPreview.h >= 2) {
        useEditorStore.getState().addLayer({
          type: "rect",
          bbox: rectPreview,
          cells: regenerateCells(rectPreview, LIGHT_RECT_STYLE),
          style: LIGHT_RECT_STYLE,
          visible: true,
        });
      }
      setRectPreview(null);
      rectStartRef.current = null;
    }
```

**Step 3: Replace line tool onMouseUp**

Replace the line tool block in `onMouseUp` (lines 191-205):

```typescript
    if (activeTool === "line" && linePreview) {
      const { r1, c1, r2, c2 } = linePreview;
      const length = r1 === r2 ? Math.abs(c2 - c1) + 1 : Math.abs(r2 - r1) + 1;
      if (length >= 2) {
        const { bbox, cells } = buildLineCells(r1, c1, r2, c2);
        useEditorStore.getState().addLayer({
          type: "line",
          bbox,
          cells,
          visible: true,
        });
      }
      setLinePreview(null);
      lineStartRef.current = null;
    }
```

**Step 4: Replace text tool commitText**

Replace the `commitText` function body (lines 51-69):

```typescript
  function commitText() {
    if (textCursor && textBufferRef.current.length > 0) {
      const { bbox, cells, content } = buildTextCells(
        textCursor.row, textCursor.col, textBufferRef.current
      );
      if (cells.size > 0) {
        useEditorStore.getState().addLayer({
          type: "text",
          bbox,
          cells,
          visible: true,
          content,
        });
      }
    }
    textBufferRef.current = "";
    setTextCursor(null);
    if (textKeyListenerRef.current) {
      window.removeEventListener("keydown", textKeyListenerRef.current);
      textKeyListenerRef.current = null;
    }
  }
```

**Step 5: Replace eraser tool onMouseUp**

Replace the eraser tool block in `onMouseUp` (lines 207-221):

```typescript
    if (activeTool === "eraser" && erasingRef.current) {
      const cells = eraserCellsRef.current;
      if (cells.length > 0) {
        const cellKeys = cells.map((c) => `${c.row},${c.col}`);
        useEditorStore.getState().eraseCells(cellKeys);
      }
      eraserCellsRef.current = [];
      setEraserCellsForRender([]);
      erasingRef.current = false;
    }
```

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests still pass. The stamp function tests in `src/tools/` still pass (they test their own functions, which are unchanged).

**Step 7: Commit**

```bash
git add src/useToolHandlers.tsx
git commit -m "feat: wire tool handlers to addLayer/eraseCells, bypass scanner"
```

---

### Task 9: Memoize `compositeLayers` in `KonvaCanvas.tsx`

**Files:**
- Modify: `src/KonvaCanvas.tsx`

**Step 1: Replace the direct call with useMemo**

In `src/KonvaCanvas.tsx`, find line 51:
```typescript
  const composite = compositeLayers(layers);
```

Replace with:
```typescript
  const composite = useMemo(() => compositeLayers(layers), [layers]);
```

The `useMemo` import is already present at line 1 (`import { useEffect, useState, useRef } from "react"` — add `useMemo` to this import).

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add src/KonvaCanvas.tsx
git commit -m "perf: memoize compositeLayers in KonvaCanvas"
```

---

### Task 10: Delete unused stamp functions and their tests

**Files:**
- Delete: `src/tools/stampRect.ts`, `src/tools/stampRect.test.ts`
- Delete: `src/tools/stampLine.ts`, `src/tools/stampLine.test.ts`
- Delete: `src/tools/stampText.ts`, `src/tools/stampText.test.ts`
- Delete: `src/tools/stampErase.ts`, `src/tools/stampErase.test.ts`

**Step 1: Verify no remaining imports**

Run: `grep -r "stampRect\|stampLine\|stampText\|stampErase" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\." | grep -v "tools/stamp"`
Expected: No output (no remaining references outside the stamp files themselves)

**Step 2: Delete the files**

```bash
rm src/tools/stampRect.ts src/tools/stampRect.test.ts
rm src/tools/stampLine.ts src/tools/stampLine.test.ts
rm src/tools/stampText.ts src/tools/stampText.test.ts
rm src/tools/stampErase.ts src/tools/stampErase.test.ts
```

**Step 3: Check if `src/tools/` directory is now empty**

If empty, delete it: `rmdir src/tools/`
If not empty, leave it.

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (fewer tests now — the stamp tests are gone, but all layer/store tests pass).

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove unused stamp functions after layers-as-source-of-truth migration"
```

---

| Task | Description | Test file |
|------|------------|-----------|
| 1 | `recomputeBbox` helper | `src/layers.test.ts` |
| 2 | `buildLineCells` helper | `src/layers.test.ts` |
| 3 | `buildTextCells` helper | `src/layers.test.ts` |
| 4 | `compositeLayersWithOwnership` | `src/layers.test.ts` |
| 5 | `LIGHT_RECT_STYLE` constant | `src/layers.test.ts` |
| 6 | `addLayer` store action | `src/store.test.ts` |
| 7 | `eraseCells` store action | `src/store.test.ts` |
| 8 | Wire `useToolHandlers` | (existing tests cover) |
| 9 | Memoize `compositeLayers` | (no new tests needed) |
| 10 | Delete unused stamp files | (verify no regressions) |
