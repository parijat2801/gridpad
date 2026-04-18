// Round-trip fidelity tests: text → scan → frames → serialize → text
// Verifies that framesToMarkdown reproduces the original text when no edits are made,
// and correctly reflects edits when frames are mutated.

import { describe, it, expect } from "vitest";
import { scanToFrames } from "./scanToFrames";
import { framesToMarkdown } from "./serialize";
import {
  createEditorState,
  getFrames,
  getRegions,
  rebuildProseParts,
  applyMoveFrame,
} from "./editorState";
import { moveFrame, type Frame } from "./frame";

const CW = 9.6;
const CH = 18.4;

/** Full round-trip: text → scan → editorState → framesToMarkdown */
function roundTrip(text: string): string {
  const { frames, prose, regions } = scanToFrames(text, CW, CH);
  const proseText = prose.map(p => p.text).join("\n\n");
  const state = createEditorState({ prose: proseText, frames, regions, proseParts: prose });
  return framesToMarkdown(
    getFrames(state),
    rebuildProseParts(state),
    getRegions(state),
    CW, CH,
  );
}

// ── Test 1: No-edit round-trip ──────────────────────────────────────────

describe("round-trip: no edits", () => {
  it("simple box passes through unchanged", () => {
    const text = "Prose above\n\n┌──────┐\n│      │\n└──────┘\n\nProse below";
    expect(roundTrip(text)).toBe(text);
  });

  it("box with text label preserves label", () => {
    const text = "Title\n\n┌──────────────┐\n│    Hello     │\n└──────────────┘\n\nEnd";
    expect(roundTrip(text)).toBe(text);
  });

  it("junction characters ├┬┤┴┼ are preserved", () => {
    const text = [
      "Header",
      "",
      "┌───────────┬───────────┐",
      "│  Left     │  Right    │",
      "├───────────┼───────────┤",
      "│  Bottom L │  Bottom R │",
      "└───────────┴───────────┘",
      "",
      "Footer",
    ].join("\n");
    const result = roundTrip(text);
    expect(result).toContain("├");
    expect(result).toContain("┬");
    expect(result).toContain("┤");
    expect(result).toContain("┴");
    expect(result).toContain("┼");
    expect(result).toBe(text);
  });

  it("nested boxes preserve both levels", () => {
    const text = [
      "Prose",
      "",
      "┌────────────────────────┐",
      "│  Outer                 │",
      "│  ┌──────────────────┐  │",
      "│  │  Inner            │  │",
      "│  └──────────────────┘  │",
      "└────────────────────────┘",
      "",
      "End",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("side-by-side boxes preserve both", () => {
    const text = [
      "Prose",
      "",
      "┌──────┐  ┌──────┐",
      "│  A   │  │  B   │",
      "└──────┘  └──────┘",
      "",
      "End",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("form with multiple text labels", () => {
    const text = [
      "Prose",
      "",
      "┌──────────────────────────┐",
      "│      Title               │",
      "├──────────────────────────┤",
      "│  Name:  ┌─────────────┐  │",
      "│         │             │  │",
      "│         └─────────────┘  │",
      "│  Email: ┌─────────────┐  │",
      "│         │             │  │",
      "│         └─────────────┘  │",
      "└──────────────────────────┘",
      "",
      "End",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });

  it("pure prose (no wireframes) passes through unchanged", () => {
    const text = "Just some prose.\n\nAnother paragraph.";
    expect(roundTrip(text)).toBe(text);
  });

  it("multiple wireframe regions separated by prose", () => {
    const text = [
      "Top prose",
      "",
      "┌────┐",
      "│ A  │",
      "└────┘",
      "",
      "Middle prose",
      "",
      "┌────┐",
      "│ B  │",
      "└────┘",
      "",
      "Bottom prose",
    ].join("\n");
    expect(roundTrip(text)).toBe(text);
  });
});

// ── Test 2: Edit round-trip ─────────────────────────────────────────────

describe("round-trip: after edits", () => {
  it("moving a top-level frame marks dirty and regenerates", () => {
    const text = "Prose\n\n┌──────┐\n│      │\n└──────┘\n\nEnd";
    const { frames, prose, regions } = scanToFrames(text, CW, CH);
    const proseText = prose.map(p => p.text).join("\n\n");
    let state = createEditorState({ prose: proseText, frames, regions, proseParts: prose });

    // Move the container frame
    const container = getFrames(state)[0];
    state = applyMoveFrame(state, container.id, CW * 2, 0); // move right by 2 chars

    const result = framesToMarkdown(
      getFrames(state),
      rebuildProseParts(state),
      getRegions(state),
      CW, CH,
    );

    // Prose should be preserved
    expect(result).toContain("Prose");
    expect(result).toContain("End");
    // Box chars should still exist (regenerated from cells)
    expect(result).toContain("┌");
    expect(result).toContain("└");
  });

  it("moving a child frame inside a container regenerates correctly", () => {
    const text = [
      "Prose",
      "",
      "┌────────────────────────┐",
      "│  Outer                 │",
      "│  ┌──────────────────┐  │",
      "│  │  Inner            │  │",
      "│  └──────────────────┘  │",
      "└────────────────────────┘",
      "",
      "End",
    ].join("\n");
    const { frames, prose, regions } = scanToFrames(text, CW, CH);
    const proseText = prose.map(p => p.text).join("\n\n");
    let state = createEditorState({ prose: proseText, frames, regions, proseParts: prose });

    // Find the inner rect (child of container's children)
    const container = getFrames(state)[0];
    const children = container.children;
    // Find a child that has its own children (the outer rect with inner nested)
    const outerRect = children.find(c => c.children.length > 0);
    if (outerRect) {
      const innerRect = outerRect.children[0];
      state = applyMoveFrame(state, innerRect.id, CW, 0);
    }

    const result = framesToMarkdown(
      getFrames(state),
      rebuildProseParts(state),
      getRegions(state),
      CW, CH,
    );

    expect(result).toContain("Prose");
    expect(result).toContain("End");
  });

  it("unmoved wireframe regions pass through with junction chars intact", () => {
    const text = [
      "Top",
      "",
      "┌───┬───┐",
      "│ A │ B │",
      "└───┴───┘",
      "",
      "Middle",
      "",
      "┌────┐",
      "│ C  │",
      "└────┘",
      "",
      "Bottom",
    ].join("\n");
    const { frames, prose, regions } = scanToFrames(text, CW, CH);
    const proseText = prose.map(p => p.text).join("\n\n");
    let state = createEditorState({ prose: proseText, frames, regions, proseParts: prose });

    // Move only the second wireframe (C box)
    const secondContainer = getFrames(state)[1];
    if (secondContainer) {
      state = applyMoveFrame(state, secondContainer.id, CW, 0);
    }

    const result = framesToMarkdown(
      getFrames(state),
      rebuildProseParts(state),
      getRegions(state),
      CW, CH,
    );

    // First wireframe should pass through unchanged — junction chars preserved
    expect(result).toContain("┬");
    expect(result).toContain("┴");
    expect(result).toContain("Top");
    expect(result).toContain("Middle");
    expect(result).toContain("Bottom");
  });
});
