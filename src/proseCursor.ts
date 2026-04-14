export interface CursorPos {
  row: number;
  col: number;
}

export function insertChar(
  text: string,
  cursor: CursorPos,
  ch: string,
): { text: string; cursor: CursorPos } {
  const lines = text.split("\n");
  const line = lines[cursor.row] ?? "";
  const before = line.slice(0, cursor.col);
  const after = line.slice(cursor.col);

  if (ch === "\n") {
    lines.splice(cursor.row, 1, before, after);
    return { text: lines.join("\n"), cursor: { row: cursor.row + 1, col: 0 } };
  }

  lines[cursor.row] = before + ch + after;
  return { text: lines.join("\n"), cursor: { row: cursor.row, col: cursor.col + 1 } };
}

export function deleteChar(
  text: string,
  cursor: CursorPos,
): { text: string; cursor: CursorPos } {
  if (cursor.row === 0 && cursor.col === 0) {
    return { text, cursor };
  }

  const lines = text.split("\n");

  if (cursor.col === 0) {
    const prevLine = lines[cursor.row - 1] ?? "";
    const curLine = lines[cursor.row] ?? "";
    const newCol = prevLine.length;
    lines.splice(cursor.row - 1, 2, prevLine + curLine);
    return { text: lines.join("\n"), cursor: { row: cursor.row - 1, col: newCol } };
  }

  const line = lines[cursor.row] ?? "";
  lines[cursor.row] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
  return { text: lines.join("\n"), cursor: { row: cursor.row, col: cursor.col - 1 } };
}
