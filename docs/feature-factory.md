# Feature Factory

## Prioritization Rubric

Score each feature 1-5 on these dimensions. Multiply by weight. Ship highest total first.

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| Agent leverage | 3x | Does this make the human↔agent loop faster, cheaper, or more precise? |
| Plain-text fidelity | 2x | Does the feature round-trip cleanly through a `.md` file and git diff? |
| Interaction delight | 2x | Will this make someone say "wait, how does an ASCII editor do that?" |
| Implementation cost | 1x | Inverse of effort — 5 = trivial, 1 = multi-week |
| Dependency risk | 1x | 5 = uses what we have, 1 = needs new libraries or browser APIs |

**Max score: 45.** Anything above 30 is a clear yes. 20-30 is worth discussing. Below 20, park it.

---

## Features

### 1. Semantic Annotations on Shapes

HTML comments attached to wireframe shapes: `<!-- component: Card, props: { title: string } -->`. Visible in gridpad's properties panel, invisible in standard markdown renderers. The bridge between visual wireframe and code intent.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 5 | Agent reads annotations directly — no guessing what a box means |
| Plain-text fidelity | 5 | HTML comments are valid markdown, survive any editor |
| Interaction delight | 3 | Useful but not visually impressive |
| Implementation cost | 4 | Parse comments near shapes, show in panel, edit inline |
| Dependency risk | 5 | Pure text parsing, no dependencies |
| **Total** | **40** | |

### 2. Connector Lines Between Shapes

Anchored lines that re-route when shapes move. Enables user flows, architecture diagrams, state machines. Renders as `─│┌└→↓` characters.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 4 | Agent reads flow/navigation structure from connections |
| Plain-text fidelity | 4 | ASCII arrows are readable, but re-routing may produce noisy diffs |
| Interaction delight | 5 | This is the "wow" feature — drag a box and arrows follow |
| Implementation cost | 2 | Pathfinding around obstacles, anchor management, re-routing |
| Dependency risk | 4 | Needs a simple routing algorithm but no external deps |
| **Total** | **35** | |

### 3. Border Style Palette

Click a rect, pick thin `┌─┐`, thick `┏━┓`, double `╔═╗`, or rounded `╭─╮` from a popover. Instant visual hierarchy.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 3 | Agent can set style via annotation; visual hierarchy helps spec clarity |
| Plain-text fidelity | 5 | Different Unicode box chars, fully valid in any editor |
| Interaction delight | 4 | Satisfying instant visual change |
| Implementation cost | 5 | `regenerateCells(bbox, style)` already exists, just needs UI |
| Dependency risk | 5 | Nothing new needed |
| **Total** | **35** | |

### 4. Visual Diff (Before/After Wireframe)

When the agent modifies the `.md`, gridpad shows old shapes ghosted in red, new shapes in green. Uses existing `diffLayers` with Hungarian matching.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 5 | Human sees exactly what the agent changed, builds trust |
| Plain-text fidelity | 5 | Reads two versions of the same `.md` — pure text |
| Interaction delight | 5 | Visual git diff for wireframes is novel and immediately useful |
| Implementation cost | 3 | Need to render two layer sets overlaid, color-code matched/unmatched |
| Dependency risk | 5 | Uses existing diff + layer infrastructure |
| **Total** | **41** | |

### 5. Responsive Breakpoints as Sections

Markdown headings define breakpoints: `# Desktop (>= 1024px)`, `# Mobile (< 768px)`. Each section has its own wireframe. Agent reads all breakpoints and generates responsive code.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 5 | Agent gets responsive specs in one file instead of separate conversations |
| Plain-text fidelity | 5 | Just markdown headings with wireframes under each |
| Interaction delight | 3 | Tab-based navigation between breakpoints |
| Implementation cost | 4 | Region model + heading parsing, mostly UI for switching views |
| Dependency risk | 5 | No new dependencies |
| **Total** | **39** | |

### 6. Component Library / Stencil File

A `.md` file with reusable wireframe patterns (cards, forms, navbars). Drag from stencil into your wireframe. Agent can read and extend the library.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 4 | Agent and human share a vocabulary of shapes |
| Plain-text fidelity | 5 | Stencil is just another `.md` file |
| Interaction delight | 4 | Drag-and-drop from a palette feels professional |
| Implementation cost | 2 | Needs cross-file reading, drag-drop, template instantiation |
| Dependency risk | 4 | File System Access API for reading stencil file |
| **Total** | **33** | |

### 7. Live Code Preview Side-by-Side

Split view: left is gridpad, right is an iframe showing the agent's generated code. Edit wireframe → agent regenerates → preview updates.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 5 | Closes the loop completely — draw and see code in one view |
| Plain-text fidelity | 3 | The preview is outside the `.md` — introduces a secondary artifact |
| Interaction delight | 5 | The ultimate demo moment |
| Implementation cost | 1 | Needs agent integration, iframe sandboxing, rebuild triggers |
| Dependency risk | 1 | Depends on external agent API, dev server, heavy integration |
| **Total** | **27** | |

### 8. Properties Panel (Inspect Mode)

Select a shape → see grid position, size (w×h chars), border style, label, annotations. Copy raw ASCII text of the shape. Shows what an agent would see.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 3 | Helps human understand what the agent reads, but agent reads the file directly |
| Plain-text fidelity | 5 | Displays data already in the layer model |
| Interaction delight | 3 | Expected in any editor, not novel |
| Implementation cost | 5 | All data exists in layer model, just render it |
| Dependency risk | 5 | Mantine components, nothing new |
| **Total** | **33** | |

### 9. Smart Alignment Guides

Show dotted lines when dragging a shape into alignment with edges/centers of other shapes. Distribute spacing evenly. Character grid makes alignment exact.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 2 | Helps human make cleaner layouts, agent benefit is indirect |
| Plain-text fidelity | 5 | No file impact — purely visual during interaction |
| Interaction delight | 4 | Feels polished and professional |
| Implementation cost | 3 | Need to scan nearby shapes during drag, render guide lines |
| Dependency risk | 5 | Pure canvas rendering |
| **Total** | **28** | |

### 10. User Flow Diagrams

Draw boxes and arrows to represent navigation flows, state machines, or architecture. Annotations specify routes, auth requirements, transitions.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 5 | Agent reads navigation/state structure directly |
| Plain-text fidelity | 4 | ASCII arrows work, complex routing may be hard to read |
| Interaction delight | 4 | Diagrams in ASCII that a coding agent can act on |
| Implementation cost | 2 | Depends on connector lines (feature #2) |
| Dependency risk | 4 | Same as connectors |
| **Total** | **33** | |

### 11. Zoom (Font Size Scaling)

Zoom in/out changes glyph atlas font size. Canvas scales uniformly. Zoom out far enough and it's a minimap.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 1 | No agent impact |
| Plain-text fidelity | 5 | No file impact |
| Interaction delight | 4 | Expected but satisfying, minimap effect is a bonus |
| Implementation cost | 3 | Rebuild glyph atlas at new size, recalculate all positions |
| Dependency risk | 5 | No new dependencies |
| **Total** | **24** | |

### 12. Template Regions (Components & Instances)

Mark a wireframe block as a template. Place instances via `<!-- use: card-template -->`. Edit template, all instances update. Templates are just ASCII blocks in the same or referenced file.

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Agent leverage | 4 | Agent reads template definitions, generates reusable components |
| Plain-text fidelity | 4 | References are HTML comments, but instance rendering needs processing |
| Interaction delight | 4 | "Change one, update all" is powerful |
| Implementation cost | 2 | Template registry, instance resolution, update propagation |
| Dependency risk | 4 | No external deps but significant new internal model |
| **Total** | **31** | |

---

## Ranked by Score

| Rank | Feature | Score |
|------|---------|-------|
| 1 | Visual Diff (Before/After) | 41 |
| 2 | Semantic Annotations | 40 |
| 3 | Responsive Breakpoints | 39 |
| 4 | Connector Lines | 35 |
| 4 | Border Style Palette | 35 |
| 6 | Properties Panel | 33 |
| 6 | Component Library / Stencil | 33 |
| 6 | User Flow Diagrams | 33 |
| 9 | Template Regions | 31 |
| 10 | Smart Alignment Guides | 28 |
| 11 | Live Code Preview | 27 |
| 12 | Zoom | 24 |
