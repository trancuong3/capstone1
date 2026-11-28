import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_OPAQUE_PORT?.trim() || "3299";
const apiPort = process.env.VIREAD_OPAQUE_API_PORT?.trim() || "18180";
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL?.trim() || `http://127.0.0.1:${port}`;
const liveApiUrl = process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim() || "";
const apiBaseURL = liveApiUrl || `http://127.0.0.1:${apiPort}`;

const rawAuthToken = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN?.trim();
const authFixtureToken =
  rawAuthToken && rawAuthToken.length >= 32
    ? rawAuthToken
    : randomBytes(32).toString("hex");
process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN = authFixtureToken;

const cronSecret =
  process.env.CRON_SECRET?.trim() ||
  "viread_opaque_cron_secret_0123456789abcdef";
process.env.CRON_SECRET = cronSecret;

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "https://example.supabase.co";
const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  "sb_publishable_test_key_1234567890";
const ssrAuthSigningKey =
  process.env.VIREAD_SSR_AUTH_SIGNING_KEY?.trim() ||
  "viread_opaque_ssr_signing_key_0123456789abcdef";

process.env.PLAYWRIGHT_OPAQUE_PORT = port;
process.env.VIREAD_OPAQUE_API_PORT = apiPort;
process.env.PLAYWRIGHT_BASE_URL = baseURL;
process.env.NEXT_PUBLIC_API_URL = apiBaseURL;
process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;

export default defineConfig({
  testDir: "./tests/e2e/opaque-box",
  testMatch: "**/*.opaque.ts",
  globalSetup: "./tests/e2e/opaque-box/fixtures/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  outputDir: "test-results/opaque-box",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/opaque-box", open: "never" }],
    ["json", { outputFile: "test-results/opaque-box/report.json" }],
  ],
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["camera", "microphone"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 420_000,
    env: {
      PLAYWRIGHT_AUTH_FIXTURES: "1",
      PLAYWRIGHT_AUTH_FIXTURE_TOKEN: authFixtureToken,
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabasePublishableKey,
      NEXT_PUBLIC_API_URL: apiBaseURL,
      BACKEND_API_URL: apiBaseURL,
      CRON_SECRET: cronSecret,
      VIREAD_SSR_AUTH_SIGNING_KEY: ssrAuthSigningKey,
    },
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      grep: /@mobile/,
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
