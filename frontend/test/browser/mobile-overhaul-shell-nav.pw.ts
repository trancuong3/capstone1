import { expect, test } from "@playwright/test";
import {
  assertAboveMobileBottomNav,
  assertNoHorizontalOverflow,
  assertTouchTargetsMin44,
  assertZeroRuntimeErrors,
  installMobileOverhaulFixture,
  MOBILE_IDS,
  normalizeProjectBucket,
  selectChildViaUi,
} from "./mobile-overhaul-fixture";

test.describe("E2E-F1: Parent Mobile Shell, Navigation & 640-767px Layout", () => {
  test.describe("Tier 1: Core Navigation & Desktop Parity", () => {
    test("Mobile bottom nav 4 primary tabs and Thêm sheet 5 links match desktop top nav active states", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      const bottomNav = page.getByTestId("mobile-bottom-nav");
      const topNav = page.getByRole("navigation", {
        name: "Điều hướng dành cho ba mẹ",
      });

      if (bucket === "desktop-1440x1000") {
        await expect(bottomNav).toBeHidden();
        for (const label of [
          "Tổng quan",
          "Sách của tôi",
          "Tiến bộ",
          "Quản lý đọc",
          "Lịch sử",
          "Giải trí",
          "Từ cần luyện",
        ]) {
          await expect(
            topNav.getByRole("link", { name: label, exact: true }),
          ).toBeVisible();
        }
        await expect(
          topNav.getByRole("link", { name: "Tổng quan", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        await topNav
          .getByRole("link", { name: "Giải trí", exact: true })
          .click();
        await expect(page).toHaveURL(/\/entertainment$/);
        await expect(
          topNav.getByRole("link", { name: "Giải trí", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        await topNav
          .getByRole("link", { name: "Từ cần luyện", exact: true })
          .click();
        await expect(page).toHaveURL(/\/reports\/difficult-words/);
        await expect(
          topNav.getByRole("link", { name: "Từ cần luyện", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
          topNav.getByRole("link", { name: "Tiến bộ", exact: true }),
        ).not.toHaveAttribute("aria-current", "page");
      } else {
        await expect(bottomNav).toBeVisible();
        for (const label of ["Tổng quan", "Sách", "Quét", "Tiến bộ"]) {
          await expect(
            bottomNav.getByRole("link", { name: label, exact: true }),
          ).toBeVisible();
        }
        await expect(
          bottomNav.getByRole("link", { name: "Tổng quan", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        await bottomNav
          .getByRole("link", { name: "Sách", exact: true })
          .click();
        await expect(page).toHaveURL(/\/books/);
        await expect(
          bottomNav.getByRole("link", { name: "Sách", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        await bottomNav
          .getByRole("link", { name: "Quét", exact: true })
          .click();
        await expect(page).toHaveURL(/\/book-scanner/);
        await expect(
          bottomNav.getByRole("link", { name: "Quét", exact: true }),
        ).toHaveAttribute("aria-current", "page");

        await bottomNav.getByRole("button", { name: /Thêm/ }).click();
        const sheet = page.getByRole("dialog", { name: "Tính năng khác" });
        await expect(sheet).toBeVisible();
        for (const label of [
          "Sách của tôi",
          "Quản lý đọc",
          "Lịch sử",
          "Giải trí",
          "Từ cần luyện",
        ]) {
          await expect(sheet.getByRole("link", { name: label })).toBeVisible();
        }
        await sheet.getByRole("link", { name: /Từ cần luyện/ }).click();
        await expect(page).toHaveURL(/\/reports\/difficult-words/);
        await expect(sheet).toBeHidden();
        await expect(
          bottomNav.getByRole("link", { name: "Tiến bộ", exact: true }),
        ).not.toHaveAttribute("aria-current", "page");
      }

      assertZeroRuntimeErrors(state);
    });

    test("Quick child switcher (<1280px) updates selected child and propagates ?childId= on report/management routes", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "gap-640x960",
        "Quick child switcher is only shown below 1280px",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      const switcher = page.getByRole("button", {
        name: /Bé đang chọn: .*, bấm để đổi|Đổi nhanh bé/,
      });
      await expect(switcher).toBeVisible();
      await expect(switcher).toContainText("Bé An");

      for (const route of [
        "/reports",
        "/reports/difficult-words",
        "/sessions",
        "/reading-management",
      ]) {
        await page.goto(route);
        await switcher.click();
        const listbox = page.getByRole("listbox", {
          name: "Chuyển nhanh hồ sơ bé",
        });
        await expect(listbox).toBeVisible();
        await expect(
          listbox.getByRole("link", { name: "Quản lý hồ sơ bé" }),
        ).toHaveAttribute("href", "/children");

        const targetAlias =
          route === "/reports" || route === "/sessions" ? "Bé Bình" : "Bé An";
        const targetId =
          targetAlias === "Bé Bình" ? MOBILE_IDS.childBinh : MOBILE_IDS.childAn;
        await listbox
          .getByRole("option", { name: new RegExp(targetAlias) })
          .click();
        await expect(page).toHaveURL(new RegExp(`childId=${targetId}`));
        await expect(switcher).toContainText(targetAlias);
      }

      assertZeroRuntimeErrors(state);
    });

    test("Account menu navigates to profile, children, settings, help-support and signs out cleanly", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");

      const openAccountMenu = async () => {
        const trigger = page.getByRole("button", { name: "Mở menu tài khoản" });
        await trigger.click();
        const menu = page.getByRole("menu", { name: "Menu tài khoản" });
        await expect(menu).toBeVisible();
        return menu;
      };

      const routes: Array<{
        label: string;
        urlPattern: RegExp;
        heading: RegExp;
      }> = [
        {
          label: "Hồ sơ ba mẹ",
          urlPattern: /\/profile$/,
          heading: /Thông tin tài khoản/,
        },
        {
          label: "Hồ sơ bé",
          urlPattern: /\/children$/,
          heading: /Hồ sơ của các bé/,
        },
        {
          label: "Cài đặt",
          urlPattern: /\/settings$/,
          heading: /Cài đặt tài khoản/,
        },
        {
          label: "Trợ giúp & hỗ trợ",
          urlPattern: /\/help-support$/,
          heading: /Trợ giúp & hỗ trợ/,
        },
      ];

      for (const item of routes) {
        const menu = await openAccountMenu();
        await menu.getByRole("menuitem", { name: item.label }).click();
        await expect(page).toHaveURL(item.urlPattern);
        await expect(
          page.getByRole("heading", { level: 1, name: item.heading }),
        ).toBeVisible();
      }

      const menuForSignOut = await openAccountMenu();
      await menuForSignOut.getByRole("menuitem", { name: "Đăng xuất" }).click();
      await expect(page).toHaveURL(/\/login/);

      assertZeroRuntimeErrors(state);
    });

    test("MobileMoreSheet opens and closes cleanly via button, backdrop, Escape, and navigation", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "gap-720x900",
        "MobileMoreSheet is only rendered below 1280px",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");

      const moreBtn = page
        .getByTestId("mobile-bottom-nav")
        .getByRole("button", { name: /Thêm/ });
      const sheet = page.getByRole("dialog", { name: "Tính năng khác" });

      // Close via explicit Đóng button
      await moreBtn.click();
      await expect(sheet).toBeVisible();
      await sheet.getByRole("button", { name: "Đóng", exact: true }).click();
      await expect(sheet).toBeHidden();

      // Close via backdrop click (click exposed top-left corner outside bottom sheet bounds)
      await moreBtn.click();
      await expect(sheet).toBeVisible();
      await page
        .getByRole("button", { name: "Đóng bảng tính năng khác" })
        .click({ position: { x: 20, y: 20 } });
      await expect(sheet).toBeHidden();

      // Close via Escape key
      await moreBtn.click();
      await expect(sheet).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();

      // Close via navigating to a sheet item
      await moreBtn.click();
      await expect(sheet).toBeVisible();
      await sheet.getByRole("link", { name: /Sách của tôi/ }).click();
      await expect(page).toHaveURL(/\/my-books$/);
      await expect(sheet).toBeHidden();

      assertZeroRuntimeErrors(state);
    });

    test("Desktop parity hides bottom nav & mobile switcher while SiteFooter follows lg breakpoint", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-430x932" &&
          bucket !== "tablet-768x1024" &&
          bucket !== "tablet-1024x768" &&
          bucket !== "desktop-1440x1000",
        "Checks breakpoint visibility across mobile, tablet, and desktop",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");

      const width = page.viewportSize()!.width;
      const bottomNav = page.getByTestId("mobile-bottom-nav");
      const quickSwitcher = page.getByRole("button", {
        name: /Bé đang chọn: .*, bấm để đổi|Đổi nhanh bé/,
      });
      const footer = page.getByRole("contentinfo");

      if (width >= 1280) {
        await expect(bottomNav).toBeHidden();
        await expect(quickSwitcher).toBeHidden();
      } else {
        await expect(bottomNav).toBeVisible();
        await expect(quickSwitcher).toBeVisible();
      }

      if (width >= 1024) {
        await expect(footer).toBeVisible();
      } else {
        await expect(footer).toBeHidden();
      }

      assertZeroRuntimeErrors(state);
    });

    test("Onboarding route /children/new hides bottom nav and quick child switcher", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844",
        "Onboarding shell behavior check on mobile",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/children/new");
      await expect(
        page.getByRole("heading", { level: 1, name: /Tạo hồ sơ bé/ }),
      ).toBeVisible();
      await expect(page.getByTestId("mobile-bottom-nav")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /Đổi nhanh bé|Bé đang chọn:/ }),
      ).toHaveCount(0);
      await assertNoHorizontalOverflow(page);

      assertZeroRuntimeErrors(state);
    });
  });

  test.describe("Tier 2: 8-Viewport Geometry, Touch Targets & Boundary Stress", () => {
    test("Zero horizontal overflow across core shell routes on every viewport", async ({
      page,
    }) => {
      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      for (const route of [
        "/dashboard",
        "/books",
        "/reports",
        "/my-books",
        "/entertainment",
      ]) {
        await page.goto(route);
        await expect(page.locator("main h1").first()).toBeVisible();
        await assertNoHorizontalOverflow(page);
      }

      assertZeroRuntimeErrors(state);
    });

    test("All interactive controls in shell header, mobile bottom nav, More sheet, and account menu meet >= 44x44px touch target on <1024px", async ({
      page,
    }) => {
      const width = page.viewportSize()?.width ?? 1440;
      test.skip(
        width >= 1024,
        "Touch target audit applies to <1024px viewports",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      await assertTouchTargetsMin44(page, { scopeSelector: "header" });
      await assertTouchTargetsMin44(page, {
        scopeSelector: '[data-testid="mobile-bottom-nav"]',
      });

      await page
        .getByTestId("mobile-bottom-nav")
        .getByRole("button", { name: /Thêm/ })
        .click();
      const sheet = page.getByRole("dialog", { name: "Tính năng khác" });
      await expect(sheet).toBeVisible();
      await assertTouchTargetsMin44(page, {
        scopeSelector: "#parent-mobile-more-sheet",
      });
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Mở menu tài khoản" }).click();
      await expect(
        page.getByRole("menu", { name: "Menu tài khoản" }),
      ).toBeVisible();
      await assertTouchTargetsMin44(page, {
        scopeSelector: "#parent-account-menu",
      });

      assertZeroRuntimeErrors(state);
    });

    test("Lowest interactive CTA scrolls clear above fixed mobile bottom nav without occlusion", async ({
      page,
    }) => {
      const width = page.viewportSize()?.width ?? 1440;
      test.skip(
        width >= 1280,
        "Bottom nav clearance applies to <1280px viewports",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      const lastDashboardAction = page.getByRole("link", {
        name: /Lịch sử đọc/,
      });
      await assertAboveMobileBottomNav(page, lastDashboardAction);

      await page.goto("/profile");
      const editBtn = page.getByRole("button", { name: /Chỉnh sửa hồ sơ/ });
      await assertAboveMobileBottomNav(page, editBtn);

      assertZeroRuntimeErrors(state);
    });

    test("Long child alias, long parent display name, and long email do not overflow at 360x800", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-360x800",
        "Narrowest 360x800 boundary stress test",
      );

      const state = await installMobileOverhaulFixture(page, {
        childrenPreset: "long-names",
      });
      await page.goto("/dashboard");

      const longChildCard = page.getByRole("button", {
        name: /Nguyễn Hoàng Minh Khôi Anh Thư/,
      });
      await expect(longChildCard).toBeVisible();
      await longChildCard.click();
      await assertNoHorizontalOverflow(page);

      const switcher = page.getByRole("button", {
        name: /Bé đang chọn: .*, bấm để đổi/,
      });
      await expect(switcher).toBeVisible();
      await switcher.click();
      await expect(
        page.getByRole("listbox", { name: "Chuyển nhanh hồ sơ bé" }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Mở menu tài khoản" }).click();
      await expect(
        page.getByText(
          "phu.huynh.nguyen.tran.hoang.gia.bao.rat.dai@example.test",
        ),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);

      assertZeroRuntimeErrors(state);
    });

    test("640-767px gap viewports (640x960 and 720x900) render topbar controls without overlap or clipping", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "gap-640x960" && bucket !== "gap-720x900",
        "Targets 640-767px dead-zone viewports",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      const logo = page.getByRole("link", { name: "ViRead - về tổng quan" });
      const switcher = page.getByRole("button", {
        name: /Bé đang chọn: .*, bấm để đổi/,
      });
      const accountBtn = page.getByRole("button", {
        name: "Mở menu tài khoản",
      });

      const [logoBox, switcherBox, accountBox] = await Promise.all([
        logo.boundingBox(),
        switcher.boundingBox(),
        accountBtn.boundingBox(),
      ]);
      expect(logoBox).not.toBeNull();
      expect(switcherBox).not.toBeNull();
      expect(accountBox).not.toBeNull();
      if (logoBox && switcherBox && accountBox) {
        expect(logoBox.x + logoBox.width).toBeLessThanOrEqual(
          switcherBox.x + 1,
        );
        expect(switcherBox.x + switcherBox.width).toBeLessThanOrEqual(
          accountBox.x + 1,
        );
        expect(accountBox.x + accountBox.width).toBeLessThanOrEqual(
          page.viewportSize()!.width,
        );
      }

      await assertNoHorizontalOverflow(page);
      assertZeroRuntimeErrors(state);
    });
  });

  test.describe("Tier 3: Cross-Feature & Multi-Tab Pairwise Interactions", () => {
    test("Two-tab localStorage + BroadcastChannel child selection syncs live across /dashboard, /books, and /reports", async ({
      browser,
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Two-tab BroadcastChannel sync verified on mobile and desktop",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      const page2 = await page.context().newPage();
      await page2.setViewportSize(page.viewportSize()!);
      await page2.goto("/books");
      await expect(
        page2.getByRole("heading", { level: 1, name: "Tủ sách của Bé An" }),
      ).toBeVisible();

      // Switch child in Tab 1 to Bé Bình
      await selectChildViaUi(page, "Bé Bình");

      // Tab 2 must reflect the updated selected child live via BroadcastChannel/storage without reloading
      await expect(
        page2.getByRole("heading", { level: 1, name: "Tủ sách của Bé Bình" }),
      ).toBeVisible();
      if (bucket === "mobile-390x844") {
        await expect(
          page2.getByRole("button", { name: /Bé đang chọn: Bé Bình/ }),
        ).toBeVisible();
      }

      // Subsequent navigation to /reports hydrates the synced child
      await page2.goto("/reports");
      await expect(
        page2.getByRole("heading", { level: 1, name: "Tiến bộ của Bé Bình" }),
      ).toBeVisible();

      await page2.close();
      void browser;
      assertZeroRuntimeErrors(state);
    });

    test("Dynamic viewport resize across 640x960 -> 720x900 -> 768x1024 -> 1440x1000 transitions shell menus cleanly", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "gap-640x960",
        "Single dynamic resize sequence driven from gap-640x960",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      // Open MobileMoreSheet at 640x960
      await page
        .getByTestId("mobile-bottom-nav")
        .getByRole("button", { name: /Thêm/ })
        .click();
      const sheet = page.getByRole("dialog", { name: "Tính năng khác" });
      await expect(sheet).toBeVisible();

      // Resize across gap-720x900 and tablet-768x1024
      await page.setViewportSize({ width: 720, height: 900 });
      await assertNoHorizontalOverflow(page);
      await expect(sheet).toBeVisible();

      await page.setViewportSize({ width: 768, height: 1024 });
      await assertNoHorizontalOverflow(page);

      // Resize to desktop 1440x1000: mobile sheet & bottom nav must hide automatically
      await page.setViewportSize({ width: 1440, height: 1000 });
      await assertNoHorizontalOverflow(page);
      await expect(page.getByTestId("mobile-bottom-nav")).toBeHidden();
      await expect(
        page.getByRole("navigation", { name: "Điều hướng dành cho ba mẹ" }),
      ).toBeVisible();

      assertZeroRuntimeErrors(state);
    });
  });
});
