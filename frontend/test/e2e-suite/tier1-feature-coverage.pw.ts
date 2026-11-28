import { expect, test } from "@playwright/test";
import {
  assertCleanHarness,
  attachPageErrorCollector,
  defaultBooks,
  defaultChildren,
  ids,
  installE2eSuiteFixture,
  seedSelectedChild,
} from "./fixtures";

test.describe("Tier 1: Feature Coverage (All Core & Secondary Routes)", () => {
  test("F3: Auth routes (/login, /register, /forgot-password, /reset-password) and root redirect (/)", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page);
    const errors = attachPageErrorCollector(page);

    // Root "/" redirects to /login; authenticated user can visit /dashboard directly
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: "Đăng nhập ViRead" }),
    ).toBeVisible();

    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Góc đọc gia đình" }),
    ).toBeVisible();

    // /login renders primary controls and links
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Đăng nhập ViRead" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Đăng nhập", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Quên mật khẩu?" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tiếp tục với Google" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tiếp tục với Facebook" }),
    ).toBeVisible();

    // /register renders heading, form fields, and submit action
    await page.goto("/register");
    await expect(
      page.getByRole("heading", { name: "Tạo tài khoản phụ huynh" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Đăng ký|Tạo tài khoản/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Đã có tài khoản? Đăng nhập" }),
    ).toBeVisible();

    // /forgot-password submit triggers Supabase recover mock
    await page.goto("/forgot-password");
    await expect(
      page.getByRole("heading", { name: "Khôi phục mật khẩu" }),
    ).toBeVisible();
    await page.getByLabel("Email của ba mẹ").fill("parent@example.test");
    await page.getByRole("button", { name: "Gửi hướng dẫn" }).click();
    await expect(
      page.getByRole("heading", { name: "Kiểm tra email nhé" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Về đăng nhập" }),
    ).toBeVisible();

    // /reset-password states (invalid-token default, expired-token, success)
    await page.goto("/reset-password");
    await expect(
      page.getByRole("heading", { name: "Liên kết không hợp lệ" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Yêu cầu hướng dẫn mới" }),
    ).toBeVisible();

    await page.goto("/reset-password?state=expired-token");
    await expect(
      page.getByRole("heading", { name: "Liên kết đã hết hạn" }),
    ).toBeVisible();

    await page.goto("/reset-password?state=success");
    await expect(
      page.getByRole("heading", { name: "Đã đổi mật khẩu" }),
    ).toBeVisible();

    assertCleanHarness(state, errors);
  });

  test("F4 & F5: Dashboard child selection, /children, /children/[childId], /profile, /settings, /help-support", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page);
    const errors = attachPageErrorCollector(page);

    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Góc đọc gia đình" }),
    ).toBeVisible();
    const childBtn = page.getByRole("button", {
      name: `${defaultChildren[0].alias}, lớp ${defaultChildren[0].grade}`,
    });
    await expect(childBtn).toBeVisible();
    await childBtn.click();
    await expect(childBtn).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "Chọn sách", exact: true }),
    ).toBeEnabled();

    // /children
    await page.goto("/children");
    await expect(
      page.getByRole("heading", { name: "Hồ sơ của các bé" }),
    ).toBeVisible();
    await expect(
      page.getByText(defaultChildren[0].alias, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Tạo hồ sơ bé" }),
    ).toBeVisible();

    // /children/[childId] view & update
    await page.goto(`/children/${ids.child1}`);
    await expect(
      page.getByRole("heading", { name: "Hồ sơ của Bé An" }),
    ).toBeVisible();
    await page.getByLabel("Tên gọi của bé").fill("Bé An Mới");
    await page.getByRole("button", { name: "Lưu thay đổi" }).click();
    await expect(
      page.getByText("Thay đổi của hồ sơ bé đã được lưu."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Hồ sơ của Bé An Mới" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Chọn sách cho Bé An Mới" }),
    ).toBeVisible();

    // /profile
    await page.goto("/profile");
    await expect(
      page.getByRole("heading", { name: "Thông tin tài khoản" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Ba mẹ ViRead" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Chỉnh sửa hồ sơ" }),
    ).toBeVisible();

    // /settings
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Cài đặt tài khoản" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Đổi mật khẩu" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Ngôn ngữ hiển thị" }),
    ).toBeVisible();

    // /help-support FAQ + feedback submit
    await page.goto("/help-support");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { name: "Trợ giúp & hỗ trợ" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Câu hỏi thường gặp" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Gửi phản hồi" }).click();
    await expect(
      page.getByRole("heading", { name: "Gửi phản hồi" }),
    ).toBeVisible();
    await page.getByLabel("Tiêu đề").fill("Hỗ trợ giọng đọc mẫu");
    await page
      .getByLabel("Nội dung")
      .fill("Ba mẹ muốn hỏi cách chọn giọng đọc miền Nam cho bé.");
    await page.getByRole("button", { name: "Gửi phản hồi" }).click();
    await expect(
      page.getByText(/Máy chủ email đã tiếp nhận phản hồi/),
    ).toBeVisible();

    assertCleanHarness(state, errors);
  });

  test("F10 & F7: Book Library (/books) favorite toggle, Book Detail (/books/[bookId]), and Reading Prep (/reading-preparation)", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto("/books");
    await expect(
      page.getByRole("heading", { name: defaultBooks[0].title }),
    ).toBeVisible();

    // Actually click favorite collection toggle on book card (exercises DELETE then PUT /reading-management/collections/:bookId)
    const removeFavBtn = page.getByRole("button", {
      name: `Bỏ ${defaultBooks[0].title} yêu thích`,
    });
    await expect(removeFavBtn).toHaveAttribute("aria-pressed", "true");
    await removeFavBtn.click();
    const addFavBtn = page.getByRole("button", {
      name: `Thêm ${defaultBooks[0].title} yêu thích`,
    });
    await expect(addFavBtn).toHaveAttribute("aria-pressed", "false");
    await addFavBtn.click();
    await expect(removeFavBtn).toHaveAttribute("aria-pressed", "true");

    // Filter search
    await page
      .getByPlaceholder("Tìm theo tên sách hoặc tác giả")
      .fill("Khu vườn");
    await expect(
      page.getByRole("heading", { name: defaultBooks[1].title }),
    ).toBeVisible();
    await page.getByPlaceholder("Tìm theo tên sách hoặc tác giả").fill("");

    // Navigate to Book Detail
    await page
      .getByRole("link", { name: `Đọc sách ${defaultBooks[0].title}` })
      .click();
    await expect(page).toHaveURL(new RegExp(`/books/${ids.book1}`));
    await expect(
      page.getByRole("heading", { name: defaultBooks[0].title }),
    ).toBeVisible();
    await expect(page.getByText(/Phạm vi đọc: Trang 1–2/)).toBeVisible();

    // Enter Reading Preparation
    await page
      .getByRole("button", { name: /Chuẩn bị đọc|Bắt đầu đọc/ })
      .click();
    await expect(page).toHaveURL(/\/reading-preparation\?/);
    await expect(
      page.getByRole("heading", { name: "Chuẩn bị đọc sách" }),
    ).toBeVisible();

    // Verify mic & start reading session (PascalCase POST /reading/sessions)
    const verifyMicBtn = page.getByRole("button", {
      name: /Kiểm tra và cấp quyền microphone/,
    });
    await verifyMicBtn.click();
    await expect(page.getByText("Microphone đã sẵn sàng")).toBeVisible();

    const startBtn = page.getByRole("button", { name: "Bắt đầu đọc" });
    await expect(startBtn).toBeEnabled();
    await startBtn.click();
    await expect(page).toHaveURL(new RegExp(`/reading/${ids.session1}`));

    assertCleanHarness(state, errors);
  });

  test("F6, F8, F9: Child Reading Canvas, Voice Settings, Sample TTS, and Comprehension Flow", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    await expect(
      page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    ).toBeVisible();
    await expect(page.locator("[data-word-id]").first()).toBeVisible();

    // Voice Settings modal open -> select voice/speed -> close
    await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
    const voiceDialog = page.getByRole("dialog", { name: "Giọng đọc mẫu" });
    await expect(voiceDialog).toBeVisible();
    await voiceDialog.getByRole("button", { name: "Chậm" }).click();
    await page.keyboard.press("Escape");
    await expect(voiceDialog).toHaveCount(0);

    // Sample page audio playback request, then stop playback so Finish control is enabled
    await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
    await expect.poll(() => state.ttsRequests).toBeGreaterThanOrEqual(1);
    const stopSampleBtn = page.getByRole("button", { name: "Dừng đọc mẫu" });
    if (await stopSampleBtn.isVisible()) {
      await stopSampleBtn.click();
    }
    const finishBtn = page.getByRole("button", { name: "Kết thúc buổi đọc" });
    await expect(finishBtn).toBeEnabled();

    // Finish reading -> confirm -> comprehension question -> answer -> session complete
    await finishBtn.click();
    const finishDialog = page.getByRole("dialog", {
      name: "Bé muốn nghỉ hôm nay?",
    });
    await expect(finishDialog).toBeVisible();
    await finishDialog.getByRole("button", { name: "Lưu và dừng" }).click();

    await expect(
      page.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Bé mèo/ }).click();
    await expect(page.getByText(/Đúng rồi|Chính xác/)).toBeVisible();
    await page.getByRole("button", { name: "Hoàn thành" }).click();

    await expect(
      page.getByRole("heading", {
        name: /Buổi đọc đã hoàn thành|Đã lưu tiến độ đọc/,
      }),
    ).toBeVisible();

    assertCleanHarness(state, errors);
  });

  test("F12: Reports (/reports), Difficult Words (/reports/difficult-words), Book Reports (/book-reports), Sessions (/sessions, /sessions/[id], /sessions/[id]/report)", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      populatedSessionReports: true,
    });
    const errors = attachPageErrorCollector(page);

    // /reports
    await page.goto("/reports");
    await expect(
      page.getByRole("heading", { name: /Tiến bộ của Bé An/ }),
    ).toBeVisible();
    await expect(page.getByText("4 buổi").first()).toBeVisible();
    await expect(
      page.getByText("Bé tiến bộ đều qua từng buổi đọc"),
    ).toBeVisible();

    // /reports/difficult-words
    await page.goto("/reports/difficult-words");
    await expect(
      page.getByRole("heading", { name: /Từ cần luyện của Bé An/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /mèo/ }).first(),
    ).toBeVisible();

    // /book-reports
    await page.goto("/book-reports");
    await expect(
      page.getByRole("heading", { name: "Báo cáo chất lượng sách" }),
    ).toBeVisible();
    await expect(page.getByText("Chưa có báo cáo nào")).toBeVisible();
    await page.getByRole("button", { name: "Tải lại" }).click();

    // /sessions
    await page.goto("/sessions");
    await expect(
      page.getByRole("heading", { name: "Lịch sử đọc" }),
    ).toBeVisible();
    await expect(page.getByText(defaultBooks[0].title)).toBeVisible();

    // /sessions/[sessionId] with populated ReadingAssessmentSummary & ReadingReport
    await page.goto(`/sessions/${ids.session1}`);
    await expect(
      page.getByRole("heading", { name: "Buổi đọc đã hoàn thành" }),
    ).toBeVisible();
    await expect(
      page.getByTestId("session-primary-reading-report"),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Báo cáo đọc" }),
    ).toBeVisible();

    // /sessions/[sessionId]/report standalone report view
    await page.goto(`/sessions/${ids.session1}/report`);
    await expect(
      page.getByRole("heading", { name: "Báo cáo đọc" }),
    ).toBeVisible();
    await expect(page.getByTestId("standalone-session-report")).toBeVisible();
    await expect(page.getByTestId("standalone-primary-report")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Đánh giá lượt đầu đã lưu" }),
    ).toBeVisible();
    await expect(
      page.getByText("Kết quả lượt đầu được giữ nguyên"),
    ).toBeVisible();

    assertCleanHarness(state, errors);
  });

  test("F11: My Books (/my-books, /my-books/[bookId]), Book Scanner (/book-scanner), Studio Tasks (/studio/tasks), and Reading Management (/reading-management)", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    // /my-books
    await page.goto("/my-books");
    await expect(
      page.getByRole("heading", { name: "Sách của tôi" }),
    ).toBeVisible();
    await expect(page.getByText("Truyện cổ tích gia đình")).toBeVisible();

    // Create private book
    await page.getByRole("button", { name: "Tạo sách riêng" }).click();
    const createForm = page.getByRole("form", { name: "Tạo sách riêng mới" });
    await expect(createForm).toBeVisible();
    await createForm.getByLabel("Tên sách *").fill("Chú thỏ thông minh");
    await createForm.getByRole("button", { name: "Lưu và thêm trang" }).click();
    await expect(
      page.getByRole("heading", { name: "Chú thỏ thông minh" }),
    ).toBeVisible();

    // /my-books/[bookId]
    await page.goto(`/my-books/${ids.privateBook1}`);
    await expect(
      page.getByRole("heading", { name: "Truyện cổ tích gia đình" }),
    ).toBeVisible();
    await expect(
      page.getByRole("form", {
        name: "Tải ảnh trang hoặc tài liệu vào sách riêng",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Các trang đang kiểm tra & duyệt/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Các trang đã thêm vào sách đọc/ }),
    ).toBeVisible();

    // /book-scanner
    await page.goto("/book-scanner");
    await expect(
      page.getByRole("heading", { name: "Đưa trang sách vào khung camera" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Bật camera để quét" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Chọn ảnh trang sách (OCR)" }),
    ).toBeVisible();

    // /studio/tasks
    await page.goto("/studio/tasks");
    await expect(page.getByTestId("studio-tasks-page")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Trung tâm tác vụ AI" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Máy xử lý AI / OCR đang trực tuyến và sẵn sàng nhận tác vụ.",
      ),
    ).toBeVisible();
    const studioRefreshBtn = page.getByRole("button", { name: "Làm mới" });
    await expect(studioRefreshBtn).toBeEnabled();
    await studioRefreshBtn.click();

    // /reading-management
    await page.goto("/reading-management");
    await expect(
      page.getByRole("heading", { name: /Quản lý đọc/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Kế hoạch đọc trong tuần" }),
    ).toContainText("Đọc truyện buổi tối");
    await expect(
      page.getByRole("region", { name: "Mục tiêu đọc" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Lịch nhắc đọc" }),
    ).toContainText("19:30");

    assertCleanHarness(state, errors);
  });

  test("F13: Entertainment Hub, Subgames (Memory, Picture Description, Sentence Shooter) & Karaoke", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);
    await seedSelectedChild(page, ids.child1);

    // Entertainment Hub
    await page.goto("/entertainment");
    await expect(
      page.getByRole("heading", { name: "Giải trí", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("hub-child-selector")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Xạ thủ ghép câu" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Kể chuyện qua tranh" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Bé nhớ được gì?" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Hát vui cùng bé" }),
    ).toBeVisible();

    // Memory Game
    await page.goto("/entertainment/memory-game");
    await expect(
      page.getByRole("heading", { name: "Bé nhớ được gì?" }),
    ).toBeVisible();
    await page.getByTestId("start-memory-game-btn").click();
    await expect(page.getByTestId("observe-stage")).toBeVisible();
    await page.getByTestId("finish-observe-btn").click();
    await expect(page.getByTestId("recall-stage")).toBeVisible();

    // Picture Description
    await page.goto("/entertainment/picture-description");
    await expect(
      page.getByRole("tab", { name: "Tranh chủ đề ViRead" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Khám phá tranh này" })
      .first()
      .click();
    await expect(page.getByTestId("teaching-mode-pills")).toBeVisible();

    // Sentence Shooter
    await page.goto("/entertainment/sentence-shooter");
    await page
      .getByRole("button", { name: new RegExp(defaultBooks[0].title) })
      .click();
    await page.getByRole("button", { name: "Bắt đầu chơi" }).click();
    await expect(page.getByTestId("difficult-word-badge")).toBeVisible();

    // Karaoke Library & Player
    await page.goto("/karaoke");
    await expect(
      page.getByRole("heading", { name: /Hát vui cùng Bé An/ }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Hát bài Ngôi sao nhỏ" }).click();
    await expect(page).toHaveURL(new RegExp(`/karaoke/${ids.song1}`));
    await expect(
      page.getByRole("slider", { name: "Vị trí phát" }),
    ).toBeVisible();
    await expect(page.getByTestId("karaoke-active-line")).toBeVisible();

    assertCleanHarness(state, errors);
  });
});
