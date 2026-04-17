# Wireframe Auto-Layout

**Goal:** Text labels inside wireframe rects shrink-fit their content, obey horizontal + vertical constraints with preserved original offsets, and truncate with `…` when the box is too small — so resizing a box repositions its labels naturally while maintaining their intended spacing. User always controls box size.

---

1. **Each text label stores `hAlign` and `vAlign` as anchor + offset pairs.** `hAlign: { anchor: "left" | "center" | "right", offset: number }` and `vAlign: { anchor: "top" | "center" | "bottom", offset: number }` on `FrameContent` when `type === "text"`. The `offset` is the pixel distance from the anchor edge measured from the **inner bounds** (after border cells — offset=0 means flush against the first interior cell, not the border). For `"center"` anchor, offset is signed (0 = perfectly centered, positive = shifted right/down). The scanner infers both by computing the text's pixel distance from left inner edge, right inner edge, and center; the closest becomes the anchor, the distance becomes the offset. Same logic vertically.

2. **Text labels become children of their enclosing rect.** A new pass in `framesFromRegions` (after all child frames are created at ~line 291) checks each text child: if its bounding box falls geometrically inside a rect child (1-cell tolerance), re-parent it — move it from the container's `children` into the rect's `children`, rebasing `x`/`y` by subtracting the rect's container-relative position. Ambiguous containment resolves to the smallest enclosing rect. Standalone labels remain as container children. **Line children (dividers like `├──┤`) are NOT re-parented** — they remain at the container level and don't participate in auto-layout. After re-parenting, rect children that gained text children get `clip: true` so text truncation works during normal rendering.

3. **Text boxes shrink-fit (hug) their content.** Width equals the measured text width; height equals `lineCount * charHeight`. No stretch, no wrap, no auto-grow. No vertical minimum — if the box is too small vertically, labels overlap (consistent with horizontal truncation). The box size is always user-controlled.

4. **Constraints position each text box independently within the parent's inner bounds, preserving original offsets.** `anchor: "left"` → `x = offset`; `anchor: "right"` → `x = parentInnerW - textBoxW - offset`; `anchor: "center"` → `x = (parentInnerW - textBoxW) / 2 + offset`. Same for `vAlign`. `parentInnerW = parent.w - 2 * charWidth`, `parentInnerH = parent.h - 2 * charHeight` (inner bounds, excluding border cells). If offset exceeds available space (box resized very small), clamp position to 0 — text sits at the edge and truncates. Labels are independently constrained — no stacking, no push, no collision avoidance.

5. **Horizontal truncation with `…` via a new text-specific render path.** The existing `renderContent` uses a cell-map (`Map<string, string>`), which can't handle truncation. A new `renderTextFrame(ctx, frame, absX, absY, parentInnerW, measureWidth)` function in `frameRenderer.ts` renders `type === "text"` frames directly with `ctx.fillText`, measuring text width and truncating with `…` when it exceeds `parentInnerW`. The full text is always stored on the frame — truncation is display-only. `renderFrame` calls `renderTextFrame` instead of `renderContent` for text children.

6. **Ghost overflow rendering during edit — post-pass outside clip.** The container frame has `clip: true`, and rect children with text children also get `clip: true` after re-parenting. Ghost text cannot render inside the clip region. Instead, `DemoV2.tsx`'s `paint()` function renders the ghost in a **post-pass** after all frames: if `textEditRef` is active and the edited frame is a text child inside a rect, render the full text at the frame's absolute position with `ctx.globalAlpha = 0.4`, outside any clip region. The ghost extends past the parent rect's boundary, showing the user how much text overflows. On edit completion (Escape or click-away), the post-pass stops rendering the ghost.

7. **`resizeFrame` calls `layoutTextChildren` for rects with text children.** `layoutTextChildren(frame, charWidth, charHeight)` iterates text children, applies `hAlign`/`vAlign` constraint positioning at the new parent size, and updates each child's `x`/`y`. Called from `resizeFrame` after regenerating border cells when `content?.type === "rect"` and `children.length > 0`. Since `resizeFrame` is a pure function returning a new Frame, `layoutTextChildren` mutates the children array of the returned frame before it's finalized.

8. **Double-click a text label → enter text edit mode.** Reuses the existing `textEditRef` path (already works for standalone text frames). After re-parenting, text children inside rect children are still hit-testable via recursive `hitTestFrames`. On edit completion, `layoutTextChildren` runs on the parent rect to shrink-fit the text box and reapply constraints. Click-away already exits text edit mode (sets `textEditRef.current = null`) — no new code needed.

9. **Alignment shortcuts while editing.** Cmd+L / Cmd+E / Cmd+R for horizontal anchor; Cmd+Shift+T / Cmd+Shift+M / Cmd+Shift+B for vertical anchor. Changing anchor recomputes offset to keep visual position: `newOffset = currentX - computeAnchorX(newAnchor, parentInnerW, textBoxW)` — the text doesn't jump. A small alignment picker (3×3 grid) appears in the toolbar when editing text inside a rect. Only active during text edit mode.

10. **Edge cases.** (a) Empty label: zero-width text box, constraint positions it at anchor + offset. (b) Nested rects: text belongs to innermost enclosing rect. (c) Undo/redo: full rebuild via `scanToFrames` re-derives nesting and alignment; `setTextAlignEffect` added to `invertedEffects` handler in `editorState.ts` for proper undo capture. (d) Enter inserts line break; text box grows taller, may be clipped vertically if it exceeds parent. (e) Unbreakable tokens wider than parent: truncate with `…` at character boundary. (f) Line children (dividers) remain at container level, don't track rect resize — acceptable for v1.

---

| File | Changes |
|------|---------|
| `src/frame.ts` | Add `hAlign: { anchor, offset }`, `vAlign: { anchor, offset }` to `FrameContent`; add `layoutTextChildren`; call from `resizeFrame`; in `framesFromRegions`: re-parent text children, set `clip: true` on rects with text children, infer anchor + offset |
| `src/frameRenderer.ts` | New `renderTextFrame` for truncation rendering with `ctx.fillText` + `…`; `renderFrame` dispatches to it for text children |
| `src/DemoV2.tsx` | Ghost post-pass in `paint()` for edit mode; alignment shortcuts + 3×3 picker UI; call `layoutTextChildren` on edit completion |
| `src/editorState.ts` | New `setTextAlignEffect`; add to `invertedEffects` for undo |

**What does NOT change:** `scanner.ts`, `reflowLayout.ts`, `cursorFind.ts`, `preparedCache.ts`, `textFont.ts`, `serialize.ts`, `regions.ts`, `layers.ts`, `canvasRenderer.ts`.
