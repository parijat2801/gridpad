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

## Code quality rules

These are enforced during every code review and agent dispatch.
Violations must be fixed before committing.

### 1. No function longer than 60 lines
Extract into named helpers. "JSX is verbose" is not an excuse.

### 2. No file longer than 300 lines
Extract modules. Demo.tsx is a thin shell — logic lives in pure modules.

### 3. Every exported function validates inputs
Return structured errors for invalid input. No silent failures.

### 4. Smallest possible scope
Variables declared in the narrowest scope. If a value is only used
in one branch, compute it there. Don't hoist state.

### 5. No `any` in new code
Define interfaces. Existing `any` in modified files is tolerated.

### 6. Separation of concerns
Each function/module does one thing. Demo.tsx wires refs and events.
Pure modules handle logic. Never mix UI + mutation + validation.

### 7. Pure functions are testable
Logic extracted into pure modules (no React, no refs, no state).
Tested with vitest. Demo.tsx is NOT the place to test logic.

### 8. Parse once, mutate model, serialize on save
NEVER re-scan the document on every render or interaction.
Regions/layers are the in-memory source of truth.

### 9. No useEffect for data flow
useEffect is for DOM setup (canvas ref, event listeners, resize).
NEVER for data flow. Call functions explicitly at mutation sites.

### 10. Playwright tests must not lie
Canvas render tests use full-image pixel counting, not sparse sampling.
A test that passes on a black screen is worse than no test.

## Invariants

These are checked at runtime via console.assert in Demo.tsx:
- doLayout: laid.length === regionsRef.length
- doLayout: y-offsets monotonically increasing
- doLayout: every wireframe has sparse rows, every prose has lines
- paint: canvas dimensions non-zero
- onMouseDown: layout computed, no gesture in progress
- onMouseMove: gesture exists, layer still in region
- onMouseUp: gesture cleared, layout rebuilt
