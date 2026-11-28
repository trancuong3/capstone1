import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  assertCleanHarness,
  attachPageErrorCollector,
  defaultBooks,
  ids,
  installE2eSuiteFixture,
} from "./fixtures";
import {
  assertZeroHorizontalOverflow,
  waitForRouteSettled,
} from "./geometry-audit";

const SCREENSHOT_DIR = path.resolve(
  process.cwd(),
  "test-results",
  "e2e-suite-screenshots",
);

test.describe("Tier 4: Real-World End-to-End Scenarios & Visual Screenshot Audit", () => {
  test("Scenario 1: Parent Account, Profile Edit, Settings & Child Creation Setup", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page);
    const errors = attachPageErrorCollector(page);

    // 1. Update parent profile display name
    await page.goto("/profile");
    await page.getByRole("button", { name: "Chỉnh sửa hồ sơ" }).click();
    const nameInput = page.getByLabel("Họ và tên");
    await nameInput.fill("Nguyễn Minh Anh");
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    await expect(
      page.getByRole("heading", { name: "Nguyễn Minh Anh" }),
    ).toBeVisible();

    // 2. Verify notification settings
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Cài đặt tài khoản" }),
    ).toBeVisible();

    // 3. Create new child profile and select on dashboard
    await page.goto("/children/new");
    await page.getByLabel("Tên gọi của bé").fill("Bé Sóc");
    await page.getByLabel("Lớp của bé").selectOption("3");
    await page.getByRole("button", { name: "Lưu hồ sơ" }).click();
    await expect(page).toHaveURL(/\/children/);
    await expect(
      page.getByRole("heading", { name: "Hồ sơ của Bé Sóc" }),
    ).toBeVisible();

    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Bé Sóc, lớp 3" }).click();
    await expect(
      page.getByRole("button", { name: "Bé Sóc, lớp 3" }),
    ).toHaveAttribute("aria-pressed", "true");

    assertCleanHarness(state, errors);
  });

  test("Scenario 2: Child Book Discovery -> Reading Prep -> Unobstructed Reading -> Comprehension -> Finish", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto("/books");
    await page
      .getByRole("link", { name: `Đọc sách ${defaultBooks[0].title}` })
      .click();
    await expect(page).toHaveURL(new RegExp(`/books/${ids.book1}`));

    await page
      .getByRole("button", { name: /Chuẩn bị đọc|Bắt đầu đọc/ })
      .click();
    await expect(page).toHaveURL(/\/reading-preparation\?/);

    await page
      .getByRole("button", { name: /Kiểm tra và cấp quyền microphone/ })
      .click();
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
    await expect(page).toHaveURL(new RegExp(`/reading/${ids.session1}`));
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();

    // Tap word to listen sample, finish, answer comprehension
    await page.locator("[data-word-id]").first().click();
    await expect.poll(() => state.ttsRequests).toBeGreaterThanOrEqual(1);

    await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
    await page
      .getByRole("dialog", { name: "Bé muốn nghỉ hôm nay?" })
      .getByRole("button", { name: "Lưu và dừng" })
      .click();

    await expect(
      page.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Bé mèo/ }).click();
    await page.getByRole("button", { name: "Hoàn thành" }).click();
    await expect(
      page.getByRole("heading", {
        name: /Buổi đọc đã hoàn thành|Đã lưu tiến độ đọc/,
      }),
    ).toBeVisible();

    assertCleanHarness(state, errors);
  });

  test("Scenario 3: Reading Progress Report -> Difficult Words Practice -> Session History Drilldown", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      populatedSessionReports: true,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto("/reports");
    await expect(
      page.getByRole("heading", { name: /Tiến bộ của Bé An/ }),
    ).toBeVisible();
    await page.getByRole("link", { name: /Mở mục Từ cần luyện/ }).click();
    await expect(page).toHaveURL(/\/reports\/difficult-words/);

    await expect(
      page.getByRole("heading", { name: /Từ cần luyện của Bé An/ }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /Luyện cùng bé|mèo/ })
      .first()
      .click();
    // Assert the practice panel & PhonicsLessonCard genuinely opened (not pre-existing list text)
    await expect(page.locator("#practice-word-heading")).toHaveText("mèo");
    await expect(page.getByTestId("phonics-lesson-card")).toBeVisible();

    await page.goto("/sessions");
    await expect(
      page.getByRole("heading", { name: "Lịch sử đọc" }),
    ).toBeVisible();
    await expect(page.getByText(defaultBooks[0].title)).toBeVisible();

    // Drill down into session detail & standalone report
    await page.goto(`/sessions/${ids.session1}`);
    await expect(
      page.getByTestId("session-primary-reading-report"),
    ).toBeVisible();
    await page.goto(`/sessions/${ids.session1}/report`);
    await expect(page.getByTestId("standalone-primary-report")).toBeVisible();

    assertCleanHarness(state, errors);
  });

  test("Scenario 4: Parent Authoring & Planning (My Books CRUD + Reading Management Goals/Plans/Reminders)", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    // My Books CRUD
    await page.goto("/my-books");
    await expect(
      page.getByRole("heading", { name: "Truyện cổ tích gia đình" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Tạo sách riêng" }).click();
    const createForm = page.getByRole("form", { name: "Tạo sách riêng mới" });
    await createForm.getByLabel("Tên sách *").fill("Sách Gia Đình Mới");
    await createForm.getByRole("button", { name: "Lưu và thêm trang" }).click();
    await expect(page).toHaveURL(/\/my-books\/[0-9a-f-]+/i);
    await expect(
      page.getByRole("heading", { name: "Sách Gia Đình Mới" }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Xóa sách Sách Gia Đình Mới" })
      .click();
    await page.getByRole("button", { name: "Xác nhận xóa" }).click();
    await expect(page).toHaveURL(/\/my-books$/);
    await expect(
      page.getByRole("heading", { name: "Sách Gia Đình Mới" }),
    ).toHaveCount(0);

    // Reading Management goal creation & reminder toggle
    await page.goto("/reading-management");
    await page.getByRole("button", { name: "Thêm mục tiêu" }).click();
    await expect(
      page.getByRole("heading", { name: "Thiết lập mục tiêu" }),
    ).toBeVisible();
    await page.getByLabel("Mục tiêu").fill("35");
    await page.getByLabel("Chu kỳ").selectOption("WEEKLY");
    await page.getByRole("button", { name: "Tạo mục tiêu" }).click();
    const goalsRegion = page.getByRole("region", { name: "Mục tiêu đọc" });
    await expect(goalsRegion).toBeVisible();
    await expect(goalsRegion).toContainText("35 phút · mỗi tuần");

    const firstReminder = page.locator("[data-reminder-id]").first();
    await firstReminder.getByRole("checkbox").click();
    await expect(page.getByRole("status").first()).toBeVisible();

    assertCleanHarness(state, errors);
  });

  test("Scenario 5: Child Play & Learn (Entertainment Hub -> Memory Game, Picture Description, Sentence Shooter -> Karaoke)", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    // Hub -> Memory Game 5-stage flow
    await page.goto("/entertainment");
    await waitForRouteSettled(page);
    await expect(page.getByTestId("hub-active-child-badge")).toBeVisible();
    await page.getByRole("link", { name: /Khám phá trí nhớ/i }).click();
    await expect(page).toHaveURL(/\/entertainment\/memory-game/);
    await page.getByTestId("start-memory-game-btn").click();
    await expect(page.getByTestId("observe-stage")).toBeVisible();
    await page.getByTestId("finish-observe-btn").click();
    await page
      .getByTestId("recall-textarea")
      .fill("Chú mèo mướp nằm ở góc dưới trái.");
    await page.getByTestId("submit-recall-btn").click();
    await expect(page.getByTestId("reveal-stage")).toBeVisible();
    await page.getByTestId("go-creative-stage-btn").click();
    await page
      .getByTestId("creative-textarea")
      .fill("Chú mèo mướp vui chơi cùng hoa hướng dương.");
    await page.getByTestId("submit-creative-btn").click();
    await expect(page.getByTestId("summary-stage")).toBeVisible();

    // Picture Description evaluate
    await page.goto("/entertainment/picture-description");
    await page
      .getByRole("button", { name: "Khám phá tranh này" })
      .first()
      .click();
    await page
      .locator("#picture-description-input")
      .fill("Chú mèo mướp đang nằm sưởi nắng.");
    await page.getByRole("button", { name: "Gửi cô giáo AI chấm bài" }).click();
    await expect(
      page.getByText("Tuyệt vời! Bé quan sát rất tinh tế!"),
    ).toBeVisible();

    // Sentence Shooter complete round
    await page.goto("/entertainment/sentence-shooter");
    await page
      .getByRole("button", { name: new RegExp(defaultBooks[0].title) })
      .click();
    await page.getByRole("button", { name: "Bắt đầu chơi" }).click();
    const wordBank = page.getByRole("group", { name: "Các từ để ghép" });
    await wordBank.getByRole("button", { name: "Bé", exact: true }).click();
    await wordBank.getByRole("button", { name: "đọc", exact: true }).click();
    await wordBank.getByRole("button", { name: "sách.", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /Giỏi quá, bé đã hoàn thành!/ }),
    ).toBeVisible();

    // Karaoke Library -> Player
    await page.goto("/karaoke");
    await page.getByRole("link", { name: "Hát bài Ngôi sao nhỏ" }).click();
    await expect(page).toHaveURL(new RegExp(`/karaoke/${ids.song1}`));
    await expect(
      page.getByRole("button", { name: "Bắt đầu hát", exact: true }),
    ).toBeEnabled();

    assertCleanHarness(state, errors);
  });

  test("Scenario 6a: Cross-Viewport Visual Screenshot Audit (Auth, Family, Books & Reading routes)", async ({
    page,
  }, testInfo) => {
    test.slow();
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      populatedSessionReports: true,
    });
    const errors = attachPageErrorCollector(page);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const auditRoutes = [
      { slug: "login", url: "/login" },
      { slug: "register", url: "/register" },
      { slug: "forgot-password", url: "/forgot-password" },
      { slug: "reset-password", url: "/reset-password" },
      { slug: "dashboard", url: "/dashboard" },
      { slug: "children", url: "/children" },
      { slug: "children-new", url: "/children/new" },
      { slug: "children-detail", url: `/children/${ids.child1}` },
      { slug: "profile", url: "/profile" },
      { slug: "settings", url: "/settings" },
      { slug: "help-support", url: "/help-support" },
      { slug: "books", url: "/books" },
      { slug: "book-detail", url: `/books/${ids.book1}` },
      {
        slug: "reading-preparation",
        url: `/reading-preparation?bookId=${ids.book1}&pageId=${ids.page1}&endPageId=${ids.page2}`,
      },
      { slug: "reading", url: `/reading/${ids.session1}?state=reading` },
    ];

    for (const item of auditRoutes) {
      await page.goto(item.url);
      await waitForRouteSettled(page);
      await page.evaluate(() => document.fonts?.ready);
      await assertZeroHorizontalOverflow(
        page,
        `audit-${testInfo.project.name}-${item.slug}`,
      );
      await page.screenshot({
        path: path.join(
          SCREENSHOT_DIR,
          `${item.slug}-${testInfo.project.name}.png`,
        ),
        fullPage: true,
      });
    }

    assertCleanHarness(state, errors);
  });

  test("Scenario 6b: Cross-Viewport Visual Screenshot Audit (Reports, Management, Entertainment & Karaoke routes)", async ({
    page,
  }, testInfo) => {
    test.slow();
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      populatedSessionReports: true,
    });
    const errors = attachPageErrorCollector(page);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const auditRoutes = [
      { slug: "reports", url: "/reports" },
      { slug: "difficult-words", url: "/reports/difficult-words" },
      { slug: "book-reports", url: "/book-reports" },
      { slug: "sessions", url: "/sessions" },
      { slug: "session-detail", url: `/sessions/${ids.session1}` },
      { slug: "session-report", url: `/sessions/${ids.session1}/report` },
      { slug: "my-books", url: "/my-books" },
      { slug: "my-book-detail", url: `/my-books/${ids.privateBook1}` },
      { slug: "book-scanner", url: "/book-scanner" },
      { slug: "studio-tasks", url: "/studio/tasks" },
      { slug: "reading-management", url: "/reading-management" },
      { slug: "entertainment", url: "/entertainment" },
      { slug: "memory-game", url: "/entertainment/memory-game" },
      {
        slug: "picture-description",
        url: "/entertainment/picture-description",
      },
      { slug: "sentence-shooter", url: "/entertainment/sentence-shooter" },
      { slug: "karaoke", url: "/karaoke" },
      { slug: "karaoke-player", url: `/karaoke/${ids.song1}` },
    ];

    for (const item of auditRoutes) {
      await page.goto(item.url);
      await waitForRouteSettled(page);
      await page.evaluate(() => document.fonts?.ready);
      await assertZeroHorizontalOverflow(
        page,
        `audit-${testInfo.project.name}-${item.slug}`,
      );
      await page.screenshot({
        path: path.join(
          SCREENSHOT_DIR,
          `${item.slug}-${testInfo.project.name}.png`,
        ),
        fullPage: true,
      });
    }

    assertCleanHarness(state, errors);
  });
});
