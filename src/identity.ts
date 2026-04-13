// Content-addressed layer identity. Hash function is FNV-32a (inline, no
// external dependency). See docs/plans/2026-04-11-layer-panel-design.md
// "Stable identity" for the design rationale.

import type { LayerType } from "./layers";

export const BASE_LAYER_ID = "base";

type Bbox = { row: number; col: number; w: number; h: number };

export function fnv32hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h.toString(16).padStart(8, "0");
}

export function contentAddressedId(
  p: { type: LayerType; bbox: Bbox; content?: string },
): string {
  const { type, bbox, content } = p;
  switch (type) {
    case "base":
      return BASE_LAYER_ID;
    case "group":
      return "";
    case "rect":
    case "line": {
      const key = `r${bbox.row}c${bbox.col}w${bbox.w}h${bbox.h}`;
      return `${type}:${fnv32hex(key)}`;
    }
    case "text": {
      const key = `r${bbox.row}c${bbox.col}w${bbox.w}h${bbox.h}:${content ?? ""}`;
      return `${type}:${fnv32hex(key)}`;
    }
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

export function randomId(): string {
  return crypto.randomUUID();
}
