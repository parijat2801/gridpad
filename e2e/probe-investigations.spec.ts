import { test } from "@playwright/test";
import * as fs from "fs";

// Probes for the 5 remaining investigations. Each probe writes a JSON
// summary to /tmp/probe-<name>.json. Read by the human to update DEBUG_PLAN.md.

async function load(page: any, md: string) {
  await page.evaluate((t: string) => (window as any).__gridpad.loadDocument(t), md);
  await page.waitForTimeout(500);
}
async function save(page: any): Promise<string> {
  return page.evaluate(() => (window as any).__gridpad.saveDocument());
}
async function getDoc(page: any): Promise<string> {
  return page.evaluate(() => (window as any).__gridpad.getProseDoc());
}
async function getTree(page: any): Promise<any[]> {
  return page.evaluate(() => (window as any).__gridpad.getFrameTree());
}
async function getFrames(page: any): Promise<any[]> {
  return page.evaluate(() => (window as any).__gridpad.getFrameRects());
}
async function clickAt(page: any, vx: number, vy: number) {
  await page.mouse.click(vx, vy);
  await page.waitForTimeout(200);
}

// ── Investigation 1: rotation past doc-end (Fix 2) ──────────────────────────
test("INV1: drag SIMPLE_BOX 100px down — what happens to claim, doc, frame?", async ({ page }) => {
  const SIMPLE_BOX = `Prose above\n\n┌──────────────┐\n│              │\n│              │\n└──────────────┘\n\nProse below`;
  await page.goto("/");
  await page.waitForTimeout(2000);
  await load(page, SIMPLE_BOX);

  const docBefore = await getDoc(page);
  const treeBefore = await getTree(page);
  const framesBefore = await getFrames(page);
  const frameId = framesBefore[0].id;
  // Get the actual top-level frame data (not the drilled list).
  const topBefore = treeBefore[0];

  // Click center of top-level (the band wrapping the rect).
  const f0 = framesBefore[0];
  const cbox = await page.locator("canvas").boundingBox();
  const cx = cbox!.x + f0.x + f0.w / 2;
  const cy = cbox!.y + f0.y + f0.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx, cy + (100 * i / 10));
  }
  await page.mouse.up();
  await page.waitForTimeout(300);

  const docAfter = await getDoc(page);
  const treeAfter = await getTree(page);
  const saved = await save(page);

  fs.writeFileSync("/tmp/probe-inv1-rotation.json", JSON.stringify({
    summary: "Drag SIMPLE_BOX 100px down — does band/doc rotate cleanly?",
    docBefore_lines: docBefore.split("\n"),
    docAfter_lines: docAfter.split("\n"),
    docBefore_length: docBefore.length,
    docAfter_length: docAfter.length,
    docBefore_lineCount: docBefore.split("\n").length,
    docAfter_lineCount: docAfter.split("\n").length,
    topFrame_before: { id: topBefore.id, gridRow: topBefore.gridRow, gridH: topBefore.gridH, w: topBefore.w, h: topBefore.h, absY: topBefore.absY },
    topFrame_after: { id: treeAfter[0]?.id, gridRow: treeAfter[0]?.gridRow, gridH: treeAfter[0]?.gridH, w: treeAfter[0]?.w, h: treeAfter[0]?.h, absY: treeAfter[0]?.absY },
    frameIdSelected: frameId,
    saved_lines: saved.split("\n"),
  }, null, 2));
});

// ── Investigation 2: resize + undo (tests 2705, 2723) ──────────────────────
test("INV2: SIMPLE_BOX resize then undo — does doc fully restore?", async ({ page }) => {
  const SIMPLE_BOX = `Prose above\n\n┌──────────────┐\n│              │\n│              │\n└──────────────┘\n\nProse below`;
  await page.goto("/");
  await page.waitForTimeout(2000);
  await load(page, SIMPLE_BOX);

  const docBefore = await getDoc(page);
  const framesBefore = await getFrames(page);
  const f0 = framesBefore[0];
  const cbox = await page.locator("canvas").boundingBox();
  // Click to select, then resize via bottom-right handle.
  await clickAt(page, cbox!.x + f0.x + f0.w / 2, cbox!.y + f0.y + f0.h / 2);
  const handleX = cbox!.x + f0.x + f0.w;
  const handleY = cbox!.y + f0.y + f0.h;
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(handleX + (50 * i / 5), handleY + (30 * i / 5));
  }
  await page.mouse.up();
  await page.waitForTimeout(300);

  const docAfterResize = await getDoc(page);

  // Click prose to commit.
  await clickAt(page, cbox!.x + 5, cbox!.y + 5);

  // Undo.
  await page.locator("canvas").focus();
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);

  const docAfterUndo = await getDoc(page);
  const saved = await save(page);

  fs.writeFileSync("/tmp/probe-inv2-undo-resize.json", JSON.stringify({
    summary: "SIMPLE_BOX resize + undo — does doc fully invert?",
    docBefore_lineCount: docBefore.split("\n").length,
    docAfterResize_lineCount: docAfterResize.split("\n").length,
    docAfterUndo_lineCount: docAfterUndo.split("\n").length,
    docBefore_length: docBefore.length,
    docAfterUndo_length: docAfterUndo.length,
    docBefore_equalsAfterUndo: docBefore === docAfterUndo,
    saved_equalsOrig: saved === SIMPLE_BOX,
    diffLines_undoVsBefore: {
      onlyInBefore: docBefore.split("\n").filter((l, i) => docAfterUndo.split("\n")[i] !== l).slice(0, 5),
      onlyInAfter: docAfterUndo.split("\n").filter((l, i) => docBefore.split("\n")[i] !== l).slice(0, 5),
    },
    saved_lines: saved.split("\n"),
  }, null, 2));
});

// ── Investigation 3: Backspace merges line above wireframe (test 2891) ─────
test("INV3: backspace at start of line two", async ({ page }) => {
  const fixture = `Line one\n\nLine two\n\n┌────┐\n│ A  │\n└────┘\n\nEnd`;
  await page.goto("/");
  await page.waitForTimeout(2000);
  await load(page, fixture);

  const framesBefore = await getFrames(page);
  const yBefore = framesBefore[0]?.y ?? 0;

  // Click on "Line two" — find its rendered position.
  const lines: any[] = await page.evaluate(() => (window as any).__gridpad.getRenderedLines());
  const lineTwoLine = lines.find(l => l.text.includes("Line two"));
  const cbox = await page.locator("canvas").boundingBox();
  const clickY = lineTwoLine ? lineTwoLine.y + 5 : 44;
  await clickAt(page, cbox!.x + 5, cbox!.y + clickY);
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);

  const framesAfter = await getFrames(page);
  const yAfter = framesAfter[0]?.y ?? 0;
  const saved = await save(page);

  fs.writeFileSync("/tmp/probe-inv3-backspace.json", JSON.stringify({
    summary: "Backspace at start of 'Line two' — does frame shift up?",
    yBefore, yAfter,
    yDelta: yAfter - yBefore,
    expected: "yAfter < yBefore (frame moves up)",
    actual: yAfter < yBefore ? "PASS" : "FAIL",
    saved_lines: saved.split("\n"),
  }, null, 2));
});

// ── Investigation 4: cross-parent reparent (test 3507) ─────────────────────
test("INV4: drag inner from outer A to outer B", async ({ page }) => {
  const fixture = `Top

┌────────────────────────┐
│  Outer A               │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘

middle

┌────────────────────────┐
│  Outer B               │
│                        │
│                        │
│                        │
└────────────────────────┘

End`;
  await page.goto("/");
  await page.waitForTimeout(2000);
  await load(page, fixture);

  const framesBefore = await getFrames(page);
  const treeBefore = await getTree(page);
  // Drill to inner: click outer A, then click again >300ms later.
  const a = framesBefore[0]; // outer A
  const b = framesBefore[1]; // outer B
  const cbox = await page.locator("canvas").boundingBox();
  // Find inner via tree walk.
  const innerNode: any = await page.evaluate(() => {
    function search(nodes: any[]): any {
      for (const n of nodes) {
        if (n.contentType === "text" && (n.text || "").includes("Inner")) return null; // skip text
        if (n.children?.length) {
          for (const c of n.children) {
            if (c.contentType === "rect" && c.children?.some((x: any) => x.text === "Inner")) return c;
          }
          const found = search(n.children);
          if (found) return found;
        }
      }
      return null;
    }
    return search((window as any).__gridpad.getFrameTree());
  });

  if (!innerNode) {
    fs.writeFileSync("/tmp/probe-inv4-reparent.json", JSON.stringify({ error: "inner not found" }, null, 2));
    return;
  }

  // Drag from inner's center to a point near top-left of B.
  const cx = cbox!.x + innerNode.absX + innerNode.w / 2;
  const cy = cbox!.y + innerNode.absY + innerNode.h / 2;
  // Drill onto inner first (click parent, then click >300ms later)
  await clickAt(page, cx, cy);
  await page.waitForTimeout(400);
  await clickAt(page, cx, cy);
  await page.waitForTimeout(200);

  const dropX = cbox!.x + b.x + 30;
  const dropY = cbox!.y + b.y + b.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(dropX, dropY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const treeAfter = await getTree(page);
  const saved = await save(page);

  // Did inner end up under B?
  const result = await page.evaluate(() => {
    const tree = (window as any).__gridpad.getFrameTree();
    function findContaining(nodes: any[], targetText: string): any {
      for (const n of nodes) {
        if (n.children?.some((c: any) => c.children?.some((cc: any) => cc.text === targetText))) return n;
        if (n.children?.length) {
          const r = findContaining(n.children, targetText);
          if (r) return r;
        }
      }
      return null;
    }
    const innerInside = findContaining(tree, "Inner");
    return {
      treeTopLevelCount: tree.length,
      innerParentSummary: innerInside ? { id: innerInside.id, contentType: innerInside.contentType, hasOuterB: tree[1]?.id === innerInside.id || tree[1]?.children?.some((c: any) => c.id === innerInside.id) } : null,
    };
  });

  fs.writeFileSync("/tmp/probe-inv4-reparent.json", JSON.stringify({
    summary: "Drag Inner from Outer A to Outer B",
    treeBefore_topLevelCount: treeBefore.length,
    treeAfter_topLevelCount: treeAfter.length,
    expected: "Inner should be a child of Outer B's tree branch",
    result,
    saved_lines: saved.split("\n"),
  }, null, 2));
});

// ── Investigation 5: promote then drag promoted (test 3827) ────────────────
test("INV5: promote child then drag the promoted frame", async ({ page }) => {
  const fixture = `Top prose

┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘



Bottom prose`;
  await page.goto("/");
  await page.waitForTimeout(2000);
  await load(page, fixture);

  const framesBefore = await getFrames(page);
  const cbox = await page.locator("canvas").boundingBox();
  const outerBefore = framesBefore[0];
  const outerYBefore = outerBefore.y;

  // Find inner node.
  const innerNode: any = await page.evaluate(() => {
    function search(nodes: any[]): any {
      if (!nodes) return null;
      for (const n of nodes) {
        if (n.children?.some((c: any) => c.text === "Inner")) return n;
        if (n.children?.length) {
          const r = search(n.children);
          if (r) return r;
        }
      }
      return null;
    }
    return search((window as any).__gridpad.getFrameTree());
  });
  if (!innerNode) {
    fs.writeFileSync("/tmp/probe-inv5-promote.json", JSON.stringify({ error: "inner not found" }, null, 2));
    return;
  }

  // Drill to inner.
  const cx = cbox!.x + innerNode.absX + innerNode.w / 2;
  const cy = cbox!.y + innerNode.absY + innerNode.h / 2;
  await clickAt(page, cx, cy);
  await page.waitForTimeout(400);
  await clickAt(page, cx, cy);
  await page.waitForTimeout(200);

  // Drag inner well below outer (promote).
  const dropY = cbox!.y + outerBefore.y + outerBefore.h + 80;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, dropY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await clickAt(page, cbox!.x + 5, cbox!.y + 5);

  const afterPromote = await getFrames(page);
  const treeAfterPromote = await getTree(page);

  let promotedDragOutcome: any = null;
  if (afterPromote.length === 2) {
    const promoted = afterPromote[1];
    const promotedYBefore = promoted.y;

    // Click promoted (parent-first selects band wrapping it; second click >300ms drills).
    const px2 = cbox!.x + promoted.x + promoted.w / 2;
    const py2 = cbox!.y + promoted.y + promoted.h / 2;
    await clickAt(page, px2, py2);
    await page.waitForTimeout(400);
    await page.mouse.move(px2, py2);
    await page.mouse.down();
    await page.mouse.move(px2, py2 + 18, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await clickAt(page, cbox!.x + 5, cbox!.y + 5);

    const final = await getFrames(page);
    const outerFinal = final.find(f => f.id === outerBefore.id);
    const promotedFinal = final.find(f => f.id === promoted.id);
    promotedDragOutcome = {
      outerYBefore,
      outerYAfter: outerFinal?.y,
      outerYDelta: outerFinal ? outerFinal.y - outerYBefore : null,
      promotedYBefore,
      promotedYAfter: promotedFinal?.y,
      promotedYDelta: promotedFinal ? promotedFinal.y - promotedYBefore : null,
    };
  }

  fs.writeFileSync("/tmp/probe-inv5-promote.json", JSON.stringify({
    summary: "Promote inner, then drag promoted — does outer stay put?",
    promoteResult_topLevelCount: afterPromote.length,
    promoteResult_expected: 2,
    treeAfterPromote_summary: treeAfterPromote.map((t: any) => ({ id: t.id, contentType: t.contentType, childCount: t.childCount })),
    promotedDragOutcome,
  }, null, 2));
});
