# CLAUDE.md

## What this project is

Gridpad is a visual ASCII wireframe editor. Open a .md file, see
shapes rendered on a Konva canvas, draw with MS-Paint-style tools.
Text is the source of truth — tools stamp characters, the scanner
derives layers.

## Architecture

Text (the document) <-> Scanner -> Layers (derived) -> Konva renders
Drawing tools -> stamp chars into text -> loadFromText -> scanner
Move/resize -> mutate layers -> toText -> autosave to file

## Stack

Vite + React 19 + TypeScript + Konva + react-konva + Mantine v9 +
Zustand + Zundo + Vitest

## Key files

- src/scanner.ts — parses ASCII text into shapes
- src/layers.ts — layer model, compositing, mutations
- src/diff.ts — identity-preserving diff pass
- src/store.ts — zustand store (no CodeMirror)
- src/KonvaCanvas.tsx — Konva Stage with grid + interactive shapes
- src/Toolbar.tsx — tool buttons
- src/tools/ — stamp helpers (stampRect, stampLine, etc.)
- src/grid.ts — cell measurement constants
- src/LayerPanel.tsx — layer tree panel

## Commands

npm run dev — start dev server
npm test — run vitest
npm run build — production build
