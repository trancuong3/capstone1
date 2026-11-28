import { expect, test } from "@playwright/test";

const visualRoutes = [
  { name: "login", path: "/login?state=default", heading: "Đăng nhập" },
  {
    name: "register",
    path: "/register?state=default",
    heading: /Đăng ký|Tạo tài khoản cho ba mẹ/,
  },
  {
    name: "forgot-submitted",
    path: "/forgot-password?state=submitted",
    heading: "Kiểm tra email nhé",
  },
  {
    name: "reset-success",
    path: "/reset-password?state=success",
    heading: "Đã đổi mật khẩu",
  },
] as const;

test.describe("Group 1 authentication UI", () => {
  for (const route of visualRoutes) {
    test(`${route.name} is usable without horizontal overflow`, async ({
      page,
    }, testInfo) => {
      await page.goto(route.path);

      await expect(
        page.getByRole("heading", { name: route.heading }),
      ).toBeVisible();
      const widths = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);

      await page.screenshot({
        caret: "initial",
        fullPage: true,
        path: testInfo.outputPath(`${route.name}.png`),
      });
    });
  }

  test("login validates the password field", async ({ page }) => {
    await page.goto("/login?state=default");
    await page.getByRole("button", { name: "Đăng nhập" }).click();

    const emailErr = page.getByText("Ba mẹ vui lòng nhập email.");
    const passErr = page.getByText("Ba mẹ vui lòng nhập mật khẩu.");
    await expect(emailErr).toBeVisible();
    await expect(passErr).toBeVisible();
    await expect(emailErr).toHaveAttribute("aria-live", "polite");
    await expect(passErr).toHaveAttribute("aria-live", "polite");

    // 8-space whitespace-only password must be rejected
    await page.getByLabel("Email của ba mẹ").fill("minhanh@example.com");
    const passwordInput = page.getByLabel("Mật khẩu", { exact: true });
    await passwordInput.fill("        ");
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await expect(passErr).toBeVisible();

    // Placeholders, show/hide password toggle, touch targets >= 44px, and a11y chrome
    await expect(page.getByLabel("Email của ba mẹ")).toHaveAttribute(
      "placeholder",
      "vidu@email.com",
    );
    await expect(passwordInput).toHaveAttribute("placeholder", "Nhập mật khẩu");
    await expect(passwordInput).toHaveAttribute("type", "password");

    const toggle = page.getByRole("button", { name: "Hiện mật khẩu" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(toggleBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    await toggle.click();
    await expect(passwordInput).toHaveAttribute("type", "text");
    await expect(
      page.getByRole("button", { name: "Ẩn mật khẩu" }),
    ).toHaveAttribute("aria-pressed", "true");

    const forgotLink = page.getByRole("link", { name: "Quên mật khẩu?" });
    const forgotBox = await forgotLink.boundingBox();
    expect(forgotBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    const signupLink = page.locator("a.account-signup");
    const signupBox = await signupLink.boundingBox();
    const formBox = await page.locator("form").boundingBox();
    expect(signupBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(signupBox?.width ?? 9999).toBeLessThan((formBox?.width ?? 0) - 20);

    await expect(
      page
        .getByRole("navigation", { name: "Tài khoản ViRead" })
        .getByRole("link", { name: "Đăng nhập" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("link", { name: "ViRead - Đăng nhập" }),
    ).toHaveAttribute("href", "/login");
    await expect(
      page.getByRole("link", { name: "ViRead - Về trang đăng nhập" }),
    ).toHaveAttribute("href", "/login");
  });

  test("login links to parent registration", async ({ page }) => {
    await page.goto("/login?state=default");
    await page
      .getByRole("main")
      .getByRole("link", { name: /Đăng ký/ })
      .click();

    await expect(page).toHaveURL(/\/register$/);
    await expect(
      page.getByRole("heading", {
        name: /Đăng ký|Tạo tài khoản cho ba mẹ/,
      }),
    ).toBeVisible();
  });

  test("registration continues to the first child profile", async ({
    page,
  }) => {
    await page.goto("/register?state=default");
    await page.getByLabel("Họ và tên ba mẹ").fill("Nguyễn Minh Anh");
    await page.getByLabel("Email của ba mẹ").fill("minhanh@example.com");
    await page.getByLabel("Mật khẩu").fill("matkhau123");
    await page.getByRole("button", { name: "Tạo tài khoản" }).click();

    await expect(page).toHaveURL(/\/children\/new\?from=register$/);
  });

  test("registration exposes loading without horizontal overflow", async ({
    page,
  }) => {
    await page.goto("/register?state=loading");

    await expect(page.getByRole("status")).toHaveText("Đang tải…");
    const widths = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
  });

  test("forgot-password completes without account enumeration", async ({
    page,
  }) => {
    await page.goto("/forgot-password?state=default");
    await page.getByLabel("Email của ba mẹ").fill("minhanh@example.com");
    await page.getByRole("button", { name: "Gửi hướng dẫn" }).click();

    await expect(
      page.getByRole("heading", { name: "Kiểm tra email nhé" }),
    ).toBeVisible();
    await expect(page.getByText(/Nếu email này đã được đăng ký/)).toBeVisible();
    await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Về đăng nhập" }),
    ).toHaveAttribute("href", "/login");
  });

  test("forgot-password continues through reset success and login", async ({
    page,
  }) => {
    await page.goto("/login?state=default");
    await page.getByRole("link", { name: "Quên mật khẩu?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel("Email của ba mẹ").fill("minhanh@example.com");
    await page.getByRole("button", { name: "Gửi hướng dẫn" }).click();

    await expect(
      page.getByRole("heading", { name: "Kiểm tra email nhé" }),
    ).toBeVisible();

    // The mock represents opening the provider-owned link from the email.
    await page.goto("/reset-password?state=default");
    await page
      .getByRole("textbox", { name: "Mật khẩu mới", exact: true })
      .fill("matkhaumoi123");
    await page.getByLabel("Nhập lại mật khẩu mới").fill("matkhaumoi123");
    await page.getByRole("button", { name: "Lưu mật khẩu mới" }).click();

    await expect(
      page.getByRole("heading", { name: "Đã đổi mật khẩu" }),
    ).toBeVisible();
    await page
      .getByRole("main")
      .getByRole("link", { name: "Đăng nhập" })
      .click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("Email của ba mẹ").fill("minhanh@example.com");
    await page.getByLabel("Mật khẩu", { exact: true }).fill("matkhaumoi123");
    await page.getByRole("button", { name: "Đăng nhập" }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", {
        name: /Chào Nguyễn Minh Anh|Hôm nay mình cùng đọc nhé/,
      }),
    ).toBeVisible();
  });

  test("reset-password exposes invalid and expired recovery states", async ({
    page,
  }) => {
    await page.goto("/reset-password?state=invalid-token");
    await expect(
      page.getByRole("heading", { name: "Liên kết không hợp lệ" }),
    ).toBeVisible();

    await page.goto("/reset-password?state=expired-token");
    await expect(
      page.getByRole("heading", { name: "Liên kết đã hết hạn" }),
    ).toBeVisible();
  });
});
