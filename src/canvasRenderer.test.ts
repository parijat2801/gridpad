// src/canvasRenderer.test.ts
// Tests for canvasRenderer.ts — buildRenderState and paintCanvas.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { buildRenderState, paintCanvas, type RenderState, type Viewport } from "./canvasRenderer";
import { createEditorState, getFrames } from "./editorState";
import { createFrame, createRectFrame } from "./frame";
import { LIGHT_RECT_STYLE } from "./layers";

// ── Canvas mock for Pretext ──────────────────────────────────────────────────

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

// ── Mock canvas context ──────────────────────────────────────────────────────

function makeMockCtx() {
  const calls: { method: string; args: unknown[] }[] = [];
  const track = (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  return {
    __calls: calls,
    fillRect: track("fillRect"),
    strokeRect: track("strokeRect"),
    fillText: track("fillText"),
    beginPath: track("beginPath"),
    moveTo: track("moveTo"),
    lineTo: track("lineTo"),
    stroke: track("stroke"),
    save: track("save"),
    restore: track("restore"),
    clip: track("clip"),
    rect: track("rect"),
    setTransform: track("setTransform"),
    translate: track("translate"),
    setLineDash: track("setLineDash"),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "top" as CanvasTextBaseline,
  };
}

const CW = 9.6;
const CH = 18.4;
const VIEWPORT: Viewport = { w: 800, h: 600 };
const DPR = 2;

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyState(prose = "") {
  return createEditorState({ prose, frames: [], regions: [], proseParts: [] });
}

function stateWithFrame() {
  const frame = createRectFrame({ gridW: 4, gridH: 3, style: LIGHT_RECT_STYLE, charWidth: CW, charHeight: CH });
  return createEditorState({ prose: "Hello world", frames: [frame], regions: [], proseParts: [] });
}

// ── buildRenderState tests ───────────────────────────────────────────────────

describe("buildRenderState", () => {
  it("creates a RenderState with prose text from EditorState", () => {
    const state = emptyState("Some prose text");
    const rs = buildRenderState(state, VIEWPORT, DPR, CW, CH);
    expect(rs.proseText).toBe("Some prose text");
  });

  it("includes frames from EditorState", () => {
    const state = stateWithFrame();
    const rs = buildRenderState(state, VIEWPORT, DPR, CW, CH);
    expect(rs.frames).toHaveLength(1);
    expect(rs.frames[0]).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
  });

  it("defaults selectedId to null", () => {
    const state = emptyState();
    const rs = buildRenderState(state, VIEWPORT, DPR, CW, CH);
    expect(rs.selectedId).toBeNull();
  });

  it("sets charWidth and charHeight from parameters", () => {
    const state = emptyState();
    const rs = buildRenderState(state, VIEWPORT, DPR, CW, CH);
    expect(rs.charWidth).toBe(CW);
    expect(rs.charHeight).toBe(CH);
  });

  it("preserves frames from EditorState — getFrames and buildRenderState agree", () => {
    const state = stateWithFrame();
    const rs = buildRenderState(state, VIEWPORT, DPR, CW, CH);
    const frames = getFrames(state);
    expect(rs.frames).toHaveLength(frames.length);
    expect(rs.frames[0].id).toBe(frames[0].id);
  });
});

// ── paintCanvas tests ────────────────────────────────────────────────────────

describe("paintCanvas", () => {
  it("paintCanvas calls setTransform with DPR", () => {
    const ctx = makeMockCtx();
    const state = emptyState("line one");
    const rs = buildRenderState(state, VIEWPORT, DPR, CW, CH);
    paintCanvas(ctx as unknown as CanvasRenderingContext2D, rs);

    const setTransformCall = ctx.__calls.find((c) => c.method === "setTransform");
    expect(setTransformCall).toBeDefined();
    // setTransform(dpr, 0, 0, dpr, 0, 0) — first arg is DPR
    expect(setTransformCall?.args[0]).toBe(DPR);
  });

  it("paintCanvas calls fillText for each prose line", () => {
    const ctx = makeMockCtx();
    const state = createEditorState({
      prose: "line one\nline two\nline three",
      frames: [],
      regions: [],
      proseParts: [
        { startRow: 0, text: "line one" },
        { startRow: 1, text: "line two" },
        { startRow: 2, text: "line three" },
      ],
    });
    const rs = buildRenderState(state, VIEWPORT, DPR, CW, CH);
    paintCanvas(ctx as unknown as CanvasRenderingContext2D, rs);

    const fillTextCalls = ctx.__calls.filter((c) => c.method === "fillText");
    // Should have at least one fillText call for the prose
    expect(fillTextCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("paintCanvas renders frames via fillRect or fillText calls", () => {
    const ctx = makeMockCtx();
    const frame = createRectFrame({ gridW: 4, gridH: 3, style: LIGHT_RECT_STYLE, charWidth: CW, charHeight: CH });
    const state = createEditorState({
      prose: "",
      frames: [frame],
      regions: [],
      proseParts: [],
    });
    const rs = buildRenderState(state, VIEWPORT, DPR, CW, CH);
    paintCanvas(ctx as unknown as CanvasRenderingContext2D, rs);

    // Frames with content should produce fillText calls (glyph rendering)
    const drawCalls = ctx.__calls.filter(
      (c) => c.method === "fillText" || c.method === "fillRect",
    );
    expect(drawCalls.length).toBeGreaterThan(0);
  });
});
