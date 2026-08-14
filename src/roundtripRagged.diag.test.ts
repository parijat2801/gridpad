// Diagnostic: ragged hand-authored boxes (interior wall one col right of the
// corners) must round-trip without doubling walls. Repro of the
// interactive-roundtrip "no edits" failure at the model level.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createEditorStateUnified, getDoc, getFrames } from "./editorState";
import { serializeUnified } from "./serializeUnified";
import type { Frame } from "./frame";

beforeAll(() => {
  const orig = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = orig(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "", fillStyle: "", textBaseline: "", fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * 9.6,
          actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4,
        }),
      })) as unknown as HTMLCanvasElement["getContext"];
    }
    return el;
  });
});

const RAGGED = [
  "Intro",
  "",
  "┌────────────┐  ┌────────────┐",
  "│  Users     │  │  Posts      │",
  "│  id        │  │  id         │",
  "└────────────┘  └────────────┘",
  "",
  "Outro",
].join("\n");

describe("ragged-box roundtrip", () => {
  it("no-edit serialize does not double walls", () => {
    const s = createEditorStateUnified(RAGGED, 9.6, 18);
    const dump = (fs: Frame[], d = 0): string[] =>
      fs.flatMap(f => [
        `${"  ".repeat(d)}${f.content?.type ?? "wrap"} r${f.gridRow} c${f.gridCol} w${f.gridW} h${f.gridH} ${JSON.stringify(f.content?.type === "text" ? f.content.text : "")}`,
        ...dump(f.children, d + 1),
      ]);
    const out = serializeUnified(getDoc(s), getFrames(s));
    // eslint-disable-next-line no-console
    console.log(dump(getFrames(s)).join("\n"));
    // eslint-disable-next-line no-console
    console.log("OUT:\n" + out);
    expect(out).not.toContain("││");
  });
});
