import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";
import { createPlaywrightAuthFixtureHeaders } from "./lib/auth/playwright-auth-fixture";

// Test-only configuration. Never use real keys, users or Supabase endpoints.
const fixtureToken =
  process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN ?? randomBytes(32).toString("hex");
process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN = fixtureToken;

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.pw.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  outputDir: "test-results/real-data",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/real-data-summary.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3106",
    extraHTTPHeaders: createPlaywrightAuthFixtureHeaders(
      "parent",
      fixtureToken,
    ),
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3106",
    url: "http://127.0.0.1:3106",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      NEXT_PUBLIC_API_URL: "http://127.0.0.1:8000",
      PLAYWRIGHT_AUTH_FIXTURES: "1",
      PLAYWRIGHT_AUTH_FIXTURE_TOKEN: fixtureToken,
    },
  },
  projects: [
    {
      name: "desktop",
      use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
