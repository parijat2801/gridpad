# Gridpad Vision

A markdown editor where ASCII wireframes come alive.

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

## What's NOT in scope

- Rich text (bold, headers rendered visually)
- Proportional fonts
- Collaborative editing
- Cloud storage
- Drawing tools (v1 edits existing wireframes, doesn't create new ones from scratch)

## Current state

Region detection, canvas rendering, click-to-select, and a test harness
with 31 tests work. Drag/resize persistence and text editing are in progress.

## Key metric

Open a 300-line plan file with 4 wireframes in under 500ms.
Drag a wireframe at 60fps. Save within 1 second of last edit.
