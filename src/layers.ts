// Layer model: each shape is a layer with a sparse cell map. Compositing
// walks layers in z-order, top wins per cell. This gives non-destructive
// editing — moving one layer never touches another layer's cells.

import type { ScanResult, RectStyle } from "./scanner";
import { extractRectStyle } from "./scanner";

export type { RectStyle } from "./scanner";

export type LayerType = "rect" | "line" | "text" | "base" | "group";

export interface Layer {
  id: string;
  type: LayerType;
  z: number;
  visible: boolean;
  bbox: { row: number; col: number; w: number; h: number };
  cells: Map<string, string>;
  /** Parent group ID. `null` or `undefined` = top-level. Groups may
   * themselves have a parentId pointing to an ancestor group. Non-group
   * layers may have a group parent. v1 forbids non-group layers from
   * being parents. Optional to simplify construction sites; absent is
   * equivalent to `null` everywhere this field is read. */
  parentId?: string | null;
  /** User-editable display name shown in the layer panel. */
  label?: string;
  /** Text layers only: the string content. */
  content?: string;
  /** Rect layers only: canonical border style used by regenerateCells. */
  style?: RectStyle;
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function parseKey(k: string): [number, number] {
  const i = k.indexOf(",");
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}

// ── Layer construction ─────────────────────────────────────
//
// Key rule: layer cells store the USER'S literal characters, copied from the
// source grid. The scanner identifies WHICH cells belong to which shape; the
// layer builder just copies those characters verbatim. Nothing is ever
// canonicalized or re-painted. This guarantees the text view never shows a
// character the user didn't type.

function getGridCell(grid: string[][], row: number, col: number): string {
  if (row < 0 || row >= grid.length) return " ";
  const r = grid[row];
  if (col < 0 || col >= r.length) return " ";
  return r[col];
}

type Bbox = { row: number; col: number; w: number; h: number };

/** Regenerate the perimeter cells of a rectangle from a style descriptor.
 * Pure function — no grid access. Interior cells are left unclaimed so text
 * and other content inside the rectangle stays in its own layers. */
export function regenerateCells(bbox: Bbox, style: RectStyle): Map<string, string> {
  const { row, col, w, h } = bbox;
  const cells = new Map<string, string>();

  if (w === 1 && h === 1) {
    cells.set(key(row, col), style.tl);
    return cells;
  }
  if (h === 1) {
    cells.set(key(row, col), style.tl);
    cells.set(key(row, col + w - 1), style.tr);
    for (let c = col + 1; c < col + w - 1; c++) {
      cells.set(key(row, c), style.h);
    }
    return cells;
  }
  if (w === 1) {
    cells.set(key(row, col), style.tl);
    cells.set(key(row + h - 1, col), style.bl);
    for (let r = row + 1; r < row + h - 1; r++) {
      cells.set(key(r, col), style.v);
    }
    return cells;
  }
  // General case: w >= 2 && h >= 2
  // Four corners
  cells.set(key(row, col), style.tl);
  cells.set(key(row, col + w - 1), style.tr);
  cells.set(key(row + h - 1, col), style.bl);
  cells.set(key(row + h - 1, col + w - 1), style.br);
  // Top edge interior
  for (let c = col + 1; c < col + w - 1; c++) {
    cells.set(key(row, c), style.h);
  }
  // Bottom edge interior
  for (let c = col + 1; c < col + w - 1; c++) {
    cells.set(key(row + h - 1, c), style.h);
  }
  // Left edge interior
  for (let r = row + 1; r < row + h - 1; r++) {
    cells.set(key(r, col), style.v);
  }
  // Right edge interior
  for (let r = row + 1; r < row + h - 1; r++) {
    cells.set(key(r, col + w - 1), style.v);
  }
  return cells;
}

/** Copy a straight line's cells from the grid. */
function lineCells(
  grid: string[][],
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): Map<string, string> {
  const cells = new Map<string, string>();
  const minR = Math.min(r1, r2);
  const maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2);
  const maxC = Math.max(c1, c2);
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      cells.set(key(r, c), getGridCell(grid, r, c));
    }
  }
  return cells;
}

/** Copy a text run's cells from the grid. */
function textCells(
  grid: string[][],
  row: number,
  col: number,
  content: string,
): Map<string, string> {
  const cells = new Map<string, string>();
  const len = [...content].length;
  for (let i = 0; i < len; i++) {
    cells.set(key(row, col + i), getGridCell(grid, row, col + i));
  }
  return cells;
}

/**
 * Build one layer per scanned shape plus (if any unclaimed cells exist) a
 * base layer at z=0 holding characters the scanner couldn't categorize.
 *
 * Z-ordering: base < rects < lines < texts. Text on top so that labels inside
 * rectangles aren't obscured.
 */
export function buildLayersFromScan(scan: ScanResult): Layer[] {
  const layers: Layer[] = [];
  let z = 0;

  // Base layer for unclaimed characters (graceful fallback)
  if (scan.unclaimedCells.size > 0) {
    let minR = Infinity,
      maxR = -Infinity,
      minC = Infinity,
      maxC = -Infinity;
    for (const k of scan.unclaimedCells.keys()) {
      const [r, c] = parseKey(k);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    layers.push({
      id: "base",
      type: "base",
      z: z++,
      visible: true,
      parentId: null,
      bbox: {
        row: minR,
        col: minC,
        w: maxC - minC + 1,
        h: maxR - minR + 1,
      },
      cells: new Map(scan.unclaimedCells),
    });
  } else {
    z++;
  }

  // Rect layers — cells are regenerated from extracted style (no longer
  // verbatim-copied). The layer records its style so resize can regenerate
  // cells at a new bbox without re-scanning.
  for (const rect of scan.rects) {
    const style = extractRectStyle(scan.grid, rect);
    const bbox = { row: rect.row, col: rect.col, w: rect.w, h: rect.h };
    layers.push({
      id: `rect_r${rect.row}c${rect.col}w${rect.w}h${rect.h}`,
      type: "rect",
      z: z++,
      visible: true,
      parentId: null,
      bbox,
      cells: regenerateCells(bbox, style),
      style,
    });
  }

  // Line layers — cells copied verbatim from grid
  for (const line of scan.lines) {
    const minR = Math.min(line.r1, line.r2);
    const maxR = Math.max(line.r1, line.r2);
    const minC = Math.min(line.c1, line.c2);
    const maxC = Math.max(line.c1, line.c2);
    layers.push({
      id: `line_r${minR}c${minC}r${maxR}c${maxC}`,
      type: "line",
      z: z++,
      visible: true,
      parentId: null,
      bbox: { row: minR, col: minC, w: maxC - minC + 1, h: maxR - minR + 1 },
      cells: lineCells(scan.grid, line.r1, line.c1, line.r2, line.c2),
    });
  }

  // Text layers — cells copied verbatim from grid
  for (const text of scan.texts) {
    layers.push({
      id: `text_r${text.row}c${text.col}_${text.content}`,
      type: "text",
      z: z++,
      visible: true,
      parentId: null,
      content: text.content,
      bbox: {
        row: text.row,
        col: text.col,
        w: [...text.content].length,
        h: 1,
      },
      cells: textCells(scan.grid, text.row, text.col, text.content),
    });
  }

  return layers;
}

// ── Compositing ────────────────────────────────────────────

/**
 * Composite layers into a single sparse cell map via DFS over the
 * parent/child tree. Roots (parentId === null or undefined) are visited
 * in ascending z; for each root, we paint its cells (non-group only) and
 * recurse into its children (also in ascending z). Hidden layers prune
 * the entire subtree — the DFS traversal enforces ancestor visibility
 * without an ancestor walk.
 *
 * Backward compat: when every layer has `parentId` null/undefined, the
 * DFS reduces to a flat sort over all layers by z, matching the legacy
 * behavior.
 */
export function compositeLayers(layers: Layer[]): Map<string, string> {
  const result = new Map<string, string>();
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
      if (!l.visible) continue; // ancestor visibility is implicit in DFS
      if (l.type === "group") {
        walk(l.id);
      } else {
        for (const [k, ch] of l.cells) result.set(k, ch);
        walk(l.id); // non-group layers may technically have children
      }
    }
  }
  walk(null);
  return result;
}

/**
 * Effective visibility: a layer is effectively visible iff it AND every
 * ancestor group is individually visible. Used by the layer panel to
 * render dimmed rows whose ancestor is hidden. NOT used by
 * `compositeLayers` — the DFS walk handles ancestor pruning directly.
 *
 * Defense-in-depth: the loop is bounded by the map size so an accidental
 * parentId cycle (e.g., from an unchecked reparent path) terminates
 * rather than infinite-looping.
 */
export function isEffectivelyVisible(
  layer: Layer,
  byId: Map<string, Layer>,
): boolean {
  let cur: Layer | undefined = layer;
  let steps = 0;
  const maxSteps = byId.size + 1;
  while (cur && steps < maxSteps) {
    if (!cur.visible) return false;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    steps++;
  }
  return true;
}

// ── Text rendering ─────────────────────────────────────────

/**
 * Convert a set of layers to ASCII text by compositing and extracting the
 * bounding grid. Trailing whitespace is trimmed per row. Empty leading rows
 * are preserved so that layer offsets are faithful.
 */
export function layerToText(layers: Layer[]): string {
  const composite = compositeLayers(layers);
  if (composite.size === 0) return "";

  let minR = Infinity,
    maxR = -Infinity,
    minC = Infinity,
    maxC = -Infinity;
  for (const k of composite.keys()) {
    const [r, c] = parseKey(k);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }

  // Normalize so the top-left is (0, 0) — this means we always emit text
  // starting from the shallowest row/col in the composite.
  const rows: string[] = [];
  for (let r = minR; r <= maxR; r++) {
    let row = "";
    for (let c = minC; c <= maxC; c++) {
      row += composite.get(key(r, c)) ?? " ";
    }
    rows.push(row.trimEnd());
  }
  return rows.join("\n");
}

// ── Layer mutations (immutable) ────────────────────────────

/**
 * Move a layer by (deltaRow, deltaCol). Returns a NEW layer; the original is
 * unchanged. Primitive that does NOT cascade to descendants — see
 * `moveLayerCascading` for the hierarchical variant.
 */
export function moveLayer(layer: Layer, deltaRow: number, deltaCol: number): Layer {
  const newCells = new Map<string, string>();
  for (const [k, ch] of layer.cells) {
    const [r, c] = parseKey(k);
    newCells.set(key(r + deltaRow, c + deltaCol), ch);
  }
  return {
    ...layer,
    bbox: {
      row: layer.bbox.row + deltaRow,
      col: layer.bbox.col + deltaCol,
      w: layer.bbox.w,
      h: layer.bbox.h,
    },
    cells: newCells,
  };
}

/**
 * Cascading move: moves the target layer and ALL of its descendants by
 * (deltaRow, deltaCol). Ancestor groups' bboxes are NOT recomputed here
 * because moving a child doesn't change which cells the ancestor
 * covers relative to that child — the ancestor should be translated by
 * the same delta. In practice the caller typically moves a whole group
 * or a whole subtree, and this helper walks down from the target.
 *
 * If the target is a group, it's translated too (via `moveLayer`).
 * If the caller moves a leaf, only the leaf moves.
 *
 * Returns a new layer list; input is not mutated.
 */
export function moveLayerCascading(
  layers: Layer[],
  id: string,
  deltaRow: number,
  deltaCol: number,
): Layer[] {
  const byParent = new Map<string, Layer[]>();
  for (const l of layers) {
    const pid = l.parentId ?? null;
    if (pid === null) continue;
    const arr = byParent.get(pid) ?? [];
    arr.push(l);
    byParent.set(pid, arr);
  }

  // BFS to collect the target and all descendants.
  const targets = new Set<string>();
  const queue: string[] = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (targets.has(cur)) continue;
    targets.add(cur);
    const kids = byParent.get(cur) ?? [];
    for (const k of kids) queue.push(k.id);
  }

  return layers.map((l) => {
    if (!targets.has(l.id)) return l;
    return moveLayer(l, deltaRow, deltaCol);
  });
}

/**
 * Delete a layer and all of its descendants. Returns a new layer list;
 * unrelated layers (including text geometrically inside a rect but with
 * no parent-child relationship) are preserved.
 */
export function deleteLayer(layers: Layer[], id: string): Layer[] {
  const byParent = new Map<string, Layer[]>();
  for (const l of layers) {
    const pid = l.parentId ?? null;
    if (pid === null) continue;
    const arr = byParent.get(pid) ?? [];
    arr.push(l);
    byParent.set(pid, arr);
  }

  const victims = new Set<string>();
  const queue: string[] = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (victims.has(cur)) continue;
    victims.add(cur);
    const kids = byParent.get(cur) ?? [];
    for (const k of kids) queue.push(k.id);
  }

  return layers.filter((l) => !victims.has(l.id));
}

/**
 * Toggle a single layer's `visible` field. Does NOT cascade: descendants
 * keep their own visible state. Use `isEffectivelyVisible` at render time
 * to check ancestor visibility. Returns a new layer list.
 */
export function toggleVisible(layers: Layer[], id: string): Layer[] {
  return layers.map((l) => {
    if (l.id !== id) return l;
    return { ...l, visible: !l.visible };
  });
}
