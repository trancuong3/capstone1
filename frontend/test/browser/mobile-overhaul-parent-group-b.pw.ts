import { expect, test } from "@playwright/test";
import {
  assertNoHorizontalOverflow,
  assertNoRawBackendLeak,
  assertTouchTargetsMin44,
  assertZeroRuntimeErrors,
  installMobileOverhaulFixture,
  MOBILE_IDS,
  normalizeProjectBucket,
  selectChildViaUi,
} from "./mobile-overhaul-fixture";

test.describe("E2E-F3: Parent Group B Routes & Entertainment", () => {
  test.describe("Tier 1: Mobile vs Desktop Functional Parity", () => {
    test("/reports renders KPIs, progress chart, assessment, and navigates to difficult words and sessions", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page, {
        hasMorePeriods: true,
      });
      await page.goto("/reports");
      await expect(
        page.getByRole("heading", { level: 1, name: "Tiến bộ của Bé An" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: "Các dấu hiệu khi đọc" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: "So sánh với kỳ trước" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: "Từ cần luyện nổi bật" }),
      ).toBeVisible();

      const periodSelect = page.getByLabel("Kỳ báo cáo đã lưu");
      await expect(periodSelect).toBeVisible();
      const loadMoreBtn = page.getByRole("button", { name: /Tải thêm kỳ/ });
      if (await loadMoreBtn.isVisible()) {
        await loadMoreBtn.click();
      }

      await expect(
        page.getByRole("link", { name: /Lịch sử đọc/ }),
      ).toBeVisible();
      await page.getByRole("link", { name: /Mở mục Từ cần luyện/ }).click();
      await expect(page).toHaveURL(/\/reports\/difficult-words/);

      assertZeroRuntimeErrors(state);
    });

    test("/reports/difficult-words shows mobile status pills vs desktop select and opens practice panel", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/reports/difficult-words");
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Từ cần luyện của Bé An",
        }),
      ).toBeVisible();

      const mobilePills = page.getByRole("group", {
        name: "Lọc nhanh theo trạng thái luyện",
      });
      const desktopSelect = page.getByLabel("Lọc theo trạng thái luyện");

      if (bucket === "mobile-390x844") {
        await expect(mobilePills).toBeVisible();
        await expect(desktopSelect).toBeHidden();
        await mobilePills
          .getByRole("button", { name: "Đã xong", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: /Luyện từ rực rỡ/ }),
        ).toBeVisible();
        await mobilePills
          .getByRole("button", { name: "Tất cả", exact: true })
          .click();
      } else {
        await expect(desktopSelect).toBeVisible();
        await expect(mobilePills).toBeHidden();
        await desktopSelect.selectOption("COMPLETED");
        await expect(
          page.getByRole("button", { name: /Luyện từ rực rỡ/ }),
        ).toBeVisible();
        await desktopSelect.selectOption("ALL");
      }

      await page.getByRole("button", { name: /Luyện từ ngập ngừng/ }).click();
      await expect(
        page.getByRole("heading", { level: 2, name: "ngập ngừng" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Nghe phát âm mẫu" }),
      ).toBeVisible();
      await expect(page.getByText(/Lịch sử luyện từ này/)).toBeVisible();

      await page.getByRole("button", { name: "Quay về danh sách" }).click();
      await expect(
        page.getByRole("button", { name: /Luyện từ ngập ngừng/ }),
      ).toBeVisible();

      assertZeroRuntimeErrors(state);
    });

    test("/sessions, /sessions/[sessionId], and /sessions/[sessionId]/report render history and detail", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page, {
        hasNextHistoryCursor: true,
      });
      await page.goto("/sessions");
      await expect(
        page.getByRole("heading", { level: 1, name: "Lịch sử đọc" }),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: /Phân trang/ }),
      ).toBeVisible();

      await page.getByRole("link", { name: "Xem chi tiết" }).first().click();
      await expect(page).toHaveURL(
        new RegExp(`/sessions/${MOBILE_IDS.sessionPrimary}`),
      );
      await expect(
        page.getByRole("heading", { level: 1, name: /Buổi đọc/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: "Câu hỏi đọc hiểu" }),
      ).toBeVisible();

      await page.goto(`/sessions/${MOBILE_IDS.sessionPrimary}/report`);
      await expect(page.locator("main")).toBeVisible();

      assertZeroRuntimeErrors(state);
    });

    test("/reading-management switches between mobile 4-tab layout and desktop masonry and creates plan + goal", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/reading-management");
      await expect(
        page.getByRole("heading", { level: 1, name: "Quản lý đọc sách" }),
      ).toBeVisible();

      const tablist = page.getByRole("tablist", { name: "Mục quản lý đọc" });
      if (bucket === "mobile-390x844") {
        await expect(tablist).toBeVisible();
        for (const tabName of [
          /Kế hoạch/,
          /Mục tiêu/,
          /Lịch nhắc/,
          /Sách lưu/,
        ]) {
          await tablist.getByRole("tab", { name: tabName }).click();
        }
        await tablist.getByRole("tab", { name: /Kế hoạch/ }).click();
      } else {
        await expect(tablist).toBeHidden();
        await expect(
          page.getByRole("heading", {
            level: 2,
            name: "Kế hoạch đọc trong tuần",
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", {
            level: 2,
            name: "Sách yêu thích và danh sách muốn đọc",
          }),
        ).toBeVisible();
      }

      // Create reading plan
      await page.getByRole("button", { name: "Thêm kế hoạch" }).click();
      await page
        .getByLabel("Tên kế hoạch")
        .fill("Đọc truyện cổ tích cuối tuần");
      await page.getByRole("button", { name: "Tạo kế hoạch tuần" }).click();
      await expect(
        page.getByText("Đọc truyện cổ tích cuối tuần"),
      ).toBeVisible();

      // Create reading goal
      if (bucket === "mobile-390x844") {
        await tablist.getByRole("tab", { name: /Mục tiêu/ }).click();
      }
      await page.getByRole("button", { name: "Thêm mục tiêu" }).click();
      await page.getByRole("button", { name: "Tạo mục tiêu" }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Quản lý đọc sách" }),
      ).toBeVisible();

      assertZeroRuntimeErrors(state);
    });

    test("/children CRUD, /profile edit, /settings password editor, and /help-support FAQ/feedback work on mobile and desktop", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000 parity pair",
      );

      const state = await installMobileOverhaulFixture(page);

      // /children CRUD
      await page.goto("/children");
      await expect(
        page.getByRole("heading", { level: 1, name: "Hồ sơ của các bé" }),
      ).toBeVisible();
      await page.getByRole("link", { name: /Tạo hồ sơ bé/ }).click();
      await expect(page).toHaveURL(/\/children\/new$/);
      await page.getByLabel("Tên gọi của bé").fill("Bé Cúc");
      await page.getByLabel("Lớp của bé").selectOption("3");
      await page.getByRole("button", { name: /Lưu hồ sơ/ }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Hồ sơ của Bé Cúc" }),
      ).toBeVisible();

      // /profile edit
      await page.goto("/profile");
      await expect(
        page.getByRole("heading", { level: 1, name: "Thông tin tài khoản" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Chỉnh sửa hồ sơ" }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Chỉnh sửa hồ sơ" }),
      ).toBeVisible();

      // /settings
      await page.goto("/settings");
      await expect(
        page.getByRole("heading", { level: 1, name: "Cài đặt tài khoản" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Đổi mật khẩu" }),
      ).toBeVisible();

      // /help-support FAQ + feedback submit
      await page.goto("/help-support");
      await expect(
        page.getByRole("heading", { level: 1, name: "Trợ giúp & hỗ trợ" }),
      ).toBeVisible();
      if (bucket === "mobile-390x844") {
        await page.getByRole("button", { name: "Tài khoản" }).click();
      }
      await page.getByText("Làm thế nào để đổi mật khẩu?").click();
      await expect(
        page.getByText(/Mở menu tài khoản, chọn Cài đặt/),
      ).toBeVisible();

      await page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await page.locator("#support-subject").fill("Góp ý giao diện di động");
      await page
        .locator("#support-message")
        .fill("Giao diện đọc trên điện thoại rất dễ nhìn.");
      await page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await expect(
        page.getByText(/Máy chủ email đã tiếp nhận phản hồi/),
      ).toBeVisible();
      expect(state.supportPayloads.length).toBe(1);

      assertZeroRuntimeErrors(state);
    });

    test("/entertainment hub, sentence-shooter full flow, picture-description tabs/submit, and karaoke work across mobile & desktop", async ({
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

      // Hub
      await page.goto("/entertainment");
      await expect(
        page.getByRole("heading", { level: 1, name: "Giải trí" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: /Bắt đầu chơi/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: /Chọn tranh/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: /Mở thư viện bài hát/ }),
      ).toBeVisible();

      // Sentence Shooter full 3-round flow + hint + pause + result
      await page.getByRole("link", { name: /Bắt đầu chơi/ }).click();
      await expect(page).toHaveURL(/\/entertainment\/sentence-shooter$/);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Chọn sách và bắt đầu chơi",
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Bắt đầu chơi" }).click();

      for (let roundIdx = 1; roundIdx <= 3; roundIdx += 1) {
        await expect(
          page.getByText(`Câu ${roundIdx}/3`, { exact: true }),
        ).toBeVisible();
        if (roundIdx === 1) {
          await page.getByRole("button", { name: "Gợi ý một từ" }).click();
          await expect(
            page.getByRole("button", { name: /Từ gợi ý/ }),
          ).toBeVisible();

          await page.getByRole("button", { name: "Tạm dừng" }).click();
          await expect(
            page.getByRole("heading", { name: "Tạm nghỉ một chút nhé?" }),
          ).toBeVisible();
          await page.getByRole("button", { name: "Chơi tiếp" }).click();
        }
        const tokenGroup = page.getByRole("group", { name: "Các từ để ghép" });
        const expectedWords =
          roundIdx === 1
            ? ["Bé", "An", "đọc", "sách"]
            : ["Bé", "An", "đọc", `sách (${roundIdx})`];
        for (const word of expectedWords) {
          await tokenGroup
            .getByRole("button", {
              name: new RegExp(`^${word.replace(/[()]/g, "\\$&")}`),
            })
            .click();
        }
        if (roundIdx < 3) {
          await page.getByRole("button", { name: "Câu tiếp theo" }).click();
        } else {
          await page.getByRole("button", { name: "Xem kết quả" }).click();
        }
      }

      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Giỏi quá, bé đã hoàn thành!",
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Đọc câu mẫu" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Chơi lượt mới" }),
      ).toBeVisible();

      // Picture Description tabs + submit
      await page.goto("/entertainment/picture-description");
      await expect(
        page.getByRole("heading", { level: 1, name: "Kể chuyện qua tranh" }),
      ).toBeVisible();
      const sourceTabs = page.getByRole("tablist", {
        name: "Chọn nguồn tranh",
      });
      await sourceTabs.getByRole("tab", { name: "Tải ảnh từ máy" }).click();
      await sourceTabs
        .getByRole("tab", { name: "Tranh từ sách ViRead" })
        .click();
      await sourceTabs
        .getByRole("tab", { name: "Tranh chủ đề ViRead" })
        .click();

      await page
        .getByRole("button", { name: "Khám phá tranh này" })
        .first()
        .click();
      await expect(
        page.getByRole("tab", { name: "Mô tả tranh" }),
      ).toBeVisible();
      await page
        .locator("#picture-description-input")
        .fill("Trong khu vườn có nhiều bông hoa rực rỡ dưới nắng mai.");
      await page
        .getByRole("button", { name: "Gửi cô giáo AI chấm bài" })
        .click();
      await expect(
        page.getByText("Bé kể chuyện thật sinh động và rõ ràng!"),
      ).toBeVisible();

      // Karaoke
      await page.goto("/karaoke");
      await expect(
        page.getByRole("heading", { level: 1, name: "Hát vui cùng Bé An" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Hát bài Bài hát của bé" }).click();
      await expect(page).toHaveURL(
        new RegExp(`/karaoke/${MOBILE_IDS.karaokeSongId}`),
      );
      await expect(
        page.getByRole("button", { name: "Bắt đầu hát", exact: true }),
      ).toBeVisible();

      assertZeroRuntimeErrors(state);
    });
  });

  test.describe("Tier 2: 8-Viewport Layout, Touch Targets, Long Text & Error Resilience", () => {
    test("All Group B and Entertainment routes render with zero horizontal overflow across all 8 viewports", async ({
      page,
    }) => {
      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      const routes = [
        "/reports",
        "/reports/difficult-words",
        "/sessions",
        `/sessions/${MOBILE_IDS.sessionPrimary}`,
        "/reading-management",
        "/children",
        "/children/new",
        "/profile",
        "/settings",
        "/help-support",
        "/device-permissions",
        "/entertainment",
        "/entertainment/sentence-shooter",
        "/entertainment/picture-description",
        "/karaoke",
        `/karaoke/${MOBILE_IDS.karaokeSongId}?version=${MOBILE_IDS.karaokeVersionId}`,
      ];

      for (const route of routes) {
        await page.goto(route);
        if (route === "/device-permissions") {
          await expect(page).toHaveURL(/\/dashboard\?focus=child-selection/);
        }
        await expect(page.locator("main h1").first()).toBeVisible();
        await assertNoHorizontalOverflow(page);
      }

      assertZeroRuntimeErrors(state);
    });

    test("Group B & Entertainment interactive controls meet >= 44x44px touch target audit on <1024px", async ({
      page,
    }) => {
      const width = page.viewportSize()?.width ?? 1440;
      test.skip(
        width >= 1024,
        "Touch target audit applies to <1024px viewports",
      );

      const state = await installMobileOverhaulFixture(page, {
        shooterBooksCount: 11,
      });
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      // /device-permissions redirects to /dashboard?focus=child-selection
      await page.goto("/device-permissions");
      await expect(page).toHaveURL(/\/dashboard\?focus=child-selection/);
      await expect(page.locator("main h1").first()).toBeVisible();
      await assertTouchTargetsMin44(page, { scopeSelector: "main" });

      // /reports/difficult-words filter pills & <summary>
      await page.goto("/reports/difficult-words");
      await assertTouchTargetsMin44(page, { scopeSelector: "main" });

      // /reading-management tabs & pagination
      await page.goto("/reading-management");
      await assertTouchTargetsMin44(page, { scopeSelector: "main" });

      // /help-support FAQ accordions
      await page.goto("/help-support");
      await assertTouchTargetsMin44(page, { scopeSelector: "main" });

      // /entertainment/sentence-shooter lobby + playing arena tokens
      await page.goto("/entertainment/sentence-shooter");
      await assertTouchTargetsMin44(page, { scopeSelector: "main" });
      await page.getByRole("button", { name: "Bắt đầu chơi" }).click();
      await expect(
        page.getByRole("group", { name: "Các từ để ghép" }),
      ).toBeVisible();
      await assertTouchTargetsMin44(page, { scopeSelector: "main" });

      assertZeroRuntimeErrors(state);
    });

    test("Long Vietnamese compound words & 12-token sentence-shooter challenge wrap cleanly at 360x800", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-360x800",
        "Narrowest 360x800 multi-token and compound word wrapping check",
      );

      const state = await installMobileOverhaulFixture(page, {
        shooterChallengeTokens: true,
      });
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      await page.goto("/reports/difficult-words");
      await expect(
        page.getByRole("button", { name: /khúc khuỷu quanh co/ }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);

      await page.goto("/entertainment/sentence-shooter");
      await page.getByRole("button", { name: /Thử thách/ }).click();
      await page.getByRole("button", { name: "Bắt đầu chơi" }).click();
      const tokenButtons = page
        .getByRole("group", { name: "Các từ để ghép" })
        .getByRole("button");
      await expect(tokenButtons).toHaveCount(12);
      await assertNoHorizontalOverflow(page);

      assertZeroRuntimeErrors(state);
    });

    test("640x960 and 720x900 gap viewports enforce <768px breakpoint parity on /reports, /difficult-words, and /reading-management", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "gap-640x960" && bucket !== "gap-720x900",
        "Targets 640-767px dead-zone viewports",
      );

      const state = await installMobileOverhaulFixture(page);

      // /reports: desktop ChildSelector hidden <768px, header switcher visible
      await page.goto("/reports");
      await expect(
        page.getByLabel("Chọn hồ sơ bé để xem dữ liệu"),
      ).toBeHidden();
      await expect(
        page.getByRole("button", {
          name: /Bé đang chọn: .*, bấm để đổi|Đổi nhanh bé/,
        }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);

      // /reports/difficult-words: mobile filter pills visible <768px, select hidden
      await page.goto("/reports/difficult-words");
      await expect(
        page.getByRole("group", { name: "Lọc nhanh theo trạng thái luyện" }),
      ).toBeVisible();
      await expect(page.getByLabel("Lọc theo trạng thái luyện")).toBeHidden();
      await assertNoHorizontalOverflow(page);

      // /reading-management: mobile 4-tab switcher visible <768px
      await page.goto("/reading-management");
      await expect(
        page.getByRole("tablist", { name: "Mục quản lý đọc" }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);

      assertZeroRuntimeErrors(state);
    });

    test("503 error & retry resilience on /reports, sentence-shooter, and /help-support never leaks raw backend errors", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844",
        "Error resilience verified on mobile-390x844",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await selectChildViaUi(page, "Bé An");

      // /reports 503 -> retry -> 200
      state.reportsStatus = 503;
      await page.goto("/reports");
      await expect(page.getByText("Chưa tải được báo cáo")).toBeVisible();
      await assertNoRawBackendLeak(page);
      state.reportsStatus = 200;
      await page.getByRole("button", { name: "Thử lại" }).click();
      await expect(
        page.getByRole("heading", { level: 2, name: "Các dấu hiệu khi đọc" }),
      ).toBeVisible();

      // sentence-shooter books 503 -> retry -> 200, then shot 503 & result 503 -> retry
      state.shooterStatus = 503;
      await page.goto("/entertainment/sentence-shooter");
      await expect(
        page.getByText("Chưa tải được danh sách sách"),
      ).toBeVisible();
      await assertNoRawBackendLeak(page);
      state.shooterStatus = 200;
      await page.getByRole("button", { name: "Thử lại" }).click();
      await page.getByRole("button", { name: "Bắt đầu chơi" }).click();

      state.shooterShotStatus = 503;
      await page
        .getByRole("group", { name: "Các từ để ghép" })
        .getByRole("button", { name: "Bé", exact: true })
        .click();
      await assertNoRawBackendLeak(page);
      state.shooterShotStatus = 200;

      // /help-support 503 -> retry -> 200
      state.supportStatus = 503;
      await page.goto("/help-support");
      await page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await page.locator("#support-subject").fill("Kiểm tra lỗi 503");
      await page
        .locator("#support-message")
        .fill("Thử gửi khi SMTP tạm ngưng.");
      await page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await expect(
        page.getByText(/Hệ thống email hỗ trợ đang tạm thời không khả dụng/),
      ).toBeVisible();
      await assertNoRawBackendLeak(page);
      state.supportStatus = 200;
      await page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await expect(
        page.getByText(/Máy chủ email đã tiếp nhận phản hồi/),
      ).toBeVisible();

      assertZeroRuntimeErrors(state);
    });
  });

  test.describe("Tier 3: Cross-Feature Pairwise Interactions", () => {
    test("Child switching propagates cleanly across /reports -> /reports/difficult-words -> /sessions -> /reading-management", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Cross-route child switching verified on mobile and desktop",
      );

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/reports");
      await expect(
        page.getByRole("heading", { level: 1, name: "Tiến bộ của Bé An" }),
      ).toBeVisible();

      if (bucket === "mobile-390x844") {
        await selectChildViaUi(page, "Bé Bình");
      } else {
        await page
          .getByLabel("Chọn hồ sơ bé để xem dữ liệu")
          .selectOption(MOBILE_IDS.childBinh);
      }
      await expect(
        page.getByRole("heading", { level: 1, name: "Tiến bộ của Bé Bình" }),
      ).toBeVisible();

      await page.getByRole("link", { name: /Mở mục Từ cần luyện/ }).click();
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Từ cần luyện của Bé Bình",
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Luyện từ chuyến đi/ }),
      ).toBeVisible();

      await page.goto(`/sessions?childId=${MOBILE_IDS.childBinh}`);
      await expect(page.getByText(/Bé Bình/)).toBeVisible();

      await page.goto(`/reading-management?childId=${MOBILE_IDS.childBinh}`);
      await expect(
        page.getByRole("heading", { level: 1, name: "Quản lý đọc sách" }),
      ).toBeVisible();

      assertZeroRuntimeErrors(state);
    });

    test("Dynamic resize 640x960 <-> 768x1024 <-> 1024x768 toggles /reading-management & /difficult-words layouts", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "gap-640x960",
        "Breakpoint transition sequence driven from gap-640x960",
      );

      const state = await installMobileOverhaulFixture(page);

      await page.goto("/reading-management");
      const tablist = page.getByRole("tablist", { name: "Mục quản lý đọc" });
      await expect(tablist).toBeVisible();
      await page.setViewportSize({ width: 768, height: 1024 });
      await expect(tablist).toBeHidden();
      await assertNoHorizontalOverflow(page);
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(tablist).toBeHidden();
      await assertNoHorizontalOverflow(page);

      await page.setViewportSize({ width: 640, height: 960 });
      await page.goto("/reports/difficult-words");
      const pills = page.getByRole("group", {
        name: "Lọc nhanh theo trạng thái luyện",
      });
      const select = page.getByLabel("Lọc theo trạng thái luyện");
      await expect(pills).toBeVisible();
      await expect(select).toBeHidden();

      await page.setViewportSize({ width: 768, height: 1024 });
      await expect(pills).toBeHidden();
      await expect(select).toBeVisible();
      await assertNoHorizontalOverflow(page);

      assertZeroRuntimeErrors(state);
    });
  });

  test.describe("Tier 4: Real-World Application Journeys J2 & J3", () => {
    test("J2 (640x960): /reports -> /reports/difficult-words practice -> /reading-management plan/goal -> /children edit alias -> header switcher sync", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "gap-640x960", "Journey J2 runs at 640x960");

      const state = await installMobileOverhaulFixture(page);

      // 1. /reports -> open Từ cần luyện
      await page.goto("/reports");
      await expect(
        page.getByRole("heading", { level: 1, name: "Tiến bộ của Bé An" }),
      ).toBeVisible();
      await page.getByRole("link", { name: /Mở mục Từ cần luyện/ }).click();

      // 2. Difficult words practice
      await expect(page).toHaveURL(/\/reports\/difficult-words/);
      await page.getByRole("button", { name: /Luyện từ ngập ngừng/ }).click();
      await expect(
        page.getByRole("heading", { level: 2, name: "ngập ngừng" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Quay về danh sách" }).click();

      // 3. /reading-management add plan & goal
      await page
        .getByTestId("mobile-bottom-nav")
        .getByRole("button", { name: /Thêm/ })
        .click();
      await page
        .getByRole("dialog", { name: "Tính năng khác" })
        .getByRole("link", { name: /Quản lý đọc/ })
        .click();
      await expect(page).toHaveURL(/\/reading-management/);
      await page.getByRole("button", { name: "Thêm kế hoạch" }).click();
      await page.getByLabel("Tên kế hoạch").fill("Đọc 15 phút mỗi tối");
      await page.getByRole("button", { name: "Tạo kế hoạch tuần" }).click();
      await expect(page.getByText("Đọc 15 phút mỗi tối")).toBeVisible();

      await page
        .getByRole("tablist", { name: "Mục quản lý đọc" })
        .getByRole("tab", { name: /Mục tiêu/ })
        .click();
      await page.getByRole("button", { name: "Thêm mục tiêu" }).click();
      await page.getByRole("button", { name: "Tạo mục tiêu" }).click();

      // 4. /children edit Bé An alias -> verify header quick switcher syncs
      await page.goto(`/children/${MOBILE_IDS.childAn}`);
      await page.getByLabel("Tên gọi của bé").fill("Bé An VIP");
      await page.getByRole("button", { name: "Lưu thay đổi" }).click();
      await expect(
        page.getByText("Thay đổi của hồ sơ bé đã được lưu."),
      ).toBeVisible();

      await page.goto("/dashboard");
      await expect(
        page.getByRole("button", { name: "Bé An VIP, lớp 2" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Bé An VIP, lớp 2" }).click();
      await expect(
        page.getByRole("button", { name: /Bé đang chọn: Bé An VIP/ }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);

      assertZeroRuntimeErrors(state);
    });

    test("J3 (390x844): /entertainment -> 3-round /entertainment/sentence-shooter -> /entertainment/picture-description -> /karaoke/[songId] -> /dashboard", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "mobile-390x844", "Journey J3 runs at 390x844");

      const state = await installMobileOverhaulFixture(page);
      await page.goto("/dashboard");
      await page.getByRole("button", { name: "Bé An, lớp 2" }).click();

      // 1. /entertainment hub -> sentence-shooter
      await page.getByRole("button", { name: "Trò chơi và âm nhạc" }).click();
      await expect(page).toHaveURL(/\/entertainment$/);
      await page.getByRole("link", { name: /Bắt đầu chơi/ }).click();
      await page.getByRole("button", { name: "Bắt đầu chơi" }).click();

      for (let roundIdx = 1; roundIdx <= 3; roundIdx += 1) {
        const tokenGroup = page.getByRole("group", { name: "Các từ để ghép" });
        const expectedWords =
          roundIdx === 1
            ? ["Bé", "An", "đọc", "sách"]
            : ["Bé", "An", "đọc", `sách (${roundIdx})`];
        for (const word of expectedWords) {
          await tokenGroup
            .getByRole("button", {
              name: new RegExp(`^${word.replace(/[()]/g, "\\$&")}`),
            })
            .click();
        }
        if (roundIdx < 3) {
          await page.getByRole("button", { name: "Câu tiếp theo" }).click();
        } else {
          await page.getByRole("button", { name: "Xem kết quả" }).click();
        }
      }
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Giỏi quá, bé đã hoàn thành!",
        }),
      ).toBeVisible();
      await page.getByRole("link", { name: /Về khu Giải trí/ }).click();

      // 2. Picture description
      await page.getByRole("link", { name: /Chọn tranh/ }).click();
      await expect(page).toHaveURL(/\/entertainment\/picture-description$/);
      await page
        .getByRole("button", { name: "Khám phá tranh này" })
        .first()
        .click();
      await page
        .locator("#picture-description-input")
        .fill("Bé nhìn thấy khu vườn hoa rực rỡ ánh nắng.");
      await page
        .getByRole("button", { name: "Gửi cô giáo AI chấm bài" })
        .click();
      await expect(
        page.getByText("Bé kể chuyện thật sinh động và rõ ràng!"),
      ).toBeVisible();
      await page
        .getByRole("link", { name: /Khu vui học|Về khu Giải trí/ })
        .first()
        .click();

      // 3. Karaoke -> /dashboard
      await page.goto("/karaoke");
      await page.getByRole("link", { name: "Hát bài Bài hát của bé" }).click();
      await expect(page).toHaveURL(
        new RegExp(`/karaoke/${MOBILE_IDS.karaokeSongId}`),
      );
      await page.getByRole("link", { name: "Về thư viện bài hát" }).click();
      await expect(page).toHaveURL(/\/karaoke$/);
      await page.getByRole("link", { name: /Về Tổng quan/ }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      await assertNoHorizontalOverflow(page);

      assertZeroRuntimeErrors(state);
    });
  });
});
