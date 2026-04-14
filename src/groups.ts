// Pure functions for group-layer manipulation. Store actions in store.ts
// wrap these. See docs/plans/2026-04-11-layer-panel-design.md
// "Group store actions" for the full contract.

import type { Layer } from "./layers";

import type { Bbox } from "./types";

/** Compute the union bbox of an array of bboxes. */
function unionBboxes(bboxes: Bbox[]): Bbox {
  let minRow = Infinity;
  let minCol = Infinity;
  let maxRow = -Infinity;
  let maxCol = -Infinity;
  for (const b of bboxes) {
    if (b.row < minRow) minRow = b.row;
    if (b.col < minCol) minCol = b.col;
    const bMaxRow = b.row + b.h - 1;
    const bMaxCol = b.col + b.w - 1;
    if (bMaxRow > maxRow) maxRow = bMaxRow;
    if (bMaxCol > maxCol) maxCol = bMaxCol;
  }
  return {
    row: minRow,
    col: minCol,
    w: maxCol - minCol + 1,
    h: maxRow - minRow + 1,
  };
}

/**
 * Create a group from a set of existing layers.
 *
 * Validates:
 * 1. childIds.length >= 2
 * 2. All child IDs resolve to existing layers
 * 3. None of the children have type === "group"
 * 4. None of the children have type === "base"
 * 5. All children share the same parentId (absent/undefined treated as null)
 *
 * Returns null on any validation failure.
 */
export function createGroup(
  layers: Layer[],
  childIds: string[],
  newGroupId: string,
): { layers: Layer[]; groupId: string } | null {
  // Validation 1: need at least 2 children
  if (childIds.length < 2) return null;

  // Validation 2: all child IDs must exist
  const childLayers: Layer[] = [];
  for (const id of childIds) {
    const layer = layers.find((l) => l.id === id);
    if (!layer) return null;
    childLayers.push(layer);
  }

  // Validations 3 & 4: no groups or base layers
  for (const child of childLayers) {
    if (child.type === "group") return null;
    if (child.type === "base") return null;
  }

  // Validation 5: all children share the same parentId
  const normalize = (p: string | null | undefined): string | null =>
    p == null ? null : p;
  const sharedParent = normalize(childLayers[0].parentId);
  for (const child of childLayers) {
    if (normalize(child.parentId) !== sharedParent) return null;
  }

  // Compute group properties
  const groupZ = Math.max(...childLayers.map((c) => c.z));
  const groupBbox = unionBboxes(childLayers.map((c) => c.bbox));

  const group: Layer = {
    id: newGroupId,
    type: "group",
    z: groupZ,
    visible: true,
    parentId: sharedParent,
    bbox: groupBbox,
    cells: new Map(),
  };

  // Sort children by ascending z for re-indexing
  const sortedChildren = [...childLayers].sort((a, b) => a.z - b.z);
  const childIdSet = new Set(childIds);

  // Build new layers array
  const newLayers: Layer[] = layers.map((l) => {
    if (!childIdSet.has(l.id)) return l;
    const newZ = sortedChildren.findIndex((c) => c.id === l.id);
    return { ...l, parentId: newGroupId, z: newZ };
  });

  newLayers.push(group);

  return { layers: newLayers, groupId: newGroupId };
}

/**
 * Dissolve a group: promote its direct children to the group's parent level.
 * Returns input unchanged if groupId doesn't exist or isn't a group.
 */
export function ungroup(layers: Layer[], groupId: string): Layer[] {
  const group = layers.find((l) => l.id === groupId);
  if (!group || group.type !== "group") return layers;

  const groupZ = group.z;
  const groupParent = group.parentId ?? null;

  // Find direct children sorted by ascending z
  const children = layers
    .filter((l) => (l.parentId ?? null) === groupId)
    .sort((a, b) => a.z - b.z);

  const n = children.length;

  // Build updated layers:
  // - Remove the group
  // - Promote children: child[i] gets z = groupZ + i
  // - Shift siblings (same level as group, z > groupZ) up by (n - 1)
  const childIdSet = new Set(children.map((c) => c.id));

  return layers
    .filter((l) => l.id !== groupId)
    .map((l) => {
      if (childIdSet.has(l.id)) {
        const idx = children.findIndex((c) => c.id === l.id);
        return { ...l, parentId: groupParent, z: groupZ + idx };
      }
      // Shift siblings at the group's parent level with z > groupZ
      if ((l.parentId ?? null) === groupParent && l.z > groupZ) {
        return { ...l, z: l.z + (n - 1) };
      }
      return l;
    });
}

/**
 * Move a layer to a new parent.
 * Returns input unchanged if:
 * - The target layer doesn't exist
 * - newParentId is not null and doesn't point to a group in the list
 */
export function reparentLayer(
  layers: Layer[],
  id: string,
  newParentId: string | null,
): Layer[] {
  const target = layers.find((l) => l.id === id);
  if (!target) return layers;

  if (newParentId !== null) {
    const newParent = layers.find((l) => l.id === newParentId);
    if (!newParent || newParent.type !== "group") return layers;

    // Cycle prevention: reject if newParent is the layer itself, or a
    // descendant of the layer. Without this, reparenting a group under
    // itself or one of its children would create a parentId cycle that
    // breaks compositeLayers (subtree unreachable from roots) and makes
    // isEffectivelyVisible infinite-loop without its own cycle guard.
    if (newParentId === id) return layers;
    if (isDescendantOf(layers, newParentId, id)) return layers;
  }

  // Compute new z: max sibling z + 1, or 0 if no siblings
  const siblings = layers.filter(
    (l) => l.id !== id && (l.parentId ?? null) === newParentId,
  );
  const newZ =
    siblings.length > 0 ? Math.max(...siblings.map((s) => s.z)) + 1 : 0;

  return layers.map((l) => {
    if (l.id !== id) return l;
    return { ...l, parentId: newParentId, z: newZ };
  });
}

/** True if `candidateDescendant` is a descendant of `ancestorId` in the
 * layer tree. Walks `parentId` pointers up from the candidate, bounded by
 * the total layer count to terminate on any pre-existing cycle. */
function isDescendantOf(
  layers: Layer[],
  candidateDescendant: string,
  ancestorId: string,
): boolean {
  const byId = new Map(layers.map((l) => [l.id, l]));
  let cur: Layer | undefined = byId.get(candidateDescendant);
  let steps = 0;
  const maxSteps = layers.length + 1; // cycle guard
  while (cur && steps < maxSteps) {
    if (cur.parentId === ancestorId) return true;
    if (cur.parentId == null) return false;
    cur = byId.get(cur.parentId);
    steps++;
  }
  return false;
}

/**
 * Compute the union bbox of all direct children of a group.
 * Returns null if the group has no direct children.
 */
export function computeGroupBbox(
  layers: Layer[],
  groupId: string,
): Bbox | null {
  const children = layers.filter((l) => (l.parentId ?? null) === groupId);
  if (children.length === 0) return null;
  return unionBboxes(children.map((c) => c.bbox));
}

/**
 * Recompute all group bboxes bottom-up (deepest groups first).
 * Pure — returns a new array with updated bboxes for all groups.
 */
export function recomputeAllGroupBboxes(layers: Layer[]): Layer[] {
  // Topological sort: process groups whose children contain no unprocessed
  // groups first. We do this by repeatedly finding groups whose children are
  // all non-groups or already-processed groups.
  const groups = layers.filter((l) => l.type === "group");

  // Build processing order: topological sort by parentId
  // Groups with no group children come first.
  const processed = new Set<string>();
  const order: string[] = [];

  // Keep iterating until all groups are ordered
  let remaining = groups.map((g) => g.id);
  while (remaining.length > 0) {
    const before = remaining.length;
    const nextRemaining: string[] = [];
    for (const gid of remaining) {
      // Can we process this group? Yes if all group children are already processed.
      const groupChildren = layers.filter(
        (l) => (l.parentId ?? null) === gid && l.type === "group",
      );
      const allChildGroupsProcessed = groupChildren.every((c) =>
        processed.has(c.id),
      );
      if (allChildGroupsProcessed) {
        order.push(gid);
        processed.add(gid);
      } else {
        nextRemaining.push(gid);
      }
    }
    remaining = nextRemaining;
    // Guard against cycles (shouldn't happen but prevents infinite loop)
    if (remaining.length === before) break;
  }

  // Apply bbox recomputation in order, updating a working copy of layers
  let workingLayers = [...layers];
  for (const gid of order) {
    const bbox = computeGroupBbox(workingLayers, gid);
    if (bbox === null) continue;
    workingLayers = workingLayers.map((l) => {
      if (l.id !== gid) return l;
      return { ...l, bbox };
    });
  }

  return workingLayers;
}
