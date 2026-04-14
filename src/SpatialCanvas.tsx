import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { prepareWithSegments, layoutWithLines, type LayoutLine } from "@chenglou/pretext";
import { useEditorStore } from "./store";
import { scan } from "./scanner";
import { detectRegions, type Region } from "./regions";
import { compositeLayers } from "./layers";
import { buildSparseRows, type SparseRow } from "./KonvaCanvas";
import {
  FONT_SIZE, FONT_FAMILY, BG_COLOR, FG_COLOR,
  measureCellSize, getCharWidth, getCharHeight,
  getGlyphAtlas,
} from "./grid";

const PROSE_FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const LINE_HEIGHT = Math.ceil(FONT_SIZE * 1.15);

/** Laid-out region ready for rendering */
interface RenderedRegion {
  region: Region;
  y: number;
  height: number;
  lines?: LayoutLine[];
  sparseRows?: SparseRow[];
}

// ── Exported pure render functions (testable) ──────────────

export function renderProseRegion(
  ctx: CanvasRenderingContext2D,
  lines: LayoutLine[],
  regionY: number,
  lineHeight: number,
  scrollY: number,
): void {
  ctx.font = PROSE_FONT;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i].text, 0, regionY + i * lineHeight - scrollY);
  }
}

function renderWireframeRegion(
  ctx: CanvasRenderingContext2D,
  sparseRows: SparseRow[],
  regionY: number,
  charWidth: number,
  charHeight: number,
  scrollY: number,
  selectedId: string | null,
  layers: Region["layers"],
): void {
  const atlas = getGlyphAtlas();
  if (!atlas) {
    ctx.font = PROSE_FONT;
    ctx.fillStyle = FG_COLOR;
    ctx.textBaseline = "top";
    for (const { row, startCol, text } of sparseRows) {
      ctx.fillText(text, startCol * charWidth, regionY + row * charHeight - scrollY);
    }
  } else {
    for (const { row, startCol, text } of sparseRows) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === " ") continue;
        const glyph = atlas.glyphs.get(ch);
        if (!glyph) {
          ctx.font = PROSE_FONT;
          ctx.fillStyle = FG_COLOR;
          ctx.textBaseline = "top";
          ctx.fillText(ch, (startCol + i) * charWidth, regionY + row * charHeight - scrollY);
          continue;
        }
        ctx.drawImage(
          atlas.canvas,
          glyph.sx, glyph.sy, atlas.cellWidth, atlas.cellHeight,
          (startCol + i) * charWidth, regionY + row * charHeight - scrollY,
          charWidth, charHeight,
        );
      }
    }
  }

  // Selection highlight
  if (selectedId && layers) {
    for (const l of layers) {
      if (l.id === selectedId) {
        ctx.strokeStyle = "#4a90e2";
        ctx.lineWidth = 2;
        ctx.strokeRect(
          l.bbox.col * charWidth,
          regionY + l.bbox.row * charHeight - scrollY,
          l.bbox.w * charWidth,
          l.bbox.h * charHeight,
        );
      }
    }
  }
}

// ── Component ──────────────────────────────────────────────

export function SpatialCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const layers = useEditorStore((s) => s.layers);
  const selectedId = useEditorStore((s) => s.selectedId);

  useEffect(() => {
    measureCellSize().then(() => setReady(true));
  }, []);

  const charWidth = ready ? getCharWidth() : 0;
  const charHeight = ready ? getCharHeight() : 0;

  // Detect regions from current text
  const regions = useMemo(() => {
    const text = useEditorStore.getState().toText();
    if (!text) return [];
    const scanResult = scan(text);
    return detectRegions(scanResult);
  }, [layers]);

  // Canvas dimensions — fill parent
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width: Math.floor(width), height: Math.floor(height) });
      }
    });
    obs.observe(parent);
    // Initial size
    setCanvasSize({
      width: Math.floor(parent.clientWidth),
      height: Math.floor(parent.clientHeight),
    });
    return () => obs.disconnect();
  }, []);

  // Lay out each region
  const renderedRegions = useMemo((): RenderedRegion[] => {
    if (!ready || charWidth === 0) return [];
    const maxWidth = canvasSize.width;

    let y = 0;
    const result: RenderedRegion[] = [];

    for (const region of regions) {
      if (region.type === "prose") {
        const prepared = prepareWithSegments(region.text, PROSE_FONT);
        const layoutResult = layoutWithLines(prepared, maxWidth, LINE_HEIGHT);
        result.push({
          region,
          y,
          height: layoutResult.height,
          lines: layoutResult.lines,
        });
        y += layoutResult.height;
      } else {
        const composite = compositeLayers(region.layers ?? []);
        const sparse = buildSparseRows(composite);
        const regionRows = region.endRow - region.startRow + 1;
        const height = regionRows * charHeight;
        result.push({
          region,
          y,
          height,
          sparseRows: sparse,
        });
        y += height;
      }
    }
    return result;
  }, [regions, ready, charWidth, charHeight, canvasSize.width]);

  const totalHeight = renderedRegions.reduce((sum, r) => sum + r.height, 0);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const rr of renderedRegions) {
      // Skip off-screen regions
      if (rr.y + rr.height < scrollY || rr.y > scrollY + canvasSize.height) continue;

      if (rr.region.type === "prose" && rr.lines) {
        renderProseRegion(ctx, rr.lines, rr.y, LINE_HEIGHT, scrollY);
      } else if (rr.sparseRows) {
        renderWireframeRegion(
          ctx, rr.sparseRows, rr.y, charWidth, charHeight, scrollY,
          selectedId, rr.region.layers,
        );
      }
    }
  }, [renderedRegions, scrollY, ready, charWidth, charHeight, selectedId, canvasSize]);

  // Scroll handler
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScrollY((prev) =>
      Math.max(0, Math.min(totalHeight - canvasSize.height, prev + e.deltaY))
    );
  }, [totalHeight, canvasSize.height]);

  // Click handler — select wireframe shapes
  const handleClick = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top + scrollY;

    for (const rr of renderedRegions) {
      if (py >= rr.y && py < rr.y + rr.height) {
        if (rr.region.type === "wireframe" && rr.region.layers) {
          const localY = py - rr.y;
          const gridRow = Math.floor(localY / charHeight);
          const gridCol = Math.floor(px / charWidth);
          // Hit test: find topmost layer at this cell
          let bestId: string | null = null;
          let bestZ = -Infinity;
          for (const l of rr.region.layers) {
            if (l.type === "base" || l.type === "group" || !l.visible) continue;
            const { row, col, w, h } = l.bbox;
            if (gridRow >= row && gridRow < row + h && gridCol >= col && gridCol < col + w) {
              if (l.z > bestZ) {
                bestZ = l.z;
                bestId = l.id;
              }
            }
          }
          useEditorStore.getState().selectLayer(bestId);
        } else {
          useEditorStore.getState().selectLayer(null);
        }
        return;
      }
    }
    useEditorStore.getState().selectLayer(null);
  }, [renderedRegions, scrollY, charWidth, charHeight]);

  if (!ready) {
    return <div style={{ background: BG_COLOR, width: "100%", height: "100%" }} />;
  }

  return (
    <canvas
      ref={canvasRef}
      width={canvasSize.width}
      height={canvasSize.height}
      style={{ background: BG_COLOR, display: "block", cursor: "default" }}
      tabIndex={0}
      role="application"
      aria-label="Spatial document canvas"
      onWheel={handleWheel}
      onClick={handleClick}
    />
  );
}
