/** Replace characters at specified cells with spaces.
 * Returns modified text. Out-of-bounds cells are ignored. */
export function stampErase(
  text: string, cells: { row: number; col: number }[],
): string {
  if (cells.length === 0) return text;

  const lines = text.split("\n");

  for (const { row, col } of cells) {
    if (row < 0 || row >= lines.length) continue;
    if (col < 0 || col >= lines[row].length) continue;
    const arr = [...lines[row]];
    arr[col] = " ";
    lines[row] = arr.join("");
  }

  return lines.join("\n");
}
