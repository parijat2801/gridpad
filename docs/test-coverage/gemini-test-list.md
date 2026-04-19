# Gemini Test List — 35 Tests

## 1. Smoke & Happy Paths

1. **Load and Render Simple Box** — Smoke/Roundtrip — simple-box fixture — Load→Save→Reload — output matches input; 1 rect; 0 visual diff; no ghosts
2. **Drag Box and Persist** — Smoke/Interaction — simple-box — Click→Drag right 50px→Save — box indented ~5 spaces; frame x increased; visual diff < 1%
3. **Resize Box and Persist** — Smoke/Interaction — simple-box — Click→Hover handle→Drag down-right 40px→Save — longer borders; frame w/h increased; no ghosts
4. **Edit Text Label Inside Box** — Smoke/Interaction — labeled-box — Click→Drill-down→Double-click→Type " World"→Escape→Save — contains "Hello World"; borders intact
5. **Type Prose Around Box** — Smoke/Prose — simple-box — Click above box→Type "New heading "→Save — prose updated; box same grid position; no overlap
6. **Draw New Rectangle Tool** — Smoke/Tools — pure-prose — Press 'r'→Drag 100x100→Save — new box in output using ┌─┐│└┘; 1 new rect

## 2. Parsing & Serialization Roundtrip

7. **Shared Wall / Junction Extraction** — Edge-Case/Parsing — junction-box — Load→Save→Reload — byte-identical; ┬ and ┴ preserved
8. **Asymmetric Shared Walls** — Edge-Case/Parsing — asymmetric-shared — Load→Save — matches input; T-junctions preserved
9. **Emoji and Unicode Character Widths** — Edge-Case/Encoding — emoji-doc — Load→Type "!"→Save — emoji preserved; cursor aligns with grapheme clusters
10. **Malformed / Broken Box Graceful Fallback** — Edge-Case/Parsing — broken-box (missing ┘) — Load→Save — parsed as unclaimed; no crash; output matches input
11. **Markdown Syntax Interference** — Regression/Parsing — markdown-heavy (---, tables, blockquotes) — Load→Save — not converted to wireframes; output matches input

## 3. Prose Reflow & Structural Logic

12. **Reflow on Horizontal Drag (Collision)** — Core Logic/Reflow — tight-prose — Drag box into paragraph — prose wraps around; no overlap with frame bbox; line heights aligned
13. **Enter Key Pushes Box Down** — Core Logic/EditorState — simple-box — Click above box→Enter 3x→Save — box y increases by 3*charHeight; 3 new blank lines above
14. **Backspace Merges Lines and Pulls Box Up** — Core Logic/EditorState — spaced-box — Click above→Backspace 3x→Save — box y decreases; no overlapping wire chars
15. **Zero-Blank-Line Proximity** — Boundary Condition — zero-gap — Drag right 50px→Save — box moves; prose intact; no ghosts

## 4. Text Label Editing

16. **Label Overflow / Clipping** — Boundary/Visual — small-box — Double-click→Type long word — text frame w expands; visual clips; save preserves
17. **Text Label Alignment Shortcuts** — Keyboard Navigation — labeled-box — Double-click→Cmd+R→Cmd+B→Save — text at bottom-right; markdown pads accordingly
18. **Delete All Text in Label** — Edge-Case — labeled-box — Double-click→Backspace until empty→Escape→Save — box intact; interior spaces

## 5. Undo / Redo

19. **Undo a Box Drag** — History — simple-box — Drag 100px right→Cmd+Z→Save — original position; markdown matches input
20. **Interleaved Undo** — Complex State — simple-box — Type "A"→Drag→Type "B"→Undo×3 — each undo reverses correct operation; state synced
21. **Redo Box Deletion** — History — simple-box — Delete→Undo→Redo→Save — box deleted in final output

## 6. Mouse & Interaction Boundaries

22. **Minimum Resize Clamp** — Boundary — simple-box — Drag handle up-left 500px — clamps to min 2×2; no negative dimensions
23. **Negative Coordinate Drag Clamp** — Boundary — simple-box at top-left — Drag aggressively up-left — clamps to 0,0
24. **Selection Drill-down Cycle** — State Transition — nested-boxes — Click outer→inner→text→empty — selected ID updates sequentially
25. **Draw Line Tool** — Tools — pure-prose — Press L→Drag vertically→Save — line frame in tree; column of │ in output

## 7. Stress & Performance

26. **Large Document / Many Boxes** — Stress — 50-boxes-doc — Drag one box→Save — no crash; reflow completes; save < 500ms
27. **Extreme Grid Dimensions** — Stress — ultra-wide-box (300 chars) — Type inside→Save — width maintained; no out-of-bounds
28. **Rapid Alternating Clicks** — Race Condition — simple-box — Loop 20x: click box→click prose→10ms — no lock-up; final state correct

## 8. Visual & Browser Edge Cases

29. **Resize Window triggers Reflow** — Browser/Layout — simple-box — Load at 1000px→Resize to 500px — doLayout called; line count increases
30. **Cursor Hover States** — Visual/Accessibility — simple-box — Hover canvas→box→handle — cursor: text→grab→nwse-resize
31. **Scrolling During Drag** — Browser Edge-Case — tall-document — Scroll 500px→Click box→Drag down 50px — correct drag deltas; no jump
32. **Drawing Tool Preview Rendering** — Visual — pure-prose — Press R→MouseDown→MouseMove (no mouseUp) — dashed preview; frame tree NOT modified

## 9. File System / Autosave

33. **Autosave Debounce** — I/O Logic — simple-box — Type A→100ms→B→100ms→C→600ms — saveToHandle called once with "ABC"
34. **Save As (New File)** — I/O Logic — simple-box — Cmd+Shift+S→Resolve picker — new handle assigned; dirty cleared
35. **Abort File Open** — Error State — simple-box — Cmd+O→Reject AbortError — no crash; existing doc remains
