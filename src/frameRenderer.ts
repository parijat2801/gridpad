// Frame renderer: draws Frame trees onto a CanvasRenderingContext2D.

import type { Frame } from "./frame";
import { buildSparseRows } from "./sparseRows";
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
    if (frame.content.type === "text" && frame.content.text !== undefined) {
      // Text frames use direct fillText with truncation support
      // parentInnerW is not available here — truncation is handled
      // when rendering children of a rect parent (see below)
      renderTextFrame(ctx, frame, x, y, charWidth, charHeight);
    } else {
      renderContent(ctx, frame.content.cells, x, y, charWidth, charHeight);
    }
  }

  // Compute parent inner width for text child truncation
  const parentInnerW = frame.content?.type === "rect" ? frame.w - 2 * charWidth : undefined;

  for (const child of frame.children) {
    if (child.content?.type === "text" && child.content.text !== undefined && parentInnerW !== undefined) {
      const childX = x + child.x;
      const childY = y + child.y;
      renderTextFrame(ctx, child, childX, childY, charWidth, charHeight, parentInnerW);
    } else {
      renderFrame(ctx, child, x, y, charWidth, charHeight);
    }
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
  const rows = buildSparseRows(cells);

  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";

  for (const { row, startCol, text } of rows) {
    const px = absX + startCol * charWidth;
    const py = absY + row * charHeight;
    ctx.fillText(text, px, py);
  }
}

// ── renderTextFrame ────────────────────────────────────────

/**
 * Render a text frame with truncation. Uses ctx.fillText directly
 * instead of cell-map rendering, enabling proportional font truncation.
 * parentInnerW is the parent rect's inner width (parent.w - 2*charWidth),
 * or undefined for standalone text frames (no truncation).
 */
export function renderTextFrame(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  absX: number,
  absY: number,
  _charWidth: number,
  _charHeight: number,
  parentInnerW?: number,
): void {
  const text = frame.content?.text;
  if (!text) return;

  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";

  if (parentInnerW === undefined || ctx.measureText(text).width <= parentInnerW) {
    // No truncation needed
    ctx.fillText(text, absX, absY);
    return;
  }

  // Truncate with ellipsis
  const ellipsis = "…";
  const ellipsisW = ctx.measureText(ellipsis).width;
  const availW = parentInnerW - ellipsisW;

  if (availW <= 0) {
    // Not even room for ellipsis — show nothing or just ellipsis
    ctx.fillText(ellipsis, absX, absY);
    return;
  }

  // Find how many characters fit
  let truncated = "";
  for (const char of text) {
    const testW = ctx.measureText(truncated + char).width;
    if (testW > availW) break;
    truncated += char;
  }

  ctx.fillText(truncated + ellipsis, absX, absY);
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
