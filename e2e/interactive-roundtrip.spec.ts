/**
 * Interactive round-trip tests.
 *
 * Load a known markdown → make specific edits → serialize → reload → verify
 * both the markdown content and visual match.
 */
import { test, expect, type Page } from "@playwright/test";

async function loadMarkdown(page: Page, md: string): Promise<void> {
  await page.evaluate((text) => (window as any).__gridpad.loadDocument(text), md);
  await page.waitForTimeout(500);
}

async function serializeMarkdown(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__gridpad.serializeDocument());
}

async function canvasScreenshot(page: Page): Promise<Buffer> {
  return page.locator("canvas").screenshot();
}

async function pixelDiffPercent(page: Page, buf1: Buffer, buf2: Buffer): Promise<number> {
  return page.evaluate(async ({ b1, b2 }) => {
    const toImg = (data: number[]): Promise<ImageBitmap> => {
      const blob = new Blob([new Uint8Array(data)], { type: "image/png" });
      return createImageBitmap(blob);
    };
    const img1 = await toImg(b1);
    const img2 = await toImg(b2);
    const c = document.createElement("canvas");
    c.width = img1.width; c.height = img1.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img1, 0, 0);
    const d1 = ctx.getImageData(0, 0, c.width, c.height).data;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img2, 0, 0);
    const d2 = ctx.getImageData(0, 0, c.width, c.height).data;
    let diff = 0;
    for (let i = 0; i < d1.length; i += 4) {
      if (Math.abs(d1[i] - d2[i]) + Math.abs(d1[i+1] - d2[i+1]) + Math.abs(d1[i+2] - d2[i+2]) > 30) diff++;
    }
    return (diff / (d1.length / 4)) * 100;
  }, { b1: [...buf1], b2: [...buf2] });
}

// ── The test document ──────────────────────────────────────

const TEST_DOC = `# My Project Plan

This document describes the architecture. Here is a key diagram:


┌──────────────────────────────┐
│        API Gateway           │
├──────────┬───────────────────┤
│ Auth     │  Router            │
│ Service  │                   │
└──────────┴───────────────────┘


The gateway handles all incoming requests.

Below is the database schema:


┌────────────┐  ┌────────────┐
│  Users     │  │  Posts      │
│  id        │  │  id         │
│  name      │  │  user_id    │
│  email     │  │  title      │
└────────────┘  └────────────┘


Each user can have many posts.`;

// ── Tests ──────────────────────────────────────────────────

test.describe("interactive round-trip", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
  });

  test("1. load doc — no edits — serialize matches original", async ({ page }) => {
    await loadMarkdown(page, TEST_DOC);
    const shot1 = await canvasScreenshot(page);

    const serialized = await serializeMarkdown(page);
    expect(serialized).toBe(TEST_DOC);

    // Reload serialized, screenshot should match
    await loadMarkdown(page, serialized);
    const shot2 = await canvasScreenshot(page);
    const diff = await pixelDiffPercent(page, shot1, shot2);
    console.log(`no-edit pixel diff: ${diff.toFixed(2)}%`);
    expect(diff).toBeLessThan(1);
  });

  test("2. type 'HELLO ' at start of first line", async ({ page }) => {
    await loadMarkdown(page, TEST_DOC);

    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click start of "# My Project Plan"
    await page.mouse.click(box!.x + 5, box!.y + 5);
    await page.waitForTimeout(300);
    await page.keyboard.press("Home");
    await page.waitForTimeout(100);

    // Type
    await page.keyboard.type("HELLO ");
    await page.waitForTimeout(300);

    const shotEdited = await canvasScreenshot(page);
    const saved = await serializeMarkdown(page);

    // Verify the text was inserted
    expect(saved.startsWith("HELLO # My Project Plan")).toBe(true);
    // Wireframes must survive
    expect(saved).toContain("┌──────────────────────────────┐");
    expect(saved).toContain("│        API Gateway           │");
    expect(saved).toContain("├──────────┬───────────────────┤");
    expect(saved).toContain("┌────────────┐  ┌────────────┐");

    // Reload and compare visually
    await loadMarkdown(page, saved);
    const shotReloaded = await canvasScreenshot(page);
    const diff = await pixelDiffPercent(page, shotEdited, shotReloaded);
    console.log(`type-at-start pixel diff: ${diff.toFixed(2)}%`);
    expect(diff).toBeLessThan(5);
  });

  test("3. press Enter 3 times above first wireframe", async ({ page }) => {
    await loadMarkdown(page, TEST_DOC);

    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click on "This document describes..." line (line 3, ~y=40)
    await page.mouse.click(box!.x + 200, box!.y + 40);
    await page.waitForTimeout(300);
    await page.keyboard.press("End");
    await page.waitForTimeout(100);

    // Press Enter 3 times
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    const shotEdited = await canvasScreenshot(page);
    const saved = await serializeMarkdown(page);

    // Original doc has API Gateway wireframe — must still be there
    expect(saved).toContain("API Gateway");
    expect(saved).toContain("Auth");
    expect(saved).toContain("Router");
    // The database wireframe too
    expect(saved).toContain("Users");
    expect(saved).toContain("Posts");
    // Junction chars preserved
    expect(saved).toContain("├");
    expect(saved).toContain("┬");
    expect(saved).toContain("┤");

    // Count newlines — should have 3 more than original
    const origNewlines = (TEST_DOC.match(/\n/g) ?? []).length;
    const savedNewlines = (saved.match(/\n/g) ?? []).length;
    console.log(`newlines: ${origNewlines} → ${savedNewlines} (delta: ${savedNewlines - origNewlines})`);
    expect(savedNewlines).toBe(origNewlines + 3);

    // Visual round-trip
    await loadMarkdown(page, saved);
    const shotReloaded = await canvasScreenshot(page);
    const diff = await pixelDiffPercent(page, shotEdited, shotReloaded);
    console.log(`enter-3x pixel diff: ${diff.toFixed(2)}%`);
    expect(diff).toBeLessThan(5);
  });

  test("4. Backspace to merge two prose lines", async ({ page }) => {
    await loadMarkdown(page, TEST_DOC);

    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click on "The gateway handles..." (line after first wireframe)
    // That's roughly y = 220 (after the API Gateway box)
    await page.mouse.click(box!.x + 5, box!.y + 220);
    await page.waitForTimeout(300);
    await page.keyboard.press("Home");
    await page.waitForTimeout(100);

    // Backspace to merge with previous line
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);

    const shotEdited = await canvasScreenshot(page);
    const saved = await serializeMarkdown(page);

    // All wireframes still present
    expect(saved).toContain("┌──────────────────────────────┐");
    expect(saved).toContain("┌────────────┐  ┌────────────┐");
    // Text still present
    expect(saved).toContain("gateway handles");
    expect(saved).toContain("Each user can have many posts");

    // Visual round-trip
    await loadMarkdown(page, saved);
    const shotReloaded = await canvasScreenshot(page);
    const diff = await pixelDiffPercent(page, shotEdited, shotReloaded);
    console.log(`backspace-merge pixel diff: ${diff.toFixed(2)}%`);
    expect(diff).toBeLessThan(5);
  });

  test("5. drag first wireframe right, then serialize", async ({ page }) => {
    await loadMarkdown(page, TEST_DOC);

    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click on the API Gateway wireframe center (~y=120, ~x=150)
    const wx = box!.x + 150, wy = box!.y + 120;
    await page.mouse.click(wx, wy);
    await page.waitForTimeout(300);

    // Drag right 80px
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(wx + i * 10, wy);
    await page.mouse.up();
    await page.waitForTimeout(500);

    // Deselect by clicking empty area
    await page.mouse.click(box!.x + 5, box!.y + 400);
    await page.waitForTimeout(300);

    const shotDragged = await canvasScreenshot(page);
    const saved = await serializeMarkdown(page);

    // Box chars must still exist
    expect(saved).toContain("┌");
    expect(saved).toContain("┘");
    expect(saved).toContain("API Gateway");

    // Second wireframe unaffected
    expect(saved).toContain("Users");
    expect(saved).toContain("Posts");

    // Reload and compare
    await loadMarkdown(page, saved);
    const shotReloaded = await canvasScreenshot(page);
    const diff = await pixelDiffPercent(page, shotDragged, shotReloaded);
    console.log(`drag-right pixel diff: ${diff.toFixed(2)}%`);
    expect(diff).toBeLessThan(5);
  });

  test("6. type between two wireframes", async ({ page }) => {
    await loadMarkdown(page, TEST_DOC);

    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click on "The gateway handles..." text between the two wireframes
    await page.mouse.click(box!.x + 300, box!.y + 220);
    await page.waitForTimeout(300);
    await page.keyboard.press("End");
    await page.waitForTimeout(100);

    // Type new sentence
    await page.keyboard.type(" It validates tokens and routes.");
    await page.waitForTimeout(300);

    const shotEdited = await canvasScreenshot(page);
    const saved = await serializeMarkdown(page);

    expect(saved).toContain("It validates tokens and routes.");
    // Both wireframes intact
    expect(saved).toContain("API Gateway");
    expect(saved).toContain("Users");
    expect(saved).toContain("Posts");
    expect(saved).toContain("├");

    // Visual round-trip
    await loadMarkdown(page, saved);
    const shotReloaded = await canvasScreenshot(page);
    const diff = await pixelDiffPercent(page, shotEdited, shotReloaded);
    console.log(`type-between pixel diff: ${diff.toFixed(2)}%`);
    expect(diff).toBeLessThan(5);
  });

  test("7. multiple edits: type + Enter + type + serialize", async ({ page }) => {
    await loadMarkdown(page, TEST_DOC);

    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click at end of first line
    await page.mouse.click(box!.x + 300, box!.y + 5);
    await page.waitForTimeout(300);
    await page.keyboard.press("End");

    // Type, then Enter, then type more
    await page.keyboard.type(" (v2)");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Updated: April 2026");
    await page.waitForTimeout(300);

    const shotEdited = await canvasScreenshot(page);
    const saved = await serializeMarkdown(page);

    expect(saved).toContain("(v2)");
    expect(saved).toContain("Updated: April 2026");
    expect(saved).toContain("API Gateway");
    expect(saved).toContain("┌────────────┐  ┌────────────┐");

    // Visual round-trip
    await loadMarkdown(page, saved);
    const shotReloaded = await canvasScreenshot(page);
    const diff = await pixelDiffPercent(page, shotEdited, shotReloaded);
    console.log(`multi-edit pixel diff: ${diff.toFixed(2)}%`);
    expect(diff).toBeLessThan(5);
  });

  test("8. save twice without editing = identical output", async ({ page }) => {
    await loadMarkdown(page, TEST_DOC);

    const save1 = await serializeMarkdown(page);
    // Simulate the ref updates that saveToHandle does
    await loadMarkdown(page, save1);
    const save2 = await serializeMarkdown(page);

    expect(save2).toBe(save1);
  });
});
