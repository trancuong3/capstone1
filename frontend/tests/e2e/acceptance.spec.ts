import { expect, test } from "@playwright/test";

const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const parentBookId = "20000000-0000-4000-8000-000000000001";
const adminBookId = "82000000-0000-4000-8000-000000000001";
const adminPageId = "83000000-0000-4000-8000-000000000001";

const routes = [
  { name: "root-redirect", path: "/" },
  { name: "login", path: "/login" },
  { name: "register", path: "/register" },
  { name: "forgot-password", path: "/forgot-password" },
  { name: "reset-password", path: "/reset-password?state=success" },
  { name: "dashboard", path: "/dashboard" },
  { name: "profile", path: "/profile" },
  { name: "children", path: "/children" },
  { name: "children-new", path: "/children/new" },
  { name: "child-detail", path: `/children/${childId}` },
  { name: "books", path: `/books?childId=${childId}` },
  {
    name: "book-detail",
    path: `/books/${parentBookId}?childId=${childId}`,
  },
  {
    name: "reading",
    path: "/reading/mock-session-001?state=reading",
  },
  { name: "sessions", path: `/sessions?childId=${childId}` },
  { name: "session-detail", path: "/sessions/mock-session-001" },
  { name: "reports", path: `/reports?childId=${childId}` },
  {
    name: "difficult-words",
    path: `/reports/difficult-words?childId=${childId}`,
  },
  { name: "admin-login", path: "/admin/login" },
  { name: "admin-books", path: "/admin/books" },
  { name: "admin-book-new", path: "/admin/books/new" },
  { name: "admin-book-detail", path: `/admin/books/${adminBookId}` },
  {
    name: "admin-ocr-review",
    path: `/admin/books/${adminBookId}/pages/${adminPageId}`,
  },
  { name: "admin-audit-logs", path: "/admin/audit-logs" },
  { name: "admin-health", path: "/admin/health" },
] as const;

const viewports = [
  { height: 1000, label: "1440", width: 1440 },
  { height: 900, label: "1024", width: 1024 },
  { height: 1024, label: "768", width: 768 },
  { height: 844, label: "390", width: 390 },
] as const;

test.describe("Frontend acceptance route matrix", () => {
  for (const viewport of viewports) {
    test(`all routes are usable at ${viewport.label}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop-chromium",
        "The matrix sets all four required viewport widths itself.",
      );

      await page.setViewportSize(viewport);

      for (const route of routes) {
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const onConsole = (message: { type(): string; text(): string }) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        };
        const onPageError = (error: Error) => pageErrors.push(error.message);

        page.on("console", onConsole);
        page.on("pageerror", onPageError);

        const response = await page.goto(route.path, {
          waitUntil: "domcontentloaded",
        });
        expect(
          response?.status(),
          `${route.path} returned an unexpected HTTP status`,
        ).toBeLessThan(400);
        await expect(
          page.locator("h1").first(),
          `${route.path} has no visible page heading`,
        ).toBeVisible();

        const widths = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(
          widths.scrollWidth,
          `${route.path} overflows horizontally at ${viewport.label}px`,
        ).toBeLessThanOrEqual(widths.clientWidth);

        if (viewport.width === 390) {
          const undersizedTargets = await page.evaluate(() =>
            Array.from(
              document.querySelectorAll<HTMLElement>("a[href], button"),
            )
              .filter((element) => {
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return (
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  rect.width > 0 &&
                  rect.height > 0 &&
                  (rect.width < 24 || rect.height < 24)
                );
              })
              .map(
                (element) =>
                  `${element.tagName.toLowerCase()}:${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "unnamed"}`,
              ),
          );
          expect(
            undersizedTargets,
            `${route.path} has touch targets below 24px`,
          ).toEqual([]);
        }

        if (viewport.width === 1440 || viewport.width === 390) {
          await page.screenshot({
            fullPage: true,
            path: testInfo.outputPath(`${route.name}-${viewport.label}.png`),
          });
        }

        expect(
          pageErrors,
          `${route.path} raised browser page errors at ${viewport.label}px`,
        ).toEqual([]);
        expect(
          consoleErrors,
          `${route.path} logged browser console errors at ${viewport.label}px`,
        ).toEqual([]);

        page.off("console", onConsole);
        page.off("pageerror", onPageError);
      }
    });
  }
});
