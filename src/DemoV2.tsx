/**
 * DemoV2 — Frame-based spatial canvas. Thin shell using frame.ts + frameRenderer.ts.
 */
import { useEffect, useRef, useState } from "react";
import { prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext";
import { scanToFrames } from "./scanToFrames";
import { type Frame, framesToObstacles, hitTestFrames, moveFrame, resizeFrame, createRectFrame, createLineFrame, createTextFrame } from "./frame";
import { renderFrame, renderFrameSelection } from "./frameRenderer";
import { reflowLayout, type PositionedLine } from "./reflowLayout";
import { FG_COLOR, measureCellSize, getCharWidth, getCharHeight, FONT_SIZE, FONT_FAMILY } from "./grid";
import { insertChar, deleteChar, type CursorPos } from "./proseCursor";

const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const LH = Math.ceil(FONT_SIZE * 1.15);
const BG = "#1e1e2e";

type ResizeHandle = "tl" | "tm" | "tr" | "ml" | "mr" | "bl" | "bm" | "br";
interface HandleRect { handle: ResizeHandle; x: number; y: number; w: number; h: number; }
const HANDLE_HIT = 12;
const HANDLE_HALF_HIT = HANDLE_HIT / 2;

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

const DEFAULT_TEXT = `# Welcome to Gridpad

Open a markdown file with wireframes to see them rendered.
Use Cmd+O to open a file, then drag the wireframe boxes around.

┌─────────────────────────────────────────────────┐
│                   Dashboard                     │
├──────────┬──────────────────────┬───────────────┤
│ Sidebar  │  Main Content        │  Right Panel  │
│          │                      │               │
│          │  ┌────────────────┐  │               │
│          │  │  Card Title    │  │               │
│          │  │  Description   │  │               │
│          │  └────────────────┘  │               │
│          │                      │               │
└──────────┴──────────────────────┴───────────────┘

The text above and below the wireframe is rendered by Pretext.
Try dragging a wireframe — Alt+click to move, text reflows around it.`;

interface DragState {
  frameId: string; startX: number; startY: number;
  startFrameX: number; startFrameY: number; startFrameW: number; startFrameH: number;
  hasMoved: boolean; resizeHandle?: ResizeHandle;
}

type ToolName = "select" | "rect" | "line" | "text";
const TOOL_BUTTONS: { tool: ToolName; label: string }[] = [
  { tool: "select", label: "↖ V" }, { tool: "rect", label: "□ R" },
  { tool: "line", label: "╱ L" }, { tool: "text", label: "T T" },
];

export default function DemoV2() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const framesRef = useRef<Frame[]>([]);
  const proseRef = useRef("");
  const preparedRef = useRef<PreparedTextWithSegments | null>(null);
  const linesRef = useRef<PositionedLine[]>([]);
  const selectedRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const cwRef = useRef(0);
  const chRef = useRef(0);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const activeToolRef = useRef<ToolName>("select");
  const [activeTool, setActiveTool] = useState<ToolName>("select");
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
    try { const w = await (h as WritableHandle).createWritable(); await w.write(proseRef.current); await w.close(); } catch { /* ignore */ }
  }
  function scheduleAutosave() {
    if (!fileHandleRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => { if (fileHandleRef.current) void saveToHandle(fileHandleRef.current); }, 500);
  }
  function setTool(t: ToolName) { activeToolRef.current = t; setActiveTool(t); drawPreviewRef.current = null; textPlacementRef.current = null; }

  function loadDocument(text: string) {
    const cw = cwRef.current, ch = chRef.current;
    const { frames, prose, regions } = scanToFrames(text, cw, ch);
    const proseText = prose.map(p => p.text).join("\n\n");
    preparedRef.current = proseText.length > 0 ? prepareWithSegments(proseText, FONT, { whiteSpace: "pre-wrap" }) : null;
    let curY = 0, frameIdx = 0;
    for (const r of regions) {
      if (r.type === "prose") { curY += r.text.split("\n").length * LH; }
      else if (frameIdx < frames.length) { frames[frameIdx].y = curY; curY += frames[frameIdx].h; frameIdx++; }
    }
    proseRef.current = proseText;
    framesRef.current = frames;
    selectedRef.current = null;
    dragRef.current = null;
    proseCursorRef.current = null;
  }

  function doLayout() {
    if (!preparedRef.current) { linesRef.current = []; return; }
    linesRef.current = reflowLayout(preparedRef.current, sizeRef.current.w, LH, framesToObstacles(framesRef.current)).lines;
  }

  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w } = sizeRef.current;
    let contentH = 100;
    for (const line of linesRef.current) contentH = Math.max(contentH, line.y + LH);
    for (const f of framesRef.current) contentH = Math.max(contentH, f.y + f.h);
    contentH = Math.max(contentH + 40, sizeRef.current.h);
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.floor(w * dpr), ph = Math.floor(contentH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, w, contentH);
    ctx.font = FONT; ctx.fillStyle = FG_COLOR; ctx.textBaseline = "top";
    for (const line of linesRef.current) ctx.fillText(line.text, line.x, line.y);
    const cw = cwRef.current, ch = chRef.current;
    for (const frame of framesRef.current) renderFrame(ctx, frame, 0, 0, cw, ch);
    if (selectedRef.current) {
      const sel = findFrameById(framesRef.current, selectedRef.current);
      if (sel) renderFrameSelection(ctx, sel.frame, sel.absX, sel.absY);
    }
    // Prose cursor (blinking)
    const cursor = proseCursorRef.current;
    if (cursor && blinkRef.current) {
      const charWidth = getCharWidth();
      const srcLines = proseRef.current.split("\n");
      let srcRow = 0;
      for (const pl of linesRef.current) {
        if (srcRow === cursor.row) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(pl.x + cursor.col * charWidth, pl.y, 2, LH);
          break;
        }
        const srcLineText = srcLines[srcRow] ?? "";
        if (pl.text.length >= srcLineText.length) srcRow++;
      }
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

  function replaceFrame(frames: Frame[], id: string, newFrame: Frame): Frame[] {
    return frames.map(f => {
      if (f.id === id) return newFrame;
      if (f.children.length > 0) return { ...f, children: replaceFrame(f.children, id, newFrame) };
      return f;
    });
  }

  function buildTextCells(text: string): Map<string, string> {
    const cells = new Map<string, string>();
    const codepoints = [...text];
    for (let i = 0; i < codepoints.length; i++) cells.set(`0,${i}`, codepoints[i]);
    return cells;
  }

  function proseCursorFromClick(px: number, py: number): CursorPos | null {
    if (linesRef.current.length === 0) return null;
    const charWidth = getCharWidth();
    let best: PositionedLine | null = null, bestDist = Infinity;
    for (const pl of linesRef.current) {
      const dist = Math.abs(pl.y + LH / 2 - py);
      if (dist < bestDist) { bestDist = dist; best = pl; }
    }
    if (!best) return null;
    const srcLines = proseRef.current.split("\n");
    let srcRow = 0;
    for (const pl of linesRef.current) {
      if (pl === best) break;
      if (pl.text.length >= (srcLines[srcRow] ?? "").length) srcRow++;
    }
    const col = Math.max(0, Math.floor((px - best.x) / charWidth));
    return { row: srcRow, col: Math.min(col, (srcLines[srcRow] ?? "").length) };
  }

  function onMouseDown(e: React.MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top + (canvas.parentElement?.scrollTop ?? 0);
    const tool = activeToolRef.current;
    // Drawing tools only activate on empty space — clicking anything selects it + reverts to Select
    const preHit = hitTestFrames(framesRef.current, px, py);
    if (tool !== "select" && preHit) {
      setTool("select"); // auto-revert to select on click
    }
    if (!preHit && (tool === "rect" || tool === "line")) {
      drawPreviewRef.current = { startX: px, startY: py, curX: px, curY: py };
      paint(); return;
    }
    if (!preHit && tool === "text") {
      const cw = cwRef.current, ch = chRef.current;
      const snappedX = Math.floor(px / cw) * cw, snappedY = Math.floor(py / ch) * ch;
      textPlacementRef.current = { x: snappedX, y: snappedY, chars: "" };
      paint(); return;
    }
    if (selectedRef.current) {
      const sel = findFrameById(framesRef.current, selectedRef.current);
      if (sel) {
        const handleHit = hitTestHandle(computeHandleRects(sel.absX, sel.absY, sel.frame.w, sel.frame.h), px, py);
        if (handleHit) {
          dragRef.current = { frameId: sel.frame.id, startX: px, startY: py, startFrameX: sel.absX, startFrameY: sel.absY, startFrameW: sel.frame.w, startFrameH: sel.frame.h, hasMoved: false, resizeHandle: handleHit };
          paint(); return;
        }
      }
    }
    const hit = hitTestFrames(framesRef.current, px, py);
    const now = Date.now();
    const last = lastClickRef.current;
    const isDblClick = last !== null && now - last.time < 300 && Math.abs(px - last.px) < 10 && Math.abs(py - last.py) < 10;
    lastClickRef.current = { time: now, px, py };
    if (hit) {
      if (isDblClick && hit.content?.type === "text") {
        const found = findFrameById(framesRef.current, hit.id);
        if (found) {
          const cw2 = getCharWidth(), text = hit.content.text ?? "";
          const col = Math.max(0, Math.min(Math.round((px - found.absX) / cw2), [...text].length));
          textEditRef.current = { frameId: hit.id, col }; selectedRef.current = hit.id;
          proseCursorRef.current = null; dragRef.current = null;
          blinkRef.current = true; canvas.focus(); paint(); return;
        }
      }
      selectedRef.current = hit.id; proseCursorRef.current = null; textEditRef.current = null;
      const found = findFrameById(framesRef.current, hit.id);
      if (found) dragRef.current = { frameId: hit.id, startX: px, startY: py, startFrameX: found.absX, startFrameY: found.absY, startFrameW: found.frame.w, startFrameH: found.frame.h, hasMoved: false };
      paint();
    } else {
      selectedRef.current = null; dragRef.current = null;
      textEditRef.current = null;
      proseCursorRef.current = proseCursorFromClick(px, py);
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
    if (!drag) return;
    const dx = px - drag.startX, dy = py - drag.startY;
    if (!drag.hasMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    drag.hasMoved = true;
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
      const resized = resizeFrame(found.frame, { w: newW, h: newH }, cw, ch);
      const anchorX = drag.startFrameX + (newDx !== 0 ? drag.startFrameW : 0);
      const anchorY = drag.startFrameY + (newDy !== 0 ? drag.startFrameH : 0);
      const newAbsX = newDx !== 0 ? anchorX - resized.w : drag.startFrameX;
      const newAbsY = newDy !== 0 ? anchorY - resized.h : drag.startFrameY;
      const parentOffX = found.absX - found.frame.x, parentOffY = found.absY - found.frame.y;
      const finalFrame = moveFrame(resized, { dx: newAbsX - parentOffX - resized.x, dy: newAbsY - parentOffY - resized.y });
      framesRef.current = replaceFrame(framesRef.current, drag.frameId, finalFrame);
    } else {
      const newX = Math.max(0, drag.startFrameX + dx - (found.absX - found.frame.x));
      const newY = Math.max(0, drag.startFrameY + dy - (found.absY - found.frame.y));
      framesRef.current = replaceFrame(framesRef.current, drag.frameId, moveFrame(found.frame, { dx: newX - found.frame.x, dy: newY - found.frame.y }));
    }
    doLayout(); paint();
  }

  function onMouseUp() {
    if (dragRef.current) { dragRef.current = null; scheduleAutosave(); }
    const preview = drawPreviewRef.current;
    if (!preview) return;
    const cw = cwRef.current, ch = chRef.current;
    const tool = activeToolRef.current;
    const x1 = Math.min(preview.startX, preview.curX), y1 = Math.min(preview.startY, preview.curY);
    const x2 = Math.max(preview.startX, preview.curX), y2 = Math.max(preview.startY, preview.curY);
    drawPreviewRef.current = null;
    if (tool === "rect" && x2 - x1 >= cw && y2 - y1 >= ch) {
      const f = createRectFrame({ gridW: Math.max(2, Math.round((x2 - x1) / cw)), gridH: Math.max(2, Math.round((y2 - y1) / ch)), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: cw, charHeight: ch });
      framesRef.current = [...framesRef.current, { ...f, x: x1, y: y1 }]; scheduleAutosave();
    } else if (tool === "line") {
      const r1 = Math.round(preview.startY / ch), c1 = Math.round(preview.startX / cw), r2 = Math.round(preview.curY / ch), c2 = Math.round(preview.curX / cw);
      if (r1 !== r2 || c1 !== c2) { framesRef.current = [...framesRef.current, createLineFrame({ r1, c1, r2, c2, charWidth: cw, charHeight: ch })]; scheduleAutosave(); }
    }
    setTool("select"); // one-shot: revert to Select after drawing
    doLayout(); paint();
  }

  useEffect(() => {
    measureCellSize().then(() => {
      cwRef.current = getCharWidth(); chRef.current = getCharHeight();
      loadDocument(DEFAULT_TEXT); setReady(true);
    });
  }, []);

  useEffect(() => {
    const fn = () => { sizeRef.current = { w: window.innerWidth, h: window.innerHeight }; };
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
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "o") {
        e.preventDefault();
        try {
          const [handle] = await window.showOpenFilePicker({ types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }] });
          fileHandleRef.current = handle;
          const file = await handle.getFile();
          loadDocument(await file.text()); doLayout(); paint();
        } catch { /* cancelled */ }
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
            framesRef.current = [...framesRef.current, createTextFrame({ text: tp.chars, row: Math.round(tp.y / ch), col: Math.round(tp.x / cw), charWidth: cw, charHeight: ch })];
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
        if (!found || found.frame.content?.type !== "text") { textEditRef.current = null; paint(); return; }
        const frame = found.frame;
        const content = frame.content!;
        const text = content.text ?? "";
        const codepoints = [...text];
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          textEditRef.current = null; blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          textEditRef.current = { ...te, col: Math.max(0, te.col - 1) };
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          textEditRef.current = { ...te, col: Math.min(codepoints.length, te.col + 1) };
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          if (te.col > 0) {
            const newCp = [...codepoints.slice(0, te.col - 1), ...codepoints.slice(te.col)];
            const newText = newCp.join("");
            const newCells = buildTextCells(newText);
            const charWidth = getCharWidth();
            const newFrame: Frame = { ...frame, w: Math.max(newCp.length, 1) * charWidth, content: { ...content, text: newText, cells: newCells } };
            framesRef.current = replaceFrame(framesRef.current, te.frameId, newFrame);
            textEditRef.current = { ...te, col: te.col - 1 };
            scheduleAutosave();
          }
          blinkRef.current = true; paint(); return;
        }
        if (e.key.length === 1 && !mod) {
          e.preventDefault();
          const newCp = [...codepoints.slice(0, te.col), e.key, ...codepoints.slice(te.col)];
          const newText = newCp.join("");
          const newCells = buildTextCells(newText);
          const charWidth = getCharWidth();
          const newFrame: Frame = { ...frame, w: newCp.length * charWidth, content: { ...content, text: newText, cells: newCells } };
          framesRef.current = replaceFrame(framesRef.current, te.frameId, newFrame);
          textEditRef.current = { ...te, col: te.col + 1 };
          scheduleAutosave(); blinkRef.current = true; paint(); return;
        }
        return;
      }
      if (proseCursorRef.current) {
        const cursor = proseCursorRef.current;
        const lines = proseRef.current.split("\n");
        if (e.key === "Escape") { proseCursorRef.current = null; paint(); return; }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          proseCursorRef.current = cursor.col > 0 ? { ...cursor, col: cursor.col - 1 } : cursor.row > 0 ? { row: cursor.row - 1, col: (lines[cursor.row - 1] ?? "").length } : cursor;
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          const lineLen = (lines[cursor.row] ?? "").length;
          proseCursorRef.current = cursor.col < lineLen ? { ...cursor, col: cursor.col + 1 } : cursor.row < lines.length - 1 ? { row: cursor.row + 1, col: 0 } : cursor;
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (cursor.row > 0) proseCursorRef.current = { row: cursor.row - 1, col: Math.min(cursor.col, (lines[cursor.row - 1] ?? "").length) };
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (cursor.row < lines.length - 1) proseCursorRef.current = { row: cursor.row + 1, col: Math.min(cursor.col, (lines[cursor.row + 1] ?? "").length) };
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          const r = deleteChar(proseRef.current, cursor);
          proseRef.current = r.text; proseCursorRef.current = r.cursor;
          preparedRef.current = prepareWithSegments(proseRef.current, FONT, { whiteSpace: "pre-wrap" });
          scheduleAutosave(); doLayout(); blinkRef.current = true; paint(); return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const r = insertChar(proseRef.current, cursor, "\n");
          proseRef.current = r.text; proseCursorRef.current = r.cursor;
          preparedRef.current = prepareWithSegments(proseRef.current, FONT, { whiteSpace: "pre-wrap" });
          scheduleAutosave(); doLayout(); blinkRef.current = true; paint(); return;
        }
        if (e.key.length === 1 && !mod) {
          e.preventDefault();
          const r = insertChar(proseRef.current, cursor, e.key);
          proseRef.current = r.text; proseCursorRef.current = r.cursor;
          preparedRef.current = prepareWithSegments(proseRef.current, FONT, { whiteSpace: "pre-wrap" });
          scheduleAutosave(); doLayout(); blinkRef.current = true; paint(); return;
        }
        return;
      }
      // Global shortcuts (no prose cursor)
      if (e.key === "Escape") { selectedRef.current = null; paint(); }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedRef.current) {
        framesRef.current = framesRef.current.filter(f => f.id !== selectedRef.current).map(f => ({ ...f, children: f.children.filter(c => c.id !== selectedRef.current) }));
        selectedRef.current = null; doLayout(); paint();
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
    <div style={{ position: "fixed", inset: 0, overflow: "auto", background: "#141420" }}>
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
        style={{ display: "block", width: sizeRef.current.w, outline: "none", cursor: "default" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
    </div>
  );
}
