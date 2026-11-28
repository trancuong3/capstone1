import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { createPlaywrightAuthFixtureHeaders } from "./lib/auth/playwright-auth-fixture";

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.__E2E_SUITE_SNAPSHOT_TAKEN) {
  process.env.__E2E_SUITE_SNAPSHOT_TAKEN = "1";
  try {
    process.env.__E2E_SUITE_TSCONFIG_B64 = readFileSync(
      path.join(frontendDir, "tsconfig.json"),
    ).toString("base64");
  } catch {
    // Ignore if absent
  }
  try {
    process.env.__E2E_SUITE_AGENTS_B64 = readFileSync(
      path.join(frontendDir, "AGENTS.md"),
    ).toString("base64");
  } catch {
    // Ignore if absent
  }
  try {
    process.env.__E2E_SUITE_NEXT_ENV_B64 = readFileSync(
      path.join(frontendDir, "next-env.d.ts"),
    ).toString("base64");
  } catch {
    // Ignore if absent
  }
}

// Test-only configuration. Never use real keys, users, or Supabase endpoints.
const fixtureToken =
  process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN ?? randomBytes(32).toString("hex");
process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN = fixtureToken;

const playwrightPort = process.env.PLAYWRIGHT_E2E_SUITE_PORT ?? "3108";
process.env.PLAYWRIGHT_PORT = playwrightPort;

const playwrightOrigin = `http://127.0.0.1:${playwrightPort}`;

export default defineConfig({
  testDir: "./test/e2e-suite",
  testMatch: "**/*.pw.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  globalSetup: "./test/e2e-suite/global-setup.ts",
  globalTeardown: "./test/e2e-suite/global-teardown.ts",
  retries: 0,
  outputDir: "test-results/e2e-suite",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/e2e-suite", open: "never" }],
    ["json", { outputFile: "test-results/e2e-suite-summary.json" }],
  ],
  use: {
    baseURL: playwrightOrigin,
    extraHTTPHeaders: createPlaywrightAuthFixtureHeaders(
      "parent",
      fixtureToken,
    ),
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${playwrightPort}`,
    url: playwrightOrigin,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      NEXT_PUBLIC_API_URL: "http://127.0.0.1:8000",
      PLAYWRIGHT_AUTH_FIXTURES: "1",
      PLAYWRIGHT_AUTH_FIXTURE_TOKEN: fixtureToken,
      PLAYWRIGHT_PORT: playwrightPort,
      NEXT_DIST_DIR: ".next-e2e-suite",
    },
  },
  projects: [
    {
      name: "desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1000 },
      },
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
