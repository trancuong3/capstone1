import { expect, test } from "@playwright/test";

import { createPlaywrightAuthFixtureHeaders } from "@/lib/auth/playwright-auth-fixture";
import { authFixtureHeaders } from "./auth-fixture";

const baseURL = "http://127.0.0.1:3000";

test("a guest is redirected away from a protected parent route", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: createPlaywrightAuthFixtureHeaders(
      "parent",
      "guest-token-is-deliberately-invalid".repeat(2),
    ),
  });
  const page = await context.newPage();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);

  await context.close();
});

test("a parent cannot open protected admin routes", async ({ page }) => {
  await page.goto("/admin/books");
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("an admin can open admin routes but not parent routes", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: authFixtureHeaders("admin"),
  });
  const page = await context.newPage();

  await page.goto("/admin/books");
  await expect(page.getByRole("heading", { name: "Kho sách" })).toBeVisible();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/admin\/books$/);

  await context.close();
});

test("an invalid fixture role fails closed and recovery remains public", async ({
  browser,
}) => {
  const token = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN;
  if (!token) throw new Error("Missing Playwright auth fixture token.");

  const invalidHeaders = {
    ...createPlaywrightAuthFixtureHeaders("parent", token),
    "x-readalong-playwright-role": "owner",
  };
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: invalidHeaders,
  });
  const page = await context.newPage();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);

  await page.setExtraHTTPHeaders(authFixtureHeaders("admin"));
  await page.goto("/reset-password?state=invalid-token");
  await expect(page).toHaveURL(/\/reset-password\?state=invalid-token$/);

  await context.close();
});
