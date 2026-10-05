import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

import { createPlaywrightAuthFixtureHeaders } from "./lib/auth/playwright-auth-fixture";

const authFixtureToken =
  process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN ?? randomBytes(32).toString("hex");
process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN = authFixtureToken;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    extraHTTPHeaders: createPlaywrightAuthFixtureHeaders(
      "parent",
      authFixtureToken,
    ),
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1",
    env: {
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      PLAYWRIGHT_AUTH_FIXTURES: "1",
      PLAYWRIGHT_AUTH_FIXTURE_TOKEN: authFixtureToken,
    },
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  workers: 2,
  projects: [
    {
      name: "desktop-chromium",
      use: {
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
