# CLAUDE.md

## What this project is

Gridpad is a markdown editor where ASCII wireframes come alive. Open a
.md file, prose renders as editable text, wireframes become interactive
objects you can click, drag, and resize. Pretext handles text layout,
wireframes render via glyph atlas on a single HTML5 Canvas.

## Architecture

```
.md file → Scanner → detectRegions → prose text + wireframe obstacles
                         ↓                    ↓
                    Pretext reflow        Layer composite
                         ↓                    ↓
                    ← Single HTML5 Canvas →
```

- Parse once on file open. Mutate in-memory model during editing. Serialize on save.
- Scanner only runs on file import — NEVER on every render or interaction.
- Regions are the source of truth during editing. proseTextRef + wireframesRef.
- reflowLayout uses Pretext layoutNextLine per line band, carving around wireframe obstacles.

## Stack

Vite + React 19 + TypeScript + @chenglou/pretext + Mantine v9 + Vitest + Playwright

## Key files

- src/Demo.tsx — thin shell: refs, event wiring, canvas JSX (<300 lines target)
- src/reflowLayout.ts — text reflow around wireframe obstacles (Pretext)
- src/regions.ts — detectRegions: split scan into prose/wireframe
- src/scanner.ts — parses ASCII text into shapes
- src/layers.ts — layer model, compositing, mutations
- src/grid.ts — cell measurement, glyph atlas
- src/spatialHitTest.ts — findLayerAt, findProseAt, detectResizeEdge
- src/spatialTextEdit.ts — drag/resize text grid edits
- src/spatialKeyHandler.ts — prose + wireframe keyboard handling
- src/spatialPaint.ts — canvas paint logic
- src/spatialLayout.ts — region-based layout (legacy, being replaced by reflow)
- src/harness.test.ts — 76 data pipeline tests
- e2e/smoke.spec.ts — Playwright browser tests

## Commands

npm run dev — start dev server (localhost:5173)
npm test — run vitest (367 tests)
npm run build — production build
npx playwright test — browser smoke tests

## Rules

1. Functions ≤60 lines, files ≤300 lines
2. Validate exported function inputs
3. No `any` in new code
4. Logic in pure modules, Demo.tsx is a thin shell
5. Parse once → mutate model → serialize on save. Never re-scan on render.
6. No useEffect for data flow — explicit calls only
7. Playwright pixel tests use full-image scan, never sparse sampling
