import { test, expect } from "@playwright/test";

test("double-click text label and type changes it", async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForTimeout(2000);

  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();

  // Double-click on "Dashboard" text
  await page.mouse.dblclick(box!.x + 230, box!.y + 110);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/gridpad-dblclick.png" });

  // Type
  await page.keyboard.type("XYZ");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/gridpad-typed.png" });
});
