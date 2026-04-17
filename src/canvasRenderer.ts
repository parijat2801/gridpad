// src/canvasRenderer.ts
// Pure canvas paint logic extracted from DemoV2.
// No refs, no closures, no React — just functions that take state and draw.

import type { EditorState } from "@codemirror/state";
import { getDoc, getFrames, getCursor, getProseParts } from "./editorState";
import type { Frame } from "./frame";
import { framesToObstacles } from "./frame";
import { renderFrame, renderFrameSelection } from "./frameRenderer";
import { reflowLayout, type PositionedLine } from "./reflowLayout";
import { FG_COLOR, FONT_SIZE, FONT_FAMILY } from "./grid";
import { buildPreparedCache } from "./preparedCache";
import { PROSE_FONT_RENDER, PROSE_LINE_HEIGHT } from "./textFont";

const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const BG = "#1e1e2e";

export interface Viewport {
  w: number;
  h: number;
}

export interface RenderState {
  viewport: Viewport;
  dpr: number;

  // Prose
  proseText: string;
  proseParts: { startRow: number; text: string }[];
  lines: PositionedLine[];

  // Frames
  frames: Frame[];
  selectedId: string | null;

  // Cell dimensions
  charWidth: number;
  charHeight: number;

  // Cursor
  cursor: { row: number; col: number } | null;
  cursorVisible: boolean;

  // Text edit cursor (for text frames)
  textEdit: { frameId: string; col: number } | null;

  // Drawing preview
  drawPreview: { startX: number; startY: number; curX: number; curY: number; tool: string } | null;

  // Text placement preview
  textPlacement: { x: number; y: number; chars: string } | null;
}

export function buildRenderState(
  state: EditorState,
  viewport: Viewport,
  dpr: number,
  charWidth: number,
  charHeight: number,
  opts: {
    selectedId?: string | null;
    cursorVisible?: boolean;
    textEdit?: { frameId: string; col: number } | null;
    drawPreview?: RenderState["drawPreview"];
    textPlacement?: RenderState["textPlacement"];
  } = {},
): RenderState {
  const proseText = getDoc(state);
  const frames = getFrames(state);
  const cursor = getCursor(state);
  const proseParts = getProseParts(state);

  // Reflow prose around frame obstacles
  const preparedLines = proseText.length > 0
    ? buildPreparedCache(proseText)
    : [];
  const lines = preparedLines.length > 0
    ? reflowLayout(preparedLines, viewport.w, PROSE_LINE_HEIGHT, framesToObstacles(frames)).lines
    : [];

  // Sort frames by ascending z so higher-z frames are painted on top
  const sortedFrames = [...frames].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

  return {
    viewport,
    dpr,
    proseText,
    proseParts,
    lines,
    frames: sortedFrames,
    selectedId: opts.selectedId ?? null,
    charWidth,
    charHeight,
    cursor,
    cursorVisible: opts.cursorVisible ?? true,
    textEdit: opts.textEdit ?? null,
    drawPreview: opts.drawPreview ?? null,
    textPlacement: opts.textPlacement ?? null,
  };
}

export function paintCanvas(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
): void {
  const { viewport, dpr, frames, charWidth, charHeight } = rs;

  // Compute content height
  let contentH = 100;
  for (const line of rs.lines) contentH = Math.max(contentH, line.y + PROSE_LINE_HEIGHT);
  for (const f of frames) contentH = Math.max(contentH, f.y + f.h);
  contentH = Math.max(contentH + 40, viewport.h);

  // DPR transform
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Clear
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, viewport.w, contentH);

  // Prose text
  ctx.font = PROSE_FONT_RENDER;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";
  for (const line of rs.lines) {
    ctx.fillText(line.text, line.x, line.y);
  }

  // Frames
  for (const frame of frames) {
    renderFrame(ctx, frame, 0, 0, charWidth, charHeight);
  }

  // Selection outline
  if (rs.selectedId) {
    const sel = findFrameById(frames, rs.selectedId);
    if (sel) renderFrameSelection(ctx, sel.frame, sel.absX, sel.absY);
  }

  // Prose cursor
  if (rs.cursor && rs.cursorVisible) {
    ctx.font = PROSE_FONT_RENDER;
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    // Find the visual line for the cursor
    let cursorLine: typeof rs.lines[0] | null = null;
    let lastBefore: typeof rs.lines[0] | null = null;
    for (const pl of rs.lines) {
      if (pl.sourceLine === rs.cursor.row && pl.sourceCol <= rs.cursor.col) {
        cursorLine = pl;
      }
      if (pl.sourceLine < rs.cursor.row) lastBefore = pl;
    }
    if (cursorLine) {
      const graphemeOffset = rs.cursor.col - cursorLine.sourceCol;
      const graphemes = [...segmenter.segment(cursorLine.text)];
      const prefix = graphemes.slice(0, graphemeOffset).map(g => g.segment).join("");
      const curX = cursorLine.x + ctx.measureText(prefix).width;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(curX, cursorLine.y, 2, PROSE_LINE_HEIGHT);
    } else if (lastBefore) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, lastBefore.y + PROSE_LINE_HEIGHT * (rs.cursor.row - lastBefore.sourceLine), 2, PROSE_LINE_HEIGHT);
    }
  }

  // Text frame cursor
  if (rs.textEdit && rs.cursorVisible) {
    const found = findFrameById(frames, rs.textEdit.frameId);
    if (found && found.frame.content?.type === "text") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(found.absX + rs.textEdit.col * charWidth, found.absY, 2, charHeight);
    }
  }

  // Drawing preview
  if (rs.drawPreview) {
    const p = rs.drawPreview;
    const x1 = Math.min(p.startX, p.curX), y1 = Math.min(p.startY, p.curY);
    const x2 = Math.max(p.startX, p.curX), y2 = Math.max(p.startY, p.curY);
    ctx.save();
    ctx.strokeStyle = "#4a90e2";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    if (p.tool === "rect") {
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    } else {
      ctx.beginPath();
      ctx.moveTo(p.startX, p.startY);
      ctx.lineTo(p.curX, p.curY);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Text placement preview
  if (rs.textPlacement) {
    const tp = rs.textPlacement;
    ctx.save();
    ctx.strokeStyle = "#4a90e2";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(tp.x, tp.y, Math.max(1, [...tp.chars].length) * charWidth, charHeight);
    ctx.setLineDash([]);
    if (tp.chars.length > 0) {
      ctx.fillStyle = FG_COLOR;
      ctx.font = FONT;
      ctx.textBaseline = "top";
      ctx.fillText(tp.chars, tp.x, tp.y);
    }
    ctx.restore();
  }
}

/**
 * Map a click position (px, py) in content-space coordinates to a source-text
 * cursor {row, col}. Uses the reflowed lines in RenderState to find the
 * closest visual line, then maps back to the source text row.
 */
export function clickToCursor(
  rs: RenderState,
  px: number,
  py: number,
  ctx?: CanvasRenderingContext2D,
): { row: number; col: number } | null {
  if (rs.lines.length === 0) return null;

  // Find the closest visual line by vertical distance
  let best = rs.lines[0];
  let bestDist = Math.abs(best.y + PROSE_LINE_HEIGHT / 2 - py);
  for (let i = 1; i < rs.lines.length; i++) {
    const dist = Math.abs(rs.lines[i].y + PROSE_LINE_HEIGHT / 2 - py);
    if (dist < bestDist) { bestDist = dist; best = rs.lines[i]; }
  }

  // sourceLine and sourceCol are set by reflowLayout — use them directly
  const srcRow = best.sourceLine;
  const srcLines = rs.proseText.split("\n");

  // Column from horizontal offset using proportional font measurement if ctx available
  let col: number;
  if (ctx) {
    ctx.font = PROSE_FONT_RENDER;
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const graphemes = [...segmenter.segment(best.text)];
    const relX = px - best.x;
    col = graphemes.length; // default: past end of line
    for (let g = 0; g < graphemes.length; g++) {
      const prefix = graphemes.slice(0, g + 1).map(s => s.segment).join("");
      const w = ctx.measureText(prefix).width;
      if (w > relX) {
        const prevW = g > 0 ? ctx.measureText(graphemes.slice(0, g).map(s => s.segment).join("")).width : 0;
        col = (relX - prevW) < (w - relX) ? g : g + 1;
        break;
      }
    }
    col = best.sourceCol + Math.min(col, graphemes.length);
  } else {
    // Fallback: fixed-width approximation using charWidth
    col = Math.max(0, Math.min(
      Math.round((px - best.x) / rs.charWidth),
      (srcLines[srcRow] ?? "").length,
    ));
  }

  // Clamp to source line length
  col = Math.min(col, (srcLines[srcRow] ?? "").length);

  return { row: srcRow, col };
}

function findFrameById(
  frames: Frame[],
  id: string,
  px = 0,
  py = 0,
): { frame: Frame; absX: number; absY: number } | null {
  for (const f of frames) {
    const ax = px + f.x, ay = py + f.y;
    if (f.id === id) return { frame: f, absX: ax, absY: ay };
    const child = findFrameById(f.children, id, ax, ay);
    if (child) return child;
  }
  return null;
}
