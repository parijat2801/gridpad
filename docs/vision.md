# Gridpad Vision

A markdown editor where ASCII wireframes come alive.

## Why

Coding agents are bad at visual work because the feedback loop is slow: describe UI in words, agent writes code, run it, look at it, describe what's wrong, repeat. Figma MCP tries to fix this but burns 10-50K tokens per screen read, requires API round-trips, and forces the agent to interpret a proprietary node model. Gridpad replaces all of that with a plain text file. An ASCII wireframe with annotations is ~2K tokens, readable by any agent, diffable in git, and editable by humans visually. The `.md` file is a shared protocol between human and agent — both sides read and write the same artifact. Most teams already have a design system; they don't need pixel-level specs from Figma, they need structural intent: which components go where, in what layout, with what hierarchy. That's exactly what an annotated wireframe expresses.

## What it does

Open any `.md` file. Prose renders as editable text. ASCII wireframes
(box-drawing characters) become interactive objects you can click,
drag, and resize. Save writes clean markdown back to disk.

## How it feels

Like editing a Google Doc that happens to understand wireframes.
Text flows naturally. Wireframes snap to the character grid.
Drag a box wider and the border redraws. Type prose between
wireframes and they shift down. Everything stays in one plain
`.md` file that works in any text editor or git diff.

## Architecture

```
.md file → Scanner → Regions (prose | wireframe)
                         ↓              ↓
                    Pretext layout   Layer composite
                         ↓              ↓
                    ← Single HTML5 Canvas →
                         ↓              ↓
                    Text editing    Drag / Resize
                         ↓              ↓
                    ← Stitch back to .md →
```

- **Pretext** lays out prose text (line breaking, measurement — pure math, 60fps reflow)
- **Scanner** detects wireframe regions (box-drawing characters)
- **Layers** model wireframe shapes (cells, bbox, z-order)
- **Single canvas** renders everything — no DOM text, no Konva
- **File round-trip** — every edit writes clean markdown

## v1 Features

### Wireframe interaction
- Click to select a shape (blue highlight + resize handles)
- Drag to move (snaps to character grid)
- Drag edge/corner to resize (redraws box-drawing border)
- Delete key removes selected shape
- Escape deselects

### Prose editing
- Click in prose to place cursor (blinking caret)
- Type to insert characters
- Backspace/Delete to remove characters
- Enter to split lines
- Arrow keys to navigate
- Prose is source-line-based (not visually wrapped lines)

### File operations
- Cmd+O to open a .md file
- Autosave: debounced write-back to disk after any edit (500ms)
- Cmd+S for manual save
- Clean markdown output (readable in any text editor, git-diffable)

### Drawing tools (stretch goal)
- Draw new rectangles (box-drawing chars)
- Draw new lines
- Type new text labels
- Eraser

## What's NOT in scope

- Rich text (bold, headers rendered visually)
- Proportional fonts
- Collaborative editing
- Cloud storage

## Performance targets

| Metric | Target | How to measure |
|--------|--------|---------------|
| File open (300-line plan, 4 wireframes) | < 500ms | `performance.now()` around `scan + detectRegions + first paint` |
| Drag frame rate | 60fps (< 16ms/frame) | `requestAnimationFrame` timing in drag loop |
| Save latency | < 1s after last edit | Timestamp delta between last mutation and `writable.close()` |
| Region detection | < 50ms for 400-line file | Harness test with `performance.now()` |
| Pretext layout | < 5ms per prose region | Harness test with `performance.now()` |

### How to verify

Performance targets are tested programmatically in the harness
(`src/harness.test.ts`) using `performance.now()` — no browser needed.
The harness runs against real colex plan files as fixtures.

## Current state

- Region detection: working (76 harness tests including real colex plan files)
- Canvas rendering: working (prose via Pretext, wireframes via glyph atlas)
- Click to select: working
- Drag to move: working, persists via text grid edit
- Resize: working, persists via text grid edit
- Scroll: working
- File open (Cmd+O): working
- Autosave: working (debounced 500ms + Cmd+S)
- Prose editing: working (cursor, typing, backspace, delete, enter, arrows)
- Wireframe text label editing: working (double-click to edit)
- Performance targets: all passing (12ms file open, 0.11ms/frame drag)
- Playwright browser tests: 5 tests (render, select, drag-twice, scroll, no-errors)
- Code: extracted into 6 pure modules (Demo.tsx is 290-line thin shell)
- Drawing tools: not yet
