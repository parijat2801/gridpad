# Remaining Fixes (v5 — corrected after code review)

**Goal:** Fix "Field is not present" crash, fix missing cursor on long docs.

---

1. **Null-guard the keydown listener** (DemoV2.tsx:457, `fn` closure). Keep the `window.addEventListener` — moving to `onKeyDown` prop breaks global shortcuts (Cmd+O) when div isn't focused (Gemini + Codex agree). Add `if (!stateRef.current) return;` as the first line inside `fn`. **Keep `useRef<EditorState>(null!)` type unchanged** — changing to nullable would cause TS errors in ~15 handler locations that are already safe at runtime (canvas doesn't render until `ready=true`). The runtime guards are what matter here.

2. **Guard paint()** (DemoV2.tsx:148). Add `if (!stateRef.current) return;` after the canvas null check. Defense in depth — paint can't reach `getSelectedId` before init (canvas isn't rendered), but the guard makes the nullable type work cleanly.

3. **Replace scroll useEffect with React prop** (DemoV2.tsx:441-447). The current useEffect has no deps array, so it re-attaches the scroll listener every render. Fix: add `onScroll={paint}` to the outer `<div>` (line 660), then delete the useEffect entirely. This follows the project rule "No useEffect for data flow — explicit calls only."

4. **Guard resize handler** (DemoV2.tsx:436). Add `if (!stateRef.current) return;` inside the `fn` closure. Window resize fires regardless of component state.

5. **Fix cursor rendering** (DemoV2.tsx:187-201). Replace the `srcRow` walk with last-matching-line algorithm plus empty-line fallback for arrow-key navigation:

```typescript
const cursor = proseCursorRef.current;
if (cursor && blinkRef.current) {
  const charWidth = getCharWidth();
  let targetLine: PositionedLine | null = null;
  let lastLineBefore: PositionedLine | null = null;
  for (const pl of linesRef.current) {
    if (pl.startCursor.segmentIndex === cursor.row &&
        pl.startCursor.graphemeIndex <= cursor.col) {
      targetLine = pl;
    }
    if (pl.startCursor.segmentIndex < cursor.row) {
      lastLineBefore = pl;
    }
  }
  ctx.fillStyle = "#ffffff";
  if (targetLine) {
    ctx.fillRect(
      targetLine.x + (cursor.col - targetLine.startCursor.graphemeIndex) * charWidth,
      targetLine.y, 2, LH,
    );
  } else if (lastLineBefore) {
    // Empty line fallback (e.g., \n\n separator navigated via arrow keys)
    ctx.fillRect(
      0,
      lastLineBefore.y + LH * (cursor.row - lastLineBefore.startCursor.segmentIndex),
      2, LH,
    );
  } else {
    // Empty document fallback — no lines at all
    ctx.fillRect(0, 0, 2, LH);
  }
}
```

---

| File | Changes |
|------|---------|
| `src/DemoV2.tsx:85` | Keep `useRef<EditorState>(null!)` unchanged |
| `src/DemoV2.tsx:436` | Guard resize: `if (!stateRef.current) return;` |
| `src/DemoV2.tsx:441-447` | Delete scroll useEffect, add `onScroll={paint}` to outer div (line 660) |
| `src/DemoV2.tsx:457` | Guard keydown: `if (!stateRef.current) return;` |
| `src/DemoV2.tsx:187-201` | Last-matching-line cursor + empty-line fallback |

**What does NOT change:** editorState.ts, canvasRenderer.ts, frame.ts, serialize.ts, all test files. Window keydown listener stays. Canvas tabIndex stays.
