import { expect, test } from "@playwright/test";

const sessionRoute = "/reading/mock-session-001";
const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bookId = "20000000-0000-4000-8000-000000000001";

test.describe("Group 4 responsive reading session mock", () => {
  test("book detail creates a session and ready starts reading", async ({
    page,
  }) => {
    await page.goto(`/books/${bookId}?childId=${childId}`);
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
    await expect(page).toHaveURL(/\/reading\/mock-session-001\?state=ready/);
    await expect(
      page.getByRole("heading", { name: "Sẵn sàng đọc chưa nào?" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
    await expect(page.getByText("Mình đang nghe bé đọc")).toBeVisible();
  });

  test("reading pauses and resumes without child-error evidence", async ({
    page,
  }) => {
    await page.goto(`${sessionRoute}?state=reading`);
    await page.getByRole("button", { name: "Tạm dừng buổi đọc" }).click();
    await expect(
      page.getByRole("dialog", { name: "Bé đang nghỉ một chút" }),
    ).toContainText("không tạo lỗi đọc");
    await expect(page.locator("[data-child-error-count='0']")).toBeVisible();
    await page.getByRole("button", { name: "Đọc tiếp" }).click();
    await expect(page.getByText("Mình đang nghe bé đọc")).toBeVisible();
  });

  test("low page confidence falls back to verified manual selection", async ({
    page,
  }) => {
    await page.goto(`${sessionRoute}?state=page-confidence-low`);
    await expect(
      page.getByRole("dialog", { name: "Mình chưa nhìn rõ trang sách" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Chọn trang", exact: true }).click();
    await page.getByRole("button", { name: "Chọn trang 5" }).click();
    await page.getByRole("button", { name: "Đúng trang này" }).click();
    await expect(page.getByLabel("Trang sách 5")).toHaveAttribute(
      "data-page-revision-id",
      "40000000-0000-4000-8000-000000000015",
    );
  });

  test("camera and microphone denial remain recoverable mock states", async ({
    page,
  }) => {
    await page.goto(`${sessionRoute}?state=camera-denied`);
    await expect(
      page.getByRole("dialog", { name: "Camera chưa sẵn sàng" }),
    ).toContainText("camera chưa được mở");
    await page.getByRole("button", { name: "Thử lại" }).click();
    await expect(page.getByText("Mình đang nghe bé đọc")).toBeVisible();

    await page.goto(`${sessionRoute}?state=microphone-denied`);
    await expect(
      page.getByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" }),
    ).toContainText("không kết luận bé đọc sai");
  });

  test("reconnecting recovers and timeout offers a safe exit", async ({
    page,
  }) => {
    await page.goto(`${sessionRoute}?state=reconnecting`);
    await page.getByRole("button", { name: "Kết nối lại" }).click();
    await expect(page.getByText("Mình đang nghe bé đọc")).toBeVisible();

    await page.goto(`${sessionRoute}?state=reconnecting&reconnect=timeout`);
    await page.getByRole("button", { name: "Kết nối lại" }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Đợi mình một chút nhé…" })
        .getByRole("alert"),
    ).toContainText("Chưa kết nối lại được");
    await expect(
      page.getByRole("button", { name: "Kết thúc an toàn" }),
    ).toBeVisible();
  });

  test("STT failure never reports a child reading error", async ({ page }) => {
    await page.goto(`${sessionRoute}?state=stt-error`);
    await expect(
      page.getByRole("dialog", { name: "Mình chưa nghe rõ" }),
    ).toContainText("không tạo lỗi đọc");
    await expect(page.locator("[data-child-error-count='0']")).toBeVisible();
    await expect(page.getByText(/bé đọc sai/i)).toHaveCount(0);
  });

  test("TTS failure keeps text help and can continue silently", async ({
    page,
  }) => {
    await page.goto(`${sessionRoute}?state=tts-error`);
    await expect(
      page.getByRole("dialog", { name: "Từ này mình đọc thế nào nhỉ?" }),
    ).toContainText("vẫn có thể nhìn chữ");
    await page.getByRole("button", { name: "Đọc tiếp" }).click();
    await expect(page.getByText("Mình đang nghe bé đọc")).toBeVisible();
  });

  test("page turn replaces the revision and current word binding", async ({
    page,
  }) => {
    await page.goto(`${sessionRoute}?state=page-turn`);
    await expect(page.getByLabel("Trang sách 5")).toHaveAttribute(
      "data-page-revision-id",
      "40000000-0000-4000-8000-000000000015",
    );
    await expect(
      page.locator(
        '[data-page-revision-id="40000000-0000-4000-8000-000000000015"][data-word-id$="000000000503"]',
      ),
    ).toBeVisible();
  });

  test("question withholds expected answer and supports retry then correct", async ({
    page,
  }) => {
    await page.goto(`${sessionRoute}?state=question`);
    await expect(
      page.getByRole("heading", { name: "Mình cùng trả lời nhé!" }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("expected_answer");
    await page.getByRole("button", { name: /A Trên bàn/ }).click();
    await expect(page.getByText("Gần đúng rồi, thử lại nhé.")).toBeVisible();
    await page.getByRole("button", { name: /B Bên cửa sổ/ }).click();
    await expect(page.getByText("Đúng rồi! Bé nhớ rất tốt.")).toBeVisible();
  });

  test("finish is guarded and complete returns to the catalog", async ({
    page,
  }) => {
    await page.goto(`${sessionRoute}?state=reading`);
    await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
    await page.getByRole("button", { name: "Lưu và dừng" }).click();
    await expect(
      page.getByRole("heading", { name: "Bé đọc xong rồi!" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Đọc cuốn khác" }).click();
    await expect(page).toHaveURL(new RegExp(`/books\\?childId=${childId}`));
  });

  for (const state of [
    "ready",
    "reading",
    "manual-page",
    "question",
    "complete",
  ]) {
    test(`${state} has no unintended horizontal overflow`, async ({
      page,
    }, testInfo) => {
      await page.goto(`${sessionRoute}?state=${state}`);
      await expect(page.locator("h1:visible").first()).toBeVisible();
      const size = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth);

      if (state === "reading" || state === "ready") {
        await page.screenshot({
          fullPage: true,
          path: testInfo.outputPath(`group4-${state}.png`),
        });
      }
    });
  }

  test("reading and dialogs reflow at 1024px and 768px", async ({ page }) => {
    for (const width of [1024, 768]) {
      await page.setViewportSize({ height: 1000, width });
      for (const state of ["reading", "manual-page", "reconnecting"]) {
        await page.goto(`${sessionRoute}?state=${state}`);
        await expect(page.locator("h1:visible").first()).toBeVisible();
        const size = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(size.scrollWidth, `${state} at ${width}px`).toBeLessThanOrEqual(
          size.clientWidth,
        );
      }
    }
  });
});
