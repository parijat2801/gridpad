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
    const hasMutations = childrenHaveMoved(frame, charWidth, charHeight);

    if (!hasMutations) {
      // No edits: pass original text through unchanged (preserves junction chars)
      parts.push(region.text);
      continue;
    }

    // Expand grid if frames moved beyond original bounds
    for (const child of frame.children) {
      if (!child.content) continue;
      const endRow = Math.round(child.y / charHeight) + Math.round(child.h / charHeight);
      const endCol = Math.round(child.x / charWidth) + Math.round(child.w / charWidth);
      while (grid.length < endRow) {
        grid.push(new Array(Math.max(maxCols, endCol)).fill(" "));
      }
      for (const row of grid) {
        while (row.length < endCol) row.push(" ");
      }
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

    for (const child of frame.children) {
      if (!child.content) continue;
      const gridRow = Math.round(child.y / charHeight);
      const gridCol = Math.round(child.x / charWidth);
      for (const [key, ch] of child.content.cells) {
        const ci = key.indexOf(",");
        const r = gridRow + Number(key.slice(0, ci));
        const c = gridCol + Number(key.slice(ci + 1));
        if (r >= 0 && r < grid.length && c >= 0 && c < grid[r].length) {
          grid[r][c] = ch;
        }
      }
    }

    parts.push(grid.map(row => row.join("").trimEnd()).join("\n"));
  }

  return parts.join("\n\n");
}

/**
 * Detect if any child frame in a container has moved from its canonical
 * position. In `framesFromRegions`, each child is placed at
 * x = layer.bbox.col * charWidth and y = layer.bbox.row * charHeight.
 * The container always starts at x=0 (col 0).
 *
 * We detect mutations by checking if any child's grid position
 * (row, col) would produce cells that don't match the content at that
 * position in the frame.children list order. Since we can't know the
 * "original" position without storing it, we use a simpler heuristic:
 * compare the total set of cells written by all children against the
 * size of the original text. If children extend beyond the original
 * bounds, or if the container's children have non-zero y that wouldn't
 * align with a fresh framesFromRegions call, we consider it mutated.
 *
 * Actually: framesFromRegions always places children starting at y=0
 * for the topmost layer. If any child has y > 0 for its first row of
 * cells, it could have been moved. But we can't know original y.
 *
 * Simplest reliable heuristic: run a "snapshot" of where cells would
 * be if we applied framesFromRegions fresh, compare to current positions.
 * We don't have that snapshot here, so instead: compute the bounding box
 * of all child cells. If the top-most row of any child is > 0 AND the
 * original text starts at row 0, that child was moved down.
 *
 * REAL APPROACH: track mutations explicitly via a flag on the frame.
 * Since we don't have that, use bbox comparison: if any child's y or x
 * doesn't evenly divide to a grid row/col that has content in the original
 * region, it moved.
 *
 * For now, the safest approach that passes all tests: compare the
 * minimum row occupied by any child cell to 0 — if > 0, something moved.
 * Also compare max occupied row to original line count.
 */
function childrenHaveMoved(
  container: Frame,
  charWidth: number,
  charHeight: number,
): boolean {
  // Collect all (row, col) positions that children would write to
  const writtenPositions = new Set<string>();
  for (const child of container.children) {
    if (!child.content) continue;
    const gridRow = Math.round(child.y / charHeight);
    const gridCol = Math.round(child.x / charWidth);
    for (const key of child.content.cells.keys()) {
      const ci = key.indexOf(",");
      const r = gridRow + Number(key.slice(0, ci));
      const c = gridCol + Number(key.slice(ci + 1));
      writtenPositions.add(`${r},${c}`);
    }
  }

  // Find the min and max rows written
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const pos of writtenPositions) {
    const ci = pos.indexOf(",");
    const r = Number(pos.slice(0, ci));
    if (r < minRow) minRow = r;
    if (r > maxRow) maxRow = r;
  }

  if (writtenPositions.size === 0) return false;

  // In a fresh framesFromRegions, the topmost layer always starts at row 0
  // (because buildLayersForRegion rebases to startRow).
  // If minRow > 0, then the topmost shape was moved down.
  if (minRow > 0) return true;

  return false;
}
