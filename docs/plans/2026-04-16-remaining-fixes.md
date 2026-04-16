# Remaining Fixes (v4 — Gemini + Codex consensus)

**Goal:** Fix "Field is not present" crash, fix missing cursor on long docs.

---

1. **Null-guard the keydown listener** (DemoV2.tsx:464). Keep the `window.addEventListener` — moving to `onKeyDown` prop breaks global shortcuts (Cmd+O) when div isn't focused (Gemini + Codex agree). Add `if (!stateRef.current) return;` as the first line inside `fn`. Change stateRef type to `useRef<EditorState | null>(null)` so TypeScript enforces null checks everywhere.

2. **Guard paint()** (DemoV2.tsx:154). Add `if (!stateRef.current) return;` after the canvas null check. Defense in depth — paint can't reach `getSelectedId` before init (canvas isn't rendered), but the guard makes the nullable type work cleanly.

3. **Remove duplicate scroll useEffect** (DemoV2.tsx:448-454). The outer div already has `onScroll={paint}` at line 667. The useEffect duplicates it and re-attaches every render (no deps array). Both reviewers confirm safe to delete.

4. **Guard resize handler** (DemoV2.tsx:443). Add `if (!stateRef.current) return;` inside the resize handler. Window resize fires regardless of component state.

5. **Fix cursor rendering** (DemoV2.tsx:194-207). Replace the `srcRow` walk with Gemini's last-matching-line algorithm plus Gemini's empty-line fallback for arrow-key navigation:

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
  }
}
```

---

| File | Changes |
|------|---------|
| `src/DemoV2.tsx:85` | `useRef<EditorState \| null>(null)` |
| `src/DemoV2.tsx:443` | Guard resize: `if (!stateRef.current) return;` |
| `src/DemoV2.tsx:448-454` | Delete scroll useEffect |
| `src/DemoV2.tsx:464` | Guard keydown: `if (!stateRef.current) return;` |
| `src/DemoV2.tsx:194-207` | Last-matching-line cursor + empty-line fallback |

**What does NOT change:** editorState.ts, canvasRenderer.ts, frame.ts, serialize.ts, all test files. Window keydown listener stays. Canvas tabIndex stays.
