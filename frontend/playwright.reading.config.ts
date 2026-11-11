import { defineConfig } from "@playwright/test";
import base from "./playwright.real-data.config";

/** Master prompt viewports; only synthetic audio and intercepted API traffic. */
export default defineConfig({
  ...base,
  testMatch: "**/reading-experience.pw.ts",
  outputDir: "test-results/reading-experience",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/reading-summary.json" }],
  ],
  projects: [
    [1440, 900],
    [1280, 800],
    [1024, 768],
    [768, 1024],
    [430, 932],
    [390, 844],
    [360, 800],
  ].map(([width, height]) => ({
    name: `${width}x${height}`,
    use: { browserName: "chromium", viewport: { width, height } },
  })),
});
