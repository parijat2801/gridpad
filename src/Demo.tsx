/**
 * Minimal Pretext + Wireframe demo.
 * One canvas. Prose via Pretext. Wireframes via glyph atlas.
 * Drag wireframes. Resize rect wireframes. Text reflows.
 */
import { useEffect, useRef, useState } from "react";
import { prepareWithSegments, layoutWithLines, type LayoutLine } from "@chenglou/pretext";
import { scan } from "./scanner";
import { detectRegions, type Region } from "./regions";
import { compositeLayers, regenerateCells, buildTextCells } from "./layers";
import type { Layer } from "./layers";
import { buildSparseRows, type SparseRow } from "./KonvaCanvas";
import type { Bbox } from "./types";
import {
  FONT_SIZE, FONT_FAMILY, BG_COLOR, FG_COLOR,
  measureCellSize, getCharWidth, getCharHeight,
  getGlyphAtlas,
} from "./grid";
import { insertChar, deleteChar } from "./proseCursor";

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
Try dragging a wireframe box — the prose reflows around it.
Click a box to select, drag edges to resize, drag interior to move.`;

const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const LH = Math.ceil(FONT_SIZE * 1.15);
const EDGE_THRESHOLD = 1; // grid cells from edge to trigger resize

interface ProseCursor {
  regionIdx: number;
  row: number; // source line index within the region's text
  col: number; // character offset within that source line
}

interface LayoutRegion {
  region: Region;
  y: number;
  height: number;
  lines?: LayoutLine[];
  sparse?: SparseRow[];
}

/** State for in-place editing of a text label inside a wireframe region. */
interface WireframeTextEdit {
  lrIdx: number;      // index into laidRef.current
  layerId: string;    // id of the text layer being edited
  col: number;        // cursor column within the text (0-based char offset)
}

type GestureMode = "drag" | "resize";
type ResizeEdge = { top: boolean; bottom: boolean; left: boolean; right: boolean };

interface GestureState {
  mode: GestureMode;
  regionIdx: number;
  layerId: string;
  startBbox: Bbox;
  startMX: number;
  startMY: number;
  edges: ResizeEdge; // which edges are being dragged (resize only)
}

export default function Demo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const docTextRef = useRef(DEFAULT_TEXT);
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

  function scheduleAutosave() {
    if (!fileHandleRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      const handle = fileHandleRef.current;
      if (!handle) return;
      try {
        const writable = await handle.createWritable();
        await writable.write(docTextRef.current);
        await writable.close();
      } catch (e) {
        console.error("Autosave failed:", e);
      }
    }, 500);
  }

  async function saveNow() {
    const handle = fileHandleRef.current;
    if (!handle) return;
    if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null; }
    try {
      const writable = await handle.createWritable();
      await writable.write(docTextRef.current);
      await writable.close();
    } catch (e) {
      console.error("Save failed:", e);
    }
  }

  useEffect(() => {
    measureCellSize().then(() => {
      cwRef.current = getCharWidth();
      chRef.current = getCharHeight();
      regionsRef.current = detectRegions(scan(docTextRef.current));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const fn = () => { sizeRef.current = { w: window.innerWidth, h: window.innerHeight }; kick(); };
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  useEffect(() => {
    const fn = async (e: KeyboardEvent) => {
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "o") {
        e.preventDefault();
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
          });
          fileHandleRef.current = handle;
          const file = await handle.getFile();
          docTextRef.current = await file.text();
          regionsRef.current = detectRegions(scan(docTextRef.current));
          scrollYRef.current = 0;
          selectedIdRef.current = null;
          gestureRef.current = null;
          proseCursorRef.current = null;
          stopBlink();
          kick();
        } catch { /* cancelled */ }
      } else if (mod && e.key === "s") {
        e.preventDefault();
        saveNow();
      } else if (wireframeTextEditRef.current) {
        // Wireframe text label editing
        handleWireframeTextKey(e);
      } else {
        // Prose cursor editing
        handleProseKey(e);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  // ── Prose key editing ──────────────────────────────────
  function handleProseKey(e: KeyboardEvent) {
    const pc = proseCursorRef.current;
    if (!pc) return;

    const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
    // Don't intercept modifier-key combos (Cmd+S, Cmd+O handled above)
    if (mod) return;

    const lr = laidRef.current[pc.regionIdx];
    if (!lr || lr.region.type !== "prose") return;

    const key = e.key;

    if (key === "Escape") {
      e.preventDefault();
      proseCursorRef.current = null;
      stopBlink();
      paint();
      return;
    }

    const sourceLines = lr.region.text.split("\n");

    if (key === "ArrowLeft") {
      e.preventDefault();
      resetBlink();
      if (pc.col > 0) {
        proseCursorRef.current = { ...pc, col: pc.col - 1 };
      } else if (pc.row > 0) {
        const prevLine = sourceLines[pc.row - 1] ?? "";
        proseCursorRef.current = { ...pc, row: pc.row - 1, col: prevLine.length };
      }
      paint();
      return;
    }

    if (key === "ArrowRight") {
      e.preventDefault();
      resetBlink();
      const line = sourceLines[pc.row] ?? "";
      if (pc.col < line.length) {
        proseCursorRef.current = { ...pc, col: pc.col + 1 };
      } else if (pc.row < sourceLines.length - 1) {
        proseCursorRef.current = { ...pc, row: pc.row + 1, col: 0 };
      }
      paint();
      return;
    }

    if (key === "ArrowUp") {
      e.preventDefault();
      resetBlink();
      if (pc.row > 0) {
        const prevLine = sourceLines[pc.row - 1] ?? "";
        proseCursorRef.current = { ...pc, row: pc.row - 1, col: Math.min(pc.col, prevLine.length) };
      }
      paint();
      return;
    }

    if (key === "ArrowDown") {
      e.preventDefault();
      resetBlink();
      if (pc.row < sourceLines.length - 1) {
        const nextLine = sourceLines[pc.row + 1] ?? "";
        proseCursorRef.current = { ...pc, row: pc.row + 1, col: Math.min(pc.col, nextLine.length) };
      }
      paint();
      return;
    }

    if (key === "Backspace") {
      e.preventDefault();
      resetBlink();
      const result = deleteChar(lr.region.text, { row: pc.row, col: pc.col });
      lr.region.text = result.text;
      proseCursorRef.current = { ...pc, row: result.cursor.row, col: result.cursor.col };
      // Stitch and save
      docTextRef.current = laidRef.current.map(l => l.region.text).join("\n\n");
      scheduleAutosave();
      doLayout();
      paint();
      return;
    }

    if (key === "Delete") {
      e.preventDefault();
      resetBlink();
      // Delete char at cursor = move right by 1, then backspace
      const line = sourceLines[pc.row] ?? "";
      let delCursor = { row: pc.row, col: pc.col };
      if (pc.col < line.length) {
        delCursor = { row: pc.row, col: pc.col + 1 };
      } else if (pc.row < sourceLines.length - 1) {
        delCursor = { row: pc.row + 1, col: 0 };
      } else {
        // Nothing to delete
        return;
      }
      const result = deleteChar(lr.region.text, delCursor);
      lr.region.text = result.text;
      // cursor stays at original position (deleteChar moves it back)
      proseCursorRef.current = { ...pc, row: result.cursor.row, col: result.cursor.col };
      docTextRef.current = laidRef.current.map(l => l.region.text).join("\n\n");
      scheduleAutosave();
      doLayout();
      paint();
      return;
    }

    if (key === "Enter") {
      e.preventDefault();
      resetBlink();
      const result = insertChar(lr.region.text, { row: pc.row, col: pc.col }, "\n");
      lr.region.text = result.text;
      proseCursorRef.current = { ...pc, row: result.cursor.row, col: result.cursor.col };
      docTextRef.current = laidRef.current.map(l => l.region.text).join("\n\n");
      scheduleAutosave();
      doLayout();
      paint();
      return;
    }

    // Printable character (length === 1, no ctrl/meta)
    if (key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      resetBlink();
      const result = insertChar(lr.region.text, { row: pc.row, col: pc.col }, key);
      lr.region.text = result.text;
      proseCursorRef.current = { ...pc, row: result.cursor.row, col: result.cursor.col };
      docTextRef.current = laidRef.current.map(l => l.region.text).join("\n\n");
      scheduleAutosave();
      doLayout();
      paint();
    }
  }

  // ── Wireframe text label editing ───────────────────────
  function handleWireframeTextKey(e: KeyboardEvent) {
    const wte = wireframeTextEditRef.current;
    if (!wte) return;

    const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
    if (mod) return;

    const lr = laidRef.current[wte.lrIdx];
    if (!lr || lr.region.type !== "wireframe" || !lr.region.layers) return;

    const layer = lr.region.layers.find(l => l.id === wte.layerId);
    if (!layer || layer.type !== "text") return;

    const key = e.key;

    if (key === "Escape" || key === "Enter") {
      e.preventDefault();
      // Commit: stitch regions back and autosave
      docTextRef.current = laidRef.current.map(l => l.region.text).join("\n\n");
      wireframeTextEditRef.current = null;
      stopBlink();
      scheduleAutosave();
      doLayout();
      paint();
      return;
    }

    if (key === "ArrowLeft") {
      e.preventDefault();
      resetBlink();
      if (wte.col > 0) {
        wireframeTextEditRef.current = { ...wte, col: wte.col - 1 };
      }
      paint();
      return;
    }

    if (key === "ArrowRight") {
      e.preventDefault();
      resetBlink();
      const content = layer.content ?? "";
      if (wte.col < content.length) {
        wireframeTextEditRef.current = { ...wte, col: wte.col + 1 };
      }
      paint();
      return;
    }

    if (key === "Backspace") {
      e.preventDefault();
      resetBlink();
      const content = layer.content ?? "";
      if (wte.col === 0) return;
      const newContent = content.slice(0, wte.col - 1) + content.slice(wte.col);
      applyWireframeTextEdit(lr, layer, newContent);
      wireframeTextEditRef.current = { ...wte, col: wte.col - 1 };
      paint();
      return;
    }

    // Printable character
    if (key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      resetBlink();
      const content = layer.content ?? "";
      const newContent = content.slice(0, wte.col) + key + content.slice(wte.col);
      applyWireframeTextEdit(lr, layer, newContent);
      wireframeTextEditRef.current = { ...wte, col: wte.col + 1 };
      paint();
    }
  }

  /** Update a text layer's cells/content/bbox and recomposite the region's sparse rows.
   * Also splices the change into region.text so autosave is consistent. */
  function applyWireframeTextEdit(lr: LayoutRegion, layer: Layer, newContent: string) {
    // Capture old width before mutating the layer
    const oldWidth = [...(layer.content ?? "")].length;
    const col = layer.bbox.col;
    const row = layer.bbox.row;

    const { cells, content: filteredContent } = buildTextCells(row, col, newContent);
    layer.cells = cells;
    layer.content = filteredContent;
    layer.bbox = { ...layer.bbox, w: Math.max(1, filteredContent.length) };

    // Splice the change into region.text: update the text grid at the layer's row
    const textLines = lr.region.text.split("\n");
    if (row < textLines.length) {
      const lineChars = [...textLines[row]];
      // Expand line if it's shorter than what we need to touch
      const maxNeeded = col + Math.max(filteredContent.length, oldWidth);
      while (lineChars.length < maxNeeded) lineChars.push(" ");
      // Clear the old content area (up to max of old and new width)
      for (let i = col; i < col + Math.max(filteredContent.length, oldWidth); i++) {
        lineChars[i] = " ";
      }
      // Write new content
      const newChars = [...filteredContent];
      for (let i = 0; i < newChars.length; i++) {
        lineChars[col + i] = newChars[i];
      }
      textLines[row] = lineChars.join("").trimEnd();
      lr.region.text = textLines.join("\n");
    }

    // Recomposite
    const comp = compositeLayers(lr.region.layers!);
    lr.sparse = buildSparseRows(comp);
  }

  // ── Blink helpers ──────────────────────────────────────
  function startBlink() {
    if (blinkTimerRef.current) clearInterval(blinkTimerRef.current);
    blinkVisibleRef.current = true;
    blinkTimerRef.current = setInterval(() => {
      blinkVisibleRef.current = !blinkVisibleRef.current;
      paint();
    }, 530);
  }

  function stopBlink() {
    if (blinkTimerRef.current) { clearInterval(blinkTimerRef.current); blinkTimerRef.current = null; }
    blinkVisibleRef.current = true;
  }

  function resetBlink() {
    blinkVisibleRef.current = true;
    if (!blinkTimerRef.current) startBlink();
  }

  // ── Layout ─────────────────────────────────────────────
  function doLayout() {
    const cw = cwRef.current;
    const ch = chRef.current;
    if (!cw) return;
    const laid: LayoutRegion[] = [];
    let y = 0;
    for (const r of regionsRef.current) {
      if (r.type === "prose") {
        const p = prepareWithSegments(r.text, FONT, { whiteSpace: "pre-wrap" });
        const l = layoutWithLines(p, sizeRef.current.w, LH);
        laid.push({ region: r, y, height: l.height, lines: l.lines });
        y += l.height;
      } else {
        const comp = compositeLayers(r.layers ?? []);
        const sp = buildSparseRows(comp);
        const rows = r.endRow - r.startRow + 1;
        const h = rows * ch;
        laid.push({ region: r, y, height: h, sparse: sp });
        y += h;
      }
    }
    laidRef.current = laid;

    // Invariants: post-layout consistency checks
    console.assert(laid.length === regionsRef.current.length, "doLayout: laid.length !== regionsRef.current.length");
    for (const lr of laid) {
      if (lr.region.type === "wireframe") console.assert(lr.sparse !== undefined, "doLayout: wireframe region missing sparse rows");
      if (lr.region.type === "prose") console.assert(lr.lines !== undefined, "doLayout: prose region missing lines");
    }
    for (let i = 1; i < laid.length; i++) {
      console.assert(laid[i].y === laid[i - 1].y + laid[i - 1].height, "doLayout: y-offsets not monotonically increasing at index " + i);
    }
  }

  // ── Render ─────────────────────────────────────────────
  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = sizeRef.current;

    // Invariants: canvas and layout sanity
    console.assert(w > 0 && h > 0, "paint: canvas dimensions are zero");
    if (laidRef.current.length === 0) console.warn("paint: no regions to render");
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const cw = cwRef.current;
    const ch = chRef.current;
    const scrollY = scrollYRef.current;
    const selectedId = selectedIdRef.current;

    ctx.clearRect(0, 0, w, h);

    for (const lr of laidRef.current) {
      const top = lr.y - scrollY;
      if (top + lr.height < 0 || top > h) continue;

      if (lr.region.type === "prose" && lr.lines) {
        ctx.font = FONT;
        ctx.fillStyle = FG_COLOR;
        ctx.textBaseline = "top";
        for (let i = 0; i < lr.lines.length; i++) {
          ctx.fillText(lr.lines[i].text, 0, top + i * LH);
        }
      } else if (lr.sparse) {
        const atlas = getGlyphAtlas();
        ctx.font = FONT;
        ctx.fillStyle = FG_COLOR;
        ctx.textBaseline = "top";
        for (const { row, startCol, text } of lr.sparse) {
          if (atlas) {
            for (let i = 0; i < text.length; i++) {
              const c = text[i];
              if (c === " ") continue;
              const g = atlas.glyphs.get(c);
              if (g) {
                ctx.drawImage(atlas.canvas,
                  g.sx, g.sy, atlas.cellWidth, atlas.cellHeight,
                  (startCol + i) * cw, top + row * ch, cw, ch);
              } else {
                ctx.fillText(c, (startCol + i) * cw, top + row * ch);
              }
            }
          } else {
            ctx.fillText(text, startCol * cw, top + row * ch);
          }
        }

        // Selection highlight + resize handles
        if (selectedId && lr.region.layers) {
          for (const l of lr.region.layers) {
            if (l.id !== selectedId) continue;
            const x = l.bbox.col * cw;
            const y2 = top + l.bbox.row * ch;
            const bw = l.bbox.w * cw;
            const bh = l.bbox.h * ch;
            ctx.strokeStyle = "#4a90e2";
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y2, bw, bh);
            // Draw resize handles (small squares at corners and midpoints)
            ctx.fillStyle = "#4a90e2";
            const hs = 6; // handle size
            const handles = [
              [x, y2], [x + bw / 2, y2], [x + bw, y2],
              [x, y2 + bh / 2], [x + bw, y2 + bh / 2],
              [x, y2 + bh], [x + bw / 2, y2 + bh], [x + bw, y2 + bh],
            ];
            for (const [hx, hy] of handles) {
              ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
            }
          }
        }
      }
    }

    // ── Prose cursor ──────────────────────────────────────
    const pc = proseCursorRef.current;
    if (pc && blinkVisibleRef.current) {
      const lr = laidRef.current[pc.regionIdx];
      if (lr && lr.region.type === "prose") {
        // Map source row → visual line index.
        // Each source line may wrap into multiple visual lines.
        // Walk the source lines counting visual lines until we reach pc.row.
        const sourceLines = lr.region.text.split("\n");
        let visualLine = 0;
        for (let si = 0; si < pc.row && si < sourceLines.length; si++) {
          // Count how many visual lines this source line uses.
          // We can check laidRef lines that start with this source line's content,
          // but the simplest/correct approach: measure wrapping via charWidth.
          const srcLen = sourceLines[si].length;
          const maxCols = cw > 0 ? Math.floor(w / cw) : 80;
          const wrappedLines = Math.max(1, Math.ceil(srcLen / maxCols));
          visualLine += wrappedLines;
        }
        const top = lr.y - scrollY;
        const cursorX = pc.col * cw;
        const cursorY = top + visualLine * LH;
        ctx.fillStyle = FG_COLOR;
        ctx.fillRect(cursorX, cursorY, 2, LH);
      }
    }

    // ── Wireframe text edit cursor ─────────────────────────
    const wte = wireframeTextEditRef.current;
    if (wte && blinkVisibleRef.current) {
      const lr = laidRef.current[wte.lrIdx];
      if (lr && lr.region.type === "wireframe" && lr.region.layers) {
        const layer = lr.region.layers.find(l => l.id === wte.layerId);
        if (layer && layer.type === "text") {
          const top = lr.y - scrollY;
          const cursorX = (layer.bbox.col + wte.col) * cw;
          const cursorY = top + layer.bbox.row * ch;
          ctx.fillStyle = FG_COLOR;
          ctx.fillRect(cursorX, cursorY, 2, ch);
        }
      }
    }
  }

  // INVARIANT: doLayout() is NEVER called from the render body.
  // It's called explicitly after: initial load, file open, mouseUp, prose edit, resize.
  // This prevents timing-dependent bugs where React re-renders reset state.

  // Paint on every render (cheap — just draws from laidRef)
  useEffect(() => { if (ready) paint(); });

  // ── Hit test ───────────────────────────────────────────
  function findLayerAt(px: number, docY: number): { lrIdx: number; layer: Layer } | null {
    const cw = cwRef.current;
    const ch = chRef.current;
    for (let i = 0; i < laidRef.current.length; i++) {
      const lr = laidRef.current[i];
      if (docY < lr.y || docY >= lr.y + lr.height) continue;
      if (lr.region.type !== "wireframe" || !lr.region.layers) continue;
      const localY = docY - lr.y;
      const gr = Math.floor(localY / ch);
      const gc = Math.floor(px / cw);
      let best: Layer | null = null;
      let bestZ = -Infinity;
      for (const l of lr.region.layers) {
        if (l.type === "base" || l.type === "group" || !l.visible) continue;
        if (gr >= l.bbox.row && gr < l.bbox.row + l.bbox.h &&
            gc >= l.bbox.col && gc < l.bbox.col + l.bbox.w &&
            l.z > bestZ) {
          best = l; bestZ = l.z;
        }
      }
      if (best) return { lrIdx: i, layer: best };
    }
    return null;
  }

  /** Find a prose region at the given document coordinates and compute cursor position */
  function findProseAt(px: number, docY: number): ProseCursor | null {
    const cw = cwRef.current;
    const canvasW = sizeRef.current.w;
    for (let i = 0; i < laidRef.current.length; i++) {
      const lr = laidRef.current[i];
      if (docY < lr.y || docY >= lr.y + lr.height) continue;
      if (lr.region.type !== "prose") continue;
      const localY = docY - lr.y;
      // Which visual line did we click?
      const visualLineIdx = Math.floor(localY / LH);
      // Map visual line → source line by counting wrapped lines per source line
      const sourceLines = lr.region.text.split("\n");
      const maxCols = cw > 0 ? Math.floor(canvasW / cw) : 80;
      let visualCount = 0;
      let srcRow = 0;
      for (let si = 0; si < sourceLines.length; si++) {
        const srcLen = sourceLines[si].length;
        const wrappedLines = Math.max(1, Math.ceil(srcLen / maxCols));
        if (visualLineIdx < visualCount + wrappedLines) {
          srcRow = si;
          break;
        }
        visualCount += wrappedLines;
        srcRow = si;
      }
      // Clamp col to the line length
      const line = sourceLines[srcRow] ?? "";
      const col = Math.max(0, Math.min(line.length, Math.round(px / cw)));
      return { regionIdx: i, row: srcRow, col };
    }
    return null;
  }

  /** Determine if click is near an edge of the selected layer's bbox */
  function detectResizeEdge(layer: Layer, gridRow: number, gridCol: number): ResizeEdge | null {
    const { row, col, w, h } = layer.bbox;
    const top = gridRow <= row + EDGE_THRESHOLD;
    const bottom = gridRow >= row + h - 1 - EDGE_THRESHOLD;
    const left = gridCol <= col + EDGE_THRESHOLD;
    const right = gridCol >= col + w - 1 - EDGE_THRESHOLD;
    if (top || bottom || left || right) {
      return { top, bottom, left, right };
    }
    return null;
  }

  function getCursor(): string {
    const g = gestureRef.current;
    if (!g) return "default";
    if (g.mode === "drag") return "grabbing";
    const { edges } = g;
    if ((edges.top && edges.left) || (edges.bottom && edges.right)) return "nwse-resize";
    if ((edges.top && edges.right) || (edges.bottom && edges.left)) return "nesw-resize";
    if (edges.top || edges.bottom) return "ns-resize";
    if (edges.left || edges.right) return "ew-resize";
    return "default";
  }

  // ── Mouse ──────────────────────────────────────────────
  function onMouseDown(e: React.MouseEvent) {
    // Invariants: pre-mousedown sanity
    console.assert(laidRef.current.length > 0, "onMouseDown: layout has not been computed");
    console.assert(gestureRef.current === null, "onMouseDown: gesture already in progress");

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const docY = e.clientY - rect.top + scrollYRef.current;
    const cw = cwRef.current;
    const ch = chRef.current;
    const now = Date.now();

    // Detect double-click: same position within 300ms
    const lastClick = lastClickRef.current;
    const isDoubleClick = lastClick !== null &&
      now - lastClick.time < 300 &&
      Math.abs(px - lastClick.px) < cw * 2 &&
      Math.abs(docY - lastClick.docY) < ch * 2;
    lastClickRef.current = { time: now, px, docY };

    const hit = findLayerAt(px, docY);

    if (hit) {
      // Check for double-click on a text layer → enter wireframe text edit mode
      if (isDoubleClick && hit.layer.type === "text") {
        proseCursorRef.current = null;
        gestureRef.current = null;
        selectedIdRef.current = hit.layer.id;

        // Compute cursor col from click position within the text layer
        const content = hit.layer.content ?? "";
        const textStartCol = hit.layer.bbox.col;
        const clickCol = Math.floor(px / cw);
        const offsetInText = Math.max(0, Math.min([...content].length, clickCol - textStartCol));

        wireframeTextEditRef.current = {
          lrIdx: hit.lrIdx,
          layerId: hit.layer.id,
          col: offsetInText,
        };
        canvasRef.current?.focus();
        startBlink();
        paint();
        return;
      }

      // Single click on a wireframe layer — exit any text edit mode, start gesture
      if (wireframeTextEditRef.current) {
        // Commit pending wireframe text edit
        docTextRef.current = laidRef.current.map(l => l.region.text).join("\n\n");
        wireframeTextEditRef.current = null;
        stopBlink();
        scheduleAutosave();
      }
      proseCursorRef.current = null;
      selectedIdRef.current = hit.layer.id;
      const lr = laidRef.current[hit.lrIdx];
      const localY = docY - lr.y;
      const gridRow = Math.floor(localY / ch);
      const gridCol = Math.floor(px / cw);

      // Check if near edge → resize, otherwise drag
      const edges = hit.layer.type === "rect" && hit.layer.style
        ? detectResizeEdge(hit.layer, gridRow, gridCol)
        : null;

      gestureRef.current = {
        mode: edges ? "resize" : "drag",
        regionIdx: hit.lrIdx,
        layerId: hit.layer.id,
        startBbox: { ...hit.layer.bbox },
        startMX: px,
        startMY: docY,
        edges: edges ?? { top: false, bottom: false, left: false, right: false },
      };
      paint(); // repaint selection without re-layout
    } else {
      // Clicked outside any wireframe layer — commit wireframe text edit if active
      if (wireframeTextEditRef.current) {
        docTextRef.current = laidRef.current.map(l => l.region.text).join("\n\n");
        wireframeTextEditRef.current = null;
        stopBlink();
        scheduleAutosave();
      }
      // Check if clicked in a prose region
      const proseHit = findProseAt(px, docY);
      if (proseHit) {
        proseCursorRef.current = proseHit;
        selectedIdRef.current = null;
        gestureRef.current = null;
        canvasRef.current?.focus();
        startBlink();
        paint();
      } else {
        proseCursorRef.current = null;
        stopBlink();
        selectedIdRef.current = null;
        gestureRef.current = null;
        paint();
      }
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const g = gestureRef.current;
    if (!g) return;

    // Invariants: gesture and layer consistency
    console.assert(gestureRef.current !== null, "onMouseMove: no gesture in progress");
    const _mmLr = laidRef.current[g.regionIdx];
    if (!_mmLr?.region.layers?.find(l => l.id === g.layerId)) console.warn("onMouseMove: gestured layer no longer exists in region");

    const canvas = canvasRef.current;
    if (!canvas) return;
    const cw = cwRef.current;
    const ch = chRef.current;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const docY = e.clientY - rect.top + scrollYRef.current;

    const dCol = Math.round((px - g.startMX) / cw);
    const dRow = Math.round((docY - g.startMY) / ch);
    if (dCol === 0 && dRow === 0) return;

    const lr = laidRef.current[g.regionIdx];
    if (!lr?.region.layers) return;
    const layer = lr.region.layers.find(l => l.id === g.layerId);
    if (!layer) return;

    if (g.mode === "drag") {
      const newRow = g.startBbox.row + dRow;
      const newCol = g.startBbox.col + dCol;
      if (layer.bbox.row === newRow && layer.bbox.col === newCol) return;

      const rowDelta = newRow - layer.bbox.row;
      const colDelta = newCol - layer.bbox.col;
      const newCells = new Map<string, string>();
      for (const [key, val] of layer.cells) {
        const ci = key.indexOf(",");
        const r = Number(key.slice(0, ci)) + rowDelta;
        const c = Number(key.slice(ci + 1)) + colDelta;
        newCells.set(`${r},${c}`, val);
      }
      layer.cells = newCells;
      layer.bbox.row = newRow;
      layer.bbox.col = newCol;
    } else {
      // Resize
      const sb = g.startBbox;
      let newRow = sb.row;
      let newCol = sb.col;
      let newW = sb.w;
      let newH = sb.h;

      if (g.edges.top) { newRow = sb.row + dRow; newH = sb.h - dRow; }
      if (g.edges.bottom) { newH = sb.h + dRow; }
      if (g.edges.left) { newCol = sb.col + dCol; newW = sb.w - dCol; }
      if (g.edges.right) { newW = sb.w + dCol; }

      // Minimum size
      if (newW < 2) newW = 2;
      if (newH < 2) newH = 2;

      const newBbox: Bbox = { row: newRow, col: newCol, w: newW, h: newH };
      if (layer.bbox.row === newBbox.row && layer.bbox.col === newBbox.col &&
          layer.bbox.w === newBbox.w && layer.bbox.h === newBbox.h) return;

      layer.bbox = newBbox;
      // Regenerate cells for rects with style
      if (layer.type === "rect" && layer.style) {
        layer.cells = regenerateCells(newBbox, layer.style);
      }
    }

    // Recomposite + repaint
    const comp = compositeLayers(lr.region.layers);
    lr.sparse = buildSparseRows(comp);
    paint();
  }

  function onMouseUp() {
    const g = gestureRef.current;
    if (!g) return;

    // Persist the drag/resize into the wireframe region's text.
    // Instead of reconstructing from composite (which loses junction chars),
    // edit the original text as a character grid: erase old, write new.
    const lr = laidRef.current[g.regionIdx];
    if (lr?.region.type === "wireframe") {
      const textLines = lr.region.text.split("\n");
      // Pad lines to a grid
      const maxCols = Math.max(...textLines.map(l => [...l].length), 0);
      const grid: string[][] = textLines.map(l => {
        const chars = [...l];
        while (chars.length < maxCols) chars.push(" ");
        return chars;
      });
      // Ensure enough rows
      const rows = lr.region.endRow - lr.region.startRow + 1;
      while (grid.length < rows) grid.push(Array(maxCols).fill(" "));

      // Erase old position (write spaces where the layer's cells WERE)
      const movedLayer = lr.region.layers!.find(l => l.id === g.layerId)!;
      const dRow = movedLayer.bbox.row - g.startBbox.row;
      const dCol = movedLayer.bbox.col - g.startBbox.col;

      // Snapshot composite of all OTHER layers before erasing
      const otherComposite = compositeLayers(lr.region.layers!.filter(l => l.id !== g.layerId));

      // Erase old cells — restore other layers' char instead of blindly writing space
      for (const [key] of lr.region.layers!.find(l => l.id === g.layerId)!.cells) {
        const ci = key.indexOf(",");
        const r = Number(key.slice(0, ci)) - dRow; // original position
        const c = Number(key.slice(ci + 1)) - dCol;
        if (r >= 0 && r < grid.length && c >= 0 && c < (grid[r]?.length ?? 0)) {
          grid[r][c] = otherComposite.get(`${r},${c}`) ?? " ";
        }
      }

      // Write new cells
      const layer = lr.region.layers!.find(l => l.id === g.layerId)!;
      for (const [key, ch] of layer.cells) {
        const ci = key.indexOf(",");
        const r = Number(key.slice(0, ci));
        const c = Number(key.slice(ci + 1));
        // Expand grid if needed
        while (grid.length <= r) grid.push(new Array(maxCols).fill(" "));
        if (!grid[r]) grid[r] = new Array(maxCols).fill(" ");
        while (grid[r].length <= c) grid[r].push(" ");
        grid[r][c] = ch;
      }

      // Convert back to text
      const newText = grid.map(row => row.join("").trimEnd()).join("\n");
      lr.region.text = newText;

      // Stitch all regions back
      docTextRef.current = laidRef.current.map(l => l.region.text).join("\n\n");
    }

    gestureRef.current = null;
    scheduleAutosave();
    doLayout(); // rebuild laidRef with correct y-offsets for next hit test
    paint();

    // Invariants: post-mouseup consistency
    console.assert(gestureRef.current === null, "onMouseUp: gesture not cleared");
    console.assert(laidRef.current.length === regionsRef.current.length, "onMouseUp: laid.length !== regionsRef.current.length");
    if (!docTextRef.current) console.warn("onMouseUp: docText is empty after gesture");
  }

  function onWheel(e: React.WheelEvent) {
    const totalH = laidRef.current.reduce((s, r) => s + r.height, 0);
    const maxScroll = Math.max(0, totalH - sizeRef.current.h);
    scrollYRef.current = Math.max(0, Math.min(maxScroll, scrollYRef.current + e.deltaY));
    paint();
  }

  // Cleanup blink timer on unmount
  useEffect(() => {
    return () => { stopBlink(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return <div style={{ background: BG_COLOR, width: "100vw", height: "100vh" }} />;
  }

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      style={{
        background: BG_COLOR, display: "block",
        position: "fixed", top: 0, left: 0,
        width: sizeRef.current.w, height: sizeRef.current.h,
        cursor: getCursor(),
        outline: "none",
      }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    />
  );
}
