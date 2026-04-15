// Frame renderer: draws Frame trees onto a CanvasRenderingContext2D.

import type { Frame } from "./frame";
import { buildSparseRows } from "./sparseRows";
import { compositeLayers } from "./layers";
import type { Layer } from "./layers";
import { FONT_SIZE, FONT_FAMILY, FG_COLOR } from "./grid";

// ── renderFrame ────────────────────────────────────────────

/**
 * Recursively render a frame and its children onto ctx.
 * parentX/parentY are the accumulated pixel offsets from parent frames.
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  parentX: number,
  parentY: number,
  charWidth: number,
  charHeight: number,
): void {
  const x = parentX + frame.x;
  const y = parentY + frame.y;

  if (frame.clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, frame.w, frame.h);
    ctx.clip();
  }

  if (frame.content) {
    renderContent(ctx, frame.content.cells, x, y, charWidth, charHeight);
  }

  for (const child of frame.children) {
    renderFrame(ctx, child, x, y, charWidth, charHeight);
  }

  if (frame.clip) {
    ctx.restore();
  }
}

// ── renderContent ──────────────────────────────────────────

function renderContent(
  ctx: CanvasRenderingContext2D,
  cells: Map<string, string>,
  absX: number,
  absY: number,
  charWidth: number,
  charHeight: number,
): void {
  // Build a synthetic Layer so we can reuse compositeLayers + buildSparseRows
  const syntheticLayer: Layer = {
    id: "__render__",
    type: "rect",
    z: 0,
    visible: true,
    bbox: { row: 0, col: 0, w: 0, h: 0 },
    cells,
  };

  const composite = compositeLayers([syntheticLayer]);
  const rows = buildSparseRows(composite);

  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";

  for (const { row, startCol, text } of rows) {
    const px = absX + startCol * charWidth;
    const py = absY + row * charHeight;
    ctx.fillText(text, px, py);
  }
}

// ── renderFrameSelection ───────────────────────────────────

const HANDLE_SIZE = 10;
const HANDLE_HALF = HANDLE_SIZE / 2;
const SELECTION_COLOR = "#4a90d9";

/**
 * Draw a blue selection outline and 8 resize handles around a frame.
 * absX/absY are the frame's absolute pixel position.
 */
export function renderFrameSelection(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  absX: number,
  absY: number,
): void {
  const { w, h } = frame;

  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = 1;
  ctx.strokeRect(absX, absY, w, h);

  ctx.fillStyle = SELECTION_COLOR;

  // 8 handle positions: corners + edge midpoints
  const handles = [
    [absX, absY],                      // top-left
    [absX + w / 2, absY],              // top-center
    [absX + w, absY],                  // top-right
    [absX, absY + h / 2],              // middle-left
    [absX + w, absY + h / 2],          // middle-right
    [absX, absY + h],                  // bottom-left
    [absX + w / 2, absY + h],          // bottom-center
    [absX + w, absY + h],              // bottom-right
  ];

  for (const [hx, hy] of handles) {
    ctx.fillRect(hx - HANDLE_HALF, hy - HANDLE_HALF, HANDLE_SIZE, HANDLE_SIZE);
  }
}
