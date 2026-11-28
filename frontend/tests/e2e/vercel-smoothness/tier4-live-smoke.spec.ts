import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

const liveBaseUrl = process.env.VIREAD_LIVE_BASE_URL?.trim() || "";
const liveApiUrl = process.env.VIREAD_LIVE_API_URL?.trim() || "";
const liveSupabaseUrl = process.env.VIREAD_LIVE_SUPABASE_URL?.trim() || "";
const liveSupabaseServiceKey =
  process.env.VIREAD_LIVE_SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
const enableTempSignup = process.env.VIREAD_LIVE_TEMP_SIGNUP === "1";

test.describe("Tier 4 Live Smoke (S7 — Vercel Preview / next start)", () => {
  test.use({ extraHTTPHeaders: {} });

  test.skip(
    !liveBaseUrl,
    "Set VIREAD_LIVE_BASE_URL to run live smoke verification.",
  );

  test("S7: live public routes, security headers, compressed images, cron fail-closed, optional Preview CORS & R2 temp-user lifecycle", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Live smoke runs once on desktop-chromium to avoid duplicate Supabase accounts.",
    );
    const base = liveBaseUrl.replace(/\/+$/, "");
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    let allowNext404ConsoleError = false;
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (
          allowNext404ConsoleError &&
          text.includes(
            "Failed to load resource: the server responded with a status of 404",
          )
        ) {
          return;
        }
        consoleErrors.push(text);
      }
    });

    // 1. Public auth routes & security headers
    const loginRes = await page.goto(`${base}/login`);
    expect(loginRes).not.toBeNull();
    expect(loginRes!.status()).toBeLessThan(400);
    const headers = loginRes!.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["permissions-policy"]).toContain("camera=(self)");
    await expect(
      page.getByRole("heading", { name: "Đăng nhập" }),
    ).toBeVisible();

    for (const authPath of ["/register", "/forgot-password"]) {
      const res = await page.goto(`${base}${authPath}`);
      expect(res?.status()).toBeLessThan(400);
      await expect(page.locator("h1:visible").first()).toBeVisible();
    }

    // 2. 404 fallback page
    allowNext404ConsoleError = true;
    const notFoundRes = await page.goto(`${base}/nonexistent-live-smoke-check`);
    allowNext404ConsoleError = false;
    expect(notFoundRes?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Không tìm thấy trang" }),
    ).toBeVisible();

    // 3. Compressed picture-description assets
    for (const fileName of [
      "happy-classroom.jpg",
      "lakeside-picnic.jpg",
      "sunny-garden.jpg",
    ]) {
      const imgRes = await request.get(
        `${base}/images/picture-description/${fileName}`,
      );
      expect(imgRes.status()).toBe(200);
      const body = await imgRes.body();
      expect(body.byteLength).toBeGreaterThan(1000);
    }

    // 4. Cron endpoint fails closed without valid Bearer secret
    const cronRes = await request.get(`${base}/api/cron/parent-emails`);
    expect([401, 503]).toContain(cronRes.status());

    // 5. Optional Preview CORS check against Render / Backend URL
    if (liveApiUrl) {
      const apiBase = liveApiUrl.replace(/\/+$/, "");
      const origin = new URL(base).origin;
      const preflight = await request.fetch(`${apiBase}/health`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(preflight.status()).toBeLessThan(400);
      expect(preflight.headers()["access-control-allow-origin"]).toBe(origin);
      expect(preflight.headers()["access-control-allow-credentials"]).toBe(
        "true",
      );

      const healthGet = await request.get(`${apiBase}/health`, {
        headers: { Origin: origin },
      });
      expect(healthGet.status()).toBe(200);
      expect(healthGet.headers()["access-control-allow-origin"]).toBe(origin);
    }

    // 6. Optional R2-compliant single temporary Supabase account flow
    if (enableTempSignup && liveSupabaseUrl && liveSupabaseServiceKey) {
      const supaBase = liveSupabaseUrl.replace(/\/+$/, "");
      const tempEmail = `viread-e2e-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
      const tempPassword = `Vr!${randomBytes(10).toString("hex")}`;
      let createdUserId: string | null = null;

      try {
        const createRes = await request.post(
          `${supaBase}/auth/v1/admin/users`,
          {
            headers: {
              apikey: liveSupabaseServiceKey,
              Authorization: `Bearer ${liveSupabaseServiceKey}`,
              "Content-Type": "application/json",
            },
            data: {
              email: tempEmail,
              password: tempPassword,
              email_confirm: true,
              user_metadata: {
                role: "parent",
                display_name: "E2E Smoke Temp Parent",
              },
            },
          },
        );
        const rawCreateBody = await createRes.text();
        try {
          const createdJson = JSON.parse(rawCreateBody) as {
            id?: string;
            user?: { id?: string };
          };
          createdUserId = createdJson.id ?? createdJson.user?.id ?? null;
        } catch {
          createdUserId = null;
        }
        expect([200, 201]).toContain(createRes.status());
        expect(createdUserId).toBeTruthy();

        await page.goto(`${base}/login`);
        await page.getByLabel("Email của ba mẹ").fill(tempEmail);
        await page.getByLabel("Mật khẩu", { exact: true }).fill(tempPassword);
        await page.getByRole("button", { name: "Đăng nhập" }).click();
        await expect(page).toHaveURL(/\/dashboard/);
        await expect(
          page.getByRole("heading", { name: "Góc đọc gia đình" }),
        ).toBeVisible();
      } finally {
        if (createdUserId) {
          const deleteRes = await request.delete(
            `${supaBase}/auth/v1/admin/users/${encodeURIComponent(createdUserId)}`,
            {
              headers: {
                apikey: liveSupabaseServiceKey,
                Authorization: `Bearer ${liveSupabaseServiceKey}`,
              },
            },
          );
          expect(deleteRes.status()).toBeLessThan(400);
        }
      }
    }

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
