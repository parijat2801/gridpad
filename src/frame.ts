// Frame model: pixel-space tree of renderable regions.
// Each Frame is either a container (clip: true, children: Frame[]) or a
// leaf with content. All coordinates are in pixels.

import { regenerateCells, buildLineCells, buildLayersFromScan } from "./layers";
import type { RectStyle, ScanResult } from "./scanner";
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

function nextId(): string {
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
  return {
    id: nextId(),
    x: bbox.col * charWidth,
    y: bbox.row * charHeight,
    w: bbox.w * charWidth,
    h: bbox.h * charHeight,
    z: 0,
    children: [],
    content: { type: "line", cells },
    clip: true,
    dirty: false,
    gridRow: bbox.row,
    gridCol: bbox.col,
    gridW: bbox.w,
    gridH: bbox.h,
  };
}

// ── framesToObstacles ──────────────────────────────────────

export function framesToObstacles(frames: Frame[]): Obstacle[] {
  return frames.map((f) => ({ id: f.id, x: f.x, y: f.y, w: f.w, h: f.h }));
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
  return bestHit ?? frame;
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

    return { id: nextId(), x, y, w, h, z: 0, children: [], content, clip: true, dirty: false, gridRow: layer.bbox.row, gridCol: layer.bbox.col, gridW: layer.bbox.w, gridH: layer.bbox.h };
  });

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

  // After reparenting, top-level text frames are bare prose — discard them.
  // Text frames that belong inside rects have already been moved to children.
  const shaped = cleaned.filter((f) => f.content?.type !== "text");

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
    });
  }

  return result;
}
