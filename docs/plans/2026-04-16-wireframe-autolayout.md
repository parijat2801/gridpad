# Wireframe Auto-Layout

**Goal:** Text labels inside wireframe rects shrink-fit their content, obey horizontal + vertical constraints, and truncate with `…` when the box is too small — so resizing a box repositions its labels naturally, and the user always controls the box size.

---

1. **Each text label stores `hAlign` and `vAlign`.** `hAlign: "left" | "center" | "right"` and `vAlign: "top" | "center" | "bottom"` on `FrameContent` when `type === "text"`, defaulting to `"left"` and `"top"`. The scanner infers both from the text's position relative to its enclosing rect's inner bounds: within 1 cell of left edge → `left`, right edge → `right`, otherwise → `center`; same logic vertically. Inference runs in `framesFromRegions` after parent-child nesting (point 2).

2. **Text labels become children of their enclosing rect.** A new pass in `framesFromRegions` checks each text child: if its bounding box falls geometrically inside a rect child (1-cell tolerance), re-parent it into the rect's `children`, rebasing `x`/`y` relative to the rect. Ambiguous containment resolves to the smallest enclosing rect. Standalone labels remain as container children.

3. **Text boxes shrink-fit (hug) their content.** Width equals the measured text width; height equals `lineCount * charHeight`. No stretch, no wrap, no auto-grow. The box size is always user-controlled.

4. **Constraints position each text box independently within the parent's inner bounds.** `hAlign: left` → `x = charWidth`; `right` → `x = innerW - textW - charWidth`; `center` → `x = (innerW - textW) / 2`. Same for `vAlign` vertically. Labels don't affect each other — no stacking, no push, no collision avoidance. Overlapping labels mean the box is too small.

5. **Horizontal truncation with `…` when text exceeds parent inner width.** At render time, if the text box is wider than `parentInnerW`, truncate the visible text and append `…`. The full text is always stored — truncation is a display-only effect (like CSS `text-overflow: ellipsis`). No data mutation, survives roundtrip naturally because the markdown stores the full label.

6. **Vertical minimum: box can't shrink below its content needs.** When resizing vertically, the box has a minimum height based on the vertical space required by its constrained text children. If a top-pinned label and a bottom-pinned label need 4 rows between them, the box won't shrink below that. Horizontal resize has no minimum — text just truncates.

7. **Ghost overflow while editing.** Double-click a label to enter edit mode. While editing, text renders fully past the box boundary as a semi-transparent ghost (no clip). The box border stays fixed. The user sees exactly what they typed and how much it overflows. On edit completion (Escape or click-away), ghost disappears and text truncates to fit. This gives visible design feedback — "your label is too long for this box" — without auto-growing.

8. **Alignment shortcuts while editing.** Cmd+L / Cmd+E / Cmd+R for horizontal; Cmd+Shift+T / Cmd+Shift+M / Cmd+Shift+B for vertical. A small alignment picker in the toolbar (3×3 grid) appears when editing text inside a rect — shortcuts are accelerators, not the only path. Changes apply immediately.

9. **Edge cases.** (a) Empty label: zero-width text box, constraint positions it at anchor. (b) Nested rects: text belongs to innermost enclosing rect. (c) Undo/redo: full rebuild re-derives nesting and alignment from scratch. (d) Click-away exits edit mode (not just Escape). (e) Enter inserts line break; text box grows taller, may truncate vertically if it exceeds parent height. (f) Unbreakable tokens wider than parent: truncate with `…` at character boundary.

---

| File | Changes |
|------|---------|
| `src/frame.ts` | Add `hAlign`, `vAlign` to `FrameContent`; add `layoutTextChildren` (apply constraints + truncation); enforce vertical minimum in `resizeFrame`; in `framesFromRegions`: re-parent text children, infer alignment |
| `src/frameRenderer.ts` | Render truncation `…` for overflowing text; render ghost overflow during edit mode |
| `src/DemoV2.tsx` | Alignment shortcuts + picker UI in text edit mode; click-away exits edit; call `layoutTextChildren` on resize and edit completion |
| `src/editorState.ts` | New `setTextAlignEffect` for `hAlign`/`vAlign` updates |

**What does NOT change:** `scanner.ts`, `reflowLayout.ts`, `cursorFind.ts`, `preparedCache.ts`, `textFont.ts`, `serialize.ts`, `regions.ts`, `layers.ts`, `canvasRenderer.ts`.
