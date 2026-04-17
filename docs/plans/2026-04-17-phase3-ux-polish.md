# Phase 3: UX Polish — Cursors, Z-Order UI, Save As

**Goal:** Surface z-order controls, add dynamic cursor styling, implement Save As, remove dead tool state.

*Depends on Phase 2 (Save As should serialize coherent state; dirty/regions must be correct first).*

1. **Dynamic cursor on canvas.** DemoV2.tsx line 898 hardcodes `cursor: "default"`. Add a `canvasCursor` React state. In `onMouseMove`, before the drag/resize logic, run a lightweight hover check when no drag is active: call `detectResizeEdge` (from `spatialHitTest.ts`) on the hovered frame — map edge to CSS cursor (`n-resize`, `ew-resize`, `nwse-resize`, etc.); if hovering a frame body, use `grab`; if over prose text, use `text`; otherwise `default`. During active drag, use `grabbing` for moves and the locked resize cursor for resizes. Bind `canvasCursor` to canvas `style.cursor`. ~15 lines added to onMouseMove.

2. **Z-order keyboard shortcuts (top-level only).** Add `]` (bring forward) and `[` (send backward) in the global keyboard handler (DemoV2.tsx ~line 860). When a top-level frame is selected: `]` dispatches `setZEffect.of({ id, z: currentZ + 1 })`, `[` dispatches `setZEffect.of({ id, z: Math.max(0, currentZ - 1) })`, both with `addToHistory.of(true)`. Also `Cmd+]` (bring to front: z = max of all frames + 1) and `Cmd+[` (send to back: z = 0, decrement others). Explicitly scoped to top-level frames — `hitTestFrames` (frame.ts:185) sorts top-level by z, children use reverse-array order (frame.ts:166), so child z-order would need separate design. Add tests in `zorder.test.ts`.

3. **Save As.** Add `showSaveFilePicker` to `file-system.d.ts`. In DemoV2.tsx, add `Cmd+Shift+S` handler: call `window.showSaveFilePicker(...)`, write via `saveToHandle`, update `fileHandleRef`. Guard with `if (!("showSaveFilePicker" in window))` for Firefox/Safari. ~15 lines.

4. **Remove dead `toolField` from CM state.** DemoV2 manages tool state via `activeToolRef` + `useState` (lines 188-189, 220). The CM `toolField` (editorState.ts:151-159), `setToolEffect` (line 58), `getTool` (line 273-275), and `setTool` wrapper (line 494-498) are unused in production. Remove all four plus `toolField` from the `extensions` array (line 243). This also requires test cleanup: `editorState.test.ts` references `getTool`/`setTool` at lines ~84, ~369, ~711 — remove or rewrite those tests since tool state now lives in React, not CM.

| File | Changes |
|------|---------|
| `src/DemoV2.tsx` | Dynamic cursor state; z-order shortcuts; Save As handler |
| `src/editorState.ts` | Remove `toolField`, `setToolEffect`, `getTool`, `setTool` |
| `src/editorState.test.ts` | Remove/rewrite tests that reference tool CM state |
| `src/file-system.d.ts` | Add `showSaveFilePicker` type |
| `src/zorder.test.ts` | Tests for keyboard-driven z-order |

**What does NOT change:** `frame.ts`, `serialize.ts`, `reflowLayout.ts`, `frameRenderer.ts`, scanner, regions, paint logic (paint already respects z via frame order).
