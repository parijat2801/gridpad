import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { scanToFrames } from "./scanToFrames";
import { framesToMarkdown } from "./serialize";
import {
  createEditorState, getFrames, getRegions, rebuildProseParts,
  applyMoveFrame, applyResizeFrame, applyDeleteFrame, applyAddFrame,
  proseInsert, editTextFrameEffect, setRegionsEffect, getDoc,
} from "./editorState";
import { Transaction } from "@codemirror/state";
import { createRectFrame, createTextFrame } from "./frame";

const CW = 9.6;
const CH = 18.4;
const LOG: string[] = [];
const L = (s: string) => LOG.push(s);

function makeState(text: string) {
  const { frames, prose, regions } = scanToFrames(text, CW, CH);
  const proseText = prose.map(p => p.text).join("\n\n");
  return { state: createEditorState({ prose: proseText, frames, regions, proseParts: prose }), regions };
}

function serialize(state: ReturnType<typeof createEditorState>, regions: ReturnType<typeof getRegions>) {
  return framesToMarkdown(getFrames(state), rebuildProseParts(state), regions, CW, CH);
}

const SIMPLE = "Prose\n\n┌──────┐\n│      │\n└──────┘\n\nEnd";
const NESTED = "Prose\n\n┌────────────────────────┐\n│  Outer                 │\n│  ┌──────────────────┐  │\n│  │  Inner            │  │\n│  └──────────────────┘  │\n└────────────────────────┘\n\nEnd";
const JUNCTION = "Header\n\n┌───────────┬───────────┐\n│  Left     │  Right    │\n├───────────┼───────────┤\n│  Bottom L │  Bottom R │\n└───────────┴───────────┘\n\nFooter";
const SIDE_BY_SIDE = "Prose\n\n┌──────┐  ┌──────┐\n│  A   │  │  B   │\n└──────┘  └──────┘\n\nEnd";
const MULTI_WIRE = "Top\n\n┌────┐\n│ X  │\n└────┘\n\nMiddle\n\n┌────┐\n│ Y  │\n└────┘\n\nBottom";
const WITH_TEXT = "Prose\n\n┌──────────────┐\n│    Hello     │\n└──────────────┘\n\nEnd";

describe("round-trip: no edits", () => {
  it("simple box", () => {
    const { state, regions } = makeState(SIMPLE);
    const result = serialize(state, regions);
    L("\n=== NO-EDIT: simple box ===");
    L(`Match: ${result === SIMPLE}`);
    if (result !== SIMPLE) L(`Got: ${JSON.stringify(result)}`);
  });

  it("junction chars", () => {
    const { state, regions } = makeState(JUNCTION);
    const result = serialize(state, regions);
    L("\n=== NO-EDIT: junction ===");
    L(`Match: ${result === JUNCTION}`);
    L(`├:${result.includes("├")} ┬:${result.includes("┬")} ┼:${result.includes("┼")} ┴:${result.includes("┴")} ┤:${result.includes("┤")}`);
  });

  it("nested box", () => {
    const { state, regions } = makeState(NESTED);
    const result = serialize(state, regions);
    L("\n=== NO-EDIT: nested ===");
    L(`Match: ${result === NESTED}`);
  });

  it("side-by-side with text", () => {
    const { state, regions } = makeState(SIDE_BY_SIDE);
    const result = serialize(state, regions);
    L("\n=== NO-EDIT: side-by-side ===");
    L(`Match: ${result === SIDE_BY_SIDE}`);
    L(`Has A: ${result.includes("A")} Has B: ${result.includes("B")}`);
  });

  it("multiple wireframe regions", () => {
    const { state, regions } = makeState(MULTI_WIRE);
    const result = serialize(state, regions);
    L("\n=== NO-EDIT: multi-wireframe ===");
    L(`Match: ${result === MULTI_WIRE}`);
  });

  it("box with text label", () => {
    const { state, regions } = makeState(WITH_TEXT);
    const result = serialize(state, regions);
    L("\n=== NO-EDIT: text label ===");
    L(`Match: ${result === WITH_TEXT}`);
    L(`Has Hello: ${result.includes("Hello")}`);
  });
});

describe("round-trip: drag/move", () => {
  it("move top-level container", () => {
    const { state: s0, regions } = makeState(SIMPLE);
    const f = getFrames(s0)[0];
    const s1 = applyMoveFrame(s0, f.id, CW * 2, 0);
    const result = serialize(s1, regions);
    L("\n=== MOVE: top-level container ===");
    L(`Has ┌: ${result.includes("┌")} Has └: ${result.includes("└")}`);
    L(`Prose preserved: ${result.includes("Prose")} ${result.includes("End")}`);
    L(`Output: ${JSON.stringify(result)}`);
  });

  it("move child inside nested container", () => {
    const { state: s0, regions } = makeState(NESTED);
    const container = getFrames(s0)[0];
    // Find a grandchild to move
    let moved = false;
    for (const child of container.children) {
      if (child.children.length > 0) {
        const gc = child.children[0];
        const s1 = applyMoveFrame(s0, gc.id, CW, CH);
        const result = serialize(s1, regions);
        L("\n=== MOVE: grandchild in nested ===");
        L(`Has Outer: ${result.includes("Outer")} Has Inner: ${result.includes("Inner")}`);
        L(`Output: ${JSON.stringify(result)}`);
        moved = true;
        break;
      }
    }
    if (!moved) L("\n=== MOVE: nested — no grandchild found ===");
  });

  it("unmoved wireframe preserves junction chars", () => {
    const { state: s0, regions } = makeState(MULTI_WIRE);
    // Move only the second wireframe
    const frames = getFrames(s0);
    if (frames.length >= 2) {
      const s1 = applyMoveFrame(s0, frames[1].id, CW, 0);
      const result = serialize(s1, regions);
      L("\n=== MOVE: unmoved region junction preservation ===");
      L(`Has X: ${result.includes("X")} Has Y: ${result.includes("Y")}`);
      L(`Output: ${JSON.stringify(result)}`);
    }
  });
});

describe("round-trip: resize", () => {
  it("resize top-level container", () => {
    const { state: s0, regions } = makeState(SIMPLE);
    const f = getFrames(s0)[0];
    const s1 = applyResizeFrame(s0, f.id, f.w + CW * 4, f.h + CH * 2, CW, CH);
    const result = serialize(s1, regions);
    L("\n=== RESIZE: top-level ===");
    L(`Has ┌: ${result.includes("┌")} Has └: ${result.includes("└")}`);
    L(`Output: ${JSON.stringify(result)}`);
  });
});

describe("round-trip: delete", () => {
  it("delete top-level frame", () => {
    const { state: s0, regions } = makeState(MULTI_WIRE);
    const frames = getFrames(s0);
    const s1 = applyDeleteFrame(s0, frames[0].id);
    const result = serialize(s1, regions);
    L("\n=== DELETE: top-level frame ===");
    L(`Frames remaining: ${getFrames(s1).length}`);
    L(`Output: ${JSON.stringify(result)}`);
  });

  it("delete child inside container", () => {
    const { state: s0, regions } = makeState(NESTED);
    const container = getFrames(s0)[0];
    if (container.children.length > 0) {
      const child = container.children[0];
      const s1 = applyDeleteFrame(s0, child.id);
      const result = serialize(s1, regions);
      L("\n=== DELETE: child inside container ===");
      L(`Container children after: ${getFrames(s1)[0].children.length}`);
      L(`Output: ${JSON.stringify(result)}`);
    }
  });
});

describe("round-trip: add frame", () => {
  it("add new rect frame", () => {
    const { state: s0, regions } = makeState("Just prose\n\nMore prose");
    const f = createRectFrame({ gridW: 6, gridH: 3, style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: CW, charHeight: CH });
    const s1 = applyAddFrame(s0, { ...f, x: 0, y: 0 });
    const result = serialize(s1, regions);
    L("\n=== ADD: new rect frame ===");
    L(`Frames: ${getFrames(s1).length}`);
    L(`Output: ${JSON.stringify(result)}`);
    L(`Note: added frames are NOT in any wireframe region — serialize ignores them`);
  });
});

describe("round-trip: text frame edit", () => {
  it("edit text label inside rect", () => {
    const { state: s0, regions } = makeState(WITH_TEXT);
    const container = getFrames(s0)[0];
    // Find text frame
    let edited = false;
    for (const child of container.children) {
      if (child.content?.type === "text" && child.content.text) {
        const s1 = s0.update({
          effects: editTextFrameEffect.of({ id: child.id, text: "World", charWidth: CW }),
          annotations: Transaction.addToHistory.of(true),
        }).state;
        const result = serialize(s1, regions);
        L("\n=== TEXT EDIT: change Hello to World ===");
        L(`Has World: ${result.includes("World")} Has Hello: ${result.includes("Hello")}`);
        L(`Output: ${JSON.stringify(result)}`);
        edited = true;
        break;
      }
    }
    if (!edited) {
      // Check grandchildren
      for (const child of container.children) {
        for (const gc of child.children) {
          if (gc.content?.type === "text" && gc.content.text) {
            const s1 = s0.update({
              effects: editTextFrameEffect.of({ id: gc.id, text: "World", charWidth: CW }),
              annotations: Transaction.addToHistory.of(true),
            }).state;
            const result = serialize(s1, regions);
            L("\n=== TEXT EDIT: change label to World (grandchild) ===");
            L(`Has World: ${result.includes("World")}`);
            L(`Output: ${JSON.stringify(result)}`);
            edited = true;
            break;
          }
        }
        if (edited) break;
      }
    }
    if (!edited) L("\n=== TEXT EDIT: no text frame found ===");
  });
});

describe("round-trip: prose editing", () => {
  it("insert character in prose", () => {
    const { state: s0, regions } = makeState(SIMPLE);
    const s1 = proseInsert(s0, { row: 0, col: 5 }, "!");
    const result = serialize(s1, regions);
    L("\n=== PROSE: insert char ===");
    L(`Has Prose!: ${result.includes("Prose!")}`);
    L(`Output: ${JSON.stringify(result)}`);
  });

  it("insert newline in prose (Enter) — with region shift", () => {
    const { state: s0, regions: origRegions } = makeState(SIMPLE);
    const beforeRow = 0;
    const s1 = proseInsert(s0, { row: beforeRow, col: 5 }, "\n");
    // Simulate DemoV2's region shift after Enter
    const updatedRegions = origRegions.map(r => {
      if (r.type === "prose" && r.startRow <= beforeRow && r.endRow >= beforeRow) {
        return { ...r, endRow: r.endRow + 1 };
      }
      if (r.startRow > beforeRow) {
        return { ...r, startRow: r.startRow + 1, endRow: r.endRow + 1 };
      }
      return r;
    });
    const s2 = s1.update({ effects: setRegionsEffect.of(updatedRegions) }).state;
    const result = serialize(s2, getRegions(s2));
    L("\n=== PROSE: insert newline (with region shift) ===");
    L(`Has Prose: ${result.includes("Prose")} Has End: ${result.includes("End")}`);
    L(`Has ┌: ${result.includes("┌")}`);
    L(`Output: ${JSON.stringify(result)}`);
  });

  it("multi-region prose edit", () => {
    const { state: s0, regions } = makeState(MULTI_WIRE);
    L("\n=== PROSE: multi-region edit (debug) ===");
    L(`CM doc before: ${JSON.stringify(getDoc(s0))}`);
    L(`Regions:`);
    for (const r of regions) L(`  ${r.type} [${r.startRow}-${r.endRow}] text=${JSON.stringify(r.text)}`);
    L(`rebuildProseParts before:`);
    for (const p of rebuildProseParts(s0)) L(`  startRow=${p.startRow} text=${JSON.stringify(p.text)}`);

    const s1 = proseInsert(s0, { row: 2, col: 6 }, " text");
    L(`CM doc after: ${JSON.stringify(getDoc(s1))}`);
    L(`rebuildProseParts after:`);
    for (const p of rebuildProseParts(s1)) L(`  startRow=${p.startRow} text=${JSON.stringify(p.text)}`);

    const result = serialize(s1, regions);
    L(`Has 'Middle text': ${result.includes("Middle text")}`);
    L(`Output: ${JSON.stringify(result)}`);
  });
});

describe("flush log", () => {
  it("write", () => {
    writeFileSync("/tmp/roundtrip-full.log", LOG.join("\n") + "\n");
    expect(true).toBe(true);
  });
});
