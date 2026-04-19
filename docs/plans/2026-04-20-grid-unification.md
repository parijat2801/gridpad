# Grid Unification — Integer Coordinates + Vector Borders

**Status:** Plan agreed. Not yet implemented. Codex reviewed for footguns.

## The Problem

Two coordinate systems: prose at 22px line height, wireframes at 13.37px. Math.round conversions between them cause cumulative drift. 63/120 sweep tests fail on complex wireframes.

## The Solution (agreed by Claude + Codex + Gemini)

1. **One logical row height** — `GRID_ROW_HEIGHT = 22px`. Delete `PROSE_LINE_HEIGHT` and stop using measured `charHeight` for geometry.
2. **Integer grid coordinates** — Frame stores `{ row, col, gridW, gridH }`. Pixels derived at render time: `y = row * 22`.
3. **Vector-drawn borders** — `┌─┐│└┘` drawn as canvas paths, not font glyphs. Labels stay Menlo 16px, centered in 22px cells.
4. **Pretext stays in pixels** — Thin wrapper converts grid→pixels before Pretext, pixels→grid after.
5. **No Math.round on save** — Frame row IS the grid row. Serialization writes directly.

## Footguns Identified by Codex

### 1. Mixed coordinate regimes during migration
Frame is `{x, y, w, h}` in pixels everywhere. Must be a full model-layer conversion, not partial.

### 2. Prose columns aren't monospace
Never derive prose save columns from `round(visualX / charWidth)`. Inter is proportional. Prose saves from source coordinates (proseSegmentMap).

### 3. Grid-snap dragging feels jumpy
Drag smoothly in pixels during interaction. Snap to grid on mouseup only.

### 4. Vector borders vs Menlo labels misalign
Define canonical border geometry at cell center. Center label text using measured ascent/descent, not textBaseline="top".

### 5. `cells` map still needed for serialization
Keep cells for save (serialize box chars to markdown). Vector rendering is display-only.

### 6. Slot width instability
One-way conversion: integer grid cols → pixels. Same formula everywhere. Never round-trip back.

## Files That Change

| File | Change |
|------|--------|
| `src/frame.ts` | Frame type: `{x,y,w,h}` → `{row,col,gridW,gridH}`, derive pixels |
| `src/gridSerialize.ts` | Remove all `Math.round(y/ch)`. Write frame row directly |
| `src/reflowLayout.ts` | Obstacle carving in grid units, convert to pixels for Pretext |
| `src/frameRenderer.ts` | Vector border drawing, label vertical centering |
| `src/DemoV2.tsx` | Drag snap policy, render pixel derivation, hit-test alignment |
| `src/editorState.ts` | moveFrame/resizeFrame in grid units |
| `src/grid.ts` | Add GRID_ROW_HEIGHT, keep charWidth for horizontal |
| `src/textFont.ts` | Delete PROSE_LINE_HEIGHT |
| `src/autoLayout.ts` | Update alignment math for 22px cells |
| `src/scanToFrames.ts` | Frame creation uses grid coords from scanner |

## Pretext's Role

- **Keeps pixel-based measurement** — no modification needed
- **Used for wireframe labels too** — unifies all text measurement
- **Obstacle carving simplifies** — integer grid math before pixel conversion
- **Cannot replace proseSegmentMap** — it's a layout engine, not a document model
- **Can improve cursor/hit-testing** — grapheme-level advances from prepared segments

## Migration Strategy

Full model conversion, not incremental:
1. Change Frame type to grid coords
2. Update all Frame consumers (renderer, serializer, hit-test, drag, resize)
3. Switch border rendering to vectors
4. Update reflowLayout obstacle math
5. Run sweep tests — target 0 failures

## Codex's Merge Requirements

- One canonical `Frame` shape: `{row, col, gridW, gridH}`, pixel `{x,y,w,h}` derived only
- One canonical serializer: geometry → cells → junctions → markdown
- Prose save positions from source coords only, never from visual x
- One global snap policy: `floor` for placement, `round` for preview
- Explicit label alignment math for Menlo in 22px cells
