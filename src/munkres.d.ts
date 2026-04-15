// Minimal type shim for munkres-js (no bundled types).
// API: computeMunkres(costMatrix) -> Array<[row, col]>
declare module "munkres-js" {
  type CostMatrix = number[][];
  type Assignment = [number, number];
  function computeMunkres(matrix: CostMatrix): Assignment[];
  export default computeMunkres;
}
