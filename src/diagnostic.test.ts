// Diagnostic tests for e2e failure root causes.
// Each test reproduces a specific failure pattern at the unit level
// to isolate the exact mechanism.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { scanToFrames } from "./scanToFrames";
import {
  gridSerialize,
  snapshotFrameBboxes,
  rebuildOriginalGrid,
  type FrameBbox,
} from "./gridSerialize";
import {
  createEditorStateFromText,
  getFrames,
  getProseSegmentMap,
  getOriginalProseSegments,
  getDoc,
  applyMoveFrame,
  applyResizeFrame,
  applyClearDirty,
  applySetOriginalProseSegments,
  proseInsert,
  getCursor,
  moveCursorTo,
} from "./editorState";
import type { Frame } from "./frame";

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

// ── Helpers ────────────────────────────────────────────────────────

const WIRE_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼═║╔╗╚╝╠╣╦╩╬"]);

/** Detect ghost wire characters not inside any frame bbox */
function findGhosts(
  md: string,
  frames: Frame[],
  cw: number,
  ch: number,
): string[] {
  const bboxes = computeBboxes(frames, cw, ch);
  const lines = md.split("\n");
  const ghosts: string[] = [];
  for (let r = 0; r < lines.length; r++) {
    const chars = [...lines[r]];
    for (let c = 0; c < chars.length; c++) {
      if (!WIRE_CHARS.has(chars[c])) continue;
      const inside = bboxes.some(
        b => r >= b.row && r < b.row + b.h && c >= b.col && c < b.col + b.w,
      );
      if (!inside) {
        ghosts.push(`Ghost '${chars[c]}' at L${r}:${c}: ${lines[r]}`);
      }
    }
  }
  return ghosts;
}

function computeBboxes(
  frames: Frame[],
  cw: number,
  ch: number,
): { row: number; col: number; w: number; h: number }[] {
  const result: { row: number; col: number; w: number; h: number }[] = [];
  const collect = (fs: Frame[], offX: number, offY: number) => {
    for (const f of fs) {
      const absX = offX + f.x;
      const absY = offY + f.y;
      if (f.content) {
        result.push({
          row: Math.round(absY / ch),
          col: Math.round(absX / cw),
          w: Math.round(f.w / cw),
          h: Math.round(f.h / ch),
        });
      }
      collect(f.children, absX, absY);
    }
  };
  collect(frames, 0, 0);
  return result;
}

/** Simulate the full save cycle (serialize + update refs) like DemoV2.saveDocument */
function fullSave(
  state: ReturnType<typeof createEditorStateFromText>,
  originalGrid: string[][],
  frameBboxSnapshot: FrameBbox[],
): { md: string; state: typeof state; originalGrid: string[][]; frameBboxSnapshot: FrameBbox[] } {
  const md = gridSerialize(
    getFrames(state), getDoc(state),
    getProseSegmentMap(state), originalGrid,
    CW, CH,
    getOriginalProseSegments(state),
    frameBboxSnapshot,
  );
  // Same ref updates as DemoV2.saveDocument
  let newState = applyClearDirty(state);
  const { proseSegments: newSegs } = scanToFrames(md, CW, CH);
  newState = applySetOriginalProseSegments(newState, newSegs);
  const newGrid = rebuildOriginalGrid(md);
  const newSnapshot = snapshotFrameBboxes(getFrames(newState), CW, CH);
  return { md, state: newState, originalGrid: newGrid, frameBboxSnapshot: newSnapshot };
}

/** Load markdown → state + refs, like DemoV2.loadDocument */
function fullLoad(text: string) {
  const state = createEditorStateFromText(text, CW, CH);
  const { originalGrid } = scanToFrames(text, CW, CH);
  const frameBboxSnapshot = snapshotFrameBboxes(getFrames(state), CW, CH);
  return { state, originalGrid, frameBboxSnapshot };
}

/** Full round-trip: load → save → reload → save → compare */
function convergenceCheck(md: string, mutate: (s: ReturnType<typeof fullLoad>) => ReturnType<typeof fullLoad>["state"]): {
  saved1: string;
  saved2: string;
  converged: boolean;
  ghosts1: string[];
  ghosts2: string[];
  frameCount1: number;
  frameCount2: number;
} {
  // Load + mutate + save
  const loaded = fullLoad(md);
  const mutatedState = mutate(loaded);
  const save1 = fullSave(mutatedState, loaded.originalGrid, loaded.frameBboxSnapshot);

  // Reload saved output + save again (no mutation)
  const reloaded = fullLoad(save1.md);
  const save2 = fullSave(reloaded.state, reloaded.originalGrid, reloaded.frameBboxSnapshot);

  // Count frames after each load
  const countFrames = (fs: Frame[]): number => {
    let n = 0;
    for (const f of fs) {
      if (f.content) n++;
      n += countFrames(f.children);
    }
    return n;
  };

  return {
    saved1: save1.md,
    saved2: save2.md,
    converged: save1.md === save2.md,
    ghosts1: findGhosts(save1.md, getFrames(mutatedState), CW, CH),
    ghosts2: findGhosts(save2.md, getFrames(reloaded.state), CW, CH),
    frameCount1: countFrames(getFrames(reloaded.state)),
    frameCount2: countFrames(getFrames(createEditorStateFromText(save2.md, CW, CH))),
  };
}

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 1: GHOSTS — shared wall blanking
// ═══════════════════════════════════════════════════════════════════

describe("diagnostic: ghosts from shared walls", () => {
  const JUNCTION = [
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

  it("junction: inspect frame tree structure after scan", () => {
    const state = createEditorStateFromText(JUNCTION, CW, CH);
    const frames = getFrames(state);
    // Diagnostic: what does the scanner produce?
    console.log("=== JUNCTION FRAME TREE ===");
    const printTree = (fs: Frame[], indent = "") => {
      for (const f of fs) {
        const contentType = f.content?.type ?? "container";
        const gridPos = `row=${Math.round(f.y / CH)}, col=${Math.round(f.x / CW)}`;
        const gridSize = `${Math.round(f.w / CW)}x${Math.round(f.h / CH)}`;
        console.log(`${indent}[${f.id.slice(0, 10)}] ${contentType} at ${gridPos} size ${gridSize} cells=${f.content?.cells.size ?? 0}`);
        printTree(f.children, indent + "  ");
      }
    };
    printTree(frames);
    console.log(`Total top-level: ${frames.length}`);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("junction: drag one child rect, check for ghosts", () => {
    const loaded = fullLoad(JUNCTION);
    const frames = getFrames(loaded.state);

    // Find a child rect to drag (e.g., the first one with content)
    const allFrames: { frame: Frame; parentId: string | null }[] = [];
    const collect = (fs: Frame[], parentId: string | null) => {
      for (const f of fs) {
        allFrames.push({ frame: f, parentId });
        collect(f.children, f.id);
      }
    };
    collect(frames, null);

    console.log("=== ALL FRAMES ===");
    for (const { frame: f, parentId } of allFrames) {
      console.log(`  ${f.id.slice(0, 10)} type=${f.content?.type ?? "container"} parent=${parentId?.slice(0, 10) ?? "root"} pos=(${f.x},${f.y}) size=${f.w}x${f.h}`);
    }

    // Try dragging the top-level frame (container) right by 2 cells
    const topFrame = frames[0];
    const mutatedState = applyMoveFrame(loaded.state, topFrame.id, CW * 2, 0);
    const save = fullSave(mutatedState, loaded.originalGrid, loaded.frameBboxSnapshot);

    console.log("=== SAVED AFTER DRAG RIGHT 2 CELLS ===");
    console.log(save.md);

    const ghosts = findGhosts(save.md, getFrames(mutatedState), CW, CH);
    console.log("=== GHOSTS ===");
    for (const g of ghosts) console.log(`  ${g}`);

    // Now reload and check frame count
    const reloaded = fullLoad(save.md);
    const reloadedFrames = getFrames(reloaded.state);
    const origContentCount = allFrames.filter(f => f.frame.content).length;

    console.log("=== RELOADED FRAMES ===");
    const reloadAll: Frame[] = [];
    const collectFlat = (fs: Frame[]) => { for (const f of fs) { reloadAll.push(f); collectFlat(f.children); } };
    collectFlat(reloadedFrames);
    const reloadContentCount = reloadAll.filter(f => f.content).length;
    console.log(`Content frames: before=${origContentCount} after=${reloadContentCount}`);

    expect(ghosts).toEqual([]);
  });

  it("junction: drag container down by 2 rows", () => {
    const result = convergenceCheck(JUNCTION, (loaded) => {
      const frames = getFrames(loaded.state);
      return applyMoveFrame(loaded.state, frames[0].id, 0, CH * 2);
    });

    console.log("=== JUNCTION DRAG DOWN ===");
    console.log("Saved1:\n" + result.saved1);
    console.log("Ghosts1:", result.ghosts1);
    console.log("Converged:", result.converged);
    console.log("Frame counts:", result.frameCount1, "→", result.frameCount2);

    if (!result.converged) {
      console.log("=== DIFF ===");
      const l1 = result.saved1.split("\n");
      const l2 = result.saved2.split("\n");
      const maxLen = Math.max(l1.length, l2.length);
      for (let i = 0; i < maxLen; i++) {
        if (l1[i] !== l2[i]) {
          console.log(`  L${i}: "${l1[i] ?? "<missing>"}" → "${l2[i] ?? "<missing>"}"`);
        }
      }
    }

    expect(result.ghosts1).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 2: FRAME COUNT CHANGED — resize breaking scanner parse
// ═══════════════════════════════════════════════════════════════════

describe("diagnostic: frame count after resize", () => {
  const NESTED = [
    "Top",
    "",
    "┌────────────────────────┐",
    "│  Outer                 │",
    "│  ┌──────────────────┐  │",
    "│  │  Inner           │  │",
    "│  └──────────────────┘  │",
    "└────────────────────────┘",
    "",
    "Bottom",
  ].join("\n");

  // Superseded by "TDD: Task 3" which properly tests convergence
  it.skip("nested: resize smaller, check frame count", () => {
    const loaded = fullLoad(NESTED);
    const frames = getFrames(loaded.state);

    console.log("=== NESTED FRAME TREE BEFORE ===");
    const printTree = (fs: Frame[], indent = "") => {
      for (const f of fs) {
        console.log(`${indent}[${f.id.slice(0, 10)}] ${f.content?.type ?? "container"} pos=(${f.x},${f.y}) size=${f.w}x${f.h} cells=${f.content?.cells.size ?? 0}`);
        printTree(f.children, indent + "  ");
      }
    };
    printTree(frames);

    // Find the outer rect (largest one with content type "rect")
    const allFrames: Frame[] = [];
    const collectAll = (fs: Frame[]) => { for (const f of fs) { allFrames.push(f); collectAll(f.children); } };
    collectAll(frames);
    const rects = allFrames.filter(f => f.content?.type === "rect");
    console.log(`Found ${rects.length} rect frames`);

    // Resize the top-level frame smaller (shrink by 3 cells width, 2 cells height)
    const topFrame = frames[0];
    const newW = topFrame.w - CW * 3;
    const newH = topFrame.h - CH * 2;
    const mutatedState = applyResizeFrame(loaded.state, topFrame.id, newW, newH, CW, CH);

    const save = fullSave(mutatedState, loaded.originalGrid, loaded.frameBboxSnapshot);

    console.log("=== SAVED AFTER RESIZE SMALLER ===");
    console.log(save.md);

    // Reload and count frames
    const reloaded = fullLoad(save.md);
    const reloadedFrames = getFrames(reloaded.state);
    const reloadAll: Frame[] = [];
    const collectFlat = (fs: Frame[]) => { for (const f of fs) { reloadAll.push(f); collectFlat(f.children); } };
    collectFlat(reloadedFrames);

    const origCount = allFrames.filter(f => f.content).length;
    const reloadCount = reloadAll.filter(f => f.content).length;
    console.log(`Content frames: before=${origCount} after=${reloadCount}`);

    const ghosts = findGhosts(save.md, getFrames(mutatedState), CW, CH);
    console.log("Ghosts:", ghosts);

    // Show what the scanner sees after reload
    console.log("=== NESTED RELOADED TREE ===");
    const printTree2 = (fs: Frame[], off = { x: 0, y: 0 }, indent = "") => {
      for (const f of fs) {
        const absX = off.x + f.x, absY = off.y + f.y;
        const type = f.content?.type ?? "container";
        const gridR = Math.round(absY / CH), gridC = Math.round(absX / CW);
        const gridW = Math.round(f.w / CW), gridH = Math.round(f.h / CH);
        const text = f.content?.text ?? "";
        console.log(`${indent}${type} grid=(${gridR},${gridC}) ${gridW}x${gridH} text="${text}"`);
        printTree2(f.children, { x: absX, y: absY }, indent + "  ");
      }
    };
    printTree2(reloadedFrames);

    // After fix: overflowing inner rect is dropped, so frame count changes.
    // The important thing is no junction artifacts (checked by TDD tests).
    expect(reloadCount).toBeLessThanOrEqual(origCount);
  });

  const JUNCTION = [
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

  it("junction: resize larger, check frame count", () => {
    const loaded = fullLoad(JUNCTION);
    const frames = getFrames(loaded.state);

    const allBefore: Frame[] = [];
    const c1 = (fs: Frame[]) => { for (const f of fs) { allBefore.push(f); c1(f.children); } };
    c1(frames);
    const beforeCount = allBefore.filter(f => f.content).length;

    console.log("=== JUNCTION BEFORE RESIZE ===");
    const printTree = (fs: Frame[], off = { x: 0, y: 0 }, indent = "") => {
      for (const f of fs) {
        const absX = off.x + f.x, absY = off.y + f.y;
        const type = f.content?.type ?? "container";
        const gridR = Math.round(absY / CH), gridC = Math.round(absX / CW);
        const gridW = Math.round(f.w / CW), gridH = Math.round(f.h / CH);
        const text = f.content?.text ?? "";
        console.log(`${indent}${type} grid=(${gridR},${gridC}) ${gridW}x${gridH} cells=${f.content?.cells.size ?? 0} text="${text}" dirty=${f.dirty}`);
        printTree(f.children, { x: absX, y: absY }, indent + "  ");
      }
    };
    printTree(frames);

    // Resize container larger (+3 cols, +1 row)
    const topFrame = frames[0];
    const mutatedState = applyResizeFrame(
      loaded.state, topFrame.id,
      topFrame.w + CW * 3, topFrame.h + CH * 1,
      CW, CH,
    );

    console.log("=== JUNCTION AFTER RESIZE (before save) ===");
    const mutatedFrames = getFrames(mutatedState);
    printTree(mutatedFrames);

    // Deep inspect text frame cells
    const inspectCells = (fs: Frame[], off = { x: 0, y: 0 }, indent = "") => {
      for (const f of fs) {
        const absX = off.x + f.x, absY = off.y + f.y;
        if (f.content?.type === "text") {
          const cells = Array.from(f.content.cells.entries());
          const gridR = Math.round(absY / CH), gridC = Math.round(absX / CW);
          console.log(`${indent}TEXT "${f.content.text}" abs=(${gridR},${gridC}) cells=[${cells.map(([k,v])=>`${k}='${v}'`).join(",")}]`);
        }
        inspectCells(f.children, { x: absX, y: absY }, indent + "  ");
      }
    };
    inspectCells(mutatedFrames);

    const save = fullSave(mutatedState, loaded.originalGrid, loaded.frameBboxSnapshot);
    console.log("=== JUNCTION RESIZE LARGER OUTPUT ===");
    console.log(save.md);

    // Show what the scanner sees after reload
    const reloaded = fullLoad(save.md);
    console.log("=== JUNCTION AFTER RELOAD ===");
    printTree(getFrames(reloaded.state));

    const allAfter: Frame[] = [];
    const c2 = (fs: Frame[]) => { for (const f of fs) { allAfter.push(f); c2(f.children); } };
    c2(getFrames(reloaded.state));
    const afterCount = allAfter.filter(f => f.content).length;
    console.log(`Content frames: before=${beforeCount} after=${afterCount}`);

    expect(afterCount).toBe(beforeCount);
  });

  it("junction: drag right, check frame count", () => {
    const result = convergenceCheck(JUNCTION, (loaded) => {
      const frames = getFrames(loaded.state);
      return applyMoveFrame(loaded.state, frames[0].id, CW * 5, 0);
    });

    console.log("=== JUNCTION DRAG RIGHT ===");
    console.log("Saved1:\n" + result.saved1);
    console.log("Frame counts:", result.frameCount1, "→", result.frameCount2);
    console.log("Ghosts:", result.ghosts1);
    console.log("Converged:", result.converged);

    expect(result.frameCount1).toBe(result.frameCount2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 3: PROSE EDIT NOT SERIALIZED
// ═══════════════════════════════════════════════════════════════════

describe("diagnostic: prose editing serialization", () => {
  const TWO_BOXES = [
    "Header",
    "",
    "┌────┐",
    "│ A  │",
    "└────┘",
    "",
    "Middle",
    "",
    "┌────┐",
    "│ B  │",
    "└────┘",
    "",
    "Footer",
  ].join("\n");

  it("prose insert between wireframes serializes correctly", () => {
    const loaded = fullLoad(TWO_BOXES);
    const state = loaded.state;

    // Inspect the prose doc and segment map
    const doc = getDoc(state);
    const segMap = getProseSegmentMap(state);
    console.log("=== PROSE DOC ===");
    const docLines = doc.split("\n");
    for (let i = 0; i < docLines.length; i++) {
      const seg = segMap[i];
      console.log(`  line ${i}: "${docLines[i]}" → grid row=${seg?.row}, col=${seg?.col}`);
    }

    // The CM doc should contain "Middle" — find which line
    const middleLine = docLines.findIndex(l => l.includes("Middle"));
    console.log(`"Middle" is on CM doc line ${middleLine}`);
    expect(middleLine).toBeGreaterThanOrEqual(0);

    // Simulate typing " EDITED" at end of "Middle" line.
    // proseInsert at (row=middleLine, col=6) with " EDITED"
    let s = moveCursorTo(state, { row: middleLine, col: 6 });
    s = proseInsert(s, getCursor(s)!, " EDITED");

    // Now serialize (no frames moved, so !anyDirty path)
    const md = gridSerialize(
      getFrames(s), getDoc(s),
      getProseSegmentMap(s), loaded.originalGrid,
      CW, CH,
      getOriginalProseSegments(s),
      loaded.frameBboxSnapshot,
    );

    console.log("=== SERIALIZED AFTER PROSE EDIT ===");
    console.log(md);

    expect(md).toContain("Middle EDITED");
    expect(md).toContain("│ A  │");
    expect(md).toContain("│ B  │");
    expect(md).toContain("Header");
    expect(md).toContain("Footer");
  });

  it("Enter key above wireframe: newline count and frame positions", () => {
    const SIMPLE = "Prose above\n\n┌──────────────┐\n│              │\n│              │\n└──────────────┘\n\nProse below";
    const loaded = fullLoad(SIMPLE);
    const doc = getDoc(loaded.state);
    const segMap = getProseSegmentMap(loaded.state);

    console.log("=== BEFORE ENTER ===");
    const lines = doc.split("\n");
    for (let i = 0; i < lines.length; i++) {
      console.log(`  line ${i}: "${lines[i]}" → row=${segMap[i]?.row}, col=${segMap[i]?.col}`);
    }

    // Simulate pressing Enter at end of first prose line
    let s = moveCursorTo(loaded.state, { row: 0, col: 11 }); // end of "Prose above"
    s = proseInsert(s, getCursor(s)!, "\n");

    const newDoc = getDoc(s);
    const newSegMap = getProseSegmentMap(s);
    console.log("=== AFTER ENTER ===");
    const newLines = newDoc.split("\n");
    for (let i = 0; i < newLines.length; i++) {
      console.log(`  line ${i}: "${newLines[i]}" → row=${newSegMap[i]?.row}, col=${newSegMap[i]?.col}`);
    }

    // The original had N newlines. After Enter, should have N+1.
    expect(newDoc.split("\n").length).toBe(doc.split("\n").length + 1);

    // Serialize without shifting frames (as the bug may be here)
    const md1 = gridSerialize(
      getFrames(s), getDoc(s),
      getProseSegmentMap(s), loaded.originalGrid,
      CW, CH,
      getOriginalProseSegments(s),
      loaded.frameBboxSnapshot,
    );
    console.log("=== SERIALIZED WITHOUT FRAME SHIFT ===");
    console.log(md1);

    // Now shift frames (simulating what DemoV2 Enter handler does)
    const editGridRow = newSegMap[0]?.row ?? 0;
    let shifted = s;
    for (const f of getFrames(s)) {
      if (f.y >= editGridRow * CH) {
        shifted = applyMoveFrame(shifted, f.id, 0, CH);
      }
    }

    const md2 = gridSerialize(
      getFrames(shifted), getDoc(shifted),
      getProseSegmentMap(shifted), loaded.originalGrid,
      CW, CH,
      getOriginalProseSegments(shifted),
      loaded.frameBboxSnapshot,
    );
    console.log("=== SERIALIZED WITH FRAME SHIFT ===");
    console.log(md2);

    // Check the wireframe is still intact
    expect(md2).toContain("┌──────────────┐");
    expect(md2).toContain("└──────────────┘");
    expect(md2).toContain("Prose above");
    expect(md2).toContain("Prose below");
  });
});

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 4: COMPLEX FIXTURES — CRM workspace
// ═══════════════════════════════════════════════════════════════════

describe("diagnostic: complex fixture ghosts", () => {
  // Simplified CRM-like fixture with nested frames and shared walls
  const CRM_SIMPLE = [
    "Title",
    "",
    "┌────────────┬──────────────────┐",
    "│ Navigation │  Content         │",
    "│            │                  │",
    "│ ┌────────┐ │  ┌────────────┐  │",
    "│ │ Item 1 │ │  │  Form      │  │",
    "│ └────────┘ │  └────────────┘  │",
    "│            │                  │",
    "└────────────┴──────────────────┘",
    "",
    "Footer",
  ].join("\n");

  it("CRM-simple: inspect tree and drag right", () => {
    const loaded = fullLoad(CRM_SIMPLE);
    const frames = getFrames(loaded.state);

    console.log("=== CRM SIMPLE FRAME TREE ===");
    const printTree = (fs: Frame[], indent = "") => {
      for (const f of fs) {
        const type = f.content?.type ?? "container";
        const pos = `(${Math.round(f.x / CW)},${Math.round(f.y / CH)})`;
        const size = `${Math.round(f.w / CW)}x${Math.round(f.h / CH)}`;
        console.log(`${indent}${type} ${pos} ${size} cells=${f.content?.cells.size ?? 0} dirty=${f.dirty}`);
        printTree(f.children, indent + "  ");
      }
    };
    printTree(frames);

    // Drag right by 3 cells
    const topFrame = frames[0];
    const mutated = applyMoveFrame(loaded.state, topFrame.id, CW * 3, 0);
    const save = fullSave(mutated, loaded.originalGrid, loaded.frameBboxSnapshot);

    console.log("=== SAVED AFTER DRAG RIGHT 3 CELLS ===");
    console.log(save.md);

    const ghosts = findGhosts(save.md, getFrames(mutated), CW, CH);
    console.log("=== GHOSTS ===");
    for (const g of ghosts) console.log(`  ${g}`);

    // Reload and compare frame count
    const reloaded = fullLoad(save.md);
    const allBefore: Frame[] = [];
    const allAfter: Frame[] = [];
    const c = (fs: Frame[], arr: Frame[]) => { for (const f of fs) { arr.push(f); c(f.children, arr); } };
    c(frames, allBefore);
    c(getFrames(reloaded.state), allAfter);

    console.log(`Frame count: before=${allBefore.filter(f => f.content).length} after=${allAfter.filter(f => f.content).length}`);

    expect(ghosts).toEqual([]);
  });

  it("CRM-simple: drag down by 2 rows", () => {
    const result = convergenceCheck(CRM_SIMPLE, (loaded) => {
      const frames = getFrames(loaded.state);
      return applyMoveFrame(loaded.state, frames[0].id, 0, CH * 2);
    });

    console.log("=== CRM DRAG DOWN ===");
    console.log("Saved:\n" + result.saved1);
    console.log("Ghosts:", result.ghosts1);
    console.log("Converged:", result.converged);
    console.log("Frame counts:", result.frameCount1, "→", result.frameCount2);

    expect(result.ghosts1).toEqual([]);
    expect(result.converged).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 5: DEFAULT_TEXT dashboard drag — the biggest failure source
// ═══════════════════════════════════════════════════════════════════

describe("diagnostic: default text dashboard drag", () => {
  // Simplified version of the dashboard from DEFAULT_TEXT
  const DASHBOARD = [
    "Prose above",
    "",
    "┌───────────────────────────────────────────────────────┐",
    "│                      My App                           │",
    "├───────────┬───────────────────────────┬───────────────┤",
    "│ Nav       │  Main Content             │  Details      │",
    "│           │                           │               │",
    "│ Home      │  ┌─────────────────────┐  │  User: Alice  │",
    "│ Search    │  │  Revenue Chart      │  │  Role: Admin  │",
    "│ Settings  │  │  ████▓▓░░           │  │               │",
    "│ Help      │  └─────────────────────┘  │  ┌─────────┐  │",
    "│           │                           │  │ Actions │  │",
    "│           │  ┌──────────┐ ┌────────┐  │  │ Edit    │  │",
    "│           │  │ Users    │ │ Tasks  │  │  │ Delete  │  │",
    "│           │  │ 1,204    │ │ 38     │  │  └─────────┘  │",
    "│           │  └──────────┘ └────────┘  │               │",
    "└───────────┴───────────────────────────┴───────────────┘",
    "",
    "Prose below",
  ].join("\n");

  it("dashboard: inspect tree structure", () => {
    const loaded = fullLoad(DASHBOARD);
    const frames = getFrames(loaded.state);

    console.log("=== DASHBOARD FRAME TREE ===");
    const allContent: Frame[] = [];
    const printTree = (fs: Frame[], off = { x: 0, y: 0 }, indent = "") => {
      for (const f of fs) {
        const absX = off.x + f.x, absY = off.y + f.y;
        const type = f.content?.type ?? "container";
        const gridR = Math.round(absY / CH), gridC = Math.round(absX / CW);
        const gridW = Math.round(f.w / CW), gridH = Math.round(f.h / CH);
        const text = f.content?.text ?? "";
        if (f.content) allContent.push(f);
        console.log(`${indent}${type} (${gridR},${gridC}) ${gridW}x${gridH} text="${text}"`);
        printTree(f.children, { x: absX, y: absY }, indent + "  ");
      }
    };
    printTree(frames);
    console.log(`Total content frames: ${allContent.length}`);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("dashboard: drag right 5 cells, check for ghosts", () => {
    const result = convergenceCheck(DASHBOARD, (loaded) => {
      const frames = getFrames(loaded.state);
      // Find the dashboard container (should be the first/only top-level frame)
      return applyMoveFrame(loaded.state, frames[0].id, CW * 5, 0);
    });

    console.log("=== DASHBOARD DRAG RIGHT 5 ===");
    console.log("Saved:\n" + result.saved1);
    console.log("Ghosts:", result.ghosts1);
    console.log("Converged:", result.converged);
    console.log("Frame counts:", result.frameCount1, "→", result.frameCount2);

    if (!result.converged) {
      const l1 = result.saved1.split("\n");
      const l2 = result.saved2.split("\n");
      for (let i = 0; i < Math.max(l1.length, l2.length); i++) {
        if (l1[i] !== l2[i]) {
          console.log(`  L${i}: "${l1[i] ?? "<missing>"}" → "${l2[i] ?? "<missing>"}"`);
        }
      }
    }

    expect(result.ghosts1).toEqual([]);
    expect(result.frameCount1).toBe(result.frameCount2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 7: FRACTIONAL PIXEL MOVES (like e2e does)
// ══════════════════════════════════════════════════���════════════════

// Superseded by "TDD: fix serialize ghosts" tests. These had a corrupted fixture.
describe.skip("diagnostic: fractional pixel moves", () => {
  const DASHBOARD = [
    "Prose above",
    "",
    "┌───────────────────────────────────────────────────────┐",
    "│                      My App                           │",
    "├───────────┬───────────────────────────┬───────────────┤",
    "│ Nav       │  Main Content             │  Details      │",
    "���           │                           │               │",
    "│ Home      │  ┌─────────────────────┐  │  User: Alice  │",
    "│ Search    │  │  Revenue Chart      │  │  Role: Admin  │",
    "│ Settings  │  │  ████▓▓░░           │  │               │",
    "│ Help      │  └─────────────────────┘  │  ┌─────────┐  │",
    "│           │                           │  │ Actions │  │",
    "│           │  ┌──────────┐ ┌────────┐  │  │ Edit    │  │",
    "│           │  │ Users    │ │ Tasks  │  │  │ Delete  │  │",
    "│           │  │ 1,204    │ │ 38     │  │  └─────────┘  │",
    "│           │  └──────────┘ └────────┘  │               │",
    "└───────────┴───────────────────────────┴───────────────┘",
    "",
    "Prose below",
  ].join("\n");

  it("dashboard: drag 50px right (fractional cells)", () => {
    // First, inspect the snapshot bboxes that will be used for blanking
    const loaded = fullLoad(DASHBOARD);
    const snapshot = loaded.frameBboxSnapshot;
    console.log("=== SNAPSHOT BBOXES FOR BLANKING ===");
    for (const b of snapshot) {
      console.log(`  id=${b.id.slice(0, 12)} row=${b.row} col=${b.col} w=${b.w} h=${b.h}`);
    }

    const result = convergenceCheck(DASHBOARD, (ld) => {
      const frames = getFrames(ld.state);
      // 50px ÷ 9.6 = 5.208 cells — fractional!
      return applyMoveFrame(ld.state, frames[0].id, 50, 0);
    });

    console.log("=== DASHBOARD DRAG 50px RIGHT (fractional) ===");
    console.log("Saved:\n" + result.saved1);
    console.log("Ghosts:", result.ghosts1);
    console.log("Converged:", result.converged);
    console.log("Frame counts:", result.frameCount1, "→", result.frameCount2);

    if (result.ghosts1.length > 0) {
      console.log("=== GHOST DETAILS ===");
      for (const g of result.ghosts1) console.log(`  ${g}`);
    }

    expect(result.ghosts1).toEqual([]);
  });

  it("dashboard: drag 80px down (fractional cells)", () => {
    const result = convergenceCheck(DASHBOARD, (loaded) => {
      const frames = getFrames(loaded.state);
      // 80px ÷ 18.4 = 4.35 rows — fractional!
      return applyMoveFrame(loaded.state, frames[0].id, 0, 80);
    });

    console.log("=== DASHBOARD DRAG 80px DOWN (fractional) ===");
    console.log("Ghosts:", result.ghosts1);
    console.log("Converged:", result.converged);
    console.log("Frame counts:", result.frameCount1, "→", result.frameCount2);

    expect(result.ghosts1).toEqual([]);
  });

  it("dashboard: resize +40 width, +20 height (like e2e)", () => {
    const loaded = fullLoad(DASHBOARD);
    const frames = getFrames(loaded.state);
    const topFrame = frames[0];

    // e2e resizeSelected(p, 40, 20) resizes by pixel amounts
    const mutated = applyResizeFrame(loaded.state, topFrame.id, topFrame.w + 40, topFrame.h + 20, CW, CH);
    const save1 = fullSave(mutated, loaded.originalGrid, loaded.frameBboxSnapshot);

    console.log("=== DASHBOARD RESIZE +40,+20 ===");
    const ghosts = findGhosts(save1.md, getFrames(mutated), CW, CH);
    console.log("Ghosts:", ghosts.length);
    if (ghosts.length > 0) {
      for (const g of ghosts) console.log(`  ${g}`);
    }

    // Reload and check convergence
    const reloaded = fullLoad(save1.md);
    const save2 = fullSave(reloaded.state, reloaded.originalGrid, reloaded.frameBboxSnapshot);
    console.log("Converged:", save1.md === save2.md);

    expect(ghosts).toEqual([]);
  });

  it("dashboard: resize -30 width, -20 height (like e2e)", () => {
    const loaded = fullLoad(DASHBOARD);
    const frames = getFrames(loaded.state);
    const topFrame = frames[0];

    const mutated = applyResizeFrame(loaded.state, topFrame.id, topFrame.w - 30, topFrame.h - 20, CW, CH);
    const save1 = fullSave(mutated, loaded.originalGrid, loaded.frameBboxSnapshot);

    console.log("=== DASHBOARD RESIZE -30,-20 ===");
    console.log("Saved:\n" + save1.md);
    const ghosts = findGhosts(save1.md, getFrames(mutated), CW, CH);
    console.log("Ghosts:", ghosts.length);
    if (ghosts.length > 0) {
      for (const g of ghosts.slice(0, 10)) console.log(`  ${g}`);
    }

    expect(ghosts).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CATEGORY 8: SNAPSHOT COVERAGE — what does snapshotFrameBboxes capture?
// ═══════════════════════════════════════════════════════════════════

describe("diagnostic: snapshot coverage", () => {
  const JUNCTION = [
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

  it("snapshot includes all frames with content", () => {
    const state = createEditorStateFromText(JUNCTION, CW, CH);
    const frames = getFrames(state);
    const snapshot = snapshotFrameBboxes(frames, CW, CH);

    console.log("=== SNAPSHOT BBOXES ===");
    for (const b of snapshot) {
      console.log(`  id=${b.id.slice(0, 10)} row=${b.row} col=${b.col} w=${b.w} h=${b.h}`);
    }

    // Count all content frames in tree
    const contentFrames: Frame[] = [];
    const collect = (fs: Frame[]) => {
      for (const f of fs) {
        if (f.content) contentFrames.push(f);
        collect(f.children);
      }
    };
    collect(frames);

    console.log(`Content frames: ${contentFrames.length}, Snapshot bboxes: ${snapshot.length}`);

    // Every content frame should have a snapshot entry
    for (const f of contentFrames) {
      const found = snapshot.find(b => b.id === f.id);
      expect(found, `Missing snapshot for frame ${f.id.slice(0, 10)} type=${f.content?.type}`).toBeDefined();
    }

    // No container frames should be in the snapshot
    const containerFrames: Frame[] = [];
    const collectContainers = (fs: Frame[]) => {
      for (const f of fs) {
        if (!f.content) containerFrames.push(f);
        collectContainers(f.children);
      }
    };
    collectContainers(frames);
    console.log(`Container frames (no content): ${containerFrames.length}`);
    for (const f of containerFrames) {
      const found = snapshot.find(b => b.id === f.id);
      console.log(`  Container ${f.id.slice(0, 10)} in snapshot: ${!!found}`);
    }
  });

  it("dirty propagation: moving container marks children dirty", () => {
    const state = createEditorStateFromText(JUNCTION, CW, CH);
    const frames = getFrames(state);
    const topFrame = frames[0];

    // Move the container
    const moved = applyMoveFrame(state, topFrame.id, CW * 2, 0);
    const movedFrames = getFrames(moved);

    console.log("=== DIRTY FLAGS AFTER MOVE ===");
    const printDirty = (fs: Frame[], indent = "") => {
      for (const f of fs) {
        console.log(`${indent}${f.content?.type ?? "container"} dirty=${f.dirty} id=${f.id.slice(0, 10)}`);
        printDirty(f.children, indent + "  ");
      }
    };
    printDirty(movedFrames);

    // Top-level frame should be dirty
    expect(movedFrames[0].dirty).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TDD: fix serialize ghosts — Tasks 1, 2, 3
// ═══════════════════════════════════════════════════════════════════

describe("TDD: fix serialize ghosts", () => {
  // ── Task 1: container bboxes in snapshot ──────────────────────────

  describe("Task 1: container bboxes in snapshot", () => {
    const JUNCTION = [
      "Header", "",
      "┌───────────┬───────────┐",
      "│  Left     │  Right    │",
      "├───────────┼───────────┤",
      "│  Bottom L │  Bottom R │",
      "└───────────┴───────────┘",
      "", "Footer",
    ].join("\n");

    it("snapshot includes container frame bbox", () => {
      const { state, frameBboxSnapshot } = fullLoad(JUNCTION);
      const frames = getFrames(state);
      // The junction has 1 top-level container frame (content===null)
      const containers: Frame[] = [];
      const collect = (fs: Frame[]) => {
        for (const f of fs) {
          if (!f.content && f.children.length > 0) containers.push(f);
          collect(f.children);
        }
      };
      collect(frames);
      expect(containers.length).toBeGreaterThan(0);
      // The snapshot should include an entry for this container
      for (const c of containers) {
        const found = frameBboxSnapshot.find(b => b.id === c.id);
        expect(found, `Container ${c.id} missing from snapshot`).toBeDefined();
      }
    });

    it("dashboard drag 50px right: zero ghosts", () => {
      const DASHBOARD = [
        "Prose above", "",
        "┌───────────────────────────────────────────────────────┐",
        "│                      My App                           │",
        "├───────────┬───────────────────────────┬───────────────┤",
        "│ Nav       │  Main Content             │  Details      │",
        "│           │                           │               │",
        "│ Home      │  ┌─────────────────────┐  │  User: Alice  │",
        "│ Search    │  │  Revenue Chart      │  │  Role: Admin  │",
        "│ Settings  │  │  ████▓▓░░           │  │               │",
        "│ Help      │  └─────────────────────┘  │  ┌─────────┐  │",
        "│           │                           │  │ Actions │  │",
        "│           │  ┌──────────┐ ┌────────┐  │  │ Edit    │  │",
        "│           │  │ Users    │ │ Tasks  │  │  │ Delete  │  │",
        "│           │  │ 1,204    │ │ 38     │  │  └─────────┘  │",
        "│           │  └──────────┘ └────────┘  │               │",
        "└───────────┴───────────────────────────┴───────────────┘",
        "", "Prose below",
      ].join("\n");

      const result = convergenceCheck(DASHBOARD, (loaded) => {
        const frames = getFrames(loaded.state);
        return applyMoveFrame(loaded.state, frames[0].id, 50, 0); // fractional
      });
      expect(result.ghosts1).toEqual([]);
    });

    it("dashboard drag 80px down: zero ghosts", () => {
      const DASHBOARD = [
        "Prose above", "",
        "┌───────────────────────────────────────────────────────┐",
        "│                      My App                           │",
        "├───────────┬───────────────────────────┬───────────────┤",
        "│ Nav       │  Main Content             │  Details      │",
        "│           │                           │               │",
        "│ Home      │  ┌─────────────────────┐  │  User: Alice  │",
        "│ Search    │  │  Revenue Chart      │  │  Role: Admin  │",
        "│ Settings  │  │  ████▓▓░░           │  │               │",
        "│ Help      │  └─────────────────────┘  │  ┌─────────┐  │",
        "│           │                           │  │ Actions │  │",
        "│           │  ┌──────────┐ ┌────────┐  │  │ Edit    │  │",
        "│           │  │ Users    │ │ Tasks  │  │  │ Delete  │  │",
        "│           │  │ 1,204    │ │ 38     │  │  └─────────┘  │",
        "│           │  └──────────┘ └────────┘  │               │",
        "└───────────┴───────────────────────────┴───────────────┘",
        "", "Prose below",
      ].join("\n");

      const result = convergenceCheck(DASHBOARD, (loaded) => {
        const frames = getFrames(loaded.state);
        return applyMoveFrame(loaded.state, frames[0].id, 0, 80); // fractional
      });
      expect(result.ghosts1).toEqual([]);
    });
  });

  // ── Task 2: Phase B write-order fix ───────────────────────────────

  describe("Task 2: Phase B write-order fix", () => {
    const JUNCTION = [
      "Header", "",
      "┌───────────┬───────────┐",
      "│  Left     │  Right    │",
      "├───────────┼───────────┤",
      "│  Bottom L │  Bottom R │",
      "└───────────┴───────────┘",
      "", "Footer",
    ].join("\n");

    it("junction resize-larger preserves all text labels", () => {
      const loaded = fullLoad(JUNCTION);
      const frames = getFrames(loaded.state);
      const topFrame = frames[0];
      const mutated = applyResizeFrame(
        loaded.state, topFrame.id,
        topFrame.w + CW * 3, topFrame.h + CH * 1,
        CW, CH,
      );
      const save = fullSave(mutated, loaded.originalGrid, loaded.frameBboxSnapshot);
      // Text labels must survive
      expect(save.md).toContain("Bottom L");
      expect(save.md).toContain("Bottom R");
    });

    it("junction resize-larger preserves frame count", () => {
      const loaded = fullLoad(JUNCTION);
      const frames = getFrames(loaded.state);

      const countContent = (fs: Frame[]): number => {
        let n = 0;
        for (const f of fs) {
          if (f.content) n++;
          n += countContent(f.children);
        }
        return n;
      };
      const beforeCount = countContent(frames);

      const topFrame = frames[0];
      const mutated = applyResizeFrame(
        loaded.state, topFrame.id,
        topFrame.w + CW * 3, topFrame.h + CH * 1,
        CW, CH,
      );
      const save = fullSave(mutated, loaded.originalGrid, loaded.frameBboxSnapshot);
      const reloaded = fullLoad(save.md);
      const afterCount = countContent(getFrames(reloaded.state));
      expect(afterCount).toBe(beforeCount);
    });
  });

  // ── Task 3: clip children to parent bounds ─────────────────────────

  describe("Task 3: clip children to parent bounds", () => {
    const NESTED = [
      "Top", "",
      "┌────────────────────────┐",
      "│  Outer                 │",
      "│  ┌──────────────────┐  │",
      "│  │  Inner           │  │",
      "│  └──────────────────┘  │",
      "└────────────────────────┘",
      "", "Bottom",
    ].join("\n");

    it("nested resize-smaller: no overflow artifacts, converges within 2 cycles", () => {
      const loaded = fullLoad(NESTED);
      const frames = getFrames(loaded.state);
      const topFrame = frames[0];
      const mutated = applyResizeFrame(
        loaded.state, topFrame.id,
        topFrame.w - CW * 3, topFrame.h - CH * 2,
        CW, CH,
      );
      // Save → reload → save → reload → save. Must converge within 2 cycles.
      const save1 = fullSave(mutated, loaded.originalGrid, loaded.frameBboxSnapshot);
      // No overflow junction artifacts (┤ outside parent)
      expect(save1.md).not.toContain("┤\n");
      expect(save1.md).not.toContain("┼");
      const r1 = fullLoad(save1.md);
      const save2 = fullSave(r1.state, r1.originalGrid, r1.frameBboxSnapshot);
      const r2 = fullLoad(save2.md);
      const save3 = fullSave(r2.state, r2.originalGrid, r2.frameBboxSnapshot);
      expect(save3.md).toBe(save2.md);
    });

    it("nested resize-smaller has no junction artifacts outside parent", () => {
      const loaded = fullLoad(NESTED);
      const frames = getFrames(loaded.state);
      const topFrame = frames[0];
      const mutated = applyResizeFrame(
        loaded.state, topFrame.id,
        topFrame.w - CW * 3, topFrame.h - CH * 2,
        CW, CH,
      );
      const save = fullSave(mutated, loaded.originalGrid, loaded.frameBboxSnapshot);
      const ghosts = findGhosts(save.md, getFrames(mutated), CW, CH);
      expect(ghosts).toEqual([]);
    });
  });
});
