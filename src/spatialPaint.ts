/**
 * spatialPaint.ts — pure paint logic for the spatial canvas.
 *
 * paintCanvas() takes everything it needs as arguments and draws to the
 * provided canvas context. No refs, no React, no state.
 */

import type { LayoutRegion } from "./spatialLayout";
import { SPATIAL_FONT, SPATIAL_LH } from "./spatialLayout";
import type { ProseCursor, ResizeEdge } from "./spatialHitTest";
import { FG_COLOR } from "./grid";
import { getGlyphAtlas } from "./grid";

/** State for in-place editing of a text label inside a wireframe region. */
export interface WireframeTextEdit {
  lrIdx: number;
  layerId: string;
  col: number;
}

/**
 * Paint the full spatial document onto ctx.
 *
 * @param ctx              - 2D canvas context (already sized)
 * @param laidRegions      - output from layoutRegions()
 * @param canvasW          - canvas width in pixels
 * @param canvasH          - canvas height in pixels
 * @param scrollY          - vertical scroll offset
 * @param cw               - character cell width
 * @param ch               - character cell height
 * @param selectedId       - id of the currently selected layer, or null
 * @param proseCursor      - active prose cursor, or null
 * @param wireframeTextEdit - active wireframe text edit, or null
 * @param blinkVisible     - whether the cursor blink phase is on
 */
export function paintCanvas(
  ctx: CanvasRenderingContext2D,
  laidRegions: LayoutRegion[],
  canvasW: number,
  canvasH: number,
  scrollY: number,
  cw: number,
  ch: number,
  selectedId: string | null,
  proseCursor: ProseCursor | null,
  wireframeTextEdit: WireframeTextEdit | null,
  blinkVisible: boolean,
): void {
  ctx.clearRect(0, 0, canvasW, canvasH);

  for (const lr of laidRegions) {
    const top = lr.y - scrollY;
    if (top + lr.height < 0 || top > canvasH) continue;

    if (lr.region.type === "prose" && lr.lines) {
      paintProseRegion(ctx, lr.lines, top);
    } else if (lr.sparse) {
      paintWireframeRegion(ctx, lr, top, cw, ch, selectedId);
    }
  }

  paintProseCursor(ctx, laidRegions, proseCursor, blinkVisible, scrollY, cw, canvasW);
  paintWireframeTextCursor(ctx, laidRegions, wireframeTextEdit, blinkVisible, scrollY, cw, ch);
}

function paintProseRegion(
  ctx: CanvasRenderingContext2D,
  lines: NonNullable<LayoutRegion["lines"]>,
  top: number,
): void {
  ctx.font = SPATIAL_FONT;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i].text, 0, top + i * SPATIAL_LH);
  }
}

function paintWireframeRegion(
  ctx: CanvasRenderingContext2D,
  lr: LayoutRegion,
  top: number,
  cw: number,
  ch: number,
  selectedId: string | null,
): void {
  const atlas = getGlyphAtlas();
  ctx.font = SPATIAL_FONT;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";

  for (const { row, startCol, text } of lr.sparse!) {
    if (atlas) {
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === " ") continue;
        const g = atlas.glyphs.get(c);
        if (g) {
          ctx.drawImage(
            atlas.canvas,
            g.sx, g.sy, atlas.cellWidth, atlas.cellHeight,
            (startCol + i) * cw, top + row * ch, cw, ch,
          );
        } else {
          ctx.fillText(c, (startCol + i) * cw, top + row * ch);
        }
      }
    } else {
      ctx.fillText(text, startCol * cw, top + row * ch);
    }
  }

  paintSelectionHandles(ctx, lr, top, cw, ch, selectedId);
}

function paintSelectionHandles(
  ctx: CanvasRenderingContext2D,
  lr: LayoutRegion,
  top: number,
  cw: number,
  ch: number,
  selectedId: string | null,
): void {
  if (!selectedId || !lr.region.layers) return;
  for (const l of lr.region.layers) {
    if (l.id !== selectedId) continue;
    const x = l.bbox.col * cw;
    const y = top + l.bbox.row * ch;
    const bw = l.bbox.w * cw;
    const bh = l.bbox.h * ch;
    ctx.strokeStyle = "#4a90e2";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, bw, bh);

    ctx.fillStyle = "#4a90e2";
    const hs = 6;
    const handles: [number, number][] = [
      [x, y], [x + bw / 2, y], [x + bw, y],
      [x, y + bh / 2], [x + bw, y + bh / 2],
      [x, y + bh], [x + bw / 2, y + bh], [x + bw, y + bh],
    ];
    for (const [hx, hy] of handles) {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
  }
}

function paintProseCursor(
  ctx: CanvasRenderingContext2D,
  laidRegions: LayoutRegion[],
  pc: ProseCursor | null,
  blinkVisible: boolean,
  scrollY: number,
  cw: number,
  canvasW: number,
): void {
  if (!pc || !blinkVisible) return;
  const lr = laidRegions[pc.regionIdx];
  if (!lr || lr.region.type !== "prose") return;

  const sourceLines = lr.region.text.split("\n");
  const maxCols = cw > 0 ? Math.floor(canvasW / cw) : 80;
  let visualLine = 0;
  for (let si = 0; si < pc.row && si < sourceLines.length; si++) {
    const srcLen = sourceLines[si].length;
    visualLine += Math.max(1, Math.ceil(srcLen / maxCols));
  }

  const top = lr.y - scrollY;
  const cursorX = pc.col * cw;
  const cursorY = top + visualLine * SPATIAL_LH;
  ctx.fillStyle = FG_COLOR;
  ctx.fillRect(cursorX, cursorY, 2, SPATIAL_LH);
}

function paintWireframeTextCursor(
  ctx: CanvasRenderingContext2D,
  laidRegions: LayoutRegion[],
  wte: WireframeTextEdit | null,
  blinkVisible: boolean,
  scrollY: number,
  cw: number,
  ch: number,
): void {
  if (!wte || !blinkVisible) return;
  const lr = laidRegions[wte.lrIdx];
  if (!lr || lr.region.type !== "wireframe" || !lr.region.layers) return;

  const layer = lr.region.layers.find(l => l.id === wte.layerId);
  if (!layer || layer.type !== "text") return;

  const top = lr.y - scrollY;
  const cursorX = (layer.bbox.col + wte.col) * cw;
  const cursorY = top + layer.bbox.row * ch;
  ctx.fillStyle = FG_COLOR;
  ctx.fillRect(cursorX, cursorY, 2, ch);
}

/**
 * Compute the CSS cursor style for the current gesture state.
 */
export function getCursorStyle(
  gestureMode: "drag" | "resize" | null,
  edges: ResizeEdge | null,
): string {
  if (!gestureMode) return "default";
  if (gestureMode === "drag") return "grabbing";
  if (!edges) return "default";
  if ((edges.top && edges.left) || (edges.bottom && edges.right)) return "nwse-resize";
  if ((edges.top && edges.right) || (edges.bottom && edges.left)) return "nesw-resize";
  if (edges.top || edges.bottom) return "ns-resize";
  if (edges.left || edges.right) return "ew-resize";
  return "default";
}
