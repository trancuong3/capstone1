import { expect, test } from "@playwright/test";

import { assertNoRawErrorLeak, IDS, installMockApi } from "./fixtures/mock-api";

test.describe("Tier 4: Realistic End-to-End Parent & Child Workloads (S1-S6)", () => {
  test("S1: cold-start login -> child selection -> catalog cover browse -> reading session (voice/phonics/comprehension) -> completion", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, {
      faults: [
        {
          method: "GET",
          path: "/profiles/dashboard-summary",
          sequence: [
            {
              status: 502,
              contentType: "text/html",
              body: "<html>Render cold start 502</html>",
            },
          ],
        },
        {
          method: "GET",
          path: "/books/catalog",
          sequence: [
            {
              status: 520,
              contentType: "text/html",
              body: "<html>Cloudflare edge 520</html>",
            },
          ],
        },
      ],
    });

    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Góc đọc gia đình" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Bé An, lớp 1" }).click();

    await page.goto("/books");
    await expect(
      page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
    ).toBeVisible();
    const coverImg = page.locator("article.catalog-volume img").first();
    await expect(coverImg).toBeVisible();

    await page.goto(`/books/${IDS.book1}`);
    await expect(page.getByAltText("Ảnh xem trước trang 1")).toBeVisible();

    // Active reading session with lazy voice + phonics panels
    await page.goto(`/reading/${IDS.session1}?state=ready`);
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
    await page.getByRole("button", { name: "Giọng đọc" }).click();
    await expect(
      page.getByRole("dialog", { name: "Giọng đọc mẫu" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Nghe đánh vần" }).click();
    await expect(
      page
        .getByTestId("phonics-lesson-card")
        .or(page.getByTestId("phonics-lesson-unsupported")),
    ).toBeVisible();

    // Comprehension question interaction
    await page.goto(`/reading/${IDS.session1}?state=question`);
    await expect(
      page.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /B Bên cửa sổ/ }).click();
    await expect(page.getByText("Đúng rồi. Bé nhớ rất tốt.")).toBeVisible();

    // Completion screen
    await page.goto(`/reading/${IDS.session1}?state=complete`);
    await expect(
      page.getByRole("heading", { name: "Buổi đọc đã hoàn thành" }),
    ).toBeVisible();
    tracker.assertCleanHealth("S1", { expectedHttpStatuses: [502, 520] });
  });

  test("S2: returning parent experiences transient 520/524 during dashboard + child switch + parallel progress report drilldown", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, {
      selectedChildId: null,
      difficultWordCount: 10,
      faults: [
        {
          method: "GET",
          path: "/profiles/dashboard-summary",
          sequence: [
            {
              status: 524,
              contentType: "text/html",
              body: "<html>Cloudflare 524 Origin Time-out</html>",
            },
          ],
        },
        {
          method: "GET",
          path: `/system/progress/${IDS.childB}/periods`,
          sequence: [
            {
              status: 520,
              contentType: "text/html",
              body: "<html>Cloudflare 520</html>",
            },
          ],
        },
        {
          method: "GET",
          path: `/system/progress/${IDS.childB}`,
          sequence: [
            {
              status: 502,
              contentType: "text/html",
              body: "<html>Bad Gateway 502</html>",
            },
          ],
        },
      ],
    });

    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Bé Bình, lớp 2" }).click();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Bé Bình, lớp 2" }),
    ).toHaveAttribute("aria-pressed", "true");

    await page.goto(`/reports?childId=${IDS.childB}`);
    await expect(
      page.getByRole("heading", { name: "Tiến bộ của Bé Bình" }),
    ).toBeVisible();
    await expect(page.getByText("Buổi đọc hoàn thành")).toBeVisible();

    await page.goto(`/reports/difficult-words?childId=${IDS.childB}`);
    await expect(
      page.getByRole("heading", { name: /Từ cần luyện của Bé Bình/ }),
    ).toBeVisible();
    tracker.assertCleanHealth("S2", { expectedHttpStatuses: [524, 520, 502] });
  });

  test("S3: parent views private book pages (no-store), updates weekly email prefs, sends test email, and submits feedback", async ({
    page,
  }) => {
    const tracker = await installMockApi(page);

    await page.goto(`/my-books/${IDS.privateBook}`);
    await expect(
      page.getByRole("heading", { name: "Truyện Gia Đình Bé An" }),
    ).toBeVisible();

    await expect
      .poll(
        () =>
          tracker.requests.find((r) =>
            r.path.includes(`/books/my-books/${IDS.privateBook}/pages/`),
          )?.headers.authorization ?? "",
      )
      .toMatch(/^Bearer /);

    await page.goto("/settings");
    await page
      .getByRole("switch", { name: /Nhắc nhẹ khi bé nghỉ đọc quá lâu/ })
      .click();
    await page.getByRole("button", { name: "Lưu cài đặt email" }).click();
    await page.getByRole("button", { name: "Gửi email thử nghiệm" }).click();
    await expect(
      page.getByText("Đã gửi email thử nghiệm tới hộp thư phụ huynh."),
    ).toBeVisible();

    await page.goto("/help-support");
    await page.getByRole("button", { name: "Gửi phản hồi" }).click();
    await page.getByLabel("Tiêu đề").fill("Trải nghiệm Sách của tôi");
    await page
      .getByLabel("Nội dung")
      .fill("Ảnh sách riêng hiển thị tốt và email thử nghiệm đã tới.");
    await page.getByRole("button", { name: "Gửi phản hồi" }).click();
    await expect(
      page.getByText(/Máy chủ email đã tiếp nhận phản hồi/),
    ).toBeVisible();
    tracker.assertCleanHealth("S3");
  });

  test("S4: child plays /entertainment/picture-description on mobile (390x844), navigates, and switches language", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const tracker = await installMockApi(page);

    await page.goto("/entertainment/picture-description");
    await expect(page.locator("h1:visible").first()).toBeVisible();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);

    for (const imgName of [
      "happy-classroom.jpg",
      "lakeside-picnic.jpg",
      "sunny-garden.jpg",
    ]) {
      const res = await page.request.get(
        `/images/picture-description/${imgName}`,
      );
      expect(res.status()).toBe(200);
    }

    await page.getByRole("button", { name: "Mở menu tài khoản" }).click();
    await page.getByRole("menuitem", { name: "Cài đặt" }).click();
    await expect(page).toHaveURL(/\/settings$/);

    await page
      .locator("main")
      .getByRole("button", { name: /Chọn ngôn ngữ giao diện|Language/i })
      .click();
    await page.locator('[role="option"][data-locale-code="en"]').click();
    await expect(
      page
        .locator("main")
        .locator('div[role="status"]')
        .filter({ hasText: /English/i }),
    ).toBeVisible();
    tracker.assertCleanHealth("S4");
  });

  test("S5: interrupted reading session (mic denied -> safe finish) -> report review & difficult-words expansion", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, { difficultWordCount: 10 });

    await page.goto(`/reading/${IDS.session1}?state=microphone-denied`);
    await expect(
      page.getByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" }),
    ).toBeVisible();
    await expect(page.locator("[data-child-error-count='0']")).toBeVisible();
    await page.getByRole("button", { name: "Kết thúc an toàn" }).click();
    await page.getByRole("button", { name: "Lưu và dừng" }).click();
    await expect(
      page.getByRole("heading", { name: "Buổi đọc đã hoàn thành" }),
    ).toBeVisible();

    await page.goto(`/reports?childId=${IDS.childA}`);
    const expandBtn = page.getByRole("button", { name: "Xem tất cả (10)" });
    await expect(expandBtn).toBeVisible();
    await expandBtn.click();
    await expect(page.getByRole("button", { name: "Thu gọn" })).toBeVisible();
    tracker.assertCleanHealth("S5");
  });

  test("S6: degraded Render 503 recovery -> retry button -> /not-found fallback navigation", async ({
    page,
  }) => {
    const tracker = await installMockApi(page, {
      faults: [
        {
          method: "GET",
          path: "/books/catalog",
          sequence: [
            {
              status: 503,
              body: {
                detail: "Service temporarily unavailable (postgresql://)",
              },
            },
          ],
        },
      ],
    });

    await page.goto("/books");
    await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
    assertNoRawErrorLeak(await page.locator("main").innerText(), "S6-503");

    await page.getByRole("button", { name: "Thử lại" }).click();
    await expect(
      page.getByRole("heading", { name: "Chú Mèo Nhỏ Đi Học" }),
    ).toBeVisible();

    await page.goto("/nonexistent-workload-fallback");
    await expect(
      page.getByRole("heading", { name: "Không tìm thấy trang" }),
    ).toBeVisible();
    await page.locator('a[href="/dashboard"]').first().click();
    await expect(page).toHaveURL(/\/dashboard$/);
    tracker.assertCleanHealth("S6", { expectedHttpStatuses: [503, 404] });
  });
});
