// src/gridSerialize.ts
import type { Frame } from "./frame";
import type { ProseSegment } from "./proseSegments";

/** Bounding box in grid coordinates for tracking original frame positions. */
export interface FrameBbox {
  row: number;
  col: number;
  w: number;
  h: number;
  id: string;
}

/**
 * Grid-based serialization. Replaces framesToMarkdown.
 *
 * Phase A: Deep-copy originalGrid, blank original prose positions AND
 *          dirty/deleted frame original positions.
 * Phase B: Write dirty frame cells at their CURRENT positions.
 * Phase C: Write current prose per CM doc line at proseSegmentMap positions.
 * Phase D: Flatten grid to text.
 */
export function gridSerialize(
  frames: Frame[],
  prose: string,
  proseSegmentMap: { row: number; col: number }[],
  originalGrid: string[][],
  charWidth: number,
  charHeight: number,
  originalProseSegments: ProseSegment[],
  originalFrameBboxes?: FrameBbox[],
): string {
  // Phase A — deep-copy grid
  const grid: string[][] = originalGrid.map(row => [...row]);

  // Expand grid if any frame extends beyond original bounds
  for (const f of frames) {
    expandGridForFrame(grid, f, 0, 0, charWidth, charHeight);
  }

  // Blank original prose segment positions (exact positions only)
  for (const seg of originalProseSegments) {
    if (seg.row >= grid.length) continue;
    const chars = [...seg.text];
    for (let c = seg.col; c < seg.col + chars.length && c < grid[seg.row].length; c++) {
      grid[seg.row][c] = " ";
    }
  }

  // Blank original positions of dirty/deleted frames
  if (originalFrameBboxes) {
    // Collect current frame IDs (recursively)
    const currentIds = new Set<string>();
    const collectIds = (fs: Frame[]) => {
      for (const f of fs) { currentIds.add(f.id); collectIds(f.children); }
    };
    collectIds(frames);

    // Collect dirty frame IDs (recursively).
    // When a container is dirty (dragged), ALL its descendants are effectively
    // dirty too — they moved with the container even though their own dirty
    // flag is false. We must blank their original positions.
    const dirtyIds = new Set<string>();
    const collectDirty = (fs: Frame[], ancestorDirty = false) => {
      for (const f of fs) {
        const isDirty = f.dirty || ancestorDirty;
        if (isDirty) dirtyIds.add(f.id);
        collectDirty(f.children, isDirty);
      }
    };
    collectDirty(frames);

    for (const bbox of originalFrameBboxes) {
      // Blank if frame is dirty (moved/resized) or deleted
      if (dirtyIds.has(bbox.id) || !currentIds.has(bbox.id)) {
        for (let r = bbox.row; r < bbox.row + bbox.h && r < grid.length; r++) {
          for (let c = bbox.col; c < bbox.col + bbox.w && c < grid[r].length; c++) {
            grid[r][c] = " ";
          }
        }
      }
    }
  }

  // Phase B — write dirty frame cells at CURRENT positions
  for (const f of frames) {
    writeFrameToGrid(grid, f, 0, 0, charWidth, charHeight);
  }

  // Phase C — write prose.
  // If any frame moved (dirty), reflow prose into rows not occupied by frames.
  // If no frame moved, use original proseSegmentMap positions (preserves round-trip).
  const anyDirty = frames.some(f => f.dirty);

  const proseLines = prose.split("\n");

  if (!anyDirty) {
    // No-edit path: write prose at original positions
    for (let i = 0; i < proseSegmentMap.length && i < proseLines.length; i++) {
      const { row, col } = proseSegmentMap[i];
      const chars = [...proseLines[i]];
      while (grid.length <= row) grid.push([]);
      while (grid[row].length < col + chars.length) grid[row].push(" ");
      for (let c = 0; c < chars.length; c++) {
        grid[row][col + c] = chars[c];
      }
    }
  } else {
    // Dirty path: reflow prose into rows not occupied by frames
    const frameRows = new Set<number>();
    for (const f of frames) {
      const startRow = Math.round(f.y / charHeight);
      const endRow = Math.round((f.y + f.h) / charHeight);
      for (let r = startRow; r < endRow; r++) frameRows.add(r);
    }

    let maxRow = grid.length;
    for (const r of frameRows) if (r >= maxRow) maxRow = r + 1;
    maxRow = Math.max(maxRow, proseLines.length + frameRows.size);

    const availableRows: number[] = [];
    for (let r = 0; r < maxRow; r++) {
      if (!frameRows.has(r)) availableRows.push(r);
    }

    for (let i = 0; i < proseLines.length; i++) {
      if (i >= availableRows.length) availableRows.push(maxRow++);
      const row = availableRows[i];
      const col = proseSegmentMap[i]?.col ?? 0;
      const chars = [...proseLines[i]];
      while (grid.length <= row) grid.push([]);
      while (grid[row].length < col + chars.length) grid[row].push(" ");
      for (let c = 0; c < chars.length; c++) {
        grid[row][col + c] = chars[c];
      }
    }
  }

  // Phase D — flatten
  const lines = grid.map(row => row.join("").trimEnd());
  // Strip trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function rebuildOriginalGrid(text: string): string[][] {
  if (!text) return [];
  return text.split("\n").map(line => [...line]);
}

/** Snapshot frame bounding boxes for next save's dirty/delete detection. */
export function snapshotFrameBboxes(
  frames: Frame[],
  charWidth: number,
  charHeight: number,
): FrameBbox[] {
  const bboxes: FrameBbox[] = [];
  const collect = (fs: Frame[], offX: number, offY: number) => {
    for (const f of fs) {
      const absX = offX + f.x;
      const absY = offY + f.y;
      if (f.content) {
        bboxes.push({
          id: f.id,
          row: Math.round(absY / charHeight),
          col: Math.round(absX / charWidth),
          w: Math.round(f.w / charWidth),
          h: Math.round(f.h / charHeight),
        });
      }
      collect(f.children, absX, absY);
    }
  };
  collect(frames, 0, 0);
  return bboxes;
}

function expandGridForFrame(
  grid: string[][],
  f: Frame,
  offX: number,
  offY: number,
  cw: number,
  ch: number,
): void {
  const endRow = Math.round((offY + f.y + f.h) / ch);
  const endCol = Math.round((offX + f.x + f.w) / cw);
  while (grid.length < endRow) grid.push([]);
  for (const row of grid) {
    while (row.length < endCol) row.push(" ");
  }
  for (const child of f.children) {
    expandGridForFrame(grid, child, offX + f.x, offY + f.y, cw, ch);
  }
}

function writeFrameToGrid(
  grid: string[][],
  f: Frame,
  offX: number,
  offY: number,
  cw: number,
  ch: number,
  ancestorDirty = false,
): void {
  const absX = offX + f.x;
  const absY = offY + f.y;
  // A frame needs rewriting if it's dirty itself OR if an ancestor moved.
  // When a container is dragged, the container is dirty but children are not.
  // Children must still be written at the new position.
  const needsWrite = f.dirty || ancestorDirty;

  if (needsWrite && f.content) {
    // Blank the frame's CURRENT bounding box
    const startRow = Math.round(absY / ch);
    const startCol = Math.round(absX / cw);
    const endRow = Math.round((absY + f.h) / ch);
    const endCol = Math.round((absX + f.w) / cw);
    for (let r = startRow; r < endRow && r < grid.length; r++) {
      for (let c = startCol; c < endCol && c < grid[r].length; c++) {
        grid[r][c] = " ";
      }
    }

    // Write cells at current position
    const gridRow = Math.round(absY / ch);
    const gridCol = Math.round(absX / cw);
    for (const [key, ch_] of f.content.cells) {
      const ci = key.indexOf(",");
      const r = gridRow + Number(key.slice(0, ci));
      const c = gridCol + Number(key.slice(ci + 1));
      if (r >= 0 && r < grid.length && c >= 0 && c < grid[r].length) {
        grid[r][c] = ch_;
      }
    }
  }

  // Recurse into children — propagate dirty state
  for (const child of f.children) {
    writeFrameToGrid(grid, child, absX, absY, cw, ch, needsWrite);
  }
}
