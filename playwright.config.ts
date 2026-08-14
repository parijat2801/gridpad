import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  workers: 4,
  fullyParallel: true,
  use: {
    baseURL: process.env.GRIDPAD_URL ?? "http://localhost:5177/",
    headless: true,
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
      : {}),
  },
});
