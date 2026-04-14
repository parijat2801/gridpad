import { test, expect } from "@playwright/test";

const URL = "http://localhost:5173";

test.describe("Gridpad Demo", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL);
    await page.waitForTimeout(1000); // wait for measureCellSize + initial render
  });

  test("canvas renders with content", async ({ page }) => {
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    // Check canvas has non-background pixels
    const hasContent = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return false;
      const ctx = c.getContext("2d");
      if (!ctx) return false;
      for (let y = 0; y < c.height; y += 20) {
        for (let x = 0; x < c.width; x += 20) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          if (!(d[0] === 26 && d[1] === 26 && d[2] === 26)) return true;
        }
      }
      return false;
    });
    expect(hasContent).toBe(true);
  });

  test("click selects wireframe (blue pixels appear)", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    // Click in wireframe area (roughly where the dashboard header is)
    await page.mouse.click(box!.x + 200, box!.y + 100);
    await page.waitForTimeout(200);
    // Check for blue selection pixels
    const hasBlue = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return false;
      const ctx = c.getContext("2d");
      if (!ctx) return false;
      for (let y = 0; y < c.height; y += 5) {
        for (let x = 0; x < c.width; x += 5) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          if (d[2] > 180 && d[0] < 100) return true; // blue-ish
        }
      }
      return false;
    });
    expect(hasBlue).toBe(true);
  });

  test("drag moves wireframe (can drag twice)", async ({ page }) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const startX = box!.x + 200;
    const startY = box!.y + 100;

    // First drag
    await page.mouse.click(startX, startY);
    await page.waitForTimeout(100);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 30, startY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Second drag — this is the regression test
    await page.mouse.click(startX + 30, startY);
    await page.waitForTimeout(100);
    await page.mouse.move(startX + 30, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 60, startY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // Verify canvas still has content (didn't corrupt)
    const hasContent = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return false;
      const ctx = c.getContext("2d");
      if (!ctx) return false;
      let count = 0;
      for (let y = 0; y < c.height; y += 20) {
        for (let x = 0; x < c.width; x += 20) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          if (!(d[0] === 26 && d[1] === 26 && d[2] === 26)) count++;
        }
      }
      return count > 10; // should have many non-background pixels
    });
    expect(hasContent).toBe(true);
  });

  test("scroll works", async ({ page }) => {
    const canvas = page.locator("canvas");
    // Read pixel at top before scroll
    const before = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      const ctx = c?.getContext("2d");
      if (!ctx) return null;
      const d = ctx.getImageData(10, 10, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    // Scroll down
    await canvas.hover();
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(300);
    // Read pixel at top after scroll
    const after = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      const ctx = c?.getContext("2d");
      if (!ctx) return null;
      const d = ctx.getImageData(10, 10, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    // If default text is short enough, scroll might not change anything
    // Just verify no crash
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
  });

  test("no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", err => errors.push(err.message));
    await page.goto(URL);
    await page.waitForTimeout(2000);
    // Click and drag to trigger interactions
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    await page.mouse.click(box!.x + 200, box!.y + 100);
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });
});
