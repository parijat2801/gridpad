/**
 * textFont.ts — Prose text font helpers.
 *
 * Font *strings* now live in ./theme (proseFontMeasure / proseFontRender) so
 * they compose from the live theme at call time. This file owns the async
 * font-load helper used to gate measurement on font availability.
 *
 * Re-exports preserve existing import sites.
 */

import { proseFontMeasure, proseFontRender } from "./theme";

export { proseFontMeasure, proseFontRender };

/** Wait for the prose font (current theme value) to be loaded before measuring.
 * Call before first buildPreparedCache, and again after any prose-font change. */
export async function ensureProseFontReady(): Promise<void> {
  await document.fonts.load(proseFontMeasure());
}
