/** Stamp a horizontal or vertical line into text.
 * Constrains to dominant axis. Returns modified text.
 * Minimum length: 2 cells. */
export function stampLine(
  text: string, r1: number, c1: number, r2: number, c2: number,
): string {
  const dRow = Math.abs(r2 - r1);
  const dCol = Math.abs(c2 - c1);
  const isH = dCol >= dRow;

  let startR: number, startC: number, endR: number, endC: number;
  if (isH) {
    startR = r1; endR = r1;
    startC = Math.min(c1, c2); endC = Math.max(c1, c2);
  } else {
    startC = c1; endC = c1;
    startR = Math.min(r1, r2); endR = Math.max(r1, r2);
  }

  const length = isH ? (endC - startC + 1) : (endR - startR + 1);
  if (length < 2) return text;

  const lines = text.split("\n");
  while (lines.length <= endR) lines.push("");

  const setChar = (r: number, c: number, ch: string) => {
    if (lines[r].length < c + 1) {
      lines[r] = lines[r] + " ".repeat(c + 1 - lines[r].length);
    }
    const arr = [...lines[r]];
    arr[c] = ch;
    lines[r] = arr.join("");
  };

  if (isH) {
    for (let c = startC; c <= endC; c++) setChar(startR, c, "─");
  } else {
    for (let r = startR; r <= endR; r++) setChar(r, startC, "│");
  }

  return lines.join("\n");
}
