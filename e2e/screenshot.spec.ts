import { test } from "@playwright/test";

test("take screenshot", async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/gridpad-screenshot.png", fullPage: true });

  // Also capture console output
  const logs: string[] = [];
  page.on("console", msg => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => logs.push(`[ERROR] ${err.message}`));

  await page.goto("http://localhost:5173");
  await page.waitForTimeout(2000);

  console.log("Console output:", logs.join("\n"));
});
