import { expect, test } from "@playwright/test";

const visualRoutes = [
  { name: "login", path: "/login", heading: "Đăng nhập" },
  {
    name: "register",
    path: "/register",
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
        fullPage: true,
        path: testInfo.outputPath(`${route.name}.png`),
      });
    });
  }

  test("login validates the password field", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Đăng nhập" }).click();

    await expect(
      page.getByText("Mật khẩu cần có ít nhất 8 ký tự."),
    ).toBeVisible();
  });

  test("login links to parent registration", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: /Đăng ký/ }).click();

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
    await page.goto("/register");
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
    await page.goto("/forgot-password");
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
    await page.goto("/login");
    await page.getByRole("link", { name: "Quên mật khẩu?" }).click();
    await page.getByRole("button", { name: "Gửi hướng dẫn" }).click();

    await expect(
      page.getByRole("heading", { name: "Kiểm tra email nhé" }),
    ).toBeVisible();

    // The mock represents opening the provider-owned link from the email.
    await page.goto("/reset-password");
    await page
      .getByRole("textbox", { name: "Mật khẩu mới", exact: true })
      .fill("matkhaumoi123");
    await page.getByLabel("Nhập lại mật khẩu mới").fill("matkhaumoi123");
    await page.getByRole("button", { name: "Lưu mật khẩu mới" }).click();

    await expect(
      page.getByRole("heading", { name: "Đã đổi mật khẩu" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Đăng nhập" }).click();
    await page.getByLabel("Mật khẩu").fill("matkhaumoi123");
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
