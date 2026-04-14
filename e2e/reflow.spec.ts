import { test, expect } from "@playwright/test";

test("drag wireframe down — prose text appears above it", async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForTimeout(2000);

  // Screenshot before drag
  await page.screenshot({ path: "/tmp/gridpad-before-drag.png" });

  // The wireframe is roughly at y=90-230 in the default layout
  // Click in the middle of that band to select it
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  const wireY = 150; // roughly center of wireframe
  await page.mouse.click(box!.x + 200, box!.y + wireY);
  await page.waitForTimeout(200);

  // Drag wireframe down by 100px
  await page.mouse.move(box!.x + 200, box!.y + wireY);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(box!.x + 200, box!.y + wireY + i * 10);
    await new Promise(r => setTimeout(r, 16));
  }
  await page.mouse.up();
  await page.waitForTimeout(300);

  // Screenshot after drag
  await page.screenshot({ path: "/tmp/gridpad-after-drag.png" });

  // Verify: wireframe moved down
  const afterY = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return -1;
    const ctx = c.getContext("2d");
    if (!ctx) return -1;
    for (let y = 0; y < c.height; y += 2) {
      let count = 0;
      for (let x = 0; x < 500; x += 5) {
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (d[0] !== 26 || d[1] !== 26 || d[2] !== 26) count++;
      }
      if (count > 20) return y;
    }
    return -1;
  });

  console.log(`Wireframe y after drag: ${afterY}`);
  expect(afterY).toBeGreaterThan(wireY + 50); // should have moved down significantly
});
