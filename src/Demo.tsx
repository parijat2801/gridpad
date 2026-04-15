/**
 * Demo.tsx — spatial canvas with prose reflow around frame obstacles.
 */
import { useEffect, useRef, useState } from "react";
import { scan } from "./scanner";
import { detectRegions } from "./regions";
import {
  createRectFrame, createLineFrame, createTextFrame,
  moveFrame, resizeFrame, framesToObstacles, framesFromRegions,
} from "./frame";
import type { Frame } from "./frame";
import { renderFrame, renderFrameSelection } from "./frameRenderer";
import { BG_COLOR, FG_COLOR, measureCellSize, getCharWidth, getCharHeight, FONT_SIZE, FONT_FAMILY } from "./grid";
import { LIGHT_RECT_STYLE, buildTextCells } from "./layers";
import { prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext";
import { reflowLayout, type PositionedLine } from "./reflowLayout";
import { DEMO_DEFAULT_TEXT } from "./demoDefaults";
import { handleProseKeyPress } from "./spatialKeyHandler";

export const SPATIAL_FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
export const SPATIAL_LH = Math.ceil(FONT_SIZE * 1.15);
const HS = 5; // handle half-size (matches frameRenderer HANDLE_SIZE=10)

type ActiveTool = "select" | "rect" | "line" | "text";
type ResizeHandle = "tl" | "tm" | "tr" | "ml" | "mr" | "bl" | "bm" | "br";

interface ProseCursor { row: number; col: number }
interface DrawGesture { tool: "rect" | "line"; frameId: string; startRow: number; startCol: number; endRow: number; endCol: number }
interface TextPlacement { frameId: string; row: number; col: number; buffer: string }
interface TextEdit { frameId: string; childId: string; col: number }
interface DragState {
  frameId: string; resizeHandle: ResizeHandle | null;
  startX: number; startY: number; startFX: number; startFY: number; startFW: number; startFH: number;
  pStartX: number; pStartY: number; moved: boolean;
}

function hitHandle(f: Frame, px: number, py: number): ResizeHandle | null {
  const pts: [ResizeHandle, number, number][] = [
    ["tl",f.x,f.y],["tm",f.x+f.w/2,f.y],["tr",f.x+f.w,f.y],
    ["ml",f.x,f.y+f.h/2],["mr",f.x+f.w,f.y+f.h/2],
    ["bl",f.x,f.y+f.h],["bm",f.x+f.w/2,f.y+f.h],["br",f.x+f.w,f.y+f.h],
  ];
  for (const [id,hx,hy] of pts) if (px>=hx-HS&&px<=hx+HS&&py>=hy-HS&&py<=hy+HS) return id;
  return null;
}
function handleCursor(h: ResizeHandle) {
  return (h==="tl"||h==="br")?"nwse-resize":(h==="tr"||h==="bl")?"nesw-resize":(h==="tm"||h==="bm")?"ns-resize":"ew-resize";
}

export default function Demo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const proseTextRef = useRef("");
  const preparedRef = useRef<PreparedTextWithSegments | null>(null);
  const framesRef = useRef<Frame[]>([]);
  const posLinesRef = useRef<PositionedLine[]>([]);
  const regionOrderRef = useRef<Array<{ type: "prose"|"wireframe"; frameId?: string }>>([]);
  const prosePartsRef = useRef<string[]>([]);
  const origTextRef = useRef<Map<string, string>>(new Map());
  const proseCursorRef = useRef<ProseCursor | null>(null);
  const blinkRef = useRef(true);
  const blinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const cwRef = useRef(0);
  const chRef = useRef(0);
  const selIdRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const drawGestureRef = useRef<DrawGesture | null>(null);
  const textPlacementRef = useRef<TextPlacement | null>(null);
  const textEditRef = useRef<TextEdit | null>(null);
  const lastClickRef = useRef<{time:number;px:number;py:number}|null>(null);
  const toolRef = useRef<ActiveTool>("select");
  const [activeTool, setActiveTool] = useState<ActiveTool>("select");
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, kick] = useState(0);

  const stopBlink = () => { if (blinkTimerRef.current) { clearInterval(blinkTimerRef.current); blinkTimerRef.current = null; } };
  const startBlink = () => { stopBlink(); blinkRef.current = true; blinkTimerRef.current = setInterval(() => { blinkRef.current = !blinkRef.current; paint(); }, 530); };
  const resetBlink = () => { blinkRef.current = true; startBlink(); };

  function updateFrame(f: Frame) { framesRef.current = framesRef.current.map(x => x.id === f.id ? f : x); }

  // ── Prose cursor pixel position ───────────────────────────
  function cursorDocPos(pc: ProseCursor): {x:number;y:number}|null {
    const lines = proseTextRef.current.split("\n");
    const cw = cwRef.current;
    let off = 0;
    for (let r = 0; r < pc.row; r++) off += (lines[r]??"").length + 1;
    off += pc.col;
    let consumed = 0;
    for (const line of posLinesRef.current) {
      const len = line.text.length;
      if (off <= consumed + len) return { x: line.x + (off - consumed) * cw, y: line.y };
      consumed += len;
      if (proseTextRef.current[consumed] === "\n") {
        if (off === consumed) return { x: line.x + len * cw, y: line.y };
        consumed++;
      }
    }
    const last = posLinesRef.current.at(-1);
    return last ? { x: last.x + last.text.length * cw, y: last.y } : { x:0, y:0 };
  }

  function findProseCursorAt(px: number, py: number): ProseCursor|null {
    const pl = posLinesRef.current;
    if (!pl.length) return null;
    const cw = cwRef.current;
    const text = proseTextRef.current;
    let ci = 0, cd = Infinity;
    for (let i = 0; i < pl.length; i++) {
      const d = Math.abs(py - (pl[i].y + SPATIAL_LH / 2));
      if (d < cd) { cd = d; ci = i; }
    }
    let consumed = 0;
    for (let i = 0; i < ci; i++) { consumed += pl[i].text.length; if (text[consumed]==="\n") consumed++; }
    const col = Math.max(0, Math.min(pl[ci].text.length, Math.round((px - pl[ci].x) / cw)));
    let rem = consumed + col;
    const srcLines = text.split("\n");
    for (let r = 0; r < srcLines.length; r++) {
      const len = (srcLines[r]??"").length;
      if (rem <= len) return { row: r, col: rem };
      rem -= len + 1;
    }
    return { row: srcLines.length - 1, col: (srcLines.at(-1)??"").length };
  }

  function buildDocText(): string {
    const parts: string[] = [];
    let pi = 0;
    for (const e of regionOrderRef.current) {
      if (e.type === "prose") parts.push(prosePartsRef.current[pi++] ?? "");
      else if (e.frameId) parts.push(origTextRef.current.get(e.frameId) ?? "");
    }
    return parts.join("\n\n");
  }

  // ── Document parsing ──────────────────────────────────────
  function loadDocument(text: string) {
    const regions = detectRegions(scan(text));
    const cw = cwRef.current, ch = chRef.current || 18;
    const proseParts = regions.filter(r => r.type === "prose").map(r => r.text);
    prosePartsRef.current = proseParts;
    proseTextRef.current = proseParts.join("\n\n");
    preparedRef.current = proseTextRef.current.length > 0
      ? prepareWithSegments(proseTextRef.current, SPATIAL_FONT, { whiteSpace: "pre-wrap" }) : null;

    const frames = framesFromRegions(regions, cw, ch).frames;
    const order: typeof regionOrderRef.current = [];
    const origMap = new Map<string, string>();
    let fi = 0;
    for (const r of regions) {
      if (r.type === "prose") { order.push({ type: "prose" }); }
      else { const f = frames[fi++]; if (f) { order.push({ type: "wireframe", frameId: f.id }); origMap.set(f.id, r.text); } }
    }
    regionOrderRef.current = order;
    origTextRef.current = origMap;

    // Two-pass y-position: lay out prose without obstacles to find visual line counts per prose part
    const W = sizeRef.current.w;
    const prepared = preparedRef.current;
    if (prepared && W > 0) {
      const vl = reflowLayout(prepared, W, SPATIAL_LH, []).lines;
      const pb: {start:number;end:number}[] = [];
      let off = 0;
      for (const p of proseParts) { pb.push({ start: off, end: off + p.length }); off += p.length + 2; }
      const proseText = proseTextRef.current;
      let cc = 0;
      const lso: number[] = [];
      for (const l of vl) { lso.push(cc); cc += l.text.length; if (proseText[cc]==="\n") cc++; }
      const lpp = proseParts.map(() => 0);
      for (let i = 0; i < vl.length; i++) {
        for (let p = 0; p < pb.length; p++) {
          if (lso[i] >= pb[p].start && lso[i] < pb[p].end) { lpp[p]++; break; }
        }
      }
      let curY = 0, ppi = 0, wfi = 0;
      for (const e of order) {
        if (e.type === "prose") { curY += (lpp[ppi++] ?? 0) * SPATIAL_LH; }
        else { const f = frames[wfi]; if (f) { frames[wfi] = { ...f, y: curY }; curY += f.h; } wfi++; }
      }
    }
    framesRef.current = frames;
  }

  function doLayout() {
    const p = preparedRef.current, W = sizeRef.current.w;
    if (!p || W <= 0) { posLinesRef.current = []; return; }
    posLinesRef.current = reflowLayout(p, W, SPATIAL_LH, framesToObstacles(framesRef.current)).lines;
  }

  // ── Paint ─────────────────────────────────────────────────
  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w } = sizeRef.current;
    const cw = cwRef.current, ch = chRef.current;
    let contentH = sizeRef.current.h;
    for (const l of posLinesRef.current) contentH = Math.max(contentH, l.y + SPATIAL_LH);
    for (const f of framesRef.current) contentH = Math.max(contentH, f.y + f.h);
    contentH += 40;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.floor(w * dpr), ph = Math.floor(contentH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1e1e2e"; ctx.fillRect(0, 0, w, contentH);
    ctx.font = SPATIAL_FONT; ctx.fillStyle = FG_COLOR; ctx.textBaseline = "top";
    for (const l of posLinesRef.current) ctx.fillText(l.text, l.x, l.y);
    for (const f of framesRef.current) renderFrame(ctx, f, 0, 0, cw, ch);
    const sel = selIdRef.current && framesRef.current.find(f => f.id === selIdRef.current);
    if (sel) renderFrameSelection(ctx, sel, sel.x, sel.y);
    const pc = proseCursorRef.current;
    if (pc && blinkRef.current) {
      const pos = cursorDocPos(pc);
      if (pos) { ctx.fillStyle = FG_COLOR; ctx.fillRect(pos.x, pos.y, 2, SPATIAL_LH); }
    }
    const te = textEditRef.current;
    if (te && blinkRef.current) {
      const pf = framesRef.current.find(f => f.id === te.frameId);
      const child = pf?.children.find(c => c.id === te.childId);
      if (pf && child) { ctx.fillStyle = FG_COLOR; ctx.fillRect(pf.x + child.x + te.col * cw, pf.y + child.y, 2, ch); }
    }
    const tp = textPlacementRef.current;
    if (tp && blinkRef.current) {
      const pf = framesRef.current.find(f => f.id === tp.frameId);
      if (pf) {
        const cx = pf.x + tp.col * cw, cy = pf.y + tp.row * ch;
        if (tp.buffer.length > 0) { ctx.fillStyle = "#4a90e2"; ctx.fillText(tp.buffer, cx, cy); }
        ctx.fillStyle = FG_COLOR; ctx.fillRect(cx + tp.buffer.length * cw, cy, 2, ch);
      }
    }
    const dg = drawGestureRef.current;
    if (dg) {
      const pf = framesRef.current.find(f => f.id === dg.frameId);
      if (pf) {
        ctx.save(); ctx.strokeStyle = "#4a90e2"; ctx.lineWidth = 1.5; ctx.setLineDash([4,3]);
        if (dg.tool === "rect") {
          const [r1,r2,c1,c2] = [Math.min(dg.startRow,dg.endRow),Math.max(dg.startRow,dg.endRow),Math.min(dg.startCol,dg.endCol),Math.max(dg.startCol,dg.endCol)];
          ctx.strokeRect(pf.x+c1*cw, pf.y+r1*ch, (c2-c1+1)*cw, (r2-r1+1)*ch);
        } else {
          const isH = Math.abs(dg.endCol-dg.startCol) >= Math.abs(dg.endRow-dg.startRow);
          ctx.beginPath();
          if (isH) { const y=pf.y+dg.startRow*ch+ch/2; ctx.moveTo(pf.x+dg.startCol*cw,y); ctx.lineTo(pf.x+(dg.endCol+1)*cw,y); }
          else { const x=pf.x+dg.startCol*cw+cw/2; ctx.moveTo(x,pf.y+Math.min(dg.startRow,dg.endRow)*ch); ctx.lineTo(x,pf.y+(Math.max(dg.startRow,dg.endRow)+1)*ch); }
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  function scheduleAutosave() {
    if (!fileHandleRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      try { const w = await fileHandleRef.current!.createWritable(); await w.write(buildDocText()); await w.close(); }
      catch (e) { console.error("Autosave failed:", e); }
    }, 500);
  }

  function getCanvasCoords(e: React.MouseEvent): {px:number;py:number} {
    const r = canvasRef.current!.getBoundingClientRect();
    const scrollTop = canvasRef.current!.parentElement?.scrollTop ?? 0;
    return { px: e.clientX - r.left, py: e.clientY - r.top + scrollTop };
  }

  function getOrCreateFrame(px: number, py: number): Frame {
    for (const f of framesRef.current) if (px>=f.x&&px<f.x+f.w&&py>=f.y&&py<f.y+f.h) return f;
    const ch = chRef.current, cw = cwRef.current;
    const f: Frame = { id:`frame-${Date.now()}`, x:0, y:Math.floor(py/ch)*ch, w:40*cw, h:8*ch, children:[], content:null, clip:true };
    framesRef.current = [...framesRef.current, f];
    regionOrderRef.current = [...regionOrderRef.current, { type:"wireframe", frameId:f.id }];
    return f;
  }

  // ── Effects ───────────────────────────────────────────────
  useEffect(() => {
    measureCellSize().then(() => { cwRef.current = getCharWidth(); chRef.current = getCharHeight(); loadDocument(DEMO_DEFAULT_TEXT); setReady(true); });
  }, []);

  useEffect(() => {
    const fn = () => { sizeRef.current = { w: window.innerWidth, h: window.innerHeight }; kick(t=>t+1); };
    window.addEventListener("resize", fn); return () => window.removeEventListener("resize", fn);
  }, []);

  useEffect(() => {
    const fn = async (e: KeyboardEvent) => {
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      const cw = cwRef.current, ch = chRef.current;
      // Text placement
      const tp = textPlacementRef.current;
      if (tp && !mod) {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          if (tp.buffer.length > 0) {
            const { cells, content } = buildTextCells(tp.row, tp.col, tp.buffer);
            if (content.length > 0) {
              const child = createTextFrame({ text:content, row:tp.row, col:tp.col, charWidth:cw, charHeight:ch });
              const withCells: Frame = { ...child, content:{ type:"text", cells, text:content } };
              const pf = framesRef.current.find(f=>f.id===tp.frameId);
              if (pf) { updateFrame({ ...pf, children:[...pf.children, withCells] }); selIdRef.current = pf.id; scheduleAutosave(); }
            }
          }
          textPlacementRef.current = null; stopBlink(); paint(); return;
        }
        if (e.key === "Backspace") { e.preventDefault(); if (tp.buffer.length>0) { textPlacementRef.current={...tp,buffer:tp.buffer.slice(0,-1)}; resetBlink(); paint(); } return; }
        if (e.key.length === 1) { e.preventDefault(); textPlacementRef.current={...tp,buffer:tp.buffer+e.key}; resetBlink(); paint(); return; }
      }
      // Text edit
      const te = textEditRef.current;
      if (te && !mod) {
        const pf = framesRef.current.find(f=>f.id===te.frameId);
        const child = pf?.children.find(c=>c.id===te.childId);
        if (pf && child && child.content?.type==="text") {
          const content = child.content.text ?? "";
          if (e.key==="Escape"||e.key==="Enter") { e.preventDefault(); textEditRef.current=null; stopBlink(); paint(); return; }
          if (e.key==="ArrowLeft") { e.preventDefault(); textEditRef.current={...te,col:Math.max(0,te.col-1)}; resetBlink(); paint(); return; }
          if (e.key==="ArrowRight") { e.preventDefault(); textEditRef.current={...te,col:Math.min(content.length,te.col+1)}; resetBlink(); paint(); return; }
          if (e.key==="Backspace"&&te.col>0) {
            e.preventDefault();
            const nc = content.slice(0,te.col-1)+content.slice(te.col);
            const { cells } = buildTextCells(0,0,nc);
            const uc: Frame = { ...child, content:{...child.content,cells,text:nc}, w:Math.max(cw,nc.length*cw) };
            updateFrame({ ...pf, children:pf.children.map(c=>c.id===te.childId?uc:c) });
            textEditRef.current={...te,col:te.col-1}; resetBlink(); paint(); return;
          }
          if (e.key.length===1) {
            e.preventDefault();
            const nc = content.slice(0,te.col)+e.key+content.slice(te.col);
            const { cells } = buildTextCells(0,0,nc);
            const uc: Frame = { ...child, content:{...child.content,cells,text:nc}, w:Math.max(cw,nc.length*cw) };
            updateFrame({ ...pf, children:pf.children.map(c=>c.id===te.childId?uc:c) });
            textEditRef.current={...te,col:te.col+1}; resetBlink(); paint(); return;
          }
        }
      }
      // Prose cursor
      const pc = proseCursorRef.current;
      if (pc && !mod) {
        const result = handleProseKeyPress(e, { regionIdx:0, row:pc.row, col:pc.col }, proseTextRef.current);
        if (result) {
          e.preventDefault();
          if (result.newText !== null) {
            proseTextRef.current = result.newText;
            if (prosePartsRef.current.length > 0) prosePartsRef.current = [result.newText, ...prosePartsRef.current.slice(1).map(()=>"")];
            preparedRef.current = prepareWithSegments(proseTextRef.current, SPATIAL_FONT, { whiteSpace:"pre-wrap" });
            doLayout(); scheduleAutosave();
          }
          proseCursorRef.current = result.cursor ? { row:result.cursor.row, col:result.cursor.col } : null;
          if (!result.cursor) stopBlink(); else if (result.resetBlink) resetBlink();
          paint(); return;
        }
      }
      if ((e.key==="Delete"||e.key==="Backspace") && selIdRef.current) {
        e.preventDefault(); framesRef.current = framesRef.current.filter(f=>f.id!==selIdRef.current);
        selIdRef.current=null; doLayout(); paint(); return;
      }
      if (e.key === "Escape") {
        e.preventDefault(); selIdRef.current=null; proseCursorRef.current=null;
        textEditRef.current=null; textPlacementRef.current=null; drawGestureRef.current=null;
        stopBlink(); paint(); return;
      }
      if (!textEditRef.current && !textPlacementRef.current && !proseCursorRef.current && !mod) {
        const map: Record<string,ActiveTool> = { v:"select",V:"select",r:"rect",R:"rect",l:"line",L:"line",t:"text",T:"text" };
        if (map[e.key]) { e.preventDefault(); toolRef.current=map[e.key]; setActiveTool(map[e.key]); return; }
      }
      if (mod && e.key==="o") {
        e.preventDefault();
        try {
          const [h] = await window.showOpenFilePicker({ types:[{description:"Markdown",accept:{"text/markdown":[".md"]}}] });
          fileHandleRef.current = h;
          loadDocument(await (await h.getFile()).text());
          selIdRef.current=null; dragRef.current=null; proseCursorRef.current=null; stopBlink(); kick(t=>t+1);
        } catch { /* cancelled */ }
      } else if (mod && e.key==="s") {
        e.preventDefault();
        if (!fileHandleRef.current) return;
        try { const w = await fileHandleRef.current.createWritable(); await w.write(buildDocText()); await w.close(); }
        catch (err) { console.error("Save failed:", err); }
      }
    };
    window.addEventListener("keydown", fn); return () => window.removeEventListener("keydown", fn);
  }, []);

  useEffect(() => () => stopBlink(), []);
  useEffect(() => { if (ready) { doLayout(); paint(); } });

  // ── Mouse handlers ────────────────────────────────────────
  function onMouseDown(e: React.MouseEvent) {
    if (!canvasRef.current) return;
    canvasRef.current.focus();
    const { px, py } = getCanvasCoords(e);
    const cw = cwRef.current, ch = chRef.current;
    const tool = toolRef.current;
    if (tool === "rect" || tool === "line") {
      const f = getOrCreateFrame(px, py);
      const row = Math.max(0,Math.floor((py-f.y)/ch)), col = Math.max(0,Math.floor((px-f.x)/cw));
      drawGestureRef.current = { tool, frameId:f.id, startRow:row, startCol:col, endRow:row, endCol:col };
      proseCursorRef.current=null; textEditRef.current=null; textPlacementRef.current=null; stopBlink(); paint(); return;
    }
    if (tool === "text") {
      const f = getOrCreateFrame(px, py);
      const row = Math.max(0,Math.floor((py-f.y)/ch)), col = Math.max(0,Math.floor((px-f.x)/cw));
      textPlacementRef.current = { frameId:f.id, row, col, buffer:"" };
      proseCursorRef.current=null; textEditRef.current=null; drawGestureRef.current=null; selIdRef.current=null;
      canvasRef.current.focus(); resetBlink(); paint(); return;
    }
    // Select: check resize handles on selected frame
    const prevSel = selIdRef.current && framesRef.current.find(f=>f.id===selIdRef.current);
    if (prevSel) {
      const h = hitHandle(prevSel, px, py);
      if (h) {
        proseCursorRef.current=null; textEditRef.current=null; stopBlink();
        dragRef.current = { frameId:prevSel.id, resizeHandle:h, startX:px, startY:py, startFX:prevSel.x, startFY:prevSel.y, startFW:prevSel.w, startFH:prevSel.h, pStartX:px, pStartY:py, moved:false };
        paint(); return;
      }
    }
    // Hit-test frames
    const hit = framesRef.current.find(f=>px>=f.x&&px<f.x+f.w&&py>=f.y&&py<f.y+f.h);
    if (hit) {
      const now = Date.now(), last = lastClickRef.current;
      const dbl = last && now-last.time<300 && Math.abs(px-last.px)<cw*2 && Math.abs(py-last.py)<ch*2;
      lastClickRef.current = { time:now, px, py };
      if (dbl) {
        for (const child of hit.children) {
          if (child.content?.type==="text") {
            const ax=hit.x+child.x, ay=hit.y+child.y;
            if (px>=ax&&px<ax+child.w&&py>=ay&&py<ay+child.h) {
              const t = child.content.text??"";
              textEditRef.current = { frameId:hit.id, childId:child.id, col:Math.max(0,Math.min(t.length,Math.round((px-ax)/cw))) };
              proseCursorRef.current=null; selIdRef.current=hit.id; drawGestureRef.current=null;
              canvasRef.current.focus(); resetBlink(); paint(); return;
            }
          }
        }
      }
      proseCursorRef.current=null; textEditRef.current=null; stopBlink(); selIdRef.current=hit.id;
      dragRef.current = { frameId:hit.id, resizeHandle:null, startX:px, startY:py, startFX:hit.x, startFY:hit.y, startFW:hit.w, startFH:hit.h, pStartX:px, pStartY:py, moved:false };
      paint();
    } else {
      selIdRef.current=null; dragRef.current=null; textEditRef.current=null;
      const c = findProseCursorAt(px, py);
      proseCursorRef.current = c; if (c) resetBlink(); else stopBlink(); paint();
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!canvasRef.current) return;
    const { px, py } = getCanvasCoords(e);
    const cw = cwRef.current, ch = chRef.current;
    const dg = drawGestureRef.current;
    if (dg) {
      const f = framesRef.current.find(f=>f.id===dg.frameId);
      if (f) { const row=Math.max(0,Math.floor((py-f.y)/ch)), col=Math.max(0,Math.floor((px-f.x)/cw)); drawGestureRef.current={...dg,endRow:row,endCol:col}; paint(); }
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved) {
      const dx=px-drag.pStartX, dy=py-drag.pStartY;
      if (Math.sqrt(dx*dx+dy*dy) < 3) return;
      drag.moved = true;
    }
    const f = framesRef.current.find(f=>f.id===drag.frameId);
    if (!f) return;
    if (drag.resizeHandle) {
      const h=drag.resizeHandle, dx=px-drag.startX, dy=py-drag.startY;
      let nx=drag.startFX, ny=drag.startFY, nw=drag.startFW, nh=drag.startFH;
      if (h==="tl"||h==="ml"||h==="bl") { nx+=dx; nw-=dx; }
      if (h==="tr"||h==="mr"||h==="br") nw+=dx;
      if (h==="tl"||h==="tm"||h==="tr") { ny+=dy; nh-=dy; }
      if (h==="bl"||h==="bm"||h==="br") nh+=dy;
      const resized = resizeFrame(f, { w:nw, h:nh }, cw, ch);
      updateFrame({ ...resized, x:Math.max(0,nx), y:Math.max(0,ny) });
      doLayout(); paint();
    } else {
      const moved = moveFrame(f, { dx:Math.max(0,drag.startFX+(px-drag.startX))-f.x, dy:Math.max(0,drag.startFY+(py-drag.startY))-f.y });
      updateFrame(moved); doLayout(); paint();
    }
  }

  function onMouseUp() {
    const dg = drawGestureRef.current;
    if (dg) {
      drawGestureRef.current = null;
      const f = framesRef.current.find(fr=>fr.id===dg.frameId);
      if (f) {
        const cw=cwRef.current, ch=chRef.current;
        const [r1,r2,c1,c2]=[dg.startRow,dg.endRow,dg.startCol,dg.endCol];
        if (dg.tool==="rect" && (Math.abs(r2-r1)>=1||Math.abs(c2-c1)>=1)) {
          const [mr,MC,mc,Mc]=[Math.min(r1,r2),Math.max(r1,r2),Math.min(c1,c2),Math.max(c1,c2)];
          const child = createRectFrame({ gridW:Mc-mc+1, gridH:MC-mr+1, style:LIGHT_RECT_STYLE, charWidth:cw, charHeight:ch });
          const positioned: Frame = { ...child, x:mc*cw, y:mr*ch };
          updateFrame({ ...f, children:[...f.children,positioned], w:Math.max(f.w,positioned.x+positioned.w), h:Math.max(f.h,positioned.y+positioned.h) });
          selIdRef.current=f.id; doLayout(); scheduleAutosave();
        } else if (dg.tool==="line" && (Math.abs(r2-r1)>=1||Math.abs(c2-c1)>=1)) {
          const child = createLineFrame({ r1, c1, r2, c2, charWidth:cw, charHeight:ch });
          updateFrame({ ...f, children:[...f.children,child], w:Math.max(f.w,child.x+child.w), h:Math.max(f.h,child.y+child.h) });
          selIdRef.current=f.id; doLayout(); scheduleAutosave();
        }
      }
      paint(); return;
    }
    if (dragRef.current) { if (dragRef.current.moved) scheduleAutosave(); dragRef.current=null; paint(); }
  }

  // ── Render ────────────────────────────────────────────────
  if (!ready) return <div style={{ background:BG_COLOR, width:"100vw", height:"100vh" }} />;
  const drag = dragRef.current;
  const cursor = activeTool==="rect"||activeTool==="line" ? "crosshair"
    : activeTool==="text" ? "text"
    : drag?.resizeHandle ? handleCursor(drag.resizeHandle)
    : drag?.moved ? "grabbing" : "default";
  const tbStyle = (a:boolean): React.CSSProperties => ({
    display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
    width:44,height:44,borderRadius:8,border:"none",background:a?"#4a90e2":"transparent",
    color:a?"#fff":"#c9c9d4",cursor:"pointer",gap:2,padding:0,transition:"background 0.12s ease",flexShrink:0,
  });
  const tools: Array<{id:ActiveTool;icon:string;label:string;key:string}> = [
    {id:"select",icon:"↖",label:"Select",key:"V"},{id:"rect",icon:"□",label:"Rect",key:"R"},
    {id:"line",icon:"╱",label:"Line",key:"L"},{id:"text",icon:"T",label:"Text",key:"T"},
  ];
  return (
    <div style={{ position:"fixed",top:0,left:0,width:"100vw",height:"100vh" }}>
      <div style={{ position:"fixed",top:12,left:"50%",transform:"translateX(-50%)",display:"flex",alignItems:"center",
        gap:2,padding:"4px 6px",background:"#2b2b33",borderRadius:10,
        boxShadow:"0 4px 16px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.3)",zIndex:100,userSelect:"none" }}>
        {tools.map(({id,icon,label,key})=>(
          <button key={id} title={`${label} (${key})`}
            onClick={()=>{toolRef.current=id;setActiveTool(id);canvasRef.current?.focus();}}
            style={tbStyle(activeTool===id)}>
            <span style={{fontSize:16,lineHeight:1}}>{icon}</span>
            <span style={{fontSize:9,opacity:activeTool===id?0.9:0.5,lineHeight:1}}>{key}</span>
          </button>
        ))}
        <div style={{width:1,height:28,background:"#444455",margin:"0 4px",flexShrink:0}}/>
        <button title="Open (⌘O)" onClick={()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"o",metaKey:true,bubbles:true}))} style={tbStyle(false)}>
          <span style={{fontSize:16,lineHeight:1}}>📂</span><span style={{fontSize:9,opacity:0.5,lineHeight:1}}>⌘O</span>
        </button>
        <button title="Save (⌘S)" onClick={()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"s",metaKey:true,bubbles:true}))} style={tbStyle(false)}>
          <span style={{fontSize:16,lineHeight:1}}>💾</span><span style={{fontSize:9,opacity:0.5,lineHeight:1}}>⌘S</span>
        </button>
      </div>
      <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,overflow:"auto",background:"#141420"}}>
        <canvas ref={canvasRef} tabIndex={0}
          style={{display:"block",width:sizeRef.current.w,minHeight:sizeRef.current.h,outline:"none",cursor:drawGestureRef.current?"crosshair":cursor}}
          onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}/>
      </div>
    </div>
  );
}
