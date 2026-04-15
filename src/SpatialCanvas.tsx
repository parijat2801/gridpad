import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { prepareWithSegments, layoutWithLines, type LayoutLine } from "@chenglou/pretext";
import { useEditorStore } from "./store";
import { scan } from "./scanner";
import { detectRegions, type Region } from "./regions";
import { compositeLayers } from "./layers";
import { buildSparseRows, type SparseRow } from "./KonvaCanvas";
import type { Bbox } from "./types";
import {
  FONT_SIZE, FONT_FAMILY, BG_COLOR, FG_COLOR,
  measureCellSize, getCharWidth, getCharHeight,
  getGlyphAtlas,
} from "./grid";

const PROSE_FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const LINE_HEIGHT = Math.ceil(FONT_SIZE * 1.15);

interface RenderedRegion {
  region: Region;
  y: number;
  height: number;
  lines?: LayoutLine[];
  sparseRows?: SparseRow[];
}

interface DragState {
  layerId: string;
  regionIdx: number;
  startBbox: Bbox;
  startPx: { x: number; y: number };
}

interface CursorState {
  regionIdx: number;
  row: number; // source line index within prose region
  col: number;
}

// ── Pure render functions ──────────────────────────────────

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
  ctx.font = PROSE_FONT;
  ctx.fillStyle = FG_COLOR;
  ctx.textBaseline = "top";

  for (const { row, startCol, text } of sparseRows) {
    if (atlas) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === " ") continue;
        const glyph = atlas.glyphs.get(ch);
        if (glyph) {
          ctx.drawImage(
            atlas.canvas,
            glyph.sx, glyph.sy, atlas.cellWidth, atlas.cellHeight,
            (startCol + i) * charWidth, regionY + row * charHeight - scrollY,
            charWidth, charHeight,
          );
        } else {
          ctx.fillText(ch, (startCol + i) * charWidth, regionY + row * charHeight - scrollY);
        }
      }
    } else {
      ctx.fillText(text, startCol * charWidth, regionY + row * charHeight - scrollY);
    }
  }

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

function renderCursor(
  ctx: CanvasRenderingContext2D,
  cursorX: number,
  cursorY: number,
  charHeight: number,
  visible: boolean,
): void {
  if (!visible) return;
  ctx.fillStyle = "#e0e0e0";
  ctx.fillRect(cursorX, cursorY, 2, charHeight);
}

// ── Hit testing ──────────────────────────────────────────

function hitTestLayers(
  layers: Region["layers"],
  gridRow: number,
  gridCol: number,
): string | null {
  if (!layers) return null;
  let bestId: string | null = null;
  let bestZ = -Infinity;
  for (const l of layers) {
    if (l.type === "base" || l.type === "group" || !l.visible) continue;
    const { row, col, w, h } = l.bbox;
    if (gridRow >= row && gridRow < row + h && gridCol >= col && gridCol < col + w) {
      if (l.z > bestZ) {
        bestZ = l.z;
        bestId = l.id;
      }
    }
  }
  return bestId;
}

// ── Component ──────────────────────────────────────────────

export function SpatialCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const layers = useEditorStore((s) => s.layers);
  const selectedId = useEditorStore((s) => s.selectedId);

  // Drag state
  const dragRef = useRef<DragState | null>(null);

  // Text cursor state
  const [cursor, setCursor] = useState<CursorState | null>(null);
  const cursorBlinkRef = useRef(true);
  const cursorTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    measureCellSize().then(() => setReady(true));
  }, []);

  const charWidth = ready ? getCharWidth() : 0;
  const charHeight = ready ? getCharHeight() : 0;

  // Regions from current text
  const regions = useMemo(() => {
    const text = useEditorStore.getState().toText();
    if (text === "") return [];
    const scanResult = scan(text);
    return detectRegions(scanResult);
  }, [layers]);

  // Canvas sizing
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setCanvasSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    obs.observe(parent);
    setCanvasSize({
      width: Math.floor(parent.clientWidth) || 800,
      height: Math.floor(parent.clientHeight) || 600,
    });
    return () => obs.disconnect();
  }, []);

  // Layout regions
  const renderedRegions = useMemo((): RenderedRegion[] => {
    if (!ready || charWidth === 0) return [];
    const maxWidth = canvasSize.width;
    let y = 0;
    const result: RenderedRegion[] = [];

    for (const region of regions) {
      if (region.type === "prose") {
        const prepared = prepareWithSegments(region.text, PROSE_FONT);
        const layoutResult = layoutWithLines(prepared, maxWidth, LINE_HEIGHT);
        result.push({ region, y, height: layoutResult.height, lines: layoutResult.lines });
        y += layoutResult.height;
      } else {
        const composite = compositeLayers(region.layers ?? []);
        const sparse = buildSparseRows(composite);
        const regionRows = region.endRow - region.startRow + 1;
        const height = regionRows * charHeight;
        result.push({ region, y, height, sparseRows: sparse });
        y += height;
      }
    }
    return result;
  }, [regions, ready, charWidth, charHeight, canvasSize.width]);

  const totalHeight = renderedRegions.reduce((sum, r) => sum + r.height, 0);

  // Cursor blink
  useEffect(() => {
    if (cursor) {
      cursorBlinkRef.current = true;
      if (cursorTimerRef.current) clearInterval(cursorTimerRef.current);
      cursorTimerRef.current = setInterval(() => {
        cursorBlinkRef.current = !cursorBlinkRef.current;
        // Force re-render for blink
        const canvas = canvasRef.current;
        if (canvas) canvas.dispatchEvent(new Event("cursorblink"));
      }, 530);
    } else {
      if (cursorTimerRef.current) clearInterval(cursorTimerRef.current);
    }
    return () => { if (cursorTimerRef.current) clearInterval(cursorTimerRef.current); };
  }, [cursor]);

  // ── Render ─────────────────────────────────────────────

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const rr of renderedRegions) {
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

    // Draw cursor
    if (cursor && renderedRegions[cursor.regionIdx]) {
      const rr = renderedRegions[cursor.regionIdx];
      if (rr.region.type === "prose") {
        const cursorX = cursor.col * charWidth;
        const cursorY = rr.y + cursor.row * LINE_HEIGHT - scrollY;
        renderCursor(ctx, cursorX, cursorY, LINE_HEIGHT, cursorBlinkRef.current);
      }
    }
  }, [renderedRegions, scrollY, ready, charWidth, charHeight, selectedId, canvasSize, cursor]);

  useEffect(() => {
    renderFrame();
  }, [renderFrame]);

  // Listen for cursor blink redraws
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = () => renderFrame();
    canvas.addEventListener("cursorblink", handler);
    return () => canvas.removeEventListener("cursorblink", handler);
  }, [renderFrame]);

  // ── Scroll ─────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScrollY((prev) =>
      Math.max(0, Math.min(Math.max(0, totalHeight - canvasSize.height), prev + e.deltaY))
    );
  }, [totalHeight, canvasSize.height]);

  // ── Find region at pixel position ──────────────────────

  const findRegionAt = useCallback((docY: number): { rr: RenderedRegion; idx: number } | null => {
    for (let i = 0; i < renderedRegions.length; i++) {
      const rr = renderedRegions[i];
      if (docY >= rr.y && docY < rr.y + rr.height) return { rr, idx: i };
    }
    return null;
  }, [renderedRegions]);

  // ── Mouse down — start drag or place cursor ────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const docY = e.clientY - rect.top + scrollY;
    const hit = findRegionAt(docY);

    if (!hit) {
      useEditorStore.getState().selectLayer(null);
      setCursor(null);
      return;
    }

    const { rr, idx } = hit;

    if (rr.region.type === "wireframe" && rr.region.layers) {
      setCursor(null);
      const localY = docY - rr.y;
      const gridRow = Math.floor(localY / charHeight);
      const gridCol = Math.floor(px / charWidth);
      const layerId = hitTestLayers(rr.region.layers, gridRow, gridCol);

      if (layerId) {
        useEditorStore.getState().selectLayer(layerId);
        // Start drag
        const layer = rr.region.layers.find(l => l.id === layerId);
        if (layer) {
          dragRef.current = {
            layerId,
            regionIdx: idx,
            startBbox: { ...layer.bbox },
            startPx: { x: px, y: docY },
          };
        }
      } else {
        useEditorStore.getState().selectLayer(null);
      }
    } else if (rr.region.type === "prose") {
      useEditorStore.getState().selectLayer(null);
      // Place text cursor
      const localY = docY - rr.y;
      const sourceLines = rr.region.text.split("\n");
      const row = Math.min(Math.floor(localY / LINE_HEIGHT), sourceLines.length - 1);
      const col = Math.min(Math.floor(px / charWidth), sourceLines[Math.max(0, row)]?.length ?? 0);
      setCursor({ regionIdx: idx, row: Math.max(0, row), col: Math.max(0, col) });
      cursorBlinkRef.current = true;
    }
  }, [findRegionAt, scrollY, charWidth, charHeight]);

  // ── Mouse move — drag ──────────────────────────────────

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const docY = e.clientY - rect.top + scrollY;

    const deltaCol = Math.round((px - drag.startPx.x) / charWidth);
    const deltaRow = Math.round((docY - drag.startPx.y) / charHeight);

    const newBbox: Bbox = {
      row: drag.startBbox.row + deltaRow,
      col: drag.startBbox.col + deltaCol,
      w: drag.startBbox.w,
      h: drag.startBbox.h,
    };

    useEditorStore.getState().moveLayerLive(drag.layerId, newBbox);
  }, [scrollY, charWidth, charHeight]);

  // ── Mouse up — end drag ────────────────────────────────

  const handleMouseUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;

    // Commit the final position — read from store
    const store = useEditorStore.getState();
    const layer = store.layers.find(l => l.id === drag.layerId);
    if (layer) {
      store.moveLayerCommit(drag.layerId, layer.bbox);
    }
  }, []);

  // ── Keyboard — text editing + shortcuts ────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // If cursor active in prose, handle text editing
    if (cursor && renderedRegions[cursor.regionIdx]?.region.type === "prose") {
      const region = renderedRegions[cursor.regionIdx].region;
      const sourceLines = region.text.split("\n");
      const { row, col } = cursor;

      // Arrow keys
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (col > 0) setCursor({ ...cursor, col: col - 1 });
        else if (row > 0) setCursor({ ...cursor, row: row - 1, col: sourceLines[row - 1]?.length ?? 0 });
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const lineLen = sourceLines[row]?.length ?? 0;
        if (col < lineLen) setCursor({ ...cursor, col: col + 1 });
        else if (row < sourceLines.length - 1) setCursor({ ...cursor, row: row + 1, col: 0 });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (row > 0) {
          const newCol = Math.min(col, sourceLines[row - 1]?.length ?? 0);
          setCursor({ ...cursor, row: row - 1, col: newCol });
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (row < sourceLines.length - 1) {
          const newCol = Math.min(col, sourceLines[row + 1]?.length ?? 0);
          setCursor({ ...cursor, row: row + 1, col: newCol });
        }
        return;
      }

      // Backspace
      if (e.key === "Backspace") {
        e.preventDefault();
        if (row === 0 && col === 0) return;
        if (col === 0) {
          // Merge with previous line
          const prevLine = sourceLines[row - 1] ?? "";
          const newCol = prevLine.length;
          sourceLines[row - 1] = prevLine + (sourceLines[row] ?? "");
          sourceLines.splice(row, 1);
          const newText = sourceLines.join("\n");
          updateProseRegionText(cursor.regionIdx, newText);
          setCursor({ ...cursor, row: row - 1, col: newCol });
        } else {
          const line = sourceLines[row] ?? "";
          sourceLines[row] = line.slice(0, col - 1) + line.slice(col);
          const newText = sourceLines.join("\n");
          updateProseRegionText(cursor.regionIdx, newText);
          setCursor({ ...cursor, col: col - 1 });
        }
        return;
      }

      // Delete
      if (e.key === "Delete") {
        e.preventDefault();
        const line = sourceLines[row] ?? "";
        if (col < line.length) {
          sourceLines[row] = line.slice(0, col) + line.slice(col + 1);
        } else if (row < sourceLines.length - 1) {
          sourceLines[row] = line + (sourceLines[row + 1] ?? "");
          sourceLines.splice(row + 1, 1);
        }
        const newText = sourceLines.join("\n");
        updateProseRegionText(cursor.regionIdx, newText);
        return;
      }

      // Enter
      if (e.key === "Enter") {
        e.preventDefault();
        const line = sourceLines[row] ?? "";
        sourceLines[row] = line.slice(0, col);
        sourceLines.splice(row + 1, 0, line.slice(col));
        const newText = sourceLines.join("\n");
        updateProseRegionText(cursor.regionIdx, newText);
        setCursor({ ...cursor, row: row + 1, col: 0 });
        return;
      }

      // Printable character
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const line = sourceLines[row] ?? "";
        sourceLines[row] = line.slice(0, col) + e.key + line.slice(col);
        const newText = sourceLines.join("\n");
        updateProseRegionText(cursor.regionIdx, newText);
        setCursor({ ...cursor, col: col + 1 });
        return;
      }

      // Escape — deselect cursor
      if (e.key === "Escape") {
        setCursor(null);
        return;
      }
    }

    // Non-cursor shortcuts
    if (e.key === "Escape") {
      useEditorStore.getState().selectLayer(null);
      setCursor(null);
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
      e.preventDefault();
      useEditorStore.getState().deleteLayer(selectedId);
    }
  }, [cursor, renderedRegions, selectedId]);

  // ── Update prose text → rebuild full document ──────────

  const updateProseRegionText = useCallback((regionIdx: number, newText: string) => {
    // Reconstruct full document from regions with the updated prose
    const parts: string[] = [];
    for (let i = 0; i < regions.length; i++) {
      if (i === regionIdx) {
        parts.push(newText);
      } else {
        parts.push(regions[i].text);
      }
    }
    const fullText = parts.join("\n\n");
    useEditorStore.getState().loadFromText(fullText);
  }, [regions]);

  // ── Ready gate ─────────────────────────────────────────

  if (!ready) {
    return <div style={{ background: BG_COLOR, width: "100%", height: "100%" }} />;
  }

  return (
    <canvas
      ref={canvasRef}
      width={canvasSize.width}
      height={canvasSize.height}
      style={{ background: BG_COLOR, display: "block", cursor: cursor ? "text" : "default" }}
      tabIndex={0}
      role="application"
      aria-label="Spatial document canvas"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onKeyDown={handleKeyDown}
    />
  );
}
