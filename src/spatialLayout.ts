/**
 * spatialLayout.ts — pure layout logic for the spatial document canvas.
 *
 * Takes a list of regions and returns laid-out regions with y-offsets,
 * Pretext lines for prose, and sparse rows for wireframes.
 * No refs, no state, no React.
 */

import { prepareWithSegments, layoutWithLines, type LayoutLine } from "@chenglou/pretext";
import type { Region } from "./regions";
import { compositeLayers } from "./layers";
import { buildSparseRows, type SparseRow } from "./KonvaCanvas";
import { FONT_SIZE, FONT_FAMILY } from "./grid";

export const SPATIAL_FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
export const SPATIAL_LH = Math.ceil(FONT_SIZE * 1.15);

export interface LayoutRegion {
  region: Region;
  y: number;
  height: number;
  lines?: LayoutLine[];
  sparse?: SparseRow[];
}

/**
 * Lay out an array of regions into vertical document space.
 *
 * @param regions   - detected prose/wireframe regions
 * @param canvasWidth - pixel width of the canvas (for prose line wrapping)
 * @param cw        - character cell width in pixels
 * @param ch        - character cell height in pixels
 * @returns         - regions with y offsets and render data
 */
export function layoutRegions(
  regions: Region[],
  canvasWidth: number,
  cw: number,
  ch: number,
): LayoutRegion[] {
  if (!cw) return [];
  const laid: LayoutRegion[] = [];
  let y = 0;

  for (const r of regions) {
    if (r.type === "prose") {
      const p = prepareWithSegments(r.text, SPATIAL_FONT, { whiteSpace: "pre-wrap" });
      const l = layoutWithLines(p, canvasWidth, SPATIAL_LH);
      laid.push({ region: r, y, height: l.height, lines: l.lines });
      y += l.height;
    } else {
      const comp = compositeLayers(r.layers ?? []);
      const sp = buildSparseRows(comp);
      const rows = r.endRow - r.startRow + 1;
      const h = rows * ch;
      laid.push({ region: r, y, height: h, sparse: sp });
      y += h;
    }
  }

  return laid;
}
