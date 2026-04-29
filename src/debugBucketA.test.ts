// Diagnostic-only test for Phase 1 Bucket A investigation.
// NOT a fix. Logs what happens when the harness's clickFrame + dragSelected
// flow is reproduced at unit level.

import { describe, it } from "vitest";
import {
  createEditorStateUnified,
  getFrames,
  getSelectedId,
  selectFrameEffect,
  moveFrameEffect,
  resolveSelectionTarget,
  findContainingBandDeep,
  findPath,
  getBandRelativeRow,
  getBandRelativeCol,
} from "./editorState";
import type { Frame } from "./frame";

const cw = 8, ch = 18;

const SIMPLE_BOX = `Prose above

┌──────────────┐
│              │
│              │
└──────────────┘

Prose below`;

const JUNCTION = `Header

┌───────────┬───────────┐
│  Left     │  Right    │
├───────────┼───────────┤
│  Bottom L │  Bottom R │
└───────────┴───────────┘

Footer`;

function dumpTree(frames: Frame[], depth = 0): string {
  const out: string[] = [];
  const walk = (f: Frame, d: number) => {
    const pad = "  ".repeat(d);
    const kind = f.isBand ? "band" : (f.content === null ? "wireframe" : f.content.type);
    const shortId = f.id.replace(/^frame-/, "").split("-")[0];
    out.push(`${pad}${kind} id=${shortId} grid=(${f.gridRow},${f.gridCol}) ${f.gridW}×${f.gridH} content=${f.content?.text ?? "—"}`);
    for (const c of f.children) walk(c, d + 1);
  };
  for (const f of frames) walk(f, depth);
  return out.join("\n");
}

function simulateClickFrame(state: ReturnType<typeof createEditorStateUnified>, leafId: string) {
  const frames = getFrames(state);
  const hit = findById(frames, leafId);
  if (!hit) throw new Error(`leaf ${leafId} not in tree`);
  const targetId = resolveSelectionTarget(hit, null, frames, false);
  return state.update({ effects: selectFrameEffect.of(targetId) }).state;
}

function findById(frames: Frame[], id: string): Frame | null {
  for (const f of frames) {
    if (f.id === id) return f;
    const c = findById(f.children, id);
    if (c) return c;
  }
  return null;
}

// Walk to find first leaf shape (non-band, non-wireframe)
function firstLeafShape(frames: Frame[]): Frame | null {
  for (const f of frames) {
    if (!f.isBand && f.content !== null) return f;
    const inChild = firstLeafShape(f.children);
    if (inChild) return inChild;
  }
  return null;
}

function logFrame(label: string, f: Frame | null) {
  if (!f) { console.log(`  ${label}: null`); return; }
  const shortId = f.id.replace(/^frame-/, "").split("-")[0];
  console.log(`  ${label}: id=${shortId} grid=(${f.gridRow},${f.gridCol}) ${f.gridW}×${f.gridH}`);
}

describe("Bucket A diagnostic — what gets selected on clickFrame(0)?", () => {
  it("SIMPLE_BOX: tree shape + click resolution", () => {
    const state = createEditorStateUnified(SIMPLE_BOX, cw, ch);
    const frames = getFrames(state);
    console.log("\n=== SIMPLE_BOX tree ===");
    console.log(dumpTree(frames));
    const leaf = firstLeafShape(frames);
    console.log("\nFirst leaf shape:");
    logFrame("leaf", leaf);
    if (!leaf) return;
    const path = findPath(frames, leaf.id);
    console.log("\nPath root → leaf:");
    for (const p of path) logFrame("  step", p);
    const targetId = resolveSelectionTarget(leaf, null, frames, false);
    const tShort = targetId?.replace(/^frame-/, "").split("-")[0] ?? "null";
    console.log(`\nresolveSelectionTarget(leaf, null, frames, false) = ${tShort}`);
    const selected = simulateClickFrame(state, leaf.id);
    const sShort = getSelectedId(selected)?.replace(/^frame-/, "").split("-")[0] ?? "null";
    console.log(`After selectFrameEffect: getSelectedId = ${sShort}`);

    // Drag clamp math
    const containingBand = findContainingBandDeep(frames, leaf.id);
    console.log("\nContaining band:");
    logFrame("band", containingBand);
    if (containingBand) {
      const bandRow = getBandRelativeRow(leaf.id, containingBand.id, frames);
      const bandCol = getBandRelativeCol(leaf.id, containingBand.id, frames);
      console.log(`  bandRow=${bandRow} bandCol=${bandCol}`);
      console.log(`  band.gridH=${containingBand.gridH} band.gridW=${containingBand.gridW}`);
      console.log(`  leaf.gridH=${leaf.gridH} leaf.gridW=${leaf.gridW}`);
      const minDRow = -bandRow;
      const maxDRow = containingBand.gridH - leaf.gridH - bandRow;
      const minDCol = -bandCol;
      const maxDCol = containingBand.gridW - leaf.gridW - bandCol;
      console.log(`  drag-clamp: dRow ∈ [${minDRow}, ${maxDRow}], dCol ∈ [${minDCol}, ${maxDCol}]`);
      // Simulate drag of 100px down → ~5-6 rows
      const desiredDRow = 6, desiredDCol = 0;
      const clampedDRow = Math.max(minDRow, Math.min(maxDRow, desiredDRow));
      const residualDRow = desiredDRow - clampedDRow;
      console.log(`  desired dRow=${desiredDRow} → clamped=${clampedDRow}, residual escalated to band=${residualDRow}`);
    }
  });

  it("JUNCTION: tree shape + click resolution on first quadrant rect", () => {
    const state = createEditorStateUnified(JUNCTION, cw, ch);
    const frames = getFrames(state);
    console.log("\n=== JUNCTION tree ===");
    console.log(dumpTree(frames));
    const leaf = firstLeafShape(frames);
    console.log("\nFirst leaf shape:");
    logFrame("leaf", leaf);
    if (!leaf) return;
    const path = findPath(frames, leaf.id);
    console.log("\nPath root → leaf:");
    for (const p of path) logFrame("  step", p);
    const targetId = resolveSelectionTarget(leaf, null, frames, false);
    const tShort2 = targetId?.replace(/^frame-/, "").split("-")[0] ?? "null";
    console.log(`\nresolveSelectionTarget(leaf, null, frames, false) = ${tShort2}`);
    if (targetId) {
      const target = findById(frames, targetId);
      logFrame("target", target);
    }

    const containingBand = findContainingBandDeep(frames, leaf.id);
    console.log("\nContaining band:");
    logFrame("band", containingBand);
    if (containingBand) {
      const bandRow = getBandRelativeRow(leaf.id, containingBand.id, frames);
      const bandCol = getBandRelativeCol(leaf.id, containingBand.id, frames);
      console.log(`  bandRow=${bandRow} bandCol=${bandCol}`);
      console.log(`  band.gridH=${containingBand.gridH} band.gridW=${containingBand.gridW}`);
      console.log(`  leaf.gridH=${leaf.gridH} leaf.gridW=${leaf.gridW}`);
      const minDRow = -bandRow;
      const maxDRow = containingBand.gridH - leaf.gridH - bandRow;
      const minDCol = -bandCol;
      const maxDCol = containingBand.gridW - leaf.gridW - bandCol;
      console.log(`  drag-clamp: dRow ∈ [${minDRow}, ${maxDRow}], dCol ∈ [${minDCol}, ${maxDCol}]`);
      // Simulate drag of 50px right → ~6 cols
      const desiredDCol = 6;
      const clampedDCol = Math.max(minDCol, Math.min(maxDCol, desiredDCol));
      console.log(`  desired dCol=${desiredDCol} → clamped=${clampedDCol}`);
    }
  });

  it("SIMPLE_BOX: simulate full click + 0,100px drag, observe leaf delta", () => {
    let state = createEditorStateUnified(SIMPLE_BOX, cw, ch);
    const frames0 = getFrames(state);
    const leaf0 = firstLeafShape(frames0);
    if (!leaf0) return;
    // Click the leaf
    state = simulateClickFrame(state, leaf0.id);
    // Now perform drag dCol=0 dRow=6 using same logic as DemoV2
    const containingBand = findContainingBandDeep(getFrames(state), leaf0.id)!;
    const bandRow = getBandRelativeRow(leaf0.id, containingBand.id, getFrames(state));
    const bandCol = getBandRelativeCol(leaf0.id, containingBand.id, getFrames(state));
    const child = leaf0;
    const dRow = 6, dCol = 0;
    const minDRow = -bandRow;
    const maxDRow = containingBand.gridH - child.gridH - bandRow;
    const minDCol = -bandCol;
    const maxDCol = containingBand.gridW - child.gridW - bandCol;
    const clampedDRow = Math.max(minDRow, Math.min(maxDRow, dRow));
    const clampedDCol = Math.max(minDCol, Math.min(maxDCol, dCol));
    const residualDRow = dRow - clampedDRow;
    console.log(`\n=== SIMPLE_BOX drag simulation ===`);
    console.log(`leaf gridRow=${leaf0.gridRow} gridCol=${leaf0.gridCol}`);
    console.log(`band gridH=${containingBand.gridH} gridW=${containingBand.gridW}`);
    console.log(`bandRow=${bandRow} bandCol=${bandCol}`);
    console.log(`drag dRow=${dRow} → clamped=${clampedDRow} residual=${residualDRow}`);
    console.log(`drag dCol=${dCol} → clamped=${clampedDCol}`);
    const effects = [];
    if (clampedDRow !== 0 || clampedDCol !== 0) {
      effects.push(moveFrameEffect.of({ id: leaf0.id, dCol: clampedDCol, dRow: clampedDRow, charWidth: cw, charHeight: ch }));
    }
    if (residualDRow !== 0) {
      effects.push(moveFrameEffect.of({ id: containingBand.id, dCol: 0, dRow: residualDRow, charWidth: cw, charHeight: ch }));
    }
    console.log(`emitting ${effects.length} effects`);
    state = state.update({ effects }).state;
    const framesAfter = getFrames(state);
    const leafAfter = findById(framesAfter, leaf0.id);
    console.log(`\nAfter drag:`);
    logFrame("leaf before", leaf0);
    logFrame("leaf after ", leafAfter);
    console.log(`leaf moved: dGridRow=${(leafAfter?.gridRow ?? 0) - leaf0.gridRow}, dGridCol=${(leafAfter?.gridCol ?? 0) - leaf0.gridCol}`);
    console.log(`pixel delta: dx=${(leafAfter?.x ?? 0) - leaf0.x}, dy=${(leafAfter?.y ?? 0) - leaf0.y}`);

    // Per harness's getFrameRects, leaf's absolute pos is sum of all path offsets.
    const pathBefore = findPath(frames0, leaf0.id);
    const pathAfter = findPath(framesAfter, leaf0.id);
    let absXBefore = 0, absYBefore = 0;
    for (const p of pathBefore) { absXBefore += p.x; absYBefore += p.y; }
    let absXAfter = 0, absYAfter = 0;
    for (const p of pathAfter) { absXAfter += p.x; absYAfter += p.y; }
    console.log(`\nharness perspective (sum of path):`);
    console.log(`  before: absX=${absXBefore} absY=${absYBefore}`);
    console.log(`  after:  absX=${absXAfter} absY=${absYAfter}`);
    console.log(`  delta:  ${absXAfter - absXBefore}, ${absYAfter - absYBefore}`);
  });

  it("JUNCTION: simulate full click + 50,0px drag on first quadrant", () => {
    let state = createEditorStateUnified(JUNCTION, cw, ch);
    const frames0 = getFrames(state);
    const leaf0 = firstLeafShape(frames0);
    if (!leaf0) return;
    state = simulateClickFrame(state, leaf0.id);
    const containingBand = findContainingBandDeep(getFrames(state), leaf0.id)!;
    const bandRow = getBandRelativeRow(leaf0.id, containingBand.id, getFrames(state));
    const bandCol = getBandRelativeCol(leaf0.id, containingBand.id, getFrames(state));
    const dCol = 6, dRow = 0;
    const minDRow = -bandRow;
    const maxDRow = containingBand.gridH - leaf0.gridH - bandRow;
    const minDCol = -bandCol;
    const maxDCol = containingBand.gridW - leaf0.gridW - bandCol;
    const clampedDRow = Math.max(minDRow, Math.min(maxDRow, dRow));
    const clampedDCol = Math.max(minDCol, Math.min(maxDCol, dCol));
    console.log(`\n=== JUNCTION drag simulation ===`);
    console.log(`leaf gridRow=${leaf0.gridRow} gridCol=${leaf0.gridCol} ${leaf0.gridW}×${leaf0.gridH}`);
    console.log(`band ${containingBand.gridW}×${containingBand.gridH}`);
    console.log(`bandRow=${bandRow} bandCol=${bandCol}`);
    console.log(`drag dCol=${dCol} → clamped=${clampedDCol}`);
    console.log(`drag dRow=${dRow} → clamped=${clampedDRow}`);

    const effects = [];
    if (clampedDRow !== 0 || clampedDCol !== 0) {
      effects.push(moveFrameEffect.of({ id: leaf0.id, dCol: clampedDCol, dRow: clampedDRow, charWidth: cw, charHeight: ch }));
    }
    state = state.update({ effects }).state;
    const framesAfter = getFrames(state);
    const leafAfter = findById(framesAfter, leaf0.id);
    const pathBefore = findPath(frames0, leaf0.id);
    const pathAfter = findPath(framesAfter, leaf0.id);
    let absXBefore = 0, absYBefore = 0;
    for (const p of pathBefore) { absXBefore += p.x; absYBefore += p.y; }
    let absXAfter = 0, absYAfter = 0;
    for (const p of pathAfter) { absXAfter += p.x; absYAfter += p.y; }
    console.log(`harness absX/absY: before (${absXBefore},${absYBefore}) after (${absXAfter},${absYAfter}) delta (${absXAfter-absXBefore},${absYAfter-absYBefore})`);

    // What about the OTHER quadrants? They should be unaffected.
    console.log(`\nAll leaf shapes after:`);
    const allLeaves: Frame[] = [];
    const collect = (fs: Frame[]) => {
      for (const f of fs) {
        if (!f.isBand && f.content !== null) allLeaves.push(f);
        collect(f.children);
      }
    };
    collect(framesAfter);
    for (const l of allLeaves) logFrame("  ", l);
  });
});
