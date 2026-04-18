import type { Frame } from "./frame";
import type { Region } from "./regions";

/**
 * Reconstruct a .md file from the in-memory frame model + prose.
 *
 * KEY DESIGN: Use region.text as the BASE LAYER, then overlay
 * cells from frames on top. This preserves junction characters
 * (├┬┤┴) that exist in the original text but get canonicalized
 * to (┌┐└┘) by regenerateCells in the frame model.
 *
 * For wireframe regions with no mutations: original text passes through.
 * For wireframe regions with mutations: base text + cell overlay.
 * For prose regions: use the prose text directly.
 *
 * MUTATION DETECTION: A frame is "mutated" if any child's x or y
 * differs from what the region's original layout would produce.
 * If no child has moved, we pass `region.text` through unchanged.
 * If any child has moved, we clear all old child cell positions,
 * then write the new positions — preserving junction chars from
 * unaffected areas.
 */
export function framesToMarkdown(
  frames: Frame[],
  prose: { startRow: number; text: string }[],
  regions: Region[],
  charWidth: number,
  charHeight: number,
): string {
  let proseIdx = 0;
  let frameIdx = 0;
  const parts: string[] = [];

  for (const region of regions) {
    if (region.type === "prose") {
      parts.push(prose[proseIdx]?.text ?? region.text);
      proseIdx++;
      continue;
    }

    const frame = frames[frameIdx];
    frameIdx++;
    if (!frame) {
      parts.push(region.text);
      continue;
    }

    // Build original grid from region text
    const origLines = region.text.split("\n");
    const maxCols = Math.max(...origLines.map(l => [...l].length), 0);
    const grid: string[][] = origLines.map(l => {
      const chars = [...l];
      while (chars.length < maxCols) chars.push(" ");
      return chars;
    });

    // Check if any child frame has moved relative to its original position.
    // In framesFromRegions, children get x = layer.bbox.col * cw, y = layer.bbox.row * ch.
    // The container's y encodes region.startRow; children are relative to container origin.
    // We detect mutations by checking if the set of occupied cells differs from original.
    const hasMutations = frame.dirty;

    if (!hasMutations) {
      // No edits: pass original text through unchanged (preserves junction chars)
      parts.push(region.text);
      continue;
    }

    // Expand grid if frames moved beyond original bounds (recursive)
    const expandGrid = (f: Frame, offX: number, offY: number) => {
      const endRow = Math.round(offY / charHeight) + Math.round(f.h / charHeight);
      const endCol = Math.round(offX / charWidth) + Math.round(f.w / charWidth);
      while (grid.length < endRow) {
        grid.push(new Array(Math.max(maxCols, endCol)).fill(" "));
      }
      for (const row of grid) {
        while (row.length < endCol) row.push(" ");
      }
      for (const child of f.children) {
        expandGrid(child, offX + child.x, offY + child.y);
      }
    };
    for (const child of frame.children) {
      expandGrid(child, child.x, child.y);
    }

    // Compute the "original" cell positions from the frame's children
    // by back-calculating where each child would have been originally.
    // We clear those positions, then write the new positions.
    //
    // Strategy: blank the entire grid first, then write all frame cells.
    // This correctly handles moves by not leaving ghost chars.
    for (let r = 0; r < grid.length; r++) {
      grid[r].fill(" ");
    }

    // Recursively write all descendants' cells to the grid.
    // Each child's position is relative to its parent, so we
    // accumulate offsets as we recurse.
    const writeFrameCells = (f: Frame, offsetX: number, offsetY: number) => {
      if (f.content) {
        const gridRow = Math.round(offsetY / charHeight);
        const gridCol = Math.round(offsetX / charWidth);
        for (const [key, ch] of f.content.cells) {
          const ci = key.indexOf(",");
          const r = gridRow + Number(key.slice(0, ci));
          const c = gridCol + Number(key.slice(ci + 1));
          if (r >= 0 && r < grid.length && c >= 0 && c < grid[r].length) {
            grid[r][c] = ch;
          }
        }
      }
      for (const child of f.children) {
        writeFrameCells(child, offsetX + child.x, offsetY + child.y);
      }
    };
    for (const child of frame.children) {
      writeFrameCells(child, child.x, child.y);
    }

    parts.push(grid.map(row => row.join("").trimEnd()).join("\n"));
  }

  // Strip leading/trailing blank lines from each part — detectRegions
  // expands wireframe ranges by ±1 row margin, pulling blank separator
  // lines into the region text. Without stripping, join("\n\n") produces
  // triple newlines.
  const trimmed = parts.map(p => {
    const lines = p.split("\n");
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  });
  return trimmed.join("\n\n");
}

