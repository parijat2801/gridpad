# Frame Model

**Goal:** Replace wireframes + layers with a unified frame tree. Every shape is a frame. Frames nest. Content clips to parent bounds.

## Data model

```typescript
interface Frame {
  id: string;
  x: number;       // pixel position relative to parent
  y: number;
  w: number;       // pixel size
  h: number;
  children: Frame[];
  // Leaf frame content (null for container frames)
  content: {
    type: "rect" | "line" | "text";
    cells: Map<string, string>;  // grid cells for rendering
    style?: RectStyle;           // for rect regeneration on resize
    text?: string;               // for text labels
  } | null;
  clip: boolean;    // if true, children outside bounds are clipped
}
```

## Canvas structure

```
Root Frame (canvas) — no clip, infinite
  ├── Prose (rendered by Pretext, not a frame — just text on canvas)
  ├── Frame "Dashboard layout" — clip: true
  │   ├── Frame "Header rect"
  │   ├── Frame "Sidebar rect"
  │   ├── Frame "Main Content rect"
  │   ├── Frame "Card Title rect"
  │   ├── Frame "Dashboard" text
  │   └── Frame "Sidebar" text
  └── More prose below
```

## What changes

| Before | After |
|--------|-------|
| Wireframe[] with layers[] | Frame tree |
| Layer type + cells | Frame with content |
| wireframesRef | framesRef (flat list of top-level frames) |
| recalcFrameBounds | frame.w/h set directly on resize |
| compositeLayers + buildSparseRows | renderFrame recursive |
| hitTestWireframe + layer search | hitTestFrame recursive |

## What stays

- Pretext for prose reflow around frames (frames are obstacles)
- Scanner for initial parse (produces frames instead of layers)
- regenerateCells for rect resize
- Glyph atlas / fillText for rendering
- reflowLayout for prose

## File structure (target: each file < 300 lines)

- `src/frame.ts` — Frame type, create/mutate helpers, serialization
- `src/frameRenderer.ts` — renderFrame(ctx, frame, clip), recursive
- `src/frameHitTest.ts` — hitTestFrame(frames, px, py), recursive
- `src/Demo.tsx` — thin shell, < 300 lines
- `src/toolbar.tsx` — extracted toolbar component

## Rendering

```typescript
function renderFrame(ctx: CanvasRenderingContext2D, frame: Frame, parentX: number, parentY: number) {
  const x = parentX + frame.x;
  const y = parentY + frame.y;

  if (frame.clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, frame.w, frame.h);
    ctx.clip();
  }

  // Draw content if leaf
  if (frame.content) {
    drawFrameContent(ctx, frame, x, y);
  }

  // Draw children
  for (const child of frame.children) {
    renderFrame(ctx, child, x, y);
  }

  if (frame.clip) {
    ctx.restore();
  }
}
```

## Hit testing

```typescript
function hitTestFrame(frames: Frame[], px: number, py: number): Frame | null {
  // Reverse order (topmost first)
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (px >= f.x && px < f.x + f.w && py >= f.y && py < f.y + f.h) {
      // Check children first (deeper = higher priority)
      const childHit = hitTestFrame(f.children, px - f.x, py - f.y);
      if (childHit) return childHit;
      return f;
    }
  }
  return null;
}
```

## Migration from current model

On file open:
1. scan() + detectRegions() as before
2. For each wireframe region: create a container Frame (clip: true)
3. For each layer in the region: create a child Frame with content
4. Prose text extracted as before for Pretext reflow

## Implementation order

1. `src/frame.ts` — types + helpers (with tests)
2. `src/frameRenderer.ts` — rendering (with tests via mock ctx)
3. `src/frameHitTest.ts` — hit testing (with tests)
4. Rewrite Demo.tsx to use frames instead of wireframes
5. Extract toolbar to `src/toolbar.tsx`
