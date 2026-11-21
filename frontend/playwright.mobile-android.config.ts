import { defineConfig } from "@playwright/test";

const mediaArgs = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
];

export default defineConfig({
  testDir: "./test/browser",
  testMatch: ["mobile-android-parity.pw.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: {
    timeout: 30_000,
  },
  reporter: [["list"]],
  use: {
    baseURL: process.env.VIREAD_E2E_WEB_ORIGIN ?? "https://192.168.1.4:8443",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["camera", "microphone"],
    launchOptions: {
      args: mediaArgs,
    },
  },
  projects: [
    {
      name: "android-360x800",
      use: {
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "android-390x844",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "android-landscape-844x390",
      use: {
        viewport: { width: 844, height: 390 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
