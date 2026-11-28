import { expect, test } from "@playwright/test";

import {
  attachPageErrorCollector,
  createRoleContext,
  installApiMock,
} from "./fixtures/session";
import { OPAQUE_CHILD_ID } from "./fixtures/test-data";

test.describe("E2E-M1 Opaque-Box Smoke Suite", () => {
  test("[SMOKE-01] Guest / redirects 307 to /login without next and renders vi LTR shell", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const errors = attachPageErrorCollector(guest.page);
      const api = await installApiMock(guest.page);

      const rootRes = await guest.context.request.get("/", {
        maxRedirects: 0,
      });
      expect(rootRes.status()).toBe(307);
      const locationHeader = rootRes.headers().location ?? "";
      const redirectUrl = new URL(locationHeader, guest.baseURL);
      expect(redirectUrl.pathname).toBe("/login");
      expect(redirectUrl.search).toBe("");

      const navRes = await guest.page.goto("/", {
        waitUntil: "domcontentloaded",
      });
      expect(navRes?.status()).toBeLessThan(400);
      const finalUrl = new URL(guest.page.url());
      expect(finalUrl.pathname).toBe("/login");
      expect(finalUrl.search).toBe("");

      const htmlLocator = guest.page.locator("html");
      await expect(htmlLocator).toHaveAttribute("lang", "vi");
      await expect(htmlLocator).toHaveAttribute("dir", "ltr");
      await expect(
        guest.page.getByRole("heading", { level: 1, name: "Đăng nhập ViRead" }),
      ).toBeVisible();

      if (!api.isLive) {
        await expect
          .poll(() => api.getRequests().some((req) => req.path === "/health"), {
            timeout: 10_000,
          })
          .toBe(true);
      }

      errors.assertNoErrors();
    } finally {
      await guest.dispose();
    }
  });

  test("[SMOKE-02] Parent /dashboard renders family desk without horizontal overflow @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installApiMock(parent.page);

      const response = await parent.page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBeLessThan(400);
      expect(new URL(parent.page.url()).pathname).toBe("/dashboard");

      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Góc đọc gia đình",
        }),
      ).toBeVisible();
      await expect(parent.page.locator("#child-selection-title")).toHaveText(
        "Chọn hồ sơ trẻ",
      );

      const hasNoHorizontalOverflow = await parent.page.evaluate(() => {
        return (
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
        );
      });
      expect(hasNoHorizontalOverflow).toBe(true);

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some((req) => req.path === "/profiles/dashboard-summary"),
          { timeout: 10_000 },
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[SMOKE-03] Admin /admin/books and /admin/health render while parent is blocked 307 to /dashboard", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    const parent = await createRoleContext(browser, "parent");
    try {
      const adminErrors = attachPageErrorCollector(admin.page);
      const adminApi = await installApiMock(admin.page);

      await admin.page.goto("/admin/books", { waitUntil: "domcontentloaded" });
      expect(new URL(admin.page.url()).pathname).toBe("/admin/books");
      await expect(
        admin.page.locator('[data-admin-workspace="true"]'),
      ).toBeVisible();
      await expect(
        admin.page.getByRole("heading", { level: 1, name: "Kho sách" }),
      ).toBeVisible();
      await expect(admin.page.getByTestId("books-kpi-total")).toBeVisible();

      await expect
        .poll(
          () =>
            adminApi
              .getRequests()
              .some((req) => req.path === "/books/admin/catalog"),
          { timeout: 10_000 },
        )
        .toBe(true);

      await admin.page.goto("/admin/health", { waitUntil: "domcontentloaded" });
      expect(new URL(admin.page.url()).pathname).toBe("/admin/health");
      await expect(
        admin.page.getByRole("heading", {
          level: 1,
          name: "Tình trạng vận hành",
        }),
      ).toBeVisible();
      const deviceCard = admin.page.getByTestId(
        "admin-client-device-capabilities",
      );
      await expect(deviceCard).toBeVisible();
      await expect(deviceCard).toContainText("Trình duyệt Web");

      await expect
        .poll(
          () =>
            adminApi
              .getRequests()
              .some((req) => req.path === "/system/admin/health"),
          { timeout: 10_000 },
        )
        .toBe(true);

      adminErrors.assertNoErrors();

      const blockedRes = await parent.context.request.get("/admin/health", {
        maxRedirects: 0,
      });
      expect(blockedRes.status()).toBe(307);
      const blockedTarget = new URL(
        blockedRes.headers().location ?? "",
        parent.baseURL,
      );
      expect(blockedTarget.pathname).toBe("/dashboard");

      await parent.page.goto("/admin/health", {
        waitUntil: "domcontentloaded",
      });
      expect(new URL(parent.page.url()).pathname).toBe("/dashboard");
      await expect(
        parent.page.locator('[data-admin-workspace="true"]'),
      ).toHaveCount(0);
    } finally {
      await Promise.all([admin.dispose(), parent.dispose()]);
    }
  });

  test("[SMOKE-04] API contract server telemetry and android ViReadAndroid/1.0 role context", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    const androidGuest = await createRoleContext(browser, "android", {
      appRole: "guest",
    });
    const androidAdmin = await createRoleContext(browser, "android", {
      appRole: "admin",
    });

    try {
      const apiOrigin = (
        process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim() ||
        process.env.NEXT_PUBLIC_API_URL?.trim() ||
        `http://127.0.0.1:${process.env.VIREAD_OPAQUE_API_PORT?.trim() || "18180"}`
      ).replace(/\/+$/, "");

      if (!process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim()) {
        const resetRes = await guest.context.request.post(
          `${apiOrigin}/__contract/reset`,
        );
        expect(resetRes.status()).toBe(200);

        const healthRes = await guest.context.request.get(
          `${apiOrigin}/health`,
        );
        expect(healthRes.status()).toBe(200);
        const healthBody = (await healthRes.json()) as {
          status?: string;
          ocr?: { ready?: boolean };
        };
        expect(healthBody.status).toBe("ok");
        expect(healthBody.ocr?.ready).toBe(true);

        const statsRes = await guest.context.request.get(
          `${apiOrigin}/__contract/stats`,
        );
        expect(statsRes.status()).toBe(200);
        const statsBody = (await statsRes.json()) as {
          requestCount: number;
          requests: Array<{ method: string; path: string }>;
        };
        expect(statsBody.requestCount).toBeGreaterThanOrEqual(1);
        expect(
          statsBody.requests.some(
            (entry) => entry.method === "GET" && entry.path === "/health",
          ),
        ).toBe(true);
      } else {
        const healthRes = await guest.context.request.get(
          `${apiOrigin}/health`,
        );
        expect(healthRes.status()).toBe(200);
      }

      const browserCallbackRes = await guest.context.request.get(
        "/auth/callback?app_shell=android&code=smoke_pkce_code",
        { maxRedirects: 0 },
      );
      expect(browserCallbackRes.status()).toBe(307);
      expect(browserCallbackRes.headers().location).toMatch(
        /^viread:\/\/auth\/callback\?code=smoke_pkce_code/,
      );

      const androidCallbackRes = await androidGuest.context.request.get(
        "/auth/callback?app_shell=android&code=smoke_pkce_code",
        { maxRedirects: 0 },
      );
      expect(androidCallbackRes.status()).toBe(307);
      const androidLocation = androidCallbackRes.headers().location ?? "";
      expect(androidLocation.startsWith("viread://")).toBe(false);
      expect(new URL(androidLocation, androidGuest.baseURL).pathname).toBe(
        "/login",
      );

      const androidErrors = attachPageErrorCollector(androidAdmin.page);
      await installApiMock(androidAdmin.page);

      await androidAdmin.page.goto("/admin/health", {
        waitUntil: "domcontentloaded",
      });
      expect(new URL(androidAdmin.page.url()).pathname).toBe("/admin/health");

      const ua = await androidAdmin.page.evaluate(() => navigator.userAgent);
      expect(ua).toContain("ViReadAndroid/1.0");

      const deviceCard = androidAdmin.page.getByTestId(
        "admin-client-device-capabilities",
      );
      await expect(deviceCard).toBeVisible();
      await expect(deviceCard).toContainText("ViRead Android WebView");

      androidErrors.assertNoErrors();
    } finally {
      await Promise.all([
        guest.dispose(),
        androidGuest.dispose(),
        androidAdmin.dispose(),
      ]);
    }
  });
});
