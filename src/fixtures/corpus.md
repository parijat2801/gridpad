# Agent-Authored Wireframe Corpus

This file is a curated test fixture for the Gridpad harness. It contains
wireframe patterns that agents actually produce, mixed with prose.
It includes both well-formed and agent-realistic (misaligned) wireframes.

## 1. Simple Dashboard Layout

A basic nested layout with shared walls and text labels.

┌────────────────────────────────────────┐
│            Header / Nav Bar            │
├──────────┬─────────────────────────────┤
│ Sidebar  │  Task List                  │
│          │                             │
│ - Tasks  │  ┌─────────────────────┐   │
│ - Done   │  │ Task: Fix login bug │   │
│          │  │ Status: In Progress │   │
│          │  └─────────────────────┘   │
│          │                             │
└──────────┴─────────────────────────────┘

The sidebar contains navigation items.
The main area shows the task list with cards.

## 2. Vertical Flow Diagram

Boxes connected by vertical arrows — a common agent pattern.
The ▼ in border edges is a KNOWN scanner gap (documented in tests).

    User clicks "Run"
          │
    ┌────────────────────────────┐
    │  API: POST /start-task     │
    │  1. Validate input         │
    │  2. Start task (atomic)    │
    │  3. Return { ok: true }    │
    └─────┬──────────────────────┘
          │ (async)
    ┌─────▼──────────────────────┐
    │  Executor                  │
    │  Runs the task to complete │
    └─────┬──────────────────────┘
          │
    ┌─────▼──────────────────────┐
    │  Evaluation Pipeline       │
    │  Updates status cache      │
    └────────────────────────────┘

This pattern appears in almost every backend plan.

## 3. Relay Race (Horizontal Flow)

Side-by-side boxes with horizontal connectors.

┌──────────┐      ┌──────────┐      ┌──────────┐
│ Check A  │──────│ Check B  │──────│ Check C  │
│ (Form)   │      │ (Agent)  │      │ (Agent)  │
└──────────┘      └──────────┘      └──────────┘

Each check produces data for the next one.

## 4. UI Mockup with Special Characters

Login screen with status indicators and form fields.

┌──────────────────────────────────────────┐
│                                          │
│           Welcome back                   │
│    Sign in to your account to continue   │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  Continue with Google              │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Email                                   │
│  ┌────────────────────────────────────┐  │
│  │ you@example.com                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Password                                │
│  ┌────────────────────────────────────┐  │
│  │ ••••••••                           │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │         Sign In                    │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Don't have an account? Sign up          │
│                                          │
└──────────────────────────────────────────┘

## 5. Progress Bars and Status Indicators

Wireframes with block fill characters.

┌─────────────────────────────────────────────┐
│  CARRIER QUOTES                    5/5 ✓    │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ ████████████████████████████████░░░ │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  COMPLIANCE DOCS                 ⚠ Blocked  │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  CREDIT CHECK                   ● Running   │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░ │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘

## 6. Tree Structure (NOT a wireframe)

This is a dependency tree — box-drawing chars used for hierarchy,
not rectangular shapes. The scanner should NOT detect rects here.

Entry Points (endpoints)
├── chat/index.ts        → tool-executor
├── tasks/index.ts       → shared/errors
├── projects/index.ts    → shared/index
└── core/index.ts        → shared/index

Shared Layer (shared/)
├── index.ts             → barrel re-export
├── types.ts             → base types (leaf)
│   ├── sub-types.ts     → nested
│   └── aliases.ts       → nested
└── errors.ts            → error classes (leaf)

This should remain prose in Gridpad.

## 7. Markdown Horizontal Rules

These dashes are markdown, NOT wireframes.

Some text before.

---

More text after the horizontal rule.

---

And another section after a second rule.

## 8. Navigation with Tree Inside Box

A box containing tree-structure navigation items.

┌─────────────────────────────────────────────┐
│                    COLEX                     │
├─────────────────────────────────────────────┤
│                                             │
│   Inbox              [+ New]                │
│                                             │
│   Work                                      │
│   ├─ Projects        (active work)          │
│   └─ Templates       (reusable)             │
│                                             │
│   Data                                      │
│   ├─ Customers                              │
│   ├─ Suppliers                              │
│   └─ Quotes                                 │
│                                             │
│   Settings                                  │
│   ├─ Connections                            │
│   └─ Team                                   │
│                                             │
├─────────────────────────────────────────────┤
│   Chat (persistent)                         │
└─────────────────────────────────────────────┘

## 9. Two Adjacent Boxes (Shared Walls)

Boxes that share a vertical wall with junction characters.

┌──────┬──────┐
│ Left │Right │
└──────┴──────┘

And two boxes stacked vertically:

┌──────────┐
│   Top    │
├──────────┤
│  Bottom  │
└──────────┘

## 10. Deeply Nested Architecture

Multiple levels of box nesting.

┌─────────────────────────────────────────────────────────┐
│  Frontend                                               │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Component Layer                                  │  │
│  │  ┌────────────────┐  ┌─────────────────────────┐  │  │
│  │  │ TaskList       │  │ TaskDetail              │  │  │
│  │  │ ┌────────────┐ │  │ ┌───────────────────┐   │  │  │
│  │  │ │ TaskCard   │ │  │ │ Output Viewer     │   │  │  │
│  │  │ └────────────┘ │  │ └───────────────────┘   │  │  │
│  │  └────────────────┘  └─────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

This is 4 levels deep — tests nesting limits.

## 11. Malformed Wireframe (Broken Corner)

This box has a missing bottom-right corner. Scanner should handle gracefully.

┌──────────┐
│  Broken  │
└──────────

And a box with mismatched width:

┌──────┐
│ OK   │
└────────┘

## 12. Empty Boxes

Minimal content wireframes.

┌┐
└┘

┌──┐
│  │
└──┘

## 13. Agent Misalignment (Content Wider Than Border)

Agents frequently produce boxes where the text content is wider than
the top/bottom border. This is the MOST COMMON agent mistake.

┌─────────┐
│ Check A  │
│ (Form)   │
└─────────┘

The content rows above are 12 chars wide but the border is 11.
A resilient scanner should still detect this as a rect.

Another common pattern — label overflows right border:

┌────────────────────────────┐
│  Runs the task to completion│
└────────────────────────────┘

The middle row is 1 char wider than the border row.

## 14. Arrow-Edge Boxes (Common Agent Flow Pattern)

Agents embed ▼ and ▲ directly in box borders for flow diagrams.

┌─────▼──────────────────────┐
│  Executor                  │
│  Runs the task             │
└─────┬──────────────────────┘

The ▼ in the top edge breaks the scanner — it's not in H_EDGE.
The ┬ in the bottom edge works because ┬ IS in H_EDGE.
This is a KNOWN GAP that should be fixed for production.

## The End

That's the full corpus. Gridpad should handle all of this gracefully —
parsing what it can, leaving the rest as prose.
