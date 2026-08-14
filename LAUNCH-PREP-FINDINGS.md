# Launch-prep findings — handoff for the next agent

**Session date:** 2026-08-14
**Branch:** `claude/code-review-launch-prep-16ss3j`, merged to `main` at `cec620a`.
**State at handoff:** vitest 718 passed (+1 `it.fails` pin), harness e2e **143/143**,
build clean, full e2e sweep **32 failing** (was 91 at session start; was 148 on the
pre-session code for the same five spec files). Working tree clean, everything pushed.

Note: the older `HANDOFF.md` and parts of `DEBUG_PLAN.md` describe a superseded
worktree (`feature/add-frame-fix`) and predate this session. Where they conflict
with this doc, this doc wins.

---

## How to run things (environment gotchas)

- **Playwright browser:** on machines without the pinned Playwright download, set
  `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` (or any Chromium binary). The
  config picks it up via `launchOptions.executablePath`.
- **Dev server:** e2e baseURL is `http://localhost:5177/` (override with
  `GRIDPAD_URL`). Start with `npx vite --port 5177`.
- **Do not trust the line reporter's tail for pass/fail counts.** A run that
  prints only `N passed` at the tail can still contain failures listed above the
  fold. Use `--reporter=json` and count statuses. This bit me once; it will bite
  you.
- `e2e/artifacts/` and `e2e/screenshots/` are untracked write-only dumps now.
  The sweep's `output.md` artifacts are the fastest way to see what a failing
  test actually produced.
- Model-level repro beats e2e forensics. `src/sweepFidelity.diag.test.ts` runs
  the four hardest fixtures through load→save (fidelity) and save→reload→save
  (convergence) in ~2s and prints per-line diffs. Set `DUMP_TREE=1` to also dump
  frame trees. Extend its `FIXTURES` map for new cases.

## What was fixed this session (mechanisms, not just symptoms)

1. **Accelerator handling** (`DemoV2.tsx`): modifier detection was
  platform-sniffed; Meta chords on non-Mac fell through into the character-insert
  path (typed a literal "z" on undo). Now `metaKey || ctrlKey`.
2. **Drags released outside the canvas never committed** (`DemoV2.tsx`):
  `onMouseUp` was canvas-bound; releases past the edge left the gesture
  uncommitted and undo-invisible. Window-level mouseup now catches all releases;
  handler is ref-guarded (double-fire safe).
3. **Self-promote corruption guard** (`editorState.ts` `decideReparent`): a
  no-hit release landing entirely inside the source band's own rows is `none`,
  not `promote` — the promote path near doc end emptied the band and destroyed
  the prose below (apply-layer bug, still pinned as `it.fails` in
  `ghostOnDragPastEnd.diag.test.ts`).
4. **Invisible armed-tool trap**: r/l/t/v are bare hotkeys; stray typing with a
  frame selected armed a tool and hijacked every later prose click. Escape now
  universally disarms; armed tools show crosshair/text cursors; text-tool click
  on prose places a prose cursor instead of stacking a label.
5. **Overscroll blank page**: spacer height now subtracts the sticky canvas's
  viewport-height contribution.
6. **Prose text selection suite** (`proseRange.ts` + DemoV2 wiring): drag-select,
  dblclick word, shift extension, Cmd+A, replace-on-type, forward delete
  (`proseDeleteAfter`), copy/cut/paste. Range deletion is band-aware (frames
  wholly inside the range are deleted via `applyDeleteFrame` bottom-up, then one
  text change; endpoints on claimed rows refuse). Clipboard reads the
  *serialized* view so wireframes copy as ASCII art. **Invariant that matters:**
  the selection anchor must collapse after every gesture/edit — a stale
  collapsed anchor plus a moved cursor fabricates a phantom selection that eats
  the next keystroke.
7. **Browser file fallbacks** (`fileBackend.browser.ts`): `input[type=file]` /
  blob download when the File System Access API is missing (Firefox/Safari).
8. **Scanner/serializer fidelity** (`scanner.ts`, `frame.ts`, `autoLayout.ts`):
   - Single-cell wire runs that are structurally connected (flowchart stems)
     are promoted to line frames instead of being silently swallowed; `┬`/`┴`
     border junctions regenerate via `repairJunctions` once the stem exists.
     Guard: not promoted when flanked by text (`A│B`) — keeps the "rogue │ in
     prose" behavior.
   - `squareRectCells` (frame.ts): rect border cells are squared to the bbox
     after scan. The ±1-drift tracer produced literal cells misaligned with the
     frame geometry → skewed renders that degraded each save/reload cycle.
   - `extractRectStyle` validates corners — a drifted corner used to read `" "`
     into `style.bl`, baking corruption into all future renders.
   - Wall-stray absorption (frame.ts) covers 1-col vertical line children flush
     against a rect wall from *either* side (ragged-outward and ragged-inward
     art) spanning interior rows.
   - `reparentChildren` (autoLayout.ts): TEXT children must *start* within the
     parent rect's rows. The one-row capture tolerance (for labels on shared
     border rows) used to swallow a prose paragraph sitting flush below a
     dragged box — the paragraph became a frame label on save.

## The remaining 32 sweep failures — ranked for the next agent

Run `npx playwright test e2e/sweep.spec.ts --reporter=json` for the live list.
Categories, with what I know:

### 1. Polyline connector bends — user-journey (6), decision-flowchart ghosts (2-ish)

**The biggest one, and it needs a design decision.** L-shaped connectors
(`┌───┤ box ├───┐` rails, elbow bends routing around boxes) have **no model
representation** — `ScannedLine`/line frames are straight segments only. The
corner glyphs at bends (`┌ ┐ └ ┘` used as elbows, not box corners) are single
unclaimed wire cells → swallowed by the wire-only text filter → destroyed on
save. Verified diff (user-journey, any op):

```
input:   ┌────┤  Sign Up     ├────┐        output:    ────┤  Sign Up     ├────
         │    │  Form        │    │                       │  Form        │
```

The straight `───` runs survive (line frames); the elbows and the rails' verticals
vanish or go ghost. Options I'd weigh: (a) polyline/elbow line frames (scanner
traces bends; line cells already support arbitrary cell maps — `buildLineCells`
is the constraint), (b) promote single unclaimed corner glyphs with ≥2 wire
neighbors into 1-cell line frames (cheap, preserves-on-save, no drag semantics),
(c) a verbatim "decoration" overlay layer for unclaimed wire cells inside band
rows. Option (b) is probably an afternoon and fixes preservation without new
interaction semantics; I'd start there.

### 2. Non-convergence on dense ragged fixtures — enterprise-dashboard (6), crm-workspace (6)

`ENTERPRISE_DASHBOARD` (e2e/test-utils.ts) is the stress fixture: multiple
adjacent ragged boxes whose row-level misalignments interact. Round-1 output
still contains artifacts (`┬┤` at row ends, half-rendered inner boxes) that
degrade on re-scan. The systemic fixes above got chat-ui and decision-flowchart
converging; these two need per-diff forensics. Method that works: paste the
fixture into `sweepFidelity.diag.test.ts`, look at the FIDELITY diff lines,
find which box produced each artifact (`DUMP_TREE=1`), and trace whether the
bad cells come from scan claims, layer cells, or junction repair. crm-workspace
I never analyzed — it may share the enterprise mechanisms or have its own.

### 3. Nested resize convergence — nested/with-children/multi-section/default (6-ish)

`resize-larger`/`resize-smaller` on boxes with children produce non-convergent
output (children/parent geometry disagreements across re-scan). Related pin:
the over-shrink degenerate case in `diagnostic.test.ts` ("nested resize-smaller")
now converges in 3 cycles instead of 2 — that was a deliberate trade for stem
preservation. The sweep wants convergence in 1 (save == save-after-reload).

### 4. Frame-count on signup-form/admin-panel (4)

Same class as the fixed prose-theft, but a different capture: after
drag-down/resize the re-scan nests something differently. Reproduce with the
model-level pattern from this session (see git history for
`treeStability.diag.test.ts` — deleted, but the pattern is 10 lines: scan input,
mutate, serialize, re-scan, diff `flattenTree` counts).

### 5. `dragSelected: frame didn't move` (4)

Not a bug — Fix 14 clamping. These fixtures have no blank rows below the
diagram, so drag-down-80 legitimately clamps to zero motion, and the test-utils
helper throws. Either the helper learns "fully clamped is a legal outcome"
(risk: masks real regressions) or the app learns drag-past-end extends the doc
(a real feature users will want — Figma-style infinite canvas it is not). The
owner should pick.

## Known-open items outside the sweep

- **Apply-layer reparent bug** (deferred, pinned `it.fails` in
  `ghostOnDragPastEnd.diag.test.ts`): `applyReparentFrame` promote past doc end
  corrupts state. Guarded at the decision oracle in production. Rewrite plan:
  `docs/plans/2026-05-04-reparent-step-rewrite.md`.
- **Wrapper asymmetry** (owner-deferred, `DEBUG_PLAN.md`): scanner wraps
  multi-rect bands at load; runtime add doesn't. Root of several tree-shape
  quirks. Decision was "wrapping should be a human gesture (multi-select +
  group)"; the multi-select UX doesn't exist yet.
- **WebKit/Tauri untested this session**: no WebKit build in the environment.
  The original "can't edit text" report was reproduced and fixed as the
  armed-tool trap in Chromium, but if the reporter was on the Tauri app
  (WKWebView), re-verify there.
- **Cmd+A endpoints on claimed rows**: if the doc starts or ends with a
  wireframe, Cmd+A selection endpoints sit on claimed rows, so
  delete-all refuses (copy works). Cosmetic; snap endpoints to the nearest
  unclaimed row if it ever matters.

## Test-infra facts worth knowing

- `e2e/test-utils.ts` drag/resize helpers now have a full-tree fallback
  (eager-bands nesting means the selected leaf may not be in flat `getFrames`).
  The harness spec has its own older copies of these helpers — divergence
  between the two copies caused confusing "not found" errors; consider
  deduplicating.
- Five specs used to hardcode `localhost:5173`; they're baseURL-relative now.
- `smoke.spec.ts`/`workflows.spec.ts` had coordinates from a pre-line-height
  layout; magic pixel coordinates in specs rot every time fonts change —
  prefer `__gridpad.getFrameRects()`-derived positions.
- The sweep's "Frame count" assertion compares `flattenTree` length before the
  op vs after save+reload — it's really a tree-shape-stability assertion.
