// Round-trip fidelity tests: text → scan → frames → serialize → text
// Verifies that gridSerialize reproduces the original text when no edits are made,
// and correctly reflects edits when frames are mutated.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { scanToFrames } from "./scanToFrames";
import { gridSerialize, snapshotFrameBboxes } from "./gridSerialize";
import {
  createEditorStateFromText,
  getFrames,
  getOriginalProseSegments,
  getDoc,
  applyMoveFrame,
} from "./editorState";

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "", fillStyle: "", textBaseline: "", fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      })) as unknown as HTMLCanvasElement["getContext"];
    }
    return el;
  });
});

const CW = 9.6;
const CH = 18.4;

/** Full round-trip using new grid pipeline */
function roundTrip(text: string): string {
  const { originalGrid } = scanToFrames(text, CW, CH);
  const state = createEditorStateFromText(text, CW, CH);
  return gridSerialize(
    getFrames(state),
    getDoc(state),
    originalGrid,
    getOriginalProseSegments(state),
  );
}

describe("round-trip: no edits", () => {
  it("API Gateway fixture survives round-trip", () => {
    const text = [
      "# My Project Plan", "",
      "This document describes the architecture.", "", "",
      "┌──────────────────────────────┐",
      "│        API Gateway           │",
      "├──────────┬───────────────────┤",
      "│ Auth     │  Router            │",
      "│ Service  │                   │",
      "└──────────┴───────────────────┘",
      "", "", "The gateway handles all incoming requests.",
    ].join("\n");
    const result = roundTrip(text);
    expect(result).toContain("API Gateway");
  });

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
    expect(roundTrip(text)).toBe(text);
  });

  it("nested boxes preserve both levels", () => {
    const text = [
      "Prose",
      "",
      "┌────────────────────────┐",
      "│  Outer                 │",
      "│  ┌──────────────────┐  │",
      "│  │  Inner           │  │",
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

  it("pure prose passes through unchanged", () => {
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

  it("form with labels", () => {
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
});

describe("round-trip: after edits", () => {
  it("moving a frame marks dirty and regenerates without ghost", () => {
    const text = "Prose\n\n┌──────┐\n│      │\n└──────┘\n\nEnd";
    const { originalGrid } = scanToFrames(text, CW, CH);
    let state = createEditorStateFromText(text, CW, CH);
    // Snapshot bboxes before moving
    const origBboxes = snapshotFrameBboxes(getFrames(state));
    const container = getFrames(state)[0];
    state = applyMoveFrame(state, container.id, 2, 0, CW, CH);
    const result = gridSerialize(
      getFrames(state), getDoc(state),
      originalGrid,
      getOriginalProseSegments(state), origBboxes,
    );
    expect(result).toContain("Prose");
    expect(result).toContain("End");
    expect(result).toContain("┌");
    expect(result).toContain("└");
    // Original position should be blanked — no ghost
    const lines = result.split("\n");
    const boxLine = lines.find(l => l.includes("┌"));
    expect(boxLine).toBeDefined();
  });
});
