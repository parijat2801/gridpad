import React, { memo, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Stage, Layer, Shape, Rect, Line as KonvaLine, Transformer } from "react-konva";
import { useEditorStore } from "./store";
import { compositeLayers, isEffectivelyVisible, setLastComposite } from "./layers";
import type { Layer as LayerType } from "./layers";
import {
  GRID_WIDTH, GRID_HEIGHT, CANVAS_PADDING, FONT_SIZE, FONT_FAMILY,
  BG_COLOR, FG_COLOR, measureCellSize, getCharWidth, getCharHeight,
  getGlyphAtlas,
} from "./grid";
import { useGestureAdapter } from "./useGestureAdapter";
import { useToolHandlers } from "./useToolHandlers";

// ── Pure helpers ──────────────────────────────────────────

interface GridBounds {
  contentRows: number;
  contentCols: number;
}

function deriveGridBounds(composite: Map<string, string>): GridBounds {
  let maxRow = 0;
  let maxCol = 0;
  for (const key of composite.keys()) {
    const i = key.indexOf(",");
    const r = Number(key.slice(0, i));
    const c = Number(key.slice(i + 1));
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }
  return {
    contentRows: maxRow + 1 + CANVAS_PADDING,
    contentCols: maxCol + 1 + CANVAS_PADDING,
  };
}

// ── Sparse row builder ────────────────────────────────────

export interface SparseRow {
  row: number;
  startCol: number;
  text: string;
}

export function buildSparseRows(composite: Map<string, string>): SparseRow[] {
  const byRow = new Map<number, Map<number, string>>();
  for (const [key, ch] of composite) {
    const i = key.indexOf(",");
    const r = Number(key.slice(0, i));
    const c = Number(key.slice(i + 1));
    let cols = byRow.get(r);
    if (!cols) {
      cols = new Map();
      byRow.set(r, cols);
    }
    cols.set(c, ch);
  }

  const result: SparseRow[] = [];
  const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
  for (const row of sortedRows) {
    const cols = byRow.get(row)!;
    const sortedCols = [...cols.keys()].sort((a, b) => a - b);
    const startCol = sortedCols[0];
    const endCol = sortedCols[sortedCols.length - 1];
    let text = "";
    for (let c = startCol; c <= endCol; c++) {
      text += cols.get(c) ?? " ";
    }
    result.push({ row, startCol, text });
  }
  return result;
}

// ── TextLayer ─────────────────────────────────────────────

interface TextLayerProps {
  layers: LayerType[];
  effectiveRows: number;
  effectiveCols: number;
  charWidth: number;
  charHeight: number;
}

const TextLayer = memo(function TextLayer({
  layers,
  effectiveRows,
  effectiveCols,
  charWidth,
  charHeight,
}: TextLayerProps) {
  const shapeRef = useRef<any>(null);
  const composite = useMemo(() => compositeLayers(layers), [layers]);
  const sparseRows = useMemo(() => buildSparseRows(composite), [composite]);

  useEffect(() => {
    setLastComposite(composite);
    return () => setLastComposite(null);
  }, [composite]);

  // Cache the Shape as a bitmap — subsequent Layer redraws blit the
  // bitmap instead of re-executing sceneFunc.
  useEffect(() => {
    const node = shapeRef.current;
    if (!node) return;
    node.clearCache();
    node.cache({
      x: 0,
      y: 0,
      width: effectiveCols * charWidth,
      height: effectiveRows * charHeight,
      pixelRatio: 1,
    });
    node.getLayer()?.batchDraw();
  }, [composite, effectiveCols, effectiveRows, charWidth, charHeight]);

  return (
    <Layer listening={false}>
      <Shape
        ref={shapeRef}
        sceneFunc={(ctx) => {
          const atlas = getGlyphAtlas();
          if (!atlas) {
            // Fallback: fillText (atlas not yet built)
            ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
            ctx.fillStyle = FG_COLOR;
            ctx.textBaseline = "top";
            for (const { row, startCol, text } of sparseRows) {
              ctx.fillText(text, startCol * charWidth, row * charHeight);
            }
            return;
          }
          for (const { row, startCol, text } of sparseRows) {
            for (let i = 0; i < text.length; i++) {
              const ch = text[i];
              if (ch === " ") continue;
              const glyph = atlas.glyphs.get(ch);
              if (!glyph) {
                // Char not in atlas — fallback to fillText for this char
                ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
                ctx.fillStyle = FG_COLOR;
                ctx.textBaseline = "top";
                ctx.fillText(ch, (startCol + i) * charWidth, row * charHeight);
                continue;
              }
              ctx.drawImage(
                atlas.canvas,
                glyph.sx, glyph.sy, atlas.cellWidth, atlas.cellHeight,
                (startCol + i) * charWidth, row * charHeight, charWidth, charHeight,
              );
            }
          }
        }}
      />
    </Layer>
  );
});

// ── InteractiveLayer ──────────────────────────────────────

interface InteractiveLayerProps {
  layers: LayerType[];
  selectedId: string | null;
  activeTool: string;
  charWidth: number;
  charHeight: number;
  previewNode: React.ReactNode;
}

// ── InteractiveShape (memoized per-layer) ─────────────────

interface InteractiveShapeProps {
  layer: LayerType;
  selected: boolean;
  activeTool: string;
  charWidth: number;
  charHeight: number;
  isTransforming: boolean;
  selectLayer: (id: string | null) => void;
  onDragStart: (id: string, node: any, cw: number, ch: number) => void;
  onDragEnd: (id: string, node: any, cw: number, ch: number) => void;
  onTransformStart: (id: string, node: any, cw: number, ch: number) => void;
  onTransformEnd: (id: string, node: any, cw: number, ch: number) => void;
  snapPos: (pos: { x: number; y: number }) => { x: number; y: number };
  setShapeRef: (id: string, node: any) => void;
}

export const InteractiveShape = memo(function InteractiveShape({
  layer: l,
  selected,
  activeTool,
  charWidth,
  charHeight,
  isTransforming,
  selectLayer,
  onDragStart,
  onDragEnd,
  onTransformStart,
  onTransformEnd,
  snapPos,
  setShapeRef,
}: InteractiveShapeProps) {
  const handleClick = useCallback(() => selectLayer(l.id), [selectLayer, l.id]);
  const handleDragStart = useCallback(
    (e: any) => onDragStart(l.id, e.target, charWidth, charHeight),
    [onDragStart, l.id, charWidth, charHeight],
  );
  const handleDragEnd = useCallback(
    (e: any) => onDragEnd(l.id, e.target, charWidth, charHeight),
    [onDragEnd, l.id, charWidth, charHeight],
  );
  const handleTransformStart = useCallback(
    (e: any) => onTransformStart(l.id, e.target, charWidth, charHeight),
    [onTransformStart, l.id, charWidth, charHeight],
  );
  const handleTransformEnd = useCallback(
    (e: any) => onTransformEnd(l.id, e.target, charWidth, charHeight),
    [onTransformEnd, l.id, charWidth, charHeight],
  );
  const handleRef = useCallback(
    (node: any) => setShapeRef(l.id, node),
    [setShapeRef, l.id],
  );

  const x = l.bbox.col * charWidth;
  const y = l.bbox.row * charHeight;
  const w = l.bbox.w * charWidth;
  const h = l.bbox.h * charHeight;

  if (l.type === "line") {
    const isH = l.bbox.h === 1;
    const points = isH ? [0, h / 2, w, h / 2] : [w / 2, 0, w / 2, h];
    return (
      <KonvaLine
        x={x} y={y}
        points={points}
        stroke={selected ? "#4a90e2" : "transparent"}
        strokeWidth={selected ? 2 : 1}
        hitStrokeWidth={10}
        draggable={selected && activeTool === "select"}
        dragBoundFunc={snapPos}
        onClick={handleClick}
        onTap={handleClick}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      />
    );
  }

  return (
    <Rect
      ref={handleRef}
      x={x} y={y} width={w} height={h}
      fill="transparent"
      stroke={selected ? "#4a90e2" : "transparent"}
      strokeWidth={selected ? 2 : 0}
      hitStrokeWidth={10}
      draggable={selected && activeTool === "select" && !isTransforming}
      dragBoundFunc={snapPos}
      onClick={handleClick}
      onTap={handleClick}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onTransformStart={handleTransformStart}
      onTransformEnd={handleTransformEnd}
    />
  );
});

// ── InteractiveLayer ──────────────────────────────────────

function InteractiveLayer({
  layers,
  selectedId,
  activeTool,
  charWidth,
  charHeight,
  previewNode,
}: InteractiveLayerProps) {
  const selectLayer = useEditorStore((s) => s.selectLayer);
  const { onDragStart, onDragEnd, onTransformStart, onTransformEnd, gestureRef } =
    useGestureAdapter();
  const transformerRef = useRef<any>(null);
  const shapeRefs = useRef<Map<string, any>>(new Map());

  const byId = useMemo(() => new Map(layers.map((l) => [l.id, l])), [layers]);
  const visibleLayers = useMemo(
    () => layers.filter(
      (l) => l.type !== "base" && l.type !== "group" && isEffectivelyVisible(l, byId),
    ),
    [layers, byId],
  );

  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const selectedLayer = layers.find((l) => l.id === selectedId);
    if (selectedId && selectedLayer?.type === "rect" && selectedLayer.style
        && shapeRefs.current.has(selectedId)) {
      tr.nodes([shapeRefs.current.get(selectedId)]);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [selectedId, layers]);

  const isTransforming = gestureRef.current?.active && gestureRef.current.mode === "resize";

  const snapPos = useCallback(
    (pos: { x: number; y: number }) => ({
      x: Math.round(pos.x / charWidth) * charWidth,
      y: Math.round(pos.y / charHeight) * charHeight,
    }),
    [charWidth, charHeight],
  );

  const setShapeRef = useCallback((id: string, node: any) => {
    if (node) shapeRefs.current.set(id, node);
    else shapeRefs.current.delete(id);
  }, []);

  return (
    <Layer listening={activeTool === "select"}>
      {visibleLayers.map((l) => (
        <InteractiveShape
          key={l.id}
          layer={l}
          selected={l.id === selectedId}
          activeTool={activeTool}
          charWidth={charWidth}
          charHeight={charHeight}
          isTransforming={!!isTransforming}
          selectLayer={selectLayer}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onTransformStart={onTransformStart}
          onTransformEnd={onTransformEnd}
          snapPos={snapPos}
          setShapeRef={setShapeRef}
        />
      ))}
      {previewNode}
      <Transformer
        ref={transformerRef}
        rotateEnabled={false}
        keepRatio={false}
        enabledAnchors={[
          "top-left", "top-right", "bottom-left", "bottom-right",
          "top-center", "bottom-center", "middle-left", "middle-right",
        ]}
        boundBoxFunc={(oldBox, newBox) => {
          const snapped = { ...newBox };
          const rightStable = Math.abs((newBox.x + newBox.width) - (oldBox.x + oldBox.width)) < charWidth / 2;
          if (rightStable) {
            const right = oldBox.x + oldBox.width;
            snapped.x = Math.round(newBox.x / charWidth) * charWidth;
            snapped.width = Math.max(charWidth, right - snapped.x);
          } else {
            snapped.x = Math.round(newBox.x / charWidth) * charWidth;
            snapped.width = Math.max(charWidth, Math.round(newBox.width / charWidth) * charWidth);
          }
          const bottomStable = Math.abs((newBox.y + newBox.height) - (oldBox.y + oldBox.height)) < charHeight / 2;
          if (bottomStable) {
            const bottom = oldBox.y + oldBox.height;
            snapped.y = Math.round(newBox.y / charHeight) * charHeight;
            snapped.height = Math.max(charHeight, bottom - snapped.y);
          } else {
            snapped.y = Math.round(newBox.y / charHeight) * charHeight;
            snapped.height = Math.max(charHeight, Math.round(newBox.height / charHeight) * charHeight);
          }
          return snapped;
        }}
      />
    </Layer>
  );
}

// ── KonvaCanvas (shell) ───────────────────────────────────

export function KonvaCanvas() {
  const layers = useEditorStore((s) => s.layers);
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectLayer = useEditorStore((s) => s.selectLayer);
  const activeTool = useEditorStore((s) => s.activeTool);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    measureCellSize().then(() => setReady(true));
  }, []);

  const charWidth = ready ? getCharWidth() : 0;
  const charHeight = ready ? getCharHeight() : 0;
  const toolHandlers = useToolHandlers(activeTool, charWidth, charHeight);

  const composite = useMemo(() => compositeLayers(layers), [layers]);
  const gridBounds = useMemo(() => deriveGridBounds(composite), [composite]);

  if (!ready) {
    return <div style={{ background: BG_COLOR, width: "100%", height: "100%" }} />;
  }

  // Derive grid size from content + minimums (no grow-only high-water mark)
  const effectiveRows = Math.max(GRID_HEIGHT, gridBounds.contentRows);
  const effectiveCols = Math.max(GRID_WIDTH, gridBounds.contentCols);

  return (
    <Stage
      width={effectiveCols * charWidth}
      height={effectiveRows * charHeight}
      style={{ background: BG_COLOR }}
      tabIndex={0}
      role="application"
      aria-label="ASCII wireframe canvas"
      onClick={(e) => {
        if (e.target === e.target.getStage()) selectLayer(null);
      }}
      onMouseDown={toolHandlers.onMouseDown}
      onMouseMove={toolHandlers.onMouseMove}
      onMouseUp={toolHandlers.onMouseUp}
    >
      <TextLayer
        layers={layers}
        effectiveRows={effectiveRows}
        effectiveCols={effectiveCols}
        charWidth={charWidth}
        charHeight={charHeight}
      />
      <InteractiveLayer
        layers={layers}
        selectedId={selectedId}
        activeTool={activeTool}
        charWidth={charWidth}
        charHeight={charHeight}
        previewNode={toolHandlers.previewNode}
      />
    </Stage>
  );
}
