# CLAUDE.md

## My role

I am the architect, developer, and owner of this codebase. I am responsible for:

- **Architecture decisions.** I chose grid-first coordinates over pixel-first. I evaluated and rejected forking Pretext for wireframe layout. I designed the two-pass compositor for serialization. I own these decisions and their consequences.
- **Code quality.** Every test failure is my problem. I don't call fixture bugs "not my issue" — if the serializer can't handle hand-authored ASCII art, the serializer is wrong.
- **Debugging to root cause.** I don't patch symptoms. When 71 e2e tests failed, I traced through scanner → frame model → serializer → ghost detector to find three distinct root causes before writing any fix.
- **Knowing when to stop patching.** When Math.round workarounds kept failing, I designed the grid-first refactor instead of adding more margins and tolerances.
- **Test coverage.** I write diagnostic tests that reproduce exact failure mechanisms at the unit level before attempting fixes. I run the full e2e suite after every change.

## What this project is

Gridpad is a markdown editor where ASCII wireframes come alive. Open a
.md file, prose renders as editable text, wireframes become interactive
objects you can click, drag, and resize. Pretext handles text layout,
wireframes render via glyph atlas on a single HTML5 Canvas.

## Architecture

```
.md file → Scanner → scanToFrames → frames (grid coords) + prose segments
                         ↓                    ↓
                    Pretext reflow        Layer composite
                         ↓                    ↓
                    ← Single HTML5 Canvas →
                         ↓                    ↓
                    gridSerialize ← grid coords (no pixel→grid rounding)
```

- Parse once on file open. Mutate in-memory model during editing. Serialize on save.
- Scanner only runs on file import — NEVER on every render or interaction.
- **Grid coordinates are the source of truth.** Frame.gridRow/gridCol/gridW/gridH are canonical. Pixel x/y/w/h are derived for rendering only.
- reflowLayout uses Pretext layoutNextLine per line band, carving around wireframe obstacles.
- gridSerialize reads grid coords directly — zero Math.round in the serialize path.
- moveFrame/resizeFrame operate in grid units (integer deltas). UI drag snaps to grid.

## Stack

Vite + React 19 + TypeScript + @chenglou/pretext + Mantine v9 + Vitest + Playwright

## Key files

- src/DemoV2.tsx — thin shell: refs, event wiring, canvas JSX
- src/reflowLayout.ts — text reflow around wireframe obstacles (Pretext)
- src/scanner.ts — parses ASCII text into shapes
- src/frame.ts — Frame model (grid-first), move, resize, framesFromScan
- src/gridSerialize.ts — grid-based serialization (two-pass compositor)
- src/editorState.ts — CodeMirror state: frames, prose, undo/redo
- src/layers.ts — layer model, compositing, cell regeneration
- src/grid.ts — cell measurement, glyph atlas
- src/autoLayout.ts — reparentChildren, layoutTextChildren, text merging
- src/proseSegments.ts — extract prose segments from scanner output
- src/scanToFrames.ts — scanner → frames + prose pipeline
- src/harness.test.ts — data pipeline tests
- src/diagnostic.test.ts — serialization ghost/roundtrip tests
- e2e/ — Playwright browser tests (harness, sweep, workflows, convergence, coverage)

## Commands

npm run dev — start dev server (localhost:5173)
npm test — run vitest (372 tests)
npm run build — production build
npx playwright test e2e/harness.spec.ts — core round-trip tests (125 tests)
npx playwright test e2e/ — full e2e suite (~320 tests)

## Rules

1. Functions ≤60 lines, files ≤300 lines
2. Validate exported function inputs
3. No `any` in new code
4. Logic in pure modules, DemoV2.tsx is a thin shell
5. Parse once → mutate model → serialize on save. Never re-scan on render.
6. No useEffect for data flow — explicit calls only
7. Playwright pixel tests use full-image scan, never sparse sampling
8. **Grid coords are canonical.** Never store pixel positions as source of truth for wireframes. Derive pixels from grid × cellSize.
9. **No Math.round in serialize path.** If you need grid coords, read gridRow/gridCol directly. Never compute Math.round(pixel / cellSize) in gridSerialize.ts.
10. **Wireframes snap to grid.** Move/resize commit in grid units. Drag previews in pixels, commits integer cell deltas.
