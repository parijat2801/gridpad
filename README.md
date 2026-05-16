# Gridpad

A markdown editor where ASCII wireframes come alive.

Open a `.md` file: prose renders as editable text, and ASCII-art wireframes become interactive objects you can click, drag, and resize. Built to make wireframing with [Claude Code](https://claude.com/claude-code) feel native — sketch a layout in plain text, manipulate it visually, and save it back as the same ASCII art.

```
┌─────────────┐   ┌─────────────┐
│   Sidebar   │   │   Content   │
│             │   │             │
│  - Item 1   │   │   Lorem     │
│  - Item 2   │   │   ipsum...  │
└─────────────┘   └─────────────┘
```

The wireframe above is a real, draggable object when opened in Gridpad — not a screenshot.

## How it works

Prose is laid out by [Pretext](https://github.com/chenglou/pretext); wireframes render via a glyph atlas onto a single HTML5 Canvas. The pipeline is parse-once, mutate-in-memory, serialize-on-save:

```
.md file → Scanner → frames (grid coords) + prose segments
                         ↓                    ↓
                    Pretext reflow        Layer composite
                         ↓                    ↓
                    ← Single HTML5 Canvas →
                         ↓
                    gridSerialize → .md file
```

Grid coordinates are the source of truth. Frames store `gridRow`/`gridCol`/`gridW`/`gridH`; pixel positions are derived for rendering only. Move and resize commit in integer grid units, so round-tripping a wireframe through the editor produces byte-identical ASCII.

## Stack

Vite · React 19 · TypeScript · [@chenglou/pretext](https://www.npmjs.com/package/@chenglou/pretext) · Vitest · Playwright

## Commands

```bash
npm install
npm run dev      # dev server at localhost:5173
npm test         # vitest unit tests
npm run build    # production build
npx playwright test e2e/   # full e2e suite
```

## Deployment

- Default `vite build` produces a Tauri-friendly bundle at `base: '/'`.
- For the gh-pages site, build with the explicit base override:
  `vite build --base=/gridpad/`
