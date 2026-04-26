/**
 * Multi-step user workflow tests.
 *
 * Each test exercises a realistic sequence of interactions:
 * load → interact → save → verify. Tests cover dragging, resizing,
 * typing, deleting, undo/redo, and working with nested frames.
 */
import { test, expect } from "@playwright/test";
import {
  load,
  save,
  clickFrame,
  dragSelected,
  resizeSelected,
  clickProse,
  getFrames,
  getFrameTree,
  findGhostsFromPage,
  checkInvariants,
  flattenTree,
  getRenderedLines,
  ensureDir,
  writeArtifact,
  ARTIFACTS,
  SIMPLE_BOX,
  LABELED_BOX,
  NESTED,
  TWO_SEPARATE,
  PURE_PROSE,
  WITH_CHILDREN,
  dblclickFrame,
  clickChild,
  getSelectedId,
} from "./test-utils";

test.describe("workflows", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  // ── 1 ──────────────────────────────────────────────────────────────────────
  test("default doc: drag dashboard right, save, reload", async ({ page }) => {
    const name = "workflow-01-drag-dashboard";

    // Default doc is already loaded on page.goto("/")
    await page.waitForTimeout(1000);

    // Select and drag frame 0 (Dashboard) 80px to the right
    await clickFrame(page, 0);
    await dragSelected(page, 80, 0);

    // Deselect by clicking prose
    await clickProse(page, 5, 5);

    // Save and capture output
    const md = await save(page);
    writeArtifact(name, "output.md", md);

    // Verify expected content present
    expect(md).toContain("Dashboard");
    expect(md).toContain("Mobile");
    expect(md).toContain("┌");

    // No ghosts
    const ghosts = await findGhostsFromPage(page, md);
    writeArtifact(name, "ghosts.json", JSON.stringify(ghosts, null, 2));
    expect(ghosts, `Ghosts found: ${ghosts.join("; ")}`).toHaveLength(0);

    // Frame tree invariants
    const tree = await getFrameTree(page);
    const inv = checkInvariants(tree);
    expect(inv, `Invariants failed: ${inv.join("; ")}`).toHaveLength(0);

    // Reload saved doc and verify it still contains key strings
    await load(page, md);
    await page.waitForTimeout(500);
    const md2 = await save(page);
    writeArtifact(name, "reload.md", md2);
    expect(md2).toContain("Dashboard");
    expect(md2).toContain("Mobile");
    expect(md2).toContain("┌");
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────
  test("create wireframe from scratch", async ({ page }) => {
    const name = "workflow-02-draw-rect";

    await load(page, PURE_PROSE);
    await page.waitForTimeout(500);

    // Escape to clear any active state, then press R to enter rect-draw mode
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await page.keyboard.press("r");
    await page.waitForTimeout(100);

    // Draw a rectangle in the canvas by mouse drag
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const startX = box!.x + 80;
    const startY = box!.y + 120;
    const endX = startX + 200;
    const endY = startY + 80;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move in steps so the app registers the drag
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        startX + ((endX - startX) * i) / 10,
        startY + ((endY - startY) * i) / 10,
      );
    }
    await page.mouse.up();
    await page.waitForTimeout(400);

    // Return to select mode
    await page.keyboard.press("v");
    await page.waitForTimeout(200);

    const md = await save(page);
    writeArtifact(name, "output.md", md);

    // Output should contain box-drawing characters
    const hasBox = md.includes("┌") || md.includes("└") || md.includes("─");
    expect(hasBox, `No box-drawing chars in output:\n${md}`).toBe(true);

    // Frame tree should be valid
    const tree = await getFrameTree(page);
    const inv = checkInvariants(tree);
    expect(inv, `Invariants: ${inv.join("; ")}`).toHaveLength(0);
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────
  test("type 3 lines above wireframe pushes it down", async ({ page }) => {
    const name = "workflow-03-insert-lines";

    await load(page, SIMPLE_BOX);
    await page.waitForTimeout(500);

    // Count lines before ┌ in input
    const inputLines = SIMPLE_BOX.split("\n");
    const inputBoxRow = inputLines.findIndex(l => l.includes("┌"));

    // Click near the top prose area to place cursor
    await clickProse(page, 60, 10);
    await page.waitForTimeout(200);

    // Move to end of line then press Enter 3 times to insert blank lines
    await page.keyboard.press("End");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(300);

    const md = await save(page);
    writeArtifact(name, "output.md", md);

    // Row of ┌ in output should be further down than in input
    const outputLines = md.split("\n");
    const outputBoxRow = outputLines.findIndex(l => l.includes("┌"));
    writeArtifact(name, "rows.json", JSON.stringify({ inputBoxRow, outputBoxRow }, null, 2));

    expect(outputBoxRow).toBeGreaterThan(inputBoxRow);

    // No ghosts
    const ghosts = await findGhostsFromPage(page, md);
    expect(ghosts, `Ghosts: ${ghosts.join("; ")}`).toHaveLength(0);
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────
  test("resize wider then verify persists after save+reload", async ({ page }) => {
    const name = "workflow-04-resize-wider";

    await load(page, SIMPLE_BOX);
    await page.waitForTimeout(500);

    await clickFrame(page, 0);

    // Record original width
    const framesBefore = await getFrames(page);
    const selId = await getSelectedId(page);
    const fBefore = framesBefore.find(f => f.id === selId)!;
    const originalW = fBefore.w;

    // Resize wider by 60px
    await resizeSelected(page, 60, 0);
    await page.waitForTimeout(300);

    // Save
    const md = await save(page);
    writeArtifact(name, "output.md", md);

    // Reload saved doc
    await load(page, md);
    await page.waitForTimeout(500);
    await clickFrame(page, 0);

    const framesAfter = await getFrames(page);
    const fAfter = framesAfter[0];
    writeArtifact(name, "sizes.json", JSON.stringify({ originalW, afterW: fAfter.w }, null, 2));

    // After reload, box should be wider than original
    expect(fAfter.w).toBeGreaterThan(originalW);

    // No ghosts
    const md2 = await save(page);
    const ghosts = await findGhostsFromPage(page, md2);
    expect(ghosts, `Ghosts: ${ghosts.join("; ")}`).toHaveLength(0);
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────
  test("rearrange two wireframes: A dragged below B", async ({ page }) => {
    const name = "workflow-05-rearrange";

    await load(page, TWO_SEPARATE);
    await page.waitForTimeout(500);

    // Frame 0 is box A (top). Drag it down 150px so it ends up below box B.
    await clickFrame(page, 0);
    await dragSelected(page, 0, 150);
    await clickProse(page, 5, 5);

    const md = await save(page);
    writeArtifact(name, "output.md", md);

    // Find row positions of "A" and "B" labels in the output
    const lines = md.split("\n");
    const rowA = lines.findIndex(l => l.includes("│ A"));
    const rowB = lines.findIndex(l => l.includes("│ B"));
    writeArtifact(name, "rows.json", JSON.stringify({ rowA, rowB }, null, 2));

    // A should now appear below B in the serialized output
    expect(rowA).toBeGreaterThan(-1);
    expect(rowB).toBeGreaterThan(-1);
    expect(rowA).toBeGreaterThan(rowB);

    // No ghosts
    const ghosts = await findGhostsFromPage(page, md);
    expect(ghosts, `Ghosts: ${ghosts.join("; ")}`).toHaveLength(0);

    const tree = await getFrameTree(page);
    const inv = checkInvariants(tree);
    expect(inv, `Invariants: ${inv.join("; ")}`).toHaveLength(0);
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────
  test("edit, undo, save — box reverts to original position", async ({ page }) => {
    const name = "workflow-06-undo";

    await load(page, SIMPLE_BOX);
    await page.waitForTimeout(500);

    // Record original box position (row of ┌)
    const inputLines = SIMPLE_BOX.split("\n");
    const origBoxRow = inputLines.findIndex(l => l.includes("┌"));

    // Drag frame right
    await clickFrame(page, 0);
    await dragSelected(page, 80, 0);
    await clickProse(page, 5, 5);

    // Undo the drag
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+z`);
    await page.waitForTimeout(400);

    const md = await save(page);
    writeArtifact(name, "output.md", md);

    // After undo, the ┌ line should have no leading indentation (box back at col 0)
    const outputLines = md.split("\n");
    const boxLine = outputLines.find(l => l.includes("┌"));
    writeArtifact(name, "boxline.txt", boxLine ?? "(not found)");

    // Box should be back near original position — ┌ at start of line (no big indent)
    expect(boxLine).toBeDefined();
    const leadingSpaces = boxLine!.match(/^(\s*)/)?.[1].length ?? 0;
    expect(leadingSpaces).toBeLessThan(5);

    // No ghosts
    const ghosts = await findGhostsFromPage(page, md);
    expect(ghosts, `Ghosts: ${ghosts.join("; ")}`).toHaveLength(0);
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────
  test("delete wireframe, type in freed space", async ({ page }) => {
    const name = "workflow-07-delete-and-type";

    await load(page, SIMPLE_BOX);
    await page.waitForTimeout(500);

    // Select and delete the wireframe
    await clickFrame(page, 0);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(400);

    // Click in the now-freed area and type
    await clickProse(page, 60, 80);
    await page.waitForTimeout(200);
    await page.keyboard.type("replaced");
    await page.waitForTimeout(300);

    const md = await save(page);
    writeArtifact(name, "output.md", md);

    // No box-drawing characters should remain
    expect(md, "┌ found after delete").not.toContain("┌");
    expect(md, "└ found after delete").not.toContain("└");

    // Typed text must appear in output
    expect(md).toContain("replaced");
  });

  // ── 8 ──────────────────────────────────────────────────────────────────────
  test("work with nested boxes: drag outer, save, no ghosts", async ({ page }) => {
    const name = "workflow-08-nested";

    await load(page, NESTED);
    await page.waitForTimeout(500);

    // Select the outer (top-level) frame and drag it right
    await clickFrame(page, 0);
    await dragSelected(page, 60, 0);
    await clickProse(page, 5, 5);

    const md = await save(page);
    writeArtifact(name, "output.md", md);

    // Both outer and inner labels must survive
    expect(md).toContain("Outer");
    expect(md).toContain("Inner");
    expect(md).toContain("┌");

    // No ghosts — critical for nested frames
    const ghosts = await findGhostsFromPage(page, md);
    writeArtifact(name, "ghosts.json", JSON.stringify(ghosts, null, 2));
    expect(ghosts, `Ghosts: ${ghosts.join("; ")}`).toHaveLength(0);

    // Tree invariants
    const tree = await getFrameTree(page);
    const inv = checkInvariants(tree);
    expect(inv, `Invariants: ${inv.join("; ")}`).toHaveLength(0);

    // Nesting depth must be > 0 (inner frame exists as child)
    const flat = flattenTree(tree);
    const maxDepth = Math.max(...flat.map(f => f.depth));
    expect(maxDepth).toBeGreaterThanOrEqual(1);
  });

  // ── 9 ──────────────────────────────────────────────────────────────────────
  test("default doc save contains all expected section headings", async ({ page }) => {
    const name = "workflow-09-default-save";

    // Default doc is already loaded
    await page.waitForTimeout(1000);

    // Get current state via serializeDocument (no mutations)
    const md: string = await page.evaluate(() =>
      (window as any).__gridpad.serializeDocument(),
    );
    writeArtifact(name, "serialized.md", md);

    // Save via full save flow (updates refs)
    const saved = await save(page);
    writeArtifact(name, "saved.md", saved);

    // Both should contain the key section markers
    for (const frag of ["Dashboard", "Mobile", "┌", "└"]) {
      expect(md, `serializeDocument missing: ${frag}`).toContain(frag);
      expect(saved, `saveDocument missing: ${frag}`).toContain(frag);
    }

    // Frame tree must be valid
    const tree = await getFrameTree(page);
    const inv = checkInvariants(tree);
    expect(inv, `Invariants: ${inv.join("; ")}`).toHaveLength(0);

    // Rendered lines should include Dashboard text
    const rendered = await getRenderedLines(page);
    const hasHeading = rendered.some(l => l.text.includes("Dashboard") || l.text.includes("Gridpad"));
    expect(hasHeading, "No Dashboard/Gridpad heading in rendered lines").toBe(true);
  });

  // ── 10 ─────────────────────────────────────────────────────────────────────
  test("edit default doc prose between wireframes, save contains new text", async ({ page }) => {
    const name = "workflow-10-prose-edit";

    // Default doc already loaded
    await page.waitForTimeout(1000);

    // Click in a prose area well away from wireframes (top of canvas)
    await clickProse(page, 5, 300);
    await page.waitForTimeout(300);

    // Type a recognizable string
    await page.keyboard.type("NEW SECTION");
    await page.waitForTimeout(300);

    const md = await save(page);
    writeArtifact(name, "output.md", md);

    // Must contain the typed text
    expect(md).toContain("NEW SECTION");

    // Key wireframe content must still be present
    expect(md).toContain("Dashboard");
    expect(md).toContain("Mobile");
    expect(md).toContain("┌");

    // No ghosts
    const ghosts = await findGhostsFromPage(page, md);
    writeArtifact(name, "ghosts.json", JSON.stringify(ghosts, null, 2));
    expect(ghosts, `Ghosts: ${ghosts.join("; ")}`).toHaveLength(0);

    // Frame tree invariants
    const tree = await getFrameTree(page);
    const inv = checkInvariants(tree);
    expect(inv, `Invariants: ${inv.join("; ")}`).toHaveLength(0);
  });
});
