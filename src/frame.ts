// Frame model: pixel-space tree of renderable regions.
// Each Frame is either a container (clip: true, children: Frame[]) or a
// leaf with content. All coordinates are in pixels.

import { regenerateCells, buildLineCells, buildLayersFromScan } from "./layers";
import type { RectStyle, ScanResult } from "./scanner";
import { isTL, isTR, isBL, isBR, isHEdge, isVEdge } from "./scanner";
import type { Bbox } from "./types";
import { layoutTextChildren, reparentChildren } from "./autoLayout";
import type { AlignAnchor, VAlignAnchor } from "./autoLayout";
export type { AlignAnchor, VAlignAnchor } from "./autoLayout";

// ── Types ──────────────────────────────────────────────────

export interface FrameContent {
  type: "rect" | "line" | "text";
  cells: Map<string, string>;
  /** Present for rect frames */
  style?: RectStyle;
  /** Present for text frames */
  text?: string;
  /** Horizontal constraint for text inside a parent rect */
  hAlign?: AlignAnchor;
  /** Vertical constraint for text inside a parent rect */
  vAlign?: VAlignAnchor;
}

export interface Frame {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Direct child frames in tree order. NOTE: a frame with non-null
   * `content` can still have children — e.g. a rect with a text label
   * has the label as a child. "Has content" does NOT imply "tree-leaf".
   *
   * When walking the tree, distinguish:
   * - tree-leaf:    `f.children.length === 0`
   * - band:         `f.isBand`
   * - wireframe:    `f.content === null && !f.isBand`
   * - shape-leaf:   `f.content !== null` (may still have text-label children)
   *
   * DFS-walking "until content !== null" will descend into text labels
   * and treat them as siblings of their parent rect. Filter by
   * `content?.type` (e.g. only "rect") to pick true sibling shapes. */
  children: Frame[];
  content: FrameContent | null;
  clip: boolean;
  dirty: boolean;
  /** Grid coordinates — canonical position for serialization.
   * Pixel x/y/w/h are derived as gridRow * ch, gridCol * cw, etc. */
  gridRow: number;
  gridCol: number;
  gridW: number;
  gridH: number;
  /** CM doc character offset — start of first claimed line. 0 = not yet placed. */
  docOffset: number;
  /** Number of CM doc lines this frame claims. 0 = not yet placed. */
  lineCount: number;
  /** True if this frame is a synthetic band container produced by
   * wrapAsBand. Bands are not selectable on their own — clicking
   * empty band space returns no hit. */
  isBand?: boolean;
}

export interface Obstacle {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── ID generation ──────────────────────────────────────────

let _counter = 0;

export function nextId(): string {
  return `frame-${++_counter}-${Date.now()}`;
}

// ── createFrame ────────────────────────────────────────────

export function createFrame(params: {
  x: number;
  y: number;
  w: number;
  h: number;
}): Frame {
  return {
    id: nextId(),
    x: params.x,
    y: params.y,
    w: params.w,
    h: params.h,
    z: 0,
    children: [],
    content: null,
    clip: true,
    dirty: false,
    gridRow: 0,
    gridCol: 0,
    gridW: 0,
    gridH: 0,
    docOffset: 0,
    lineCount: 0,
  };
}

// ── createRectFrame ────────────────────────────────────────

export function createRectFrame(params: {
  gridW: number;
  gridH: number;
  style: RectStyle;
  charWidth: number;
  charHeight: number;
}): Frame {
  const { gridW, gridH, style, charWidth, charHeight } = params;
  const bbox: Bbox = { row: 0, col: 0, w: gridW, h: gridH };
  const cells = regenerateCells(bbox, style);
  return {
    id: nextId(),
    x: 0,
    y: 0,
    w: gridW * charWidth,
    h: gridH * charHeight,
    z: 0,
    children: [],
    content: { type: "rect", cells, style },
    clip: true,
    dirty: false,
    gridRow: 0, gridCol: 0, // caller sets position
    gridW,
    gridH,
    docOffset: 0,
    lineCount: 0,
  };
}

// ── createTextFrame ────────────────────────────────────────

export function createTextFrame(params: {
  text: string;
  row: number;
  col: number;
  charWidth: number;
  charHeight: number;
}): Frame {
  const { text, row, col, charWidth, charHeight } = params;
  const codepoints = [...text];
  const cells = new Map<string, string>();
  for (let i = 0; i < codepoints.length; i++) {
    cells.set(`0,${i}`, codepoints[i]);
  }
  return {
    id: nextId(),
    x: col * charWidth,
    y: row * charHeight,
    w: codepoints.length * charWidth,
    h: charHeight,
    z: 0,
    children: [],
    content: { type: "text", cells, text },
    clip: true,
    dirty: false,
    gridRow: row,
    gridCol: col,
    gridW: codepoints.length,
    gridH: 1,
    docOffset: 0,
    lineCount: 0,
  };
}

// ── createLineFrame ────────────────────────────────────────

export function createLineFrame(params: {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  charWidth: number;
  charHeight: number;
}): Frame {
  const { r1, c1, r2, c2, charWidth, charHeight } = params;
  const { bbox, cells } = buildLineCells(r1, c1, r2, c2);
  // Rebase cells to local-to-frame coords (origin 0,0). buildLineCells keys
  // them in absolute (input) coords; the serializer's renderFrameRow expects
  // localRow indexing. framesFromScan does the same rebase at frame.ts ~340.
  const localCells = new Map<string, string>();
  for (const [k, v] of cells) {
    const ci = k.indexOf(",");
    const r = Number(k.slice(0, ci)) - bbox.row;
    const c = Number(k.slice(ci + 1)) - bbox.col;
    localCells.set(`${r},${c}`, v);
  }
  return {
    id: nextId(),
    x: bbox.col * charWidth,
    y: bbox.row * charHeight,
    w: bbox.w * charWidth,
    h: bbox.h * charHeight,
    z: 0,
    children: [],
    content: { type: "line", cells: localCells },
    clip: true,
    dirty: false,
    gridRow: bbox.row,
    gridCol: bbox.col,
    gridW: bbox.w,
    gridH: bbox.h,
    docOffset: 0,
    lineCount: 0,
  };
}

// ── framesToObstacles ──────────────────────────────────────

export function framesToObstacles(frames: Frame[]): Obstacle[] {
  return frames.map((f) => ({ id: f.id, x: f.x, y: f.y, w: f.w, h: f.h }));
}

// ── recomputePixelFields ───────────────────────────────────

/**
 * Recompute every frame's pixel x/y/w/h from its canonical grid coords.
 * Use this when cell size (cw / ch) changes — the grid coords are still the
 * source of truth, but the cached pixel fields are now stale.
 *
 * Grid coords on band children are stored BAND-RELATIVE (see wrapAsBand),
 * so the same `grid * cellSize` formula applies at every tree depth — there
 * is no parent-offset accumulation to do here.
 *
 * Top-level frame y values are intentionally NOT touched: doLayout owns
 * the absolute y of every top-level frame (it stitches prose blocks and
 * frame rows together via lineTop). We only correct relative dimensions
 * here; doLayout will overwrite top-level y on its next call.
 */
export function recomputePixelFields(frames: Frame[], cw: number, ch: number): void {
  for (const f of frames) {
    f.x = f.gridCol * cw;
    f.w = f.gridW * cw;
    f.h = f.gridH * ch;
    // f.y left alone for top-level frames — doLayout sets it. For child
    // frames it'll be overwritten by the recursive pass below using the
    // child's band-relative gridRow.
    if (f.children.length > 0) recomputeChildren(f.children, cw, ch);
  }
}

function recomputeChildren(children: Frame[], cw: number, ch: number): void {
  for (const c of children) {
    c.x = c.gridCol * cw;
    c.y = c.gridRow * ch;
    c.w = c.gridW * cw;
    c.h = c.gridH * ch;
    if (c.children.length > 0) recomputeChildren(c.children, cw, ch);
  }
}

// ── hitTestFrames ──────────────────────────────────────────

function hitTestOne(frame: Frame, px: number, py: number): Frame | null {
  if (px < frame.x || px >= frame.x + frame.w) return null;
  if (py < frame.y || py >= frame.y + frame.h) return null;
  // Try children in reverse order (last = highest z = topmost)
  // Pick the smallest matching child (most specific hit)
  const relX = px - frame.x;
  const relY = py - frame.y;
  let bestHit: Frame | null = null;
  let bestArea = Infinity;
  for (let i = frame.children.length - 1; i >= 0; i--) {
    const hit = hitTestOne(frame.children[i], relX, relY);
    if (hit) {
      const area = hit.w * hit.h;
      if (area < bestArea) {
        bestHit = hit;
        bestArea = area;
      }
    }
  }
  if (bestHit) return bestHit;
  // Synthetic bands (isBand=true) are not selectable on their own —
  // empty band space returns null, not the band. Children still hit
  // via the recursive case above.
  if (frame.isBand) return null;
  return frame;
}

export function hitTestFrames(frames: Frame[], px: number, py: number): Frame | null {
  const sorted = [...frames].sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
  for (const frame of sorted) {
    const hit = hitTestOne(frame, px, py);
    if (hit) return hit;
  }
  return null;
}

// ── moveFrame ──────────────────────────────────────────────

export function moveFrame(
  frame: Frame,
  delta: { dCol: number; dRow: number; charWidth: number; charHeight: number },
): Frame {
  const gridRow = frame.gridRow + delta.dRow;
  const gridCol = frame.gridCol + delta.dCol;
  return {
    ...frame,
    gridRow,
    gridCol,
    x: gridCol * delta.charWidth,
    y: gridRow * delta.charHeight,
  };
}

/** Snap a pixel value to the nearest grid boundary. */
export function snapToGrid(px: number, cellSize: number): number {
  return Math.round(px / cellSize) * cellSize;
}

// ── resizeFrame ────────────────────────────────────────────

export function resizeFrame(
  frame: Frame,
  size: { gridW: number; gridH: number },
  charWidth: number,
  charHeight: number,
): Frame {
  // Minimum 3 rows/cols if frame has text children (need 1 interior row/col)
  const hasTextChildren = frame.children.some(c => c.content?.type === "text");
  const minDim = hasTextChildren ? 3 : 2;
  const gridW = Math.max(minDim, size.gridW);
  const gridH = Math.max(minDim, size.gridH);
  const w = gridW * charWidth;
  const h = gridH * charHeight;

  let content = frame.content;
  if (content?.type === "rect" && content.style) {
    const bbox: Bbox = { row: 0, col: 0, w: gridW, h: gridH };
    const cells = regenerateCells(bbox, content.style);
    content = { ...content, cells };
  }

  // Clamp children to fit within new bounds
  const clampedChildren = frame.children.map(child => {
    let cr = child.gridRow;
    let cc = child.gridCol;
    let cw2 = child.gridW;
    let ch2 = child.gridH;
    // Clamp position to stay within parent
    if (cr + ch2 > gridH) {
      cr = Math.max(0, gridH - ch2);
      if (cr + ch2 > gridH) ch2 = gridH - cr;
    }
    if (cc + cw2 > gridW) {
      cc = Math.max(0, gridW - cw2);
      if (cc + cw2 > gridW) cw2 = gridW - cc;
    }
    if (cr === child.gridRow && cc === child.gridCol && cw2 === child.gridW && ch2 === child.gridH) {
      return child;
    }
    // Regenerate cells if rect was resized
    let newContent = child.content;
    if (newContent?.type === "rect" && newContent.style && (cw2 !== child.gridW || ch2 !== child.gridH)) {
      const bbox: Bbox = { row: 0, col: 0, w: cw2, h: ch2 };
      newContent = { ...newContent, cells: regenerateCells(bbox, newContent.style) };
    }
    return {
      ...child,
      gridRow: cr, gridCol: cc, gridW: cw2, gridH: ch2,
      x: cc * charWidth, y: cr * charHeight,
      w: cw2 * charWidth, h: ch2 * charHeight,
      content: newContent,
      dirty: true,
    };
  });

  const resized = { ...frame, w, h, gridW, gridH, content, children: clampedChildren };
  if (content?.type === "rect" && resized.children.length > 0) {
    return layoutTextChildren(resized, charWidth, charHeight);
  }
  return resized;
}

// ── framesFromScan ─────────────────────────────────────────

/** Rebuild a rect's cell map so its borders align exactly with the (0,0)…
 * (h-1, w-1) bbox. Literal glyphs survive at border positions where they
 * play the right role (edge chars and junctions); misplaced or missing
 * border cells are regenerated from the style; out-of-bbox cells drop.
 * Interior cells pass through untouched. */
export function squareRectCells(
  cells: Map<string, string>,
  w: number,
  h: number,
  style: RectStyle,
): Map<string, string> {
  if (w < 2 || h < 2) return cells;
  const out = new Map<string, string>();
  // Interior cells (and border cells with role-compatible glyphs) first.
  for (const [k, ch] of cells) {
    const ci = k.indexOf(",");
    const r = Number(k.slice(0, ci));
    const c = Number(k.slice(ci + 1));
    if (r < 0 || r >= h || c < 0 || c >= w) continue; // off-bbox (drift)
    const isBorder = r === 0 || r === h - 1 || c === 0 || c === w - 1;
    if (!isBorder) { out.set(k, ch); continue; }
    const ok =
      (r === 0 && c === 0 && isTL(ch)) ||
      (r === 0 && c === w - 1 && isTR(ch)) ||
      (r === h - 1 && c === 0 && isBL(ch)) ||
      (r === h - 1 && c === w - 1 && isBR(ch)) ||
      ((r === 0 || r === h - 1) && c > 0 && c < w - 1 && isHEdge(ch)) ||
      ((c === 0 || c === w - 1) && r > 0 && r < h - 1 && isVEdge(ch));
    if (ok) out.set(k, ch);
  }
  // Fill any border position still empty with the canonical style glyph.
  const canonical = regenerateCells({ row: 0, col: 0, w, h }, style);
  for (const [k, ch] of canonical) {
    if (!out.has(k)) out.set(k, ch);
  }
  return out;
}

export function framesFromScan(
  scanResult: ScanResult,
  charWidth: number,
  charHeight: number,
): Frame[] {
  const allLayers = buildLayersFromScan(scanResult);
  const layers = allLayers.filter((l) => l.type !== "base");

  const frames: Frame[] = layers.map((layer) => {
    const x = layer.bbox.col * charWidth;
    const y = layer.bbox.row * charHeight;
    const w = layer.bbox.w * charWidth;
    const h = layer.bbox.h * charHeight;

    // Rebase cells to origin (0,0) — the frame's pixel position handles the offset
    const rebasedCells = new Map<string, string>();
    const baseRow = layer.bbox.row;
    const baseCol = layer.bbox.col;
    for (const [k, val] of layer.cells) {
      const ci = k.indexOf(",");
      const r = Number(k.slice(0, ci)) - baseRow;
      const c = Number(k.slice(ci + 1)) - baseCol;
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

    return { id: nextId(), x, y, w, h, z: 0, children: [], content, clip: true, dirty: false, gridRow: layer.bbox.row, gridCol: layer.bbox.col, gridW: layer.bbox.w, gridH: layer.bbox.h, docOffset: 0, lineCount: 0 };
  });

  // Square every rect's border cells to its bbox. The corner-seed tracer
  // tolerates ±1 drift (hand-authored art where a border row is shifted a
  // column), and the literal claimed cells then sit misaligned with the
  // frame's grid geometry: corners land off-bbox, edge cells go missing, and
  // every save renders a skewed box that degrades further on reload. Border
  // positions keep their literal glyph when it plays the right role there
  // (junctions like ┬ ┴ ├ ┤ ┼ survive); anything else is regenerated from
  // the style. Interior cells (labels, separator rows) stay untouched.
  for (const f of frames) {
    if (f.content?.type === "rect" && f.content.style) {
      f.content = { ...f.content, cells: squareRectCells(f.content.cells, f.gridW, f.gridH, f.content.style) };
    }
  }

  reparentChildren(frames, charWidth, charHeight);

  // Filter out text frames that are just wire/border characters.
  // The scanner's detectTexts sometimes claims border chars (│, ─, etc.)
  // as text labels. Remove them at every level of the tree.
  const WIRE_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼═║╔╗╚╝╠╣╦╩╬"]);
  const isWireText = (f: Frame): boolean =>
    f.content?.type === "text" &&
    typeof f.content.text === "string" &&
    [...f.content.text].every(ch => WIRE_CHARS.has(ch) || ch === " ");
  const filterWireText = (fs: Frame[]): Frame[] =>
    fs.filter(f => !isWireText(f)).map(f =>
      f.children.length > 0 ? { ...f, children: filterWireText(f.children) } : f
    );
  const cleaned = filterWireText(frames);

  // Absorb wall-stray line children — hand-authored raggedness where interior
  // rows run one column past the box corner (a │ flush OUTSIDE the wall) or
  // stop one column short of it (a │ flush INSIDE the wall, leaving the
  // corner-traced wall column blank on those rows). Single-row strays already
  // normalize away via the wire-text filter above; multi-row strays become
  // 1-col line children that render a doubled wall (`…││`) on every save.
  // Tight match so flowchart connectors survive: vertical 1-col line,
  // hugging the parent rect's left or right wall from either side, spanning
  // interior rows only.
  const isWallStray = (parent: Frame, c: Frame): boolean =>
    c.content?.type === "line" && c.gridW === 1
    && (c.gridCol === parent.gridW || c.gridCol === -1
      || c.gridCol === parent.gridW - 2 || c.gridCol === 1)
    && c.gridRow >= 1 && c.gridRow + c.gridH <= parent.gridH - 1;
  const absorbWallStrays = (fs: Frame[]): Frame[] =>
    fs.map(f => ({
      ...f,
      children: absorbWallStrays(
        f.content?.type === "rect" ? f.children.filter(c => !isWallStray(f, c)) : f.children,
      ),
    }));
  const absorbed = absorbWallStrays(cleaned);

  // After reparenting, top-level text frames are bare prose — discard them.
  // Text frames that belong inside rects have already been moved to children.
  const shaped = absorbed.filter((f) => f.content?.type !== "text");

  // Filter out orphan line frames — single-cell lines (│ or ─) that aren't
  // adjacent to any rect. These come from misaligned ASCII art where a wire
  // char extends past the wireframe boundary. Including them inflates container
  // bounds and causes ghost chars after moves.
  const rects = shaped.filter(f => f.content?.type === "rect");
  const isOrphanLine = (f: Frame): boolean => {
    if (f.content?.type !== "line") return false;
    if (f.gridW > 1 && f.gridH > 1) return false; // multi-cell line, keep
    // Check if any rect is adjacent (shares a row/col boundary)
    for (const r of rects) {
      const touchH = f.gridRow < r.gridRow + r.gridH + 1 && f.gridRow + f.gridH > r.gridRow - 1;
      const touchV = f.gridCol < r.gridCol + r.gridW + 1 && f.gridCol + f.gridW > r.gridCol - 1;
      if (touchH && touchV) return false; // adjacent to a rect — keep
    }
    return true; // isolated — orphan
  };
  const noOrphans = shaped.filter(f => !isOrphanLine(f));

  // Group overlapping/adjacent top-level frames into container frames.
  // This restores the "click container → drag whole wireframe" UX that
  // framesFromRegions provided via region-based grouping.
  return groupIntoContainers(noOrphans, charWidth, charHeight);
}

/**
 * Group overlapping/adjacent top-level frames into container frames.
 * Two frames belong to the same wireframe if their bounding boxes overlap
 * or are within 1 cell of each other vertically.
 */
function groupIntoContainers(
  frames: Frame[],
  _charWidth: number,
  charHeight: number,
): Frame[] {
  if (frames.length <= 1) return frames;

  // Union-find to group overlapping frames
  const parent = frames.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Merge frames whose row ranges overlap or are adjacent (within 1 row gap).
  // This groups all shapes that are part of the same wireframe, including
  // side-by-side boxes that share the same row range.
  const margin = charHeight; // 1 row margin
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i], b = frames[j];
      const aTop = a.y, aBot = a.y + a.h;
      const bTop = b.y, bBot = b.y + b.h;
      // Vertical overlap or adjacency — same wireframe if they share rows
      if (aTop <= bBot + margin && bTop <= aBot + margin) union(i, j);
    }
  }

  // Collect groups
  const groups = new Map<number, number[]>();
  for (let i = 0; i < frames.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const result: Frame[] = [];
  for (const indices of groups.values()) {
    if (indices.length === 1) {
      // Single frame — no container needed
      result.push(frames[indices[0]]);
      continue;
    }

    // Multiple frames — wrap in a container
    const children = indices.map(i => frames[i]);
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    let minRow = Infinity, minCol = Infinity, maxRow = 0, maxCol = 0;
    for (const c of children) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x + c.w > maxX) maxX = c.x + c.w;
      if (c.y + c.h > maxY) maxY = c.y + c.h;
      if (c.gridRow < minRow) minRow = c.gridRow;
      if (c.gridCol < minCol) minCol = c.gridCol;
      if (c.gridRow + c.gridH > maxRow) maxRow = c.gridRow + c.gridH;
      if (c.gridCol + c.gridW > maxCol) maxCol = c.gridCol + c.gridW;
    }

    // Rebase children to container-relative coordinates
    const rebasedChildren = children.map(c => ({
      ...c,
      x: c.x - minX,
      y: c.y - minY,
      gridRow: c.gridRow - minRow,
      gridCol: c.gridCol - minCol,
    }));

    result.push({
      id: nextId(),
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      z: 0,
      children: rebasedChildren,
      content: null,
      clip: true,
      dirty: false,
      gridRow: minRow,
      gridCol: minCol,
      gridW: maxCol - minCol,
      gridH: maxRow - minRow,
      docOffset: 0,
      lineCount: 0,
    });
  }

  return result;
}

/**
 * Wrap N child frames into a synthetic full-width band container.
 *
 * The band owns the doc-line claim (lineCount, docOffset) and is the new
 * top-level frame. Children are rebased to band-relative grid rows with
 * lineCount=0 and docOffset=0; their gridCol stays absolute (the band
 * spans col 0 → docWidthCols, full doc width).
 *
 * The band's docOffset is inherited from the child with the smallest
 * gridRow (the topmost claim). gridH = union of children's row ranges.
 *
 * Children must be in ABSOLUTE grid coordinates on entry (i.e., they
 * were top-level before this call). Mixing already-band-relative and
 * absolute children is undefined behavior — the caller must ensure
 * inputs are consistent.
 */
export function wrapAsBand(
  children: Frame[],
  charWidth: number,
  charHeight: number,
  docWidthCols: number,
): Frame {
  if (children.length === 0) {
    throw new Error("wrapAsBand: cannot wrap empty children");
  }
  let minRow = Infinity, maxRow = 0;
  let docOffset = 0;
  for (const c of children) {
    if (c.gridRow < minRow) {
      minRow = c.gridRow;
      docOffset = c.docOffset;
    }
    if (c.gridRow + c.gridH > maxRow) maxRow = c.gridRow + c.gridH;
  }
  const gridH = maxRow - minRow;
  const rebasedChildren: Frame[] = children.map((c) => ({
    ...c,
    gridRow: c.gridRow - minRow,
    x: c.gridCol * charWidth,
    y: (c.gridRow - minRow) * charHeight,
    docOffset: 0,
    lineCount: 0,
  }));
  return {
    id: nextId(),
    x: 0,
    y: minRow * charHeight,
    w: docWidthCols * charWidth,
    h: gridH * charHeight,
    z: 0,
    children: rebasedChildren,
    content: null,
    clip: true,
    dirty: true,
    isBand: true,
    gridRow: minRow,
    gridCol: 0,
    gridW: docWidthCols,
    gridH,
    docOffset,
    lineCount: gridH,
  };
}
