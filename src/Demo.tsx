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
import { compositeLayers } from "./layers";
import type { Layer } from "./layers";
import { buildSparseRows, type SparseRow } from "./KonvaCanvas";
import {
  BG_COLOR, FG_COLOR, measureCellSize, getCharWidth, getCharHeight,
  getGlyphAtlas, FONT_SIZE, FONT_FAMILY,
} from "./grid";
import { prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext";
import { reflowLayout, type PositionedLine, type Obstacle } from "./reflowLayout";
import { DEMO_DEFAULT_TEXT } from "./demoDefaults";

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

// ── Drag state ───────────────────────────────────────────
interface DragState {
  wireframeId: string;
  startY: number;   // pixel docY at drag start
  startWfY: number; // wireframe.y at drag start
}

export default function Demo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  // Data model
  const proseTextRef = useRef<string>("");
  const preparedRef = useRef<PreparedTextWithSegments | null>(null);
  const wireframesRef = useRef<Wireframe[]>([]);
  const posLinesRef = useRef<PositionedLine[]>([]);

  // Scroll + UI state
  const scrollYRef = useRef(0);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const cwRef = useRef(0);
  const chRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [, forceRender] = useState(0);
  const kick = () => forceRender(t => t + 1);

  // ── Document parsing ─────────────────────────────────────
  function loadDocument(text: string) {
    const scanResult = scan(text);
    const regions = detectRegions(scanResult);

    // Concatenate all prose text
    const proseParts: string[] = [];
    regions.forEach(r => {
      if (r.type === "prose") proseParts.push(r.text);
    });
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
        wireframes.push({
          id: `wf-${wireframes.length}`,
          x: 0,
          y: curY,
          w: cw,
          h,
          layers,
          sparse,
          originalText: r.text,
        });
        curY += h;
      } else {
        // Estimate prose height: rough line count * LH
        const lines = r.text.split("\n");
        curY += lines.length * SPATIAL_LH;
      }
    }

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
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    const ctx = canvas.getContext("2d")!;
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
    const atlas = getGlyphAtlas();
    for (const wf of wireframesRef.current) {
      const top = wf.y - scrollY;
      if (top + wf.h < 0 || top > h) continue;

      ctx.font = SPATIAL_FONT;
      ctx.fillStyle = FG_COLOR;
      ctx.textBaseline = "top";

      for (const { row, startCol, text } of wf.sparse) {
        if (atlas) {
          for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === " ") continue;
            const g = atlas.glyphs.get(c);
            if (g) {
              ctx.drawImage(
                atlas.canvas,
                g.sx, g.sy, atlas.cellWidth, atlas.cellHeight,
                (startCol + i) * cw, top + row * ch, cw, ch,
              );
            } else {
              ctx.fillText(c, (startCol + i) * cw, top + row * ch);
            }
          }
        } else {
          ctx.fillText(text, startCol * cw, top + row * ch);
        }
      }

      // Draw selection highlight
      if (selectedIdRef.current !== null && wf.id === selectedIdRef.current) {
        ctx.strokeStyle = "#4a90e2";
        ctx.lineWidth = 2;
        ctx.strokeRect(wf.x + 1, top + 1, wf.w - 2, wf.h - 2);
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
        const docText = wireframesRef.current.map(wf => wf.originalText).join("\n\n");
        const w = await handle.createWritable();
        await w.write(proseTextRef.current + "\n\n" + docText);
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
          dragRef.current = null;
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
          await w.write(proseTextRef.current);
          await w.close();
        } catch (e) {
          console.error("Save failed:", e);
        }
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
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
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const docY = e.clientY - rect.top + scrollYRef.current;

    const wf = hitTestWireframe(px, docY);
    if (wf) {
      selectedIdRef.current = wf.id;
      dragRef.current = {
        wireframeId: wf.id,
        startY: docY,
        startWfY: wf.y,
      };
      paint();
    } else {
      selectedIdRef.current = null;
      dragRef.current = null;
      paint();
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const docY = e.clientY - rect.top + scrollYRef.current;

    const dy = docY - drag.startY;
    const wf = wireframesRef.current.find(w => w.id === drag.wireframeId);
    if (!wf) return;

    const newY = Math.max(0, drag.startWfY + dy);
    wf.y = newY;

    // Reflow text around updated wireframe position — this is the "wow" moment
    doLayout();
    paint();
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
        cursor: isDragging ? "grabbing" : "default",
      }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    />
  );
}
