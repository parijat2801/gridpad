# Phase 4: DemoV2 Extraction — Thin Shell Target

**Goal:** Break DemoV2.tsx from ~900 lines down to ~250 by extracting concerns into pure modules.

*Depends on Phases 1-3 being complete — the code being extracted must be in its final form. Phase 4 is a pure refactor: zero behavior changes.*

1. **Extract `canvasInteraction.ts` (~200 lines).** Move `onMouseDown`, `onMouseMove`, `onMouseUp` into a pure module. The module receives a `CanvasCallbacks` interface with: `paint()`, `doLayout()`, `scheduleAutosave()`, `setCanvasCursor(c: string)`, `setTool(t: ToolName)` — these are the component-scope functions the handlers close over today. Plus a `CanvasRefs` interface for the refs they read/write (stateRef, framesRef, dragRef, etc.). Returns `{ onMouseDown, onMouseMove, onMouseUp }`. DemoV2 builds the callbacks + refs objects and calls `createCanvasHandlers(refs, callbacks)`. This is not purely ref-based — Codex correctly noted that `paint()`, `scheduleAutosave()`, and `doLayout()` are component-scope dependencies that need an explicit callback interface.

2. **Extract `canvasPaint.ts` (~100 lines).** Move the `paint()` function (DemoV2.tsx ~lines 240-337) into a pure module. Takes a `PaintContext` (canvas, dpr, charWidth, charHeight, state, frames, lines, prepared cache, selection state, tool preview state) and draws everything. No React imports. `doLayout()` (~lines 235-238) stays in DemoV2 since it updates refs.

3. **Extract `keyboardHandler.ts` (~250 lines).** Move the keyboard event handler (DemoV2.tsx ~lines 615-880). This is the largest extraction. The handler closes over React state setters (`setActiveTool`, `setStatus`), async save helpers (`saveToHandle`, `scheduleAutosave`), and file picker APIs. Define a `KeyboardCallbacks` interface: `{ paint, doLayout, scheduleAutosave, saveToHandle, setTool, openFile }` plus `KeyboardRefs` for state/frame/cursor refs. Returns `handleKeyDown(e: KeyboardEvent)`. DemoV2 attaches via `window.addEventListener`.

4. **Move `proseCursorFromClick` into `cursorFind.ts`.** The function at DemoV2.tsx ~lines 339-416 does grapheme-level binary search. It already has a natural boundary: takes lines, click coords, font metrics, returns CursorPos. `cursorFind.ts` already exports `findCursorLine` — add `proseCursorFromClick` alongside it with tests. Corrected from original plan: the function starts at ~line 339 (not 350).

5. After all extractions, DemoV2.tsx retains: ref declarations (~50 lines), `loadDocument` + `doLayout` (~20 lines), `useEffect` hooks (~25 lines), file I/O helpers (~20 lines), tool state (~10 lines), JSX (~25 lines), callback/ref object construction (~50 lines). Target: ~200-250 lines.

| File | Changes |
|------|---------|
| `src/canvasInteraction.ts` | **New** — mouse handlers with `CanvasCallbacks` + `CanvasRefs` interfaces |
| `src/canvasPaint.ts` | **New** — paint function with `PaintContext` interface |
| `src/keyboardHandler.ts` | **New** — keyboard handler with `KeyboardCallbacks` + `KeyboardRefs` interfaces |
| `src/cursorFind.ts` | Add `proseCursorFromClick` (moved from DemoV2) |
| `src/DemoV2.tsx` | Thin shell: refs, hooks, callback wiring, JSX |
| `src/canvasInteraction.test.ts` | **New** — tests for mouse handler edge cases |
| `src/keyboardHandler.test.ts` | **New** — tests for keyboard shortcuts |
| `src/cursorFind.test.ts` | Add tests for `proseCursorFromClick` |

**What does NOT change:** `editorState.ts`, `frame.ts`, `serialize.ts`, `reflowLayout.ts`, `frameRenderer.ts`, `grid.ts`, `layers.ts`. All logic stays identical — only file boundaries and dependency injection patterns change.
