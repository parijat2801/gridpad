/**
 * Minimal Pretext + Wireframe demo.
 * One canvas. Prose via Pretext. Wireframes via glyph atlas.
 * Drag wireframes. Resize rect wireframes. Text reflows.
 */
import { useEffect, useRef, useState } from "react";
import { prepareWithSegments, layoutWithLines, type LayoutLine } from "@chenglou/pretext";
import { scan } from "./scanner";
import { detectRegions, type Region } from "./regions";
import { compositeLayers, regenerateCells } from "./layers";
import type { Layer } from "./layers";
import { buildSparseRows, type SparseRow } from "./KonvaCanvas";
import type { Bbox } from "./types";
import {
  FONT_SIZE, FONT_FAMILY, BG_COLOR, FG_COLOR,
  measureCellSize, getCharWidth, getCharHeight,
  getGlyphAtlas,
} from "./grid";

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

interface LayoutRegion {
  region: Region;
  y: number;
  height: number;
  lines?: LayoutLine[];
  sparse?: SparseRow[];
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
  const gestureRef = useRef<GestureState | null>(null);

  const [, forceRender] = useState(0);
  const kick = () => forceRender(t => t + 1);

  useEffect(() => {
    measureCellSize().then(() => {
      cwRef.current = getCharWidth();
      chRef.current = getCharHeight();
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
          const file = await handle.getFile();
          docTextRef.current = await file.text();
          scrollYRef.current = 0;
          selectedIdRef.current = null;
          gestureRef.current = null;
          kick();
        } catch { /* cancelled */ }
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  // ── Layout ─────────────────────────────────────────────
  function doLayout() {
    const cw = cwRef.current;
    const ch = chRef.current;
    if (!cw) return;
    const regions = detectRegions(scan(docTextRef.current));
    const laid: LayoutRegion[] = [];
    let y = 0;
    for (const r of regions) {
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
  }

  // ── Render ─────────────────────────────────────────────
  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = sizeRef.current;
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
  }

  // Only re-layout when not mid-gesture (gesture directly mutates layers + repaints)
  if (ready && !gestureRef.current) doLayout();
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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const docY = e.clientY - rect.top + scrollYRef.current;
    const cw = cwRef.current;
    const ch = chRef.current;
    const hit = findLayerAt(px, docY);

    if (hit) {
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
      selectedIdRef.current = null;
      gestureRef.current = null;
      paint();
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const g = gestureRef.current;
    if (!g) return;
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
    if (g) {
      // Persist the mutation: stitch regions back into docText
      const parts: string[] = [];
      for (const lr of laidRef.current) {
        if (lr.region.type === "wireframe" && lr.region.layers) {
          // Rebuild wireframe text from mutated layers
          const composite = compositeLayers(lr.region.layers);
          const sparse = buildSparseRows(composite);
          const rows = lr.region.endRow - lr.region.startRow + 1;
          const textLines: string[] = [];
          for (let r = 0; r < rows; r++) {
            const sr = sparse.find(s => s.row === r);
            if (sr) {
              const prefix = " ".repeat(sr.startCol);
              textLines.push((prefix + sr.text).trimEnd());
            } else {
              textLines.push("");
            }
          }
          // Trim trailing empty lines
          while (textLines.length > 0 && textLines[textLines.length - 1] === "") textLines.pop();
          parts.push(textLines.join("\n"));
        } else {
          parts.push(lr.region.text);
        }
      }
      docTextRef.current = parts.join("\n\n");
      gestureRef.current = null;
      // Re-layout with updated text so layers match
      doLayout();
      paint();
    }
  }

  function onWheel(e: React.WheelEvent) {
    const totalH = laidRef.current.reduce((s, r) => s + r.height, 0);
    const maxScroll = Math.max(0, totalH - sizeRef.current.h);
    scrollYRef.current = Math.max(0, Math.min(maxScroll, scrollYRef.current + e.deltaY));
    paint();
  }

  if (!ready) {
    return <div style={{ background: BG_COLOR, width: "100vw", height: "100vh" }} />;
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        background: BG_COLOR, display: "block",
        position: "fixed", top: 0, left: 0,
        width: sizeRef.current.w, height: sizeRef.current.h,
        cursor: getCursor(),
      }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    />
  );
}
