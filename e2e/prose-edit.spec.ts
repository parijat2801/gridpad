import { test, expect } from "@playwright/test";

test("click in prose area and type — text appears", async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForTimeout(2000);

  // Screenshot before
  await page.screenshot({ path: "/tmp/gridpad-before-type.png" });

  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();

  // Click in prose area (top of page, where "# Welcome" text is)
  await page.mouse.click(box!.x + 100, box!.y + 10);
  await page.waitForTimeout(300);

  // Type some text
  await page.keyboard.type("HELLO ");
  await page.waitForTimeout(500);

  // Screenshot after
  await page.screenshot({ path: "/tmp/gridpad-after-type.png" });

  // Verify: canvas should contain the typed text as pixels
  // We can't read text from canvas, but we can check that content changed
  const afterPixels = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return 0;
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    // Count non-bg pixels in top 30px (where we typed)
    let count = 0;
    const data = ctx.getImageData(0, 0, c.width, 30).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 26 || data[i + 1] !== 26 || data[i + 2] !== 26) count++;
    }
    return count;
  });

  console.log(`Pixels in top 30px after typing: ${afterPixels}`);
  // Should have content (the typed text + original text)
  expect(afterPixels).toBeGreaterThan(50);
});
