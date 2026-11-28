import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

const managedBaseUrl = process.env.PLAYWRIGHT_BASE_URL?.trim();
const fallbackPort = process.env.PLAYWRIGHT_PORT ?? "3199";
const baseURL = managedBaseUrl || `http://127.0.0.1:${fallbackPort}`;

const fallbackFixtureToken =
  process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN ?? randomBytes(32).toString("hex");
if (!process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN) {
  process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN = fallbackFixtureToken;
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /vercel-(smoothness-e2e|authenticated-flows)\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "test-results/vercel-e2e",
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  ...(managedBaseUrl
    ? {}
    : {
        webServer: {
          command: `npm run dev -- --hostname 127.0.0.1 --port ${fallbackPort}`,
          url: baseURL,
          reuseExistingServer: false,
          timeout: 120_000,
          env: {
            NEXT_PUBLIC_SUPABASE_URL:
              process.env.NEXT_PUBLIC_SUPABASE_URL ??
              "https://sampleid.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
              process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
              "sb_publishable_test_key_1234567890",
            NEXT_PUBLIC_API_URL:
              process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:18080",
            VIREAD_SSR_AUTH_SIGNING_KEY:
              process.env.VIREAD_SSR_AUTH_SIGNING_KEY ??
              "viread_e2e_test_signing_key_0123456789abcdef",
            PLAYWRIGHT_AUTH_FIXTURES: "1",
            PLAYWRIGHT_AUTH_FIXTURE_TOKEN: fallbackFixtureToken,
            NEXT_DIST_DIR: ".next-e2e",
          },
        },
      }),
  projects: [
    {
      name: "desktop-chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
