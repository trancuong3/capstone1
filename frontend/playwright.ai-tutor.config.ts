import { defineConfig } from "@playwright/test";

import realDataConfig from "./playwright.real-data.config";

// Reuse the isolated credentials, network fixture and viewports. Webpack avoids
// the local Turbopack dev server's incomplete nested-route discovery on Windows.
export default defineConfig({
  ...realDataConfig,
  testMatch: "**/ai-tutor.pw.ts",
  outputDir: "test-results/ai-tutor",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/ai-tutor-summary.json" }],
  ],
  webServer: {
    ...realDataConfig.webServer,
    command: "npm run dev -- --webpack --hostname 127.0.0.1 --port 3106",
  },
});
