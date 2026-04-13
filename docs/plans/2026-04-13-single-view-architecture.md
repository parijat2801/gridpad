# Single-View ASCII Editor — Architecture (v2)

**Date:** 2026-04-13
**Status:** Architecture freeze. Supersedes 2026-04-12 version.

## The one sentence

A web app that opens `.md` files, renders ASCII wireframes visually,
and lets you draw on them like MS Paint. Autosaves back to the file.

## How it works

```
.md file on disk
  ↕ read on open, autosave on every change
  ↕
Text string (in memory)
  ↕
  ├─→ Scanner reads text → finds shapes → Layers (derived)
  │     ↕
  │     Konva renders layers visually
  │     User clicks/drags/resizes layers
  │     Layer mutations → write back to text → autosave
  │
  ├─→ Drawing tools stamp characters into text → autosave
  │     Scanner re-derives layers from updated text
  │
  └─→ Claude edits the .md file externally
        File watcher detects change → app reloads text
        Scanner → diff → layers preserved
```

No CodeMirror. No sync subscribers. No debounce. No annotations.
The file is the source of truth. The app reads and writes it.

## File handling

### Opening a file

Use the File System Access API (`showOpenFilePicker`). Works in
Chrome 86+. Returns a `FileSystemFileHandle` that we keep in
memory for subsequent writes.

```typescript
const [handle] = await window.showOpenFilePicker({
  types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
});
const file = await handle.getFile();
const text = await file.text();
store.loadFromText(text);
```

### Autosave

On every store change that modifies layers, compute `toText()` and
write back to the file handle:

```typescript
const writable = await handle.createWritable();
await writable.write(store.toText());
await writable.close();
```

Debounce writes by 500ms to avoid thrashing disk on rapid edits
(e.g., dragging a shape). This is the ONLY debounce in the system.

### Watching for external changes

Claude (or any editor) may modify the `.md` file while the app has
it open. Poll the file every 2 seconds:

```typescript
setInterval(async () => {
  const file = await handle.getFile();
  if (file.lastModified > lastKnownModified) {
    const text = await file.text();
    store.loadFromText(text);
    lastKnownModified = file.lastModified;
  }
}, 2000);
```

The diff pass preserves groups, labels, visibility, and selection
when the file's content changes — same as today. A wholesale
rewrite (Claude replaces the entire document) clears all metadata
— by design.

Future upgrade: `FileSystemObserver` API (Chrome 129+) replaces
polling with push notifications. Drop-in replacement.

### New file / no file

The app starts with no file open. It shows the default ASCII
wireframe (the Dashboard example). The user can draw on it
immediately. "Save" prompts `showSaveFilePicker` to create a new
`.md` file.

## What we delete from the current codebase

- **CodeMirror and all its deps** — `@codemirror/state`,
  `@codemirror/view`, `@codemirror/theme-one-dark`, `codemirror`
  (basicSetup). ~200KB removed from bundle.
- **The entire sync layer in App.tsx** — `canvasEditAnnotation`,
  `applyingFromCanvas`, `textDebounceRef`, the 100ms
  layers→CodeMirror subscriber, the 300ms CodeMirror→layers
  listener. All gone.
- **`CanvasEditor.tsx`** — replaced by Konva canvas.
- **`ResizeHandles.tsx`** — replaced by Konva Transformer.
- **`rot-js`** — replaced by Konva.

This eliminates Race 1 (stale debounce), Race 2 (controlled prop
jitter — already solved by API research), Race 5 (stale CodeMirror
push), and the entire `cancelPendingTextSync` mechanism.

## What we keep

- `scanner.ts` — untouched
- `layers.ts` — untouched (compositeLayers, moveLayer, etc.)
- `diff.ts` — untouched (identity preservation across file edits)
- `identity.ts` — untouched
- `groups.ts` — untouched
- `store.ts` — remove CodeMirror-specific actions, add file/tool
  state. `loadFromText` and `toText` stay as-is.
- `LayerPanel.tsx` — untouched
- `theme.ts`, `main.tsx` — minor layout changes

## Two mutation paths

### Path A — Text path (drawing tools create new shapes)

```
Tool stamps characters into text → loadFromText(newText)
  → scanner → diff → layers → Konva re-renders → autosave
```

Drawing tools use this because they create new shapes with no prior
layer state. No style to preserve, no cells to erase.

### Path B — Layer path (move/resize modify existing shapes)

```
moveLayerCommit / resizeLayerCommit → mutate layer cells/bbox
  → Konva re-renders → toText() → autosave
```

Move and resize use this because they NEED prior layer state:

1. **Move needs to know which cells to erase.** The layer's cell
   map says exactly which cells belong to this shape. Through text,
   erasing a shared wall character (`┬` between two adjacent rects)
   would break the other rect.

2. **Resize needs the layer's `style` field.** A rect scanned from
   `╔══╗` has `style.tl = "╔"`. `regenerateCells` uses this to
   repaint with the correct characters. Through text, the stamp
   helper would write `┌──┐` — silently replacing heavy borders.

3. **The diff pass could wobble.** Imperfect text erasure could
   produce stray characters that the scanner misinterprets,
   remapping layers and losing group membership.

4. **Shared walls are safe.** Each layer owns its own cell map.
   Moving one layer doesn't touch another's cells.

**Overlap when drawing on existing shapes** is not a bug — it's
"active tool wins" (MS Paint behavior). The scanner re-derives
what's there.

## Rendering with Konva

Single `<Stage>` with two `<Layer>`s:

### Layer 1 — Character grid

Custom Konva `<Shape>` with `sceneFunc` that batch-renders the
composited character map via `ctx.fillText()` row by row.
`listening={false}`. Re-renders when `layers` changes.

### Layer 2 — Interactive shapes + tool feedback

One Konva hit-target per visible, non-base, non-group layer:
- **Rect layers** → Konva `<Rect>`, transparent fill, click
  anywhere inside selects.
- **Line layers** → Konva `<Line>` with `hitStrokeWidth={10}`.
- **Text layers** → Konva `<Rect>` sized to text content width.

Tool previews (draw outlines, cursor, eraser highlight) are
ephemeral nodes on this layer, removed on commit.

### Konva Transformer

Attached to selected rect when `activeTool === "select"`. Provides
8 resize handles. `boundBoxFunc` enforces grid snapping and min
1×1 cell size.

Transformer changes `scaleX`/`scaleY` on the node, not
`width`/`height`. On `onTransformEnd`, normalize scale to
dimensions, reset scale to 1, commit to store.

### Lifecycle adapter (`useGestureAdapter` hook)

Wraps Konva drag/transform events with zundo safety:

**Move:**
- `onDragStart` → snapshot bbox from store, install Escape +
  pointercancel listeners, call `moveLayerLive` once (zundo
  snapshot-then-pause)
- `onDragMove` → NO store call. Konva owns position.
  `dragBoundFunc` snaps to grid.
- `onDragEnd` → read final position from node, snap to grid,
  call `moveLayerCommit`. Remove listeners.
- Escape → `moveLayerCommit(preDragBbox)`, reset node position
- Cleanup → commit pre-drag bbox if interrupted

**Resize:**
- `onTransformStart` → snapshot bbox, install listeners, call
  `resizeLayerLive` once (zundo snapshot)
- `onTransform` → NO store call. `boundBoxFunc` snaps visually.
- `onTransformEnd` → normalize scale, commit to store. Remove
  listeners.
- Escape → commit pre-transform bbox, reset node attrs
- Cleanup → commit pre-transform bbox if interrupted

**Characters snap on release, not per frame.** The user sees the
shape outline move/resize smoothly (Konva handles that), but ASCII
characters update in one jump on commit. Acceptable for v1.

### Controlled vs uncontrolled during drag

Both move and resize: Konva owns the node during the gesture.
Store updates once on end. react-konva (non-strict mode, default)
only reconciles props when values change in the render — if we
don't update the store during drag, props don't change, no jitter.

Escape revert sequence:
1. Revert store (commitAction with pre-drag bbox) — resumes zundo
2. Reset Konva node (`node.setAttrs(...)`) — prevents flicker
3. React re-render reconciles props with store values

## Layout

```
┌──────────┬──────────────────────────────────┐
│  Layer   │  [Open] [Save] [V][R][L][T][E]   │
│  Panel   ├──────────────────────────────────┤
│  (240px) │                                   │
│          │          Konva Stage               │
│          │                                   │
│          │                                   │
└──────────┴──────────────────────────────────┘
```

- Layer panel on the left (already built).
- Toolbar across the top: Open/Save file buttons + tool buttons.
- Konva Stage fills remaining space.
- No CodeMirror. No debug drawer. If a user wants to see the raw
  text, they open the `.md` file in any text editor.

## Tools

| Tool | Key | Action |
|------|-----|--------|
| Select | V | Click/drag/resize layers (Path B) |
| Rectangle | R | Stamp `┌─┐│└─┘` into text (Path A) |
| Line | L | Stamp `───` or `│` into text (Path A) |
| Text | T | Type characters into text (Path A) |
| Eraser | E | Write spaces into text (Path A) |

### Tool commit path (Path A tools only)

1. Compute characters to write.
2. Get current text: `store.toText()`.
3. Stamp characters (pure function, returns new string).
4. Call `store.loadFromText(newText)`.
5. Scanner → diff → layers → Konva re-renders.
6. Autosave debounce fires → writes to file.

### Tool edge-case decisions

- **Overlap:** active tool wins. Drawing over existing shapes
  overwrites their characters.
- **Document expansion:** stamp helpers pad affected rows only.
- **Eraser:** writes spaces. `layerToText` trims trailing spaces.
- **Text commit:** on Escape or click-away. Not per-keystroke.
- **Lines:** orthogonal only (horizontal or vertical).
- **Minimum sizes:** rect 2×2, line 2 cells, text 1 char.

## Store changes

```typescript
type ToolId = "select" | "rect" | "line" | "text" | "eraser";

// New fields:
activeTool: ToolId;
setActiveTool: (tool: ToolId) => void;
fileHandle: FileSystemFileHandle | null;
setFileHandle: (h: FileSystemFileHandle | null) => void;
```

`reset()` sets `activeTool: "select"`, `fileHandle: null`.

Remove: everything CodeMirror-related. `loadFromText` and `toText`
stay unchanged.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| V | Select tool |
| R | Rectangle tool |
| L | Line tool |
| T | Text tool |
| E | Eraser tool |
| Escape | Context-dependent (see precedence) |
| Delete/Backspace | Delete selected layer (Select tool) |
| Cmd/Ctrl+Z | Undo |
| Cmd/Ctrl+Shift+Z | Redo |
| Cmd/Ctrl+O | Open file |
| Cmd/Ctrl+S | Save file |

**Escape precedence (highest first):**
1. Active drag/resize → revert (lifecycle adapter, capture phase,
   `stopPropagation`)
2. Text tool typing → commit text
3. Drawing tool preview → cancel draw
4. Nothing active → switch to Select

## Cell sizing

Measured at runtime after `document.fonts.ready`. NOT hardcoded.
Stored in `grid.ts` module-level state.

```typescript
await document.fonts.ready;
ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
CHAR_WIDTH = ctx.measureText("M┌─┐│").width / 5;
CHAR_HEIGHT = (metrics.actualBoundingBoxAscent +
               metrics.actualBoundingBoxDescent) * 1.15;
```

## Migration strategy

Feature flag `?renderer=konva` during development. Both renderers
coexist. Old code deleted in Phase 4 after parity verified.

**Phase 1:** Konva renders character grid (visual parity).
**Phase 2:** Select + move + resize (interaction parity).
**Phase 3:** Toolbar + drawing tools + file open/save (new features).
**Phase 4:** Remove CodeMirror, rot.js, old components.

## Future: Obsidian plugin

The core logic (scanner, layers, diff, groups, Konva canvas, tools)
is framework-agnostic — it reads text and renders to a canvas. An
Obsidian plugin wraps this in an `ItemView`:

```typescript
class AsciiDrawView extends ItemView {
  getViewType() { return "ascii-draw"; }
  async onOpen() {
    // Mount React app into this.contentEl
    // Read file from this.app.vault
    // Autosave via this.app.vault.modify()
  }
}
```

Obsidian handles file I/O and the `.md` file association. The File
System Access API code is replaced by Obsidian's vault API. The
Konva canvas, scanner, layers, tools — all reused as-is.

## Non-goals

- Pan/zoom (v2)
- Style picker for shapes (v2)
- Freehand drawing
- Multi-select on canvas
- Copy/paste shapes
- Collaborative editing
- Grapheme-cluster support (emoji)
