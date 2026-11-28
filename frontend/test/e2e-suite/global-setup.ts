import { request } from "@playwright/test";
import { createPlaywrightAuthFixtureHeaders } from "../../lib/auth/playwright-auth-fixture";
import warmRoutes from "../browser/warm-routes";

const E2E_SUITE_WARM_PREFIXES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/dashboard",
  "/my-books",
  "/profile",
  "/settings",
  "/help-support",
  "/reading-management",
  "/entertainment",
  "/karaoke",
  "/children",
  "/books",
  "/book-scanner",
  "/book-reports",
  "/reading-preparation",
  "/sessions",
  "/reports",
  "/reading/",
].join(",");

async function warmStudioTasksRoute(): Promise<void> {
  const token = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN;
  if (!token) throw new Error("Missing isolated auth fixture token");
  const port =
    process.env.PLAYWRIGHT_E2E_SUITE_PORT ??
    process.env.PLAYWRIGHT_PORT ??
    "3108";
  const context = await request.newContext({
    baseURL: `http://127.0.0.1:${port}`,
    extraHTTPHeaders: createPlaywrightAuthFixtureHeaders("parent", token),
  });
  try {
    const response = await context.get("/studio/tasks", {
      timeout: 120_000,
      maxRedirects: 0,
    });
    if (response.status() !== 200) {
      throw new Error(
        `Isolated route warmup failed: parent /studio/tasks ${response.status()}`,
      );
    }
    await response.dispose();
  } finally {
    await context.dispose();
  }
}

export default async function globalSetup(): Promise<void> {
  if (!process.env.PLAYWRIGHT_ROUTE_FILTER) {
    process.env.PLAYWRIGHT_ROUTE_FILTER = E2E_SUITE_WARM_PREFIXES;
  }
  await warmRoutes();
  await warmStudioTasksRoute();
}
