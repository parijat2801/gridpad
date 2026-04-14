# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> Gridpad Demo >> click selects wireframe (blue pixels appear)
- Location: e2e/smoke.spec.ts:31:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  1   | import { test, expect } from "@playwright/test";
  2   | 
  3   | const URL = "http://localhost:5173";
  4   | 
  5   | test.describe("Gridpad Demo", () => {
  6   |   test.beforeEach(async ({ page }) => {
  7   |     await page.goto(URL);
  8   |     await page.waitForTimeout(1000); // wait for measureCellSize + initial render
  9   |   });
  10  | 
  11  |   test("canvas renders with content", async ({ page }) => {
  12  |     const canvas = page.locator("canvas");
  13  |     await expect(canvas).toBeVisible();
  14  |     // Check canvas has non-background pixels
  15  |     const hasContent = await page.evaluate(() => {
  16  |       const c = document.querySelector("canvas");
  17  |       if (!c) return false;
  18  |       const ctx = c.getContext("2d");
  19  |       if (!ctx) return false;
  20  |       for (let y = 0; y < c.height; y += 20) {
  21  |         for (let x = 0; x < c.width; x += 20) {
  22  |           const d = ctx.getImageData(x, y, 1, 1).data;
  23  |           if (!(d[0] === 26 && d[1] === 26 && d[2] === 26)) return true;
  24  |         }
  25  |       }
  26  |       return false;
  27  |     });
  28  |     expect(hasContent).toBe(true);
  29  |   });
  30  | 
  31  |   test("click selects wireframe (blue pixels appear)", async ({ page }) => {
  32  |     const canvas = page.locator("canvas");
  33  |     const box = await canvas.boundingBox();
  34  |     // Click in wireframe area (roughly where the dashboard header is)
  35  |     await page.mouse.click(box!.x + 200, box!.y + 100);
  36  |     await page.waitForTimeout(200);
  37  |     // Check for blue selection pixels
  38  |     const hasBlue = await page.evaluate(() => {
  39  |       const c = document.querySelector("canvas");
  40  |       if (!c) return false;
  41  |       const ctx = c.getContext("2d");
  42  |       if (!ctx) return false;
  43  |       for (let y = 0; y < c.height; y += 5) {
  44  |         for (let x = 0; x < c.width; x += 5) {
  45  |           const d = ctx.getImageData(x, y, 1, 1).data;
  46  |           if (d[2] > 180 && d[0] < 100) return true; // blue-ish
  47  |         }
  48  |       }
  49  |       return false;
  50  |     });
> 51  |     expect(hasBlue).toBe(true);
      |                     ^ Error: expect(received).toBe(expected) // Object.is equality
  52  |   });
  53  | 
  54  |   test("drag moves wireframe (can drag twice)", async ({ page }) => {
  55  |     const canvas = page.locator("canvas");
  56  |     const box = await canvas.boundingBox();
  57  |     const startX = box!.x + 200;
  58  |     const startY = box!.y + 100;
  59  | 
  60  |     // First drag
  61  |     await page.mouse.click(startX, startY);
  62  |     await page.waitForTimeout(100);
  63  |     await page.mouse.move(startX, startY);
  64  |     await page.mouse.down();
  65  |     await page.mouse.move(startX + 30, startY, { steps: 5 });
  66  |     await page.mouse.up();
  67  |     await page.waitForTimeout(200);
  68  | 
  69  |     // Second drag — this is the regression test
  70  |     await page.mouse.click(startX + 30, startY);
  71  |     await page.waitForTimeout(100);
  72  |     await page.mouse.move(startX + 30, startY);
  73  |     await page.mouse.down();
  74  |     await page.mouse.move(startX + 60, startY, { steps: 5 });
  75  |     await page.mouse.up();
  76  |     await page.waitForTimeout(200);
  77  | 
  78  |     // Verify canvas still has content (didn't corrupt)
  79  |     const hasContent = await page.evaluate(() => {
  80  |       const c = document.querySelector("canvas");
  81  |       if (!c) return false;
  82  |       const ctx = c.getContext("2d");
  83  |       if (!ctx) return false;
  84  |       let count = 0;
  85  |       for (let y = 0; y < c.height; y += 20) {
  86  |         for (let x = 0; x < c.width; x += 20) {
  87  |           const d = ctx.getImageData(x, y, 1, 1).data;
  88  |           if (!(d[0] === 26 && d[1] === 26 && d[2] === 26)) count++;
  89  |         }
  90  |       }
  91  |       return count > 10; // should have many non-background pixels
  92  |     });
  93  |     expect(hasContent).toBe(true);
  94  |   });
  95  | 
  96  |   test("scroll works", async ({ page }) => {
  97  |     const canvas = page.locator("canvas");
  98  |     // Read pixel at top before scroll
  99  |     const before = await page.evaluate(() => {
  100 |       const c = document.querySelector("canvas");
  101 |       const ctx = c?.getContext("2d");
  102 |       if (!ctx) return null;
  103 |       const d = ctx.getImageData(10, 10, 1, 1).data;
  104 |       return [d[0], d[1], d[2]];
  105 |     });
  106 |     // Scroll down
  107 |     await canvas.hover();
  108 |     await page.mouse.wheel(0, 200);
  109 |     await page.waitForTimeout(300);
  110 |     // Read pixel at top after scroll
  111 |     const after = await page.evaluate(() => {
  112 |       const c = document.querySelector("canvas");
  113 |       const ctx = c?.getContext("2d");
  114 |       if (!ctx) return null;
  115 |       const d = ctx.getImageData(10, 10, 1, 1).data;
  116 |       return [d[0], d[1], d[2]];
  117 |     });
  118 |     // If default text is short enough, scroll might not change anything
  119 |     // Just verify no crash
  120 |     expect(before).not.toBeNull();
  121 |     expect(after).not.toBeNull();
  122 |   });
  123 | 
  124 |   test("no console errors", async ({ page }) => {
  125 |     const errors: string[] = [];
  126 |     page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  127 |     page.on("pageerror", err => errors.push(err.message));
  128 |     await page.goto(URL);
  129 |     await page.waitForTimeout(2000);
  130 |     // Click and drag to trigger interactions
  131 |     const canvas = page.locator("canvas");
  132 |     const box = await canvas.boundingBox();
  133 |     await page.mouse.click(box!.x + 200, box!.y + 100);
  134 |     await page.waitForTimeout(200);
  135 |     expect(errors).toEqual([]);
  136 |   });
  137 | });
  138 | 
```