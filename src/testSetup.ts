/**
 * testSetup.ts — global Vitest setup.
 *
 * Patches HTMLCanvasElement.prototype.getContext so that Pretext's
 * font-measurement code works in jsdom (which provides no real
 * CanvasRenderingContext2D). This is a prototype patch rather than a spy so it
 * doesn't interfere with tests that install their own document.createElement
 * spies (canvasRenderer.test.ts, harness.test.ts).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(HTMLCanvasElement.prototype as any).getContext = function () {
  return {
    font: "",
    fillStyle: "",
    textBaseline: "",
    fillText: () => {},
    measureText: (text: string) => ({
      width: text.length * 9.6,
      actualBoundingBoxAscent: 12,
      actualBoundingBoxDescent: 4,
    }),
  };
};
