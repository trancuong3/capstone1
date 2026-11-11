import { defineConfig } from "@playwright/test";
import base from "./playwright.real-data.config";

/** Focused Phase 3 coverage; retains the existing isolated auth/API setup. */
export default defineConfig(base, {
  testMatch: "**/tts-upgrade.pw.ts",
  outputDir: "test-results/tts",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/tts-summary.json" }],
  ],
  projects: [
    ...(base.projects ?? []),
    {
      name: "tablet",
      use: { browserName: "chromium", viewport: { width: 768, height: 1024 } },
    },
  ],
});
