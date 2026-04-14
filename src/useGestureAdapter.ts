import { useEffect, useRef } from "react";
import { useEditorStore } from "./store";
import type { Bbox } from "./types";

interface GestureState {
  layerId: string;
  startBbox: Bbox;
  active: boolean;
  mode: "move" | "resize";
  node: any;
}

/**
 * Returns callbacks for move (onDragStart/onDragEnd) and resize
 * (onTransformStart/onTransformEnd) + cleanup.
 * Konva owns node position during drag (no per-frame store updates).
 * Store updates ONCE on end via moveLayerCommit/resizeLayerCommit.
 */
export function useGestureAdapter() {
  const gestureRef = useRef<GestureState | null>(null);
  const escapeRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const cancelRef = useRef<((e: PointerEvent) => void) | null>(null);

  // Cleanup on unmount: commit pre-gesture bbox if interrupted.
  useEffect(() => {
    return () => {
      const g = gestureRef.current;
      if (g?.active) {
        if (g.mode === "resize") {
          g.node.scaleX(1);
          g.node.scaleY(1);
          useEditorStore.getState().resizeLayerCommit(g.layerId, g.startBbox);
        } else {
          useEditorStore.getState().moveLayerCommit(g.layerId, g.startBbox);
        }
      }
      if (escapeRef.current) {
        window.removeEventListener("keydown", escapeRef.current, true);
      }
      if (cancelRef.current) {
        window.removeEventListener("pointercancel", cancelRef.current);
      }
    };
  }, []);

  function installListeners(node: any, g: GestureState, charWidth: number, charHeight: number) {
    const revertGesture = () => {
      const store = useEditorStore.getState();
      if (g.mode === "resize") {
        node.scaleX(1);
        node.scaleY(1);
        node.width(g.startBbox.w * charWidth);
        node.height(g.startBbox.h * charHeight);
        store.resizeLayerCommit(g.layerId, g.startBbox);
      } else {
        store.moveLayerCommit(g.layerId, g.startBbox);
      }
      node.position({
        x: g.startBbox.col * charWidth,
        y: g.startBbox.row * charHeight,
      });
    };

    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !gestureRef.current?.active) return;
      e.stopPropagation();
      revertGesture();
      if (g.mode === "move") node.stopDrag();
      gestureRef.current = null;
      removeListeners();
    };
    const onCancel = () => {
      if (!gestureRef.current?.active) return;
      revertGesture();
      gestureRef.current = null;
      removeListeners();
    };
    const removeListeners = () => {
      window.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("pointercancel", onCancel);
      escapeRef.current = null;
      cancelRef.current = null;
    };

    window.addEventListener("keydown", onEscape, true);
    window.addEventListener("pointercancel", onCancel);
    escapeRef.current = onEscape;
    cancelRef.current = onCancel;

    return removeListeners;
  }

  function onDragStart(layerId: string, node: any, charWidth: number, charHeight: number) {
    const layer = useEditorStore.getState().layers.find((l) => l.id === layerId);
    if (!layer) return;
    const g: GestureState = {
      layerId,
      startBbox: { ...layer.bbox },
      active: true,
      mode: "move",
      node,
    };
    gestureRef.current = g;
    // Trigger zundo snapshot-then-pause via a no-op live call
    useEditorStore.getState().moveLayerLive(layerId, layer.bbox);
    installListeners(node, g, charWidth, charHeight);
  }

  function onDragEnd(layerId: string, node: any, charWidth: number, charHeight: number) {
    if (!gestureRef.current?.active) return;
    const newCol = Math.round(node.x() / charWidth);
    const newRow = Math.round(node.y() / charHeight);
    const layer = useEditorStore.getState().layers.find((l) => l.id === layerId);
    if (!layer) return;
    useEditorStore.getState().moveLayerCommit(layerId, {
      row: newRow, col: newCol, w: layer.bbox.w, h: layer.bbox.h,
    });
    gestureRef.current = null;
    if (escapeRef.current) {
      window.removeEventListener("keydown", escapeRef.current, true);
      escapeRef.current = null;
    }
    if (cancelRef.current) {
      window.removeEventListener("pointercancel", cancelRef.current);
      cancelRef.current = null;
    }
  }

  function onTransformStart(layerId: string, node: any, charWidth: number, charHeight: number) {
    const layer = useEditorStore.getState().layers.find((l) => l.id === layerId);
    if (!layer) return;
    const g: GestureState = {
      layerId,
      startBbox: { ...layer.bbox },
      active: true,
      mode: "resize",
      node,
    };
    gestureRef.current = g;
    useEditorStore.getState().resizeLayerLive(layerId, layer.bbox);
    installListeners(node, g, charWidth, charHeight);
  }

  function onTransformEnd(layerId: string, node: any, charWidth: number, charHeight: number) {
    if (!gestureRef.current?.active) return;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const newW = Math.max(1, Math.round((node.width() * scaleX) / charWidth));
    const newH = Math.max(1, Math.round((node.height() * scaleY) / charHeight));
    const newCol = Math.round(node.x() / charWidth);
    const newRow = Math.round(node.y() / charHeight);
    node.scaleX(1);
    node.scaleY(1);
    node.width(newW * charWidth);
    node.height(newH * charHeight);
    useEditorStore.getState().resizeLayerCommit(layerId, {
      row: newRow, col: newCol, w: newW, h: newH,
    });
    gestureRef.current = null;
    if (escapeRef.current) {
      window.removeEventListener("keydown", escapeRef.current, true);
      escapeRef.current = null;
    }
    if (cancelRef.current) {
      window.removeEventListener("pointercancel", cancelRef.current);
      cancelRef.current = null;
    }
  }

  return { onDragStart, onDragEnd, onTransformStart, onTransformEnd, gestureRef };
}
