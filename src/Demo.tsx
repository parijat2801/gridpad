/**
 * Demo.tsx — spatial canvas with prose reflow around wireframe obstacles.
 *
 * Model:
 *   proseTextRef      — all prose from document concatenated with "\n\n"
 *   preparedRef       — cached Pretext PreparedTextWithSegments
 *   wireframesRef     — array of Wireframe obstacles (full-width, vertical-only drag)
 *   posLinesRef       — output of reflowLayout(): PositionedLine[]
 *
 * On every paint cycle:
 *   reflowLayout(prepared, canvasWidth, LH, obstacles) → positioned lines
 *   Draw positioned lines at their (x, y) coordinates
 *   Draw wireframes at their pixel (x, y) positions
 *
 * Drag model (v1):
 *   Wireframes always span full canvas width (x=0, w=canvasWidth)
 *   They can only be dragged vertically (change y only)
 *   Text reflows in real-time around dragged wireframe
 */
import { useEffect, useRef, useState } from "react";
import { scan } from "./scanner";
import { detectRegions } from "./regions";
import { compositeLayers, moveLayer, regenerateCells, buildTextCells } from "./layers";
import type { Layer } from "./layers";
import { buildSparseRows, type SparseRow } from "./KonvaCanvas";
import {
  BG_COLOR, FG_COLOR, measureCellSize, getCharWidth, getCharHeight,
  FONT_SIZE, FONT_FAMILY,
} from "./grid";
import { prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext";
import { reflowLayout, type PositionedLine, type Obstacle } from "./reflowLayout";
import { DEMO_DEFAULT_TEXT } from "./demoDefaults";
import { handleProseKeyPress } from "./spatialKeyHandler";
import { detectResizeEdge } from "./spatialHitTest";
import type { ResizeEdge } from "./spatialHitTest";

export const SPATIAL_FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
export const SPATIAL_LH = Math.ceil(FONT_SIZE * 1.15);

// ── Wireframe type ───────────────────────────────────────
export interface Wireframe {
  id: string;
  /** Pixel x — always 0 for v1 (full-width) */
  x: number;
  /** Pixel y — vertical position in document space */
  y: number;
  /** Pixel width — always canvasWidth for v1 */
  w: number;
  /** Pixel height */
  h: number;
  layers: Layer[];
  sparse: SparseRow[];
  /** Original text from the file for this wireframe region */
  originalText: string;
}

// ── Prose cursor ─────────────────────────────────────────
interface ProseCursorState {
  /** Source line index in proseTextRef.split("\n") */
  row: number;
  /** Character offset within that source line */
  col: number;
}

// ── Drag state ───────────────────────────────────────────
interface DragState {
  wireframeId: string;
  /** If set, we are dragging an individual layer (not the whole wireframe) */
  layerId?: string;
  /** Layer's bbox at drag start, in wireframe-local grid coords */
  startBbox?: { row: number; col: number; w: number; h: number };
  startY: number;   // pixel docY at drag start
  startWfY: number; // wireframe.y at drag start
  /** pixel mouseX at drag start (for layer column delta) */
  startMX?: number;
  /** If set, this is a resize gesture (not a move) */
  resizeEdge?: ResizeEdge;
}

export default function Demo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  // Data model
  const proseTextRef = useRef<string>("");
  const preparedRef = useRef<PreparedTextWithSegments | null>(null);
  const wireframesRef = useRef<Wireframe[]>([]);
  const posLinesRef = useRef<PositionedLine[]>([]);

  // Region order for correct document reconstruction on save
  const regionOrderRef = useRef<Array<{ type: "prose" | "wireframe"; wireframeId?: string }>>([]);
  // Individual prose parts (one per prose region) for reconstruction
  const prosePartsRef = useRef<string[]>([]);

  // Prose cursor + blink
  const proseCursorRef = useRef<ProseCursorState | null>(null);
  const blinkVisibleRef = useRef(true);
  const blinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Scroll + UI state
  const scrollYRef = useRef(0);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const cwRef = useRef(0);
  const chRef = useRef(0);
  /** Selected wireframe id (for whole-wf selection highlight + block drag) */
  const selectedIdRef = useRef<string | null>(null);
  /** Selected individual layer id within a wireframe */
  const selectedLayerIdRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // Wireframe text label editing
  const wireframeTextEditRef = useRef<{ wfId: string; layerId: string; col: number } | null>(null);
  // Double-click detection
  const lastClickRef = useRef<{ time: number; px: number; docY: number } | null>(null);

  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [, forceRender] = useState(0);
  const kick = () => forceRender(t => t + 1);

  // ── Blink cursor ─────────────────────────────────────────
  function startBlink() {
    stopBlink();
    blinkVisibleRef.current = true;
    blinkTimerRef.current = setInterval(() => {
      blinkVisibleRef.current = !blinkVisibleRef.current;
      paint();
    }, 530);
  }

  function stopBlink() {
    if (blinkTimerRef.current) {
      clearInterval(blinkTimerRef.current);
      blinkTimerRef.current = null;
    }
  }

  function resetBlink() {
    blinkVisibleRef.current = true;
    startBlink();
  }

  // ── Compute prose cursor pixel position ──────────────────
  /**
   * Map {row, col} source cursor to document-space pixel {x, y}.
   * Walk visual lines from posLinesRef, accumulating consumed source chars.
   */
  function cursorDocPos(cursor: ProseCursorState): { x: number; y: number } | null {
    const text = proseTextRef.current;
    const sourceLines = text.split("\n");
    const cw = cwRef.current;

    // Linear offset of cursor in source text
    let targetOffset = 0;
    for (let r = 0; r < cursor.row; r++) {
      targetOffset += (sourceLines[r] ?? "").length + 1; // +1 for \n
    }
    targetOffset += cursor.col;

    const posLines = posLinesRef.current;
    let consumed = 0;
    for (let i = 0; i < posLines.length; i++) {
      const line = posLines[i];
      const lineLen = line.text.length;
      if (targetOffset <= consumed + lineLen) {
        const colInLine = targetOffset - consumed;
        return { x: line.x + colInLine * cw, y: line.y };
      }
      consumed += lineLen;
      // If the source text has a \n here (source line break), skip it
      if (text[consumed] === "\n") {
        if (targetOffset === consumed) {
          return { x: line.x + lineLen * cw, y: line.y };
        }
        consumed += 1;
      }
    }

    // Past all visual lines — place at end of last line
    const last = posLines[posLines.length - 1];
    if (last) {
      return { x: last.x + last.text.length * cw, y: last.y };
    }
    return { x: 0, y: 0 };
  }

  // ── Find prose cursor position from click ────────────────
  function findProseCursorAt(px: number, docY: number): ProseCursorState | null {
    const posLines = posLinesRef.current;
    if (posLines.length === 0) return null;

    const cw = cwRef.current;
    const text = proseTextRef.current;

    // Find the visual line closest to the click (by y midpoint)
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let i = 0; i < posLines.length; i++) {
      const dist = Math.abs(docY - (posLines[i].y + SPATIAL_LH / 2));
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }

    const closestLine = posLines[closestIdx];

    // Walk visual lines 0..closestIdx-1, accumulating consumed source chars
    let consumed = 0;
    for (let i = 0; i < closestIdx; i++) {
      const line = posLines[i];
      consumed += line.text.length;
      if (text[consumed] === "\n") consumed += 1;
    }

    // Col within the visual line based on x click
    const colInLine = Math.max(
      0,
      Math.min(closestLine.text.length, Math.round((px - closestLine.x) / cw)),
    );
    const offsetInSource = consumed + colInLine;

    // Convert linear offset → { row, col } in source lines
    const sourceLines = text.split("\n");
    let remaining = offsetInSource;
    for (let r = 0; r < sourceLines.length; r++) {
      const lineLen = (sourceLines[r] ?? "").length;
      if (remaining <= lineLen) {
        return { row: r, col: remaining };
      }
      remaining -= lineLen + 1; // +1 for \n
    }

    // Past end — clamp to last line
    const lastRow = sourceLines.length - 1;
    return { row: lastRow, col: (sourceLines[lastRow] ?? "").length };
  }

  // ── Build full document text from region order ───────────
  function buildDocText(): string {
    const order = regionOrderRef.current;
    const proseParts = prosePartsRef.current;
    const wireframes = wireframesRef.current;
    let proseIdx = 0;
    const parts: string[] = [];
    for (const entry of order) {
      if (entry.type === "prose") {
        parts.push(proseParts[proseIdx] ?? "");
        proseIdx++;
      } else {
        const wf = wireframes.find(w => w.id === entry.wireframeId);
        if (wf) parts.push(wf.originalText);
      }
    }
    return parts.join("\n\n");
  }

  // ── Document parsing ─────────────────────────────────────
  function loadDocument(text: string) {
    const scanResult = scan(text);
    const regions = detectRegions(scanResult);

    // Concatenate all prose text and build region order + prose parts
    const proseParts: string[] = [];
    regions.forEach(r => {
      if (r.type === "prose") proseParts.push(r.text);
    });
    prosePartsRef.current = proseParts;
    proseTextRef.current = proseParts.join("\n\n");

    // Build prepared text (cached — re-created on content change)
    if (proseTextRef.current.length > 0) {
      preparedRef.current = prepareWithSegments(
        proseTextRef.current,
        SPATIAL_FONT,
        { whiteSpace: "pre-wrap" },
      );
    } else {
      preparedRef.current = null;
    }

    // Build wireframe objects
    // We need to assign initial pixel y-positions for wireframes.
    // Strategy: simulate a pass where prose fills canvasWidth, then
    // place wireframes at their natural document order position.
    // For initial load we use a simple estimate: lay out all regions in order
    // at the current canvas width.
    const cw = canvasRef.current?.width ?? sizeRef.current.w;
    const wireframes: Wireframe[] = [];
    const regionOrder: Array<{ type: "prose" | "wireframe"; wireframeId?: string }> = [];

    // Do a quick sequential layout pass to figure out initial y positions
    let curY = 0;
    // We need to know how many prose lines came before each wireframe to
    // estimate its initial y. Use a full reflow pass after setting wireframes.
    // For now: assign sequential y based on prose blocks above each wireframe.
    // We'll do a proper reflow after assigning initial positions.

    // First pass: assign temporary y positions based on sequential order
    const ch = chRef.current || 18; // fallback
    for (const r of regions) {
      if (r.type === "wireframe") {
        const rowCount = r.endRow - r.startRow + 1;
        const h = rowCount * ch;
        const layers = r.layers ?? [];
        const comp = compositeLayers(layers);
        const sparse = buildSparseRows(comp);
        const wfId = `wf-${wireframes.length}`;
        wireframes.push({
          id: wfId,
          x: 0,
          y: curY,
          w: cw,
          h,
          layers,
          sparse,
          originalText: r.text,
        });
        regionOrder.push({ type: "wireframe", wireframeId: wfId });
        curY += h;
      } else {
        // Estimate prose height: rough line count * LH
        const lines = r.text.split("\n");
        curY += lines.length * SPATIAL_LH;
        regionOrder.push({ type: "prose" });
      }
    }
    regionOrderRef.current = regionOrder;

    wireframesRef.current = wireframes;
  }

  // ── Layout + Paint ──────────────────────────────────────
  function doLayout() {
    const prepared = preparedRef.current;
    const canvasWidth = sizeRef.current.w;
    const wireframes = wireframesRef.current;

    if (!prepared || canvasWidth <= 0) {
      posLinesRef.current = [];
      return;
    }

    // Build obstacles from wireframes
    const obstacles: Obstacle[] = wireframes.map(wf => ({
      x: wf.x,
      y: wf.y,
      w: canvasWidth, // full width for v1
      h: wf.h,
    }));

    const result = reflowLayout(prepared, canvasWidth, SPATIAL_LH, obstacles);
    posLinesRef.current = result.lines;
  }

  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = sizeRef.current;

    // Retina / HiDPI: set physical pixel size to CSS pixel size * devicePixelRatio
    const dpr = window.devicePixelRatio || 1;
    const physW = Math.floor(w * dpr);
    const physH = Math.floor(h * dpr);
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width = physW;
      canvas.height = physH;
    }

    const ctx = canvas.getContext("2d")!;
    // Scale all drawing operations so coordinates remain in CSS pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scrollY = scrollYRef.current;
    const cw = cwRef.current;
    const ch = chRef.current;

    ctx.clearRect(0, 0, w, h);

    // Draw prose lines
    ctx.font = SPATIAL_FONT;
    ctx.fillStyle = FG_COLOR;
    ctx.textBaseline = "top";
    for (const line of posLinesRef.current) {
      const screenY = line.y - scrollY;
      if (screenY + SPATIAL_LH < 0 || screenY > h) continue;
      ctx.fillText(line.text, line.x, screenY);
    }

    // Draw wireframes
    for (const wf of wireframesRef.current) {
      const top = wf.y - scrollY;
      if (top + wf.h < 0 || top > h) continue;

      ctx.font = SPATIAL_FONT;
      ctx.fillStyle = FG_COLOR;
      ctx.textBaseline = "top";

      for (const { row, startCol, text } of wf.sparse) {
        // Use fillText per row for Retina sharpness (atlas drawImage is low-res)
        ctx.fillText(text, startCol * cw, top + row * ch);
      }

      // Draw selection highlight
      if (selectedLayerIdRef.current !== null) {
        // Individual layer selected within this wireframe
        const selLayer = wf.layers.find(l => l.id === selectedLayerIdRef.current);
        if (selLayer) {
          const { row, col, w: bw, h: bh } = selLayer.bbox;
          ctx.strokeStyle = "#4a90e2";
          ctx.lineWidth = 2;
          ctx.strokeRect(
            wf.x + col * cw + 1,
            top + row * ch + 1,
            bw * cw - 2,
            bh * ch - 2,
          );

          // Draw resize handles for rect layers with style
          if (selLayer.type === "rect" && selLayer.style) {
            const hx = wf.x + col * cw;
            const hy = top + row * ch;
            const hw = bw * cw;
            const hh = bh * ch;
            const hs = 6; // handle size in pixels
            const handlePositions = [
              { x: hx,           y: hy           }, // top-left
              { x: hx + hw / 2,  y: hy           }, // top-mid
              { x: hx + hw,      y: hy           }, // top-right
              { x: hx,           y: hy + hh / 2  }, // mid-left
              { x: hx + hw,      y: hy + hh / 2  }, // mid-right
              { x: hx,           y: hy + hh       }, // bottom-left
              { x: hx + hw / 2,  y: hy + hh       }, // bottom-mid
              { x: hx + hw,      y: hy + hh       }, // bottom-right
            ];
            ctx.fillStyle = "#4a90e2";
            for (const hp of handlePositions) {
              ctx.fillRect(hp.x - hs / 2, hp.y - hs / 2, hs, hs);
            }
          }
        }
      } else if (selectedIdRef.current !== null && wf.id === selectedIdRef.current) {
        // Whole wireframe selected
        ctx.strokeStyle = "#4a90e2";
        ctx.lineWidth = 2;
        ctx.strokeRect(wf.x + 1, top + 1, wf.w - 2, wf.h - 2);
      }
    }

    // Draw prose cursor
    const pc = proseCursorRef.current;
    if (pc && blinkVisibleRef.current) {
      const pos = cursorDocPos(pc);
      if (pos) {
        const screenY = pos.y - scrollY;
        ctx.fillStyle = FG_COLOR;
        ctx.fillRect(pos.x, screenY, 2, SPATIAL_LH);
      }
    }

    // Draw wireframe text edit cursor
    const wte = wireframeTextEditRef.current;
    if (wte && blinkVisibleRef.current) {
      const wf = wireframesRef.current.find(w => w.id === wte.wfId);
      const layer = wf?.layers.find(l => l.id === wte.layerId);
      if (wf && layer && layer.type === "text") {
        const cursorX = (layer.bbox.col + wte.col) * cw;
        const cursorY = wf.y - scrollY + layer.bbox.row * ch;
        ctx.fillStyle = FG_COLOR;
        ctx.fillRect(cursorX, cursorY, 2, ch);
      }
    }
  }

  // ── Schedule autosave ───────────────────────────────────
  function scheduleAutosave() {
    if (!fileHandleRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      const handle = fileHandleRef.current;
      if (!handle) return;
      // Reconstruct document text from wireframe originalText + prose
      // For v1 we just save the original document text unchanged unless
      // prose was edited (prose editing not wired in this version)
      try {
        const w = await handle.createWritable();
        await w.write(buildDocText());
        await w.close();
      } catch (e) {
        console.error("Autosave failed:", e);
      }
    }, 500);
  }

  // ── Effects ──────────────────────────────────────────────
  useEffect(() => {
    measureCellSize().then(() => {
      cwRef.current = getCharWidth();
      chRef.current = getCharHeight();
      loadDocument(DEMO_DEFAULT_TEXT);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const fn = () => {
      sizeRef.current = { w: window.innerWidth, h: window.innerHeight };
      // Update wireframe widths when canvas resizes
      wireframesRef.current = wireframesRef.current.map(wf => ({
        ...wf,
        w: window.innerWidth,
      }));
      kick();
    };
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  useEffect(() => {
    const fn = async (e: KeyboardEvent) => {
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;

      // ── Wireframe text label editing ─────────────────────
      const wte = wireframeTextEditRef.current;
      if (wte && !mod) {
        const wf = wireframesRef.current.find(w => w.id === wte.wfId);
        const layer = wf?.layers.find(l => l.id === wte.layerId);
        if (wf && layer && layer.type === "text") {
          const content = layer.content ?? "";

          if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault();
            wireframeTextEditRef.current = null;
            stopBlink();
            paint();
            return;
          }

          if (e.key === "ArrowLeft") {
            e.preventDefault();
            wireframeTextEditRef.current = { ...wte, col: Math.max(0, wte.col - 1) };
            resetBlink();
            paint();
            return;
          }

          if (e.key === "ArrowRight") {
            e.preventDefault();
            wireframeTextEditRef.current = { ...wte, col: Math.min(content.length, wte.col + 1) };
            resetBlink();
            paint();
            return;
          }

          if (e.key === "Backspace") {
            e.preventDefault();
            if (wte.col > 0) {
              const newContent = content.slice(0, wte.col - 1) + content.slice(wte.col);
              const { cells, content: fc, bbox } = buildTextCells(layer.bbox.row, layer.bbox.col, newContent);
              const layerIdx = wf.layers.findIndex(l => l.id === wte.layerId);
              wf.layers = [
                ...wf.layers.slice(0, layerIdx),
                { ...layer, cells, content: fc, bbox: { ...bbox, w: Math.max(1, fc.length) } },
                ...wf.layers.slice(layerIdx + 1),
              ];
              wf.sparse = buildSparseRows(compositeLayers(wf.layers));
              wireframeTextEditRef.current = { ...wte, col: wte.col - 1 };
              resetBlink();
              paint();
            }
            return;
          }

          // Printable character insertion
          if (e.key.length === 1) {
            e.preventDefault();
            const newContent = content.slice(0, wte.col) + e.key + content.slice(wte.col);
            const { cells, content: fc, bbox } = buildTextCells(layer.bbox.row, layer.bbox.col, newContent);
            const layerIdx = wf.layers.findIndex(l => l.id === wte.layerId);
            wf.layers = [
              ...wf.layers.slice(0, layerIdx),
              { ...layer, cells, content: fc, bbox: { ...bbox, w: Math.max(1, fc.length) } },
              ...wf.layers.slice(layerIdx + 1),
            ];
            wf.sparse = buildSparseRows(compositeLayers(wf.layers));
            wireframeTextEditRef.current = { ...wte, col: wte.col + 1 };
            resetBlink();
            paint();
            return;
          }
        }
      }

      // ── Prose cursor keyboard handling ──────────────────
      const pc = proseCursorRef.current;
      if (pc && !mod) {
        const result = handleProseKeyPress(
          e,
          { regionIdx: 0, row: pc.row, col: pc.col },
          proseTextRef.current,
        );
        if (result) {
          e.preventDefault();
          if (result.newText !== null) {
            proseTextRef.current = result.newText;
            // Keep prosePartsRef in sync: distribute updated text back into prose parts.
            // Simple v1 strategy: assign updated flat text to first prose region only;
            // subsequent prose regions become empty (they were joined via "\n\n").
            if (prosePartsRef.current.length > 0) {
              prosePartsRef.current = [result.newText, ...prosePartsRef.current.slice(1).map(() => "")];
            }
            preparedRef.current = prepareWithSegments(
              proseTextRef.current,
              SPATIAL_FONT,
              { whiteSpace: "pre-wrap" },
            );
            doLayout();
            scheduleAutosave();
          }
          if (result.cursor === null) {
            proseCursorRef.current = null;
            stopBlink();
          } else {
            proseCursorRef.current = { row: result.cursor.row, col: result.cursor.col };
            if (result.resetBlink) resetBlink();
          }
          paint();
          return;
        }
      }

      // ── Layer/selection keyboard shortcuts ──────────────
      if (e.key === "Delete" || e.key === "Backspace") {
        const selLayerId = selectedLayerIdRef.current;
        if (selLayerId) {
          e.preventDefault();
          // Find the wireframe containing the selected layer
          const wf = wireframesRef.current.find(w =>
            w.layers.some(l => l.id === selLayerId),
          );
          if (wf) {
            wf.layers = wf.layers.filter(l => l.id !== selLayerId);
            wf.sparse = buildSparseRows(compositeLayers(wf.layers));
          }
          selectedLayerIdRef.current = null;
          selectedIdRef.current = null;
          paint();
          return;
        }
      }

      if (e.key === "Escape") {
        e.preventDefault();
        selectedIdRef.current = null;
        selectedLayerIdRef.current = null;
        proseCursorRef.current = null;
        wireframeTextEditRef.current = null;
        stopBlink();
        paint();
        return;
      }

      if (mod && e.key === "o") {
        e.preventDefault();
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
          });
          fileHandleRef.current = handle;
          const text = await (await handle.getFile()).text();
          loadDocument(text);
          scrollYRef.current = 0;
          selectedIdRef.current = null;
          selectedLayerIdRef.current = null;
          dragRef.current = null;
          proseCursorRef.current = null;
          stopBlink();
          kick();
        } catch {
          /* cancelled */
        }
      } else if (mod && e.key === "s") {
        e.preventDefault();
        const handle = fileHandleRef.current;
        if (!handle) return;
        try {
          const w = await handle.createWritable();
          await w.write(buildDocText());
          await w.close();
        } catch (e) {
          console.error("Save failed:", e);
        }
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  // Cleanup blink timer on unmount
  useEffect(() => {
    return () => stopBlink();
  }, []);

  // On every render: layout + paint
  useEffect(() => {
    if (ready) {
      doLayout();
      paint();
    }
  });

  // ── Mouse handlers ──────────────────────────────────────
  function hitTestWireframe(px: number, docY: number): Wireframe | null {
    for (const wf of wireframesRef.current) {
      if (
        px >= wf.x && px <= wf.x + wf.w &&
        docY >= wf.y && docY <= wf.y + wf.h
      ) {
        return wf;
      }
    }
    return null;
  }

  function onMouseDown(e: React.MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const docY = e.clientY - rect.top + scrollYRef.current;

    const wf = hitTestWireframe(px, docY);
    if (wf) {
      const cw = cwRef.current;
      const ch = chRef.current;
      // Convert click to wireframe-local grid coords
      const gridRow = Math.floor((docY - wf.y) / ch);
      const gridCol = Math.floor(px / cw);

      // Find the topmost layer (highest z) whose bbox contains this grid cell
      const sortedLayers = [...wf.layers]
        .filter(l => l.visible && l.type !== "group")
        .sort((a, b) => b.z - a.z); // descending z — topmost first
      const hitLayer = sortedLayers.find(l =>
        gridRow >= l.bbox.row &&
        gridRow < l.bbox.row + l.bbox.h &&
        gridCol >= l.bbox.col &&
        gridCol < l.bbox.col + l.bbox.w,
      ) ?? null;

      // Check for double-click on a text layer
      const now = Date.now();
      const last = lastClickRef.current;
      const isDoubleClick =
        last !== null &&
        now - last.time < 300 &&
        Math.abs(px - last.px) < cw * 2 &&
        Math.abs(docY - last.docY) < ch * 2;
      lastClickRef.current = { time: now, px, docY };

      if (isDoubleClick && hitLayer && hitLayer.type === "text") {
        // Enter wireframe text label editing mode
        const colInContent = Math.max(
          0,
          Math.min(
            hitLayer.content?.length ?? 0,
            gridCol - hitLayer.bbox.col,
          ),
        );
        wireframeTextEditRef.current = {
          wfId: wf.id,
          layerId: hitLayer.id,
          col: colInContent,
        };
        proseCursorRef.current = null;
        selectedIdRef.current = null;
        selectedLayerIdRef.current = hitLayer.id;
        dragRef.current = null;
        canvas.focus();
        resetBlink();
        paint();
        return;
      }

      // Clear prose cursor when clicking into a wireframe
      proseCursorRef.current = null;
      // Clear wireframe text edit if clicking elsewhere
      wireframeTextEditRef.current = null;
      stopBlink();

      if (hitLayer) {
        // Individual layer selected
        selectedIdRef.current = null;
        selectedLayerIdRef.current = hitLayer.id;

        // Check if this is a resize gesture (rect layer with style, near edge)
        let resizeEdge: ResizeEdge | undefined;
        if (hitLayer.type === "rect" && hitLayer.style) {
          const edge = detectResizeEdge(hitLayer, gridRow, gridCol, 1);
          if (edge) resizeEdge = edge;
        }

        dragRef.current = {
          wireframeId: wf.id,
          layerId: hitLayer.id,
          startBbox: { ...hitLayer.bbox },
          startY: docY,
          startWfY: wf.y,
          startMX: px,
          resizeEdge,
        };
      } else {
        // Whole wireframe block drag
        selectedIdRef.current = wf.id;
        selectedLayerIdRef.current = null;
        dragRef.current = {
          wireframeId: wf.id,
          startY: docY,
          startWfY: wf.y,
        };
      }
      paint();
    } else {
      selectedIdRef.current = null;
      selectedLayerIdRef.current = null;
      dragRef.current = null;
      // Try to place prose cursor in prose area
      const cursor = findProseCursorAt(px, docY);
      if (cursor) {
        proseCursorRef.current = cursor;
        resetBlink();
      } else {
        proseCursorRef.current = null;
        stopBlink();
      }
      paint();
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const docY = e.clientY - rect.top + scrollYRef.current;

    const wf = wireframesRef.current.find(w => w.id === drag.wireframeId);
    if (!wf) return;

    if (drag.layerId && drag.startBbox && drag.startMX !== undefined) {
      // Individual layer drag or resize — no reflow, just recomposite within wireframe
      const cw = cwRef.current;
      const ch = chRef.current;
      const deltaRow = Math.round((docY - drag.startY) / ch);
      const deltaCol = Math.round((px - drag.startMX) / cw);

      const layerIdx = wf.layers.findIndex(l => l.id === drag.layerId);
      if (layerIdx !== -1) {
        const layer = wf.layers[layerIdx];

        if (drag.resizeEdge && layer.style) {
          // Resize gesture — compute new bbox from startBbox + delta + edges
          const sb = drag.startBbox;
          const edge = drag.resizeEdge;
          let newRow = sb.row;
          let newCol = sb.col;
          let newW = sb.w;
          let newH = sb.h;

          if (edge.top) {
            newRow = sb.row + deltaRow;
            newH = sb.h - deltaRow;
          }
          if (edge.bottom) {
            newH = sb.h + deltaRow;
          }
          if (edge.left) {
            newCol = sb.col + deltaCol;
            newW = sb.w - deltaCol;
          }
          if (edge.right) {
            newW = sb.w + deltaCol;
          }

          // Clamp minimum size to 2x2
          if (newW < 2) {
            if (edge.left) newCol = sb.col + sb.w - 2;
            newW = 2;
          }
          if (newH < 2) {
            if (edge.top) newRow = sb.row + sb.h - 2;
            newH = 2;
          }

          const newBbox = { row: newRow, col: newCol, w: newW, h: newH };
          const newCells = regenerateCells(newBbox, layer.style);
          const resizedLayer: Layer = { ...layer, bbox: newBbox, cells: newCells };
          wf.layers = [
            ...wf.layers.slice(0, layerIdx),
            resizedLayer,
            ...wf.layers.slice(layerIdx + 1),
          ];
          wf.sparse = buildSparseRows(compositeLayers(wf.layers));
          // Recalculate wireframe obstacle height from layer bounds
          let maxRow = 0;
          for (const l of wf.layers) {
            maxRow = Math.max(maxRow, l.bbox.row + l.bbox.h);
          }
          wf.h = maxRow * chRef.current;
          doLayout(); // reflow prose around resized wireframe
          paint();
        } else {
          // Move gesture
          const newRow = drag.startBbox.row + deltaRow;
          const newCol = drag.startBbox.col + deltaCol;
          const actualDeltaRow = newRow - layer.bbox.row;
          const actualDeltaCol = newCol - layer.bbox.col;
          if (actualDeltaRow !== 0 || actualDeltaCol !== 0) {
            const movedLayer = moveLayer(layer, actualDeltaRow, actualDeltaCol);
            wf.layers = [
              ...wf.layers.slice(0, layerIdx),
              movedLayer,
              ...wf.layers.slice(layerIdx + 1),
            ];
            // Recomposite wireframe (wireframe position unchanged — no reflow)
            wf.sparse = buildSparseRows(compositeLayers(wf.layers));
            // Keep selectedLayerIdRef in sync (id is unchanged)
            paint();
          }
        }
      }
    } else {
      // Whole wireframe block drag — reflow text around updated position
      const dy = docY - drag.startY;
      const newY = Math.max(0, drag.startWfY + dy);
      wf.y = newY;
      doLayout();
      paint();
    }
  }

  function onMouseUp() {
    if (dragRef.current) {
      dragRef.current = null;
      scheduleAutosave();
    }
  }

  function onWheel(e: React.WheelEvent) {
    // Estimate total doc height from last positioned line + wireframes below it
    let totalH = 0;
    if (posLinesRef.current.length > 0) {
      const last = posLinesRef.current[posLinesRef.current.length - 1];
      totalH = Math.max(totalH, last.y + SPATIAL_LH);
    }
    for (const wf of wireframesRef.current) {
      totalH = Math.max(totalH, wf.y + wf.h);
    }
    scrollYRef.current = Math.max(
      0,
      Math.min(Math.max(0, totalH - sizeRef.current.h), scrollYRef.current + e.deltaY),
    );
    paint();
  }

  if (!ready) return <div style={{ background: BG_COLOR, width: "100vw", height: "100vh" }} />;

  const isDragging = dragRef.current !== null;
  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      style={{
        background: BG_COLOR,
        display: "block",
        position: "fixed",
        top: 0,
        left: 0,
        width: sizeRef.current.w,
        height: sizeRef.current.h,
        outline: "none",
        cursor: isDragging ? "grabbing" : "text",
      }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    />
  );
}
