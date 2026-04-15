/** Build sparse row draw commands from a composite cell map. */

export interface SparseRow {
  row: number;
  startCol: number;
  text: string;
}

export function buildSparseRows(composite: Map<string, string>): SparseRow[] {
  const byRow = new Map<number, Map<number, string>>();
  for (const [key, ch] of composite) {
    const i = key.indexOf(",");
    const r = Number(key.slice(0, i));
    const c = Number(key.slice(i + 1));
    let cols = byRow.get(r);
    if (!cols) { cols = new Map(); byRow.set(r, cols); }
    cols.set(c, ch);
  }
  const result: SparseRow[] = [];
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const cols = byRow.get(row)!;
    const sorted = [...cols.keys()].sort((a, b) => a - b);
    const startCol = sorted[0];
    const endCol = sorted[sorted.length - 1];
    let text = "";
    for (let c = startCol; c <= endCol; c++) text += cols.get(c) ?? " ";
    result.push({ row, startCol, text });
  }
  return result;
}
