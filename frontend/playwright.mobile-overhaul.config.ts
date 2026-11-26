import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";
import { createPlaywrightAuthFixtureHeaders } from "./lib/auth/playwright-auth-fixture";

// Test-only configuration. Never use real keys, users or Supabase endpoints.
const fixtureToken =
  process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN ?? randomBytes(32).toString("hex");
process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN = fixtureToken;

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "mobile-overhaul-*.pw.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  globalSetup: "./test/browser/warm-routes.ts",
  retries: 0,
  outputDir: "test-results/mobile-overhaul",
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: "playwright-report-mobile-overhaul", open: "never" },
    ],
    ["json", { outputFile: "test-results/mobile-overhaul-summary.json" }],
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
    command: "npm run dev -- --webpack --hostname 127.0.0.1 --port 3106",
    url: "http://127.0.0.1:3106",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      NEXT_PUBLIC_API_URL: "http://127.0.0.1:8000",
      PLAYWRIGHT_AUTH_FIXTURES: "1",
      PLAYWRIGHT_AUTH_FIXTURE_TOKEN: fixtureToken,
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
  projects: [
    {
      name: "mobile-360x800",
      use: {
        browserName: "chromium",
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile-390x844",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "mobile-430x932",
      use: {
        browserName: "chromium",
        viewport: { width: 430, height: 932 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "gap-640x960",
      use: {
        browserName: "chromium",
        viewport: { width: 640, height: 960 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "gap-720x900",
      use: {
        browserName: "chromium",
        viewport: { width: 720, height: 900 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "tablet-768x1024",
      use: {
        browserName: "chromium",
        viewport: { width: 768, height: 1024 },
        hasTouch: true,
      },
    },
    {
      name: "tablet-1024x768",
      use: {
        browserName: "chromium",
        viewport: { width: 1024, height: 768 },
      },
    },
    {
      name: "desktop-1440x1000",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
