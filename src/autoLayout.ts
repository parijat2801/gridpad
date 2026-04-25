// Auto-layout: re-parenting and constraint-based positioning of children
// within rect frames.

import type { Frame } from "./frame";

// ── Types ──────────────────────────────────────────────────

export interface AlignAnchor {
  anchor: "left" | "center" | "right";
  offset: number;
}

export interface VAlignAnchor {
  anchor: "top" | "center" | "bottom";
  offset: number;
}

// ── layoutTextChildren ─────────────────────────────────────

/** Reposition text children within a rect frame based on their constraints. */
export function layoutTextChildren(
  frame: Frame,
  charWidth: number,
  charHeight: number,
): Frame {
  if (!frame.content || frame.content.type !== "rect" || frame.children.length === 0) {
    return frame;
  }
  const innerW = frame.w - 2 * charWidth;
  const innerH = frame.h - 2 * charHeight;

  const newChildren = frame.children.map(child => {
    if (!child.content || child.content.type !== "text") return child;
    const hAlign = child.content.hAlign ?? { anchor: "left" as const, offset: 0 };
    const vAlign = child.content.vAlign ?? { anchor: "top" as const, offset: 0 };

    let x: number;
    if (hAlign.anchor === "left") x = charWidth + hAlign.offset;
    else if (hAlign.anchor === "right") x = charWidth + innerW - child.w - hAlign.offset;
    else x = charWidth + (innerW - child.w) / 2 + hAlign.offset;
    x = Math.max(0, x);

    let y: number;
    if (vAlign.anchor === "top") y = charHeight + vAlign.offset;
    else if (vAlign.anchor === "bottom") y = charHeight + innerH - child.h - vAlign.offset;
    else y = charHeight + (innerH - child.h) / 2 + vAlign.offset;
    y = Math.max(0, y);

    // Compute grid coords in grid space — no pixel round-trip.
    // Clamp to parent interior: [1, gridH-2] for row, [1, gridW-2] for col.
    const gridCol = Math.max(1, Math.min(frame.gridW - 2, Math.round(x / charWidth)));
    const gridRow = Math.max(1, Math.min(frame.gridH - 2, Math.round(y / charHeight)));
    return { ...child, x: gridCol * charWidth, y: gridRow * charHeight, gridRow, gridCol };
  });

  return { ...frame, children: newChildren };
}

// ── inferAlignment ─────────────────────────────────────────

function inferAlignment(
  child: Frame,
  bestRect: Frame,
  charWidth: number,
  charHeight: number,
): { hAlign: AlignAnchor; vAlign: VAlignAnchor } {
  const relX = child.x - bestRect.x - charWidth;
  const relY = child.y - bestRect.y - charHeight;
  const innerW = bestRect.w - 2 * charWidth;
  const innerH = bestRect.h - 2 * charHeight;

  // Infer hAlign: center wins within 2-cell tolerance
  const distLeft = relX;
  const distRight = innerW - relX - child.w;
  const distCenterH = Math.abs(relX - (innerW - child.w) / 2);
  const centerToleranceH = 2 * charWidth;
  let hAlign: AlignAnchor;
  if (distCenterH <= centerToleranceH) {
    hAlign = { anchor: "center", offset: relX - (innerW - child.w) / 2 };
  } else if (distLeft <= distRight) {
    hAlign = { anchor: "left", offset: relX };
  } else {
    hAlign = { anchor: "right", offset: distRight };
  }

  // Infer vAlign: center wins within 2-cell tolerance
  const distTop = relY;
  const distBottom = innerH - relY - child.h;
  const distCenterV = Math.abs(relY - (innerH - child.h) / 2);
  const centerToleranceV = 2 * charHeight;
  let vAlign: VAlignAnchor;
  if (distCenterV <= centerToleranceV) {
    vAlign = { anchor: "center", offset: relY - (innerH - child.h) / 2 };
  } else if (distTop <= distBottom) {
    vAlign = { anchor: "top", offset: relY };
  } else {
    vAlign = { anchor: "bottom", offset: distBottom };
  }

  return { hAlign, vAlign };
}

// ── mergeAdjacentTexts ─────────────────────────────────────

/** Merge text children on the same row that are separated by ≤ 2 * charWidth. */
export function mergeAdjacentTexts(parent: Frame, charWidth: number, charHeight: number): void {
  const textChildren = parent.children.filter(c => c.content?.type === "text");
  const nonTextChildren = parent.children.filter(c => c.content?.type !== "text");

  // Group by row (rounded grid row from y position)
  const rowMap = new Map<number, Frame[]>();
  for (const child of textChildren) {
    const row = Math.round(child.y / charHeight);
    const group = rowMap.get(row);
    if (group) {
      group.push(child);
    } else {
      rowMap.set(row, [child]);
    }
  }

  const mergedTexts: Frame[] = [];
  for (const group of rowMap.values()) {
    group.sort((a, b) => a.x - b.x);

    let i = 0;
    while (i < group.length) {
      let current = group[i];
      while (i + 1 < group.length) {
        const next = group[i + 1];
        const gap = next.x - (current.x + current.w);
        if (gap > 2 * charWidth) break;

        // Merge current and next
        const mergedText = (current.content!.text ?? "") + " " + (next.content!.text ?? "");
        const mergedW = next.x + next.w - current.x;
        const codepoints = [...mergedText];
        const cells = new Map<string, string>();
        for (let ci = 0; ci < codepoints.length; ci++) {
          cells.set(`0,${ci}`, codepoints[ci]);
        }
        current = {
          ...current,
          w: mergedW,
          gridW: codepoints.length,
          content: { ...current.content!, text: mergedText, cells },
        };
        i++;
      }
      mergedTexts.push(current);
      i++;
    }
  }

  parent.children = [...nonTextChildren, ...mergedTexts];
}

// ── reparentChildren ───────────────────────────────────────

/** Re-parent all child frames (rect, line, text) into their smallest enclosing
 * rect frame. Infers hAlign/vAlign from position relative to the rect's inner
 * bounds. Uses a two-pass approach: pass 1 computes assignments, pass 2 applies
 * them so every child sees the original flat list during assignment. */
export function reparentChildren(
  children: Frame[],
  charWidth: number,
  charHeight: number,
): void {
  const rects = children.filter(c => c.content?.type === "rect");
  // Pass 1: compute parent assignments into a map
  const assignments = new Map<string, string>(); // childId → parentRectId

  for (const child of children) {
    if (child.id === undefined) continue;
    // Find smallest enclosing rect (skip self)
    let bestRect: Frame | null = null;
    let bestArea = Infinity;
    for (const rect of rects) {
      if (rect.id === child.id) continue; // self-exclusion
      const inside =
        child.x >= rect.x &&
        child.y >= rect.y &&
        child.x + child.w <= rect.x + rect.w + charWidth &&
        child.y + child.h <= rect.y + rect.h + charHeight;
      if (inside) {
        const area = rect.w * rect.h;
        if (area < bestArea) { bestArea = area; bestRect = rect; }
      }
    }
    if (bestRect) {
      assignments.set(child.id, bestRect.id);
    }
  }

  // Pass 2: apply assignments
  const rectById = new Map<string, Frame>(rects.map(r => [r.id, r]));
  const toRemove = new Set<string>();

  for (const child of children) {
    const parentId = assignments.get(child.id);
    if (!parentId) continue;
    const parentRect = rectById.get(parentId);
    if (!parentRect) continue;

    let reparented: Frame;
    if (child.content?.type === "text") {
      const { hAlign, vAlign } = inferAlignment(child, parentRect, charWidth, charHeight);
      reparented = {
        ...child,
        x: child.x - parentRect.x,
        y: child.y - parentRect.y,
        gridRow: child.gridRow - parentRect.gridRow,
        gridCol: child.gridCol - parentRect.gridCol,
        content: { ...child.content, hAlign, vAlign },
      };
    } else {
      // rect or line: rebase coordinates, keep children intact
      reparented = {
        ...child,
        x: child.x - parentRect.x,
        y: child.y - parentRect.y,
        gridRow: child.gridRow - parentRect.gridRow,
        gridCol: child.gridCol - parentRect.gridCol,
      };
    }

    parentRect.children.push(reparented);
    // Don't set clip: true on rect children — truncation is handled by
    // renderTextFrame via parentInnerW, not canvas clipping. Setting clip
    // here breaks hit-testing (text children intercept clicks meant for
    // the parent rect's resize handles).
    toRemove.add(child.id);
  }

  // Remove re-parented children from the flat list (mutate in place)
  for (let i = children.length - 1; i >= 0; i--) {
    if (toRemove.has(children[i].id)) {
      children.splice(i, 1);
    }
  }

  // Merge adjacent text labels on each parent rect that gained children
  for (const rect of rects) {
    if (rect.children.length > 0) {
      mergeAdjacentTexts(rect, charWidth, charHeight);
    }
  }
}

