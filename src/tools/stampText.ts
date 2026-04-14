/** Stamp a string of characters into text at (row, col).
 * Filters to printable single-column characters only.
 * Returns modified text. */
export function stampText(
  text: string, row: number, col: number, buffer: string,
): string {
  const filtered = [...buffer].filter((ch) => {
    const code = ch.codePointAt(0)!;
    return (code >= 32 && code <= 126) || (code >= 0x2500 && code <= 0x257f);
  }).join("");

  if (filtered.length === 0) return text;

  const lines = text.split("\n");
  while (lines.length <= row) lines.push("");
  if (lines[row].length < col + filtered.length) {
    lines[row] = lines[row] + " ".repeat(
      col + filtered.length - lines[row].length
    );
  }
  const arr = [...lines[row]];
  for (let i = 0; i < filtered.length; i++) {
    arr[col + i] = filtered[i];
  }
  lines[row] = arr.join("");
  return lines.join("\n");
}
