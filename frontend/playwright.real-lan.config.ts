import { defineConfig } from "@playwright/test";

// Real-data end-to-end acceptance against the live Windows LAN HTTPS ViRead host.
// Zero mocks, zero auth fixtures; uses real Supabase Auth + Windows FastAPI + Local OCR.
const lanOrigin = process.env.VIREAD_LAN_ORIGIN || "https://192.168.1.4:8443";

export default defineConfig({
  testDir: "./tests/e2e-real-lan",
  testMatch: "**/*.pw.ts",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  outputDir: "test-results/real-lan",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/real-lan-summary.json" }],
  ],
  use: {
    baseURL: lanOrigin,
    // Chromium in Playwright accepts our local test CA; strict TLS verification is
    // independently verified by verify_frontend.py & OpenSSL & Gradle SSLContext.
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [
    {
      name: "mobile-android-viewport",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
