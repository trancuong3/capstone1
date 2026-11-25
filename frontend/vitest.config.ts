import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // Prevent jsdom worker CPU contention from skewing the p95 <= 50ms highlight
    // latency benchmark or causing 5s cold-render timeouts across 184 test files.
    maxWorkers: 1,
    testTimeout: 15000,
    // The hosting preflight uses Node's built-in test runner, not Vitest/jsdom.
    // It has a dedicated CI step: node --test scripts/verify-hosting-env.test.mjs.
    exclude: [
      "tests/e2e/**",
      "node_modules/**",
      ".next/**",
      "scripts/verify-hosting-env.test.mjs",
    ],
    css: true,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
