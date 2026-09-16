import { expect, test } from "@playwright/test";

const currentChildId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const foreignChildId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const group2VisualRoutes = [
  {
    heading: /Chào Nguyễn Minh Anh|Hôm nay mình cùng đọc nhé/,
    name: "dashboard-populated",
    path: "/dashboard",
  },
  {
    heading: "Thông tin tài khoản",
    name: "parent-profile",
    path: "/profile",
  },
  {
    heading: "Các bạn nhỏ của gia đình",
    name: "children-list",
    path: "/children",
    readyText: "Bé An",
  },
  {
    heading: "Tạo hồ sơ bé",
    name: "child-create",
    path: "/children/new",
  },
  {
    heading: "Tài khoản đã sẵn sàng",
    name: "child-onboarding",
    path: "/children/new?from=register",
  },
  {
    heading: "Hồ sơ của Bé An",
    name: "child-edit",
    path: `/children/${currentChildId}`,
  },
] as const;

test.describe("Group 2 parent and child profile UI", () => {
  for (const route of group2VisualRoutes) {
    test(`${route.name} is usable without horizontal overflow`, async ({
      page,
    }, testInfo) => {
      await page.goto(route.path);
      await expect(
        page.getByRole("heading", { name: route.heading }),
      ).toBeVisible();
      if ("readyText" in route) {
        await expect(
          page.getByText(route.readyText, { exact: true }),
        ).toBeVisible();
      }

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

  test("registration creates the first child profile and reaches book selection", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: /Đăng ký/ }).click();

    await page.getByLabel("Họ và tên ba mẹ").fill("Nguyễn Minh Anh");
    await page.getByLabel("Email của ba mẹ").fill("minhanh@example.com");
    await page.getByLabel("Mật khẩu").fill("matkhau123");
    await page.getByRole("button", { name: "Tạo tài khoản" }).click();

    await expect(
      page.getByRole("heading", { name: "Tài khoản đã sẵn sàng" }),
    ).toBeVisible();
    await page.getByLabel("Tên gọi của bé").fill("Bé Na");
    await page.getByLabel("Lớp của bé").selectOption("3");
    await page.getByRole("button", { name: /Lưu và chọn sách/ }).click();

    await expect(page).toHaveURL(/\/books\?childId=/);
    await expect(
      page.getByRole("heading", {
        name: "Bé Na muốn đọc gì hôm nay?",
      }),
    ).toBeVisible();
  });

  test("dashboard opens the owned child profile list", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Quản lý hồ sơ" }).click();

    await expect(page).toHaveURL(/\/children$/);
    await expect(
      page.getByRole("heading", { name: "Các bạn nhỏ của gia đình" }),
    ).toBeVisible();
    await expect(page.getByText("Hồ sơ riêng tư")).toHaveCount(0);
  });

  test("creates and edits an owned child profile", async ({ page }) => {
    await page.goto("/children");
    await page.getByRole("link", { name: "Tạo hồ sơ bé" }).click();
    await page.getByLabel("Tên gọi của bé").fill("Bé Na");
    await page.getByLabel("Lớp của bé").selectOption("3");
    await page.getByRole("button", { name: "Lưu hồ sơ" }).click();

    await expect(page).toHaveURL(/\/children\/[^/?]+\?created=1$/);
    await expect(page.getByText("Hồ sơ bé đã được tạo.")).toBeVisible();

    const alias = page.getByLabel("Tên gọi của bé");
    await alias.fill("Bé Na Mới");
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();

    await expect(
      page.getByText("Thay đổi của hồ sơ bé đã được lưu."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Hồ sơ của Bé Na Mới" }),
    ).toBeVisible();
  });

  test("uses the same not-found UI for a foreign child id", async ({
    page,
  }) => {
    await page.goto(`/children/${foreignChildId}`);

    await expect(
      page.getByRole("heading", { name: "Không tìm thấy hồ sơ bé" }),
    ).toBeVisible();
    await expect(page.getByText(/phụ huynh khác/i)).toHaveCount(0);
  });

  test("keeps child save failures generic", async ({ page }) => {
    await page.goto("/children/new?state=error");
    await page.getByLabel("Tên gọi của bé").fill("Bé Na");
    await page.getByRole("button", { name: "Lưu hồ sơ" }).click();

    await expect(
      page.getByRole("alert").filter({ hasText: "Chưa thể lưu hồ sơ" }),
    ).toContainText("Ba mẹ vui lòng thử lại sau.");
  });

  test("supports empty, loading, and safe-error dashboard states", async ({
    page,
  }) => {
    await page.goto("/dashboard?state=empty");
    await expect(
      page.getByRole("heading", {
        name: "Gia đình mình chưa có hồ sơ bé",
      }),
    ).toBeVisible();

    await page.goto("/dashboard?state=loading");
    await expect(page.getByRole("status")).toContainText("Đang tải");

    await page.goto("/dashboard?state=error");
    await expect(
      page.getByRole("alert").filter({ hasText: "Chưa tải được tổng quan" }),
    ).toContainText("Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.");
  });

  test("has no horizontal overflow at 1024px and 768px", async ({ page }) => {
    for (const width of [1024, 768]) {
      await page.setViewportSize({ height: 1000, width });

      for (const route of [
        "/register",
        "/dashboard",
        "/profile",
        "/children",
        "/children/new",
        `/children/${currentChildId}`,
      ]) {
        await page.goto(route);
        await expect(page.locator("h1")).toBeVisible();
        const dimensions = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(
          dimensions.scrollWidth,
          `${route} at ${width}px`,
        ).toBeLessThanOrEqual(dimensions.clientWidth);
      }
    }
  });
});
