/**
 * Demo.tsx — thin shell for the Pretext + Wireframe spatial canvas.
 *
 * Logic lives in:
 *   spatialLayout.ts     — layoutRegions()
 *   spatialPaint.ts      — paintCanvas(), getCursorStyle()
 *   spatialHitTest.ts    — findLayerAt(), findProseAt(), detectResizeEdge()
 *   spatialTextEdit.ts   — apply*() helpers
 *   spatialKeyHandler.ts — handleProseKeyPress(), handleWireframeKeyPress()
 */
import { useEffect, useRef, useState } from "react";
import { scan } from "./scanner";
import { detectRegions, type Region } from "./regions";
import { compositeLayers } from "./layers";
import { buildSparseRows } from "./KonvaCanvas";
import { BG_COLOR, measureCellSize, getCharWidth, getCharHeight } from "./grid";
import { layoutRegions, type LayoutRegion } from "./spatialLayout";
import { paintCanvas, getCursorStyle, type WireframeTextEdit } from "./spatialPaint";
import { findLayerAt, findProseAt, detectResizeEdge, type ProseCursor, type ResizeEdge } from "./spatialHitTest";
import {
  applyDragToText, applyResizeToText, applyLiveDrag, applyLiveResize, applyWireframeTextEdit,
} from "./spatialTextEdit";
import { handleProseKeyPress, handleWireframeKeyPress } from "./spatialKeyHandler";
import { DEMO_DEFAULT_TEXT } from "./demoDefaults";

const EDGE_THRESHOLD = 1;
type GestureMode = "drag" | "resize";
interface GestureState {
  mode: GestureMode; regionIdx: number; layerId: string;
  startBbox: { row: number; col: number; w: number; h: number };
  startMX: number; startMY: number; edges: ResizeEdge;
}

export default function Demo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const docTextRef = useRef(DEMO_DEFAULT_TEXT);
  const scrollYRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const laidRef = useRef<LayoutRegion[]>([]);
  const cwRef = useRef(0);
  const chRef = useRef(0);
  const regionsRef = useRef<Region[]>([]);
  const gestureRef = useRef<GestureState | null>(null);
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const proseCursorRef = useRef<ProseCursor | null>(null);
  const blinkVisibleRef = useRef(true);
  const blinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wireframeTextEditRef = useRef<WireframeTextEdit | null>(null);
  const lastClickRef = useRef<{ time: number; px: number; docY: number } | null>(null);
  const [, forceRender] = useState(0);
  const kick = () => forceRender(t => t + 1);

  // ── Wiring helpers ─────────────────────────────────────
  function doLayout() {
    laidRef.current = layoutRegions(regionsRef.current, sizeRef.current.w, cwRef.current, chRef.current);
  }
  function paint() {
    const canvas = canvasRef.current; if (!canvas) return;
    const { w, h } = sizeRef.current;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    paintCanvas(canvas.getContext("2d")!, laidRef.current, w, h, scrollYRef.current,
      cwRef.current, chRef.current, selectedIdRef.current,
      proseCursorRef.current, wireframeTextEditRef.current, blinkVisibleRef.current);
  }
  function startBlink() {
    if (blinkTimerRef.current) clearInterval(blinkTimerRef.current);
    blinkVisibleRef.current = true;
    blinkTimerRef.current = setInterval(() => { blinkVisibleRef.current = !blinkVisibleRef.current; paint(); }, 530);
  }
  function stopBlink() {
    if (blinkTimerRef.current) { clearInterval(blinkTimerRef.current); blinkTimerRef.current = null; }
    blinkVisibleRef.current = true;
  }
  function resetBlink() { blinkVisibleRef.current = true; if (!blinkTimerRef.current) startBlink(); }
  function stitchDoc() { docTextRef.current = laidRef.current.map(l => l.region.text).join("\n\n"); }
  function scheduleAutosave() {
    if (!fileHandleRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      const h = fileHandleRef.current; if (!h) return;
      try { const w = await h.createWritable(); await w.write(docTextRef.current); await w.close(); }
      catch (e) { console.error("Autosave failed:", e); }
    }, 500);
  }
  function commitWireframeTextEdit() {
    if (!wireframeTextEditRef.current) return;
    stitchDoc(); scheduleAutosave(); wireframeTextEditRef.current = null; stopBlink();
  }

  // ── Effects ─────────────────────────────────────────────
  useEffect(() => {
    measureCellSize().then(() => {
      cwRef.current = getCharWidth(); chRef.current = getCharHeight();
      regionsRef.current = detectRegions(scan(docTextRef.current));
      setReady(true); // triggers re-render → useEffect calls doLayout + paint
    });
  }, []);
  useEffect(() => {
    const fn = () => { sizeRef.current = { w: window.innerWidth, h: window.innerHeight }; kick(); };
    window.addEventListener("resize", fn); return () => window.removeEventListener("resize", fn);
  }, []);
  useEffect(() => {
    const fn = async (e: KeyboardEvent) => {
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "o") {
        e.preventDefault();
        try {
          const [handle] = await window.showOpenFilePicker({ types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }] });
          fileHandleRef.current = handle;
          docTextRef.current = await (await handle.getFile()).text();
          regionsRef.current = detectRegions(scan(docTextRef.current));
          scrollYRef.current = 0; selectedIdRef.current = null; gestureRef.current = null;
          proseCursorRef.current = null; stopBlink(); kick();
        } catch { /* cancelled */ }
      } else if (mod && e.key === "s") {
        e.preventDefault();
        const h = fileHandleRef.current; if (!h) return;
        try { const w = await h.createWritable(); await w.write(docTextRef.current); await w.close(); }
        catch (e) { console.error("Save failed:", e); }
      } else if (wireframeTextEditRef.current) {
        onWireframeTextKey(e);
      } else {
        onProseKey(e);
      }
    };
    window.addEventListener("keydown", fn); return () => window.removeEventListener("keydown", fn);
  }, []);
  // On every render: ensure layout is computed and canvas is painted.
  // doLayout is cheap (no scan) — just Pretext measurement + composite.
  useEffect(() => { if (ready) { doLayout(); paint(); } });
  useEffect(() => () => stopBlink(), []);

  // ── Key handlers ────────────────────────────────────────
  function onProseKey(e: KeyboardEvent) {
    const pc = proseCursorRef.current; if (!pc) return;
    const lr = laidRef.current[pc.regionIdx];
    if (!lr || lr.region.type !== "prose") return;
    const result = handleProseKeyPress(e, pc, lr.region.text);
    if (!result) return;
    if (result.preventDefault) e.preventDefault();
    if (result.stopBlink) stopBlink();
    if (result.resetBlink) resetBlink();
    proseCursorRef.current = result.cursor;
    if (result.newText !== null) { lr.region.text = result.newText; stitchDoc(); scheduleAutosave(); }
    if (result.needsLayout) doLayout();
    paint();
  }

  function onWireframeTextKey(e: KeyboardEvent) {
    const wte = wireframeTextEditRef.current; if (!wte) return;
    const lr = laidRef.current[wte.lrIdx];
    if (!lr || lr.region.type !== "wireframe" || !lr.region.layers) return;
    const layer = lr.region.layers.find(l => l.id === wte.layerId);
    if (!layer || layer.type !== "text") return;
    const result = handleWireframeKeyPress(e, wte.col, layer.content ?? "");
    if (!result) return;
    if (result.preventDefault) e.preventDefault();
    if (result.resetBlink) resetBlink();
    if (result.commit) { commitWireframeTextEdit(); doLayout(); paint(); return; }
    if (result.newContent !== null) {
      const upd = applyWireframeTextEdit(lr.region.text, layer.bbox, layer.content ?? "", result.newContent);
      layer.cells = upd.cells; layer.content = upd.content; layer.bbox = upd.bbox;
      lr.region.text = upd.regionText;
      lr.sparse = buildSparseRows(compositeLayers(lr.region.layers!));
    }
    wireframeTextEditRef.current = { ...wte, col: result.col! };
    paint();
  }

  // ── Mouse handlers ──────────────────────────────────────
  function onMouseDown(e: React.MouseEvent) {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left; const docY = e.clientY - rect.top + scrollYRef.current;
    const cw = cwRef.current; const ch = chRef.current;
    const now = Date.now(); const last = lastClickRef.current;
    const isDouble = last !== null && now - last.time < 300 &&
      Math.abs(px - last.px) < cw * 2 && Math.abs(docY - last.docY) < ch * 2;
    lastClickRef.current = { time: now, px, docY };
    const hit = findLayerAt(laidRef.current, px, docY, cw, ch);
    if (hit) {
      if (isDouble && hit.layer.type === "text") {
        proseCursorRef.current = null; gestureRef.current = null; selectedIdRef.current = hit.layer.id;
        const col = Math.max(0, Math.min([...(hit.layer.content ?? "")].length, Math.floor(px / cw) - hit.layer.bbox.col));
        wireframeTextEditRef.current = { lrIdx: hit.lrIdx, layerId: hit.layer.id, col };
        canvasRef.current?.focus(); startBlink(); paint(); return;
      }
      commitWireframeTextEdit(); proseCursorRef.current = null; selectedIdRef.current = hit.layer.id;
      const lr = laidRef.current[hit.lrIdx];
      const gridRow = Math.floor((docY - lr.y) / ch); const gridCol = Math.floor(px / cw);
      const edges = hit.layer.type === "rect" && hit.layer.style
        ? detectResizeEdge(hit.layer, gridRow, gridCol, EDGE_THRESHOLD) : null;
      gestureRef.current = { mode: edges ? "resize" : "drag", regionIdx: hit.lrIdx, layerId: hit.layer.id,
        startBbox: { ...hit.layer.bbox }, startMX: px, startMY: docY,
        edges: edges ?? { top: false, bottom: false, left: false, right: false } };
      paint();
    } else {
      commitWireframeTextEdit();
      const proseHit = findProseAt(laidRef.current, px, docY, cw, ch, 0, sizeRef.current.w);
      if (proseHit) {
        proseCursorRef.current = proseHit; selectedIdRef.current = null; gestureRef.current = null;
        canvasRef.current?.focus(); startBlink(); paint();
      } else {
        proseCursorRef.current = null; stopBlink(); selectedIdRef.current = null; gestureRef.current = null; paint();
      }
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const g = gestureRef.current; if (!g) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left; const docY = e.clientY - rect.top + scrollYRef.current;
    const dCol = Math.round((px - g.startMX) / cwRef.current);
    const dRow = Math.round((docY - g.startMY) / chRef.current);
    if (dCol === 0 && dRow === 0) return;
    const lr = laidRef.current[g.regionIdx]; if (!lr?.region.layers) return;
    const layer = lr.region.layers.find(l => l.id === g.layerId); if (!layer) return;
    if (g.mode === "drag") {
      const upd = applyLiveDrag(layer, g.startBbox, dRow, dCol); if (!upd) return;
      layer.cells = upd.cells; layer.bbox.row = upd.newRow; layer.bbox.col = upd.newCol;
    } else {
      const upd = applyLiveResize(layer, g.startBbox, dRow, dCol, g.edges); if (!upd) return;
      layer.bbox = upd.bbox; layer.cells = upd.cells;
    }
    lr.sparse = buildSparseRows(compositeLayers(lr.region.layers));
    paint();
  }

  function onMouseUp() {
    const g = gestureRef.current; if (!g) return;
    const lr = laidRef.current[g.regionIdx];
    if (lr?.region.type === "wireframe" && lr.region.layers) {
      const totalRows = lr.region.endRow - lr.region.startRow + 1;
      lr.region.text = g.mode === "drag"
        ? applyDragToText(lr.region.text, lr.region.layers, g.layerId, g.startBbox, totalRows)
        : applyResizeToText(lr.region.text, lr.region.layers, g.layerId, g.startBbox, totalRows);
      stitchDoc();
    }
    gestureRef.current = null; scheduleAutosave(); doLayout(); paint();
  }

  function onWheel(e: React.WheelEvent) {
    const totalH = laidRef.current.reduce((s, r) => s + r.height, 0);
    scrollYRef.current = Math.max(0, Math.min(Math.max(0, totalH - sizeRef.current.h), scrollYRef.current + e.deltaY));
    paint();
  }

  if (!ready) return <div style={{ background: BG_COLOR, width: "100vw", height: "100vh" }} />;
  const g = gestureRef.current;
  return (
    <canvas ref={canvasRef} tabIndex={0}
      style={{ background: BG_COLOR, display: "block", position: "fixed", top: 0, left: 0,
        width: sizeRef.current.w, height: sizeRef.current.h, outline: "none",
        cursor: getCursorStyle(g ? g.mode : null, g ? g.edges : null) }}
      onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
    />
  );
}
