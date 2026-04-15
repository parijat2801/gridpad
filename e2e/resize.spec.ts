import { test, expect } from "@playwright/test";

test("resize rect changes wireframe rendering", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", msg => { if (msg.text().startsWith("resize:")) logs.push(msg.text()); });

  await page.goto("http://localhost:5173");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/gridpad-resize-before.png" });

  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();

  // Click on the inner Card Title rect to select it
  // It's roughly at x=160, y=200 in the default layout
  await page.mouse.click(box!.x + 200, box!.y + 200);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/gridpad-resize-selected.png" });

  // Drag the bottom-right handle of the selected rect
  // From screenshot: handle is at roughly x=305, y=237
  await page.mouse.move(box!.x + 305, box!.y + 237);
  await page.mouse.down();
  await page.mouse.move(box!.x + 305, box!.y + 290, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  await page.screenshot({ path: "/tmp/gridpad-resize-after.png" });
  console.log(`Resize console logs: ${logs.length}`);
  for (const l of logs.slice(0, 3)) console.log(`  ${l}`);
});
