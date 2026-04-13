// Diff pass: merge a fresh scan's ProposedLayer[] with the existing Layer[]
// stack, preserving identity (parentId, label, visible, z, style) wherever
// content-addressed IDs or geometry fallback find a match. See
// docs/plans/2026-04-11-layer-panel-design.md "Diff pass" for the contract.

import type { Layer, RectStyle } from "./layers";
import { contentAddressedId, BASE_LAYER_ID } from "./identity";
import munkres from "munkres-js";

export interface ProposedLayer {
  type: "rect" | "line" | "text" | "base";
  bbox: { row: number; col: number; w: number; h: number };
  cells: Map<string, string>;
  content?: string;
  /** Rect proposals carry the scanner-extracted RectStyle so that
   * brand-new rect layers (flowing through step 3) retain the style
   * information needed by the canvas resize path. The diff pass does
   * NOT inspect style for matching. */
  style?: RectStyle;
}

const MISMATCH_COST = 1e9;

/**
 * Cost for geometry-based matching between a proposal and an existing layer.
 *
 * Returns MISMATCH_COST for cross-type pairs (mandatory type constraint) and
 * also for pairs where the centre-distance + size-delta exceeds 3× the
 * larger of the two layers' max dimension. That cap stops distant,
 * geometrically unrelated layers from being matched when a wholly new
 * document replaces an old one.
 */
function geometryCost(p: ProposedLayer, e: Layer): number {
  if (p.type !== e.type) return MISMATCH_COST;
  const pCr = p.bbox.row + (p.bbox.h - 1) / 2;
  const pCc = p.bbox.col + (p.bbox.w - 1) / 2;
  const eCr = e.bbox.row + (e.bbox.h - 1) / 2;
  const eCc = e.bbox.col + (e.bbox.w - 1) / 2;
  const dist = Math.hypot(pCr - eCr, pCc - eCc);
  const sizeDiff = Math.abs(p.bbox.w - e.bbox.w) + Math.abs(p.bbox.h - e.bbox.h);
  const rawCost = dist + sizeDiff;
  // Reject matches where the geometry distance far exceeds the layers'
  // own dimensions — these are effectively unrelated layers.
  const threshold = Math.max(p.bbox.w, p.bbox.h, e.bbox.w, e.bbox.h) * 3;
  return rawCost > threshold ? MISMATCH_COST : rawCost;
}

function mergeLayer(proposal: ProposedLayer, existing: Layer, id: string): Layer {
  return {
    ...existing,
    id,
    type: proposal.type,
    bbox: proposal.bbox,
    cells: proposal.cells,
    content: proposal.content,
    // Preserve identity fields from existing:
    parentId: existing.parentId,
    label: existing.label,
    visible: existing.visible,
    z: existing.z,
    // Style: prefer the freshly scanned style so manual border edits
    // (e.g., user types `═` over `─`) take effect on the next resize.
    // Fall back to existing.style when the proposal doesn't carry one
    // (non-rect proposals, or scanner couldn't extract a style).
    style: proposal.style ?? existing.style,
  };
}

export function diffLayers(
  existing: Layer[],
  proposals: ProposedLayer[],
): Layer[] {
  // Separate groups from non-groups.
  const existingGroups = existing.filter((l) => l.type === "group");
  const existingNonGroups = existing.filter((l) => l.type !== "group");

  // ── Step 1: Exact match by content-addressed ID ──────────────────────────
  //
  // Build a map from content-addressed ID → existing non-group layer.
  // If two existing layers share the same ID, the higher-z one wins.
  const existingIdMap = new Map<string, Layer>();
  for (const layer of existingNonGroups) {
    const id = contentAddressedId(layer);
    if (id === "") continue; // groups return "" — skip
    const current = existingIdMap.get(id);
    if (!current || layer.z > current.z) {
      existingIdMap.set(id, layer);
    }
  }

  // Track which existing layers (by their .id field) have been matched.
  const matchedExistingIds = new Set<string>();
  const result: Layer[] = [];
  const unmatchedProposals: ProposedLayer[] = [];

  for (const proposal of proposals) {
    const id = contentAddressedId(proposal);
    const existingLayer = existingIdMap.get(id);
    if (existingLayer && !matchedExistingIds.has(existingLayer.id)) {
      matchedExistingIds.add(existingLayer.id);
      result.push(mergeLayer(proposal, existingLayer, id));
    } else {
      unmatchedProposals.push(proposal);
    }
  }

  // Build list of unmatched existing non-group layers.
  const unmatchedExisting = existingNonGroups.filter(
    (l) => !matchedExistingIds.has(l.id),
  );

  // ── Step 2: Geometry fallback via Hungarian algorithm ────────────────────

  // Short-circuit: skip if either side is empty (munkres-js throws on []).
  const geometryMatchedProposalIndices = new Set<number>();
  if (unmatchedProposals.length > 0 && unmatchedExisting.length > 0) {
    const nP = unmatchedProposals.length;
    const nE = unmatchedExisting.length;
    const n = Math.max(nP, nE);

    // Pad to a square matrix with MISMATCH_COST (avoids depending on
    // munkres-js's internal padding behavior).
    const costMatrix: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) {
        if (i < nP && j < nE) {
          row.push(geometryCost(unmatchedProposals[i], unmatchedExisting[j]));
        } else {
          row.push(MISMATCH_COST);
        }
      }
      costMatrix.push(row);
    }

    const assignments = munkres(costMatrix);
    const geometryMatchedExistingIndices = new Set<number>();

    for (const [row, col] of assignments) {
      if (
        row < nP &&
        col < nE &&
        costMatrix[row][col] < MISMATCH_COST
      ) {
        geometryMatchedProposalIndices.add(row);
        geometryMatchedExistingIndices.add(col);
        const proposal = unmatchedProposals[row];
        const existingLayer = unmatchedExisting[col];
        const id = contentAddressedId(proposal);
        result.push(mergeLayer(proposal, existingLayer, id));
        matchedExistingIds.add(existingLayer.id);
      }
    }
  }

  // ── Step 3: New proposals ────────────────────────────────────────────────
  //
  // Remaining unmatched proposals become brand-new layers.
  // z starts just above the highest z in the existing stack.
  const baseZ =
    existing.length > 0 ? Math.max(...existing.map((l) => l.z)) + 1 : 0;

  let newIndex = 0;
  for (let i = 0; i < unmatchedProposals.length; i++) {
    if (geometryMatchedProposalIndices.has(i)) continue; // already handled
    const proposal = unmatchedProposals[i];
    // Base layer always gets the well-known constant ID.
    const id =
      proposal.type === "base" ? BASE_LAYER_ID : contentAddressedId(proposal);
    result.push({
      id,
      type: proposal.type,
      bbox: proposal.bbox,
      cells: proposal.cells,
      content: proposal.content,
      style: proposal.style, // only set for rects; undefined otherwise
      parentId: null,
      visible: true,
      label: undefined,
      z: baseZ + newIndex,
    });
    newIndex++;
  }

  // Step 4: Stale removal is implicit — unmatched existing non-group layers
  // are simply not included in `result`. Base layer follows the same rule:
  // if no base proposal exists, no base layer appears in `result`.

  // ── Step 5: Group pruning and bbox recomputation ─────────────────────────

  // Carry groups over from existing (they are never touched in steps 1–4).
  let groups = existingGroups.map((g) => ({ ...g }));

  // Prune groups with zero direct children; iterate until stable.
  // Each pass can make the next group's children disappear (if a parent
  // group becomes childless, its own parent-level sibling count can
  // change via the `result ∪ groups` view), so we loop until no change.
  let changed = true;
  while (changed) {
    changed = false;
    const allLayers = [...result, ...groups];
    const nextGroups: typeof groups = [];

    for (const group of groups) {
      const directChildCount = allLayers.filter(
        (l) => l.parentId === group.id,
      ).length;

      if (directChildCount === 0) {
        // Childless group: drop it. No reparent-pointer fixup is needed —
        // by definition no `result` or `groups` entry has `parentId ===
        // group.id` when the count is zero. A grandparent group that had
        // *this* group as its sole child will itself become childless on
        // the next loop pass and be dropped in turn.
        changed = true;
      } else {
        nextGroups.push(group);
      }
    }

    groups = nextGroups;
  }

  // Build a depth map so we can process leaves before their ancestors.
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  function getGroupDepth(groupId: string, visited = new Set<string>()): number {
    if (visited.has(groupId)) return 0; // cycle guard
    visited.add(groupId);
    const g = groupMap.get(groupId);
    if (!g) return 0;
    const childGroups = groups.filter((cg) => cg.parentId === groupId);
    if (childGroups.length === 0) return 0;
    return 1 + Math.max(...childGroups.map((cg) => getGroupDepth(cg.id, new Set(visited))));
  }

  // Sort ascending by depth: depth-0 (leaf groups) first, roots last.
  const sortedGroups = [...groups].sort(
    (a, b) => getGroupDepth(a.id) - getGroupDepth(b.id),
  );

  // Recompute bboxes in leaf-first order so nested groups are correct
  // before their parents use them.
  for (const group of sortedGroups) {
    const allCurrent = [...result, ...groups];
    const directChildren = allCurrent.filter((l) => l.parentId === group.id);
    if (directChildren.length === 0) continue; // should not happen post-prune

    let minRow = Infinity;
    let minCol = Infinity;
    let maxRow = -Infinity;
    let maxCol = -Infinity;

    for (const child of directChildren) {
      const childMaxRow = child.bbox.row + child.bbox.h - 1;
      const childMaxCol = child.bbox.col + child.bbox.w - 1;
      if (child.bbox.row < minRow) minRow = child.bbox.row;
      if (child.bbox.col < minCol) minCol = child.bbox.col;
      if (childMaxRow > maxRow) maxRow = childMaxRow;
      if (childMaxCol > maxCol) maxCol = childMaxCol;
    }

    group.bbox = {
      row: minRow,
      col: minCol,
      w: maxCol - minCol + 1,
      h: maxRow - minRow + 1,
    };
  }

  // Combine result layers and surviving groups, sorted by z ascending.
  const finalResult = [...result, ...groups];
  finalResult.sort((a, b) => a.z - b.z);
  return finalResult;
}
