# Block Model Design & Implementation Plan

## Problem

Wireframes and prose live in separate coordinate systems. Wireframes use `y = gridRow * charHeight` (static). Prose uses Pretext reflow (dynamic). They don't share a unified document flow. Consequences: Enter/Backspace/delete-wireframe/resize cause prose and wireframes to desync.

## Design

### Block model

The document is an ordered list of blocks. Two types:

- **ProseBlock**: one or more lines of text. Owns full canvas width. Reflowed by Pretext.
- **WireframeBlock**: a single top-level Frame (which may have child frames). Owns full canvas width for its row height. `gridCol` determines horizontal offset within that band.

Any text on the same rows as a wireframe is wireframe content (child text frames), never prose. Blank lines are prose content, not a separate `gap` field.

```
blocks: [
  { type: "prose", text: "# My App\n\nSome description..." },
  { type: "wireframe", frame: sidebar },
  { type: "wireframe", frame: mainPanel },
  { type: "prose", text: "Footer notes go here." },
]
```

### Parse-time grouping

`groupIntoContainers` stays. If two wireframes are side by side in the .md file, the scanner + groupIntoContainers wraps them into one container frame. That container becomes one WireframeBlock.

### Unified layout pass (Pretext-interleaved)

Convert blocks to a `LayoutEntry[]` array and feed it to `reflowLayout`. Pretext's `lineTop` accumulator positions everything — prose and wireframes — in one pass.

```ts
type LayoutEntry = PreparedTextWithSegments | null | WireframeBand;

interface WireframeBand {
  type: "wireframe";
  ids: string[];      // frame IDs in this band
  heightPx: number;   // band height in pixels
}
```

Block list -> LayoutEntry[] conversion:
- ProseBlock: prepare each line via Pretext, emit as PreparedTextWithSegments or null (empty lines)
- WireframeBlock: emit a WireframeBand marker with the frame's height

In `reflowLayout`'s main loop:
- Prose entry (PreparedTextWithSegments | null): existing Pretext layoutNextLine logic, advances lineTop
- WireframeBand entry: record Y for all frame IDs, advance lineTop by heightPx

Result includes `wireframeYs: Map<string, number>` and `sourceLineYs: Map<number, number>` alongside the existing `PositionedLine[]`.

Properties:
- `reflowLayout` no longer takes obstacles. Prose gets full width always.
- Wireframe screen Y comes from block position in the entry array, not `gridRow * charHeight`.
- Enter above wireframe -> prose block grows -> all blocks below shift down.
- Delete wireframe -> block removed -> everything below shifts up.
- No `proseSegmentMap` needed — block order is the source of truth.

### Pretext

Stays as the single layout engine. Handles Unicode segmentation, CJK/kinsoku, bidi, subpixel glyph measurement, proportional fonts. Wireframe bands are interleaved into its input so it positions everything in one pass.

### Drag interactions

- Drop on prose area -> reorder in block list (split prose block if needed)
- Drop inside wireframe bounds -> reparent as child
- Drag child out of parent -> becomes new top-level block
- Horizontal drag -> changes `gridCol` only

### Visual distinction

Wireframe bands and prose bands get distinct backgrounds so drop targets are obvious during drag.

### Serialization (block-based)

Walk blocks in order. Prose blocks -> text lines. Wireframe blocks -> write frame cells to a grid region at `gridCol` offset, run junction repair, flatten to text.

Keeps: two-pass compositor (collectFrameCells), junction repair (repairJunctions).
Drops: originalGrid diffing, dirty tracking, originalProseSegments, frameBboxSnapshot, ghost cleanup, framesToProseGaps, reparse-after-save baseline refresh.

Risk: hand-authored ASCII art details that the scanner didn't fully capture into frame.content.cells will be lost on save. The current serializer preserves them via originalGrid overlay. The block serializer regenerates from cells only.

### Round-trip boundary

Markdown text round-trips (serialize -> parse -> serialize produces same output). In-memory state (frame IDs, z-order, hAlign/vAlign, dirty, selection) is ephemeral — regenerated on parse.

### Editing interactions

- Click between wireframe blocks with no prose: auto-create empty prose block
- Delete all text in prose block: collapse it (remove from block list)
- Add new wireframe (R key): insert new wireframe block at cursor position, split prose if needed
- Resize wireframe taller: block claims more rows, everything below pushes down
- Undo/redo: block list stored in EditorState via StateField with invertedEffects snapshot

## What changes

### Goes away entirely
- `carveSlots` in reflowLayout.ts (obstacle slot carving)
- Obstacle parameter in `reflowLayout` signature
- `framesToProseGaps` in gridSerialize.ts
- `originalGrid` diffing pipeline in gridSerialize (Phase A blanking)
- Ghost cleanup (Phase B.6) in gridSerialize
- `originalProseSegmentsField` in editorState.ts
- `proseSegmentMapField` in editorState.ts
- `proseSegments.ts` (replaced by block model)
- `originalGridRef`, `frameBboxSnapshotRef` in DemoV2.tsx
- Reparse-after-save baseline refresh in DemoV2.tsx saveToHandle()
- Enter/Backspace frame-shifting hacks in DemoV2.tsx
- Absolute `gridRow` for top-level frames (position comes from block order)

### Stays (with modifications)
- Pretext for prose line-breaking (no obstacles)
- `gridSerialize` -> rewritten as block-order serializer (~100 lines vs ~400)
- Frame model with children, `gridRow`/`gridCol`/`gridW`/`gridH` for child frames
- Scanner/parser (`scanner.ts` untouched, `scanToFrames.ts` updated to emit block list)
- `groupIntoContainers` in frame.ts (parse-time grouping)
- `moveFrame`/`resizeFrame` (for child frames within parent)
- Two-pass compositor (`collectFrameCells`) for writing frame cells
- Junction repair (`repairJunctions`)
- `preparedCache.ts` (now per-prose-block)
- `cursorFind.ts` (takes block Y offset)

### New
- `blockModel.ts`: Block list type, layout pass, block operations (insert, remove, reorder, split prose)
- `blocksField` in editorState.ts with invertedEffects for undo
- Block-order serializer function
- Drag-to-reparent and drag-to-unparent in DemoV2.tsx
- Visual band distinction in paint()

## Implementation phases

### Phase 1: Block data model + parser (no UI changes yet)
1. Create `src/blockModel.ts` with `ProseBlock`, `WireframeBlock`, `Block` types.
2. Add `buildBlockList(frames, proseSegments)` — takes existing scanToFrames output and produces ordered block list. Pure function, testable.
3. Add `blockSerialize(blocks)` — walks blocks, writes prose lines and frame cells in order. Uses existing `collectFrameCells` and `repairJunctions`. Pure function, testable.
4. Add `blocksToLayoutEntries(blocks, preparedCache)` — converts block list to `LayoutEntry[]` by interleaving prepared prose lines and WireframeBand markers. Pure function.
5. Update `reflowLayout` signature: replace `obstacles` param with `LayoutEntry[]` input. Add `WireframeBand` branch to main loop. Return `wireframeYs` and `sourceLineYs` in result.
6. Write unit tests for all four: buildBlockList, blockSerialize, blocksToLayoutEntries, updated reflowLayout. Test round-trip: parse -> buildBlockList -> blockSerialize -> parse -> compare.
7. Run existing harness/diagnostic tests to verify nothing regressed (no UI wired yet).

### Phase 2: Wire block model into EditorState
1. Add `blocksField` StateField to editorState.ts. Stores Block[].
2. Add block-level effects: `reorderBlockEffect`, `splitProseBlockEffect`, `removeBlockEffect`, `insertBlockEffect`, `reparentFrameEffect`.
3. Add `invertedEffects` for block mutations (snapshot-based, same pattern as frames).
4. Update `createEditorStateFromText` to build block list and store in state.
5. Remove `proseSegmentMapField`, `originalProseSegmentsField`.
6. Unit test undo/redo of block operations.

### Phase 3: Wire into DemoV2 (layout + rendering)
1. Replace `doLayout()`: call `blocksToLayoutEntries()` then `reflowLayout()`.
2. Store `wireframeYsRef` and `sourceLineYsRef` from layout result.
3. Update `paint()` to use `wireframeYsRef` for top-level frame Y.
4. Update hit testing to use `wireframeYsRef`.
5. Update `findCursorLine` to use `sourceLineYs`.
6. Update `proseCursorFromClick` — guard against clicks in wireframe bands.
7. Delete Enter/Backspace frame-shifting hacks.
8. Delete `originalGridRef`, `frameBboxSnapshotRef`.
9. Replace `gridSerialize` call in `saveToHandle` with `blockSerialize`.
10. Delete reparse-after-save baseline refresh.
11. Run full e2e suite, compare before/after.

### Phase 4: Drag reorder + reparent
1. On drag drop on prose area: compute target block index, dispatch `reorderBlockEffect`.
2. On drag drop inside wireframe: dispatch `reparentFrameEffect`.
3. On drag child out of parent: dispatch unparent (remove from parent, insert new block).
4. Visual band distinction during drag (different bg for wireframe vs prose regions).

## Risk mitigation

- Phase 1 is entirely additive — new files, new tests, nothing wired in. Zero regression risk.
- Phase 2 adds state fields but doesn't change UI. Existing tests keep passing.
- Phase 3 is the big switch. Run full e2e suite before and after. Capture before/after screenshots for visual comparison.
- The main regression risk: hand-authored ASCII details lost by block serializer. Mitigation: run harness round-trip tests on all existing fixtures. Any fixture that produces different output after serialize -> parse -> serialize flags a regression.
- Branch: `feature/block-model`. All work happens here. Merge to main only when e2e suite is green.
