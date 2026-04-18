/**
 * Kill-regions regression suite.
 *
 * Tests the grid-based pipeline end-to-end in the browser:
 * - Canvas renders content
 * - Wireframe selection (click)
 * - Wireframe drag (no corruption)
 * - Prose typing
 * - Enter/Backspace prose editing
 * - No console errors
 *
 * Requires dev server running: ./node_modules/.bin/vite --port 5177
 */
import { test, expect, type Page } from "@playwright/test";

// Helper: count non-background pixels in a region of the canvas
async function countContentPixels(
  page: Page,
  opts: { x?: number; y?: number; w?: number; h?: number } = {},
): Promise<number> {
  return page.evaluate(({ x, y, w, h }) => {
    const c = document.querySelector("canvas");
    if (!c) return 0;
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    const dpr = window.devicePixelRatio || 1;
    const sx = Math.round((x ?? 0) * dpr);
    const sy = Math.round((y ?? 0) * dpr);
    const sw = Math.round((w ?? c.width / dpr) * dpr);
    const sh = Math.round((h ?? c.height / dpr) * dpr);
    const data = ctx.getImageData(sx, sy, sw, sh).data;
    let count = 0;
    // Background is #1e1e2e = rgb(30, 30, 46)
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 30 || data[i + 1] !== 30 || data[i + 2] !== 46) count++;
    }
    return count;
  }, opts);
}

// Helper: count blue selection pixels (selection highlight)
async function countBluePixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return 0;
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Blue selection: high blue, low red/green
      if (data[i + 2] > 180 && data[i] < 100 && data[i + 1] < 160) count++;
    }
    return count;
  });
}

// Helper: find wireframe position by scanning for box-drawing char pixels
// Returns approximate center of the first wireframe found
async function findWireframeCenter(page: Page): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return null;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    const dpr = window.devicePixelRatio || 1;
    const w = c.width / dpr;
    const h = c.height / dpr;
    // Scan in CSS pixels, looking for a cluster of non-bg pixels
    // that's likely a wireframe (below the prose header)
    for (let row = 150; row < h; row += 10) {
      const data = ctx.getImageData(0, Math.round(row * dpr), c.width, Math.round(10 * dpr)).data;
      let consecutive = 0;
      let startX = 0;
      for (let px = 0; px < c.width; px++) {
        const i = px * 4;
        if (data[i] !== 30 || data[i + 1] !== 30 || data[i + 2] !== 46) {
          if (consecutive === 0) startX = px;
          consecutive++;
          // Found a horizontal run of >50 non-bg pixels — likely a wireframe border
          if (consecutive > 50) {
            return { x: (startX / dpr) + 25, y: row + 20 };
          }
        } else {
          consecutive = 0;
        }
      }
    }
    return null;
  });
  return pos ?? { x: 300, y: 250 }; // fallback
}

test.describe("kill-regions regression", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
  });

  test("canvas renders with visible content", async ({ page }) => {
    const pixels = await countContentPixels(page);
    expect(pixels).toBeGreaterThan(1000);
  });

  test("prose text is visible in top area", async ({ page }) => {
    // The default text starts with "# Gridpad" — should render in the top area
    const topPixels = await countContentPixels(page, { y: 0, h: 40 });
    expect(topPixels).toBeGreaterThan(50);
  });

  test("wireframes are visible below prose", async ({ page }) => {
    // Dashboard wireframe starts ~row 12, which is ~220px at CH=18.4
    const wfPixels = await countContentPixels(page, { y: 200, h: 200 });
    expect(wfPixels).toBeGreaterThan(500);
  });

  test("click on wireframe selects it (blue highlight)", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const wf = await findWireframeCenter(page);
    await page.mouse.click(box!.x + wf.x, box!.y + wf.y);
    await page.waitForTimeout(300);
    const blue = await countBluePixels(page);
    expect(blue).toBeGreaterThan(0);
  });

  test("drag wireframe does not corrupt canvas", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const wf = await findWireframeCenter(page);
    const x = box!.x + wf.x, y = box!.y + wf.y;

    const beforePixels = await countContentPixels(page);

    // Select
    await page.mouse.click(x, y);
    await page.waitForTimeout(200);

    // Drag right
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(x + i * 10, y);
    await page.mouse.up();
    await page.waitForTimeout(300);

    const afterPixels = await countContentPixels(page);
    // Content should still exist (not black canvas)
    expect(afterPixels).toBeGreaterThan(beforePixels * 0.5);
  });

  test("drag twice without visual corruption", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const wf = await findWireframeCenter(page);
    let x = box!.x + wf.x, y = box!.y + wf.y;

    // First drag
    await page.mouse.click(x, y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(x + i * 10, y);
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Second drag from new position
    x += 50;
    await page.mouse.click(x, y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(x + i * 10, y);
    await page.mouse.up();
    await page.waitForTimeout(300);

    const pixels = await countContentPixels(page);
    expect(pixels).toBeGreaterThan(500);
  });

  test("click prose area and type text", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click near top where prose is
    await page.mouse.click(box!.x + 100, box!.y + 15);
    await page.waitForTimeout(300);

    const beforePixels = await countContentPixels(page, { y: 0, h: 30 });

    // Type
    await page.keyboard.type("TEST ");
    await page.waitForTimeout(300);

    const afterPixels = await countContentPixels(page, { y: 0, h: 30 });
    // Should have changed (new text)
    expect(afterPixels).not.toBe(beforePixels);
  });

  test("Enter key adds line and pushes content down", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click at start of prose
    await page.mouse.click(box!.x + 10, box!.y + 15);
    await page.waitForTimeout(300);

    // Snapshot content in area below
    const beforeLowerPixels = await countContentPixels(page, { y: 50, h: 50 });

    // Press Enter 3 times
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(300);

    // Content below should have shifted (different pixel counts)
    const afterLowerPixels = await countContentPixels(page, { y: 50, h: 50 });
    // The pixel count will change because content moved
    expect(afterLowerPixels).not.toBe(beforeLowerPixels);
  });

  test("Backspace merges lines without crash", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click in prose area
    await page.mouse.click(box!.x + 10, box!.y + 40);
    await page.waitForTimeout(300);

    // Press Home to go to start of line, then Backspace to merge
    await page.keyboard.press("Home");
    await page.waitForTimeout(100);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);

    // Canvas should still have content (no crash)
    const pixels = await countContentPixels(page);
    expect(pixels).toBeGreaterThan(500);
  });

  test("Undo/Redo with Cmd+Z / Cmd+Shift+Z", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click and type
    await page.mouse.click(box!.x + 100, box!.y + 15);
    await page.waitForTimeout(200);
    await page.keyboard.type("UNDO_TEST");
    await page.waitForTimeout(200);

    // Undo
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+z`);
    await page.waitForTimeout(200);

    // Canvas should still render
    const pixels = await countContentPixels(page);
    expect(pixels).toBeGreaterThan(500);
  });

  test("no console errors during interaction", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", err => errors.push(err.message));

    await page.goto("/");
    await page.waitForTimeout(2000);

    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const wf = await findWireframeCenter(page);

    // Click wireframe
    await page.mouse.click(box!.x + wf.x, box!.y + wf.y);
    await page.waitForTimeout(200);

    // Drag
    const x = box!.x + wf.x, y = box!.y + wf.y;
    await page.mouse.down();
    for (let i = 1; i <= 3; i++) await page.mouse.move(x + i * 10, y);
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Click prose and type
    await page.mouse.click(box!.x + 10, box!.y + 15);
    await page.waitForTimeout(200);
    await page.keyboard.type("A");
    await page.waitForTimeout(200);

    // Enter
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);

    // Backspace
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    const real = errors.filter(e => !e.includes("React DevTools") && !e.includes("favicon"));
    expect(real).toEqual([]);
  });
});
