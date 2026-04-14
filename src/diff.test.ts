import { describe, it, expect } from "vitest";
import { diffLayers, type ProposedLayer } from "./diff";
import { contentAddressedId, BASE_LAYER_ID } from "./identity";
import type { Layer } from "./layers";

// ── Factories ───────────────────────────────────────────────

import type { Bbox } from "./types";

function makeRect(id: string, bbox: Bbox, extras: Partial<Layer> = {}): Layer {
  return {
    id,
    type: "rect",
    z: 0,
    visible: true,
    parentId: null,
    cells: new Map(),
    bbox,
    ...extras,
  } as Layer;
}

function makeGroup(id: string, bbox: Bbox, extras: Partial<Layer> = {}): Layer {
  return {
    id,
    type: "group",
    z: 0,
    visible: true,
    parentId: null,
    cells: new Map(),
    bbox,
    ...extras,
  } as Layer;
}

function makeProposal(
  type: ProposedLayer["type"],
  bbox: Bbox,
  content?: string,
): ProposedLayer {
  return { type, bbox, cells: new Map(), content };
}

// ── Step 1: exact match ─────────────────────────────────────

describe("diffLayers — Step 1: exact match", () => {
  it("empty existing + empty proposals → empty output", () => {
    const result = diffLayers([], []);
    expect(result).toEqual([]);
  });

  it("empty existing + one proposal → one new layer with content-addressed ID and defaults", () => {
    const bbox: Bbox = { row: 0, col: 0, w: 5, h: 3 };
    const proposal = makeProposal("rect", bbox);
    const result = diffLayers([], [proposal]);

    expect(result).toHaveLength(1);
    const layer = result[0];
    expect(layer.id).toBe(contentAddressedId(proposal));
    expect(layer.parentId).toBeNull();
    expect(layer.visible).toBe(true);
    expect(layer.label).toBeUndefined();
    expect(layer.z).toBe(0);
  });

  it("exact match preserves parentId, label, visible, z, and style", () => {
    const bbox: Bbox = { row: 2, col: 3, w: 10, h: 5 };
    const style = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
    const proposal = makeProposal("rect", bbox);
    const existingId = contentAddressedId(proposal);
    const existing = makeRect(existingId, bbox, {
      parentId: "g1",
      label: "My Box",
      visible: false,
      z: 5,
      style,
    });

    const result = diffLayers([existing], [proposal]);

    expect(result).toHaveLength(1);
    const layer = result[0];
    expect(layer.parentId).toBe("g1");
    expect(layer.label).toBe("My Box");
    expect(layer.visible).toBe(false);
    expect(layer.z).toBe(5);
    expect(layer.style).toEqual(style);
  });

  it("duplicate existing IDs — higher-z layer wins, lower-z is dropped", () => {
    // Two rects with identical bbox → same content-addressed ID
    const bbox: Bbox = { row: 0, col: 0, w: 3, h: 3 };
    const proposal = makeProposal("rect", bbox);
    const sharedId = contentAddressedId(proposal);

    const lowerZ = makeRect(sharedId, bbox, { z: 1, label: "lower" });
    const higherZ = makeRect(sharedId, bbox, { z: 9, label: "higher" });

    const result = diffLayers([lowerZ, higherZ], [proposal]);

    expect(result).toHaveLength(1);
    expect(result[0].z).toBe(9);
    expect(result[0].label).toBe("higher");
  });
});

// ── Step 2: geometry fallback ───────────────────────────────

describe("diffLayers — Step 2: geometry fallback", () => {
  it("shifted rect is rematched via geometry and preserves label", () => {
    const existingBbox: Bbox = { row: 0, col: 0, w: 5, h: 3 };
    const proposalBbox: Bbox = { row: 0, col: 1, w: 5, h: 3 };

    const proposal = makeProposal("rect", proposalBbox);
    const existingId = contentAddressedId({ type: "rect", bbox: existingBbox });
    const existing = makeRect(existingId, existingBbox, { label: "Keep me" });

    // Step 1 won't match (different bbox → different hash)
    // Step 2 should match via geometry (only 1-col shift)
    const result = diffLayers([existing], [proposal]);

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Keep me");
  });

  it("A/B/C insertion — inserted rect is new, A/B/C keep their labels", () => {
    // Three existing rects left-to-right
    const bboxA: Bbox = { row: 0, col: 0, w: 3, h: 3 };
    const bboxB: Bbox = { row: 0, col: 10, w: 3, h: 3 };
    const bboxC: Bbox = { row: 0, col: 20, w: 3, h: 3 };

    const idA = contentAddressedId({ type: "rect", bbox: bboxA });
    const idB = contentAddressedId({ type: "rect", bbox: bboxB });
    const idC = contentAddressedId({ type: "rect", bbox: bboxC });

    const existingA = makeRect(idA, bboxA, { z: 1, label: "A" });
    const existingB = makeRect(idB, bboxB, { z: 2, label: "B" });
    const existingC = makeRect(idC, bboxC, { z: 3, label: "C" });

    // Proposals: A, new rect at col 5, B, C (B and C are unshifted)
    const propA = makeProposal("rect", bboxA);
    const propNew = makeProposal("rect", { row: 0, col: 5, w: 3, h: 3 });
    const propB = makeProposal("rect", bboxB);
    const propC = makeProposal("rect", bboxC);

    const result = diffLayers([existingA, existingB, existingC], [propA, propNew, propB, propC]);

    expect(result).toHaveLength(4);

    const labeledA = result.find((l) => l.label === "A");
    const labeledB = result.find((l) => l.label === "B");
    const labeledC = result.find((l) => l.label === "C");
    expect(labeledA).toBeDefined();
    expect(labeledB).toBeDefined();
    expect(labeledC).toBeDefined();

    // The new rect at col 5 has no label (it's brand new)
    const newLayer = result.find(
      (l) => l.bbox.col === 5 && l.label === undefined,
    );
    expect(newLayer).toBeDefined();
  });

  it("geometry fallback rejects cross-type matches — existing rect, proposal text → new text layer, rect removed", () => {
    const bbox: Bbox = { row: 0, col: 0, w: 5, h: 3 };
    const rectId = contentAddressedId({ type: "rect", bbox });
    const existingRect = makeRect(rectId, bbox, { label: "rect" });

    // Text proposal at same bbox — step 1 misses (different type prefix),
    // step 2 cost is MISMATCH_COST, so the assignment is rejected
    const textProposal = makeProposal("text", bbox);

    const result = diffLayers([existingRect], [textProposal]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    // The old rect should be gone
    expect(result.find((l) => l.type === "rect")).toBeUndefined();
    // New text layer should have a fresh content-addressed ID (not the old rect's ID)
    expect(result[0].id).toBe(contentAddressedId(textProposal));
  });

  it("empty proposals short-circuit — rect removed, no crash", () => {
    const bbox: Bbox = { row: 0, col: 0, w: 3, h: 3 };
    const rectId = contentAddressedId({ type: "rect", bbox });
    const existing = makeRect(rectId, bbox);

    const result = diffLayers([existing], []);
    expect(result).toEqual([]);
  });
});

// ── Step 3: new proposal IDs and z assignment ───────────────

describe("diffLayers — Step 3: new proposals get content-addressed IDs and z", () => {
  it("new proposals get content-addressed IDs", () => {
    const bbox: Bbox = { row: 1, col: 2, w: 7, h: 4 };
    const proposal = makeProposal("rect", bbox);

    const result = diffLayers([], [proposal]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(contentAddressedId(proposal));
  });

  it("new proposals after matched layers get z = max(existingZ) + 1 + index", () => {
    // Three existing layers with z = 5, 10, 15; one matching proposal (z=5)
    const matchedBbox: Bbox = { row: 0, col: 0, w: 3, h: 3 };
    const matchedId = contentAddressedId({ type: "rect", bbox: matchedBbox });
    const existingMatched = makeRect(matchedId, matchedBbox, { z: 5 });
    const existingOther1 = makeRect("other1", { row: 5, col: 5, w: 3, h: 3 }, { z: 10 });
    const existingOther2 = makeRect("other2", { row: 10, col: 10, w: 3, h: 3 }, { z: 15 });

    const matchingProposal = makeProposal("rect", matchedBbox);
    const newProposal1 = makeProposal("rect", { row: 20, col: 20, w: 3, h: 3 });
    const newProposal2 = makeProposal("rect", { row: 30, col: 30, w: 3, h: 3 });

    const result = diffLayers(
      [existingMatched, existingOther1, existingOther2],
      [matchingProposal, newProposal1, newProposal2],
    );

    // matched proposal keeps z=5; unmatched other1 and other2 are removed
    // new proposals get z = max(5,10,15) + 1 + 0 = 16, and + 1 = 17
    const newLayers = result
      .filter((l) => l.id !== matchedId)
      .sort((a, b) => a.z - b.z);

    expect(newLayers).toHaveLength(2);
    expect(newLayers[0].z).toBe(16);
    expect(newLayers[1].z).toBe(17);
  });

  it("empty existing → first new proposal gets z = 0, not -Infinity", () => {
    const proposal = makeProposal("rect", { row: 0, col: 0, w: 3, h: 3 });
    const result = diffLayers([], [proposal]);

    expect(result).toHaveLength(1);
    expect(result[0].z).toBe(0);
    expect(Number.isFinite(result[0].z)).toBe(true);
  });
});

// ── Step 4: stale removal ───────────────────────────────────

describe("diffLayers — Step 4: stale removal", () => {
  it("unmatched non-group existing layer is removed", () => {
    const existingBbox: Bbox = { row: 0, col: 0, w: 5, h: 5 };
    const existingId = contentAddressedId({ type: "rect", bbox: existingBbox });
    const existing = makeRect(existingId, existingBbox, { label: "old" });

    // Proposal has completely different geometry → no match in step 1 or 2
    const proposal = makeProposal("rect", { row: 100, col: 100, w: 3, h: 3 });

    const result = diffLayers([existing], [proposal]);

    expect(result).toHaveLength(1);
    expect(result.find((l) => l.label === "old")).toBeUndefined();
  });

  it("existing base layer is removed when proposals have no base", () => {
    const baseLayer: Layer = {
      id: BASE_LAYER_ID,
      type: "base",
      z: 0,
      visible: true,
      parentId: null,
      cells: new Map([["0,0", "x"]]),
      bbox: { row: 0, col: 0, w: 1, h: 1 },
    };

    // Proposals only have a regular rect, no base
    const proposal = makeProposal("rect", { row: 0, col: 0, w: 3, h: 3 });

    const result = diffLayers([baseLayer], [proposal]);

    expect(result.find((l) => l.type === "base")).toBeUndefined();
  });

  it("new base proposal gets id === BASE_LAYER_ID", () => {
    const baseProposal = makeProposal("base", { row: 0, col: 0, w: 10, h: 5 });

    const result = diffLayers([], [baseProposal]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(BASE_LAYER_ID);
    expect(result[0].type).toBe("base");
  });
});

// ── Step 5: group pruning and bbox recomputation ────────────

describe("diffLayers — Step 5: group pruning and bbox recomputation", () => {
  it("group with all children surviving has its bbox recomputed as union of child bboxes", () => {
    const childBbox1: Bbox = { row: 0, col: 0, w: 3, h: 3 };
    const childBbox2: Bbox = { row: 5, col: 5, w: 3, h: 3 };

    const childId1 = contentAddressedId({ type: "rect", bbox: childBbox1 });
    const childId2 = contentAddressedId({ type: "rect", bbox: childBbox2 });

    const group = makeGroup("g1", { row: 0, col: 0, w: 3, h: 3 });
    const child1 = makeRect(childId1, childBbox1, { parentId: "g1", z: 1 });
    const child2 = makeRect(childId2, childBbox2, { parentId: "g1", z: 2 });

    const propChild1 = makeProposal("rect", childBbox1);
    const propChild2 = makeProposal("rect", childBbox2);

    const result = diffLayers([group, child1, child2], [propChild1, propChild2]);

    const survivingGroup = result.find((l) => l.id === "g1");
    expect(survivingGroup).toBeDefined();

    // Union of {0,0,3,3} and {5,5,3,3}:
    // minRow=0, minCol=0, maxRow=0+3-1=2 vs 5+3-1=7 → maxRow=7, maxCol=7
    // w = maxCol - minCol + 1 = 8, h = maxRow - minRow + 1 = 8
    expect(survivingGroup!.bbox).toEqual({ row: 0, col: 0, w: 8, h: 8 });
  });

  it("group with zero surviving children is removed", () => {
    const childBbox: Bbox = { row: 0, col: 0, w: 3, h: 3 };
    const childId = contentAddressedId({ type: "rect", bbox: childBbox });

    const group = makeGroup("g1", childBbox);
    const child = makeRect(childId, childBbox, { parentId: "g1" });

    // Proposals do NOT include the child → child is removed → group pruned
    const result = diffLayers([group, child], []);

    expect(result).toHaveLength(0);
    expect(result.find((l) => l.id === "g1")).toBeUndefined();
  });

  it("nested groups: child group bbox is recomputed before parent bbox", () => {
    const rectBbox: Bbox = { row: 2, col: 2, w: 4, h: 4 };
    const rectId = contentAddressedId({ type: "rect", bbox: rectBbox });

    // G1 > G2 > rect
    const g1 = makeGroup("g1", { row: 0, col: 0, w: 1, h: 1 }, { z: 0 });
    const g2 = makeGroup("g2", { row: 0, col: 0, w: 1, h: 1 }, { parentId: "g1", z: 1 });
    const rect = makeRect(rectId, rectBbox, { parentId: "g2", z: 2 });

    const propRect = makeProposal("rect", rectBbox);

    const result = diffLayers([g1, g2, rect], [propRect]);

    const survivingG1 = result.find((l) => l.id === "g1");
    const survivingG2 = result.find((l) => l.id === "g2");

    expect(survivingG2).toBeDefined();
    // G2's bbox should cover the rect exactly
    expect(survivingG2!.bbox).toEqual(rectBbox);

    expect(survivingG1).toBeDefined();
    // G1's bbox should cover G2, which covers the rect
    expect(survivingG1!.bbox).toEqual(rectBbox);
  });
});
