/**
 * spatialHitTest.ts — pure hit-testing functions for the spatial canvas.
 *
 * findLayerAt, findProseAt, detectResizeEdge — all take data args only,
 * return plain values. No refs, no state, no React.
 */

import type { Layer } from "./layers";
import type { LayoutRegion } from "./spatialLayout";

export interface LayerHit {
  lrIdx: number;
  layer: Layer;
}

export interface ProseCursor {
  regionIdx: number;
  /** Source line index within the region's text */
  row: number;
  /** Character offset within that source line */
  col: number;
}

export interface ResizeEdge {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

/**
 * Return the topmost wireframe layer at the given document position,
 * or null if no layer is hit.
 */
export function findLayerAt(
  laidRegions: LayoutRegion[],
  px: number,
  docY: number,
  cw: number,
  ch: number,
): LayerHit | null {
  for (let i = 0; i < laidRegions.length; i++) {
    const lr = laidRegions[i];
    if (docY < lr.y || docY >= lr.y + lr.height) continue;
    if (lr.region.type !== "wireframe" || !lr.region.layers) continue;

    const localY = docY - lr.y;
    const gr = Math.floor(localY / ch);
    const gc = Math.floor(px / cw);

    let best: Layer | null = null;
    let bestZ = -Infinity;
    for (const l of lr.region.layers) {
      if (l.type === "base" || l.type === "group" || !l.visible) continue;
      if (
        gr >= l.bbox.row && gr < l.bbox.row + l.bbox.h &&
        gc >= l.bbox.col && gc < l.bbox.col + l.bbox.w &&
        l.z > bestZ
      ) {
        best = l;
        bestZ = l.z;
      }
    }
    if (best) return { lrIdx: i, layer: best };
  }
  return null;
}

/**
 * Find the prose cursor position for a click at the given document coordinates.
 */
export function findProseAt(
  laidRegions: LayoutRegion[],
  px: number,
  docY: number,
  cw: number,
  _ch: number,
  lh: number,
  canvasWidth: number,
): ProseCursor | null {
  for (let i = 0; i < laidRegions.length; i++) {
    const lr = laidRegions[i];
    if (docY < lr.y || docY >= lr.y + lr.height) continue;
    if (lr.region.type !== "prose") continue;

    const localY = docY - lr.y;
    const visualLineIdx = Math.floor(localY / lh);
    const sourceLines = lr.region.text.split("\n");
    const maxCols = cw > 0 ? Math.floor(canvasWidth / cw) : 80;

    let visualCount = 0;
    let srcRow = 0;
    for (let si = 0; si < sourceLines.length; si++) {
      const srcLen = sourceLines[si].length;
      const wrappedLines = Math.max(1, Math.ceil(srcLen / maxCols));
      if (visualLineIdx < visualCount + wrappedLines) {
        srcRow = si;
        break;
      }
      visualCount += wrappedLines;
      srcRow = si;
    }

    const line = sourceLines[srcRow] ?? "";
    const col = Math.max(0, Math.min(line.length, Math.round(px / cw)));
    return { regionIdx: i, row: srcRow, col };
  }
  return null;
}

/**
 * Determine if the click position is near a resize edge of the given layer.
 * Returns the edge flags if within threshold, null otherwise.
 */
export function detectResizeEdge(
  layer: Layer,
  gridRow: number,
  gridCol: number,
  threshold: number,
): ResizeEdge | null {
  const { row, col, w, h } = layer.bbox;
  const top = gridRow <= row + threshold;
  const bottom = gridRow >= row + h - 1 - threshold;
  const left = gridCol <= col + threshold;
  const right = gridCol >= col + w - 1 - threshold;
  if (top || bottom || left || right) {
    return { top, bottom, left, right };
  }
  return null;
}
