// src/serialize.ts
// Reconstruct a markdown document from CM editor state.
// Prose regions are taken from the live CM doc (via rebuildProseParts).
// Wireframe regions retain their original scanned text.

import type { Frame } from "./frame";
import type { Region } from "./regions";
import type { ProsePart } from "./editorState";

/**
 * Reconstruct the full document string from the current editor state.
 *
 * @param _frames  - Frame array (reserved for future pixel→ASCII export).
 * @param proseParts - Updated prose parts from rebuildProseParts().
 * @param regions  - Original regions from getRegions() — used to reconstruct
 *                   wireframe text in document order.
 * @param _cw      - Char width in pixels (reserved for future use).
 * @param _ch      - Char height in pixels (reserved for future use).
 */
export function framesToMarkdown(
  _frames: Frame[],
  proseParts: ProsePart[],
  regions: Region[],
  _cw: number,
  _ch: number,
): string {
  if (regions.length === 0) {
    // No regions — fall back to raw prose parts joined by blank lines.
    return proseParts.map((p) => p.text).join("\n\n");
  }

  const parts: string[] = [];
  let proseIndex = 0;

  for (const region of regions) {
    if (region.type === "prose") {
      // Use updated prose from CM state if available, else fall back to original.
      const part = proseParts[proseIndex];
      parts.push(part !== undefined ? part.text : region.text);
      proseIndex++;
    } else {
      // Wireframe region — keep original scanned text unchanged.
      parts.push(region.text);
    }
  }

  return parts.join("\n");
}
