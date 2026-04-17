/**
 * textFont.ts — Prose text font constants.
 * Separate from grid.ts which owns monospace cell measurement for wireframes.
 */

/** Font string for Pretext measurement — bare Inter, no fallback stack.
 * Pretext warns that system-ui is unsafe for layout accuracy on macOS. */
export const PROSE_FONT_MEASURE = "16px Inter";

/** Font string for canvas ctx.font — includes fallback for missing glyphs. */
export const PROSE_FONT_RENDER = "16px Inter, sans-serif";

/** Line height for prose text in pixels. Inter at 16px reads best at ~22px. */
export const PROSE_LINE_HEIGHT = 22;

/** Wait for Inter to be loaded before measuring text.
 * Call once before first buildPreparedCache. */
export async function ensureProseFontReady(): Promise<void> {
  await document.fonts.load(PROSE_FONT_MEASURE);
}
