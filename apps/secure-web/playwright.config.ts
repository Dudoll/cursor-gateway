import { defineConfig } from "@playwright/test";

const browserChannel = process.env.PLAYWRIGHT_CHANNEL?.trim();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? [["github"], ["line"]] : [["line"]],
  expect: {
    timeout: 8_000
  },
  use: {
    baseURL: "http://localhost:4174",
    browserName: "chromium",
    ...(browserChannel === "bundled" ? {} : { channel: browserChannel || "msedge" }),
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4174",
    url: "http://localhost:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
