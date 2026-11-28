import { expect, test } from "@playwright/test";
import {
  assertCleanHarness,
  attachPageErrorCollector,
  defaultBooks,
  defaultChildren,
  ids,
  installE2eSuiteFixture,
} from "./fixtures";
import { assertResponsiveLayoutSeparation } from "./geometry-audit";

test.describe("Tier 3: Cross-Feature Journeys & Responsive Separation", () => {
  test("Pairwise journey: Dashboard child select -> /books -> /books/[bookId] -> /reading-preparation -> /reading/[sessionId] -> comprehension -> /reports", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page);
    const errors = attachPageErrorCollector(page);

    // 1. Select child on Dashboard
    await page.goto("/dashboard");
    await page
      .getByRole("button", {
        name: `${defaultChildren[0].alias}, lớp ${defaultChildren[0].grade}`,
      })
      .click();
    await page.getByRole("button", { name: "Chọn sách", exact: true }).click();
    await expect(page).toHaveURL(/\/books$/);

    // 2. Open book detail
    await page
      .getByRole("link", { name: `Đọc sách ${defaultBooks[0].title}` })
      .click();
    await expect(page).toHaveURL(new RegExp(`/books/${ids.book1}`));

    // 3. Preparation -> check mic -> start session
    await page
      .getByRole("button", { name: /Chuẩn bị đọc|Bắt đầu đọc/ })
      .click();
    await expect(page).toHaveURL(/\/reading-preparation\?/);
    await page
      .getByRole("button", { name: /Kiểm tra và cấp quyền microphone/ })
      .click();
    await expect(page.getByText("Microphone đã sẵn sàng")).toBeVisible();
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
    await expect(page).toHaveURL(new RegExp(`/reading/${ids.session1}`));
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();

    // 4. Finish reading -> answer comprehension -> view reports
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

    await page.goto("/reports");
    await expect(
      page.getByRole("heading", { name: /Tiến bộ của Bé An/ }),
    ).toBeVisible();

    assertCleanHarness(state, errors);
  });

  test("F8: Live STT <-> TTS sync (Bé đọc -> emitTranscript -> word highlight -> Nghe mẫu -> EchoGuard settle -> emitTranscript -> /compare + comprehension)", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      disableBrowserSpeechRecognition: false,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    await expect(
      page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    ).toBeVisible();

    // 1. Start listening via Bé đọc
    await page
      .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
      .click();
    await expect(
      page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (
              window as {
                __e2eSpeechControl?: { isActive(): boolean };
              }
            ).__e2eSpeechControl?.isActive(),
          ),
        ),
      )
      .toBe(true);

    // 2. Emit partial transcript "Bé mèo" -> verify word tokens transition to data-reading-state="correct"
    const firstEmitted = await page.evaluate(() =>
      (
        window as {
          __e2eSpeechControl?: {
            emitTranscript(text: string, isFinal?: boolean): boolean;
          };
        }
      ).__e2eSpeechControl?.emitTranscript("Bé mèo", true),
    );
    expect(firstEmitted).toBe(true);
    await expect(
      page.locator('[data-word-id="90000000-0000-4000-8000-000000000001"]'),
    ).toHaveAttribute("data-reading-state", "correct");
    await expect(
      page.locator('[data-word-id="90000000-0000-4000-8000-000000000002"]'),
    ).toHaveAttribute("data-reading-state", "correct");

    // 3. Interrupt with sample TTS ("Nghe đọc mẫu cả trang"), verify TTS plays and mic cleanly resumes after HAL settle
    await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
    await expect.poll(() => state.ttsRequests).toBeGreaterThanOrEqual(1);
    await expect(
      page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(
            (
              window as {
                __e2eSpeechControl?: { isActive(): boolean };
              }
            ).__e2eSpeechControl?.isActive(),
          ),
        ),
      )
      .toBe(true);

    // 4. Wait past EchoGuard tailMs (1500ms) and emit remaining words "đọc sách"
    await page.waitForTimeout(1600);
    const secondEmitted = await page.evaluate(() =>
      (
        window as {
          __e2eSpeechControl?: {
            emitTranscript(text: string, isFinal?: boolean): boolean;
          };
        }
      ).__e2eSpeechControl?.emitTranscript("đọc sách", true),
    );
    expect(secondEmitted).toBe(true);

    // Wait for page-turn / page 2 transition if autoAdvance fired cleanly
    await expect(
      page.getByRole("button", { name: "Kết thúc buổi đọc" }),
    ).toBeEnabled();

    // 5. Finish reading -> confirm /compare -> comprehension -> complete
    await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
    await page
      .getByRole("dialog", { name: "Bé muốn nghỉ hôm nay?" })
      .getByRole("button", { name: "Lưu và dừng" })
      .click();
    await expect
      .poll(() =>
        state.requests.some((req) =>
          req.startsWith(`POST /reading/sessions/${ids.session1}/compare`),
        ),
      )
      .toBe(true);
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

  test("F8: Restored practice-state hydrates saved word mastery & retry prompt cleanly", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      restoredPracticeState: true,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    await expect
      .poll(() =>
        state.requests.some((req) =>
          req.startsWith(
            `GET /reading/sessions/${ids.session1}/practice-state`,
          ),
        ),
      )
      .toBe(true);

    const retryDialog = page.getByRole("dialog", {
      name: "Mình đọc lại những từ này nhé?",
    });
    await expect(retryDialog).toBeVisible();
    await retryDialog.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
    await expect(retryDialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Hoàn thành đọc lại" }),
    ).toBeVisible();

    assertCleanHarness(state, errors);
  });

  test("Reading controls, voice settings modal, sample TTS, and STT mic start/pause state transitions", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
      disableBrowserSpeechRecognition: true,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto(`/reading/${ids.session1}?state=reading`);
    await expect(
      page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    ).toBeVisible();

    // Open voice settings dialog -> choose region/voice -> close cleanly
    await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
    const voiceDialog = page.getByRole("dialog", { name: "Giọng đọc mẫu" });
    await expect(voiceDialog).toBeVisible();
    await voiceDialog
      .getByRole("button", { name: "Nhanh", exact: true })
      .click();
    await voiceDialog.getByRole("button", { name: "Đóng hộp thoại" }).click();
    await expect(voiceDialog).toHaveCount(0);

    // Start listening with mic -> pause modal -> resume reading
    await page
      .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
      .click();
    await expect(
      page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Tạm dừng buổi đọc" }).click();
    const pauseDialog = page.getByRole("dialog", {
      name: "Bé đang nghỉ một chút",
    });
    await expect(pauseDialog).toBeVisible();
    await pauseDialog.getByRole("button", { name: "Đọc tiếp" }).click();
    await expect(pauseDialog).toHaveCount(0);

    // Play sample TTS
    await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
    await expect.poll(() => state.ttsRequests).toBeGreaterThanOrEqual(1);

    assertCleanHarness(state, errors);
  });

  test("Responsive layout separation (< 768px mobile bottom nav & 'Tính năng khác' sheet vs >= 768px desktop nav)", async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    for (const routePath of ["/dashboard", "/reports", "/my-books"]) {
      await page.goto(routePath);
      await page.waitForLoadState("networkidle");
      await assertResponsiveLayoutSeparation(
        page,
        `${testInfo.project.name}:${routePath}`,
        isMobile,
      );
    }

    if (isMobile) {
      const mobileBottomNav = page.getByTestId("mobile-bottom-nav");
      await mobileBottomNav.getByRole("button", { name: /Thêm/ }).click();
      const sheet = page.getByRole("dialog", { name: "Tính năng khác" });
      await expect(sheet).toBeVisible();
      await sheet.getByRole("link", { name: /Giải trí/ }).click();
      await expect(page).toHaveURL(/\/entertainment$/);
    } else {
      const entertainmentLink = page
        .locator(".parent-nav-links")
        .getByRole("link", { name: "Giải trí" });
      await expect(entertainmentLink).toBeVisible();
      await Promise.all([
        page.waitForURL(/\/entertainment$/),
        entertainmentLink.click(),
      ]);
    }

    assertCleanHarness(state, errors);
  });

  test("Cross-feature child switch updates /reading-management and /entertainment recommendations", async ({
    page,
  }) => {
    const state = await installE2eSuiteFixture(page, {
      seedChildId: ids.child1,
    });
    const errors = attachPageErrorCollector(page);

    await page.goto("/reading-management");
    await expect(
      page.getByRole("region", { name: "Kế hoạch đọc trong tuần" }),
    ).toContainText("Đọc truyện buổi tối");

    await page.getByLabel("Hồ sơ bé").selectOption(ids.child2);
    await expect(page.getByText("Chưa có lịch nhắc nào.")).toBeVisible();

    await page.goto("/entertainment");
    await expect(page.getByTestId("hub-child-selector")).toBeVisible();
    await page.getByTestId("hub-child-selector").selectOption(ids.child2);
    await expect(page.getByText(/Chào Bé Bông!/)).toBeVisible();

    assertCleanHarness(state, errors);
  });
});
