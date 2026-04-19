import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  workers: 4,
  fullyParallel: true,
  use: {
    baseURL: process.env.GRIDPAD_URL ?? "http://localhost:5177/gridpad/",
    headless: true,
  },
});
