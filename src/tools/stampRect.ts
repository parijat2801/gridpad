import type { Bbox } from "../types";

/** Stamp a Unicode light rect's border characters into text.
 * Returns modified text. Only pads affected rows. */
export function stampRect(text: string, bbox: Bbox): string {
  const { row, col, w, h } = bbox;
  if (w < 2 || h < 2) return text;

  const lines = text.split("\n");
  while (lines.length <= row + h - 1) lines.push("");

  const setChar = (r: number, c: number, ch: string) => {
    if (lines[r].length < c + 1) {
      lines[r] = lines[r] + " ".repeat(c + 1 - lines[r].length);
    }
    const arr = [...lines[r]];
    arr[c] = ch;
    lines[r] = arr.join("");
  };

  setChar(row, col, "┌");
  setChar(row, col + w - 1, "┐");
  setChar(row + h - 1, col, "└");
  setChar(row + h - 1, col + w - 1, "┘");
  for (let c = col + 1; c < col + w - 1; c++) {
    setChar(row, c, "─");
    setChar(row + h - 1, c, "─");
  }
  for (let r = row + 1; r < row + h - 1; r++) {
    setChar(r, col, "│");
    setChar(r, col + w - 1, "│");
  }

  return lines.join("\n");
}
