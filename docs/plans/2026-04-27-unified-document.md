# Unified Document

## Problem

The current architecture splits the .md file into two parallel data structures at load time: wireframe lines are stripped from the CM doc and stored as Frame objects with absolute gridRow positions, while prose lines go into the CM doc. This creates a coordinate mismatch — prose Y comes from Pretext reflow (dynamic), wireframe Y comes from gridRow * charHeight (static). Every mutation that changes the vertical size of anything requires manual syncing between the two systems.

Note: horizontal text wrapping around wireframes is already dead code. In DemoV2.tsx obstacles are forced to full canvas width. carveSlots in reflowLayout.ts is unused. The transition to full-width wireframe line claims is mathematically identical to what already happens.

## Design

### Open

Scanner runs on the .md file. Identifies wireframe regions (line ranges containing box-drawing characters). Creates Frame objects that claim those line ranges. Frame objects own the wireframe content. The claimed lines in the CM doc are blanked — the Frame is the source of truth for wireframe content.

Scanner only runs on file open. Never during editing.

### Edit

User does whatever they want. Frames are mutable objects — drag, resize, type labels, draw new wireframes. CM doc is mutable prose text — type, Enter, Backspace, arrow keys. No syncing between the two systems. No proseSegmentMap. No gridRow shifting. No frame-shifting hacks.

### Save

Single pass walk over CM doc lines:
1. For each line, check if it's claimed by any Frame(s).
2. If prose: output the line text directly from the CM doc.
3. If wireframe: render the Frame's content as ASCII box-drawing characters at the correct gridCol offset. Multiple side-by-side frames on the same line merge cells by column position.
4. Join with newlines.

No originalGrid. No originalProseSegments. No frameBboxes. No dirty tracking. No multi-phase composition.

### Next open

Scanner runs again on the saved .md. Fresh parse, fresh Frames. The cycle repeats.

## Layout

Pretext lays out all lines top-to-bottom via a lineTop accumulator. We tell it which line ranges are wireframes. For those lines, lineTop advances by the wireframe's height (lineCount * charHeight). For prose lines, Pretext's layoutNextLine handles line-breaking and measurement, lineTop advances by the prose line height.

The wireframe's Y position = lineTop at the point where its line range begins. This Y is derived from the prose above it — all the prose line heights accumulated by Pretext. No absolute gridRow needed.

Pretext measures text without DOM reflow (sub-millisecond). The editorial-engine demo reflows around moving obstacles at 60fps. Layout recomputation on every interaction is cheap.

### How mutations work

- **Enter above wireframe**: inserts a line in the CM doc. More prose above the wireframe. lineTop is higher when we reach the wireframe lines. Wireframe renders lower. Automatic.
- **Backspace above wireframe**: removes a line. Less prose above. lineTop is lower. Wireframe renders higher. Automatic.
- **Delete wireframe**: Frame is removed. Its claimed lines are deleted from the CM doc (or if shared with side-by-side frames, recompute blank line count as max of remaining frame heights). Everything below shifts up. Automatic.
- **Resize wireframe taller**: insert new blank lines into the CM doc at the end of the Frame's range. Frame claims more lines. lineTop advances further. Everything below shifts down. Automatic.
- **Resize wireframe shorter**: remove excess blank lines from the CM doc. Frame claims fewer lines. lineTop advances less. Everything below shifts up. Automatic.
- **Drag wireframe**: visual pixel offset during mouseMove (like today — preview only). On mouseUp, commit: cut the Frame's claimed lines from the CM doc, insert at the new position. lineTop recomputes. Automatic.
- **Drop target**: the layout pass already computed Y for every line via the lineTop accumulator. Pixel Y to CM doc line is a lookup into the layout output — same mechanism as proseCursorFromClick today. No extra work.
- **Window resize / prose reflow**: Pretext relays out prose at new width. Prose may wrap to more or fewer visual lines. lineTop changes. Wireframe Y adjusts. Automatic.
- **Add new wireframe**: insert blank lines into the CM doc at the insertion point. New Frame claims those lines. lineTop advances for them. Everything below shifts down. Automatic.

### Side-by-side wireframes

Two wireframes on the same .md lines (side by side horizontally) work natively. Scanner detects both. Both Frames claim the same line range. They render at the same Y (same lineTop), at different X positions (gridCol). No special handling — falls out of the model naturally because line range claims can overlap.

For unequal heights: the CM doc contains max(height_A, height_B) blank lines. If one frame is deleted, recompute as max of remaining frame heights and adjust blank line count. Not reference counting — just max(remaining).

### Why this works

Every case reduces to: the CM doc changed, so lineTop accumulates differently, so everything renders at the right Y. No special cases. No syncing. One coordinate system — Pretext's lineTop accumulator — positions everything.

### How Pretext fits

Pretext is a text layout engine. It measures text, breaks lines, computes widths — pure math, no DOM. It doesn't detect wireframes — we do (scanner at load time). But Pretext's line-by-line layout gives us Y positions for free via lineTop. We use Pretext's layoutNextLine for prose lines (proper Unicode line-breaking, proportional font measurement). For wireframe lines, we just advance lineTop by the wireframe's height — no Pretext measurement needed for those.

## Frame line claims — CM native

Each Frame stores a CM doc character offset (docOffset) and a line count (lineCount). CodeMirror's position mapping keeps docOffset correct through edits automatically.

```
interface Frame {
  docOffset: number;  // CM character offset — start of first claimed line
  lineCount: number;  // number of lines this frame claims
  gridCol: number;    // horizontal offset for rendering
  // ... content, children, etc remain
}
```

When any CM transaction changes the document, the framesField updater remaps every Frame's docOffset:

```
update(frames, tr) {
  if (tr.docChanged) {
    frames = frames.map(f => ({
      ...f,
      docOffset: tr.changes.mapPos(f.docOffset)
    }));
  }
  // ... process other effects
}
```

To find a Frame's current line range: `state.doc.lineAt(f.docOffset).number - 1` gives the 0-indexed start line.

No gridRow. No proseSegmentMap. No parallel data structures.

## Protecting claimed lines

A CM transactionFilter in editorState.ts rejects any edit that touches lines claimed by a Frame. Inspect the transaction's changed ranges, check if any overlap a Frame's claimed line range, cancel if so.

Claimed line ranges should also use Decoration.replace or atomic ranges so they are not visually selectable or highlightable by mouse drag.

The user can only edit wireframes through Frame operations (drag, resize, label edit, delete), never by typing into their line range.

## Cursor behavior

Arrow keys skip wireframe line ranges. If the cursor tries to enter a line claimed by a Frame, it jumps to the next prose line (down) or previous prose line (up). The Frame's line claim defines the skip zone. Click on a wireframe area = select the Frame, not place a prose cursor.

## Undo/redo

CM's history natively undoes blank line insertions/deletions. The existing invertedEffects pattern snapshots the frames array before frame mutations. The mapPos in framesField.update remaps docOffset through undo transactions the same way it handles regular edits. Frame state and CM doc state revert together.

## Known limitations (future work)

- **Copy/paste**: selecting the whole document and copying gives blank lines where wireframes are. A CM clipboard handler could serialize wireframe content into the clipboard. Not a blocker — address later.
