import { useEffect, useMemo, useState, useRef } from "react";
import { Stage, Layer, Shape, Rect, Line as KonvaLine, Transformer } from "react-konva";
import { useEditorStore } from "./store";
import { compositeLayers, isEffectivelyVisible } from "./layers";
import {
  GRID_WIDTH, GRID_HEIGHT, CANVAS_PADDING, FONT_SIZE, FONT_FAMILY,
  BG_COLOR, FG_COLOR, measureCellSize, getCharWidth, getCharHeight,
} from "./grid";
import { useGestureAdapter } from "./useGestureAdapter";
import { useToolHandlers } from "./useToolHandlers";

export function KonvaCanvas() {
  const layers = useEditorStore((s) => s.layers);
  const selectedId = useEditorStore((s) => s.selectedId);
  const selectLayer = useEditorStore((s) => s.selectLayer);
  const activeTool = useEditorStore((s) => s.activeTool);
  const [ready, setReady] = useState(false);
  const highWaterRef = useRef<{ rows: number; cols: number }>({ rows: 0, cols: 0 });
  const transformerRef = useRef<any>(null);
  const shapeRefs = useRef<Map<string, any>>(new Map());

  const { onDragStart, onDragEnd, onTransformStart, onTransformEnd, gestureRef } = useGestureAdapter();

  useEffect(() => {
    measureCellSize().then(() => setReady(true));
  }, []);

  // Call useToolHandlers unconditionally (Rules of Hooks) — use 0 when not measured yet
  const charWidth = ready ? getCharWidth() : 0;
  const charHeight = ready ? getCharHeight() : 0;
  const toolHandlers = useToolHandlers(activeTool, charWidth, charHeight);

  // Attach transformer to selected rect
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

  const composite = useMemo(() => compositeLayers(layers), [layers]);

  if (!ready) {
    return <div style={{ background: BG_COLOR, width: "100%", height: "100%" }} />;
  }

  // Derive grid dimensions from content
  let maxRow = 0;
  let maxCol = 0;
  for (const key of composite.keys()) {
    const [r, c] = key.split(",").map(Number);
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }

  const contentRows = maxRow + 1 + CANVAS_PADDING;
  const contentCols = maxCol + 1 + CANVAS_PADDING;

  // Reset high-water mark when layers are empty (reset/new file)
  if (layers.length === 0) {
    highWaterRef.current = { rows: 0, cols: 0 };
  }

  // Grow only, never shrink
  const effectiveRows = Math.max(GRID_HEIGHT, contentRows, highWaterRef.current.rows);
  const effectiveCols = Math.max(GRID_WIDTH, contentCols, highWaterRef.current.cols);
  highWaterRef.current = { rows: effectiveRows, cols: effectiveCols };

  const stageWidth = effectiveCols * charWidth;
  const stageHeight = effectiveRows * charHeight;

  // Build visible non-base, non-group layers for hit targets
  const byId = new Map(layers.map((l) => [l.id, l]));
  const visibleLayers = layers.filter(
    (l) => l.type !== "base" && l.type !== "group" && isEffectivelyVisible(l, byId)
  );

  const isTransforming = gestureRef.current?.active && gestureRef.current.mode === "resize";

  return (
    <Stage
      width={stageWidth}
      height={stageHeight}
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
      <Layer listening={false}>
        <Shape
          sceneFunc={(ctx) => {
            ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
            ctx.fillStyle = FG_COLOR;
            ctx.textBaseline = "top";
            for (let row = 0; row < effectiveRows; row++) {
              let line = "";
              for (let col = 0; col < effectiveCols; col++) {
                line += composite.get(`${row},${col}`) ?? " ";
              }
              ctx.fillText(line, 0, row * charHeight);
            }
          }}
        />
      </Layer>
      <Layer listening={activeTool === "select"}>
        {visibleLayers.map((l) => {
          const x = l.bbox.col * charWidth;
          const y = l.bbox.row * charHeight;
          const w = l.bbox.w * charWidth;
          const h = l.bbox.h * charHeight;
          const selected = l.id === selectedId;

          if (l.type === "line") {
            const isH = l.bbox.h === 1;
            const points = isH
              ? [0, h / 2, w, h / 2]
              : [w / 2, 0, w / 2, h];
            return (
              <KonvaLine
                key={l.id}
                x={x} y={y}
                points={points}
                stroke={selected ? "#4a90e2" : "transparent"}
                strokeWidth={selected ? 2 : 1}
                hitStrokeWidth={10}
                draggable={l.id === selectedId && activeTool === "select"}
                dragBoundFunc={(pos) => ({
                  x: Math.round(pos.x / charWidth) * charWidth,
                  y: Math.round(pos.y / charHeight) * charHeight,
                })}
                onClick={() => selectLayer(l.id)}
                onTap={() => selectLayer(l.id)}
                onDragStart={(e) => onDragStart(l.id, e.target, charWidth, charHeight)}
                onDragEnd={(e) => onDragEnd(l.id, e.target, charWidth, charHeight)}
              />
            );
          }

          return (
            <Rect
              key={l.id}
              ref={(node) => {
                if (node) shapeRefs.current.set(l.id, node);
                else shapeRefs.current.delete(l.id);
              }}
              x={x} y={y} width={w} height={h}
              fill="transparent"
              stroke={selected ? "#4a90e2" : "transparent"}
              strokeWidth={selected ? 2 : 0}
              hitStrokeWidth={10}
              draggable={l.id === selectedId && activeTool === "select" && !isTransforming}
              dragBoundFunc={(pos) => ({
                x: Math.round(pos.x / charWidth) * charWidth,
                y: Math.round(pos.y / charHeight) * charHeight,
              })}
              onClick={() => selectLayer(l.id)}
              onTap={() => selectLayer(l.id)}
              onDragStart={(e) => onDragStart(l.id, e.target, charWidth, charHeight)}
              onDragEnd={(e) => onDragEnd(l.id, e.target, charWidth, charHeight)}
              onTransformStart={(e) => onTransformStart(l.id, e.target, charWidth, charHeight)}
              onTransformEnd={(e) => onTransformEnd(l.id, e.target, charWidth, charHeight)}
            />
          );
        })}
        {toolHandlers.previewNode}
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
    </Stage>
  );
}
