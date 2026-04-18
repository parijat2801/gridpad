// Frame model: pixel-space tree of renderable regions.
// Each Frame is either a container (clip: true, children: Frame[]) or a
// leaf with content. All coordinates are in pixels.

import { regenerateCells, buildLineCells, buildLayersFromScan } from "./layers";
import type { RectStyle, ScanResult } from "./scanner";
import type { Region } from "./regions";
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

export function moveFrame(frame: Frame, delta: { dx: number; dy: number }): Frame {
  return { ...frame, x: frame.x + delta.dx, y: frame.y + delta.dy };
}

// ── resizeFrame ────────────────────────────────────────────

export function resizeFrame(
  frame: Frame,
  size: { w: number; h: number },
  charWidth: number,
  charHeight: number,
): Frame {
  const minW = 2 * charWidth;
  const minH = 2 * charHeight;
  const w = Math.max(minW, size.w);
  const h = Math.max(minH, size.h);

  let content = frame.content;
  if (content?.type === "rect" && content.style) {
    const gridW = Math.round(w / charWidth);
    const gridH = Math.round(h / charHeight);
    const bbox: Bbox = { row: 0, col: 0, w: gridW, h: gridH };
    const cells = regenerateCells(bbox, content.style);
    content = { ...content, cells };
  }

  const resized = { ...frame, w, h, content };
  if (content?.type === "rect" && frame.children.length > 0) {
    return layoutTextChildren(resized, charWidth, charHeight);
  }
  return resized;
}

// ── framesFromRegions ──────────────────────────────────────

export function framesFromRegions(
  regions: Region[],
  charWidth: number,
  charHeight: number,
  scanResult?: ScanResult,
): { frames: Frame[]; prose: { startRow: number; text: string }[] } {
  const frames: Frame[] = [];
  const prose: { startRow: number; text: string }[] = [];
  const allLayers = scanResult ? buildLayersFromScan(scanResult) : [];

  for (const region of regions) {
    if (region.type === "prose") {
      prose.push({ startRow: region.startRow, text: region.text });
      continue;
    }

    // wireframe region → container + child frames per layer
    const layers = allLayers.filter(l => {
      const layerEndRow = l.bbox.row + l.bbox.h - 1;
      return l.bbox.row >= region.startRow && layerEndRow <= region.endRow;
    });
    if (layers.length === 0) continue;

    // Compute bbox of all layers for container sizing (relative to region)
    let minRow = Infinity;
    let minCol = Infinity;
    let maxRow = 0;
    let maxCol = 0;
    for (const layer of layers) {
      if (layer.bbox.row < minRow) minRow = layer.bbox.row;
      if (layer.bbox.col < minCol) minCol = layer.bbox.col;
      const r = layer.bbox.row + layer.bbox.h;
      const c = layer.bbox.col + layer.bbox.w;
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    }

    const containerW = (maxCol - minCol) * charWidth;
    const containerH = (maxRow - minRow) * charHeight;
    const containerX = minCol * charWidth;
    const containerY = minRow * charHeight;

    const children: Frame[] = layers.map((layer) => {
      const x = (layer.bbox.col - minCol) * charWidth;
      const y = (layer.bbox.row - minRow) * charHeight;
      const w = layer.bbox.w * charWidth;
      const h = layer.bbox.h * charHeight;

      // Rebase cells to origin (0,0) — the frame's pixel position handles the offset
      const rebasedCells = new Map<string, string>();
      const baseRow = layer.bbox.row;
      const baseCol = layer.bbox.col;
      for (const [key, val] of layer.cells) {
        const ci = key.indexOf(",");
        const r = Number(key.slice(0, ci)) - baseRow;
        const c = Number(key.slice(ci + 1)) - baseCol;
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

      return { id: nextId(), x, y, w, h, z: 0, children: [], content, clip: false, dirty: false };
    });

    // Re-parent children into their enclosing rect children
    reparentChildren(children, charWidth, charHeight);

    const container: Frame = {
      id: nextId(),
      x: containerX,
      y: containerY,
      w: containerW,
      h: containerH,
      z: 0,
      children,
      content: null,
      dirty: false,
      clip: true,
    };

    frames.push(container);
  }

  return { frames, prose };
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

    return { id: nextId(), x, y, w, h, z: 0, children: [], content, clip: true, dirty: false };
  });

  reparentChildren(frames, charWidth, charHeight);

  // After reparenting, top-level text frames are bare prose — discard them.
  // Text frames that belong inside rects have already been moved to children.
  return frames.filter((f) => f.content?.type !== "text");
}
