// Editor state store: zustand with zundo temporal middleware for undo/redo.
//
// The store is the single source of truth for the visual editor. The .md file
// on disk is synced via the File System Access API (read on open, autosave on
// change). No CodeMirror — text is computed via toText() when needed.

import { create } from "zustand";
import { temporal } from "zundo";
import { scan, proposalsFromScan } from "./scanner";
import {
  deleteLayer as deleteLayerPure,
  layerToText,
  moveLayerCascading,
  regenerateCells,
  toggleVisible as toggleVisiblePure,
  type Layer,
} from "./layers";
import { diffLayers } from "./diff";
import {
  createGroup as createGroupPure,
  recomputeAllGroupBboxes,
  reparentLayer as reparentLayerPure,
  ungroup as ungroupPure,
} from "./groups";
import { randomId } from "./identity";

export type ToolId = "select" | "rect" | "line" | "text" | "eraser";

export interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
}

export type { Bbox } from "./types";
import type { Bbox } from "./types";

export interface EditorState {
  layers: Layer[];
  selectedId: string | null;
  viewport: Viewport;
  activeTool: ToolId;
  fileHandle: FileSystemFileHandle | null;

  // Actions
  loadFromText: (text: string) => void;
  selectLayer: (id: string | null) => void;
  moveLayer: (id: string, deltaRow: number, deltaCol: number) => void;
  moveLayerLive: (id: string, newBbox: Bbox) => void;
  moveLayerCommit: (id: string, newBbox: Bbox) => void;
  resizeLayerLive: (id: string, newBbox: Bbox) => void;
  resizeLayerCommit: (id: string, newBbox: Bbox) => void;
  setViewport: (v: Partial<Viewport>) => void;
  setActiveTool: (tool: ToolId) => void;
  setFileHandle: (h: FileSystemFileHandle | null) => void;
  // Layer panel actions
  deleteLayer: (id: string) => void;
  toggleVisible: (id: string) => void;
  createGroup: (childIds: string[]) => string | null;
  ungroup: (groupId: string) => void;
  reparentLayer: (id: string, newParentId: string | null) => void;
  toText: () => string;
  reset: () => void;
}

function normalizeBbox(b: Bbox): Bbox {
  return {
    row: Math.max(0, Math.floor(b.row)),
    col: Math.max(0, Math.floor(b.col)),
    w: Math.max(1, Math.floor(b.w)),
    h: Math.max(1, Math.floor(b.h)),
  };
}

function mutateRectBbox(layers: Layer[], id: string, newBbox: Bbox): Layer[] | null {
  const idx = layers.findIndex((l) => l.id === id);
  if (idx < 0) return null;
  const layer = layers[idx];
  if (layer.type !== "rect") {
    throw new Error(`resizeLayer: expected rect layer, got ${layer.type}`);
  }
  if (!layer.style) {
    throw new Error(`resizeLayer: expected rect layer to have a style`);
  }
  const resized: Layer = {
    ...layer,
    bbox: newBbox,
    cells: regenerateCells(newBbox, layer.style),
  };
  const next = [...layers];
  next[idx] = resized;
  return next;
}

function mutateMoveBbox(layers: Layer[], id: string, newBbox: Bbox): Layer[] | null {
  const idx = layers.findIndex((l) => l.id === id);
  if (idx < 0) return null;
  const layer = layers[idx];
  const dRow = newBbox.row - layer.bbox.row;
  const dCol = newBbox.col - layer.bbox.col;
  return moveLayerCascading(layers, id, dRow, dCol);
}

const initialViewport: Viewport = { panX: 0, panY: 0, zoom: 1 };

let _inLiveDrag = false;

export const useEditorStore = create<EditorState>()(
  temporal<EditorState>((set, get) => ({
    layers: [],
    selectedId: null,
    viewport: initialViewport,
    activeTool: "select" as ToolId,
    fileHandle: null,

    loadFromText: (text: string) => {
      const proposals = proposalsFromScan(scan(text));
      const next = diffLayers(get().layers, proposals);
      const surviving = new Set(next.map((l) => l.id));
      const current = get().selectedId;
      const nextSelected = current && surviving.has(current) ? current : null;
      set({ layers: next, selectedId: nextSelected });
    },

    selectLayer: (id: string | null) => {
      set({ selectedId: id });
    },

    resizeLayerLive: (id, newBbox) => {
      const normalized = normalizeBbox(newBbox);
      const next = mutateRectBbox(get().layers, id, normalized);
      if (next === null) return;
      const t = useEditorStore.temporal.getState();
      if (!_inLiveDrag) {
        if (!t.isTracking) t.resume();
        _inLiveDrag = true;
        set({});
        t.pause();
      }
      set({ layers: next });
    },

    resizeLayerCommit: (id, newBbox) => {
      const normalized = normalizeBbox(newBbox);
      const mutated = mutateRectBbox(get().layers, id, normalized);
      if (mutated === null) return;
      const next = recomputeAllGroupBboxes(mutated);
      const t = useEditorStore.temporal.getState();
      if (_inLiveDrag) {
        _inLiveDrag = false;
        set({ layers: next });
        t.resume();
      } else {
        set({ layers: next });
      }
    },

    moveLayerLive: (id, newBbox) => {
      const normalized = normalizeBbox(newBbox);
      const next = mutateMoveBbox(get().layers, id, normalized);
      if (next === null) return;
      const t = useEditorStore.temporal.getState();
      if (!_inLiveDrag) {
        if (!t.isTracking) t.resume();
        _inLiveDrag = true;
        set({});
        t.pause();
      }
      set({ layers: next });
    },

    moveLayerCommit: (id, newBbox) => {
      const normalized = normalizeBbox(newBbox);
      const mutated = mutateMoveBbox(get().layers, id, normalized);
      if (mutated === null) return;
      const next = recomputeAllGroupBboxes(mutated);
      const t = useEditorStore.temporal.getState();
      if (_inLiveDrag) {
        _inLiveDrag = false;
        set({ layers: next });
        t.resume();
      } else {
        set({ layers: next });
      }
    },

    moveLayer: (id: string, deltaRow: number, deltaCol: number) => {
      const current = get().layers;
      const layer = current.find((l: Layer) => l.id === id);
      if (!layer) return;
      const newBbox: Bbox = {
        row: layer.bbox.row + deltaRow,
        col: layer.bbox.col + deltaCol,
        w: layer.bbox.w,
        h: layer.bbox.h,
      };
      get().moveLayerCommit(id, newBbox);
    },

    setViewport: (v: Partial<Viewport>) => {
      set({ viewport: { ...get().viewport, ...v } });
    },

    setActiveTool: (tool: ToolId) => {
      set({ activeTool: tool });
    },

    setFileHandle: (h: FileSystemFileHandle | null) => {
      set({ fileHandle: h });
    },

    deleteLayer: (id: string) => {
      const next = recomputeAllGroupBboxes(deleteLayerPure(get().layers, id));
      const survived = new Set(next.map((l) => l.id));
      const sel = get().selectedId;
      set({
        layers: next,
        selectedId: sel && survived.has(sel) ? sel : null,
      });
    },

    toggleVisible: (id: string) => {
      set({ layers: toggleVisiblePure(get().layers, id) });
    },

    createGroup: (childIds: string[]): string | null => {
      const newGroupId = randomId();
      const result = createGroupPure(get().layers, childIds, newGroupId);
      if (result === null) return null;
      set({ layers: recomputeAllGroupBboxes(result.layers) });
      return result.groupId;
    },

    ungroup: (groupId: string) => {
      const next = ungroupPure(get().layers, groupId);
      const survived = new Set(next.map((l) => l.id));
      const sel = get().selectedId;
      set({
        layers: next,
        selectedId: sel && survived.has(sel) ? sel : null,
      });
    },

    reparentLayer: (id: string, newParentId: string | null) => {
      const next = recomputeAllGroupBboxes(
        reparentLayerPure(get().layers, id, newParentId),
      );
      set({ layers: next });
    },

    toText: () => layerToText(get().layers),

    reset: () => {
      _inLiveDrag = false;
      const t = useEditorStore.temporal.getState();
      if (!t.isTracking) t.resume();
      set({
        layers: [],
        selectedId: null,
        viewport: initialViewport,
        activeTool: "select" as ToolId,
        fileHandle: null,
      });
      t.clear();
    },
  })),
);
