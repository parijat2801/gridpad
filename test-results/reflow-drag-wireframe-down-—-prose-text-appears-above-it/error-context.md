# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: reflow.spec.ts >> drag wireframe down — prose text appears above it
- Location: e2e/reflow.spec.ts:3:1

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 200
Received:   0
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | 
  3  | test("drag wireframe down — prose text appears above it", async ({ page }) => {
  4  |   await page.goto("http://localhost:5173");
  5  |   await page.waitForTimeout(2000);
  6  | 
  7  |   // Screenshot before drag
  8  |   await page.screenshot({ path: "/tmp/gridpad-before-drag.png" });
  9  | 
  10 |   // The wireframe is roughly at y=90-230 in the default layout
  11 |   // Click in the middle of that band to select it
  12 |   const canvas = page.locator("canvas");
  13 |   const box = await canvas.boundingBox();
  14 |   const wireY = 150; // roughly center of wireframe
  15 |   await page.mouse.click(box!.x + 200, box!.y + wireY);
  16 |   await page.waitForTimeout(200);
  17 | 
  18 |   // Drag wireframe down by 100px
  19 |   await page.mouse.move(box!.x + 200, box!.y + wireY);
  20 |   await page.mouse.down();
  21 |   for (let i = 1; i <= 10; i++) {
  22 |     await page.mouse.move(box!.x + 200, box!.y + wireY + i * 10);
  23 |     await new Promise(r => setTimeout(r, 16));
  24 |   }
  25 |   await page.mouse.up();
  26 |   await page.waitForTimeout(300);
  27 | 
  28 |   // Screenshot after drag
  29 |   await page.screenshot({ path: "/tmp/gridpad-after-drag.png" });
  30 | 
  31 |   // Verify: wireframe moved down
  32 |   const afterY = await page.evaluate(() => {
  33 |     const c = document.querySelector("canvas");
  34 |     if (!c) return -1;
  35 |     const ctx = c.getContext("2d");
  36 |     if (!ctx) return -1;
  37 |     for (let y = 0; y < c.height; y += 2) {
  38 |       let count = 0;
  39 |       for (let x = 0; x < 500; x += 5) {
  40 |         const d = ctx.getImageData(x, y, 1, 1).data;
  41 |         if (d[0] !== 26 || d[1] !== 26 || d[2] !== 26) count++;
  42 |       }
  43 |       if (count > 20) return y;
  44 |     }
  45 |     return -1;
  46 |   });
  47 | 
  48 |   console.log(`Wireframe y after drag: ${afterY}`);
> 49 |   expect(afterY).toBeGreaterThan(wireY + 50); // should have moved down significantly
     |                  ^ Error: expect(received).toBeGreaterThan(expected)
  50 | });
  51 | 
```