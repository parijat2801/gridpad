# Inline Wireframe Layout

## Problem

Wireframe Y is computed as `gridRow * charHeight` (absolute). Prose Y comes from Pretext reflow. They don't share a layout pass, so Enter/Backspace/delete-wireframe cause prose and wireframes to desync.

## Approach

Make `reflowLayout` position both prose and wireframes in one pass. Instead of passing wireframes as external obstacles with absolute Y, interleave merged wireframe bands into the layout input array at their document-order position. When the layout loop hits a wireframe band marker, it advances `lineTop` by the band's pixel height. Prose before the band ends up above it; prose after ends up below it. No obstacles needed.

## Changes

### 1. New types and updated signature in reflowLayout.ts

```ts
export interface WireframeBand {
  type: "wireframe";
  ids: string[];       // all frame IDs in this merged band
  heightPx: number;    // max(bottom) - min(top) of merged band
}

export type LayoutEntry = PreparedTextWithSegments | null | WireframeBand;
```

Change `reflowLayout` signature — remove `obstacles` parameter:
```ts
export function reflowLayout(
  entries: LayoutEntry[],
  canvasWidth: number,
  lineHeight: number,
): ReflowResult
```

Updated result — add wireframe Y positions and per-source-line Y map:
```ts
export interface ReflowResult {
  lines: PositionedLine[];
  wireframeYs: Map<string, number>;  // frame id -> screen Y
  sourceLineYs: Map<number, number>; // CM source line index -> Y position
  totalHeight: number;
}
```

In the main loop, three branches:

```ts
for (let i = 0; i < entries.length; i++) {
  const entry = entries[i];

  if (isWireframeBand(entry)) {
    // Record Y for all frames in this band
    for (const id of entry.ids) {
      wireframeYs.set(id, lineTop);
    }
    lineTop += entry.heightPx;
    continue;
  }

  // Record source line Y before any wrapping
  sourceLineYs.set(proseLineIndex, lineTop);

  if (entry === null) {
    // Empty prose line — just advance
    lineTop += lineHeight;
    proseLineIndex++;
    continue;
  }

  // ... existing Pretext layoutNextLine logic, unchanged ...
  proseLineIndex++;
}
```

Note: `proseLineIndex` tracks the CM doc line number, incrementing only for prose entries (not wireframe bands). This is what `sourceLine` in `PositionedLine` refers to.

Delete: `obstacles` parameter, obstacle-skipping loops (lines 98-106, 114-124), `carveSlots` function, `Obstacle` interface.

### 2. Build interleaved entries in DemoV2.tsx doLayout()

Replace the current `doLayout` (lines 253-269).

New `doLayout`:
1. Get prose prepared lines from `preparedRef.current`.
2. Get frames from `framesRef.current`.
3. Get `proseSegmentMap` — maps CM doc line index to original grid `{row, col}`.
4. Merge overlapping/adjacent frame row ranges into bands (same logic as current doLayout lines 256-266, but outputting `WireframeBand` objects with frame IDs and merged height).
5. Interleave: walk CM doc lines in order. For each doc line, check its `proseSegmentMap[i].row`. Before emitting the prose entry, emit any wireframe bands whose row range starts at or before this prose line's grid row. After all prose lines, emit any remaining wireframe bands.
6. Handle edge cases:
   - Wireframe bands before first prose line: emit bands first.
   - Wireframe bands after last prose line: append bands at end.
   - All wireframes, no prose: entries array is only bands.
   - All prose, no wireframes: entries array is only prose (same as before).
   - Empty document: return early (no entries).
7. Call `reflowLayout(entries, canvasWidth, lineHeight)`.
8. Store `wireframeYs` in `wireframeYsRef.current` (new ref, `Map<string, number>`).
9. Store `sourceLineYs` in `sourceLineYsRef.current` (new ref, `Map<number, number>`).

Important: do NOT mutate `frame.y` on EditorState-owned objects. `wireframeYsRef` is a separate derived-layout ref, like `linesRef`.

### 3. Update paint() to use wireframeYsRef

Currently `paint()` renders frames at `frame.y` (which is `gridRow * charHeight`). Change frame rendering to use `wireframeYsRef.current.get(frame.id)` for the Y position of top-level frames. Child frame Y is relative to parent, so only top-level Y changes.

For frames not in the map (shouldn't happen, but defensive): fall back to `frame.y`.

### 4. Update hit testing to use wireframeYsRef

`hitTestFrames` uses `frame.x/y` for bounds. The click handler in DemoV2 needs to use `wireframeYsRef` for top-level frame Y when computing hit test bounds. Two options:

**Option A**: Before hit testing, build a temporary array of frames with adjusted Y from `wireframeYsRef`. Immutable — doesn't mutate state objects.

**Option B**: Pass `wireframeYsRef` to hit test and offset there.

Recommend A — simpler, hit testing is not perf-critical.

### 5. Update findCursorLine to use sourceLineYs

Currently `findCursorLine` (cursorFind.ts) has a fallback for empty lines that computes Y as `lastLineBefore.y + lineHeight * (cursor.row - lastLineBefore.sourceLine)`. This doesn't account for wireframe bands between the last rendered prose line and the cursor position.

Change: pass `sourceLineYs: Map<number, number>` as an additional parameter. In the empty-line fallback, look up `sourceLineYs.get(cursor.row)` instead of computing from `lastLineBefore`. In the empty-document fallback, use `sourceLineYs.get(cursor.row) ?? cursor.row * lineHeight`.

```ts
export function findCursorLine(
  cursor: { row: number; col: number },
  lines: PositionedLine[],
  measureWidth: (text: string) => number,
  lineHeight: number,
  sourceLineYs?: Map<number, number>,
): CursorLineResult {
  // ... existing targetLine logic unchanged ...

  } else if (sourceLineYs?.has(cursor.row)) {
    return { x: 0, y: sourceLineYs.get(cursor.row)! };
  } else if (lastLineBefore) {
    // Original fallback
    return {
      x: 0,
      y: lastLineBefore.y + lineHeight * (cursor.row - lastLineBefore.sourceLine),
    };
  }
  return { x: 0, y: sourceLineYs?.get(cursor.row) ?? cursor.row * lineHeight };
}
```

### 6. Delete Enter/Backspace frame-shifting hacks in DemoV2.tsx

Delete the loops in the Enter handler (lines 1053-1064) and Backspace handler (lines 1025-1036) that manually shift frame `gridRow` by +/-1 via `moveFrameEffect`. The layout pass now positions wireframes from document order — when a prose line is added or removed, `doLayout()` recomputes and wireframes move automatically.

Also delete `proseSegmentMap` updates in those handlers if they are only used for the frame-shifting calculation. (Verify: `proseSegmentMap` is also used in serialization via `gridSerialize` — if so, keep the field but remove the frame-shifting usage.)

### 7. Update proseCursorFromClick to use sourceLineYs

`proseCursorFromClick` (DemoV2.tsx:381) finds the closest rendered prose line to a click. After the change, prose line Y positions already account for wireframe bands, so the existing nearest-line logic should work. However, clicking in a wireframe band (no prose lines there) should not create a prose cursor — add a guard: if the click Y falls within a wireframe band (check `wireframeYsRef`), return null.

### 8. Update tests

- `reflowLayout.test.ts`: update all tests to use new signature (no `obstacles` param, `LayoutEntry[]` instead of `PreparedTextWithSegments[]`). Add tests:
  - WireframeBand at start of entries (before prose)
  - WireframeBand between prose lines
  - WireframeBand at end of entries (after prose)
  - Multiple merged bands
  - All-wireframe document (no prose entries)
  - Empty document
  - Verify `wireframeYs` and `sourceLineYs` in results
- `cursorFind.test.ts`: add tests with `sourceLineYs` parameter for cursor positioning after wireframe bands.
- `harness.test.ts` / `diagnostic.test.ts`: serialization round-trip tests should be unaffected (serialization untouched).
- e2e: existing tests should pass — visual behavior is the same or better.

## What this does NOT change

- Serialization (`gridSerialize.ts`) — untouched. `gridRow`/`gridCol` remain canonical for serialization. `framesToProseGaps` still used.
- Scanner/parser (`scanToFrames.ts`, `scanner.ts`) — untouched.
- EditorState (`editorState.ts`) — untouched. Frames still stored with `gridRow`/`gridCol`.
- Frame model (`frame.ts`) — untouched. `moveFrame`/`resizeFrame` still operate on `gridRow`/`gridCol`.
- `proseSegments.ts`, `preparedCache.ts` — untouched.

## What this fixes

- Enter above wireframe -> wireframe moves down (layout recomputed from doc order)
- Backspace above wireframe -> wireframe moves up
- Delete wireframe -> prose and wireframes below shift up
- No more manual frame-shifting hacks that create multiple undo steps
- Cursor placement on empty lines after wireframe bands is correct

## What this does NOT fix (future work)

- Drag reorder (dragging still moves `gridRow`, doesn't reorder in block list)
- Reparent by drag
- Visual band distinction (wireframe vs prose backgrounds)
- Simplified serialization (still uses `originalGrid` pipeline)
- Side-by-side wireframes (future block model)

## Risk

Low. The layout change is isolated to `reflowLayout` + `doLayout` + `paint` + `hitTest` + `cursorFind`. Serialization, state management, and frame model are untouched. If something breaks, it's visible immediately in the canvas render.

## Size

~80 lines new/changed across reflowLayout.ts, DemoV2.tsx, cursorFind.ts. ~40 lines deleted (frame-shifting hacks + obstacle code). ~100 lines of new tests.
