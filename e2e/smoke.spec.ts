import { test, expect } from "@playwright/test";

test.describe("Gridpad Demo", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
  });

  test("canvas renders with visible content (not black)", async ({ page }) => {
    const contentPixels = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return 0;
      const ctx = c.getContext("2d");
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== 26 || data[i + 1] !== 26 || data[i + 2] !== 26) count++;
      }
      return count;
    });
    console.log(`Content pixels: ${contentPixels}`);
    expect(contentPixels).toBeGreaterThan(1000);
  });

  test("click selects wireframe (blue pixels appear)", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    await page.mouse.click(box!.x + 200, box!.y + 110);
    await page.waitForTimeout(300);
    const bluePixels = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return 0;
      const ctx = c.getContext("2d");
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 2] > 180 && data[i] < 100 && data[i + 1] < 160) count++;
      }
      return count;
    });
    console.log(`Blue pixels: ${bluePixels}`);
    expect(bluePixels).toBeGreaterThan(0);
  });

  test("drag twice without corruption", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const x = box!.x + 200, y = box!.y + 110;

    // First drag
    await page.mouse.click(x, y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(x + i * 10, y);
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Second drag
    await page.mouse.click(x + 50, y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(x + 50 + i * 10, y);
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Canvas still has content
    const pixels = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return 0;
      const ctx = c.getContext("2d");
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== 26 || data[i + 1] !== 26 || data[i + 2] !== 26) count++;
      }
      return count;
    });
    console.log(`Content after 2 drags: ${pixels}`);
    expect(pixels).toBeGreaterThan(500);
  });

  test("no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", err => errors.push(err.message));
    await page.goto("/");
    await page.waitForTimeout(2000);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + 200, box.y + 110);
      await page.waitForTimeout(200);
    }
    const real = errors.filter(e => !e.includes("React DevTools"));
    expect(real).toEqual([]);
  });
});
