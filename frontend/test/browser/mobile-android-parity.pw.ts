import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

interface StackInfo {
  auth_url: string;
  api_url: string;
  web_origin: string;
  db_name: string;
  legacy_catalog_book_id: string;
  users: {
    parent_a: {
      id: string;
      email: string;
      password: string;
      child_id: string;
      child_alias: string;
    };
  };
  assets: {
    clean_png: string;
  };
}

const STACK_INFO_PATH =
  process.env.VIREAD_E2E_STACK_INFO ??
  path.join(os.tmpdir(), "viread_ppb_e2e_stack_info.json");

const SCREENSHOT_DIR =
  process.env.VIREAD_MOBILE_E2E_SCREENSHOT_DIR ??
  path.join(os.tmpdir(), "viread_mobile_android_e2e_screenshots");

const SHARED_BOOK_ID_CACHE = path.join(
  os.tmpdir(),
  "viread_mobile_e2e_ready_book_id.txt",
);

function readStackInfo(): StackInfo {
  if (!fs.existsSync(STACK_INFO_PATH)) {
    throw new Error(
      `Missing E2E stack info at ${STACK_INFO_PATH}. Start run_parent_private_books_e2e_stack.py first.`,
    );
  }
  return JSON.parse(fs.readFileSync(STACK_INFO_PATH, "utf-8")) as StackInfo;
}

async function assertMobileScreenHealth(
  page: Page,
  projectName: string,
  screenSlug: string,
  interactiveLocators: Locator[] = [],
) {
  await page.waitForLoadState("domcontentloaded");

  // 1. Assert zero horizontal overflow (scrollWidth <= innerWidth) & zero broken images
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const brokenImages = Array.from(document.querySelectorAll("img"))
      .filter((img) => {
        const style = window.getComputedStyle(img);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const src = img.getAttribute("src") || "";
        return src.length > 0 && img.complete && img.naturalWidth === 0;
      })
      .map((img) => img.getAttribute("alt") || img.getAttribute("src") || "img");

    return {
      scrollWidth: doc.scrollWidth,
      innerWidth: window.innerWidth,
      brokenImages,
    };
  });

  expect(
    metrics.scrollWidth,
    `[${projectName}:${screenSlug}] Horizontal overflow detected (${metrics.scrollWidth} > ${metrics.innerWidth})`,
  ).toBeLessThanOrEqual(metrics.innerWidth + 1);

  expect(
    metrics.brokenImages,
    `[${projectName}:${screenSlug}] Broken images detected`,
  ).toEqual([]);

  // 2. Assert primary interactive controls meet >= 44px mobile touch target minimum
  for (const locator of interactiveLocators) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box, `[${projectName}:${screenSlug}] Missing bounding box`).not.toBeNull();
    expect(
      Math.round(box!.height),
      `[${projectName}:${screenSlug}] Touch target height < 44px (${box?.height}px)`,
    ).toBeGreaterThanOrEqual(44);
  }

  // 3. Persist acceptance screenshot
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const shotPath = path.join(SCREENSHOT_DIR, `${projectName}_${screenSlug}.png`);
  await page.screenshot({ path: shotPath, fullPage: false });
}

async function tapTopNav(page: Page, label: RegExp, expectedUrl: RegExp) {
  const navLink = page
    .getByRole("navigation", { name: /Điều hướng dành cho ba mẹ/i })
    .getByRole("link", { name: label });
  await navLink.scrollIntoViewIfNeeded();
  await navLink.click();
  await page.waitForURL(expectedUrl, { timeout: 25_000 });
}

test.describe("Mobile & Android WebView Full UI + OCR Parity E2E", () => {
  test("completes full Parent & Child flow across Login -> Dashboard -> My Books -> Books -> Reading (TTS + Mic) -> Book Scanner OCR -> Management -> Sessions -> Reports -> Logout with 0 overflow & 0 runtime errors", async ({
    page,
  }, testInfo) => {
    const stack = readStackInfo();
    const projectName = testInfo.project.name;

    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    let isSigningOut = false;

    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (text.includes("favicon.ico")) return;
        if (isSigningOut && text.includes("status of 401")) return;
        consoleErrors.push(text);
      }
    });

    // 1. Login Screen
    await page.goto("/login");
    const loginSubmit = page.getByRole("button", { name: /^Đăng nhập$/ });
    await expect(loginSubmit).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "01_login", [loginSubmit]);

    await page.getByLabel("Email của ba mẹ").fill(stack.users.parent_a.email);
    await page.getByLabel("Mật khẩu").fill(stack.users.parent_a.password);
    await loginSubmit.click();
    await page.waitForURL((url) => url.pathname.startsWith("/dashboard"), {
      timeout: 30_000,
    });

    // 2. Dashboard + Select Child Profile
    const childBtn = page.getByRole("button", {
      name: new RegExp(`^${stack.users.parent_a.child_alias}, lớp`, "i"),
    });
    await expect(childBtn).toBeVisible();
    await childBtn.click();
    await expect(childBtn).toHaveAttribute("aria-pressed", "true");
    const chooseBookBtn = page.getByRole("button", { name: /^Chọn sách$/i });
    await assertMobileScreenHealth(page, projectName, "02_dashboard", [
      childBtn,
      chooseBookBtn,
    ]);

    // 3. My Books (/my-books) — Create Private Book + Real OCR + Tool Check + Add Page
    await tapTopNav(page, /^Sách của tôi$/i, /\/my-books$/);
    const createPrivateBtn = page.getByRole("button", {
      name: /Tạo sách riêng/i,
    });
    await expect(createPrivateBtn).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "03_my_books", [
      createPrivateBtn,
    ]);

    let readableBookId = fs.existsSync(SHARED_BOOK_ID_CACHE)
      ? fs.readFileSync(SHARED_BOOK_ID_CACHE, "utf-8").trim()
      : "";

    if (!readableBookId || projectName === "android-360x800") {
      await createPrivateBtn.click();
      const bookTitle = `Sách Gia Đình Mobile ${Date.now()}`;
      await page.getByLabel(/Tên sách/i).fill(bookTitle);
      const saveBookBtn = page.getByRole("button", {
        name: /Lưu và thêm trang/i,
      });
      await assertMobileScreenHealth(page, projectName, "03b_my_books_create", [
        saveBookBtn,
      ]);
      await saveBookBtn.click();
      await page.waitForURL(/\/my-books\/([0-9a-f-]+)/i, { timeout: 25_000 });
      const match = page.url().match(/\/my-books\/([0-9a-f-]+)/i);
      expect(match).not.toBeNull();
      readableBookId = match![1];

      const privateFileInput = page.getByLabel(
        /Chọn tệp trang sách hoặc tài liệu/i,
      );
      await privateFileInput.setInputFiles(stack.assets.clean_png);
      const uploadCheckBtn = page.getByRole("button", {
        name: /Tải lên & kiểm tra/i,
      });
      await assertMobileScreenHealth(
        page,
        projectName,
        "03c_my_book_detail_upload",
        [uploadCheckBtn],
      );
      await uploadCheckBtn.click();

      const addPageBtn = page.getByRole("button", {
        name: /Thêm trang vào sách/i,
      });
      await expect(addPageBtn).toBeEnabled({ timeout: 90_000 });
      await addPageBtn.click();
      await expect(
        page.getByText(/Đã thêm vào sách đọc|Đã thêm trang/i).first(),
      ).toBeVisible({ timeout: 25_000 });
      fs.writeFileSync(SHARED_BOOK_ID_CACHE, readableBookId, "utf-8");
    } else {
      const detailLink = page
        .locator(`a[href="/my-books/${readableBookId}"]`)
        .first();
      await expect(detailLink).toBeVisible();
      await detailLink.click();
      await page.waitForURL(new RegExp(`/my-books/${readableBookId}`), {
        timeout: 25_000,
      });
      await assertMobileScreenHealth(page, projectName, "03c_my_book_detail");
    }

    // 4. Open Book Library (/books) & Ready Book Detail (/books/[bookId]) keeping Bé An selected
    await tapTopNav(page, /^Tổng quan$/i, /\/dashboard/);
    const childBtnCheck = page.getByRole("button", {
      name: new RegExp(`^${stack.users.parent_a.child_alias}, lớp`, "i"),
    });
    if ((await childBtnCheck.getAttribute("aria-pressed")) !== "true") {
      await childBtnCheck.click();
    }
    await page.getByRole("button", { name: /^Chọn sách$/i }).click();
    await page.waitForURL(/\/books$/, { timeout: 25_000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "04_books_library");

    const openReadyBook = page
      .locator(`a[href*="/books/${readableBookId}"]`)
      .first();
    await expect(openReadyBook).toBeVisible();
    await openReadyBook.click();
    await page.waitForURL(new RegExp(`/books/${readableBookId}`), {
      timeout: 25_000,
    });

    const prepReadingBtn = page.getByRole("button", { name: "Chuẩn bị đọc" });
    if (!(await prepReadingBtn.isEnabled())) {
      const thumb = page
        .getByLabel("Các trang sách có thể xem trước")
        .locator("button")
        .first();
      await thumb.click();
    }
    await expect(prepReadingBtn).toBeEnabled();
    await assertMobileScreenHealth(page, projectName, "05_book_detail", [
      prepReadingBtn,
    ]);

    // 5. Reading Preparation -> Microphone Check -> Live Reading Session (TTS + Mic)
    await prepReadingBtn.click();
    await page.waitForURL(/\/reading-preparation/, { timeout: 25_000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const checkMicBtn = page.getByRole("button", {
      name: /Kiểm tra và cấp quyền microphone/i,
    });
    if (await checkMicBtn.isVisible().catch(() => false)) {
      await checkMicBtn.click();
    }

    const startSessionBtn = page.getByRole("button", {
      name: /^Bắt đầu đọc$/i,
    });
    await expect(startSessionBtn).toBeEnabled({ timeout: 20_000 });
    await assertMobileScreenHealth(page, projectName, "06_reading_preparation", [
      startSessionBtn,
    ]);

    await startSessionBtn.click();
    await page.waitForURL(/\/reading\/[0-9a-f-]+/i, { timeout: 25_000 });

    // Inside /reading/[sessionId], tap the child reading-room "Bắt đầu đọc" gate to open the live page + mic
    const inRoomStartBtn = page.getByRole("button", { name: /^Bắt đầu đọc$/i });
    await expect(inRoomStartBtn).toBeVisible({ timeout: 20_000 });
    await assertMobileScreenHealth(
      page,
      projectName,
      "07a_reading_room_ready",
      [inRoomStartBtn],
    );
    await inRoomStartBtn.click();

    await expect(page.getByText(/Mèo/i).first()).toBeVisible({
      timeout: 25_000,
    });
    const pauseSessionBtn = page.getByRole("button", {
      name: /Tạm dừng buổi đọc/i,
    });
    const ttsModelBtn = page.getByRole("button", {
      name: /Nghe đọc mẫu cả trang/i,
    });
    await assertMobileScreenHealth(page, projectName, "07_reading_session", [
      pauseSessionBtn,
      ttsModelBtn,
    ]);

    // Return to Dashboard and re-select Bé An for Book Scanner & Parent navigation
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: /Góc đọc gia đình/i }),
    ).toBeVisible({ timeout: 25_000 });
    const childBtnScanner = page.getByRole("button", {
      name: new RegExp(`^${stack.users.parent_a.child_alias}, lớp`, "i"),
    });
    if ((await childBtnScanner.getAttribute("aria-pressed")) !== "true") {
      await childBtnScanner.click();
    }

    // 6. Book Scanner (/book-scanner) — Portrait Camera + Real Local OCR Upload
    await page.getByRole("button", { name: /Quét sách/i }).click();
    await page.waitForURL(/\/book-scanner/, { timeout: 25_000 });

    const startCamBtn = page.getByRole("button", {
      name: /Bật camera để quét/i,
    });
    const nativeCamBtn = page.getByRole("button", {
      name: /Chụp bằng Camera máy/i,
    });
    const pickOcrBtn = page.getByRole("button", {
      name: /Chọn ảnh trang sách \(OCR\)/i,
    });
    await expect(startCamBtn).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "08_book_scanner_idle", [
      startCamBtn,
      nativeCamBtn,
      pickOcrBtn,
    ]);

    await startCamBtn.click();
    const manualShutterBtn = page.getByRole("button", {
      name: /Chụp & Quét ngay/i,
    });
    await expect(manualShutterBtn).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "08b_book_scanner_live", [
      manualShutterBtn,
    ]);

    if (projectName === "android-390x844") {
      // Run full real PaddleOCR + VietOCR upload on the primary mobile viewport
      const scannerFileInput = page.getByTestId("local-ocr-file-input");
      await scannerFileInput.setInputFiles(stack.assets.clean_png);
      const ocrResultText = page.getByTestId("local-ocr-text");
      await expect(ocrResultText).toBeVisible({ timeout: 150_000 });
      await expect(ocrResultText).toContainText(/Mèo con đi học/i);
      await assertMobileScreenHealth(
        page,
        projectName,
        "08c_book_scanner_ocr_result",
      );
    }

    // 7. Reading Management, Sessions, Reports, Difficult Words, Entertainment via top nav
    await tapTopNav(page, /^Quản lý đọc$/i, /\/reading-management/);
    await expect(page.locator("h1, h2").first()).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "09_reading_management");

    await tapTopNav(page, /^Lịch sử$/i, /\/sessions/);
    await expect(page.locator("h1, h2").first()).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "10_sessions_history");

    await tapTopNav(page, /^Tiến bộ$/i, /\/reports$/);
    await expect(page.locator("h1, h2").first()).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "11_reports_progress");

    await tapTopNav(page, /^Từ cần luyện$/i, /\/reports\/difficult-words/);
    await expect(page.locator("h1, h2").first()).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "12_difficult_words");

    await tapTopNav(page, /^Giải trí$/i, /\/entertainment/);
    await expect(page.locator("h1, h2").first()).toBeVisible();
    await assertMobileScreenHealth(page, projectName, "13_entertainment");

    // 8. Clean Logout from Mobile Header Account Menu
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const accountBtn = page.getByRole("button", {
      name: /Mở menu tài khoản/i,
    });
    await expect(accountBtn).toBeVisible();
    await accountBtn.click();
    const signOutItem = page.getByRole("menuitem", { name: /Đăng xuất/i });
    await expect(signOutItem).toBeVisible();
    isSigningOut = true;
    await signOutItem.click();
    await page.waitForURL((url) => url.pathname.startsWith("/login"), {
      timeout: 25_000,
    });

    expect(pageErrors, `[${projectName}] Uncaught pageerror(s)`).toEqual([]);
    expect(consoleErrors, `[${projectName}] Unexpected console.error(s)`).toEqual([]);
  });
});
