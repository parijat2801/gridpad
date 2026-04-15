// Scanner: takes flat ASCII text with Unicode box-drawing characters and
// detects rectangles, lines, and text labels.
//
// Algorithm (corner-seed tracing, ported from ascii-graphs BoxParser):
//   1. Parse text into a 2D char array.
//   2. For each top-left corner (┌), trace right → down → left → up, verify
//      closure, and emit a rectangle. Mark all boundary cells as "claimed".
//   3. From unclaimed structural characters, extract line runs.
//   4. From unclaimed printable characters, extract text labels.
//   5. Any remaining characters go into unclaimedCells (graceful fallback).
//
// Shared walls Just Work: each rectangle is traced independently from its
// corner. A ┬ character is a valid top edge for both the left box (as ─) and
// the right box (as ┌ — well, actually as top edge). We allow corners to
// overlap — boundary claiming is inclusive.

export interface ScannedRect {
  row: number;
  col: number;
  w: number;
  h: number;
}

export interface ScannedLine {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface ScannedText {
  row: number;
  col: number;
  content: string;
}

export interface ScanResult {
  rects: ScannedRect[];
  lines: ScannedLine[];
  texts: ScannedText[];
  unclaimedCells: Map<string, string>;
  /** The parsed source grid. Layer construction reads the user's literal
   * characters from here — the scanner never canonicalizes characters. */
  grid: string[][];
}

export interface RectStyle {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

// Character classification
//
// T-junctions and crosses are valid corners for adjacent boxes sharing walls:
//   ┬ is TR for the left box AND TL for the right box
//   ┴ is BR for the left box AND BL for the right box
//   ├ is BL for the top box AND TL for the bottom box
//   ┤ is BR for the top box AND TR for the bottom box
//   ┼ is all four
// Each corner set is the union of its primary character and the T-junctions
// that can play that role.
const TL_CORNERS = new Set(["┌", "╭", "╔", "+", "┬", "├", "┼"]);
const TR_CORNERS = new Set(["┐", "╮", "╗", "+", "┬", "┤", "┼"]);
const BL_CORNERS = new Set(["└", "╰", "╚", "+", "┴", "├", "┼"]);
const BR_CORNERS = new Set(["┘", "╯", "╝", "+", "┴", "┤", "┼"]);


const H_EDGE = new Set(["─", "━", "═", "┬", "┴", "┼", "╤", "╧", "╪", "-", "▼", "▲"]);
const V_EDGE = new Set(["│", "║", "├", "┤", "┼", "╟", "╢", "╫", "|", "►", "◄"]);

// For line detection (stricter than edge — excludes corners)
const H_LINE_CHAR = new Set(["─", "━", "═", "-"]);
const V_LINE_CHAR = new Set(["│", "║", "|"]);

function isTL(ch: string): boolean {
  return TL_CORNERS.has(ch);
}
function isTR(ch: string): boolean {
  return TR_CORNERS.has(ch);
}
function isBL(ch: string): boolean {
  return BL_CORNERS.has(ch);
}
function isBR(ch: string): boolean {
  return BR_CORNERS.has(ch);
}
function isHEdge(ch: string): boolean {
  return H_EDGE.has(ch);
}
function isVEdge(ch: string): boolean {
  return V_EDGE.has(ch);
}

function key(row: number, col: number): string {
  return `${row},${col}`;
}

function parseGrid(text: string): string[][] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  return lines.map((line) => [...line]);
}

function getCell(grid: string[][], row: number, col: number): string {
  if (row < 0 || row >= grid.length) return " ";
  const r = grid[row];
  if (col < 0 || col >= r.length) return " ";
  return r[col];
}

// Trace right from (row, startCol+1) along horizontal edge characters until we
// hit a top-right corner. Returns the column of the TR corner, or -1 if the
// run breaks before finding one.
function traceRight(grid: string[][], row: number, startCol: number): number {
  const width = grid[row]?.length ?? 0;
  for (let c = startCol + 1; c < width; c++) {
    const ch = getCell(grid, row, c);
    if (isTR(ch)) return c;
    if (!isHEdge(ch)) return -1;
  }
  return -1;
}

// Trace down from (startRow+1, col) along vertical edge characters until we
// hit any bottom corner. Returns the row of the bottom corner, or -1 if break.
function traceDown(
  grid: string[][],
  startRow: number,
  col: number,
  expectCorner: (ch: string) => boolean,
): number {
  for (let r = startRow + 1; r < grid.length; r++) {
    const ch = getCell(grid, r, col);
    if (expectCorner(ch)) return r;
    if (!isVEdge(ch)) return -1;
  }
  return -1;
}

// Verify the bottom edge from (row, startCol) to (row, endCol) is all
// horizontal edge characters (plus BL at start and BR at end).
function verifyBottomEdge(
  grid: string[][],
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  if (!isBL(getCell(grid, row, startCol))) return false;
  if (!isBR(getCell(grid, row, endCol))) return false;
  for (let c = startCol + 1; c < endCol; c++) {
    if (!isHEdge(getCell(grid, row, c))) return false;
  }
  return true;
}

function detectRectangles(
  grid: string[][],
): { rects: ScannedRect[]; claimed: Set<string> } {
  const rects: ScannedRect[] = [];
  const claimed = new Set<string>();

  // Dedup by (row,col,w,h) key since T-junction traces may produce the same
  // rectangle from multiple starting points.
  const seen = new Set<string>();

  for (let row = 0; row < grid.length; row++) {
    const width = grid[row].length;
    for (let col = 0; col < width; col++) {
      const ch = getCell(grid, row, col);
      if (!isTL(ch)) continue;

      // Must have a horizontal edge or corner to the right and vertical
      // edge below for this to be a rectangle corner.
      const right = getCell(grid, row, col + 1);
      const below = getCell(grid, row + 1, col);
      if (!isHEdge(right) && !isTR(right)) continue;
      if (!isVEdge(below) && !isBL(below)) continue;

      // Trace right to find TR corner
      const trCol = traceRight(grid, row, col);
      if (trCol < 0) continue;

      // Trace down the left edge to find BL corner
      const blRow = traceDown(grid, row, col, isBL);
      if (blRow < 0) continue;

      // Trace down the right edge to find BR corner (should be same row as BL)
      const brRow = traceDown(grid, row, trCol, isBR);
      if (brRow !== blRow) continue;

      // Verify the bottom edge
      if (!verifyBottomEdge(grid, blRow, col, trCol)) continue;

      // Rectangle confirmed — record it (dedup)
      const w = trCol - col + 1;
      const h = blRow - row + 1;
      const sig = `${row},${col},${w},${h}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      rects.push({ row, col, w, h });

      // Mark boundary cells as claimed
      for (let c = col; c <= trCol; c++) {
        claimed.add(key(row, c));
        claimed.add(key(blRow, c));
      }
      for (let r = row; r <= blRow; r++) {
        claimed.add(key(r, col));
        claimed.add(key(r, trCol));
      }
    }
  }

  return { rects, claimed };
}

function detectLines(
  grid: string[][],
  claimed: Set<string>,
): { lines: ScannedLine[]; lineClaimed: Set<string> } {
  const lines: ScannedLine[] = [];
  const lineClaimed = new Set<string>();

  // Horizontal lines: scan each row for runs of H_LINE_CHAR not claimed by
  // rects. ONLY multi-cell runs are promoted to line shapes — single isolated
  // characters fall through to unclaimedCells so they remain authoritative
  // user characters with no reinterpretation.
  for (let row = 0; row < grid.length; row++) {
    const width = grid[row].length;
    let runStart = -1;
    for (let col = 0; col <= width; col++) {
      const ch = col < width ? getCell(grid, row, col) : " ";
      const isLine =
        col < width && H_LINE_CHAR.has(ch) && !claimed.has(key(row, col));
      if (isLine) {
        if (runStart < 0) runStart = col;
      } else {
        if (runStart >= 0 && col - 1 > runStart) {
          // Multi-cell run only
          lines.push({ r1: row, c1: runStart, r2: row, c2: col - 1 });
          for (let c = runStart; c < col; c++) {
            lineClaimed.add(key(row, c));
          }
        }
        runStart = -1;
      }
    }
  }

  // Vertical lines: same rule — only multi-cell runs become line shapes.
  const height = grid.length;
  const maxWidth = grid.reduce((m, r) => Math.max(m, r.length), 0);
  for (let col = 0; col < maxWidth; col++) {
    let runStart = -1;
    for (let row = 0; row <= height; row++) {
      const ch = row < height ? getCell(grid, row, col) : " ";
      const isLine =
        row < height &&
        V_LINE_CHAR.has(ch) &&
        !claimed.has(key(row, col)) &&
        !lineClaimed.has(key(row, col));
      if (isLine) {
        if (runStart < 0) runStart = row;
      } else {
        if (runStart >= 0 && row - 1 > runStart) {
          lines.push({ r1: runStart, c1: col, r2: row - 1, c2: col });
          for (let r = runStart; r < row; r++) {
            lineClaimed.add(key(r, col));
          }
        }
        runStart = -1;
      }
    }
  }

  return { lines, lineClaimed };
}

function detectTexts(
  grid: string[][],
  claimed: Set<string>,
  lineClaimed: Set<string>,
): { texts: ScannedText[]; textClaimed: Set<string> } {
  const texts: ScannedText[] = [];
  const textClaimed = new Set<string>();

  for (let row = 0; row < grid.length; row++) {
    const width = grid[row].length;
    let runStart = -1;
    let runContent = "";
    for (let col = 0; col <= width; col++) {
      const ch = col < width ? getCell(grid, row, col) : " ";
      const k = key(row, col);
      const isClaimed = claimed.has(k) || lineClaimed.has(k);
      const isText =
        col < width && ch !== " " && ch !== "" && !isClaimed;

      if (isText) {
        if (runStart < 0) {
          runStart = col;
          runContent = ch;
        } else {
          runContent += ch;
        }
      } else {
        if (runStart >= 0) {
          texts.push({ row, col: runStart, content: runContent });
          for (let c = runStart; c < runStart + runContent.length; c++) {
            textClaimed.add(key(row, c));
          }
          runStart = -1;
          runContent = "";
        }
      }
    }
  }

  return { texts, textClaimed };
}

function canonicalizeCorner(ch: string, position: "tl" | "tr" | "bl" | "br"): string {
  switch (ch) {
    case "┬":
      if (position === "tl") return "┌";
      if (position === "tr") return "┐";
      return ch;
    case "┴":
      if (position === "bl") return "└";
      if (position === "br") return "┘";
      return ch;
    case "├":
      if (position === "tl") return "┌";
      if (position === "bl") return "└";
      return ch;
    case "┤":
      if (position === "tr") return "┐";
      if (position === "br") return "┘";
      return ch;
    case "┼":
      if (position === "tl") return "┌";
      if (position === "tr") return "┐";
      if (position === "bl") return "└";
      if (position === "br") return "┘";
      return ch;
    default:
      return ch;
  }
}

const H_COLLAPSE = new Set(["─", "━", "═", "-", "┬", "┴", "┼", "╤", "╧", "╪"]);
const V_COLLAPSE = new Set(["│", "║", "|", "├", "┤", "┼", "╟", "╢", "╫"]);

function canonicalizeEdgeChar(ch: string, role: "h" | "v"): string {
  if (role === "h" && H_COLLAPSE.has(ch)) return "─";
  if (role === "v" && V_COLLAPSE.has(ch)) return "│";
  return ch;
}

function vote(chars: string[], fallback: string): string {
  if (chars.length === 0) return fallback;
  const counts = new Map<string, { count: number; firstIdx: number }>();
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const existing = counts.get(ch);
    if (existing) {
      existing.count++;
    } else {
      counts.set(ch, { count: 1, firstIdx: i });
    }
  }
  let winner = fallback;
  let bestCount = -1;
  let bestIdx = Infinity;
  for (const [ch, { count, firstIdx }] of counts) {
    if (count > bestCount || (count === bestCount && firstIdx < bestIdx)) {
      winner = ch;
      bestCount = count;
      bestIdx = firstIdx;
    }
  }
  return winner;
}

export function extractRectStyle(grid: string[][], rect: ScannedRect): RectStyle {
  const { row, col, w, h } = rect;

  // Step 1: Read corner characters
  const tlChar = getCell(grid, row, col);
  const trChar = getCell(grid, row, col + w - 1);
  const blChar = getCell(grid, row + h - 1, col);
  const brChar = getCell(grid, row + h - 1, col + w - 1);

  // Step 2: Canonicalize corners
  const tl = canonicalizeCorner(tlChar, "tl");
  const tr = canonicalizeCorner(trChar, "tr");
  const bl = canonicalizeCorner(blChar, "bl");
  const br = canonicalizeCorner(brChar, "br");

  // Step 3: ASCII family special case — all four canonicalized corners are "+"
  if (tl === "+" && tr === "+" && bl === "+" && br === "+") {
    return { tl, tr, bl, br, h: "-", v: "|" };
  }

  // Step 4–5: Vote on h (horizontal edge)
  const hChars: string[] = [];
  // Top edge interior
  for (let c = col + 1; c <= col + w - 2; c++) {
    hChars.push(canonicalizeEdgeChar(getCell(grid, row, c), "h"));
  }
  // Bottom edge interior
  for (let c = col + 1; c <= col + w - 2; c++) {
    hChars.push(canonicalizeEdgeChar(getCell(grid, row + h - 1, c), "h"));
  }
  const hEdge = vote(hChars, "─");

  // Step 6: Vote on v (vertical edge)
  const vChars: string[] = [];
  // Left edge interior
  for (let r = row + 1; r <= row + h - 2; r++) {
    vChars.push(canonicalizeEdgeChar(getCell(grid, r, col), "v"));
  }
  // Right edge interior
  for (let r = row + 1; r <= row + h - 2; r++) {
    vChars.push(canonicalizeEdgeChar(getCell(grid, r, col + w - 1), "v"));
  }
  const vEdge = vote(vChars, "│");

  // Step 7: Return
  return { tl, tr, bl, br, h: hEdge, v: vEdge };
}

export function scan(text: string): ScanResult {
  const grid = parseGrid(text);
  if (grid.length === 0) {
    return {
      rects: [],
      lines: [],
      texts: [],
      unclaimedCells: new Map(),
      grid,
    };
  }

  const { rects, claimed } = detectRectangles(grid);
  const { lines, lineClaimed } = detectLines(grid, claimed);
  const { texts, textClaimed } = detectTexts(grid, claimed, lineClaimed);

  // Collect unclaimed cells — literal characters the user typed that aren't
  // part of any detected shape. These stay verbatim in the base layer.
  const unclaimedCells = new Map<string, string>();
  for (let row = 0; row < grid.length; row++) {
    const width = grid[row].length;
    for (let col = 0; col < width; col++) {
      const ch = getCell(grid, row, col);
      if (ch === " " || ch === "") continue;
      const k = key(row, col);
      if (claimed.has(k) || lineClaimed.has(k) || textClaimed.has(k)) continue;
      unclaimedCells.set(k, ch);
    }
  }

  return { rects, lines, texts, unclaimedCells, grid };
}
