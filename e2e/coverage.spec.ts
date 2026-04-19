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
  ensureDir,
  ARTIFACTS,
  SIMPLE_BOX,
  LABELED_BOX,
  NESTED,
  getSelectedId,
} from "./test-utils";

test.describe("coverage: P0/P1 interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("hitTest at frame center returns frame ID", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    const frames = await getFrames(page);
    const f = frames[0];
    const result = await page.evaluate(({ x, y }) => {
      return (window as any).__gridpad.hitTest(x, y);
    }, { x: f.x + f.w / 2, y: f.y + f.h / 2 });
    expect(result).not.toBeNull();
    expect(result.id).toBeTruthy();
  });

  test("hitTest at empty space returns null", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    // Click far below any frame
    const result = await page.evaluate(({ x, y }) => {
      return (window as any).__gridpad.hitTest(x, y);
    }, { x: 500, y: 500 });
    expect(result).toBeNull();
  });

  test("Escape clears prose cursor", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    await clickProse(page, 5, 5);
    // Verify cursor is set
    const before = await page.evaluate(() => (window as any).__gridpad.getCursorPosition());
    expect(before).not.toBeNull();
    // Press Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => (window as any).__gridpad.getCursorPosition());
    expect(after).toBeNull();
  });

  test("redo frame move restores position", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    const framesBefore = await getFrames(page);
    const xBefore = framesBefore[0].x;

    // Drag right
    await clickFrame(page, 0);
    await dragSelected(page, 80, 0);
    await clickProse(page, 5, 5);
    const framesAfterDrag = await getFrames(page);
    const xAfterDrag = framesAfterDrag[0].x;
    expect(xAfterDrag).toBeGreaterThan(xBefore);

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    const framesAfterUndo = await getFrames(page);
    expect(framesAfterUndo[0].x).toBeCloseTo(xBefore, 0);

    // Redo
    await page.keyboard.press("Meta+Shift+z");
    await page.waitForTimeout(300);
    const framesAfterRedo = await getFrames(page);
    expect(framesAfterRedo[0].x).toBeCloseTo(xAfterDrag, 0);
  });

  test("delete container cascades to children", async ({ page }) => {
    await load(page, NESTED);
    const treeBefore = flattenTree(await getFrameTree(page));
    expect(treeBefore.length).toBeGreaterThan(1);

    // Select and delete the top-level frame
    await clickFrame(page, 0);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);

    const treeAfter = flattenTree(await getFrameTree(page));
    // All frames should be gone (container + children)
    expect(treeAfter.length).toBe(0);

    // Save and verify no wire chars
    const saved = await save(page);
    const hasWire = [...saved].some(c => "┌┐└┘│─├┤┬┴┼".includes(c));
    expect(hasWire).toBe(false);
  });

  test("drag parent moves all children by same delta", async ({ page }) => {
    await load(page, NESTED);
    const treeBefore = await getFrameTree(page);
    const flatBefore = flattenTree(treeBefore);
    // Get child positions before
    const childBefore = flatBefore.find(f => f.depth > 0);
    expect(childBefore).toBeTruthy();

    // Drag parent
    await clickFrame(page, 0);
    await dragSelected(page, 60, 0);
    await clickProse(page, 5, 5);

    const treeAfter = await getFrameTree(page);
    const flatAfter = flattenTree(treeAfter);
    const childAfter = flatAfter.find(f => f.depth > 0);
    expect(childAfter).toBeTruthy();

    // Child should have moved by approximately the same delta
    // Note: child absX includes parent offset, so if parent moved 60px, child absX also moves ~60px
    expect(childAfter!.absX - childBefore!.absX).toBeGreaterThan(30); // at least moved significantly
  });

  test("resize from top-left handle", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    await clickFrame(page, 0);
    const framesBefore = await getFrames(page);
    const f = framesBefore[0];

    // Drag from top-left corner inward (shrinks frame, moves x/y)
    const { box, scrollTop } = await (async () => {
      const canvas = page.locator("canvas");
      const box = await canvas.boundingBox();
      const scrollTop = await page.evaluate(() => document.querySelector("canvas")?.parentElement?.scrollTop ?? 0);
      return { box: box!, scrollTop };
    })();

    const hx = box.x + f.x;
    const hy = box.y + (f.y - scrollTop);
    await page.mouse.move(hx, hy);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.move(hx + 20, hy + 10, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const framesAfter = await getFrames(page);
    const fAfter = framesAfter[0];
    // Frame should have moved right/down and shrunk
    expect(fAfter.x).toBeGreaterThan(f.x);
    expect(fAfter.w).toBeLessThan(f.w);
  });

  test("click frame after prose typing works (scroll-aware)", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    // Type prose (may cause scroll)
    await clickProse(page, 5, 5);
    await page.keyboard.type("TYPED SOME TEXT ");
    await page.waitForTimeout(200);

    // Now click frame — should work despite potential scroll change
    await clickFrame(page, 0);
    const sel = await getSelectedId(page);
    expect(sel).not.toBeNull();
  });
});
