// src/gridSerialize.ts
import type { Frame } from "./frame";
import type { ProseSegment } from "./proseSegments";

// ── Junction repair ────────────────────────────────────────

/** All box-drawing characters we recognize */
const BOX_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼"]);

/** Which chars have a stroke going in each direction */
const DOWN  = new Set([..."│├┤┼┌┐┬"]);
const UP    = new Set([..."│├┤┼└┘┴"]);
const RIGHT = new Set([..."─┌└├┬┴┼"]);
const LEFT  = new Set([..."─┐┘┤┬┴┼"]);

/** Map (up, down, left, right) → junction character */
const JUNCTION_MAP: Record<string, string> = {
  "0100": "╷", // down only — rare, keep original
  "1000": "╵", // up only — rare, keep original
  "0010": "╴", // left only — rare, keep original
  "0001": "╶", // right only — rare, keep original
  "0011": "─",
  "1100": "│",
  "0101": "┌",
  "0110": "┐",
  "1001": "└",
  "1010": "┘",
  "0111": "┬",
  "1011": "┴",
  "1101": "├",
  "1110": "┤",
  "1111": "┼",
};

/** Inherent connection directions of a box-drawing character */
function inherentConnections(ch: string): [boolean, boolean, boolean, boolean] {
  return [UP.has(ch), DOWN.has(ch), LEFT.has(ch), RIGHT.has(ch)];
}

/** Scan the grid for box-drawing characters and upgrade corners to junctions
 * where neighboring cells connect. Mutates grid in place. Never downgrades
 * — a cell's inherent connections are OR'd with neighbor connections. */
export function repairJunctions(grid: string[][]): void {
  const rows = grid.length;
  if (rows === 0) return;

  for (let r = 0; r < rows; r++) {
    const cols = grid[r].length;
    for (let c = 0; c < cols; c++) {
      const ch = grid[r][c];
      if (!BOX_CHARS.has(ch)) continue;

      // Inherent connections of the current character
      const [iUp, iDown, iLeft, iRight] = inherentConnections(ch);

      // OR inherent connections with neighbor connections (never downgrade)
      const hasUp    = iUp    || (r > 0 && c < grid[r - 1].length && DOWN.has(grid[r - 1][c]));
      const hasDown  = iDown  || (r < rows - 1 && c < grid[r + 1].length && UP.has(grid[r + 1][c]));
      const hasLeft  = iLeft  || (c > 0 && RIGHT.has(grid[r][c - 1]));
      const hasRight = iRight || (c < cols - 1 && LEFT.has(grid[r][c + 1]));

      const key = `${hasUp ? 1 : 0}${hasDown ? 1 : 0}${hasLeft ? 1 : 0}${hasRight ? 1 : 0}`;
      const replacement = JUNCTION_MAP[key];
      if (replacement) {
        grid[r][c] = replacement;
      }
      // If no match (e.g., "0000"), keep original character
    }
  }
}

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
    // Dirty propagates both DOWN (ancestor dirty → children dirty) and
    // UP (child dirty → parent dirty). When a child moves inside a parent,
    // the parent's border cells at the child's old position need blanking.
    const dirtyIds = new Set<string>();
    const hasAnyDirtyDesc = (f: Frame): boolean =>
      f.dirty || f.children.some(hasAnyDirtyDesc);
    const collectDirty = (fs: Frame[], ancestorDirty = false) => {
      for (const f of fs) {
        const isDirty = f.dirty || ancestorDirty || hasAnyDirtyDesc(f);
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

  // Phase B.5 — repair junction characters where frame borders meet
  repairJunctions(grid);

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
  // A frame needs rewriting if it's dirty itself, an ancestor moved,
  // OR any descendant is dirty (child move can overwrite parent border cells).
  const hasAnyDirtyDescendant = (fr: Frame): boolean =>
    fr.dirty || fr.children.some(hasAnyDirtyDescendant);
  const needsWrite = f.dirty || ancestorDirty || hasAnyDirtyDescendant(f);

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
