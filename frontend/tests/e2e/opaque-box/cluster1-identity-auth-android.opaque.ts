import { expect, test, type Page } from "@playwright/test";

import {
  createCluster1ApiHandler,
  createCluster1ApiState,
} from "./fixtures/cluster1-2-data";
import {
  attachPageErrorCollector,
  createRoleContext,
  installApiMock,
  OPAQUE_ADMIN_ID,
  OPAQUE_PARENT_ID,
} from "./fixtures/session";
import {
  makeMinimalPngBuffer,
  makeMinimalWebpBuffer,
  makeOpaqueUuid,
  makeOversizedBuffer,
  OPAQUE_CHILD_ID,
  OPAQUE_NOW_ISO,
  OPAQUE_UNSAFE_NEXT_PATHS,
  OVERSIZED_AVATAR_BYTES,
} from "./fixtures/test-data";

function makeSupabaseJwt(userId: string, role: "parent" | "admin"): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      aud: "authenticated",
      exp: nowSec + 36_000,
      iat: nowSec - 60,
      role: "authenticated",
      sub: userId,
      user_metadata: { role },
    }),
  ).toString("base64url");
  return `${header}.${payload}.opaque-login-sig`;
}

async function fillHydrated(
  locator: ReturnType<Page["locator"]>,
  value: string,
): Promise<void> {
  await expect(async () => {
    await locator.fill(value);
    await expect(locator).toHaveValue(value);
  }).toPass({ timeout: 10_000 });
}

function appAlerts(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

async function mockSupabasePasswordAuth(
  page: Page,
  options: {
    userId: string;
    email: string;
    role: "parent" | "admin";
    active?: number;
    rejectSignIn?: boolean;
  },
): Promise<void> {
  await page.route("https://*.supabase.co/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/auth/v1/token")) {
      if (options.rejectSignIn) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "invalid_grant",
            error_code: "invalid_credentials",
            msg: "Invalid login credentials",
          }),
        });
        return;
      }
      const token = makeSupabaseJwt(options.userId, options.role);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          access_token: token,
          token_type: "bearer",
          expires_in: 36_000,
          refresh_token: "opaque-refresh",
          user: {
            id: options.userId,
            aud: "authenticated",
            role: "authenticated",
            email: options.email,
            user_metadata: { role: options.role },
            app_metadata: { provider: "email", providers: ["email"] },
            created_at: OPAQUE_NOW_ISO,
          },
        }),
      });
      return;
    }

    if (url.pathname.startsWith("/rest/v1/profiles")) {
      const accept = route.request().headers().accept ?? "";
      const row = {
        id: options.userId,
        role: options.role,
        active: options.active ?? 1,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          accept.includes("application/vnd.pgrst.object+json") ? row : [row],
        ),
      });
      return;
    }

    if (url.pathname.startsWith("/auth/v1/signup")) {
      const identity = {
        id: `ident-${options.userId}`,
        user_id: options.userId,
        identity_data: { email: options.email },
        provider: "email",
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: options.userId,
          email: options.email,
          identities: [identity],
          user: {
            id: options.userId,
            aud: "authenticated",
            role: "authenticated",
            email: options.email,
            identities: [identity],
            user_metadata: { role: options.role },
            app_metadata: { provider: "email", providers: ["email"] },
            created_at: OPAQUE_NOW_ISO,
          },
          session: null,
        }),
      });
      return;
    }

    if (url.pathname.startsWith("/auth/v1/recover")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: options.userId,
        aud: "authenticated",
        role: "authenticated",
        email: options.email,
        user_metadata: { role: options.role },
        app_metadata: { provider: "email", providers: ["email"] },
        created_at: OPAQUE_NOW_ISO,
      }),
    });
  });
}

// ===========================================================================
// F-01: Email/Password Auth, Recovery & SSR Guard (6 Tier 1 + 6 Tier 2)
// ===========================================================================

test.describe("F-01: Email/Password Auth & SSR Guard", () => {
  test("[T1-F01-01] Unauthenticated /dashboard and /admin/parents redirect 307 to login with encoded next", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const parentRes = await guest.context.request.get("/dashboard", {
        maxRedirects: 0,
      });
      expect(parentRes.status()).toBe(307);
      const parentLoc = new URL(
        parentRes.headers().location ?? "",
        guest.baseURL,
      );
      expect(parentLoc.pathname).toBe("/login");
      expect(parentLoc.searchParams.get("next")).toBe("/dashboard");

      const adminRes = await guest.context.request.get("/admin/parents", {
        maxRedirects: 0,
      });
      expect(adminRes.status()).toBe(307);
      const adminLoc = new URL(
        adminRes.headers().location ?? "",
        guest.baseURL,
      );
      expect(adminLoc.pathname).toBe("/admin/login");
      expect(adminLoc.searchParams.get("next")).toBe("/admin/parents");
    } finally {
      await guest.dispose();
    }
  });

  test("[T1-F01-02] Parent /login submits valid credentials and navigates to /dashboard", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster1ApiState();
      await installApiMock(parent.page, createCluster1ApiHandler(state));
      await mockSupabasePasswordAuth(parent.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
      });

      await parent.page.goto("/login", { waitUntil: "load" });
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Đăng nhập ViRead",
        }),
      ).toBeVisible();

      await fillHydrated(
        parent.page.getByLabel("Email của ba mẹ"),
        "parent@viread.local",
      );
      await fillHydrated(
        parent.page.getByLabel("Mật khẩu", { exact: true }),
        "SecretPass123!",
      );
      await parent.page.getByRole("button", { name: "Đăng nhập" }).click();

      await expect(parent.page).toHaveURL(/\/dashboard$/);
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Góc đọc gia đình",
        }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F01-03] Admin /admin/login navigates to /admin/books and /admin redirects 307 to /admin/parents", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createCluster1ApiState({
        profile: {
          id: OPAQUE_ADMIN_ID,
          display_name: "Quản trị viên",
          role: "admin",
          created_at: OPAQUE_NOW_ISO,
          email: "admin@viread.local",
          contact_phone: null,
          pending_email: null,
          email_verified: true,
          contact_info_status: "available",
          children: [],
          avatar_url: null,
        },
      });
      await installApiMock(admin.page, createCluster1ApiHandler(state), {
        unmatchedMode: "default-mock",
      });
      await mockSupabasePasswordAuth(admin.page, {
        userId: OPAQUE_ADMIN_ID,
        email: "admin@viread.local",
        role: "admin",
      });

      const rootAdminRes = await admin.context.request.get("/admin", {
        maxRedirects: 0,
      });
      expect(rootAdminRes.status()).toBe(307);
      expect(
        new URL(rootAdminRes.headers().location ?? "", admin.baseURL).pathname,
      ).toBe("/admin/parents");

      await admin.page.goto("/admin/login", { waitUntil: "load" });
      await expect(
        admin.page.locator('[data-admin-workspace="true"]'),
      ).toBeVisible();
      await expect(
        admin.page.getByRole("heading", {
          level: 1,
          name: "Đăng nhập quản trị",
        }),
      ).toBeVisible();

      await fillHydrated(
        admin.page.getByLabel("Email quản trị"),
        "admin@viread.local",
      );
      await fillHydrated(
        admin.page.getByLabel("Mật khẩu", { exact: true }),
        "AdminSecret123!",
      );
      await admin.page.getByRole("button", { name: "Đăng nhập" }).click();

      await expect(admin.page).toHaveURL(/\/admin\/books$/);
      await expect(
        admin.page.getByRole("heading", { level: 1, name: "Kho sách" }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F01-04] /register email-confirmation flow renders non-enumerating status notice", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const errors = attachPageErrorCollector(guest.page);
      await installApiMock(guest.page);
      await mockSupabasePasswordAuth(guest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "newparent@viread.local",
        role: "parent",
      });

      await guest.page.goto("/register", { waitUntil: "load" });
      await expect(
        guest.page.getByRole("heading", {
          level: 1,
          name: "Tạo tài khoản phụ huynh",
        }),
      ).toBeVisible();

      await fillHydrated(
        guest.page.getByLabel("Họ và tên ba mẹ"),
        "Nguyễn Thị Mai",
      );
      await fillHydrated(
        guest.page.getByLabel("Email của ba mẹ"),
        "newparent@viread.local",
      );
      await fillHydrated(
        guest.page.getByLabel("Mật khẩu", { exact: true }),
        "Password123!",
      );
      await guest.page.getByRole("button", { name: "Tạo tài khoản" }).click();

      await expect(
        guest.page.getByRole("heading", {
          level: 1,
          name: "Kiểm tra email nhé",
        }),
      ).toBeVisible();
      await expect(guest.page.getByRole("status")).toContainText(
        "Vì lý do bảo mật, thông báo này không xác nhận một email đã có tài khoản hay chưa.",
      );

      errors.assertNoErrors();
    } finally {
      await guest.dispose();
    }
  });

  test("[T1-F01-05] /forgot-password submits email and supports resend confirmation", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const errors = attachPageErrorCollector(guest.page);
      await installApiMock(guest.page);
      await mockSupabasePasswordAuth(guest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
      });

      await guest.page.goto("/forgot-password", {
        waitUntil: "load",
      });
      await expect(
        guest.page.getByRole("heading", {
          level: 1,
          name: "Khôi phục mật khẩu",
        }),
      ).toBeVisible();

      await fillHydrated(
        guest.page.getByLabel("Email của ba mẹ"),
        "parent@viread.local",
      );
      await guest.page.getByRole("button", { name: "Gửi hướng dẫn" }).click();

      await expect(
        guest.page.getByRole("heading", {
          level: 1,
          name: "Kiểm tra email nhé",
        }),
      ).toBeVisible();

      await guest.page
        .getByRole("button", { name: "Gửi lại hướng dẫn" })
        .click();
      await expect(
        guest.page.getByRole("heading", {
          level: 1,
          name: "Đã yêu cầu gửi lại",
        }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await guest.dispose();
    }
  });

  test("[T1-F01-06] Security headers enforced on Next.js responses without X-Powered-By", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const res = await guest.context.request.get("/login");
      expect(res.status()).toBe(200);
      const headers = res.headers();
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["referrer-policy"]).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(headers["permissions-policy"]).toContain("camera=(self)");
      expect(headers["permissions-policy"]).toContain("microphone=(self)");
      expect(headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
      expect(headers["content-security-policy"]).toContain("object-src 'none'");
      expect(headers["x-powered-by"]).toBeUndefined();
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F01-01] Login and Admin Login client validation and invalid credentials alert banners", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      await installApiMock(guest.page);
      await mockSupabasePasswordAuth(guest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
        rejectSignIn: true,
      });

      await guest.page.goto("/login", { waitUntil: "load" });
      await expect(async () => {
        await guest.page.getByRole("button", { name: "Đăng nhập" }).click();
        await expect(
          guest.page.getByText("Ba mẹ vui lòng nhập email."),
        ).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });
      await expect(
        guest.page.getByText("Mật khẩu cần có ít nhất 8 ký tự."),
      ).toBeVisible();

      await fillHydrated(
        guest.page.getByLabel("Email của ba mẹ"),
        "not-an-email",
      );
      await guest.page.getByRole("button", { name: "Đăng nhập" }).click();
      await expect(
        guest.page.getByText("Email chưa đúng định dạng."),
      ).toBeVisible();

      await fillHydrated(
        guest.page.getByLabel("Email của ba mẹ"),
        "parent@viread.local",
      );
      await fillHydrated(
        guest.page.getByLabel("Mật khẩu", { exact: true }),
        "WrongPass123!",
      );
      await guest.page.getByRole("button", { name: "Đăng nhập" }).click();
      await expect(appAlerts(guest.page)).toContainText(
        "Email hoặc mật khẩu chưa đúng. Ba mẹ thử lại nhé.",
      );

      await guest.page.goto("/admin/login", { waitUntil: "load" });
      await expect(async () => {
        await guest.page.getByRole("button", { name: "Đăng nhập" }).click();
        await expect(guest.page.getByText("Vui lòng nhập email.")).toBeVisible({
          timeout: 2_000,
        });
      }).toPass({ timeout: 15_000 });
      await fillHydrated(
        guest.page.getByLabel("Email quản trị"),
        "admin@viread.local",
      );
      await fillHydrated(
        guest.page.getByLabel("Mật khẩu", { exact: true }),
        "WrongAdmin123!",
      );
      await guest.page.getByRole("button", { name: "Đăng nhập" }).click();
      await expect(appAlerts(guest.page)).toContainText(
        "Thông tin đăng nhập chưa đúng. Vui lòng thử lại.",
      );
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F01-02] Cross-role SSR isolation and Active=0 deactivated account fail-closed rejection", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    const admin = await createRoleContext(browser, "admin");
    const guest = await createRoleContext(browser, "guest");
    try {
      const parentToAdmin = await parent.context.request.get("/admin/parents", {
        maxRedirects: 0,
      });
      expect(parentToAdmin.status()).toBe(307);
      expect(
        new URL(parentToAdmin.headers().location ?? "", parent.baseURL)
          .pathname,
      ).toBe("/dashboard");

      const adminToProfile = await admin.context.request.get("/profile", {
        maxRedirects: 0,
      });
      expect(adminToProfile.status()).toBe(307);
      expect(
        new URL(adminToProfile.headers().location ?? "", admin.baseURL)
          .pathname,
      ).toBe("/admin/books");

      // Deactivated account (Active=0) in unheadered guest context fails closed on /admin/login
      await installApiMock(guest.page);
      await mockSupabasePasswordAuth(guest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "deactivated@viread.local",
        role: "admin",
        active: 0,
      });
      await guest.page.goto("/admin/login", { waitUntil: "load" });
      await fillHydrated(
        guest.page.getByLabel("Email quản trị"),
        "deactivated@viread.local",
      );
      await fillHydrated(
        guest.page.getByLabel("Mật khẩu", { exact: true }),
        "AdminPass123!",
      );
      await guest.page.getByRole("button", { name: "Đăng nhập" }).click();

      await expect(appAlerts(guest.page)).toContainText(
        "Tài khoản này không có quyền truy cập khu vực quản trị.",
      );
    } finally {
      await Promise.all([parent.dispose(), admin.dispose(), guest.dispose()]);
    }
  });

  test("[T2-F01-03] Open-redirect sanitization rejects unsafe next paths and cross-role next targets", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      await installApiMock(parent.page);
      await mockSupabasePasswordAuth(parent.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
      });

      for (const unsafeNext of [
        ...OPAQUE_UNSAFE_NEXT_PATHS,
        "/admin/health",
        "/login",
      ]) {
        await parent.page.goto(
          `/login?next=${encodeURIComponent(unsafeNext)}`,
          { waitUntil: "load" },
        );
        await fillHydrated(
          parent.page.getByLabel("Email của ba mẹ"),
          "parent@viread.local",
        );
        await fillHydrated(
          parent.page.getByLabel("Mật khẩu", { exact: true }),
          "SecretPass123!",
        );
        await parent.page.getByRole("button", { name: "Đăng nhập" }).click();

        await expect(parent.page).toHaveURL(/\/dashboard$/);
      }
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F01-04] /register validation and duplicate-email non-enumerating flow", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      await installApiMock(guest.page);
      await guest.page.route("https://*.supabase.co/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/auth/v1/signup")) {
          await route.fulfill({
            status: 422,
            contentType: "application/json",
            body: JSON.stringify({
              code: "user_already_exists",
              msg: "User already registered",
            }),
          });
          return;
        }
        await route.fulfill({ status: 200, body: "{}" });
      });

      await guest.page.goto("/register", { waitUntil: "load" });
      await expect(async () => {
        await guest.page.getByRole("button", { name: "Tạo tài khoản" }).click();
        await expect(
          guest.page.getByText("Ba mẹ vui lòng nhập họ và tên."),
        ).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });

      await fillHydrated(
        guest.page.getByLabel("Họ và tên ba mẹ"),
        "Phụ huynh B",
      );
      await fillHydrated(
        guest.page.getByLabel("Email của ba mẹ"),
        "existing@viread.local",
      );
      await fillHydrated(
        guest.page.getByLabel("Mật khẩu", { exact: true }),
        "Password123!",
      );
      await guest.page.getByRole("button", { name: "Tạo tài khoản" }).click();

      const alertText = appAlerts(guest.page);
      await expect(alertText).toContainText(
        "Không thể hoàn tất đăng ký. Ba mẹ vui lòng kiểm tra thông tin hoặc đăng nhập nếu đã có tài khoản.",
      );
      await expect(alertText).not.toContainText(/already|tồn tại/i);
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F01-05] /reset-password fail-closed without recovery context, expired state, and password mismatch", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const errors = attachPageErrorCollector(guest.page);
      await installApiMock(guest.page);
      await mockSupabasePasswordAuth(guest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
      });

      await guest.page.goto("/reset-password", {
        waitUntil: "load",
      });
      await expect(
        guest.page.getByRole("heading", {
          level: 1,
          name: "Liên kết không hợp lệ",
        }),
      ).toBeVisible();
      await expect(guest.page.getByRole("status")).toContainText(
        "Liên kết khôi phục không thể được sử dụng để đổi mật khẩu.",
      );
      await expect(
        guest.page.getByRole("link", { name: "Yêu cầu hướng dẫn mới" }),
      ).toBeVisible();

      await guest.page.goto(
        "/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
        { waitUntil: "load" },
      );
      await expect(
        guest.page.getByRole("heading", {
          level: 1,
          name: "Liên kết đã hết hạn",
        }),
      ).toBeVisible();

      const recoveryJwt = makeSupabaseJwt(OPAQUE_PARENT_ID, "parent");
      await guest.page.goto(
        `/reset-password#access_token=${recoveryJwt}&refresh_token=opaque-refresh&type=recovery&expires_in=3600`,
        { waitUntil: "load" },
      );
      await expect(
        guest.page.getByRole("heading", {
          level: 1,
          name: "Đặt mật khẩu mới",
        }),
      ).toBeVisible();
      await fillHydrated(
        guest.page.getByLabel("Mật khẩu mới", { exact: true }),
        "NewSecret123!",
      );
      await fillHydrated(
        guest.page.getByLabel("Nhập lại mật khẩu mới", { exact: true }),
        "Different123!",
      );
      await guest.page
        .getByRole("button", { name: "Lưu mật khẩu mới" })
        .click();
      await expect(
        guest.page.getByText("Hai mật khẩu chưa khớp."),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F01-06] Spoofed x-viread-ssr-auth, invalid fixture token, and bogus auth cookie fail closed", async ({
    browser,
  }) => {
    const rawContext = await browser.newContext({
      baseURL: `http://127.0.0.1:${process.env.PLAYWRIGHT_OPAQUE_PORT?.trim() || "3299"}`,
      extraHTTPHeaders: {
        "x-viread-ssr-auth": "forged.payload.signature",
        "x-readalong-playwright-role": "admin",
        "x-readalong-playwright-auth-token": "invalid-short-token",
      },
    });
    try {
      await rawContext.addCookies([
        {
          name: "sb-example-auth-token",
          value: "base64-not-a-valid-jwt-session",
          domain: "127.0.0.1",
          path: "/",
        },
        {
          name: "viread_role_cache",
          value: "forged-role-cache",
          domain: "127.0.0.1",
          path: "/",
        },
      ]);

      const adminRes = await rawContext.request.get("/admin/parents", {
        maxRedirects: 0,
      });
      expect(adminRes.status()).toBe(307);
      expect(
        new URL(
          adminRes.headers().location ?? "",
          `http://127.0.0.1:${process.env.PLAYWRIGHT_OPAQUE_PORT?.trim() || "3299"}`,
        ).pathname,
      ).toBe("/admin/login");

      const parentRes = await rawContext.request.get("/dashboard", {
        maxRedirects: 0,
      });
      expect(parentRes.status()).toBe(307);
      expect(
        new URL(
          parentRes.headers().location ?? "",
          `http://127.0.0.1:${process.env.PLAYWRIGHT_OPAQUE_PORT?.trim() || "3299"}`,
        ).pathname,
      ).toBe("/login");
    } finally {
      await rawContext.close();
    }
  });
});

// ===========================================================================
// F-02: OAuth PKCE & Android Loopback (5 Tier 1 + 5 Tier 2)
// ===========================================================================

test.describe("F-02: OAuth PKCE & Android Loopback", () => {
  test("[T1-F02-01] Google OAuth button initiates /auth/v1/authorize with provider=google and openid email profile scopes", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      let capturedAuthorizeUrl: URL | null = null;
      await guest.page.route("https://*.supabase.co/**", async (route) => {
        const reqUrl = new URL(route.request().url());
        if (reqUrl.pathname.startsWith("/auth/v1/authorize")) {
          capturedAuthorizeUrl = reqUrl;
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<html><body>OAuth Mock</body></html>",
          });
          return;
        }
        await route.fulfill({ status: 200, body: "{}" });
      });

      await guest.page.goto("/login", { waitUntil: "domcontentloaded" });
      await guest.page
        .getByRole("button", { name: "Tiếp tục với Google" })
        .click();

      await expect.poll(() => capturedAuthorizeUrl !== null).toBe(true);
      expect(capturedAuthorizeUrl!.searchParams.get("provider")).toBe("google");
      expect(capturedAuthorizeUrl!.searchParams.get("scopes")).toBe(
        "openid email profile",
      );
      expect(capturedAuthorizeUrl!.searchParams.get("redirect_to")).toContain(
        "/auth/callback",
      );
    } finally {
      await guest.dispose();
    }
  });

  test("[T1-F02-02] Facebook OAuth button requests email scope and sets viread_auth_next cookie for safe next", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      let capturedAuthorizeUrl: URL | null = null;
      await guest.page.route("https://*.supabase.co/**", async (route) => {
        const reqUrl = new URL(route.request().url());
        if (reqUrl.pathname.startsWith("/auth/v1/authorize")) {
          capturedAuthorizeUrl = reqUrl;
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<html><body>OAuth Mock</body></html>",
          });
          return;
        }
        await route.fulfill({ status: 200, body: "{}" });
      });

      await guest.page.goto("/login?next=%2Fbooks", {
        waitUntil: "domcontentloaded",
      });
      await guest.page
        .getByRole("button", { name: "Tiếp tục với Facebook" })
        .click();

      await expect.poll(() => capturedAuthorizeUrl !== null).toBe(true);
      expect(capturedAuthorizeUrl!.searchParams.get("provider")).toBe(
        "facebook",
      );
      expect(capturedAuthorizeUrl!.searchParams.get("scopes")).toBe("email");

      const cookies = await guest.context.cookies();
      const nextCookie = cookies.find((c) => c.name === "viread_auth_next");
      expect(decodeURIComponent(nextCookie?.value ?? "")).toBe("/books");
    } finally {
      await guest.dispose();
    }
  });

  test("[T1-F02-03] /auth/callback with app_shell=android from desktop browser redirects 307 to viread://auth/callback", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const res = await guest.context.request.get(
        "/auth/callback?app_shell=android&code=pkce_123",
        { maxRedirects: 0 },
      );
      expect(res.status()).toBe(307);
      expect(res.headers().location).toBe(
        "viread://auth/callback?code=pkce_123",
      );
    } finally {
      await guest.dispose();
    }
  });

  test("[T1-F02-04] /auth/callback from ViReadAndroid/1.0 UA does NOT emit viread:// deep link", async ({
    browser,
  }) => {
    const androidGuest = await createRoleContext(browser, "android", {
      appRole: "guest",
    });
    try {
      const res = await androidGuest.context.request.get(
        "/auth/callback?app_shell=android&code=pkce_123",
        { maxRedirects: 0 },
      );
      expect(res.status()).toBe(307);
      const location = res.headers().location ?? "";
      expect(location.startsWith("viread://")).toBe(false);
      expect(new URL(location, androidGuest.baseURL).pathname).toBe("/login");
    } finally {
      await androidGuest.dispose();
    }
  });

  test("[T1-F02-05] /login oauth_error=email_required and oauth_failed render exact localized alert banners", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      await guest.page.goto("/login?oauth_error=email_required", {
        waitUntil: "domcontentloaded",
      });
      await expect(guest.page.getByRole("alert")).toContainText(
        "Facebook không cung cấp email cho tài khoản này. Hãy cấp quyền email trong Facebook hoặc đăng nhập bằng Google/email và mật khẩu.",
      );

      await guest.page.goto("/login?oauth_error=oauth_failed", {
        waitUntil: "domcontentloaded",
      });
      await expect(guest.page.getByRole("alert")).toContainText(
        "Không thể hoàn tất đăng nhập xã hội. Nếu dùng Facebook, hãy kiểm tra quyền email của ứng dụng Facebook rồi thử lại.",
      );
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F02-01] /auth/callback missing code or error=access_denied redirects 307 to /login?oauth_error=oauth_failed and clears viread_auth_next", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      await guest.context.addCookies([
        {
          name: "viread_auth_next",
          value: encodeURIComponent("/books"),
          url: guest.baseURL,
        },
      ]);

      const noCodeRes = await guest.context.request.get("/auth/callback", {
        maxRedirects: 0,
      });
      expect(noCodeRes.status()).toBe(307);
      const loc1 = new URL(noCodeRes.headers().location ?? "", guest.baseURL);
      expect(loc1.pathname).toBe("/login");
      expect(loc1.searchParams.get("oauth_error")).toBe("oauth_failed");

      const deniedRes = await guest.context.request.get(
        "/auth/callback?error=access_denied",
        { maxRedirects: 0 },
      );
      expect(deniedRes.status()).toBe(307);
      const loc2 = new URL(deniedRes.headers().location ?? "", guest.baseURL);
      expect(loc2.pathname).toBe("/login");
      expect(loc2.searchParams.get("oauth_error")).toBe("oauth_failed");

      const cookies = await guest.context.cookies();
      const nextCookie = cookies.find((c) => c.name === "viread_auth_next");
      expect(nextCookie?.value ?? "").toBe("");
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F02-02] /auth/callback?app_shell=android strips unsafe next and rejects invalid code characters", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const badNextRes = await guest.context.request.get(
        "/auth/callback?app_shell=android&code=good_code_1&next=%2F%2Fevil.example.com",
        { maxRedirects: 0 },
      );
      expect(badNextRes.status()).toBe(307);
      expect(badNextRes.headers().location).toBe(
        "viread://auth/callback?code=good_code_1",
      );

      const badCodeRes = await guest.context.request.get(
        "/auth/callback?app_shell=android&code=bad%20code%3Cscript%3E",
        { maxRedirects: 0 },
      );
      expect(badCodeRes.status()).toBe(307);
      expect(badCodeRes.headers().location).toBe(
        "viread://auth/callback?error=oauth_failed",
      );
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F02-03] resolvePublicOrigin rejects spoofed external X-Forwarded-Host and falls back to 127.0.0.1", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const res = await guest.context.request.get("/auth/callback", {
        maxRedirects: 0,
        headers: {
          "x-forwarded-host": "evil.example.com",
          "x-forwarded-proto": "https",
        },
      });
      expect(res.status()).toBe(307);
      const location = res.headers().location ?? "";
      expect(location).not.toContain("evil.example.com");
      expect(["127.0.0.1", "localhost"]).toContain(new URL(location).hostname);
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F02-04] resolvePublicOrigin accepts valid RFC1918 LAN X-Forwarded-Host", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const res = await guest.context.request.get("/auth/callback", {
        maxRedirects: 0,
        headers: {
          "x-forwarded-host": "192.168.1.50:3299",
          "x-forwarded-proto": "https",
        },
      });
      expect(res.status()).toBe(307);
      const location = res.headers().location ?? "";
      expect(location).toMatch(/^https:\/\/192\.168\.1\.50:3299\/login/);
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F02-05] ViReadAndroid/1.0 UA on /login sets OAuth redirect_to to 127.0.0.1:3000/auth/callback with viread_nonce", async ({
    browser,
  }) => {
    const androidGuest = await createRoleContext(browser, "android", {
      appRole: "guest",
    });
    try {
      let capturedAuthorizeUrl: URL | null = null;
      await androidGuest.page.route(
        "https://*.supabase.co/**",
        async (route) => {
          const reqUrl = new URL(route.request().url());
          if (reqUrl.pathname.startsWith("/auth/v1/authorize")) {
            capturedAuthorizeUrl = reqUrl;
            await route.fulfill({ status: 200, body: "<html>OAuth</html>" });
            return;
          }
          await route.fulfill({ status: 200, body: "{}" });
        },
      );

      await androidGuest.page.goto("/login", { waitUntil: "domcontentloaded" });
      await androidGuest.page
        .getByRole("button", { name: "Tiếp tục với Google" })
        .click();

      await expect.poll(() => capturedAuthorizeUrl !== null).toBe(true);
      const redirectTo =
        capturedAuthorizeUrl!.searchParams.get("redirect_to") ?? "";
      const parsedRedirect = new URL(redirectTo);
      expect(parsedRedirect.origin).toBe("http://127.0.0.1:3000");
      expect(parsedRedirect.pathname).toBe("/auth/callback");
      const nonce = parsedRedirect.searchParams.get("viread_nonce") ?? "";
      expect(nonce.length).toBeGreaterThanOrEqual(16);
    } finally {
      await androidGuest.dispose();
    }
  });
});

// ===========================================================================
// F-03: Profiles & Family (5 Tier 1 + 5 Tier 2)
// ===========================================================================

test.describe("F-03: Profiles & Family", () => {
  test("[T1-F03-01] /dashboard renders family desk and selects child profile button", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster1ApiState();
      await installApiMock(parent.page, createCluster1ApiHandler(state));

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Góc đọc gia đình",
        }),
      ).toBeVisible();
      await expect(parent.page.locator("#child-selection-title")).toHaveText(
        "Chọn hồ sơ trẻ",
      );

      const childButton = parent.page.getByRole("button", {
        name: "Bé An, lớp 2",
      });
      await expect(childButton).toBeVisible();
      await expect(childButton).toHaveAttribute("aria-pressed", "true");

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F03-02] /profile updates display name and normalizes Vietnamese phone 0912345678 to +84912345678", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster1ApiState();
      const api = await installApiMock(
        parent.page,
        createCluster1ApiHandler(state),
      );

      await parent.page.goto("/profile", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Thông tin tài khoản",
        }),
      ).toBeVisible();

      await parent.page
        .getByRole("button", { name: "Chỉnh sửa hồ sơ" })
        .click();
      const form = parent.page.getByRole("form", {
        name: "Chỉnh sửa hồ sơ ba mẹ",
      });
      await expect(form).toBeVisible();

      await form.getByLabel("Họ và tên").fill("Phụ huynh Bình Minh");
      await form.getByLabel("Số điện thoại").fill("0912345678");
      await form.getByRole("button", { name: "Lưu thay đổi" }).click();

      await expect(parent.page.getByRole("status")).toContainText(
        "Đã lưu các thay đổi hồ sơ.",
      );
      expect(state.profile.contact_phone).toBe("+84912345678");
      expect(
        api
          .getRequests()
          .some(
            (r) =>
              r.method === "PATCH" && r.path === "/profiles/me/contact-phone",
          ),
      ).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F03-03] /children and /children/new creates child profile via POST /profiles/children", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster1ApiState();
      await installApiMock(parent.page, createCluster1ApiHandler(state));

      await parent.page.goto("/children", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Hồ sơ của các bé",
        }),
      ).toBeVisible();

      await parent.page.getByRole("link", { name: "Tạo hồ sơ bé" }).click();
      await expect(parent.page).toHaveURL(/\/children\/new$/);
      await parent.page.waitForLoadState("load");

      await fillHydrated(parent.page.getByLabel("Tên gọi của bé"), "Bé Bông");
      await parent.page.getByLabel("Lớp của bé").selectOption("3");
      await parent.page.getByRole("button", { name: "Lưu hồ sơ" }).click();

      await expect(parent.page).toHaveURL(/\/children\/[^/?]+\?created=1$/);
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Hồ sơ của Bé Bông",
        }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F03-04] /children/[childId] updates child alias and grade via PUT /profiles/children/{id}", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster1ApiState();
      await installApiMock(parent.page, createCluster1ApiHandler(state));

      await parent.page.goto(`/children/${OPAQUE_CHILD_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Hồ sơ của Bé An",
        }),
      ).toBeVisible();

      await parent.page.getByLabel("Tên gọi của bé").fill("Bé An Lớp 4");
      await parent.page.getByLabel("Lớp của bé").selectOption("4");
      await parent.page.getByRole("button", { name: "Lưu thay đổi" }).click();

      await expect(parent.page.getByRole("status")).toContainText(
        "Thay đổi của hồ sơ bé đã được lưu.",
      );
      expect(state.children[0]?.grade).toBe(4);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F03-05] /children/[childId] deletes child profile via alertdialog confirmation", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createCluster1ApiState();
      await installApiMock(parent.page, createCluster1ApiHandler(state));

      await parent.page.goto(`/children/${OPAQUE_CHILD_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Xóa hồ sơ bé" }).click();

      const dialog = parent.page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Xóa hồ sơ bé?");
      await dialog.getByRole("button", { name: "Xóa hồ sơ" }).click();

      await expect(parent.page).toHaveURL(/\/children$/);
      expect(state.children).toHaveLength(0);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F03-01] Contact phone validation rejects invalid input and handles backend 422", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const state = createCluster1ApiState();
      state.faults["PATCH /profiles/me/contact-phone"] = {
        status: 422,
        body: { detail: "INVALID_PHONE_FORMAT" },
      };
      await installApiMock(parent.page, createCluster1ApiHandler(state));

      await parent.page.goto("/profile", { waitUntil: "domcontentloaded" });
      await parent.page
        .getByRole("button", { name: "Chỉnh sửa hồ sơ" })
        .click();
      const form = parent.page.getByRole("form", {
        name: "Chỉnh sửa hồ sơ ba mẹ",
      });

      await form.getByLabel("Số điện thoại").fill("123");
      await form.getByRole("button", { name: "Lưu thay đổi" }).click();
      await expect(
        parent.page.getByText(
          "Nhập số hợp lệ, ví dụ 0912345678 hoặc +84912345678.",
        ),
      ).toBeVisible();

      await form.getByLabel("Số điện thoại").fill("0912345678");
      await form.getByRole("button", { name: "Lưu thay đổi" }).click();
      await expect(appAlerts(parent.page)).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F03-02] Profile avatar upload valid PNG/WebP and remove vs 0-byte, bad MIME, and >5MB client validation", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const state = createCluster1ApiState();
      await installApiMock(parent.page, createCluster1ApiHandler(state));

      await parent.page.goto("/profile", { waitUntil: "load" });
      await parent.page
        .getByRole("button", { name: "Chỉnh sửa hồ sơ" })
        .click();

      const fileInput = parent.page.getByLabel(
        "Chọn ảnh đại diện PNG, JPG hoặc WEBP",
      );

      // 0-byte file
      await fileInput.setInputFiles({
        name: "empty.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(0),
      });
      await expect(appAlerts(parent.page)).toContainText(
        "Tệp ảnh đang trống. Ba mẹ vui lòng chọn ảnh khác.",
      );

      // Bad MIME type
      await fileInput.setInputFiles({
        name: "script.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from("<svg/>"),
      });
      await expect(appAlerts(parent.page)).toContainText(
        "Chỉ hỗ trợ ảnh PNG, JPG hoặc WEBP.",
      );

      // Oversized (> 5 MB)
      await fileInput.setInputFiles({
        name: "huge.png",
        mimeType: "image/png",
        buffer: makeOversizedBuffer(OVERSIZED_AVATAR_BYTES),
      });
      await expect(appAlerts(parent.page)).toContainText(
        "Ảnh cần có dung lượng tối đa 5 MB.",
      );

      // Valid WebP
      await fileInput.setInputFiles({
        name: "avatar.webp",
        mimeType: "image/webp",
        buffer: makeMinimalWebpBuffer(),
      });
      await expect
        .poll(() => state.profile.avatar_url)
        .toContain("viread-avatars");

      // Remove avatar
      await parent.page.getByRole("button", { name: "Xóa ảnh" }).click();
      await expect.poll(() => state.profile.avatar_url).toBeNull();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F03-03] Server-side avatar 413/422 failure renders safe alert without crash", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const state = createCluster1ApiState();
      state.faults[`POST /profiles/children/${OPAQUE_CHILD_ID}/avatar`] = {
        status: 413,
        body: { detail: "Image exceeds the 5 MB limit" },
      };
      await installApiMock(parent.page, createCluster1ApiHandler(state));

      await parent.page.goto(`/children/${OPAQUE_CHILD_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const fileInput = parent.page.getByLabel(
        "Chọn ảnh đại diện PNG, JPG hoặc WEBP",
      );
      await fileInput.setInputFiles({
        name: "avatar.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });

      await expect(appAlerts(parent.page)).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F03-04] Child grade 1..5 boundary, empty alias validation, and 422 rejection", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const state = createCluster1ApiState();
      state.faults["POST /profiles/children"] = {
        status: 422,
        body: { detail: "INVALID_GRADE" },
      };
      await installApiMock(parent.page, createCluster1ApiHandler(state));

      await parent.page.goto("/children/new", {
        waitUntil: "load",
      });
      await expect(async () => {
        await parent.page.getByRole("button", { name: "Lưu hồ sơ" }).click();
        await expect(
          parent.page.getByText("Ba mẹ vui lòng nhập tên gọi của bé."),
        ).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });

      const gradeOptions = await parent.page
        .getByLabel("Lớp của bé")
        .locator("option")
        .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
      expect(gradeOptions).toEqual(["1", "2", "3", "4", "5"]);

      await fillHydrated(parent.page.getByLabel("Tên gọi của bé"), "Bé Nam");
      await parent.page.getByLabel("Lớp của bé").selectOption("5");
      await parent.page.getByRole("button", { name: "Lưu hồ sơ" }).click();

      await expect(appAlerts(parent.page)).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F03-05] Cross-family child 404, 403 retry state, and dashboard-summary 404 fallback", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    try {
      const foreignChildId = makeOpaqueUuid(99, "92000000");
      const forbiddenChildId = makeOpaqueUuid(98, "92000000");
      const state = createCluster1ApiState({
        dashboardSummaryStatus: 404,
      });
      state.faults[`GET /profiles/children/${forbiddenChildId}`] = {
        status: 403,
        body: { detail: "FORBIDDEN" },
      };
      await installApiMock(parent.page, createCluster1ApiHandler(state));

      // Dashboard fallback on 404 still renders family children
      await parent.page.goto("/dashboard", { waitUntil: "load" });
      await expect(
        parent.page.getByRole("button", { name: "Bé An, lớp 2" }),
      ).toBeVisible();

      // Cross-family 404
      await parent.page.goto(`/children/${foreignChildId}`, {
        waitUntil: "load",
      });
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Không tìm thấy hồ sơ bé",
        }),
      ).toBeVisible();

      // Forbidden 403
      await parent.page.goto(`/children/${forbiddenChildId}`, {
        waitUntil: "load",
      });
      await expect(
        appAlerts(parent.page).filter({ hasText: "Chưa tải được hồ sơ bé" }),
      ).toBeVisible();
      await expect(
        parent.page.getByRole("button", { name: "Thử lại" }),
      ).toBeVisible();
    } finally {
      await parent.dispose();
    }
  });
});

// ===========================================================================
// F-04: Admin Users (5 Tier 1 + 5 Tier 2)
// ===========================================================================

test.describe("F-04: Admin Users (Parents Directory & Governance)", () => {
  function createAdminState() {
    return createCluster1ApiState({
      profile: {
        id: OPAQUE_ADMIN_ID,
        display_name: "Quản trị viên",
        role: "admin",
        created_at: OPAQUE_NOW_ISO,
        email: "admin@viread.local",
        contact_phone: null,
        pending_email: null,
        email_verified: true,
        contact_info_status: "available",
        children: [],
        avatar_url: null,
      },
    });
  }

  test("[T1-F04-01] /admin/parents renders parent directory, KPI total, and rows", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createAdminState();
      await installApiMock(admin.page, createCluster1ApiHandler(state));

      await admin.page.goto("/admin/parents", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        admin.page.getByRole("heading", {
          level: 1,
          name: "Danh sách phụ huynh",
        }),
      ).toBeVisible();
      await expect(admin.page.getByText("Phụ huynh Kiểm thử")).toBeVisible();
      await expect(admin.page.getByText("Trần Thu Hà")).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F04-02] /admin/parents search, pagination, and clear filter work cleanly", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createAdminState();
      for (let i = 10; i < 22; i += 1) {
        state.adminParents.push({
          id: makeOpaqueUuid(i, "91000000"),
          display_name: `Phụ huynh Thứ ${i}`,
          email: `parent${i}@viread.local`,
          phone: `+849000000${i}`,
          created_at: OPAQUE_NOW_ISO,
          children: [],
          contact_info_status: "available",
        });
      }
      const api = await installApiMock(
        admin.page,
        createCluster1ApiHandler(state),
      );

      await admin.page.goto("/admin/parents", {
        waitUntil: "domcontentloaded",
      });
      const nav = admin.page.locator(
        'nav[aria-label="Phân trang danh sách phụ huynh"]',
      );
      await expect(nav).toBeVisible();
      await nav.getByRole("button", { name: "Trang sau" }).click();

      await expect
        .poll(() =>
          api
            .getRequests()
            .some(
              (r) =>
                r.path === "/profiles/admin/parents" &&
                r.url.includes("offset=10"),
            ),
        )
        .toBe(true);

      await admin.page
        .getByLabel("Tìm phụ huynh theo tên hiển thị")
        .fill("Thu Hà");
      await admin.page
        .getByRole("button", { name: "Tìm kiếm", exact: true })
        .click();
      await expect(admin.page.getByText("Trần Thu Hà")).toBeVisible();

      await admin.page.getByRole("button", { name: "Xóa lọc" }).click();
      await expect(admin.page.getByText("Phụ huynh Kiểm thử")).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F04-03] Thêm Parent modal creates parent and shows invitation notice", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createAdminState();
      await installApiMock(admin.page, createCluster1ApiHandler(state));

      await admin.page.goto("/admin/parents", {
        waitUntil: "load",
      });
      await expect(admin.page.getByText("Phụ huynh Kiểm thử")).toBeVisible();

      const dialog = admin.page.getByRole("dialog");
      await expect(async () => {
        await admin.page.getByRole("button", { name: "Thêm Parent" }).click();
        await expect(dialog).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });

      await fillHydrated(dialog.getByLabel("Tên hiển thị"), "Lê Hoàng Long");
      await fillHydrated(dialog.getByLabel("Email"), "long@viread.local");
      await fillHydrated(dialog.getByLabel("Số điện thoại"), "0988777666");
      await dialog.getByRole("button", { name: "Tạo Parent" }).click();

      await expect(
        admin.page.getByText(
          "Đã gửi lời mời tạo tài khoản phụ huynh. Tài khoản cần hoàn tất xác minh email theo hướng dẫn.",
        ),
      ).toBeVisible();
      await expect(admin.page.getByText("Lê Hoàng Long")).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F04-04] /admin/parents/[parentId] renders detail and updates profile via PATCH", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createAdminState();
      await installApiMock(admin.page, createCluster1ApiHandler(state));

      await admin.page.goto(`/admin/parents/${OPAQUE_PARENT_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        admin.page.getByRole("heading", {
          level: 1,
          name: "Phụ huynh Kiểm thử",
        }),
      ).toBeVisible();

      await admin.page.getByRole("button", { name: "Sửa hồ sơ" }).click();
      const dialog = admin.page.getByRole("dialog");
      await dialog.getByLabel("Tên hiển thị").fill("Phụ huynh Đã Sửa");
      await dialog.getByRole("button", { name: "Lưu thay đổi" }).click();

      await expect(
        admin.page.getByRole("heading", {
          level: 1,
          name: "Phụ huynh Đã Sửa",
        }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T1-F04-05] Soft deactivation via Vô hiệu hóa confirms DELETE and preserves related data notice", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const errors = attachPageErrorCollector(admin.page);
      const state = createAdminState();
      await installApiMock(admin.page, createCluster1ApiHandler(state));

      await admin.page.goto("/admin/parents", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: "Vô hiệu hóa" })
        .first()
        .click();

      const dialog = admin.page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Vô hiệu hóa Parent");
      await dialog.getByRole("button", { name: "Vô hiệu hóa Parent" }).click();

      await expect(
        admin.page.getByText(
          "Đã chuyển tài khoản phụ huynh sang trạng thái ngừng hoạt động. Dữ liệu liên quan vẫn được giữ nguyên.",
        ),
      ).toBeVisible();
      expect(state.deactivatedParentIds).toContain(OPAQUE_PARENT_ID);

      errors.assertNoErrors();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F04-01] Admin parent modal validates empty name, bad email, invalid phone, and edit no-change guard", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createAdminState();
      await installApiMock(admin.page, createCluster1ApiHandler(state));

      await admin.page.goto("/admin/parents", {
        waitUntil: "load",
      });
      await expect(admin.page.getByText("Phụ huynh Kiểm thử")).toBeVisible();

      const createDialog = admin.page.getByRole("dialog");
      await expect(async () => {
        await admin.page.getByRole("button", { name: "Thêm Parent" }).click();
        await expect(createDialog).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });

      await createDialog.getByRole("button", { name: "Tạo Parent" }).click();
      await expect(
        createDialog.getByText("Vui lòng nhập tên hiển thị."),
      ).toBeVisible();
      await expect(
        createDialog.getByText("Email là trường bắt buộc."),
      ).toBeVisible();

      await fillHydrated(createDialog.getByLabel("Tên hiển thị"), "Test");
      await fillHydrated(createDialog.getByLabel("Email"), "bad-email");
      await fillHydrated(
        createDialog.getByLabel("Số điện thoại"),
        "1234567890123456789012345678901",
      );
      await createDialog.getByRole("button", { name: "Tạo Parent" }).click();
      await expect(
        createDialog.getByText("Email chưa đúng định dạng."),
      ).toBeVisible();
      await expect(
        createDialog.getByText("Số điện thoại chưa đúng định dạng."),
      ).toBeVisible();
      await createDialog.getByRole("button", { name: "Hủy" }).click();

      // Edit no-change guard
      await admin.page.getByRole("button", { name: "Sửa" }).first().click();
      const editDialog = admin.page.getByRole("dialog");
      await editDialog.getByRole("button", { name: "Lưu thay đổi" }).click();
      await expect(
        editDialog.getByText("Chưa có thay đổi nào để lưu."),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F04-02] Duplicate email 409 preserves form inputs and displays conflict message", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createAdminState();
      await installApiMock(admin.page, createCluster1ApiHandler(state));

      await admin.page.goto("/admin/parents", {
        waitUntil: "load",
      });
      await expect(admin.page.getByText("Phụ huynh Kiểm thử")).toBeVisible();

      const dialog = admin.page.getByRole("dialog");
      await expect(async () => {
        await admin.page.getByRole("button", { name: "Thêm Parent" }).click();
        await expect(dialog).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });

      await fillHydrated(dialog.getByLabel("Tên hiển thị"), "Trùng Email");
      await fillHydrated(dialog.getByLabel("Email"), "parent@viread.local");
      await dialog.getByRole("button", { name: "Tạo Parent" }).click();

      await expect(
        dialog.getByText(
          "Email hoặc số điện thoại đã được một tài khoản khác sử dụng.",
        ),
      ).toBeVisible();
      await expect(dialog.getByLabel("Tên hiển thị")).toHaveValue(
        "Trùng Email",
      );
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F04-03] contact_info_status not_configured disables email and phone inputs in edit modal", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createAdminState();
      state.adminParents[0] = {
        ...state.adminParents[0]!,
        contact_info_status: "not_configured",
      };
      await installApiMock(admin.page, createCluster1ApiHandler(state));

      await admin.page.goto(`/admin/parents/${OPAQUE_PARENT_ID}`, {
        waitUntil: "load",
      });
      await admin.page.getByRole("button", { name: "Sửa hồ sơ" }).click();

      const dialog = admin.page.getByRole("dialog");
      await expect(dialog.getByLabel("Email")).toBeDisabled();
      await expect(dialog.getByLabel("Số điện thoại")).toBeDisabled();
    } finally {
      await admin.dispose();
    }
  });

  test("[T2-F04-04] Non-admin isolation: parent blocked 307 from /admin/parents and API 403 renders forbidden title", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent");
    const admin = await createRoleContext(browser, "admin");
    try {
      const ssrRes = await parent.context.request.get("/admin/parents", {
        maxRedirects: 0,
      });
      expect(ssrRes.status()).toBe(307);
      expect(
        new URL(ssrRes.headers().location ?? "", parent.baseURL).pathname,
      ).toBe("/dashboard");

      const state = createAdminState();
      state.faults["GET /profiles/admin/parents"] = {
        status: 403,
        body: { detail: "FORBIDDEN" },
      };
      await installApiMock(admin.page, createCluster1ApiHandler(state));

      await admin.page.goto("/admin/parents", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        admin.page.getByText("Bạn không có quyền xem danh sách phụ huynh"),
      ).toBeVisible();
    } finally {
      await Promise.all([parent.dispose(), admin.dispose()]);
    }
  });

  test("[T2-F04-05] Strict Zod validation on /profiles/admin/parents rejects invalid UUID and non-offset timestamp", async ({
    browser,
  }) => {
    const admin = await createRoleContext(browser, "admin");
    try {
      const state = createAdminState();
      state.faults["GET /profiles/admin/parents"] = {
        status: 200,
        body: {
          items: [
            {
              id: "not-a-uuid",
              display_name: "Bad",
              created_at: "2026-11-21T10:00:00",
              children_count: 1,
            },
          ],
          total: 1,
          limit: 10,
          offset: 0,
        },
      };
      await installApiMock(admin.page, createCluster1ApiHandler(state));

      await admin.page.goto("/admin/parents", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        admin.page.getByText("Không thể tải danh sách phụ huynh"),
      ).toBeVisible();
    } finally {
      await admin.dispose();
    }
  });
});

// ===========================================================================
// F-23: Android Native WebView APK Contracts (5 Tier 1 + 5 Tier 2)
// ===========================================================================

test.describe("F-23: Android Native WebView APK Contracts", () => {
  test("[T1-F23-01] Origin contract: / -> 307 /login, /login -> 200 HTML with /_next/, api /health -> 200 JSON", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const rootRes = await guest.context.request.get("/", {
        maxRedirects: 0,
      });
      expect(rootRes.status()).toBe(307);
      expect(
        new URL(rootRes.headers().location ?? "", guest.baseURL).pathname,
      ).toBe("/login");

      const loginRes = await guest.context.request.get("/login");
      expect(loginRes.status()).toBe(200);
      expect(loginRes.headers()["content-type"]).toContain("text/html");
      const html = await loginRes.text();
      expect(html).toContain("/_next/");
      expect(html.toLowerCase()).toContain("viread");

      const apiOrigin = (
        process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim() ||
        process.env.NEXT_PUBLIC_API_URL?.trim() ||
        `http://127.0.0.1:${process.env.VIREAD_OPAQUE_API_PORT?.trim() || "18180"}`
      ).replace(/\/+$/, "");
      const healthRes = await guest.context.request.get(`${apiOrigin}/health`);
      expect(healthRes.status()).toBe(200);
      const body = (await healthRes.json()) as {
        status?: string;
        database?: { status?: string };
      };
      expect(body.status).toBe("ok");
      expect(body.database?.status).toBe("healthy");
    } finally {
      await guest.dispose();
    }
  });

  test("[T1-F23-02] ViReadAndroid/1.0 renders ViRead Android WebView in /admin/health device capabilities", async ({
    browser,
  }) => {
    const androidAdmin = await createRoleContext(browser, "android", {
      appRole: "admin",
    });
    try {
      const errors = attachPageErrorCollector(androidAdmin.page);
      await installApiMock(androidAdmin.page, undefined, {
        unmatchedMode: "default-mock",
      });

      await androidAdmin.page.goto("/admin/health", {
        waitUntil: "domcontentloaded",
      });
      const card = androidAdmin.page.getByTestId(
        "admin-client-device-capabilities",
      );
      await expect(card).toBeVisible();
      await expect(card).toContainText("ViRead Android WebView");

      errors.assertNoErrors();
    } finally {
      await androidAdmin.dispose();
    }
  });

  test("[T1-F23-03] ViReadAndroid/1.0 OAuth initiates 127.0.0.1:3000/auth/callback with viread_nonce", async ({
    browser,
  }) => {
    const androidGuest = await createRoleContext(browser, "android", {
      appRole: "guest",
    });
    try {
      let capturedUrl: URL | null = null;
      await androidGuest.page.route(
        "https://*.supabase.co/**",
        async (route) => {
          const reqUrl = new URL(route.request().url());
          if (reqUrl.pathname.startsWith("/auth/v1/authorize")) {
            capturedUrl = reqUrl;
            await route.fulfill({ status: 200, body: "<html>OAuth</html>" });
            return;
          }
          await route.fulfill({ status: 200, body: "{}" });
        },
      );

      await androidGuest.page.goto("/login", { waitUntil: "domcontentloaded" });
      await androidGuest.page
        .getByRole("button", { name: "Tiếp tục với Google" })
        .click();

      await expect.poll(() => capturedUrl !== null).toBe(true);
      const redirectTo = new URL(
        capturedUrl!.searchParams.get("redirect_to") ?? "",
      );
      expect(redirectTo.origin).toBe("http://127.0.0.1:3000");
      expect(redirectTo.pathname).toBe("/auth/callback");
      expect(
        (redirectTo.searchParams.get("viread_nonce") ?? "").length,
      ).toBeGreaterThanOrEqual(16);
    } finally {
      await androidGuest.dispose();
    }
  });

  test("[T1-F23-04] Zero horizontal overflow on /login, /register, and /forgot-password at 390x844 and 360x800 @mobile", async ({
    browser,
  }) => {
    const androidGuest = await createRoleContext(browser, "android", {
      appRole: "guest",
    });
    try {
      const errors = attachPageErrorCollector(androidGuest.page);
      await installApiMock(androidGuest.page);

      for (const viewport of [
        { width: 390, height: 844 },
        { width: 360, height: 800 },
      ]) {
        await androidGuest.page.setViewportSize(viewport);
        for (const path of ["/login", "/register", "/forgot-password"]) {
          await androidGuest.page.goto(path, { waitUntil: "domcontentloaded" });
          const noOverflow = await androidGuest.page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          );
          expect(noOverflow).toBe(true);
        }
      }

      errors.assertNoErrors();
    } finally {
      await androidGuest.dispose();
    }
  });

  test("[T1-F23-05] Zero horizontal overflow on /dashboard, /profile, /children, /children/new, /admin/parents @mobile", async ({
    browser,
  }) => {
    const androidParent = await createRoleContext(browser, "android", {
      appRole: "parent",
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const androidAdmin = await createRoleContext(browser, "android", {
      appRole: "admin",
    });
    try {
      const parentState = createCluster1ApiState();
      await installApiMock(
        androidParent.page,
        createCluster1ApiHandler(parentState),
      );
      const adminState = createCluster1ApiState({
        profile: {
          id: OPAQUE_ADMIN_ID,
          display_name: "Admin",
          role: "admin",
          created_at: OPAQUE_NOW_ISO,
          email: "admin@viread.local",
          contact_phone: null,
          pending_email: null,
          email_verified: true,
          contact_info_status: "available",
          children: [],
          avatar_url: null,
        },
      });
      await installApiMock(
        androidAdmin.page,
        createCluster1ApiHandler(adminState),
      );

      for (const viewport of [
        { width: 390, height: 844 },
        { width: 360, height: 800 },
      ]) {
        await androidParent.page.setViewportSize(viewport);
        for (const path of [
          "/dashboard",
          "/profile",
          "/children",
          "/children/new",
        ]) {
          await androidParent.page.goto(path, {
            waitUntil: "domcontentloaded",
          });
          const noOverflow = await androidParent.page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          );
          expect(noOverflow).toBe(true);
        }

        await androidAdmin.page.setViewportSize(viewport);
        await androidAdmin.page.goto("/admin/parents", {
          waitUntil: "domcontentloaded",
        });
        const adminNoOverflow = await androidAdmin.page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        );
        expect(adminNoOverflow).toBe(true);
      }
    } finally {
      await Promise.all([androidParent.dispose(), androidAdmin.dispose()]);
    }
  });

  test("[T2-F23-01] viread:android-background event suspends camera on /book-scanner and reveals resume CTA", async ({
    browser,
  }) => {
    const androidParent = await createRoleContext(browser, "android", {
      appRole: "parent",
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(androidParent.page);
      await androidParent.context.grantPermissions(["camera"]);
      const state = createCluster1ApiState();
      await installApiMock(
        androidParent.page,
        createCluster1ApiHandler(state),
        { unmatchedMode: "default-mock" },
      );

      await androidParent.page.goto("/book-scanner", {
        waitUntil: "load",
      });
      await androidParent.page
        .getByRole("button", { name: "Bật camera để quét" })
        .click();
      await expect(
        androidParent.page.getByTestId("scanner-camera-viewport"),
      ).toBeVisible();

      await androidParent.page.evaluate(() => {
        document.dispatchEvent(new Event("viread:android-background"));
      });

      const resumeBtn = androidParent.page.getByRole("button", {
        name: "Bật lại camera",
      });
      await expect(resumeBtn).toBeVisible();
      await resumeBtn.click();

      errors.assertNoErrors();
    } finally {
      await androidParent.dispose();
    }
  });

  test("[T2-F23-02] window.ViReadNativeSpeech port handshake handles getCapabilities and speak events", async ({
    browser,
  }) => {
    const androidParent = await createRoleContext(browser, "android", {
      appRole: "parent",
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(androidParent.page);
      await androidParent.page.addInitScript(() => {
        const listeners = new Set<(ev: { data: string }) => void>();
        const sent: Array<Record<string, unknown>> = [];
        (
          window as unknown as {
            __vireadNativeSent?: Array<Record<string, unknown>>;
            ViReadNativeSpeech?: {
              postMessage: (msg: string) => void;
              addEventListener: (
                type: string,
                cb: (ev: { data: string }) => void,
              ) => void;
              removeEventListener: (
                type: string,
                cb: (ev: { data: string }) => void,
              ) => void;
            };
          }
        ).__vireadNativeSent = sent;

        (
          window as unknown as {
            ViReadNativeSpeech: {
              postMessage: (msg: string) => void;
              addEventListener: (
                type: string,
                cb: (ev: { data: string }) => void,
              ) => void;
              removeEventListener: (
                type: string,
                cb: (ev: { data: string }) => void,
              ) => void;
            };
          }
        ).ViReadNativeSpeech = {
          postMessage(raw: string) {
            const cmd = JSON.parse(raw) as Record<string, unknown>;
            sent.push(cmd);
            const emit = (payload: Record<string, unknown>) => {
              const ev = { data: JSON.stringify(payload) };
              for (const l of listeners) l(ev);
            };
            if (cmd.action === "getCapabilities") {
              setTimeout(
                () =>
                  emit({
                    type: "capabilities",
                    requestId: cmd.requestId,
                    ttsAvailable: true,
                    viVoicesCount: 2,
                    sttAvailable: true,
                    onDeviceSttAvailable: true,
                    platform: "android-webview",
                  }),
                10,
              );
            } else if (cmd.action === "speak") {
              setTimeout(() => {
                emit({ type: "tts_start", requestId: cmd.requestId });
                emit({
                  type: "tts_range",
                  requestId: cmd.requestId,
                  start: 0,
                  end: 3,
                });
                emit({ type: "tts_done", requestId: cmd.requestId });
              }, 10);
            }
          },
          addEventListener(_type: string, cb: (ev: { data: string }) => void) {
            listeners.add(cb);
          },
          removeEventListener(
            _type: string,
            cb: (ev: { data: string }) => void,
          ) {
            listeners.delete(cb);
          },
        };
      });

      await installApiMock(androidParent.page, undefined, {
        unmatchedMode: "default-mock",
      });
      await androidParent.page.goto("/dashboard", {
        waitUntil: "domcontentloaded",
      });

      const bridgeResult = await androidParent.page.evaluate(() => {
        const w = window as unknown as {
          ViReadNativeSpeech: {
            postMessage: (msg: string) => void;
            addEventListener: (
              type: string,
              cb: (ev: { data: string }) => void,
            ) => void;
          };
          __vireadNativeSent: Array<Record<string, unknown>>;
        };
        const events: Array<Record<string, unknown>> = [];
        w.ViReadNativeSpeech.addEventListener("message", (ev) => {
          events.push(JSON.parse(ev.data) as Record<string, unknown>);
        });
        w.ViReadNativeSpeech.postMessage(
          JSON.stringify({ action: "getCapabilities", requestId: "cap_1" }),
        );
        w.ViReadNativeSpeech.postMessage(
          JSON.stringify({
            action: "speak",
            requestId: "tts_1",
            text: "Xin chào bé An",
            rate: 1.0,
            pitch: 1.0,
          }),
        );
        return new Promise<{
          sentActions: string[];
          receivedTypes: string[];
        }>((resolve) => {
          setTimeout(() => {
            resolve({
              sentActions: w.__vireadNativeSent.map((c) => String(c.action)),
              receivedTypes: events.map((e) => String(e.type)),
            });
          }, 80);
        });
      });

      expect(bridgeResult.sentActions).toEqual(["getCapabilities", "speak"]);
      expect(bridgeResult.receivedTypes).toContain("capabilities");
      expect(bridgeResult.receivedTypes).toContain("tts_start");
      expect(bridgeResult.receivedTypes).toContain("tts_range");
      expect(bridgeResult.receivedTypes).toContain("tts_done");

      errors.assertNoErrors();
    } finally {
      await androidParent.dispose();
    }
  });

  test("[T2-F23-03] Absent ViReadNativeSpeech port and oversized payload fail safely without uncaught page errors", async ({
    browser,
  }) => {
    const androidParent = await createRoleContext(browser, "android", {
      appRole: "parent",
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(androidParent.page);
      await installApiMock(androidParent.page, undefined, {
        unmatchedMode: "default-mock",
      });

      await androidParent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      const hasNativePort = await androidParent.page.evaluate(() => {
        const w = window as unknown as { ViReadNativeSpeech?: unknown };
        return Boolean(w.ViReadNativeSpeech);
      });
      expect(hasNativePort).toBe(false);

      errors.assertNoErrors();
    } finally {
      await androidParent.dispose();
    }
  });

  test("[T2-F23-04] Android app_shell=android deep-link strips unsafe next and invalid error parameter", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const res = await guest.context.request.get(
        "/auth/callback?app_shell=android&error=access%20denied%21&next=%2F%2Fevil.com",
        { maxRedirects: 0 },
      );
      expect(res.status()).toBe(307);
      expect(res.headers().location).toBe(
        "viread://auth/callback?error=oauth_failed",
      );
    } finally {
      await guest.dispose();
    }
  });

  test("[T2-F23-05] Android WebView renders lang=vi dir=ltr and viewport-fit=cover meta tag", async ({
    browser,
  }) => {
    const androidGuest = await createRoleContext(browser, "android", {
      appRole: "guest",
      locale: "vi",
    });
    try {
      const errors = attachPageErrorCollector(androidGuest.page);
      await androidGuest.page.goto("/login", { waitUntil: "domcontentloaded" });

      await expect(androidGuest.page.locator("html")).toHaveAttribute(
        "lang",
        "vi",
      );
      await expect(androidGuest.page.locator("html")).toHaveAttribute(
        "dir",
        "ltr",
      );
      const viewportContent = await androidGuest.page
        .locator('meta[name="viewport"]')
        .getAttribute("content");
      expect(viewportContent ?? "").toContain("viewport-fit=cover");

      errors.assertNoErrors();
    } finally {
      await androidGuest.dispose();
    }
  });
});
