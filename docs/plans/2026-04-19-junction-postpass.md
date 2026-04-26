# Junction Post-Pass — Repair Box-Drawing Junctions After Serialization

**Goal:** After gridSerialize writes all frame cells to the grid (Phase B), scan the grid for adjacent box-drawing characters and upgrade simple corners to junction characters where borders meet.

## The Problem

`regenerateCells` produces only canonical corners (┌┐└┘) and edges (─│). When two frames share a wall, the junction chars (┬├┼┤┴) that should appear at the intersection are lost. This affects:
- Existing junctions after drag (┬ → ┌)
- New junctions created by dragging frames together

## Design

**Phase B.5 — Junction repair post-pass.** After Phase B writes all dirty frame cells, scan every cell in the grid. For each box-drawing character, check its 4 neighbors (up/down/left/right). If the neighbor pattern indicates a junction, upgrade the character.

The rules are based on which directions have connecting edges:

| Has Up | Has Down | Has Left | Has Right | Result |
|--------|----------|----------|-----------|--------|
| no     | yes      | no       | yes       | ┌      |
| no     | yes      | yes      | no        | ┐      |
| yes    | no       | no       | yes       | └      |
| yes    | no       | yes      | no        | ┘      |
| no     | yes      | yes      | yes       | ┬      |
| yes    | no       | yes      | yes       | ┴      |
| yes    | yes      | no       | yes       | ├      |
| yes    | yes      | yes      | no        | ┤      |
| yes    | yes      | yes      | yes       | ┼      |
| no     | no       | yes      | yes       | ─      |
| yes    | yes      | no       | no        | │      |

"Has Up" means the cell above contains a vertical connector (│├┤┼┌┐└┘┬┴) or the cell itself is on the bottom edge of its box. In practice: check if the neighbor cell is a box-drawing char that connects in this direction.

**Connector sets:**
- Connects downward: `│├┤┼┌┐┬` (has a vertical line going down)
- Connects upward: `│├┤┼└┘┴` (has a vertical line going up)
- Connects right: `─┌└├┬┴┼` (has a horizontal line going right)
- Connects left: `─┐┘┤┬┴┼` (has a horizontal line going left)

**Scope:** Only modify cells that are already box-drawing characters. Don't touch spaces or text. Only upgrade corners/edges to junctions — never downgrade.

## Tasks

### Task 1: `repairJunctions` function in gridSerialize.ts

Add `repairJunctions(grid: string[][])` — mutates the grid in place. Called between Phase B and Phase C.

**Test cases:**
- Two rects sharing a vertical wall: `┐┌` on same row → `┤├` or `┐┌` stays (depends on direction)
- Actually: the right edge of left rect is `┐`, left edge of right rect is `┌`. If they're adjacent (`┐┌` at cols 5,6), each has connections from both sides → `┐` becomes `┤` (up+down+left), `┌` becomes `├` (up+down+right). Wait — `┐` has up+left, `┌` has down+right. When adjacent, `┐` at col 5 now also has a right neighbor (the `┌` at col 6 connects left). So `┐` has up+left+right → `┬`. And `┌` has down+right+left neighbor above... This needs careful thought.

Let me simplify: for each cell that IS a box-drawing char, look at all 4 neighbors. A neighbor "connects" to this cell if the neighbor is a box-drawing char that has an edge pointing toward this cell.

```
For cell at (r,c):
  up    = cell(r-1,c) connects downward?
  down  = cell(r+1,c) connects upward?
  left  = cell(r,c-1) connects rightward?
  right = cell(r,c+1) connects leftward?
```

Then pick the junction char from the truth table.

### Task 2: Integration — call repairJunctions between Phase B and Phase C

One line: `repairJunctions(grid);` after the Phase B loop.

### Task 3: Update the child-ghost orphan `│`

The orphaned `│` from child frame operations should also be handled. If a `│` has no vertical neighbors (no connector above or below), it should be left alone (it might be prose). But if it's surrounded by spaces on all sides except one, it's an orphan that should be blanked. Actually — the junction post-pass won't fix orphaned `│` because it only upgrades, never removes. The orphan fix is separate.

For now, focus on Tasks 1-2. The orphan `│` issue may resolve itself once parents are properly blanked.

| File | Changes |
|------|---------|
| `src/gridSerialize.ts` | Add `repairJunctions()`, call between Phase B and Phase C |
| `src/gridSerialize.test.ts` or `src/roundtrip.test.ts` | Unit tests for repairJunctions |
