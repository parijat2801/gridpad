// src/zorder.test.ts
// Tests for Phase 6 z-order support.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createFrame, createRectFrame, hitTestFrames } from "./frame";
import { createEditorState, getFrames, setZEffect, editorUndo } from "./editorState";
import { buildRenderState } from "./canvasRenderer";
import { LIGHT_RECT_STYLE } from "./layers";
import { Transaction } from "@codemirror/state";

// ── Canvas mock for Pretext ────────────────────────────────────────────────

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "",
        fillStyle: "",
        textBaseline: "",
        fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      })) as HTMLCanvasElement["getContext"];
    }
    return el;
  });
});

const CW = 9.6;
const CH = 18.4;
const VIEWPORT = { w: 800, h: 600 };
const DPR = 2;

// ── z-order tests ─────────────────────────────────────────────────────────

describe("z-order", () => {
  it("createFrame has z = 0 by default", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    expect(frame.z).toBe(0);
  });

  it("createRectFrame has z = 0 by default", () => {
    const frame = createRectFrame({
      gridW: 4,
      gridH: 3,
      style: LIGHT_RECT_STYLE,
      charWidth: CW,
      charHeight: CH,
    });
    expect(frame.z).toBe(0);
  });

  it("setZEffect updates frame z value", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    let state = createEditorState({
      prose: "",
      frames: [frame],
      regions: [],
      proseParts: [],
    });

    state = state.update({
      effects: setZEffect.of({ id: frame.id, z: 5 }),
      annotations: Transaction.addToHistory.of(true),
    }).state;

    const frames = getFrames(state);
    expect(frames[0].z).toBe(5);
  });

  it("setZEffect is undoable", () => {
    const frame = createFrame({ x: 0, y: 0, w: 100, h: 50 });
    let state = createEditorState({
      prose: "",
      frames: [frame],
      regions: [],
      proseParts: [],
    });

    // Apply setZEffect
    state = state.update({
      effects: setZEffect.of({ id: frame.id, z: 10 }),
      annotations: Transaction.addToHistory.of(true),
    }).state;

    expect(getFrames(state)[0].z).toBe(10);

    // Undo
    state = editorUndo(state);
    expect(getFrames(state)[0].z).toBe(0);
  });

  it("buildRenderState sorts frames by ascending z", () => {
    const frameA = { ...createFrame({ x: 0, y: 0, w: 50, h: 50 }), z: 2 };
    const frameB = { ...createFrame({ x: 10, y: 10, w: 50, h: 50 }), z: 0 };
    const frameC = { ...createFrame({ x: 20, y: 20, w: 50, h: 50 }), z: 1 };

    const state = createEditorState({
      prose: "",
      frames: [frameA, frameB, frameC],
      regions: [],
      proseParts: [],
    });

    const rs = buildRenderState(state, VIEWPORT, DPR, CW, CH);

    // Should be sorted ascending: z=0, z=1, z=2
    expect(rs.frames[0].z).toBe(0);
    expect(rs.frames[1].z).toBe(1);
    expect(rs.frames[2].z).toBe(2);
  });

  it("hitTestFrames picks the highest-z frame when overlapping", () => {
    // Two overlapping frames at the same position; higher z wins
    const frameLow = { ...createFrame({ x: 0, y: 0, w: 100, h: 100 }), z: 0 };
    const frameHigh = { ...createFrame({ x: 0, y: 0, w: 100, h: 100 }), z: 5 };

    // hitTestFrames should return the higher-z frame (frameHigh)
    const hit = hitTestFrames([frameLow, frameHigh], 50, 50);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(frameHigh.id);
  });

  it("hitTestFrames returns lower-z frame if higher-z does not overlap the point", () => {
    const frameLow = { ...createFrame({ x: 0, y: 0, w: 200, h: 200 }), z: 0 };
    const frameHigh = { ...createFrame({ x: 100, y: 100, w: 50, h: 50 }), z: 5 };

    // Click at (10, 10) — inside frameLow, outside frameHigh
    const hit = hitTestFrames([frameLow, frameHigh], 10, 10);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(frameLow.id);
  });
});
