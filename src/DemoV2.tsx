/**
 * DemoV2 — Frame-based spatial canvas. Thin shell using frame.ts + frameRenderer.ts.
 */
import { useEffect, useRef, useState } from "react";
import { buildPreparedCache, type PreparedCache } from "./preparedCache";
import type { EditorState } from "@codemirror/state";
import { Transaction } from "@codemirror/state";
import {
  createEditorStateUnified, getDoc, getFrames,
  selectFrameEffect, getSelectedId,
  moveFrameEffect, resizeFrameEffect, setZEffect,
  applyAddFrame, applyDeleteFrame, applyClearDirty,
  proseInsert, proseDeleteBefore, moveCursorTo, getCursor,
  proseMoveLeft, proseMoveRight, proseMoveUp, proseMoveDown,
  editorUndo, editorRedo,
  setTextEditEffect, editTextFrameEffect, getTextEdit,
  type CursorPos,
} from "./editorState";
import { serializeUnified } from "./serializeUnified";
import { type Frame, hitTestFrames, resizeFrame, createRectFrame, createLineFrame, createTextFrame } from "./frame";
import { renderFrame, renderFrameSelection } from "./frameRenderer";
import { setTextAlignEffect } from "./editorState";
import { reflowLayout, type PositionedLine } from "./reflowLayout";
import { findCursorLine } from "./cursorFind";
import { FG_COLOR, measureCellSize, getCharWidth, getCharHeight, FONT_SIZE, FONT_FAMILY } from "./grid";
import { PROSE_FONT_RENDER, PROSE_LINE_HEIGHT, ensureProseFontReady } from "./textFont";

const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const BG = "#1e1e2e";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type ResizeHandle = "tl" | "tm" | "tr" | "ml" | "mr" | "bl" | "bm" | "br";
interface HandleRect { handle: ResizeHandle; x: number; y: number; w: number; h: number; }
const HANDLE_HIT = 24;
const HANDLE_HALF_HIT = HANDLE_HIT / 2;
const RESIZE_CURSOR_MAP: Record<ResizeHandle, string> = {
  tl: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", br: "nwse-resize",
  tm: "ns-resize", bm: "ns-resize", ml: "ew-resize", mr: "ew-resize",
};

function computeHandleRects(absX: number, absY: number, fw: number, fh: number): HandleRect[] {
  const pts: [ResizeHandle, number, number][] = [
    ["tl", absX, absY], ["tm", absX + fw / 2, absY], ["tr", absX + fw, absY],
    ["ml", absX, absY + fh / 2], ["mr", absX + fw, absY + fh / 2],
    ["bl", absX, absY + fh], ["bm", absX + fw / 2, absY + fh], ["br", absX + fw, absY + fh],
  ];
  return pts.map(([handle, cx, cy]) => ({ handle, x: cx - HANDLE_HALF_HIT, y: cy - HANDLE_HALF_HIT, w: HANDLE_HIT, h: HANDLE_HIT }));
}

function hitTestHandle(rects: HandleRect[], px: number, py: number): ResizeHandle | null {
  for (const r of rects) {
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r.handle;
  }
  return null;
}

function hasDescendant(frame: Frame, id: string): boolean {
  for (const c of frame.children) {
    if (c.id === id || hasDescendant(c, id)) return true;
  }
  return false;
}

const DEFAULT_TEXT = `# Gridpad

Where ASCII wireframes come alive. Drag any box to see prose reflow around it. Resize from edges. Click anywhere to type. Press R to draw rectangles, L for lines, V to go back to select mode.



## Dashboard Layout

A classic three-column web app. Drag the sidebar or panels to watch text reflow in real time around the wireframe obstacles.



┌───────────────────────────────────────────────────────┐
│                      My App                           │
├───────────┬───────────────────────────┬───────────────┤
│ Nav       │  Main Content             │  Details      │
│           │                           │               │
│ Home      │  ┌─────────────────────┐  │  User: Alice  │
│ Search    │  │  Revenue Chart      │  │  Role: Admin  │
│ Settings  │  │  ████▓▓░░           │  │               │
│ Help      │  └─────────────────────┘  │  ┌─────────┐  │
│           │                           │  │ Actions │  │
│           │  ┌──────────┐ ┌────────┐  │  │ Edit    │  │
│           │  │ Users    │ │ Tasks  │  │  │ Delete  │  │
│           │  │ 1,204    │ │ 38     │  │  └─────────┘  │
│           │  └──────────┘ └────────┘  │               │
└───────────┴───────────────────────────┴───────────────┘



The text you are reading reflows dynamically around every wireframe on this page. Try dragging the dashboard above and the paragraphs will rearrange themselves to fill the remaining space. This is the core idea behind Gridpad: prose and wireframes coexist on a single canvas, each aware of the other.



## Mobile App

A phone-sized screen with header, content area, and bottom navigation bar.



┌──────────────────┐
│   My App    ≡    │
├──────────────────┤
│                  │
│  Welcome back!   │
│                  │
│  ┌────────────┐  │
│  │  Profile   │  │
│  │  ┌──────┐  │  │
│  │  │ IMG  │  │  │
│  │  └──────┘  │  │
│  └────────────┘  │
│                  │
├──────────────────┤
│ ⌂    ☆    ✉    ⚙ │
└──────────────────┘



## User Flow

A simple flowchart showing navigation between screens. Drag the boxes to rearrange the flow.



┌─────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│  Login  │────│ Dashboard │────│ Settings │────│  Logout  │
└─────────┘    └───────────┘    └──────────┘    └──────────┘



Every element on this page is interactive. Wireframes are detected from plain ASCII box-drawing characters, no special syntax needed. Open your own markdown file with Cmd+O to try it on your own documents.



## Sign Up Form

A form wireframe. Double-click the text labels inside frames to edit them inline.



┌──────────────────────────┐
│      Create Account      │
├──────────────────────────┤
│                          │
│  Name:  ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
│  Email: ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
│  Pass:  ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
│                          │
│     ┌──────────────┐     │
│     │   Sign Up    │     │
│     └──────────────┘     │
│                          │
└──────────────────────────┘`;

interface DragState {
  frameId: string; startX: number; startY: number;
  startFrameX: number; startFrameY: number; startFrameW: number; startFrameH: number;
  hasMoved: boolean; resizeHandle?: ResizeHandle;
  /** Deferred drill-down: if set, apply this selection on mouseUp when !hasMoved */
  pendingDrillDownId?: string;
}

type ToolName = "select" | "rect" | "line" | "text";
const TOOL_BUTTONS: { tool: ToolName; label: string }[] = [
  { tool: "select", label: "↖ V" }, { tool: "rect", label: "□ R" },
  { tool: "line", label: "╱ L" }, { tool: "text", label: "T T" },
];

export default function DemoV2() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<EditorState>(null!);
  const [ready, setReady] = useState(false);
  const framesRef = useRef<Frame[]>([]);
  const proseRef = useRef("");
  const preparedRef = useRef<PreparedCache>([]);
  const linesRef = useRef<PositionedLine[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const cwRef = useRef(0);
  const chRef = useRef(0);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const activeToolRef = useRef<ToolName>("select");
  const [activeTool, setActiveTool] = useState<ToolName>("select");
  const [canvasCursor, setCanvasCursor] = useState("default");
  const proseCursorRef = useRef<CursorPos | null>(null);
  const blinkRef = useRef(true);
  const textEditRef = useRef<{ frameId: string; col: number } | null>(null);
  const lastClickRef = useRef<{ time: number; px: number; py: number } | null>(null);
  const drawPreviewRef = useRef<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const textPlacementRef = useRef<{ x: number; y: number; chars: string } | null>(null);
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  type WritableHandle = FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> };
  async function saveToHandle(h: FileSystemFileHandle) {
    console.log("saveToHandle called, handle:", h.name);
    try {
      const state = stateRef.current;
      const md = serializeUnified(getDoc(state), getFrames(state));
      const w = await (h as WritableHandle).createWritable();
      await w.write(md);
      await w.close();
      stateRef.current = applyClearDirty(stateRef.current);
      syncRefsFromState();
    } catch (err) { console.error("saveToHandle failed:", err); }
  }
  function scheduleAutosave() {
    if (!fileHandleRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => { if (fileHandleRef.current) void saveToHandle(fileHandleRef.current); }, 500);
  }
  function setTool(t: ToolName) { activeToolRef.current = t; setActiveTool(t); drawPreviewRef.current = null; textPlacementRef.current = null; }

  function loadDocument(text: string) {
    const cw = cwRef.current, ch = chRef.current;
    stateRef.current = createEditorStateUnified(text, cw, ch);
    syncRefsFromState();
    dragRef.current = null;
    proseCursorRef.current = null;
  }

  /** Refresh framesRef + proseRef + preparedRef from the current EditorState.
   * Call after any mutation that goes through unifiedDocSync (drag, resize,
   * delete, add) so the prepared-line cache reflects the post-mutation doc. */
  function syncRefsFromState() {
    const proseText = getDoc(stateRef.current);
    proseRef.current = proseText;
    framesRef.current = getFrames(stateRef.current);
    preparedRef.current = buildPreparedCache(proseText);
  }

  function doLayout() {
    if (!stateRef.current) { linesRef.current = []; return; }
    const ch = chRef.current;
    const frames = getFrames(stateRef.current);

    // Build set of claimed line numbers (0-based)
    const claimedLines = new Set<number>();
    for (const f of frames) {
      if (f.lineCount === 0) continue;
      const startLine = stateRef.current.doc.lineAt(f.docOffset).number - 1;
      for (let i = 0; i < f.lineCount; i++) claimedLines.add(startLine + i);
    }

    // Build preparedLines: null for claimed lines, prepared text for prose
    const prepared = preparedRef.current;
    const adjusted = prepared.map((p, i) => claimedLines.has(i) ? null : p);

    // No obstacles in unified mode
    linesRef.current = reflowLayout(adjusted, sizeRef.current.w, ch, []).lines;

    // Set frame pixel Y from lineTop accumulator
    let lineTop = 0;
    const doc = stateRef.current.doc;
    for (let i = 0; i < doc.lines; i++) {
      if (claimedLines.has(i)) {
        for (const f of frames) {
          if (f.lineCount === 0) continue;
          const startLine = doc.lineAt(f.docOffset).number - 1;
          if (i === startLine) {
            f.y = lineTop;
            f.x = f.gridCol * cwRef.current;
          }
        }
        lineTop += ch;
      } else {
        const visualLines = linesRef.current.filter(l => l.sourceLine === i);
        lineTop += Math.max(visualLines.length, 1) * ch;
      }
    }
  }

  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!stateRef.current) return;
    const { w, h: viewH } = sizeRef.current;
    let contentH = 100;
    for (const line of linesRef.current) contentH = Math.max(contentH, line.y + chRef.current);
    for (const f of framesRef.current) contentH = Math.max(contentH, f.y + f.h);
    contentH = Math.max(contentH + 40, viewH);
    // Update scroll spacer to enable scrolling over full content
    const spacer = canvas.parentElement?.querySelector("[data-spacer]") as HTMLElement | null;
    if (spacer) spacer.style.height = `${contentH}px`;
    const scrollTop = canvas.parentElement?.scrollTop ?? 0;
    // Canvas is viewport-sized (never exceeds GPU limits), drawing is offset by scrollTop
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.floor(w * dpr), ph = Math.floor(viewH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext("2d")!;
    // Clear entire canvas in device space first (no transform)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, pw, ph);
    // DPR scaling, then translate by scroll offset in CSS coords
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(0, -scrollTop);
    ctx.font = PROSE_FONT_RENDER; ctx.fillStyle = FG_COLOR; ctx.textBaseline = "top";
    // Viewport culling — only draw visible content
    const viewTop = scrollTop - chRef.current;
    const viewBot = scrollTop + viewH + chRef.current;
    for (const line of linesRef.current) {
      if (line.y + PROSE_LINE_HEIGHT >= viewTop && line.y <= viewBot) ctx.fillText(line.text, line.x, line.y);
    }
    const cw = cwRef.current, ch = chRef.current;
    for (const frame of framesRef.current) {
      if (frame.y + frame.h >= viewTop && frame.y <= viewBot) renderFrame(ctx, frame, 0, 0, cw, ch);
    }
    const selectedId = getSelectedId(stateRef.current);
    if (selectedId) {
      const sel = findFrameById(framesRef.current, selectedId);
      if (sel) renderFrameSelection(ctx, sel.frame, sel.absX, sel.absY);
    }
    // Prose cursor (blinking)
    const cursor = proseCursorRef.current;
    if (cursor && blinkRef.current) {
      ctx.font = PROSE_FONT_RENDER;
      const pos = findCursorLine(cursor, linesRef.current, (s) => ctx.measureText(s).width, chRef.current);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(pos.x, pos.y, 2, PROSE_LINE_HEIGHT);
    }
    // Text frame cursor (blinking)
    const te = textEditRef.current;
    if (te && blinkRef.current) {
      const found = findFrameById(framesRef.current, te.frameId);
      if (found && found.frame.content?.type === "text") {
        const charWidth = getCharWidth();
        const charHeight = chRef.current;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(found.absX + te.col * charWidth, found.absY, 2, charHeight);
      }
    }
    // Ghost overflow for text being edited inside a rect
    const teGhost = textEditRef.current;
    if (teGhost) {
      const found = findFrameById(framesRef.current, teGhost.frameId);
      if (found && found.frame.content?.type === "text" && found.frame.content.text) {
        // Measure with correct font before checking overflow
        ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
        const textWidth = ctx.measureText(found.frame.content.text).width;
        // Check against frame width (parent clip handles the rest)
        if (textWidth > found.frame.w) {
          ctx.save();
          ctx.globalAlpha = 0.4;
          ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
          ctx.fillStyle = FG_COLOR;
          ctx.textBaseline = "top";
          ctx.fillText(found.frame.content.text, found.absX, found.absY);
          ctx.restore();
        }
      }
    }
    // Drawing tool preview + text placement
    const preview = drawPreviewRef.current;
    if (preview) {
      const x1 = Math.min(preview.startX, preview.curX), y1 = Math.min(preview.startY, preview.curY);
      const x2 = Math.max(preview.startX, preview.curX), y2 = Math.max(preview.startY, preview.curY);
      ctx.save(); ctx.strokeStyle = "#4a90e2"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      if (activeToolRef.current === "rect") { ctx.strokeRect(x1, y1, x2 - x1, y2 - y1); }
      else { ctx.beginPath(); ctx.moveTo(preview.startX, preview.startY); ctx.lineTo(preview.curX, preview.curY); ctx.stroke(); }
      ctx.restore();
    }
    const tp = textPlacementRef.current;
    if (tp) {
      const cw2 = cwRef.current, ch2 = chRef.current;
      ctx.save(); ctx.strokeStyle = "#4a90e2"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.strokeRect(tp.x, tp.y, Math.max(1, [...tp.chars].length) * cw2, ch2); ctx.setLineDash([]);
      if (tp.chars.length > 0) { ctx.fillStyle = FG_COLOR; ctx.font = FONT; ctx.textBaseline = "top"; ctx.fillText(tp.chars, tp.x, tp.y); }
      ctx.restore();
    }
  }

  function findFrameById(frames: Frame[], id: string, px = 0, py = 0): { frame: Frame; absX: number; absY: number } | null {
    for (const f of frames) {
      const ax = px + f.x, ay = py + f.y;
      if (f.id === id) return { frame: f, absX: ax, absY: ay };
      const child = findFrameById(f.children, id, ax, ay);
      if (child) return child;
    }
    return null;
  }


  function proseCursorFromClick(px: number, py: number): CursorPos | null {
    if (linesRef.current.length === 0) return null;
    // Find closest visual line — vertical distance first, horizontal tie-break
    let best: PositionedLine | null = null;
    let bestDist = Infinity;
    const candidates: PositionedLine[] = [];
    let minVDist = Infinity;

    for (const pl of linesRef.current) {
      const vDist = Math.abs(pl.y + PROSE_LINE_HEIGHT / 2 - py);
      if (vDist < minVDist) minVDist = vDist;
    }
    // Collect all lines within 1px of the best vertical distance (same y-band)
    for (const pl of linesRef.current) {
      const vDist = Math.abs(pl.y + PROSE_LINE_HEIGHT / 2 - py);
      if (vDist <= minVDist + 1) candidates.push(pl);
    }
    if (candidates.length === 1) {
      best = candidates[0];
    } else {
      // Multi-slot tie-break: prefer the slot that contains px horizontally
      for (const pl of candidates) {
        if (px >= pl.x && px <= pl.x + pl.width) { best = pl; break; }
      }
      // If px is outside all slots, pick nearest by horizontal distance
      if (!best) {
        for (const pl of candidates) {
          const hDist = px < pl.x ? pl.x - px : px > pl.x + pl.width ? px - pl.x - pl.width : 0;
          if (hDist < bestDist) { bestDist = hDist; best = pl; }
        }
      }
    }
    if (!best) return null;

    // Use sourceLine/sourceCol — the EditorState-compatible coordinates
    const row = best.sourceLine;

    // Binary search for clicked grapheme using proportional font measurement
    const graphemes = [...graphemeSegmenter.segment(best.text)];
    let clickCol = graphemes.length; // default: click past end of line
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d")!;
      ctx.font = PROSE_FONT_RENDER;
      const relX = px - best.x;
      for (let g = 0; g < graphemes.length; g++) {
        const prefix = graphemes.slice(0, g + 1).map(s => s.segment).join("");
        const w = ctx.measureText(prefix).width;
        if (w > relX) {
          // Check if click is closer to this grapheme or the previous one
          const prevW = g > 0 ? ctx.measureText(graphemes.slice(0, g).map(s => s.segment).join("")).width : 0;
          clickCol = (relX - prevW) < (w - relX) ? g : g + 1;
          break;
        }
      }
    }
    const col = best.sourceCol + Math.min(clickCol, graphemes.length);

    // Clamp against actual source line length (grapheme count)
    const state = stateRef.current;
    if (!state) return null;
    const clampedRow = Math.min(Math.max(row, 0), state.doc.lines - 1);
    const lineText = state.doc.line(clampedRow + 1).text;
    const lineGraphemes = [...graphemeSegmenter.segment(lineText)].length;
    const clampedCol = Math.min(col, lineGraphemes);
    return { row: clampedRow, col: clampedCol };
  }

  function onMouseDown(e: React.MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top + (canvas.parentElement?.scrollTop ?? 0);
    const tool = activeToolRef.current;
    // Single hit-test for the whole click handler
    const hit = hitTestFrames(framesRef.current, px, py);
    // Drawing tools only activate on empty space — clicking anything selects it + reverts to Select
    if (tool !== "select" && hit) {
      setTool("select"); // auto-revert to select on click
    }
    if (!hit && (tool === "rect" || tool === "line")) {
      drawPreviewRef.current = { startX: px, startY: py, curX: px, curY: py };
      paint(); return;
    }
    if (!hit && tool === "text") {
      const cw = cwRef.current, ch = chRef.current;
      const snappedX = Math.floor(px / cw) * cw, snappedY = Math.floor(py / ch) * ch;
      textPlacementRef.current = { x: snappedX, y: snappedY, chars: "" };
      paint(); return;
    }
    const currentSelectedId = getSelectedId(stateRef.current);
    if (currentSelectedId) {
      const sel = findFrameById(framesRef.current, currentSelectedId);
      if (sel) {
        const handleHit = hitTestHandle(computeHandleRects(sel.absX, sel.absY, sel.frame.w, sel.frame.h), px, py);
        if (handleHit) {
          dragRef.current = { frameId: sel.frame.id, startX: px, startY: py, startFrameX: sel.absX, startFrameY: sel.absY, startFrameW: sel.frame.w, startFrameH: sel.frame.h, hasMoved: false, resizeHandle: handleHit };
          paint(); return;
        }
      }
    }
    // Drill-down UX: first click selects container, second click on child selects child
    // But drill-down is deferred to mouseUp — on mouseDown we always drag the
    // currently selected frame (or its container) to avoid stealing resize handles.
    const hitContainer = hit ? framesRef.current.find(f => f.id === hit.id || hasDescendant(f, hit.id)) : null;
    const wouldDrillDown = hit && hitContainer && currentSelectedId === hitContainer.id && currentSelectedId !== hit.id;
    const targetId = hit ? (
      // If we'd drill down, defer it — keep current selection for dragging
      wouldDrillDown ? currentSelectedId
      // If the hit IS what's already selected, keep it
      : currentSelectedId === hit.id ? hit.id
      // Otherwise select the container
      : hitContainer?.id ?? hit.id
    ) : null;
    const now = Date.now();
    const last = lastClickRef.current;
    const isDblClick = last !== null && now - last.time < 300 && Math.abs(px - last.px) < 10 && Math.abs(py - last.py) < 10;
    lastClickRef.current = { time: now, px, py };
    if (hit && targetId) {
      if (isDblClick && hit.content?.type === "text") {
        const found = findFrameById(framesRef.current, hit.id);
        if (found) {
          const cw2 = getCharWidth(), text = hit.content.text ?? "";
          const textLen = Math.max(0, Math.min(Math.round((px - found.absX) / cw2), [...text].length));
          stateRef.current = stateRef.current.update({
            effects: [selectFrameEffect.of(hit.id), setTextEditEffect.of({ frameId: hit.id, col: textLen })],
          }).state;
          textEditRef.current = getTextEdit(stateRef.current); // sync for paint
          proseCursorRef.current = null; dragRef.current = null;
          blinkRef.current = true; canvas.focus(); paint(); return;
        }
      }
      stateRef.current = stateRef.current.update({ effects: selectFrameEffect.of(targetId) }).state;
      proseCursorRef.current = null; textEditRef.current = null;
      const found = findFrameById(framesRef.current, targetId);
      if (found) dragRef.current = { frameId: targetId, startX: px, startY: py, startFrameX: found.absX, startFrameY: found.absY, startFrameW: found.frame.w, startFrameH: found.frame.h, hasMoved: false, pendingDrillDownId: wouldDrillDown ? hit.id : undefined };
      paint();
    } else {
      stateRef.current = stateRef.current.update({ effects: selectFrameEffect.of(null) }).state;
      dragRef.current = null;
      textEditRef.current = null;
      const cursor = proseCursorFromClick(px, py);
      proseCursorRef.current = cursor;
      if (cursor) stateRef.current = moveCursorTo(stateRef.current, cursor);
      blinkRef.current = true; paint();
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top + (canvas.parentElement?.scrollTop ?? 0);
    if (drawPreviewRef.current) { drawPreviewRef.current = { ...drawPreviewRef.current, curX: px, curY: py }; paint(); return; }
    const drag = dragRef.current;
    if (!drag) {
      // Dynamic cursor — hover detection when no drag active
      const selectedId = getSelectedId(stateRef.current);
      if (selectedId) {
        const sel = findFrameById(framesRef.current, selectedId);
        if (sel) {
          const handle = hitTestHandle(computeHandleRects(sel.absX, sel.absY, sel.frame.w, sel.frame.h), px, py);
          if (handle) {
            setCanvasCursor(RESIZE_CURSOR_MAP[handle]);
          } else {
            setCanvasCursor(hitTestFrames(framesRef.current, px, py) ? "grab" : "text");
          }
        } else { setCanvasCursor("text"); }
      } else {
        setCanvasCursor(hitTestFrames(framesRef.current, px, py) ? "grab" : "text");
      }
      return;
    }
    const dx = px - drag.startX, dy = py - drag.startY;
    if (!drag.hasMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    const isFirstDragStep = !drag.hasMoved;
    drag.hasMoved = true;
    if (drag.resizeHandle) {
      setCanvasCursor(RESIZE_CURSOR_MAP[drag.resizeHandle]);
    } else { setCanvasCursor("grabbing"); }
    const found = findFrameById(framesRef.current, drag.frameId);
    if (!found) return;
    if (drag.resizeHandle) {
      const cw = cwRef.current, ch = chRef.current;
      const h = drag.resizeHandle, sw = drag.startFrameW, sh = drag.startFrameH;
      let newW = sw, newH = sh, newDx = 0, newDy = 0;
      if (h === "br") { newW = sw + dx; newH = sh + dy; }
      else if (h === "bl") { newW = sw - dx; newH = sh + dy; newDx = dx; }
      else if (h === "tr") { newW = sw + dx; newH = sh - dy; newDy = dy; }
      else if (h === "tl") { newW = sw - dx; newH = sh - dy; newDx = dx; newDy = dy; }
      else if (h === "bm") { newH = sh + dy; }
      else if (h === "tm") { newH = sh - dy; newDy = dy; }
      else if (h === "mr") { newW = sw + dx; }
      else if (h === "ml") { newW = sw - dx; newDx = dx; }
      const newGridW = Math.max(2, Math.round(newW / cw));
      const newGridH = Math.max(2, Math.round(newH / ch));
      const resized = resizeFrame(found.frame, { gridW: newGridW, gridH: newGridH }, cw, ch);
      const anchorX = drag.startFrameX + (newDx !== 0 ? drag.startFrameW : 0);
      const anchorY = drag.startFrameY + (newDy !== 0 ? drag.startFrameH : 0);
      const newAbsX = newDx !== 0 ? anchorX - resized.w : drag.startFrameX;
      const newAbsY = newDy !== 0 ? anchorY - resized.h : drag.startFrameY;
      const parentOffX = found.absX - found.frame.x, parentOffY = found.absY - found.frame.y;
      const moveDx = newAbsX - parentOffX - found.frame.x;
      const moveDy = newAbsY - parentOffY - found.frame.y;
      const moveGridDCol = Math.round(moveDx / cw);
      const moveGridDRow = Math.round(moveDy / ch);
      const effects = [
        resizeFrameEffect.of({ id: drag.frameId, gridW: newGridW, gridH: newGridH, charWidth: cw, charHeight: ch }),
        moveFrameEffect.of({ id: drag.frameId, dCol: moveGridDCol, dRow: moveGridDRow, charWidth: cw, charHeight: ch }),
      ];
      stateRef.current = stateRef.current.update({
        effects,
        annotations: [Transaction.addToHistory.of(isFirstDragStep)],
      }).state;
      syncRefsFromState();
    } else {
      // Compute target position from drag start + mouse delta, snapped to grid
      const cw = cwRef.current, ch = chRef.current;
      const targetCol = Math.round(Math.max(0, drag.startFrameX + dx) / cw);
      const targetRow = Math.round(Math.max(0, drag.startFrameY + dy) / ch);
      const currentCol = Math.round(found.absX / cw);
      const currentRow = Math.round(found.absY / ch);
      const dCol = targetCol - currentCol;
      const dRow = targetRow - currentRow;
      if (dCol !== 0 || dRow !== 0) {
        stateRef.current = stateRef.current.update({
          effects: moveFrameEffect.of({ id: drag.frameId, dCol, dRow, charWidth: cw, charHeight: ch }),
          annotations: [Transaction.addToHistory.of(isFirstDragStep)],
        }).state;
        syncRefsFromState();
      }
    }
    doLayout(); paint();
  }

  function onMouseUp() {
    if (dragRef.current) {
      // Deferred drill-down: if user clicked without dragging, apply the
      // drill-down selection now (selects the child instead of the container)
      if (!dragRef.current.hasMoved && dragRef.current.pendingDrillDownId) {
        stateRef.current = stateRef.current.update({
          effects: selectFrameEffect.of(dragRef.current.pendingDrillDownId),
        }).state;
        paint();
      }
      dragRef.current = null; scheduleAutosave();
    }
    const preview = drawPreviewRef.current;
    if (!preview) return;
    const cw = cwRef.current, ch = chRef.current;
    const tool = activeToolRef.current;
    const x1 = Math.min(preview.startX, preview.curX), y1 = Math.min(preview.startY, preview.curY);
    const x2 = Math.max(preview.startX, preview.curX), y2 = Math.max(preview.startY, preview.curY);
    drawPreviewRef.current = null;
    if (tool === "rect" && x2 - x1 >= cw && y2 - y1 >= ch) {
      const f = createRectFrame({ gridW: Math.max(2, Math.round((x2 - x1) / cw)), gridH: Math.max(2, Math.round((y2 - y1) / ch)), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: cw, charHeight: ch });
      const gridR = Math.round(y1 / ch), gridC = Math.round(x1 / cw);
      stateRef.current = applyAddFrame(stateRef.current, { ...f, x: gridC * cw, y: gridR * ch, gridRow: gridR, gridCol: gridC });
      syncRefsFromState(); scheduleAutosave();
    } else if (tool === "line") {
      const r1 = Math.round(preview.startY / ch), c1 = Math.round(preview.startX / cw), r2 = Math.round(preview.curY / ch), c2 = Math.round(preview.curX / cw);
      if (r1 !== r2 || c1 !== c2) {
        stateRef.current = applyAddFrame(stateRef.current, createLineFrame({ r1, c1, r2, c2, charWidth: cw, charHeight: ch }));
        syncRefsFromState(); scheduleAutosave();
      }
    }
    setTool("select"); // one-shot: revert to Select after drawing
    doLayout(); paint();
  }

  useEffect(() => {
    Promise.all([measureCellSize(), ensureProseFontReady()]).then(() => {
      cwRef.current = getCharWidth(); chRef.current = getCharHeight();
      loadDocument(DEFAULT_TEXT); setReady(true);
      // Expose test hooks for Playwright round-trip testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__gridpad = {
        loadDocument: (text: string) => { loadDocument(text); doLayout(); paint(); },
        serializeDocument: () => {
          const state = stateRef.current;
          return serializeUnified(getDoc(state), getFrames(state));
        },
        /** Serialize + update all refs (mirrors real saveToHandle minus file I/O) */
        saveDocument: () => {
          const state = stateRef.current;
          const md = serializeUnified(getDoc(state), getFrames(state));
          stateRef.current = applyClearDirty(stateRef.current);
          syncRefsFromState();
          doLayout(); paint();
          return md;
        },
        /** Get all top-level frame bounding boxes in CSS pixels */
        getFrameRects: () => {
          return framesRef.current.map(f => ({
            id: f.id,
            x: f.x, y: f.y, w: f.w, h: f.h,
            hasChildren: f.children.length > 0,
            contentType: f.content?.type ?? "container",
          }));
        },
        /** Get full frame tree with all children, positions, and content */
        getFrameTree: () => {
          const collect = (fs: Frame[], offX: number, offY: number, offRow: number, offCol: number): unknown[] =>
            fs.map(f => ({
              id: f.id,
              absX: offX + f.x, absY: offY + f.y,
              w: f.w, h: f.h,
              gridRow: offRow + f.gridRow,
              gridCol: offCol + f.gridCol,
              gridW: f.gridW,
              gridH: f.gridH,
              contentType: f.content?.type ?? "container",
              text: f.content?.text ?? null,
              dirty: f.dirty,
              childCount: f.children.length,
              children: collect(f.children, offX + f.x, offY + f.y, offRow + f.gridRow, offCol + f.gridCol),
            }));
          return collect(framesRef.current, 0, 0, 0, 0);
        },
        /** Get current prose text from CM doc */
        getProseDoc: () => getDoc(stateRef.current),
        /** Get the selected frame ID (null if nothing selected) */
        getSelectedId: () => getSelectedId(stateRef.current),
        /** Get positioned prose lines from reflowLayout (what's actually rendered) */
        getRenderedLines: () => linesRef.current.map(l => ({
          x: l.x, y: l.y, text: l.text, width: l.width,
          sourceLine: l.sourceLine, sourceCol: l.sourceCol,
        })),
        /** Get measured character dimensions */
        getCharDims: () => ({ cw: cwRef.current, ch: chRef.current }),
        /** Get current text edit state (null if not editing) */
        getTextEdit: () => getTextEdit(stateRef.current),
        /** Debug: test hitTestFrames at a given position */
        hitTest: (px: number, py: number) => {
          const hit = hitTestFrames(framesRef.current, px, py);
          return hit ? { id: hit.id, type: hit.content?.type ?? "container" } : null;
        },
        /** Clear all active interaction state (prose cursor, selection, text edit) */
        clearState: () => {
          stateRef.current = stateRef.current.update({
            effects: [selectFrameEffect.of(null), setTextEditEffect.of(null)],
          }).state;
          proseCursorRef.current = null;
          textEditRef.current = null;
          dragRef.current = null;
          doLayout(); paint();
        },
        /** Get prose cursor position */
        getCursorPosition: () => proseCursorRef.current,
        /** Check if any frame is dirty */
        isDirty: () => framesRef.current.some(f => f.dirty),
        /** Programmatically select a frame by ID and prepare for drag */
        selectFrame: (id: string) => {
          stateRef.current = stateRef.current.update({
            effects: [selectFrameEffect.of(id), setTextEditEffect.of(null)],
          }).state;
          proseCursorRef.current = null;
          textEditRef.current = null;
          syncRefsFromState();
          paint();
        },
      };
    }).catch(err => console.error("Init failed:", err));
  }, []);

  useEffect(() => {
    const fn = () => { if (!stateRef.current) return; sizeRef.current = { w: window.innerWidth, h: window.innerHeight }; doLayout(); paint(); };
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (proseCursorRef.current || textEditRef.current) { blinkRef.current = !blinkRef.current; paint(); }
    }, 530);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const fn = async (e: KeyboardEvent) => {
      if (!stateRef.current) return;
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        stateRef.current = editorUndo(stateRef.current);
        syncRefsFromState();
        proseRef.current = getDoc(stateRef.current);
        preparedRef.current = buildPreparedCache(proseRef.current);
        proseCursorRef.current = getCursor(stateRef.current);
        doLayout(); blinkRef.current = true; paint();
        return;
      }
      if (mod && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        stateRef.current = editorRedo(stateRef.current);
        syncRefsFromState();
        proseRef.current = getDoc(stateRef.current);
        preparedRef.current = buildPreparedCache(proseRef.current);
        proseCursorRef.current = getCursor(stateRef.current);
        doLayout(); blinkRef.current = true; paint();
        return;
      }
      if (mod && e.key === "o") {
        e.preventDefault();
        try {
          const [handle] = await window.showOpenFilePicker({ types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }] });
          fileHandleRef.current = handle;
          const file = await handle.getFile();
          loadDocument(await file.text()); doLayout(); paint();
        } catch (err) { if (err instanceof DOMException && err.name === "AbortError") { /* cancelled */ } else { console.error("File open failed:", err); throw err; } }
      }
      if (mod && e.shiftKey && e.key === "s") {
        e.preventDefault();
        if (!("showSaveFilePicker" in window)) return;
        try {
          const handle = await window.showSaveFilePicker({
            types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
            suggestedName: "document.md",
          });
          fileHandleRef.current = handle;
          await saveToHandle(handle);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") { /* cancelled */ }
          else { console.error("Save As failed:", err); }
        }
        return;
      }
      if (mod && e.key === "s") {
        e.preventDefault();
        if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null; }
        if (fileHandleRef.current) await saveToHandle(fileHandleRef.current);
      }
      // Text placement tool — collect typed chars
      const tp = textPlacementRef.current;
      if (tp) {
        if (e.key === "Escape") { e.preventDefault(); textPlacementRef.current = null; paint(); return; }
        if (e.key === "Enter") {
          e.preventDefault();
          if (tp.chars.length > 0) {
            const cw = cwRef.current, ch = chRef.current;
            stateRef.current = applyAddFrame(stateRef.current, createTextFrame({ text: tp.chars, row: Math.round(tp.y / ch), col: Math.round(tp.x / cw), charWidth: cw, charHeight: ch }));
            syncRefsFromState();
            scheduleAutosave(); doLayout();
          }
          setTool("select"); paint(); return; // one-shot: revert to Select
        }
        if (e.key === "Backspace") { e.preventDefault(); const cps = [...tp.chars]; cps.pop(); textPlacementRef.current = { ...tp, chars: cps.join("") }; paint(); return; }
        if (e.key.length === 1 && !mod) { e.preventDefault(); textPlacementRef.current = { ...tp, chars: tp.chars + e.key }; paint(); return; }
        return;
      }
      if (textEditRef.current) {
        const te = textEditRef.current;
        const found = findFrameById(framesRef.current, te.frameId);
        if (!found || found.frame.content?.type !== "text") {
          stateRef.current = stateRef.current.update({ effects: setTextEditEffect.of(null) }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          paint(); return;
        }
        const text = found.frame.content!.text ?? "";
        const codepoints = [...text];
        // Alignment shortcuts (only while editing text inside a rect)
        if (mod && !e.shiftKey) {
          if (e.key === "l" || e.key === "L") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, hAlign: { anchor: "left", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
          if (e.key === "e" || e.key === "E") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, hAlign: { anchor: "center", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
          if (e.key === "r" || e.key === "R") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, hAlign: { anchor: "right", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
        }
        if (mod && e.shiftKey) {
          if (e.key === "t" || e.key === "T") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, vAlign: { anchor: "top", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
          if (e.key === "m" || e.key === "M") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, vAlign: { anchor: "center", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
          if (e.key === "b" || e.key === "B") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, vAlign: { anchor: "bottom", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
        }
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({ effects: setTextEditEffect.of(null) }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({
            effects: setTextEditEffect.of({ frameId: te.frameId, col: Math.max(0, te.col - 1) }),
          }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({
            effects: setTextEditEffect.of({ frameId: te.frameId, col: Math.min(codepoints.length, te.col + 1) }),
          }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "Home") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({
            effects: setTextEditEffect.of({ frameId: te.frameId, col: 0 }),
          }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "End") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({
            effects: setTextEditEffect.of({ frameId: te.frameId, col: codepoints.length }),
          }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          if (te.col > 0) {
            const newCp = [...codepoints.slice(0, te.col - 1), ...codepoints.slice(te.col)];
            const newText = newCp.join("");
            const charWidth = getCharWidth();
            stateRef.current = stateRef.current.update({
              effects: [
                editTextFrameEffect.of({ id: te.frameId, text: newText, charWidth }),
                setTextEditEffect.of({ frameId: te.frameId, col: te.col - 1 }),
              ],
              annotations: [Transaction.addToHistory.of(true)],
            }).state;
            syncRefsFromState();
            textEditRef.current = getTextEdit(stateRef.current);
            scheduleAutosave();
          }
          blinkRef.current = true; paint(); return;
        }
        if (e.key.length === 1 && !mod) {
          e.preventDefault();
          const newCp = [...codepoints.slice(0, te.col), e.key, ...codepoints.slice(te.col)];
          const newText = newCp.join("");
          const charWidth = getCharWidth();
          stateRef.current = stateRef.current.update({
            effects: [
              editTextFrameEffect.of({ id: te.frameId, text: newText, charWidth }),
              setTextEditEffect.of({ frameId: te.frameId, col: te.col + 1 }),
            ],
            annotations: [Transaction.addToHistory.of(true)],
          }).state;
          syncRefsFromState();
          textEditRef.current = getTextEdit(stateRef.current);
          scheduleAutosave(); blinkRef.current = true; paint(); return;
        }
        return;
      }
      if (proseCursorRef.current) {
        if (e.key === "Escape") { proseCursorRef.current = null; paint(); return; }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          stateRef.current = proseMoveLeft(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          stateRef.current = proseMoveRight(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          stateRef.current = proseMoveUp(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          stateRef.current = proseMoveDown(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          const beforeCursor = getCursor(stateRef.current)!;
          stateRef.current = proseDeleteBefore(stateRef.current, beforeCursor);
          // Unified-doc: proseDelete mutates the CM doc; mapPos in framesField
          // shifts every frame's docOffset automatically. No manual frame-shift
          // loop needed. syncRefsFromState rebuilds preparedRef from scratch.
          syncRefsFromState();
          proseCursorRef.current = getCursor(stateRef.current);
          scheduleAutosave(); doLayout(); blinkRef.current = true; paint(); return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          stateRef.current = proseInsert(stateRef.current, getCursor(stateRef.current)!, "\n");
          // Same as Backspace: unified pipeline handles both doc + frame shift.
          syncRefsFromState();
          proseCursorRef.current = getCursor(stateRef.current);
          scheduleAutosave(); doLayout(); blinkRef.current = true; paint(); return;
        }
        if (e.key.length === 1 && !mod) {
          e.preventDefault();
          stateRef.current = proseInsert(stateRef.current, getCursor(stateRef.current)!, e.key);
          syncRefsFromState();
          proseCursorRef.current = getCursor(stateRef.current);
          scheduleAutosave(); doLayout(); blinkRef.current = true; paint(); return;
        }
        return;
      }
      // Global shortcuts (no prose cursor)
      if (e.key === "Escape") {
        stateRef.current = stateRef.current.update({ effects: selectFrameEffect.of(null) }).state;
        paint();
      }
      const deleteSelectedId = getSelectedId(stateRef.current);
      if ((e.key === "Delete" || e.key === "Backspace") && deleteSelectedId) {
        stateRef.current = applyDeleteFrame(stateRef.current, deleteSelectedId);
        syncRefsFromState();
        doLayout(); paint();
      }
      // Z-order shortcuts (top-level frames only)
      const zSelId = getSelectedId(stateRef.current);
      if (zSelId) {
        const topFrame = framesRef.current.find(f => f.id === zSelId);
        if (topFrame) {
          if (e.key === "]" && !mod) {
            e.preventDefault();
            stateRef.current = stateRef.current.update({ effects: setZEffect.of({ id: topFrame.id, z: topFrame.z + 1 }), annotations: [Transaction.addToHistory.of(true)] }).state;
            syncRefsFromState(); doLayout(); paint(); return;
          }
          if (e.key === "[" && !mod) {
            e.preventDefault();
            stateRef.current = stateRef.current.update({ effects: setZEffect.of({ id: topFrame.id, z: Math.max(0, topFrame.z - 1) }), annotations: [Transaction.addToHistory.of(true)] }).state;
            syncRefsFromState(); doLayout(); paint(); return;
          }
          if (e.key === "]" && mod) {
            e.preventDefault();
            const maxZ = Math.max(...framesRef.current.map(f => f.z));
            stateRef.current = stateRef.current.update({ effects: setZEffect.of({ id: topFrame.id, z: maxZ + 1 }), annotations: [Transaction.addToHistory.of(true)] }).state;
            syncRefsFromState(); doLayout(); paint(); return;
          }
          if (e.key === "[" && mod) {
            e.preventDefault();
            stateRef.current = stateRef.current.update({ effects: setZEffect.of({ id: topFrame.id, z: 0 }), annotations: [Transaction.addToHistory.of(true)] }).state;
            syncRefsFromState(); doLayout(); paint(); return;
          }
        }
      }
      if (!mod) {
        if (e.key === "v" || e.key === "V") setTool("select");
        if (e.key === "r" || e.key === "R") setTool("rect");
        if (e.key === "l" || e.key === "L") setTool("line");
        if (e.key === "t" || e.key === "T") setTool("text");
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  useEffect(() => { if (ready) { doLayout(); paint(); } }, [ready]);

  if (!ready) return <div style={{ background: BG, width: "100vw", height: "100vh" }} />;

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "auto", background: "#141420" }} onScroll={paint}>
      <div style={{ position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 100, background: "#2b2b33", borderRadius: 10, padding: "4px 8px", boxShadow: "0 2px 12px rgba(0,0,0,0.5)", display: "flex", gap: 4 }}>
        {TOOL_BUTTONS.map(({ tool, label }) => (
          <button key={tool} onClick={() => setTool(tool)} style={{ background: activeTool === tool ? "#4a90e2" : "transparent", color: "#e0e0e0", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: FONT_FAMILY, fontSize: 13, fontWeight: activeTool === tool ? 600 : 400 }}>
            {label}
          </button>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ display: "block", width: "100%", height: "100%", position: "sticky", top: 0, outline: "none", cursor: canvasCursor }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
      <div data-spacer="" style={{ pointerEvents: "none" }} />
    </div>
  );
}
