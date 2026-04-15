import { describe, it, expect, vi } from "vitest";

// These will fail until frameRenderer.ts exists
import { renderFrame, renderFrameSelection } from "./frameRenderer";
import { createFrame, createRectFrame } from "./frame";
import { LIGHT_RECT_STYLE } from "./layers";

const CW = 9.6;
const CH = 18.4;

function mockCtx() {
  return {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    textBaseline: "",
    lineWidth: 0,
    fillText: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe("renderFrame", () => {
  it("draws content cells for a rect frame", () => {
    const ctx = mockCtx();
    const frame = createRectFrame({
      gridW: 4, gridH: 3,
      style: LIGHT_RECT_STYLE,
      charWidth: CW, charHeight: CH,
    });

    renderFrame(ctx, frame, 0, 0, CW, CH);

    // Should have called fillText for the sparse rows of the rect
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it("applies clip when frame.clip is true", () => {
    const ctx = mockCtx();
    const parent = {
      ...createFrame({ x: 0, y: 0, w: 100, h: 80 }),
      clip: true,
      children: [createRectFrame({
        gridW: 4, gridH: 3,
        style: LIGHT_RECT_STYLE,
        charWidth: CW, charHeight: CH,
      })],
    };

    renderFrame(ctx, parent, 0, 0, CW, CH);

    expect(ctx.save).toHaveBeenCalled();
    expect(ctx.clip).toHaveBeenCalled();
    expect(ctx.restore).toHaveBeenCalled();
  });

  it("offsets children by parent position", () => {
    const ctx = mockCtx();
    const child = createRectFrame({
      gridW: 3, gridH: 2,
      style: LIGHT_RECT_STYLE,
      charWidth: CW, charHeight: CH,
    });
    const parent = {
      ...createFrame({ x: 50, y: 100, w: 200, h: 150 }),
      children: [{ ...child, x: 10, y: 20 }],
    };

    renderFrame(ctx, parent, 0, 0, CW, CH);

    // fillText calls should have x offset of 50 + 10 = 60
    const calls = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // At least one call should have x > 50 (parent offset)
    const hasOffset = calls.some((c: [string, number, number]) => c[1] >= 50);
    expect(hasOffset).toBe(true);
  });
});

describe("renderFrameSelection", () => {
  it("draws blue stroke rect and 8 handles for selected frame", () => {
    const ctx = mockCtx();
    const frame = createFrame({ x: 10, y: 20, w: 100, h: 80 });

    renderFrameSelection(ctx, frame, 10, 20);

    expect(ctx.strokeRect).toHaveBeenCalled();
    // 8 handles = 8 fillRect calls (plus the strokeRect)
    const fillRectCalls = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls;
    expect(fillRectCalls.length).toBe(8);
  });
});
