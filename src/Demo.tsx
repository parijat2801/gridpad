/**
 * Demo.tsx — spatial canvas with prose reflow around wireframe obstacles.
 *
 * Model:
 *   proseTextRef      — all prose from document concatenated with "\n\n"
 *   preparedRef       — cached Pretext PreparedTextWithSegments
 *   wireframesRef     — array of Wireframe obstacles (real x/w positions)
 *   posLinesRef       — output of reflowLayout(): PositionedLine[]
 *
 * On every paint cycle:
 *   reflowLayout(prepared, canvasWidth, LH, obstacles) → positioned lines
 *   Draw positioned lines at their (x, y) coordinates
 *   Draw wireframes at their pixel (x, y) positions
 *
 * Drag model:
 *   Wireframes have real x/w based on content bbox — text flows on both sides
 *   They can be dragged both horizontally and vertically
 *   Text reflows in real-time around dragged wireframe
 */
import { useEffect, useRef, useState } from "react";
import { scan } from "./scanner";
import { detectRegions } from "./regions";
import { compositeLayers, moveLayer, regenerateCells, buildTextCells, buildLineCells, LIGHT_RECT_STYLE } from "./layers";
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
  /** Pixel x — horizontal position in document space */
  x: number;
  /** Pixel y — vertical position in document space */
  y: number;
  /** Pixel width — actual content width (not full canvas) */
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

// ── Drawing tool types ────────────────────────────────────
type ActiveTool = "select" | "rect" | "line" | "text";

/** Active draw gesture for rect/line tools (start grid coords within wireframe) */
interface DrawGestureState {
  tool: "rect" | "line";
  /** Wireframe being drawn into (may be null if creating a new wireframe) */
  wfId: string | null;
  /** New wireframe y position when wfId is null */
  newWfY?: number;
  /** Start grid row in wireframe-local coords */
  startRow: number;
  /** Start grid col in wireframe-local coords */
  startCol: number;
  /** Current end row (updated on mousemove) */
  endRow: number;
  /** Current end col */
  endCol: number;
}

/** Active text placement state */
interface TextPlacementState {
  wfId: string | null;
  newWfY?: number;
  row: number;
  col: number;
  buffer: string;
}

const TOOLBAR_HEIGHT = 32;

// ── Drag state ───────────────────────────────────────────
interface DragState {
  wireframeId: string;
  /** If set, we are dragging an individual layer (not the whole wireframe) */
  layerId?: string;
  /** Layer's bbox at drag start, in wireframe-local grid coords */
  startBbox?: { row: number; col: number; w: number; h: number };
  startY: number;   // pixel docY at drag start
  startWfY: number; // wireframe.y at drag start
  startX: number;   // pixel mouseX at drag start (for whole-wireframe horizontal drag)
  startWfX: number; // wireframe.x at drag start
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

  // Drawing tool state
  const activeToolRef = useRef<ActiveTool>("select");
  const drawGestureRef = useRef<DrawGestureState | null>(null);
  const textPlacementRef = useRef<TextPlacementState | null>(null);
  const [activeTool, setActiveTool] = useState<ActiveTool>("select");

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
    let prepared: PreparedTextWithSegments | null = null;
    if (proseTextRef.current.length > 0) {
      prepared = prepareWithSegments(
        proseTextRef.current,
        SPATIAL_FONT,
        { whiteSpace: "pre-wrap" },
      );
      preparedRef.current = prepared;
    } else {
      preparedRef.current = null;
    }

    // Build wireframe objects
    const canvasWidth = sizeRef.current.w;
    const wireframes: Wireframe[] = [];
    const regionOrder: Array<{ type: "prose" | "wireframe"; wireframeId?: string }> = [];
    const ch = chRef.current || 18; // fallback

    for (const r of regions) {
      if (r.type === "wireframe") {
        const rowCount = r.endRow - r.startRow + 1;
        const h = rowCount * ch;
        const layers = r.layers ?? [];
        const comp = compositeLayers(layers);
        const sparse = buildSparseRows(comp);
        const wfId = `wf-${wireframes.length}`;

        // Compute real content width from layer bboxes
        let maxCol = 0;
        for (const l of layers) {
          maxCol = Math.max(maxCol, l.bbox.col + l.bbox.w);
        }
        // Fallback: scan sparse rows for widest content
        if (maxCol === 0) {
          for (const row of sparse) {
            maxCol = Math.max(maxCol, row.startCol + row.text.length);
          }
        }
        // If still no content, use a reasonable default width
        const wfW = maxCol > 0 ? maxCol * cwRef.current : Math.floor(canvasWidth * 0.5);

        wireframes.push({
          id: wfId,
          x: 0,
          y: 0, // placeholder — corrected in two-pass layout below
          w: wfW,
          h,
          layers,
          sparse,
          originalText: r.text,
        });
        regionOrder.push({ type: "wireframe", wireframeId: wfId });
      } else {
        regionOrder.push({ type: "prose" });
      }
    }
    regionOrderRef.current = regionOrder;
    wireframesRef.current = wireframes;

    // ── Two-pass wireframe y-position correction ─────────────
    // Pass 1: reflow prose WITHOUT any obstacles. This gives the actual
    // visual line positions produced by Pretext (accounting for real wrapping).
    // Pass 2: walk regions in document order, accumulate curY using the
    // actual prose line count per prose region. Assign wireframe y-positions
    // based on that accurate curY.
    if (prepared && canvasWidth > 0) {
      const noObstacleResult = reflowLayout(prepared, canvasWidth, SPATIAL_LH, []);
      const visualLines = noObstacleResult.lines;

      // Build char-offset boundaries for each prose part.
      // proseText = proseParts.join("\n\n"), so boundaries are:
      //   part[0]: chars 0 .. proseParts[0].length - 1
      //   part[1]: chars proseParts[0].length+2 .. proseParts[0].length+2+proseParts[1].length - 1
      // We count how many visual lines fall within each part's char range.
      const partBoundaries: { start: number; end: number }[] = [];
      let offset = 0;
      for (const part of proseParts) {
        partBoundaries.push({ start: offset, end: offset + part.length });
        offset += part.length + 2; // +2 for "\n\n" separator
      }

      // For each visual line, find which char offset it starts at.
      // We reconstruct cumulative char offsets by walking visual lines.
      // Each visual line consumes line.text.length chars from the source,
      // plus any "\n" that was consumed at a source-line-break boundary.
      const proseText = proseTextRef.current;
      let charConsumed = 0;
      // lineStartOffset[i] = cumulative char offset at start of visual line i
      const lineStartOffset: number[] = [];
      for (let i = 0; i < visualLines.length; i++) {
        lineStartOffset.push(charConsumed);
        charConsumed += visualLines[i].text.length;
        // If next char in source is a \n (source line break), consume it
        if (proseText[charConsumed] === "\n") charConsumed += 1;
      }

      // Count visual lines per prose part
      const linesPerPart: number[] = proseParts.map(() => 0);
      for (let i = 0; i < visualLines.length; i++) {
        const charOff = lineStartOffset[i];
        for (let p = 0; p < partBoundaries.length; p++) {
          if (charOff >= partBoundaries[p].start && charOff < partBoundaries[p].end) {
            linesPerPart[p]++;
            break;
          }
        }
      }

      // Walk regions in document order, assign wireframe y-positions
      let curY = 0;
      let prosePartIdx = 0;
      let wfIdx = 0;
      for (const entry of regionOrder) {
        if (entry.type === "prose") {
          const count = linesPerPart[prosePartIdx] ?? 0;
          curY += count * SPATIAL_LH;
          prosePartIdx++;
        } else {
          const wf = wireframes[wfIdx];
          if (wf) {
            wf.y = curY;
            curY += wf.h;
          }
          wfIdx++;
        }
      }
    }
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

    // Build obstacles from wireframes — use real x/w so text flows on both sides
    const obstacles: Obstacle[] = wireframes.map(wf => ({
      x: wf.x,
      y: wf.y,
      w: wf.w,
      h: wf.h,
    }));

    const result = reflowLayout(prepared, canvasWidth, SPATIAL_LH, obstacles);
    posLinesRef.current = result.lines;
  }

  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w } = sizeRef.current;

    // Compute total content height: max of all prose lines and wireframe bottoms
    let contentH = 0;
    for (const line of posLinesRef.current) {
      contentH = Math.max(contentH, line.y + SPATIAL_LH);
    }
    for (const wf of wireframesRef.current) {
      contentH = Math.max(contentH, wf.y + wf.h);
    }
    contentH = Math.max(contentH + 40, sizeRef.current.h - TOOLBAR_HEIGHT); // pad + min viewport

    // Retina / HiDPI
    const dpr = window.devicePixelRatio || 1;
    const physW = Math.floor(w * dpr);
    const physH = Math.floor(contentH * dpr);
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width = physW;
      canvas.height = physH;
    }

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Subtle grey background
    ctx.fillStyle = "#1e1e2e";
    ctx.fillRect(0, 0, w, contentH);

    const cw = cwRef.current;
    const ch = chRef.current;

    const scrollY = 0; // browser scroll handles scrolling; canvas renders full content

    // Draw prose lines
    ctx.font = SPATIAL_FONT;
    ctx.fillStyle = FG_COLOR;
    ctx.textBaseline = "top";
    for (const line of posLinesRef.current) {
      ctx.fillText(line.text, line.x, line.y);
    }

    // Draw wireframes
    for (const wf of wireframesRef.current) {
      const top = wf.y;

      ctx.font = SPATIAL_FONT;
      ctx.fillStyle = FG_COLOR;
      ctx.textBaseline = "top";

      for (const { row, startCol, text } of wf.sparse) {
        // Use fillText per row for Retina sharpness (atlas drawImage is low-res)
        ctx.fillText(text, wf.x + startCol * cw, top + row * ch);
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
        const cursorX = wf.x + (layer.bbox.col + wte.col) * cw;
        const cursorY = wf.y - scrollY + layer.bbox.row * ch;
        ctx.fillStyle = FG_COLOR;
        ctx.fillRect(cursorX, cursorY, 2, ch);
      }
    }

    // Draw text placement cursor (text tool active, waiting for input)
    const tp = textPlacementRef.current;
    if (tp && blinkVisibleRef.current) {
      const wfForTp = wireframesRef.current.find(w => w.id === tp.wfId);
      if (wfForTp) {
        const cursorX = wfForTp.x + (tp.col + tp.buffer.length) * cw;
        const cursorY = wfForTp.y - scrollY + tp.row * ch;
        // Draw typed buffer text preview
        if (tp.buffer.length > 0) {
          ctx.font = SPATIAL_FONT;
          ctx.fillStyle = "#4a90e2";
          ctx.textBaseline = "top";
          ctx.fillText(tp.buffer, wfForTp.x + tp.col * cw, cursorY);
        }
        ctx.fillStyle = FG_COLOR;
        ctx.fillRect(cursorX, cursorY, 2, ch);
      }
    }

    // Draw rect/line preview overlay
    const dg = drawGestureRef.current;
    if (dg) {
      const wfForDg = wireframesRef.current.find(w => w.id === dg.wfId);
      if (wfForDg) {
        const top = wfForDg.y - scrollY;
        ctx.save();
        ctx.strokeStyle = "#4a90e2";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        const wfX = wfForDg.x;
        if (dg.tool === "rect") {
          const minR = Math.min(dg.startRow, dg.endRow);
          const maxR = Math.max(dg.startRow, dg.endRow);
          const minC = Math.min(dg.startCol, dg.endCol);
          const maxC = Math.max(dg.startCol, dg.endCol);
          ctx.strokeRect(
            wfX + minC * cw,
            top + minR * ch,
            (maxC - minC + 1) * cw,
            (maxR - minR + 1) * ch,
          );
        } else if (dg.tool === "line") {
          const dRow = Math.abs(dg.endRow - dg.startRow);
          const dCol = Math.abs(dg.endCol - dg.startCol);
          const isH = dCol >= dRow;
          ctx.beginPath();
          if (isH) {
            const y = top + dg.startRow * ch + ch / 2;
            ctx.moveTo(wfX + dg.startCol * cw, y);
            ctx.lineTo(wfX + (dg.endCol + 1) * cw, y);
          } else {
            const x = wfX + dg.startCol * cw + cw / 2;
            const minR = Math.min(dg.startRow, dg.endRow);
            const maxR = Math.max(dg.startRow, dg.endRow);
            ctx.moveTo(x, top + minR * ch);
            ctx.lineTo(x, top + (maxR + 1) * ch);
          }
          ctx.stroke();
        }
        ctx.restore();
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
      // Wireframes keep their real x/w on resize — no override needed
      kick();
    };
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  useEffect(() => {
    const fn = async (e: KeyboardEvent) => {
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;

      // ── Text tool placement input ─────────────────────────
      const tp = textPlacementRef.current;
      if (tp && !mod) {
        const wf = wireframesRef.current.find(w => w.id === tp.wfId);
        if (wf) {
          if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault();
            // Commit the text layer if buffer is non-empty
            if (tp.buffer.length > 0) {
              const { cells, content, bbox } = buildTextCells(tp.row, tp.col, tp.buffer);
              if (content.length > 0) {
                const newLayer: Layer = {
                  id: `text_${Date.now()}`,
                  type: "text",
                  z: 0,
                  visible: true,
                  parentId: null,
                  bbox: { ...bbox, w: Math.max(1, content.length) },
                  cells,
                  content,
                };
                addLayerToWireframe(wf, newLayer);
                selectedLayerIdRef.current = newLayer.id;
                selectedIdRef.current = null;
                scheduleAutosave();
              }
            }
            textPlacementRef.current = null;
            stopBlink();
            paint();
            return;
          }

          if (e.key === "Backspace") {
            e.preventDefault();
            if (tp.buffer.length > 0) {
              textPlacementRef.current = { ...tp, buffer: tp.buffer.slice(0, -1) };
              resetBlink();
              paint();
            }
            return;
          }

          if (e.key.length === 1) {
            e.preventDefault();
            textPlacementRef.current = { ...tp, buffer: tp.buffer + e.key };
            resetBlink();
            paint();
            return;
          }
        }
      }

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
        textPlacementRef.current = null;
        drawGestureRef.current = null;
        stopBlink();
        paint();
        return;
      }

      // ── Tool shortcuts (only when no active text edit or prose cursor) ──
      const noTextActive =
        !wireframeTextEditRef.current &&
        !textPlacementRef.current &&
        !proseCursorRef.current;
      if (noTextActive && !mod) {
        let newTool: ActiveTool | null = null;
        if (e.key === "v" || e.key === "V") newTool = "select";
        else if (e.key === "r" || e.key === "R") newTool = "rect";
        else if (e.key === "l" || e.key === "L") newTool = "line";
        else if (e.key === "t" || e.key === "T") newTool = "text";
        if (newTool !== null) {
          e.preventDefault();
          activeToolRef.current = newTool;
          setActiveTool(newTool);
          return;
        }
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

  // ── Drawing tool helpers ─────────────────────────────────

  /** Return pixel coords → wireframe-local grid (row, col). */
  function pixelToGrid(wf: Wireframe, px: number, docY: number): { row: number; col: number } {
    const cw = cwRef.current;
    const ch = chRef.current;
    return {
      row: Math.max(0, Math.floor((docY - wf.y) / ch)),
      col: Math.max(0, Math.floor((px - wf.x) / cw)),
    };
  }

  /**
   * Ensure a wireframe exists for drawing. If click is inside an existing
   * wireframe, return it. Otherwise create a new minimal wireframe at that
   * y position and return it.
   */
  function getOrCreateWireframe(px: number, docY: number): Wireframe {
    const existing = hitTestWireframe(px, docY);
    if (existing) return existing;

    // Create a new wireframe at this y position (snapped to ch grid)
    // Use a default content width (40 cols) rather than full canvas width
    const ch = chRef.current;
    const cw = cwRef.current;
    const snappedY = Math.floor(docY / ch) * ch;
    const defaultCols = 40;
    const newWf: Wireframe = {
      id: `wf-${Date.now()}`,
      x: 0,
      y: snappedY,
      w: defaultCols * cw,
      h: ch * 8, // default 8 rows tall
      layers: [],
      sparse: [],
      originalText: "",
    };
    wireframesRef.current = [...wireframesRef.current, newWf];
    regionOrderRef.current = [...regionOrderRef.current, { type: "wireframe", wireframeId: newWf.id }];
    return newWf;
  }

  /** Add a new layer to a wireframe, recomposite, and repaint. */
  function addLayerToWireframe(wf: Wireframe, newLayer: Layer) {
    const maxZ = wf.layers.reduce((m, l) => Math.max(m, l.z), -1);
    const layerWithZ: Layer = { ...newLayer, z: maxZ + 1 };
    wf.layers = [...wf.layers, layerWithZ];
    wf.sparse = buildSparseRows(compositeLayers(wf.layers));

    // Grow wireframe to fit all layers
    let maxRow = 0;
    let maxCol = 0;
    for (const l of wf.layers) {
      maxRow = Math.max(maxRow, l.bbox.row + l.bbox.h);
      maxCol = Math.max(maxCol, l.bbox.col + l.bbox.w);
    }
    wf.h = Math.max(wf.h, maxRow * chRef.current);
    wf.w = Math.max(wf.w, maxCol * cwRef.current);
    doLayout();
  }

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
    const docY = e.clientY - rect.top + (canvasRef.current?.parentElement?.scrollTop ?? 0);

    // ── Drawing tools: rect, line, text ──────────────────
    const tool = activeToolRef.current;
    if (tool === "rect" || tool === "line") {
      const targetWf = getOrCreateWireframe(px, docY);
      const { row, col } = pixelToGrid(targetWf, px, docY);
      drawGestureRef.current = {
        tool,
        wfId: targetWf.id,
        startRow: row,
        startCol: col,
        endRow: row,
        endCol: col,
      };
      proseCursorRef.current = null;
      wireframeTextEditRef.current = null;
      textPlacementRef.current = null;
      stopBlink();
      paint();
      return;
    }

    if (tool === "text") {
      const targetWf = getOrCreateWireframe(px, docY);
      const { row, col } = pixelToGrid(targetWf, px, docY);
      textPlacementRef.current = {
        wfId: targetWf.id,
        row,
        col,
        buffer: "",
      };
      proseCursorRef.current = null;
      wireframeTextEditRef.current = null;
      drawGestureRef.current = null;
      selectedIdRef.current = null;
      selectedLayerIdRef.current = null;
      canvas.focus();
      resetBlink();
      paint();
      return;
    }

    const wf = hitTestWireframe(px, docY);
    if (wf) {
      const cw = cwRef.current;
      const ch = chRef.current;
      // Convert click to wireframe-local grid coords (account for wf.x offset)
      const gridRow = Math.floor((docY - wf.y) / ch);
      const gridCol = Math.floor((px - wf.x) / cw);

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

      if (hitLayer && !e.altKey) {
        // Individual layer selected (Alt+click bypasses to whole-wireframe drag)
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
          startX: px,
          startWfX: wf.x,
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
          startX: px,
          startWfX: wf.x,
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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const docY = e.clientY - rect.top + (canvasRef.current?.parentElement?.scrollTop ?? 0);

    // Update draw gesture preview
    const dg = drawGestureRef.current;
    if (dg) {
      const wf = wireframesRef.current.find(w => w.id === dg.wfId);
      if (wf) {
        const { row, col } = pixelToGrid(wf, px, docY);
        drawGestureRef.current = { ...dg, endRow: row, endCol: col };
        paint();
      }
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;

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
      const dx = px - drag.startX;
      const newY = Math.max(0, drag.startWfY + dy);
      const newX = Math.max(0, drag.startWfX + dx);
      wf.y = newY;
      wf.x = newX;
      doLayout();
      paint();
    }
  }

  function onMouseUp() {
    // Commit draw gesture
    const dg = drawGestureRef.current;
    if (dg) {
      drawGestureRef.current = null;
      const wf = wireframesRef.current.find(w => w.id === dg.wfId);
      if (wf) {
        const r1 = dg.startRow, c1 = dg.startCol;
        const r2 = dg.endRow, c2 = dg.endCol;
        // Require minimum size (at least 1 cell)
        if (dg.tool === "rect" && (Math.abs(r2 - r1) >= 1 || Math.abs(c2 - c1) >= 1)) {
          const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
          const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
          const bbox = { row: minR, col: minC, w: maxC - minC + 1, h: maxR - minR + 1 };
          const cells = regenerateCells(bbox, LIGHT_RECT_STYLE);
          const newLayer: Layer = {
            id: `rect_${Date.now()}`,
            type: "rect",
            z: 0,
            visible: true,
            parentId: null,
            bbox,
            cells,
            style: LIGHT_RECT_STYLE,
          };
          addLayerToWireframe(wf, newLayer);
          selectedLayerIdRef.current = newLayer.id;
          selectedIdRef.current = null;
          scheduleAutosave();
        } else if (dg.tool === "line" && (Math.abs(r2 - r1) >= 1 || Math.abs(c2 - c1) >= 1)) {
          const { bbox, cells } = buildLineCells(r1, c1, r2, c2);
          const newLayer: Layer = {
            id: `line_${Date.now()}`,
            type: "line",
            z: 0,
            visible: true,
            parentId: null,
            bbox,
            cells,
          };
          addLayerToWireframe(wf, newLayer);
          selectedLayerIdRef.current = newLayer.id;
          selectedIdRef.current = null;
          scheduleAutosave();
        }
      }
      paint();
      return;
    }

    if (dragRef.current) {
      dragRef.current = null;
      scheduleAutosave();
    }
  }

  // Browser native scroll handles scrolling (canvas in scrollable div)

  if (!ready) return <div style={{ background: BG_COLOR, width: "100vw", height: "100vh" }} />;

  const isDragging = dragRef.current !== null;
  const isDrawing = drawGestureRef.current !== null;
  const toolCursor = activeTool === "rect" || activeTool === "line"
    ? "crosshair"
    : activeTool === "text"
    ? "text"
    : isDragging ? "grabbing" : "default";

  const toolButtons: Array<{ id: ActiveTool; label: string; shortcut: string }> = [
    { id: "select", label: "Select", shortcut: "V" },
    { id: "rect",   label: "Rect",   shortcut: "R" },
    { id: "line",   label: "Line",   shortcut: "L" },
    { id: "text",   label: "Text",   shortcut: "T" },
  ];

  return (
    <div style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh" }}>
      {/* Toolbar */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: TOOLBAR_HEIGHT,
          background: "#1e1e1e",
          borderBottom: "1px solid #333",
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 8px",
          zIndex: 10,
          boxSizing: "border-box",
        }}
      >
        {toolButtons.map(({ id, label, shortcut }) => (
          <button
            key={id}
            title={`${label} (${shortcut})`}
            onClick={() => {
              activeToolRef.current = id;
              setActiveTool(id);
              canvasRef.current?.focus();
            }}
            style={{
              background: activeTool === id ? "#4a90e2" : "#2d2d2d",
              color: activeTool === id ? "#fff" : "#ccc",
              border: `1px solid ${activeTool === id ? "#4a90e2" : "#444"}`,
              borderRadius: 4,
              padding: "2px 10px",
              fontSize: 12,
              cursor: "pointer",
              height: 24,
              lineHeight: "20px",
            }}
          >
            {label} <span style={{ opacity: 0.6, fontSize: 10 }}>{shortcut}</span>
          </button>
        ))}
      </div>

      {/* Canvas — scrolls naturally via browser scroll */}
      <div style={{
        position: "fixed", top: TOOLBAR_HEIGHT, left: 0, right: 0, bottom: 0,
        overflow: "auto", background: "#141420",
      }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          style={{
            display: "block",
            width: sizeRef.current.w,
            minHeight: sizeRef.current.h - TOOLBAR_HEIGHT,
            outline: "none",
            cursor: isDrawing ? "crosshair" : toolCursor,
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
        />
      </div>
    </div>
  );
}
