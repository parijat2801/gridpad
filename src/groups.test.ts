import { describe, it, expect } from "vitest";
import type { Layer } from "./layers";
import {
  createGroup,
  ungroup,
  reparentLayer,
  computeGroupBbox,
  recomputeAllGroupBboxes,
} from "./groups";

// Helper factory for Layer objects. parentId and "group" type are now
// part of the canonical Layer interface, so no cast is needed in the
// common case.
function makeLayer(
  id: string,
  type: Layer["type"],
  extras: Partial<Layer> = {},
): Layer {
  return {
    id,
    type,
    z: 0,
    visible: true,
    bbox: { row: 0, col: 0, w: 3, h: 3 },
    parentId: null,
    cells: new Map(),
    ...extras,
  };
}

// ─── createGroup ───────────────────────────────────────────────────────────

describe("createGroup", () => {
  it("happy path: 2 top-level rects become a group", () => {
    const rect1 = makeLayer("r1", "rect", { z: 2 });
    const rect2 = makeLayer("r2", "rect", { z: 5 });
    const layers = [rect1, rect2];

    const result = createGroup(layers, ["r1", "r2"], "g1");

    expect(result).not.toBeNull();
    const { layers: out, groupId } = result!;

    // Group is present
    const group = out.find((l) => l.id === groupId);
    expect(group).toBeDefined();
    expect(group!.type).toBe("group");
    // Group is at top level
    expect((group as Layer).parentId).toBeNull();
    // Group z = max(rect1.z, rect2.z) = 5
    expect(group!.z).toBe(5);

    // Both rects now belong to the group
    const outRect1 = out.find((l) => l.id === "r1")!;
    const outRect2 = out.find((l) => l.id === "r2")!;
    expect((outRect1 as Layer).parentId).toBe(groupId);
    expect((outRect2 as Layer).parentId).toBe(groupId);
  });

  it("children's z values are reassigned to 0, 1 in ascending original-z order inside the group", () => {
    // rect1.z = 7, rect2.z = 3 — ascending original-z order: rect2 first
    const rect1 = makeLayer("r1", "rect", { z: 7 });
    const rect2 = makeLayer("r2", "rect", { z: 3 });
    const layers = [rect1, rect2];

    const result = createGroup(layers, ["r1", "r2"], "g1");
    expect(result).not.toBeNull();
    const { layers: out } = result!;

    // rect2 had z=3 (lower), so gets index 0; rect1 had z=7, gets index 1
    const outRect2 = out.find((l) => l.id === "r2")!;
    const outRect1 = out.find((l) => l.id === "r1")!;
    expect(outRect2.z).toBe(0);
    expect(outRect1.z).toBe(1);
  });

  it("rejects fewer than 2 children", () => {
    const rect1 = makeLayer("r1", "rect", { z: 1 });
    const layers = [rect1];

    const result = createGroup(layers, ["r1"], "g1");

    expect(result).toBeNull();
  });

  it("rejects children with different parentIds (not all siblings)", () => {
    const rect1 = makeLayer("r1", "rect", { z: 1, parentId: null });
    const rect2 = makeLayer("r2", "rect", { z: 2, parentId: "otherGroup" } as Partial<Layer>);
    const layers = [rect1, rect2];

    const result = createGroup(layers, ["r1", "r2"], "g1");

    expect(result).toBeNull();
  });

  it("rejects if a child is a group (v1 forbids nested grouping via createGroup)", () => {
    const existingGroup = makeLayer("g0", "group" as Layer["type"], { z: 1, parentId: null } as Partial<Layer>);
    const rect1 = makeLayer("r1", "rect", { z: 2, parentId: null });
    const layers = [existingGroup, rect1];

    const result = createGroup(layers, ["g0", "r1"], "g1");

    expect(result).toBeNull();
  });

  it("rejects if a child is the base layer", () => {
    const base = makeLayer("base", "base", { z: 0 });
    const rect1 = makeLayer("r1", "rect", { z: 1 });
    const layers = [base, rect1];

    const result = createGroup(layers, ["base", "r1"], "g1");

    expect(result).toBeNull();
  });

  it("rejects if a child ID doesn't exist in the layer list", () => {
    const rect1 = makeLayer("r1", "rect", { z: 1 });
    const layers = [rect1];

    const result = createGroup(layers, ["r1", "nonexistent"], "g1");

    expect(result).toBeNull();
  });

  it("group bbox = union of children's bboxes", () => {
    // rect1 at row=0, col=0, w=3, h=3 → occupies rows 0-2, cols 0-2
    const rect1 = makeLayer("r1", "rect", {
      z: 1,
      bbox: { row: 0, col: 0, w: 3, h: 3 },
    });
    // rect2 at row=5, col=5, w=3, h=3 → occupies rows 5-7, cols 5-7
    const rect2 = makeLayer("r2", "rect", {
      z: 2,
      bbox: { row: 5, col: 5, w: 3, h: 3 },
    });
    const layers = [rect1, rect2];

    const result = createGroup(layers, ["r1", "r2"], "g1");
    expect(result).not.toBeNull();

    const { layers: out, groupId } = result!;
    const group = out.find((l) => l.id === groupId)!;

    // Union: minRow=0, minCol=0, maxRow=7 (row 5 + h 3 - 1), maxCol=7 (col 5 + w 3 - 1)
    // → w = 7 - 0 + 1 = 8, h = 7 - 0 + 1 = 8
    expect(group.bbox).toEqual({ row: 0, col: 0, w: 8, h: 8 });
  });
});

// ─── ungroup ──────────────────────────────────────────────────────────────

describe("ungroup", () => {
  it("happy path: children promoted to top level and group removed", () => {
    const group = makeLayer("g1", "group" as Layer["type"], {
      z: 5,
      parentId: null,
    } as Partial<Layer>);
    const rect1 = makeLayer("r1", "rect", { z: 0, parentId: "g1" } as Partial<Layer>);
    const rect2 = makeLayer("r2", "rect", { z: 1, parentId: "g1" } as Partial<Layer>);
    const layers = [group, rect1, rect2];

    const out = ungroup(layers, "g1");

    // Group is removed
    expect(out.find((l) => l.id === "g1")).toBeUndefined();
    // Children are promoted to top level
    const outRect1 = out.find((l) => l.id === "r1")!;
    const outRect2 = out.find((l) => l.id === "r2")!;
    expect((outRect1 as Layer).parentId).toBeNull();
    expect((outRect2 as Layer).parentId).toBeNull();
  });

  it("promoted children occupy the group's former z slot, higher siblings shift up", () => {
    // Setup: sibling at z=3, group at z=5, sibling at z=7
    // Group has 2 children (z=0, z=1 inside the group)
    // After ungroup: children take z=5 and z=6, sibling at z=7 shifts to z=8
    const siblingLow = makeLayer("sib-low", "rect", { z: 3, parentId: null });
    const group = makeLayer("g1", "group" as Layer["type"], {
      z: 5,
      parentId: null,
    } as Partial<Layer>);
    const siblingHigh = makeLayer("sib-high", "rect", { z: 7, parentId: null });
    const child1 = makeLayer("c1", "rect", { z: 0, parentId: "g1" } as Partial<Layer>);
    const child2 = makeLayer("c2", "rect", { z: 1, parentId: "g1" } as Partial<Layer>);
    const layers = [siblingLow, group, siblingHigh, child1, child2];

    const out = ungroup(layers, "g1");

    // Low sibling unchanged
    expect(out.find((l) => l.id === "sib-low")!.z).toBe(3);
    // Children get z starting at group's former z=5
    const outC1 = out.find((l) => l.id === "c1")!;
    const outC2 = out.find((l) => l.id === "c2")!;
    // c1 had z=0 (lower), c2 had z=1 → promoted in ascending z order
    // so c1 gets z=5, c2 gets z=6
    expect(outC1.z).toBe(5);
    expect(outC2.z).toBe(6);
    // High sibling shifts from z=7 to z=8 (one extra child was inserted)
    expect(out.find((l) => l.id === "sib-high")!.z).toBe(8);
  });

  it("ungrouping a non-group layer returns input unchanged", () => {
    const rect1 = makeLayer("r1", "rect", { z: 1 });
    const rect2 = makeLayer("r2", "rect", { z: 2 });
    const layers = [rect1, rect2];

    const out = ungroup(layers, "r1");

    // Same layers, no mutation
    expect(out).toHaveLength(2);
    expect(out.find((l) => l.id === "r1")).toBeDefined();
    expect(out.find((l) => l.id === "r2")).toBeDefined();
  });

  it("ungrouping a nonexistent ID returns input unchanged", () => {
    const rect1 = makeLayer("r1", "rect", { z: 1 });
    const layers = [rect1];

    const out = ungroup(layers, "doesNotExist");

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("r1");
  });
});

// ─── reparentLayer ────────────────────────────────────────────────────────

describe("reparentLayer", () => {
  it("happy path: move a rect from top level into a group", () => {
    const group = makeLayer("g1", "group" as Layer["type"], {
      z: 5,
      parentId: null,
    } as Partial<Layer>);
    // One existing child inside the group at z=3
    const existingChild = makeLayer("c0", "rect", {
      z: 3,
      parentId: "g1",
    } as Partial<Layer>);
    const rect1 = makeLayer("r1", "rect", { z: 1, parentId: null });
    const layers = [group, existingChild, rect1];

    const out = reparentLayer(layers, "r1", "g1");

    const outRect1 = out.find((l) => l.id === "r1")!;
    expect((outRect1 as Layer).parentId).toBe("g1");
    // z = max(child.z in g1) + 1 = 3 + 1 = 4
    expect(outRect1.z).toBe(4);
  });

  it("move to top level sets parentId to null", () => {
    const group = makeLayer("g1", "group" as Layer["type"], {
      z: 5,
      parentId: null,
    } as Partial<Layer>);
    const rect1 = makeLayer("r1", "rect", { z: 0, parentId: "g1" } as Partial<Layer>);
    const layers = [group, rect1];

    const out = reparentLayer(layers, "r1", null);

    const outRect1 = out.find((l) => l.id === "r1")!;
    expect((outRect1 as Layer).parentId).toBeNull();
  });

  it("rejects non-group targets: returns input unchanged", () => {
    const rect1 = makeLayer("r1", "rect", { z: 1 });
    const rect2 = makeLayer("r2", "rect", { z: 2 });
    const layers = [rect1, rect2];

    const out = reparentLayer(layers, "r1", "r2");

    // rect2 is not a group, so the reparent is rejected
    const outRect1 = out.find((l) => l.id === "r1")!;
    expect((outRect1 as Layer).parentId).toBeNull();
    expect(out).toHaveLength(2);
  });

  it("reparenting to destination with no siblings assigns z=0", () => {
    const group = makeLayer("g1", "group" as Layer["type"], {
      z: 5,
      parentId: null,
    } as Partial<Layer>);
    const rect1 = makeLayer("r1", "rect", { z: 1, parentId: null });
    const layers = [group, rect1];

    const out = reparentLayer(layers, "r1", "g1");

    const outRect1 = out.find((l) => l.id === "r1")!;
    expect(outRect1.z).toBe(0);
  });

  it("reparenting a layer that doesn't exist returns input unchanged", () => {
    const group = makeLayer("g1", "group" as Layer["type"], {
      z: 5,
      parentId: null,
    } as Partial<Layer>);
    const layers = [group];

    const out = reparentLayer(layers, "nonexistent", "g1");

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("g1");
  });

  it("rejects reparenting a group under itself (self-cycle)", () => {
    const g1 = makeLayer("g1", "group", { z: 5, parentId: null });
    const layers = [g1];

    const out = reparentLayer(layers, "g1", "g1");

    // Layers unchanged — no self-parent cycle
    expect(out.find((l) => l.id === "g1")!.parentId).toBeNull();
  });

  it("rejects reparenting a group under its own descendant (cycle)", () => {
    // G1 contains G2 contains rect. Try to move G1 under G2.
    const g1 = makeLayer("g1", "group", { z: 0, parentId: null });
    const g2 = makeLayer("g2", "group", { z: 0, parentId: "g1" });
    const rect = makeLayer("r1", "rect", { z: 0, parentId: "g2" });
    const layers = [g1, g2, rect];

    const out = reparentLayer(layers, "g1", "g2");

    // Layers unchanged — cycle would be created
    expect(out.find((l) => l.id === "g1")!.parentId).toBeNull();
    expect(out.find((l) => l.id === "g2")!.parentId).toBe("g1");
  });

  it("allows reparenting a layer under a sibling's subtree (no cycle)", () => {
    // G1 and G2 are siblings; moving a rect from G1 into G2 is fine.
    const g1 = makeLayer("g1", "group", { z: 0, parentId: null });
    const g2 = makeLayer("g2", "group", { z: 1, parentId: null });
    const r1 = makeLayer("r1", "rect", { z: 0, parentId: "g1" });
    const layers = [g1, g2, r1];

    const out = reparentLayer(layers, "r1", "g2");

    expect(out.find((l) => l.id === "r1")!.parentId).toBe("g2");
  });
});

// ─── computeGroupBbox ─────────────────────────────────────────────────────

describe("computeGroupBbox", () => {
  it("returns null for an empty group (no children)", () => {
    const group = makeLayer("g1", "group" as Layer["type"], {
      z: 1,
      parentId: null,
    } as Partial<Layer>);
    const layers = [group];

    const bbox = computeGroupBbox(layers, "g1");

    expect(bbox).toBeNull();
  });

  it("returns union bbox for group with two rects", () => {
    const group = makeLayer("g1", "group" as Layer["type"], {
      z: 5,
      parentId: null,
    } as Partial<Layer>);
    // rect1 at {row:0, col:0, w:3, h:3} → rows 0-2, cols 0-2
    const rect1 = makeLayer("r1", "rect", {
      z: 0,
      parentId: "g1",
      bbox: { row: 0, col: 0, w: 3, h: 3 },
    } as Partial<Layer>);
    // rect2 at {row:5, col:5, w:3, h:3} → rows 5-7, cols 5-7
    const rect2 = makeLayer("r2", "rect", {
      z: 1,
      parentId: "g1",
      bbox: { row: 5, col: 5, w: 3, h: 3 },
    } as Partial<Layer>);
    const layers = [group, rect1, rect2];

    const bbox = computeGroupBbox(layers, "g1");

    // Union: minRow=0, minCol=0, maxRow=7, maxCol=7 → w=8, h=8
    expect(bbox).toEqual({ row: 0, col: 0, w: 8, h: 8 });
  });

  it("returns union bbox spanning direct children and nested group's bbox", () => {
    // G1 contains a rect and G2 (a nested group whose bbox is already computed)
    const g1 = makeLayer("g1", "group" as Layer["type"], {
      z: 10,
      parentId: null,
    } as Partial<Layer>);
    const g2 = makeLayer("g2", "group" as Layer["type"], {
      z: 1,
      parentId: "g1",
      // G2's bbox is already set (stale or pre-computed)
      bbox: { row: 10, col: 10, w: 4, h: 4 },
    } as Partial<Layer>);
    const rect1 = makeLayer("r1", "rect", {
      z: 0,
      parentId: "g1",
      bbox: { row: 0, col: 0, w: 3, h: 3 },
    } as Partial<Layer>);
    const layers = [g1, g2, rect1];

    const bbox = computeGroupBbox(layers, "g1");

    // Direct children of g1: rect1 {0,0,3,3} and g2 {10,10,4,4}
    // Union: minRow=0, minCol=0, maxRow=13 (10+4-1), maxCol=13 (10+4-1)
    // → w=14, h=14
    expect(bbox).toEqual({ row: 0, col: 0, w: 14, h: 14 });
  });
});

// ─── recomputeAllGroupBboxes ──────────────────────────────────────────────

describe("recomputeAllGroupBboxes", () => {
  it("top-level groups are recomputed from their direct children", () => {
    // Group with a stale bbox; children are at a different location
    const group = makeLayer("g1", "group" as Layer["type"], {
      z: 5,
      parentId: null,
      // STALE bbox
      bbox: { row: 100, col: 100, w: 1, h: 1 },
    } as Partial<Layer>);
    const rect1 = makeLayer("r1", "rect", {
      z: 0,
      parentId: "g1",
      bbox: { row: 0, col: 0, w: 5, h: 3 },
    } as Partial<Layer>);
    const rect2 = makeLayer("r2", "rect", {
      z: 1,
      parentId: "g1",
      bbox: { row: 2, col: 4, w: 4, h: 4 },
    } as Partial<Layer>);
    const layers = [group, rect1, rect2];

    const out = recomputeAllGroupBboxes(layers);

    const outGroup = out.find((l) => l.id === "g1")!;
    // Union of r1 {0,0,5,3} and r2 {2,4,4,4}:
    // minRow=0, minCol=0, maxRow=5 (2+4-1), maxCol=7 (4+4-1)
    // → w=8, h=6
    expect(outGroup.bbox).toEqual({ row: 0, col: 0, w: 8, h: 6 });
  });

  it("nested groups are recomputed bottom-up: G1 > G2 > rect", () => {
    // G1 > G2 > rect. G2's bbox is stale, G1's bbox is stale.
    // After recompute: G2.bbox matches the rect, G1.bbox matches G2.
    const rect = makeLayer("r1", "rect", {
      z: 0,
      parentId: "g2",
      bbox: { row: 3, col: 7, w: 4, h: 2 },
    } as Partial<Layer>);
    const g2 = makeLayer("g2", "group" as Layer["type"], {
      z: 0,
      parentId: "g1",
      // STALE
      bbox: { row: 999, col: 999, w: 1, h: 1 },
    } as Partial<Layer>);
    const g1 = makeLayer("g1", "group" as Layer["type"], {
      z: 0,
      parentId: null,
      // STALE
      bbox: { row: 999, col: 999, w: 1, h: 1 },
    } as Partial<Layer>);
    const layers = [g1, g2, rect];

    const out = recomputeAllGroupBboxes(layers);

    const outG2 = out.find((l) => l.id === "g2")!;
    const outG1 = out.find((l) => l.id === "g1")!;

    // G2 now matches rect's bbox
    expect(outG2.bbox).toEqual({ row: 3, col: 7, w: 4, h: 2 });
    // G1 now matches G2's (freshly computed) bbox
    expect(outG1.bbox).toEqual({ row: 3, col: 7, w: 4, h: 2 });
  });
});
