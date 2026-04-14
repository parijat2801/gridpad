# Reflow Architecture — Text Flows Around Wireframes

**Goal:** Replace fixed prose/wireframe regions with a continuous text stream that reflows around wireframe obstacles. Dragging a wireframe re-layouts text at 60fps.

**Core pattern (from Pretext editorial-engine demo):**
1. All prose is one `PreparedTextWithSegments`
2. Wireframes are rect obstacles with absolute pixel positions
3. Per-line layout: for each line band, subtract obstacle intervals, `layoutNextLine` fills remaining slots
4. On drag: update obstacle position, re-run layout loop, repaint

**Data model:**
- `proseText: string` — all prose concatenated (wireframe text excluded)
- `wireframes: Wireframe[]` — each has `{ id, x, y, layers, originalText }`
- Wireframe positions are pixel-based (not grid-row-based)
- On file open: scan → detectRegions → extract prose text + wireframe objects

**Layout loop (runs on every paint):**
```
cursor = start of proseText
lineTop = 0
while cursor not exhausted:
  bandTop = lineTop, bandBottom = lineTop + lineHeight
  blocked = wireframes overlapping this band → intervals
  slots = carveTextLineSlots({left:0, right:canvasWidth}, blocked)
  for each slot: layoutNextLine(prepared, cursor, slotWidth) → draw text
  lineTop += lineHeight
```

**What changes:**
- spatialLayout.ts → rewritten to use obstacle-based layout
- spatialPaint.ts → draws lines at variable x positions (not always x=0)
- spatialHitTest.ts → hit test checks wireframe rects at pixel positions
- spatialTextEdit.ts → prose editing modifies proseText, wireframe drag changes (x,y)
- regions.ts → still used for initial parse, but layout doesn't use regions

**What stays:** scanner, layers, compositeLayers, buildSparseRows, glyph atlas, regenerateCells
