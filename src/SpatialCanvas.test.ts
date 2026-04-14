import { describe, it, expect, vi } from "vitest";
import { renderProseRegion } from "./SpatialCanvas";

// Mock canvas context for jsdom
function mockCtx() {
  return {
    font: "",
    fillStyle: "",
    textBaseline: "",
    fillText: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    strokeRect: vi.fn(),
    strokeStyle: "",
    lineWidth: 0,
    measureText: (text: string) => ({ width: text.length * 10 }),
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe("renderProseRegion", () => {
  it("draws text lines at correct y positions", () => {
    const ctx = mockCtx();
    const lines = [
      { text: "Hello world", width: 110, start: { segmentIndex: 0, graphemeIndex: 0 }, end: { segmentIndex: 0, graphemeIndex: 11 } },
      { text: "Second line", width: 110, start: { segmentIndex: 0, graphemeIndex: 12 }, end: { segmentIndex: 0, graphemeIndex: 23 } },
    ];
    renderProseRegion(ctx, lines, 0, 20, 0);
    expect(ctx.fillText).toHaveBeenCalledTimes(2);
    expect(ctx.fillText).toHaveBeenCalledWith("Hello world", 0, 0);
    expect(ctx.fillText).toHaveBeenCalledWith("Second line", 0, 20);
  });

  it("applies scrollY offset", () => {
    const ctx = mockCtx();
    const lines = [
      { text: "Line 1", width: 60, start: { segmentIndex: 0, graphemeIndex: 0 }, end: { segmentIndex: 0, graphemeIndex: 6 } },
    ];
    renderProseRegion(ctx, lines, 0, 20, 50);
    expect(ctx.fillText).toHaveBeenCalledWith("Line 1", 0, -50);
  });

  it("applies regionY offset", () => {
    const ctx = mockCtx();
    const lines = [
      { text: "Line 1", width: 60, start: { segmentIndex: 0, graphemeIndex: 0 }, end: { segmentIndex: 0, graphemeIndex: 6 } },
    ];
    renderProseRegion(ctx, lines, 100, 20, 0);
    expect(ctx.fillText).toHaveBeenCalledWith("Line 1", 0, 100);
  });
});
