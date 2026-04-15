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
import { prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext";

const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const LH = Math.ceil(FONT_SIZE * 1.15);
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
  const prepared: PreparedTextWithSegments | null = proseText.length > 0
    ? prepareWithSegments(proseText, FONT, { whiteSpace: "pre-wrap" })
    : null;
  const lines = prepared
    ? reflowLayout(prepared, viewport.w, LH, framesToObstacles(frames)).lines
    : [];

  return {
    viewport,
    dpr,
    proseText,
    proseParts,
    lines,
    frames,
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
  for (const line of rs.lines) contentH = Math.max(contentH, line.y + LH);
  for (const f of frames) contentH = Math.max(contentH, f.y + f.h);
  contentH = Math.max(contentH + 40, viewport.h);

  // DPR transform
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Clear
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, viewport.w, contentH);

  // Prose text
  ctx.font = FONT;
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
    const srcLines = rs.proseText.split("\n");
    let srcRow = 0;
    for (const pl of rs.lines) {
      if (srcRow === rs.cursor.row) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(pl.x + rs.cursor.col * charWidth, pl.y, 2, LH);
        break;
      }
      const srcLineText = srcLines[srcRow] ?? "";
      if (pl.text.length >= srcLineText.length) srcRow++;
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
