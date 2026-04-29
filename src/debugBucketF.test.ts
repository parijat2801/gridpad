// Diagnostic for Bucket F text-label edit
import { describe, it } from "vitest";
import {
  createEditorStateUnified,
  getFrames,
  getTextEdit,
  resolveSelectionTarget,
  selectFrameEffect,
  setTextEditEffect,
  editTextFrameEffect,
  getDoc,
} from "./editorState";
import { serializeUnified } from "./serializeUnified";
import type { Frame } from "./frame";

const cw = 8, ch = 18;

const LABELED_BOX = `Title

┌──────────────┐
│    Hello     │
└──────────────┘

End`;

function dump(frames: Frame[], depth = 0): string {
  const out: string[] = [];
  const walk = (f: Frame, d: number) => {
    const pad = "  ".repeat(d);
    const kind = f.isBand ? "band" : (f.content === null ? "wireframe" : f.content.type);
    const sid = f.id.replace(/^frame-/, "").split("-")[0];
    out.push(`${pad}${kind} id=${sid} grid=(${f.gridRow},${f.gridCol}) ${f.gridW}×${f.gridH} text="${f.content?.text ?? ""}"`);
    for (const c of f.children) walk(c, d + 1);
  };
  for (const f of frames) walk(f, depth);
  return out.join("\n");
}

function findById(frames: Frame[], id: string): Frame | null {
  for (const f of frames) {
    if (f.id === id) return f;
    const c = findById(f.children, id);
    if (c) return c;
  }
  return null;
}

function firstTextChild(frames: Frame[]): Frame | null {
  for (const f of frames) {
    if (f.content?.type === "text") return f;
    const c = firstTextChild(f.children);
    if (c) return c;
  }
  return null;
}

describe("Bucket F text-label diagnostic", () => {
  it("simulates dblclick on Hello label, types !, observes save", () => {
    let state = createEditorStateUnified(LABELED_BOX, cw, ch);
    console.log("\n=== LABELED_BOX initial tree ===");
    console.log(dump(getFrames(state)));

    const text = firstTextChild(getFrames(state));
    if (!text) { console.log("NO TEXT CHILD"); return; }
    console.log(`\nText child: id=${text.id.replace(/^frame-/, "").split("-")[0]} text="${text.content?.text}"`);

    // Step 1: clickFrame(0) — clicks first leaf, which is the text label
    // Mimic: hit = text, selectedId = null, ctrl = false
    const targetId1 = resolveSelectionTarget(text, null, getFrames(state), false);
    console.log(`Step 1 (clickFrame): selects ${targetId1?.replace(/^frame-/, "").split("-")[0]}`);
    state = state.update({ effects: selectFrameEffect.of(targetId1) }).state;

    // Step 2: dblclick first mousedown
    const targetId2 = resolveSelectionTarget(text, targetId1, getFrames(state), false);
    console.log(`Step 2 (dblclick first): selects ${targetId2?.replace(/^frame-/, "").split("-")[0]}`);
    state = state.update({ effects: selectFrameEffect.of(targetId2) }).state;

    // Step 3: dblclick second mousedown — isDblClick=true, hit.content.type === text
    // → directly enters text-edit on hit.id
    const targetId3 = resolveSelectionTarget(text, targetId2, getFrames(state), false);
    console.log(`Step 3 (dblclick second target via resolve): ${targetId3?.replace(/^frame-/, "").split("-")[0]}`);
    console.log(`  But dblclick branch ignores targetId; uses hit.id = ${text.id.replace(/^frame-/, "").split("-")[0]}`);
    state = state.update({
      effects: [
        selectFrameEffect.of(text.id),
        setTextEditEffect.of({ frameId: text.id, col: 0 }),
      ],
    }).state;
    const te = getTextEdit(state);
    console.log(`Text edit state: frameId=${te?.frameId.replace(/^frame-/, "").split("-")[0]} col=${te?.col}`);

    // Step 4: keyboard "End" → set col to text length
    const codepoints = [...(text.content?.text ?? "")];
    state = state.update({
      effects: setTextEditEffect.of({ frameId: text.id, col: codepoints.length }),
    }).state;
    const te2 = getTextEdit(state);
    console.log(`After End: col=${te2?.col} (text length ${codepoints.length})`);

    // Step 5: type "!" → editTextFrameEffect + setTextEditEffect
    const newCp = [...codepoints.slice(0, te2!.col), "!", ...codepoints.slice(te2!.col)];
    const newText = newCp.join("");
    state = state.update({
      effects: [
        editTextFrameEffect.of({ id: text.id, text: newText, charWidth: cw }),
        setTextEditEffect.of({ frameId: text.id, col: te2!.col + 1 }),
      ],
    }).state;
    console.log(`After type "!": new text should be "${newText}"`);
    console.log(`Frame tree after edit:`);
    console.log(dump(getFrames(state)));

    // Step 6: save (serialize)
    const md = serializeUnified(getDoc(state), getFrames(state));
    console.log(`\nSerialized output:\n${md}`);
    console.log(`\nContains "Hello!"? ${md.includes("Hello!")}`);
    console.log(`Contains "Hello"? ${md.includes("Hello")}`);
  });
});
