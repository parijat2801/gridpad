# Codex (GPT-5.4) Test List — 120 Tests

## Frame Selection & Hit Testing (1-10)
1. Click empty canvas — no selection, prose cursor set
2. Click inside frame — frame selected, prose cursor cleared
3. Click frame then click empty — deselects frame
4. Click overlapping frames — highest z-order wins
5. Click nested child (drill-down) — first click=parent, second=child
6. Drill-down returns to parent on outside click
7. Click frame border pixel — selects frame (not prose)
8. Selection shows blue outline and 8 handles
9. Multiple rapid clicks don't create ghost selections
10. Selection survives viewport scroll

## Frame Drag (11-20)
11. Drag frame right — x increases, markdown indented
12. Drag frame down — y increases, markdown rows shift
13. Drag to x=0 clamp — no negative coordinates
14. Drag to y=0 clamp — no negative coordinates
15. Small drag (< 1 grid cell) — may not change grid position
16. Drag 10x in sequence — position accumulates
17. Drag then save — dirty flag set, position persisted
18. Drag nested child within parent — child moves, parent stays
19. Drag parent moves all children
20. Drag frame past document bottom — grid expands

## Frame Resize (21-30)
21. Resize from bottom-right handle — w/h increase
22. Resize from top-left handle — x/y shift, w/h change
23. Resize to minimum (2x2) — clamps, no inversion
24. Resize very large — grid expands
25. Resize parent — children re-layout via auto-layout
26. Resize regenerates cells (border chars correct)
27. Resize then save — new dimensions persisted
28. Resize then undo — original dimensions restored
29. Resize handle cursor changes (nwse, nesw, ns, ew)
30. Resize shrink then expand back — idempotent

## Frame Delete (31-40)
31. Select + Delete key — frame removed
32. Delete container — all children removed
33. Delete child — parent survives
34. Delete then undo — frame restored
35. Delete then undo then move — restored frame movable
36. Delete all frames — prose-only document
37. Delete leaves no ghost wire chars
38. Delete cascade — empty container auto-removed
39. Delete then save — frame absent from output
40. Delete frame between prose — prose gap closes

## Text Label Edit (41-50)
41. Double-click text label — enters edit mode
42. Type character in text edit — label updates
43. Arrow keys move caret inside text frame
44. Backspace deletes previous grapheme (including emoji)
45. Enter exits text-edit mode
46. Escape exits text-edit preserving edits
47. Long label overflows visually (ghost preview)
48. Delete all text — empty label, frame persists
49. Click elsewhere exits text edit
50. Text edit undo restores previous label

## Prose Editing (51-62)
51. Click prose positions cursor near grapheme boundary
52. Typing updates rendered lines
53. Arrow left/right across grapheme clusters (emoji)
54. Arrow up/down maintain approximate column across wraps
55. Backspace deletes character
56. Backspace at line start merges with previous
57. Enter splits prose line
58. Typing near frame reflows around obstacle
59. Deleting prose causes reflow recomputation
60. Escape clears prose cursor
61. Typing after selecting frame — no prose mutation without click
62. Prose undo restores exact previous text

## Undo/Redo (63-70)
63. Undo frame move restores position
64. Redo frame move reapplies position
65. Undo resize restores geometry
66. Undo chain: move then resize — unwinds in reverse
67. Interleaved undo across frame and prose — one history
68. Undo text-edit restores label
69. Undo delete restores frame
70. Delete child → undo → move parent — consistent

## Serialization (71-76)
71. Save without edits is idempotent
72. Save after move clears dirty state
73. Save after delete removes original cells
74. Save after resize blanks old footprint
75. Round-trip after edit preserves frame tree semantics
76. serializeDocument matches saveDocument

## Layout & Reflow (77-79)
77. Window resize recomputes prose layout
78. Scroll large document — visible rendering intact
79. Large doc with many frames loads within time budget

## Stress (80-83)
80. 20 sequential drags — no blank canvas
81. Rapid save after edit — no lost keystroke
82. Rapid undo/redo — no crash
83. Autosave timer — no interference with manual save

## Error States (84)
84. Open-file on unsupported env — graceful failure

## Tools (85-98)
85. R key enters rect draw mode
86. Draw rect on empty space — creates frame
87. Tiny rect (< 1 cell) — ignored
88. Click frame in draw mode — reverts to select
89. L key — line draw tool
90. T key — text placement tool
91. Text placement backspace edits pending text
92. Escape cancels pending text placement
93. V key returns to select mode
94. Z-order ] brings forward
95. Z-order [ sends backward
96. Mod+] sends to front
97. Mod+[ sends to back
98. Z-order on nested child — defined behavior

## Visual (99-107)
99. Selection overlay survives scroll
100. Selection overlay aligns after scroll
101. Cursor blink in prose and text-edit only
102. Rendered prose never inside frame obstacle
103. Frame text clipping stays inside bounds
104. No-edit save/reload screenshot fidelity
105. Move save/reload screenshot fidelity
106. Resize save/reload screenshot fidelity
107. Text-edit save/reload screenshot fidelity

## Edge Cases (108-120)
108. Delete from junction — no orphan junction chars
109. Malformed mixed-content — no exceptions
110. Tabs in prose — no positioning crash
111. CRLF input round-trips safely
112. 10,000-char prose line — no overflow crash
113. 5+ levels nested frames — no recursion issues
114. Hit-test near frame borders — correct selection
115. Double-click timing — doesn't start drag
116. Mouse-up after drag finalizes cleanly
117. clearState hook resets all interaction state
118. selectFrame hook selects exact frame
119. Rendered line source mapping coherent after edits
120. Comprehensive mixed workflow — 10+ operations, no errors
