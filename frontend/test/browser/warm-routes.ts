import { request } from "@playwright/test";
import { createPlaywrightAuthFixtureHeaders } from "../../lib/auth/playwright-auth-fixture";

/**
 * Auth fixtures are forbidden in production, so these tests use Next dev.
 * Compile its route modules before interactive tests start: compiling a new
 * module during a click can reload an already open development tab.
 * This performs only loopback SSR GETs; no client/provider code is executed.
 */
export default async function warmRoutes(): Promise<void> {
  const token = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN;
  if (!token) throw new Error("Missing isolated auth fixture token");
  const book = "33333333-3333-4333-8333-333333333333";
  const session = "44444444-4444-4444-8444-444444444444";
  const page = "55555555-5555-4555-8555-555555555555";
  const paths = {
    parent: [
      "/login",
      "/register",
      "/forgot-password",
      "/reset-password",
      "/dashboard",
      "/profile",
      "/settings",
      "/help-support",
      "/reading-management",
      "/entertainment",
      "/entertainment/picture-description",
      "/entertainment/sentence-shooter",
      "/karaoke",
      "/karaoke/11111111-1111-4111-8111-111111111111",
      "/children",
      "/children/new",
      "/children/22222222-2222-4222-8222-222222222222",
      "/books",
      `/books/${book}`,
      "/book-scanner",
      "/book-reports",
      `/reading-preparation?bookId=${book}&pageId=${page}&endPageId=${page}`,
      "/sessions",
      `/sessions/${session}`,
      `/sessions/${session}/report`,
      "/reports",
      "/reports/difficult-words",
      `/reading/${session}?state=reading`,
    ],
    admin: [
      "/admin/login",
      "/admin/parents",
      "/admin/parents/11111111-1111-4111-8111-111111111111",
      "/admin/books",
      `/admin/books/${book}`,
      `/admin/books/${book}/edit`,
      `/admin/books/${book}/pages/${page}`,
      "/admin/audit-logs",
      "/admin/health",
      "/admin/books/new",
      "/admin/metadata-quality",
      "/admin/viread-training",
      "/admin/karaoke",
      "/admin/karaoke/new",
      "/admin/karaoke/11111111-1111-4111-8111-111111111111/edit",
    ],
  } as const;
  const routeFilter = process.env.PLAYWRIGHT_ROUTE_FILTER?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const role of ["parent", "admin"] as const) {
    const targetPaths = routeFilter?.length
      ? paths[role].filter((path) =>
          routeFilter.some((prefix) => path.startsWith(prefix)),
        )
      : paths[role];
    if (targetPaths.length === 0) continue;
    const context = await request.newContext({
      baseURL: "http://127.0.0.1:3106",
      extraHTTPHeaders: createPlaywrightAuthFixtureHeaders(role, token),
    });
    try {
      for (const path of targetPaths) {
        const response = await context.get(path, {
          timeout: 120000,
          maxRedirects: 0,
        });
        if (response.status() !== 200)
          throw new Error(
            `Isolated route warmup failed: ${role} ${path} ${response.status()}`,
          );
        await response.dispose();
      }
    } finally {
      await context.dispose();
    }
  }
}
