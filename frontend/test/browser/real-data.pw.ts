import { expect, test, type Page } from "@playwright/test";
import {
  book,
  child,
  ids,
  installApiFixture,
  setRole,
} from "./real-data-fixture";
import { installReadingExperience } from "./reading-experience-fixture";
import { songDetail, songId } from "../karaoke-fixtures";

async function assertLayout(page: Page) {
  const dimensions = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const describe = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const htmlElement = element as HTMLElement;
      return {
        tag: element.tagName.toLowerCase(),
        className:
          typeof htmlElement.className === "string"
            ? htmlElement.className
            : "",
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        overflowX: window.getComputedStyle(element).overflowX,
      };
    };
    const overflowingElements = Array.from(document.body.querySelectorAll("*"))
      .map((element) => {
        const ancestors: ReturnType<typeof describe>[] = [];
        let ancestor = element.parentElement;
        while (ancestor) {
          ancestors.push(describe(ancestor));
          ancestor = ancestor.parentElement;
        }
        const isContained = ancestors.some((item) =>
          ["auto", "scroll", "hidden", "clip"].includes(item.overflowX),
        );
        return {
          ...describe(element),
          text: element.textContent?.trim().slice(0, 50),
          isContained,
          ancestors: ancestors.slice(0, 6),
        };
      })
      .filter(
        (element) =>
          element.width > 0 &&
          element.right > width + 1 &&
          !element.isContained,
      )
      .sort((left, right) => right.right - left.right)
      .slice(0, 15);

    return {
      width,
      scroll: document.documentElement.scrollWidth,
      body: describe(document.body),
      header: document.querySelector("header")
        ? describe(document.querySelector("header")!)
        : null,
      main: document.querySelector("main")
        ? describe(document.querySelector("main")!)
        : null,
      overflowingElements,
    };
  });
  expect(
    dimensions.scroll,
    `Horizontal overflow: ${JSON.stringify(dimensions)}`,
  ).toBeLessThanOrEqual(dimensions.width);
}

async function selectChildAndOpenBooks(page: Page) {
  await page.goto("/dashboard");
  const childButton = page.getByRole("button", {
    name: `${child.alias}, lớp ${child.grade}`,
  });
  await childButton.click();
  await expect(childButton).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Chọn sách" }).click();
  await expect(page).toHaveURL(/\/books$/);
}

test("Parent dashboard → catalog → real book metadata with unavailable preview", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await selectChildAndOpenBooks(page);
  await page.getByRole("link", { name: `Đọc sách ${book.title}` }).click();
  await expect(
    page.getByRole("heading", { name: book.title, exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Ảnh xem trước chưa sẵn sàng")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Chuẩn bị đọc" }),
  ).toBeDisabled();
  expect(api.unexpected).toEqual([]);
});

test("Parent search, no result, keyboard clear and API retry", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await selectChildAndOpenBooks(page);
  await expect(
    page.getByRole("link", { name: `Đọc sách ${book.title}` }),
  ).toBeVisible();
  await page.getByLabel("Tìm theo tên sách hoặc tác giả").fill("không có");
  await expect(
    page.getByRole("heading", { name: "Không tìm thấy cuốn sách phù hợp" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Xóa bộ lọc" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("link", { name: `Đọc sách ${book.title}` }),
  ).toBeVisible();
  api.catalogStatus = 503;
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole("button", { name: "Chọn sách" }).click();
  await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
  await expect(page.getByText("private sql token")).toHaveCount(0);
  api.catalogStatus = 200;
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(
    page.getByRole("link", { name: `Đọc sách ${book.title}` }),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Parent empty catalog and detail route require a selected child", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  api.emptyCatalog = true;
  await selectChildAndOpenBooks(page);
  await expect(
    page.getByRole("heading", { name: "Thư viện đang được cập nhật" }),
  ).toBeVisible();
  await page.goto(`/books/${ids.page}`);
  await expect(page).toHaveURL(
    /\/dashboard\?focus=child-selection&reason=missing$/,
  );
  await expect(
    page.getByText("Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc hoặc chơi."),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Parent stored history → detail, report counts and words", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await page.goto(`/sessions?childId=${ids.child}`);
  await expect(page.getByText(book.title).first()).toBeVisible();
  await page.getByRole("link", { name: "Xem chi tiết", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Buổi đọc đã dừng" }),
  ).toBeVisible();
  await expect(page.getByText("Chưa đánh giá")).toBeVisible();
  await page.goto(`/reports?childId=${ids.child}`);
  await expect(page.getByText("2 buổi", { exact: true })).toBeVisible();
  // This flow auto-starts practice after selecting a word. Deny the
  // microphone deterministically to verify the safe paused/retry state.
  await page.addInitScript(() => {
    const device = navigator.mediaDevices;
    if (!device) return;
    const probe = window as Window & { __practiceMicRequests?: number };
    probe.__practiceMicRequests = 0;
    Object.defineProperty(device, "getUserMedia", {
      configurable: true,
      value: async () => {
        probe.__practiceMicRequests = (probe.__practiceMicRequests ?? 0) + 1;
        throw new DOMException(
          "Test microphone permission denied",
          "NotAllowedError",
        );
      },
    });
  });
  await page.goto(`/reports/difficult-words?childId=${ids.child}`);
  const wordPracticeButton = page.getByRole("button", {
    name: /Luyện từ Mèo API/,
  });
  await expect(wordPracticeButton).toBeVisible();
  await wordPracticeButton.click();
  await expect(
    page.getByRole("heading", { name: "Mèo API", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Nghe phát âm mẫu" }),
  ).toBeVisible();
  // A denied device must not claim success or silently start another attempt.
  await expect(
    page.getByRole("button", { name: "Tiếp tục luyện" }),
  ).toBeVisible();
  const microphoneRequests = await page.evaluate(() => {
    const probe = window as Window & { __practiceMicRequests?: number };
    return probe.__practiceMicRequests;
  });
  expect(microphoneRequests).toBe(1);
  await expect(
    page.getByText("Đã tạm dừng. Khi sẵn sàng, bé bấm Tiếp tục luyện nhé."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bắt đầu luyện" }),
  ).toHaveCount(0);
  expect(api.unexpected).toEqual([]);
});

test("Parent unavailable reports/history do not manufacture zero data and can retry", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  api.reportStatus = 501;
  api.historyStatus = 501;
  for (const path of [
    "/reports",
    "/reports/difficult-words",
    "/sessions",
    `/sessions/${ids.session}`,
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Dữ liệu đang chờ bổ sung" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Thử lại" })).toBeVisible();
    await assertLayout(page);
  }
  api.historyStatus = 200;
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(
    page.getByRole("heading", { name: "Buổi đọc đã dừng" }),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Admin catalog → metadata, unavailable pages retry, audit and health", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await setRole(page, "admin");
  api.adminPagesStatus = 501;
  await page.goto("/admin/books?state=empty");
  await page.getByRole("link", { name: new RegExp(book.title) }).click();
  await expect(page.getByRole("heading", { name: book.title })).toBeVisible();
  await expect(page.getByText("Dữ liệu trang đang chờ bổ sung")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Chỉnh sửa metadata / vòng đời" }),
  ).toBeVisible();
  api.adminPagesStatus = 200;
  await page.getByRole("button", { name: "Tải lại" }).click();
  await expect(page.getByRole("heading", { name: "Trang 2" })).toBeVisible();
  await page.goto("/admin/audit-logs");
  await expect(page.getByText("book.read", { exact: true })).toBeVisible();
  await expect(page.getByText("Hệ thống", { exact: true })).toBeVisible();
  await page.goto("/admin/health");
  await expect(page.getByRole("heading", { name: "Database" })).toBeVisible();
  await page.getByRole("button", { name: "Kiểm tra lại" }).click();
  await expect(
    page.getByText("Database đã phản hồi truy vấn đọc."),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Admin OCR is read-only and can switch to a stored revision", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await setRole(page, "admin");
  await page.goto(`/admin/books/${ids.book}/pages/${ids.page}`);
  await expect(
    page.getByRole("heading", { name: "Kiểm tra OCR · R2" }),
  ).toBeVisible();
  await expect(page.getByLabel("Nội dung trang")).toBeDisabled();
  await page
    .getByText("Thông tin chi tiết từ OCR và lịch sử revision", {
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: /Chạy lại OCR từ ảnh đã lưu/ }),
  ).toBeEnabled();
  await page.getByRole("button", { name: /Revision R1/ }).click();
  await expect(page.getByLabel("Nội dung trang")).toHaveValue(
    "Văn bản revision cũ",
  );
  expect(api.unexpected).toEqual([]);
});

test("Admin OCR draft → combined AI review → save → verify preserves bounding boxes", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await setRole(page, "admin");
  await page.goto(`/admin/books/${ids.book}/pages/${ids.page}`);
  await expect(
    page.getByRole("heading", { name: "Kiểm tra OCR · R2" }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: /Tạo bản nháp để sửa nội dung/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Kiểm tra OCR · R3" }),
  ).toBeVisible();
  await expect(page.getByLabel("Nội dung trang")).toHaveValue("Văn bản đã lưu");
  expect(api.draftCreateSourceRevisionId).toBe(ids.revision);

  await page.getByRole("button", { name: /XÁC NHẬN & CHẠY AI/ }).click();
  await expect(
    page.getByRole("heading", { name: "Rà soát đề xuất AI" }),
  ).toBeVisible();
  await expect(page.getByLabel("Nội dung trang")).toHaveValue("Văn bản đã lưu");

  // Proposals start unchecked; confirming zero selections explicitly rejects all.
  const review = page.getByRole("region", { name: "Rà soát đề xuất AI" });
  const applySelected = page.getByRole("button", {
    name: /Xác nhận lựa chọn gợi ý/,
  });
  const proposedChanges = review.getByRole("checkbox");
  await expect(proposedChanges).toHaveCount(1);
  await expect(proposedChanges.first()).not.toBeChecked();
  await expect(applySelected).toBeEnabled();

  await proposedChanges.first().check();
  await expect(applySelected).toBeEnabled();
  await applySelected.click();

  await expect(page.getByLabel("Nội dung trang")).toHaveValue("Văn bản đã sửa");
  expect(api.workflowRequest).toMatchObject({
    page_revision_id: ids.draftRevision,
    draft_text: "Văn bản đã lưu",
  });
  const firstBox = page.getByRole("button", { name: /Từ 1: Văn\./ });
  await expect(firstBox).toBeVisible();
  const bboxStyle = await firstBox.getAttribute("style");
  expect(bboxStyle).toContain("left: 10%");
  expect(bboxStyle).toContain("top: 20%");
  expect(bboxStyle).toContain("width: 14%");
  expect(bboxStyle).toContain("height: 5%");

  const workflowCard = page.getByTestId("admin-ai-workflow");
  await expect(
    workflowCard
      .getByText("Candidate version")
      .locator("..")
      .getByText("1", { exact: true }),
  ).toBeVisible();
  await expect(workflowCard.getByText("Khớp Candidate hiện tại")).toBeVisible();
  await page.getByRole("button", { name: /Lưu bản nháp/ }).click();
  await expect(page.getByText("Đã lưu bản nháp vào database.")).toBeVisible();
  expect(api.draftSaveRequest?.draft_text).toBe("Văn bản đã sửa");
  const savedWords = api.draftSaveRequest?.words as
    Array<Record<string, unknown>> | undefined;
  expect(savedWords?.[0]?.bbox).toEqual([0.1, 0.2, 0.14, 0.05]);

  expect(api.candidateRequest).toMatchObject({
    expected_candidate_version: 0,
    candidate_text: "Văn bản đã sửa",
  });
  await page.getByRole("button", { name: "Xác nhận kết quả Safety" }).click();
  expect(api.safetyDecisionRequest).toMatchObject({
    expected_candidate_hash: "c".repeat(64),
    confirmed: true,
  });
  await page
    .getByRole("button", {
      name: /XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG/,
    })
    .click();
  await expect(
    page.getByText("Đã xác minh revision", { exact: true }),
  ).toBeVisible();
  expect(api.verifyRequest?.corrected_text).toBe("Văn bản đã sửa");
  expect(api.verifyRequest?.proofread_audit).toMatchObject({
    mode: "AI_CHECKED",
    checked_text: "Văn bản đã sửa",
    suggestions: [],
  });
  expect(api.unexpected).toEqual([]);
});

test("Admin book creation requires separate name and title and sends normalized metadata", async ({
  page,
}) => {
  const api = await installApiFixture(page);
  await setRole(page, "admin");
  await page.goto("/admin/books/new");

  const name = page.getByRole("textbox", { name: "Tên sách *" });
  const title = page.getByRole("textbox", { name: "Tiêu đề sách *" });
  await page.getByRole("button", { name: "Tạo sách" }).click();
  await expect(
    page.getByText("Vui lòng nhập tên sách.", { exact: true }),
  ).toBeVisible();
  expect(api.createBookRequest).toBeNull();

  await name.fill("  Tên hiển thị mới  ");
  await page.getByRole("button", { name: "Tạo sách" }).click();
  await expect(
    page.getByText("Vui lòng nhập tiêu đề sách.", { exact: true }),
  ).toBeVisible();
  expect(api.createBookRequest).toBeNull();

  await title.fill("  Cuốn sách mới  ");
  await page.getByLabel(/Tác giả/).fill("  Tác giả A  ");
  await page.getByRole("button", { name: "Tạo sách" }).click();

  await expect(page).toHaveURL(
    /\/admin\/books\/88888888-8888-4888-8888-888888888888$/,
  );
  await expect(
    page.getByRole("heading", { name: "Cuốn sách mới", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sách chưa có trang" }),
  ).toBeVisible();
  expect(api.createBookRequest).toEqual({
    name: "Tên hiển thị mới",
    title: "Cuốn sách mới",
    author: "Tác giả A",
    min_grade: 1,
    max_grade: 5,
  });
  expect(api.unexpected).toEqual([]);
});

test("Visual QA: book, scanner and reading preparation at requested widths", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "This flow captures all four requested viewport widths.",
  );
  const api = await installApiFixture(page);
  api.previewStatus = 200;
  await page.addInitScript(() => {
    const probe = { cameraRequests: 0, microphoneRequests: 0 };
    Object.assign(window, { __deviceProbe: probe });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        if (constraints.video) probe.cameraRequests += 1;
        if (constraints.audio) probe.microphoneRequests += 1;
        throw new DOMException(
          "Isolated denied device fixture",
          "NotAllowedError",
        );
      },
    });
  });

  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await setRole(page, "parent");
    await page.goto("/dashboard");
    const childButton = page.getByRole("button", {
      name: `${child.alias}, lớp ${child.grade}`,
    });
    await childButton.click();
    await expect(childButton).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Quét sách" }).click();
    await expect(
      page.getByRole("heading", { name: "Camera đang tắt" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Bật camera để quét" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __deviceProbe: { cameraRequests: number } })
            .__deviceProbe.cameraRequests,
      ),
    ).toBe(0);
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`after-book-scanner-${width}.png`),
      fullPage: true,
      caret: "initial",
      style: "nextjs-portal { display: none !important; }",
    });

    await page.getByRole("button", { name: "Bật camera để quét" }).click();
    await expect(
      page.getByText("Camera chưa sẵn sàng", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __deviceProbe: { cameraRequests: number } })
            .__deviceProbe.cameraRequests,
      ),
    ).toBe(1);
    await page
      .getByRole("navigation", { name: "Điều hướng dành cho ba mẹ" })
      .getByRole("link", { name: "Tổng quan", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Góc đọc gia đình",
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Chọn sách" }).click();
    await expect(
      page.getByRole("link", { name: `Đọc sách ${book.title}` }),
    ).toBeVisible();
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`after-book-library-${width}.png`),
      fullPage: true,
      caret: "initial",
      style: "nextjs-portal { display: none !important; }",
    });

    await page.getByRole("link", { name: `Đọc sách ${book.title}` }).click();
    await expect(
      page.getByRole("button", { name: "Chuẩn bị đọc" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Chuẩn bị đọc" }).click();
    await expect(
      page.getByRole("button", { name: "Kiểm tra và cấp quyền microphone" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              __deviceProbe: { microphoneRequests: number };
            }
          ).__deviceProbe.microphoneRequests,
      ),
    ).toBe(0);
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`after-reading-preparation-${width}.png`),
      fullPage: true,
      caret: "initial",
      style: "nextjs-portal { display: none !important; }",
    });

    await page
      .getByRole("button", { name: "Kiểm tra và cấp quyền microphone" })
      .click();
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __deviceProbe: { microphoneRequests: number };
              }
            ).__deviceProbe.microphoneRequests,
        ),
      )
      .toBe(1);
    expect(api.unexpected).toEqual([]);
  }
});

test("Reading management editor pages keep fields readable at all requested widths", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "This interaction checks all four requested widths.",
  );
  test.setTimeout(120_000);
  const api = await installApiFixture(page);
  await page.goto("/reading-management", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("button", { name: "Thêm lịch nhắc" }),
  ).toBeVisible();
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const [action, title] of [
      ["Thêm kế hoạch", "Thiết lập kế hoạch đọc"],
      ["Thêm mục tiêu", "Thiết lập mục tiêu"],
      ["Thêm lịch nhắc", "Thiết lập lịch nhắc"],
    ]) {
      await page.getByRole("button", { name: action, exact: true }).click();
      const dialog = page.locator(".figma-form-page");
      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeFocused();
      await expect(dialog).toBeVisible();
      const fields = await dialog
        .locator('input:not([type="checkbox"]), select')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            const parent = element
              .closest(".figma-form-page")!
              .getBoundingClientRect();
            return {
              width: rect.width,
              fits: rect.left >= parent.left && rect.right <= parent.right,
            };
          }),
        );
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        expect(field.width, `${title} at ${width}px`).toBeGreaterThanOrEqual(
          120,
        );
        expect(field.fits, `${title} at ${width}px`).toBe(true);
      }
      await assertLayout(page);
      await dialog.screenshot({
        path: testInfo.outputPath(`editor-${action}-${width}.png`),
      });
      await page.getByRole("button", { name: "Quay lại", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: action, exact: true }),
      ).toBeVisible();
    }
  }
  expect(api.unexpected).toEqual([]);
});

test("Parent account editor pages retain cancel and validation at all requested widths", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "This interaction checks all four requested widths.",
  );
  test.setTimeout(120_000);
  const api = await installApiFixture(page);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto("/profile");
    await page
      .getByRole("button", { name: "Chỉnh sửa hồ sơ", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Thông tin cá nhân" }),
    ).toBeVisible();
    await page.getByLabel("Họ và tên", { exact: true }).fill("Tên chưa lưu");
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`parent-profile-edit-${width}.png`),
      fullPage: true,
      style: "nextjs-portal { display: none !important; }",
    });
    await page.getByRole("button", { name: "Hủy", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Ba mẹ API", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Tên chưa lưu", { exact: true })).toHaveCount(
      0,
    );
    await page.goto("/settings");
    await page
      .getByRole("button", { name: "Đổi mật khẩu", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Đổi mật khẩu", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByLabel("Mật khẩu hiện tại", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Mật khẩu mới", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Xác nhận mật khẩu mới", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Lưu mật khẩu mới", exact: true })
      .click();
    await expect(page.locator("main").getByRole("alert")).toContainText(
      "nhập mật khẩu hiện tại",
    );
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`parent-password-edit-${width}.png`),
      fullPage: true,
      style: "nextjs-portal { display: none !important; }",
    });
    await page.getByRole("button", { name: "Hủy", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Cài đặt tài khoản" }),
    ).toBeVisible();
    await page.goto("/help-support");
    await page
      .getByRole("button", { name: "Gửi phản hồi", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Gửi phản hồi", exact: true })
      .click();
    await expect(page.locator("main").getByRole("alert")).toContainText(
      "điền tiêu đề",
    );
    await assertLayout(page);
    await page.screenshot({
      path: testInfo.outputPath(`parent-feedback-edit-${width}.png`),
      fullPage: true,
      style: "nextjs-portal { display: none !important; }",
    });
    await page.getByRole("button", { name: "Quay lại", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Câu hỏi thường gặp" }),
    ).toBeVisible();
  }
  expect(api.unexpected).toEqual([]);
});

for (const routeGroup of ["parent", "admin"] as const) {
  test(`read-route matrix ${routeGroup}, headings, console and overflow at all requested widths`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "Matrix itself covers all four requested widths.",
    );
    test.setTimeout(360_000);
    const readingFixture = await installReadingExperience(page);
    const api = readingFixture.api;
    const adminSong = songDetail();
    const adminDraft = adminSong.draft!;
    await page
      .context()
      .route("http://127.0.0.1:8000/karaoke/admin/songs**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        const headers = {
          "access-control-allow-origin": "http://127.0.0.1:3106",
          "access-control-allow-headers": "authorization,content-type,accept",
          "access-control-allow-methods": "GET,OPTIONS",
        };
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers });
        if (request.method() !== "GET")
          return route.fulfill({ status: 405, headers });
        const body =
          pathname === "/karaoke/admin/songs"
            ? {
                items: [
                  {
                    song_id: songId,
                    status: adminSong.status,
                    revision: adminSong.revision,
                    title: adminDraft.title,
                    author: adminDraft.author,
                    min_grade: adminDraft.min_grade,
                    max_grade: adminDraft.max_grade,
                    duration_ms: adminDraft.duration_ms,
                    draft_version_id: adminDraft.id,
                    published_version_id: null,
                    has_audio: adminDraft.has_audio,
                    has_cover: adminDraft.has_cover,
                    created_at: adminSong.created_at,
                    updated_at: adminSong.updated_at,
                  },
                ],
                total: 1,
                limit: 12,
                offset: 0,
              }
            : pathname === `/karaoke/admin/songs/${songId}`
              ? adminSong
              : { detail: "Not found" };
        return route.fulfill({
          status:
            pathname.startsWith(`/karaoke/admin/songs/${songId}`) ||
            pathname === "/karaoke/admin/songs"
              ? 200
              : 404,
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const resourceFailures: string[] = [];
    const apiRequests: string[] = [];
    let activePath = "(before first route)";
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().includes("503 (Service Unavailable)")
      )
        consoleErrors.push(`${activePath}: ${message.text()}`);
    });
    page.on("requestfailed", (request) =>
      resourceFailures.push(
        `${activePath}: ${request.url()} (${request.failure()?.errorText ?? "failed"})`,
      ),
    );
    page.on("response", (response) => {
      if (response.status() >= 400)
        resourceFailures.push(
          `${activePath}: ${response.status()} ${response.url()}`,
        );
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.port === "8000" || url.hostname === "example.supabase.co")
        apiRequests.push(
          `${activePath}: ${request.method()} ${url.pathname}${url.search}`,
        );
    });
    const paths = [
      "/",
      "/login",
      "/register",
      "/forgot-password",
      "/reset-password",
      "/admin/login",
      "/dashboard",
      "/profile",
      "/settings",
      "/help-support",
      "/device-permissions",
      "/entertainment",
      "/entertainment/picture-description",
      "/entertainment/sentence-shooter",
      "/karaoke",
      `/karaoke/${songId}`,
      "/children",
      "/children/new",
      `/children/${ids.child}`,
      "/books",
      `/books/${ids.book}`,
      "/book-reports",
      "/book-scanner",
      `/reading-preparation?bookId=${ids.book}&pageId=${ids.page}&endPageId=${ids.page}`,
      `/reading/${ids.session}?state=reading`,
      "/sessions",
      `/sessions/${ids.session}`,
      `/sessions/${ids.session}/report`,
      "/reports",
      "/reports/difficult-words",
      "/reading-management",
      "/admin",
      "/admin/parents",
      `/admin/parents/${ids.parent}`,
      "/admin/books",
      "/admin/books/new",
      `/admin/books/${ids.book}`,
      `/admin/books/${ids.book}/edit`,
      `/admin/books/${ids.book}/pages/${ids.page}`,
      "/admin/audit-logs",
      "/admin/health",
      "/admin/metadata-quality",
      "/admin/viread-training",
      "/admin/karaoke",
      "/admin/karaoke/new",
      `/admin/karaoke/${songId}/edit`,
    ];
    const screenshotNames: Record<string, string> = {
      "/login": "auth-login",
      "/register": "auth-register",
      "/profile": "parent-profile",
      "/settings": "parent-settings",
      "/help-support": "parent-support",
      "/dashboard": "parent-dashboard",
      "/entertainment": "parent-entertainment",
      "/admin/karaoke": "admin-karaoke",
      [`/reading/${ids.session}?state=reading`]: "reading-session",
      [`/sessions/${ids.session}`]: "session-detail",
      "/reports": "parent-reports",
      "/reports/difficult-words": "difficult-words",
      "/sessions": "reading-history",
      "/reading-management": "reading-management",
      "/admin/parents": "admin-parents",
      [`/admin/parents/${ids.parent}`]: "admin-parent-detail",
      "/admin/books": "admin-books",
      [`/admin/books/${ids.book}/pages/${ids.page}`]: "admin-ocr",
      "/admin/audit-logs": "admin-audit",
      "/admin/health": "admin-health",
      "/admin/metadata-quality": "admin-metadata",
      "/admin/viread-training": "admin-training",
    };
    const routeFilter = process.env.PLAYWRIGHT_ROUTE_FILTER;
    const routeFilters = new Set(
      routeFilter?.split(",").map((path) => path.trim()),
    );
    const requestedRoutes = routeFilter
      ? paths.filter((path) => routeFilters.has(path))
      : paths;
    const routesToVisit = requestedRoutes.filter(
      (path) => path.startsWith("/admin") === (routeGroup === "admin"),
    );
    expect(
      routesToVisit.length,
      `route filter did not match: ${routeFilter}`,
    ).toBeGreaterThan(0);
    for (const path of routesToVisit) {
      activePath = path;
      await setRole(page, path.startsWith("/admin") ? "admin" : "parent");
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(response?.status(), path).toBe(200);
      const expectedPath = new URL(path, "http://localhost").pathname;
      const finalUrl = new URL(page.url());
      const childGatedRoute =
        /^\/books(?:\/|$)/.test(expectedPath) ||
        /^\/karaoke(?:\/|$)/.test(expectedPath) ||
        expectedPath === "/entertainment/picture-description" ||
        expectedPath === "/entertainment/sentence-shooter" ||
        expectedPath === "/book-scanner" ||
        expectedPath === "/reading-preparation";
      if (expectedPath === "/") {
        expect(finalUrl.pathname, path).toBe("/login");
      } else if (
        expectedPath === "/device-permissions" &&
        finalUrl.pathname === "/dashboard"
      ) {
        expect(finalUrl.searchParams.get("focus"), path).toBe(
          "child-selection",
        );
      } else if (childGatedRoute && finalUrl.pathname === "/dashboard") {
        expect(finalUrl.searchParams.get("focus"), path).toBe(
          "child-selection",
        );
        expect(finalUrl.searchParams.get("reason"), path).toBe("missing");
      } else {
        expect(finalUrl.pathname, path).toBe(
          expectedPath === "/admin" ? "/admin/parents" : expectedPath,
        );
      }
      if (path === `/reading/${ids.session}?state=reading`)
        expect(
          await page.evaluate(
            () =>
              (
                window as unknown as {
                  __readingProbe: { microphoneRequests: number };
                }
              ).__readingProbe.microphoneRequests,
          ),
          "opening a reading session must not request microphone access",
        ).toBe(0);
      await expect(page.locator("h1").first(), path).toBeVisible();
      // Wait for the intended content, not a transient skeleton or hidden heading.
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      if (path === "/admin/books")
        await expect(
          page.getByRole("link", { name: new RegExp(book.title) }),
        ).toBeVisible();
      if (path === "/entertainment")
        await expect(
          page.getByRole("link", { name: "Mở thư viện bài hát" }),
        ).toHaveAttribute("href", "/karaoke");
      if (path === `/admin/books/${ids.book}`)
        await expect(
          page.getByRole("heading", { name: "Trang 2" }),
        ).toBeVisible();
      if (path === `/admin/books/${ids.book}/pages/${ids.page}`)
        await expect(page.getByLabel("Nội dung trang")).toHaveValue(
          "Văn bản đã lưu",
        );
      if (path === "/admin/audit-logs")
        await expect(
          page.getByText("book.read", { exact: true }),
        ).toBeVisible();
      if (path === "/admin/health")
        await expect(
          page.getByRole("heading", { name: "Database" }),
        ).toBeVisible();
      for (const width of [1440, 1024, 768, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await expect(
          page.locator("h1").first(),
          `${path} at ${width}px`,
        ).toBeVisible();
        await assertLayout(page);
        const screenshotName = screenshotNames[path];
        if (screenshotName && finalUrl.pathname === expectedPath)
          await page.screenshot({
            path: testInfo.outputPath(`after-${screenshotName}-${width}.png`),
            fullPage: true,
            // Do not mutate input styles while React is hydrating the page.
            caret: "initial",
            style: "nextjs-portal { display: none !important; }",
          });
      }
    }
    expect(pageErrors).toEqual([]);
    expect(
      consoleErrors,
      JSON.stringify(
        {
          resourceFailures,
          apiRequests,
          unexpectedApi: api.unexpected,
          unexpectedReading: readingFixture.unexpected,
        },
        null,
        2,
      ),
    ).toEqual([]);
    expect(api.unexpected).toEqual([]);
    expect(readingFixture.unexpected).toEqual([]);
  });
}
