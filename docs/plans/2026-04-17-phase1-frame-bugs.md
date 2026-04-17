# Phase 1: Frame Model Bugs

**Goal:** Fix child frame deletion, make move/resize undoable, clean up selection state on delete.

1. `deleteFrameEffect` in `editorState.ts:106` does `result.filter(f => f.id !== id)` — top-level only. Replace with a recursive `removeById` that walks `frame.children` (same pattern as `applyMove`/`applyResize` which already recurse at lines 91-96). The `applyDeleteFrame` wrapper and its `addToHistory.of(true)` annotation stay unchanged. Add tests: delete a child inside a container, verify parent keeps other children; delete a deeply nested child; delete a top-level frame (regression).

2. When a frame is deleted, `selectedIdField` (editorState.ts:181) and `textEditField` (editorState.ts:195) are not cleared — the app holds stale references to a frame that no longer exists. Fix: in `framesField.update`, after processing `deleteFrameEffect`, also emit `selectFrameEffect.of(null)` and `setTextEditEffect.of(null)` if the deleted id matches the current selection or text edit target. Alternatively, handle this in `applyDeleteFrame` by bundling the three effects in one transaction. Add test: delete the selected frame, verify `getSelectedId` returns null; delete a frame being text-edited, verify `getTextEdit` returns null.

3. Move and resize drags dispatch effects with `Transaction.addToHistory.of(false)` (DemoV2.tsx lines 540, 553) so interim steps don't flood history. But `onMouseUp` (line 561) never commits a final history-enabled transaction — drags are invisible to undo. Fix: on mouseUp, if `dragRef.current.hasMoved`, dispatch a no-op `moveFrameEffect.of({ id, dx: 0, dy: 0 })` (or `resizeFrameEffect` with current dimensions) annotated with `addToHistory.of(true)`. The `invertedEffects` snapshot (editorState.ts:223-237) already captures pre-transaction frame state, so undo restores frames to their pre-drag snapshot. Add tests in `editorState.test.ts`: move frame with history=false then history=true, verify undo restores original position; same for resize.

4. `setZEffect` (editorState.ts:108-109) only updates top-level frames, same bug as delete. Make it recursive. Note: this is future-proofing only — Phase 3's z-order UI targets top-level frames exclusively since `hitTestFrames` (frame.ts:185) sorts by z at the top level while children use reverse-array order (frame.ts:166).

| File | Changes |
|------|---------|
| `src/editorState.ts` | Recursive delete in `framesField.update`; recursive setZ; clear selection/textEdit on delete |
| `src/editorState.test.ts` | Tests for child deletion, selection cleanup, undo of move/resize |
| `src/DemoV2.tsx` | History commit on mouseUp for move/resize drags |

**What does NOT change:** `frame.ts`, `serialize.ts`, `frameRenderer.ts`, scanner, regions, reflow, paint logic.
