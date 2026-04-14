import { useState, useRef, useEffect, type ReactNode } from "react";
import { Rect as KonvaRect, Line as KonvaLine } from "react-konva";
import { useEditorStore } from "./store";
import type { Bbox } from "./types";
import type { ToolId } from "./store";
import { pixelToCell } from "./grid";
import { regenerateCells, LIGHT_RECT_STYLE, buildLineCells, buildTextCells } from "./layers";

interface ToolHandlers {
  onMouseDown: (e: any) => void;
  onMouseMove: (e: any) => void;
  onMouseUp: () => void;
  previewNode: ReactNode;
}

export function useToolHandlers(
  activeTool: ToolId,
  charWidth: number,
  charHeight: number,
): ToolHandlers {
  // ── Rect tool state ──
  const [rectPreview, setRectPreview] = useState<Bbox | null>(null);
  const rectStartRef = useRef<{ row: number; col: number } | null>(null);

  // ── Line tool state ──
  const [linePreview, setLinePreview] = useState<{
    r1: number; c1: number; r2: number; c2: number;
  } | null>(null);
  const lineStartRef = useRef<{ row: number; col: number } | null>(null);

  // ── Text tool state ──
  const [textCursor, setTextCursor] = useState<{
    row: number; col: number;
  } | null>(null);
  const textBufferRef = useRef<string>("");
  const textKeyListenerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  // ── Eraser tool state ──
  // Use ref (not state) for cell accumulation so mouseUp always sees
  // the latest cells, even if React hasn't re-rendered yet.
  const eraserCellsRef = useRef<{ row: number; col: number }[]>([]);
  const [eraserCellsForRender, setEraserCellsForRender] = useState<
    { row: number; col: number }[]
  >([]);
  const erasingRef = useRef(false);

  // Helper: commit text buffer to store and clear cursor
  function commitText() {
    if (textCursor && textBufferRef.current.length > 0) {
      const { bbox, cells, content } = buildTextCells(
        textCursor.row, textCursor.col, textBufferRef.current
      );
      if (cells.size > 0) {
        useEditorStore.getState().addLayer({
          type: "text",
          bbox,
          cells,
          visible: true,
          content,
        });
      }
    }
    textBufferRef.current = "";
    setTextCursor(null);
    if (textKeyListenerRef.current) {
      window.removeEventListener("keydown", textKeyListenerRef.current);
      textKeyListenerRef.current = null;
    }
  }

  // Cleanup on tool switch: commit text if deactivating text tool
  useEffect(() => {
    if (activeTool !== "text") {
      commitText();
    }
  }, [activeTool]);

  // Cleanup on unmount: remove any lingering text tool listener
  useEffect(() => {
    return () => {
      if (textKeyListenerRef.current) {
        window.removeEventListener("keydown", textKeyListenerRef.current);
        textKeyListenerRef.current = null;
      }
    };
  }, []);

  // ── Dispatch ──
  function onMouseDown(e: any) {
    const stage = e.target.getStage?.();
    if (!stage) return;
    const isStage = e.target === stage;
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const raw = pixelToCell(pos.x, pos.y);
    const cell = { row: Math.max(0, raw.row), col: Math.max(0, raw.col) };

    if (activeTool === "rect" && isStage) {
      rectStartRef.current = cell;
      setRectPreview({ row: cell.row, col: cell.col, w: 1, h: 1 });
    }

    if (activeTool === "line" && isStage) {
      lineStartRef.current = cell;
      setLinePreview({ r1: cell.row, c1: cell.col, r2: cell.row, c2: cell.col });
    }

    if (activeTool === "text") {
      commitText();
      if (isStage) {
        setTextCursor(cell);
        textBufferRef.current = "";
        const onKey = (e: KeyboardEvent) => {
          // Ignore events from UI inputs
          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
          if (e.key === "Escape") { commitText(); return; }
          if (e.key === "Backspace") {
            e.preventDefault();
            textBufferRef.current = textBufferRef.current.slice(0, -1);
            return;
          }
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            textBufferRef.current += e.key;
          }
        };
        window.addEventListener("keydown", onKey);
        textKeyListenerRef.current = onKey;
      }
    }

    if (activeTool === "eraser" && isStage) {
      erasingRef.current = true;
      eraserCellsRef.current = [cell];
      setEraserCellsForRender([cell]);
    }
  }

  function onMouseMove(e: any) {
    const pos = e.target.getStage?.()?.getPointerPosition();
    if (!pos) return;
    const raw = pixelToCell(pos.x, pos.y);
    const cell = { row: Math.max(0, raw.row), col: Math.max(0, raw.col) };

    if (activeTool === "rect" && rectStartRef.current) {
      const s = rectStartRef.current;
      setRectPreview({
        row: Math.min(s.row, cell.row),
        col: Math.min(s.col, cell.col),
        w: Math.abs(cell.col - s.col) + 1,
        h: Math.abs(cell.row - s.row) + 1,
      });
    }

    if (activeTool === "line" && lineStartRef.current) {
      const s = lineStartRef.current;
      const dRow = Math.abs(cell.row - s.row);
      const dCol = Math.abs(cell.col - s.col);
      if (dCol >= dRow) {
        setLinePreview({ r1: s.row, c1: s.col, r2: s.row, c2: cell.col });
      } else {
        setLinePreview({ r1: s.row, c1: s.col, r2: cell.row, c2: s.col });
      }
    }

    if (activeTool === "eraser" && erasingRef.current) {
      const prev = eraserCellsRef.current;
      if (!prev.some((c) => c.row === cell.row && c.col === cell.col)) {
        const next = [...prev, cell];
        eraserCellsRef.current = next;
        setEraserCellsForRender(next);
      }
    }
  }

  function onMouseUp() {
    if (activeTool === "rect" && rectPreview) {
      if (rectPreview.w >= 2 && rectPreview.h >= 2) {
        useEditorStore.getState().addLayer({
          type: "rect",
          bbox: rectPreview,
          cells: regenerateCells(rectPreview, LIGHT_RECT_STYLE),
          style: LIGHT_RECT_STYLE,
          visible: true,
        });
      }
      setRectPreview(null);
      rectStartRef.current = null;
    }

    if (activeTool === "line" && linePreview) {
      const { r1, c1, r2, c2 } = linePreview;
      const length = r1 === r2 ? Math.abs(c2 - c1) + 1 : Math.abs(r2 - r1) + 1;
      if (length >= 2) {
        const { bbox, cells } = buildLineCells(r1, c1, r2, c2);
        useEditorStore.getState().addLayer({
          type: "line",
          bbox,
          cells,
          visible: true,
        });
      }
      setLinePreview(null);
      lineStartRef.current = null;
    }

    if (activeTool === "eraser" && erasingRef.current) {
      const cells = eraserCellsRef.current;
      if (cells.length > 0) {
        const cellKeys = cells.map((c) => `${c.row},${c.col}`);
        useEditorStore.getState().eraseCells(cellKeys);
      }
      eraserCellsRef.current = [];
      setEraserCellsForRender([]);
      erasingRef.current = false;
    }
  }

  // ── Preview nodes ──
  let previewNode: ReactNode = null;
  if (rectPreview) {
    previewNode = (
      <KonvaRect
        x={rectPreview.col * charWidth}
        y={rectPreview.row * charHeight}
        width={rectPreview.w * charWidth}
        height={rectPreview.h * charHeight}
        fill="transparent"
        stroke="#4a90e2"
        strokeWidth={1}
        dash={[4, 4]}
        listening={false}
      />
    );
  }
  if (linePreview) {
    const { r1, c1, r2, c2 } = linePreview;
    const isH = r1 === r2;
    const x = Math.min(c1, c2) * charWidth;
    const y = Math.min(r1, r2) * charHeight;
    const w = (Math.abs(c2 - c1) + 1) * charWidth;
    const h = (Math.abs(r2 - r1) + 1) * charHeight;
    const points = isH
      ? [0, h / 2, w, h / 2]
      : [w / 2, 0, w / 2, h];
    previewNode = (
      <KonvaLine
        x={x} y={y}
        points={points}
        stroke="#4a90e2"
        strokeWidth={1}
        dash={[4, 4]}
        listening={false}
      />
    );
  }
  if (textCursor) {
    const cursorCol = textCursor.col + textBufferRef.current.length;
    previewNode = (
      <KonvaRect
        x={cursorCol * charWidth}
        y={textCursor.row * charHeight}
        width={2}
        height={charHeight}
        fill="#4a90e2"
        listening={false}
      />
    );
  }
  if (eraserCellsForRender.length > 0) {
    previewNode = (
      <>
        {eraserCellsForRender.map((c, i) => (
          <KonvaRect
            key={i}
            x={c.col * charWidth}
            y={c.row * charHeight}
            width={charWidth}
            height={charHeight}
            fill="rgba(255, 60, 60, 0.3)"
            listening={false}
          />
        ))}
      </>
    );
  }

  return { onMouseDown, onMouseMove, onMouseUp, previewNode };
}
