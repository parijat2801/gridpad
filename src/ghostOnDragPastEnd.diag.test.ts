// Reproducer for: drag-past-doc-end ghost bug.
// e2e artifact: after dragSelected(0, 100) + save on the fixture below,
// output.md contains a phantom "┌──────────────┐" at column 8 and
// "Prose below" is gone. The frame tree is empty (tree-after.json: []).
//
// Root-cause hypothesis (from reading DemoV2.tsx:791-816):
//   On mouseup, decideReparent(frames, draggedId, dropPx, dropPy) is called.
//   The SELECTED frame is the RECT (depth=1), not the BAND (depth=0).
//   When cursor lands past doc end → hitTestFrames returns null.
//   Since draggedTopAncestor (band) !== draggedId (rect), decideReparent
//   returns { kind: "promote" }. applyReparentFrame runs → rect is moved
//   out of band → band is now empty → band gets pruned from the model.
//   Frame tree goes to []. But the serializer writes whatever was in the
//   CM doc at the dropped position → phantom "┌" glyph.
//
// This test exercises the MODEL LAYER (no Playwright).

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  createEditorStateUnified,
  getFrames,
  getDoc,
  applyMoveFrame,
  applyReparentFrame,
  decideReparent,
} from "./editorState";
import { serializeUnified } from "./serializeUnified";

const CW = 9.6;
const CH = 18.4;

// Exact input from e2e/artifacts/drag-down/input.md
const INPUT = "Prose above\n\n┌──────────────┐\n│              │\n│              │\n└──────────────┘\n\nProse below";

beforeAll(() => {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() => ({
        font: "", fillStyle: "", textBaseline: "", fillText: () => {},
        measureText: (text: string) => ({
          width: text.length * CW,
          actualBoundingBoxAscent: 12,
          actualBoundingBoxDescent: 4,
        }),
      })) as unknown as HTMLCanvasElement["getContext"];
    }
    return el;
  });
});

// Walk tree to find first leaf shape (non-band, content !== null)
function findFirstLeafRect(frames: ReturnType<typeof getFrames>): ReturnType<typeof getFrames>[number] | null {
  for (const f of frames) {
    if (!f.isBand && f.content !== null) return f;
    const inChild = findFirstLeafRect(f.children);
    if (inChild) return inChild;
  }
  return null;
}

describe("ghost on drag past doc end — model layer reproducer", () => {
  it("tree structure: band at top level, rect as child", () => {
    const state = createEditorStateUnified(INPUT, CW, CH);
    const frames = getFrames(state);

    // The unified model wraps every claiming frame in a band.
    // The tree should be: band → (wireframe →) rect.
    const band = frames.find(f => f.isBand);
    expect(band, "Should have a top-level band").toBeDefined();

    const leaf = findFirstLeafRect(frames);
    expect(leaf, "Should have a leaf rect").toBeDefined();

    // The selected frame (what clickFrame returns) is the leaf, not the band.
    // draggedTopAncestor !== draggedId when the rect is selected.
    expect(band!.id).not.toBe(leaf!.id);
  });

  it("decideReparent: cursor past doc end triggers spurious promote", () => {
    const state = createEditorStateUnified(INPUT, CW, CH);
    const frames = getFrames(state);

    const leaf = findFirstLeafRect(frames);
    expect(leaf).toBeDefined();

    // Simulate cursor landing past last doc line (e.g., 100px past doc bottom).
    // With 8 lines at CH=18.4: docHeight ≈ 8 * 18.4 = 147.2px
    // A 100px downward drag from ~line 3 lands around y=155px, past doc end.
    const dropPx = leaf!.x + leaf!.w / 2;   // horizontally centered on frame
    const dropPy = (state.doc.lines + 2) * CH; // clearly past doc end

    const docExtentPy = state.doc.lines * CH;
    const decision = decideReparent(frames, leaf!.id, dropPx, dropPy, docExtentPy);

    // BUG: should be "none" (drop outside all frames = no reparent for a band child),
    // but is "promote" because cursor missed all frames and draggedTopAncestor !== draggedId.
    // This assert FAILS, demonstrating the spurious promote:
    expect(
      decision.kind,
      `decideReparent returned '${decision.kind}' for cursor past doc end. ` +
      `Expected 'none' — a child dragged past doc end should not be promoted.`
    ).toBe("none");
  });

  it("applyReparentFrame promote empties the band → frame tree becomes []", () => {
    const state0 = createEditorStateUnified(INPUT, CW, CH);
    const frames0 = getFrames(state0);

    const leaf = findFirstLeafRect(frames0);
    expect(leaf).toBeDefined();

    // Simulate what DemoV2.onMouseUp does when decideReparent returns "promote":
    const docLines = state0.doc.lines;
    const dropPy = (docLines + 2) * CH; // past doc end
    const dropPx = leaf!.x + leaf!.w / 2;
    const aRow = Math.max(0, Math.min(docLines - 1, Math.round(dropPy / CH)));
    const aCol = Math.round(dropPx / CW);

    const state1 = applyReparentFrame(state0, leaf!.id, null, aRow, aCol, CW, CH);
    const frames1 = getFrames(state1);

    // After spurious promote, the band is emptied and pruned.
    // The frame tree should still contain something (the promoted rect as a new band).
    // But in practice, the ghost appears in the serialized output.
    const claimingFrames1 = frames1.filter(f => f.lineCount > 0);

    // Serialize and check for orphan wire characters
    const doc1 = getDoc(state1);
    const saved = serializeUnified(doc1, frames1);
    const savedLines = saved.split("\n");

    const WIRE_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼═║╔╗╚╝╠╣╦╩╬"]);
    const orphans: string[] = [];
    for (let r = 0; r < savedLines.length; r++) {
      for (const ch of [...savedLines[r]]) {
        if (WIRE_CHARS.has(ch)) {
          // Is this row claimed by any frame?
          const inside = claimingFrames1.some(f => r >= f.gridRow && r < f.gridRow + f.lineCount);
          if (!inside) {
            orphans.push(`saved orphan at L${r}: "${savedLines[r]}"`);
          }
        }
      }
    }

    // BUG: after spurious promote the reparented rect claims a row past "Prose below",
    // so serializeUnified renders the wireframe char at a wrong row → ghost.
    expect(
      orphans,
      `Serialized output has orphan wire chars after spurious promote:\n${orphans.join("\n")}\n\nSaved:\n${saved}\n\nDoc:\n${doc1}\n\nFrames: ${JSON.stringify(claimingFrames1.map(f => ({ gridRow: f.gridRow, lineCount: f.lineCount })))}`
    ).toEqual([]);

    // Also assert "Prose below" survived.
    expect(
      saved,
      `"Prose below" was destroyed.\nSaved:\n${saved}`
    ).toContain("Prose below");
  });
});
