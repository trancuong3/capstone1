import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

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
    parent_b: {
      id: string;
      email: string;
      password: string;
      child_id: string;
      child_alias: string;
    };
    admin: {
      id: string;
      email: string;
      password: string;
    };
  };
  assets: {
    clean_png: string;
    flagged_png: string;
    retry_png: string;
    replaced_png: string;
  };
}

const STACK_INFO_PATH =
  process.env.VIREAD_E2E_STACK_INFO ??
  path.join(os.tmpdir(), "viread_ppb_e2e_stack_info.json");
const SCREENSHOT_DIR =
  process.env.VIREAD_E2E_SCREENSHOT_DIR ??
  path.join(os.tmpdir(), "viread_ppb_e2e_screenshots");

function readStackInfo(): StackInfo {
  if (!fs.existsSync(STACK_INFO_PATH)) {
    throw new Error(
      `E2E stack info not found at ${STACK_INFO_PATH}. Start run_parent_private_books_e2e_stack.py first.`,
    );
  }
  return JSON.parse(fs.readFileSync(STACK_INFO_PATH, "utf-8")) as StackInfo;
}

async function setE2EMode(
  apiUrl: string,
  mode:
    | "real_ollama"
    | "flagged_medium"
    | "fail_tool_check_once"
    | "slow_then_stale",
  extra: Record<string, unknown> = {},
) {
  const res = await fetch(`${apiUrl}/_e2e/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, ...extra }),
  });
  expect(res.ok).toBe(true);
}

async function getAccessToken(
  authUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${authUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.ok).toBe(true);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function loginParent(
  page: Page,
  email: string,
  password: string,
  childAlias?: string,
) {
  await page.goto("/login");
  await page.getByLabel("Email của ba mẹ").fill(email);
  await page.getByLabel("Mật khẩu").fill(password);
  const submitBtn = page.getByRole("button", { name: /^Đăng nhập$/ });
  await expect(submitBtn).toBeEnabled();
  await submitBtn.click();
  await page.waitForURL((url) => url.pathname.startsWith("/dashboard"), {
    timeout: 25_000,
  });
  if (childAlias) {
    const childBtn = page.getByRole("button", {
      name: new RegExp(`^${childAlias}, lớp`, "i"),
    });
    await expect(childBtn).toBeVisible({ timeout: 15_000 });
    await childBtn.click();
    await expect(childBtn).toHaveAttribute("aria-pressed", "true");
  }
}

async function loginAdmin(page: Page, email: string, password: string) {
  await page.goto("/admin/login");
  const emailInput = page.getByLabel("Email quản trị");
  await expect(emailInput).toBeVisible();
  await emailInput.click();
  await emailInput.fill("");
  await emailInput.fill(email);
  await expect(emailInput).toHaveValue(email);
  await page.getByLabel("Mật khẩu").fill(password);
  await page.getByRole("button", { name: /^Đăng nhập$/ }).click();
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith("/admin/") && url.pathname !== "/admin/login",
    {
      timeout: 25_000,
    },
  );
}

async function saveShot(page: Page, name: string) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: true,
  });
}

async function openNewContext(
  browser: Browser,
  baseURL: string,
  viewport: { width: number; height: number } | null,
) {
  const ctx = await browser.newContext({
    baseURL,
    viewport: viewport ?? { width: 1440, height: 1000 },
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

test.describe.serial("Parent Private Books Real Full-Stack E2E", () => {
  test("Scenario 1: Clean pass with real local Ollama, Child A reading, and full cross-family + live image isolation", async ({
    browser,
    page,
    baseURL,
  }, testInfo) => {
    const info = readStackInfo();
    const tag = testInfo.project.name.includes("mobile") ? "mobile" : "desktop";
    const runId = Date.now().toString().slice(-4);
    const bookTitle = `Truyện Sạch Nhà An (${tag}-${runId})`;

    await setE2EMode(info.api_url, "real_ollama");

    // 1. Parent A logs in via real /login UI, selects Bé An, & opens Sách của tôi via nav link
    await loginParent(
      page,
      info.users.parent_a.email,
      info.users.parent_a.password,
      info.users.parent_a.child_alias,
    );
    await page.getByRole("link", { name: "Sách của tôi" }).first().click();
    await page.waitForURL(/\/my-books$/);
    await expect(
      page.getByRole("heading", { name: "Sách của tôi" }),
    ).toBeVisible();
    await expect(page.getByText(/Chỉ bạn và các hồ sơ trẻ/)).toBeVisible();

    // 2. Create private book
    await page.getByRole("button", { name: /Tạo sách riêng/ }).click();
    await page.getByLabel(/Tên sách/).fill(bookTitle);
    await page.getByLabel(/Tác giả/).fill("Gia đình bé An");
    await page.getByRole("button", { name: "Lưu và thêm trang" }).click();

    await page.waitForURL(/\/my-books\/[0-9a-f-]+$/i);
    const bookId = page.url().split("/my-books/")[1];
    expect(bookId).toBeTruthy();
    await expect(page.getByRole("heading", { name: bookTitle })).toBeVisible();

    // 3. Upload real Vietnamese PNG -> REAL OCR + Proofread + REAL local Ollama Tool Check
    await page
      .getByLabel(/Chọn tệp trang sách hoặc tài liệu/)
      .setInputFiles(info.assets.clean_png);
    await page.getByRole("button", { name: /Tải lên & kiểm tra/ }).click();

    // Wait for worker + real local Ollama to finish and enable Thêm trang vào sách
    const addPageBtn = page.getByRole("button", {
      name: /Thêm trang vào sách/,
    });
    await expect(addPageBtn).toBeEnabled({ timeout: 90_000 });
    await expect(page.getByText("Đạt — có thể thêm trang")).toBeVisible();

    // Verify real local Ollama proof recorded by backend
    const healthRes = await fetch(`${info.api_url}/_e2e/health`);
    const healthJson = (await healthRes.json()) as {
      last_real_ollama_proof: {
        tool_check_workflow_id: string;
        provider_events: Array<{ provider: string; model?: string }>;
      } | null;
    };
    expect(healthJson.last_real_ollama_proof).not.toBeNull();
    expect(
      healthJson.last_real_ollama_proof?.tool_check_workflow_id,
    ).toBeTruthy();
    expect(
      healthJson.last_real_ollama_proof?.provider_events.some(
        (ev) => ev.provider === "ollama_local",
      ),
    ).toBe(true);

    // 4. Parent A adds page to private book
    await addPageBtn.click();
    await expect(page.getByText("Đã thêm vào sách đọc").first()).toBeVisible();
    await saveShot(page, `s1_parent_my_book_ready_${tag}`);

    // 5. Child A opens private book to read via client-side link (keeps Bé An selected)
    const readLink = page.getByRole("link", { name: /Mở đọc cùng bé/ });
    await expect(readLink).toBeVisible();
    await readLink.click();
    await page.waitForURL(new RegExp(`/books/${bookId}$`));
    await expect(page.getByRole("heading", { name: bookTitle })).toBeVisible();
    await expect(page.getByText("Sách riêng của gia đình")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Chuẩn bị đọc" }),
    ).toBeEnabled();
    await saveShot(page, `s1_child_a_book_detail_${tag}`);

    // 6. Live Cross-Session Image Isolation Proof
    const tokenA = await getAccessToken(
      info.auth_url,
      info.users.parent_a.email,
      info.users.parent_a.password,
    );
    const tokenB = await getAccessToken(
      info.auth_url,
      info.users.parent_b.email,
      info.users.parent_b.password,
    );

    // Verify shared catalog default list does NOT expose A's private book
    const sharedCatRes = await fetch(`${info.api_url}/books/catalog`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(sharedCatRes.status).toBe(200);
    const sharedCat = (await sharedCatRes.json()) as Array<{ id: string }>;
    expect(sharedCat.some((b) => b.id === bookId)).toBe(false);

    // Get A's exact valid private image proxy URL
    const previewRes = await fetch(
      `${info.api_url}/books/catalog/${bookId}/preview`,
      { headers: { Authorization: `Bearer ${tokenA}` } },
    );
    expect(previewRes.status).toBe(200);
    const previews = (await previewRes.json()) as Array<{
      preview_url: string;
    }>;
    expect(previews.length).toBeGreaterThan(0);
    const exactImageUrl = previews[0].preview_url;
    expect(exactImageUrl).toContain(`/books/my-books/${bookId}/pages/`);

    // A gets 200 PNG with Cache-Control: private, no-store
    const imgA = await fetch(exactImageUrl, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(imgA.status).toBe(200);
    expect(imgA.headers.get("cache-control")?.toLowerCase()).toContain(
      "no-store",
    );

    // Logged-out / anonymous gets 401 on the exact valid image URL
    const imgAnon = await fetch(exactImageUrl);
    expect(imgAnon.status).toBe(401);

    // Parent B gets 404 on the EXACT valid image URL!
    const imgB = await fetch(exactImageUrl, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(imgB.status).toBe(404);

    // 7. Browser Isolation: Parent B logs in in fresh context -> cannot see book or open URLs
    const { ctx: ctxB, page: pageB } = await openNewContext(
      browser,
      baseURL ?? info.web_origin,
      page.viewportSize(),
    );
    try {
      await loginParent(
        pageB,
        info.users.parent_b.email,
        info.users.parent_b.password,
        info.users.parent_b.child_alias,
      );
      // Navigate to /books via dashboard CTA so Bé Bình stays selected in AppStore
      await pageB
        .getByRole("button", { name: /Chọn sách|Thư viện|Tủ sách/i })
        .first()
        .click();
      await pageB.waitForURL(/\/books$/);
      await expect(pageB.getByText("Chú Mèo Nhỏ")).toBeVisible();
      await expect(pageB.getByText(bookTitle)).toHaveCount(0);

      // Direct fixture URL /my-books/{bookId} -> blocked (404 empty state)
      await pageB.goto(`/my-books/${bookId}`);
      await expect(
        pageB.getByRole("heading", { name: "Không tìm thấy sách riêng" }),
      ).toBeVisible();

      // Direct API check for /books/catalog/{bookId} as Parent B -> 404 (plus no exposure via /books)
      const bCatalogDetail = await fetch(
        `${info.api_url}/books/catalog/${bookId}`,
        { headers: { Authorization: `Bearer ${tokenB}` } },
      );
      expect(bCatalogDetail.status).toBe(404);
    } finally {
      await ctxB.close();
    }
  });

  test("Scenario 2: Flagged Tool Check locks Add (UI+API) -> Admin Sách người dùng Request Changes -> Revised -> Admin Approve -> Add & Read", async ({
    browser,
    page,
    baseURL,
  }, testInfo) => {
    const info = readStackInfo();
    const tag = testInfo.project.name.includes("mobile") ? "mobile" : "desktop";
    const runId = Date.now().toString().slice(-4);
    const bookTitle = `Truyện Cần Duyệt (${tag}-${runId})`;

    await setE2EMode(info.api_url, "flagged_medium");

    // 1. Parent A creates book & uploads flagged page
    await loginParent(
      page,
      info.users.parent_a.email,
      info.users.parent_a.password,
      info.users.parent_a.child_alias,
    );
    await page.getByRole("link", { name: "Sách của tôi" }).first().click();
    await page.waitForURL(/\/my-books$/);
    await page.getByRole("button", { name: /Tạo sách riêng/ }).click();
    await page.getByLabel(/Tên sách/).fill(bookTitle);
    await page.getByRole("button", { name: "Lưu và thêm trang" }).click();
    await page.waitForURL(/\/my-books\/[0-9a-f-]+$/i);
    const bookId = page.url().split("/my-books/")[1];

    await page
      .getByLabel(/Chọn tệp trang sách hoặc tài liệu/)
      .setInputFiles(info.assets.flagged_png);
    await page.getByRole("button", { name: /Tải lên & kiểm tra/ }).click();

    // Wait for NEEDS_ADMIN_REVIEW
    await expect(page.getByText("Cần Admin duyệt").first()).toBeVisible({
      timeout: 45_000,
    });
    const addBtn = page.getByRole("button", { name: /Thêm trang vào sách/ });
    await expect(addBtn).toBeDisabled();
    await saveShot(page, `s2_parent_flagged_locked_${tag}`);

    // Verify BACKEND ALSO blocks add-page with 409!
    const tokenA = await getAccessToken(
      info.auth_url,
      info.users.parent_a.email,
      info.users.parent_a.password,
    );
    const detailRes = await fetch(`${info.api_url}/books/my-books/${bookId}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const detailJson = (await detailRes.json()) as {
      submissions: Array<{
        id: string;
        submission_version: number;
        candidate_hash: string;
      }>;
    };
    const subV1 = detailJson.submissions[0];
    const blockedAdd = await fetch(
      `${info.api_url}/books/my-books/${bookId}/submissions/${subV1.id}/add-page`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expected_submission_version: subV1.submission_version,
          expected_candidate_hash: subV1.candidate_hash,
        }),
      },
    );
    expect(blockedAdd.status).toBe(409);

    // 2. Parent A sends v1 to Admin
    await page.getByRole("button", { name: /Gửi Admin xem xét/ }).click();
    await page
      .getByLabel("Lời nhắn cho Admin")
      .fill("Mong Admin xem xét duyệt trang truyện gia đình này.");
    await page.getByRole("button", { name: /Xác nhận gửi Admin/ }).click();
    await expect(page.getByText("Đang chờ Admin").first()).toBeVisible();
    await expect(addBtn).toBeDisabled();

    // 3. Admin logs in -> Quality -> Sách người dùng -> Requests changes first!
    const { ctx: adminCtx, page: adminPage } = await openNewContext(
      browser,
      baseURL ?? info.web_origin,
      page.viewportSize(),
    );
    try {
      await loginAdmin(
        adminPage,
        info.users.admin.email,
        info.users.admin.password,
      );
      await adminPage.goto("/admin/metadata-quality");
      await adminPage.getByRole("tab", { name: "Sách người dùng" }).click();

      const itemCard = adminPage.locator("li", { hasText: bookTitle });
      await expect(itemCard).toBeVisible();
      await itemCard.getByRole("button", { name: "Mở để duyệt" }).click();

      // Sensitive excerpt collapsed by default
      const summary = adminPage.getByText("Xem đoạn nhạy cảm bị gắn cờ");
      await expect(summary).toBeVisible();
      const isOpen = await summary.evaluate(
        (el) =>
          (el.closest("details") as HTMLDetailsElement | null)?.open ?? true,
      );
      expect(isOpen).toBe(false);
      await saveShot(adminPage, `s2_admin_user_books_review_${tag}`);

      // Admin requests changes on v1
      await adminPage
        .getByLabel("Lý do quyết định Admin")
        .fill(
          "Đoạn văn v1 hơi bí ẩn, đề nghị phụ huynh chỉnh lại nhẹ nhàng hơn.",
        );
      await adminPage.getByRole("button", { name: /Yêu cầu sửa/ }).click();
      await expect(
        adminPage.getByText(/Đã gửi yêu cầu chỉnh sửa/),
      ).toBeVisible();

      // 4. Parent A refreshes -> still blocked -> edits text to create v2 -> sends v2 to Admin
      await page.getByRole("button", { name: /Làm mới trạng thái/ }).click();
      await expect(page.getByText(/Đoạn văn v1 hơi bí ẩn/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Thêm trang vào sách/ }),
      ).toBeDisabled();

      await page.getByRole("button", { name: /Sửa nội dung/ }).click();
      await page
        .getByLabel("Chỉnh sửa văn bản trang")
        .fill("Câu chuyện khu rừng sáng sủa với các bạn nhỏ vui vẻ đọc sách.");
      await page
        .getByRole("button", { name: /Lưu phiên bản mới & kiểm tra lại/ })
        .click();

      // v2 runs flagged_medium -> NEEDS_ADMIN_REVIEW -> Parent A sends v2 to Admin
      await expect(page.getByText(/Phiên bản v2/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText("Cần Admin duyệt").first()).toBeVisible({
        timeout: 45_000,
      });
      await page.getByRole("button", { name: /Gửi Admin xem xét/ }).click();
      await page
        .getByLabel("Lời nhắn cho Admin")
        .fill("Đã chỉnh sửa v2 cho nhẹ nhàng, nhờ Admin duyệt.");
      await page.getByRole("button", { name: /Xác nhận gửi Admin/ }).click();
      await expect(page.getByText("Đang chờ Admin").first()).toBeVisible();

      // 5. Admin approves exact v2
      await adminPage.getByRole("button", { name: /Tải lại hàng đợi/ }).click();
      const v2Card = adminPage.locator("li", { hasText: bookTitle });
      await expect(v2Card).toContainText("v2");
      await v2Card.getByRole("button", { name: "Mở để duyệt" }).click();
      await expect(adminPage.getByText(/Phiên bản v2/)).toBeVisible();
      await adminPage
        .getByLabel("Lý do quyết định Admin")
        .fill("Phiên bản v2 đã phù hợp cho bé đọc cùng phụ huynh.");
      await adminPage.getByRole("button", { name: /Duyệt bản này/ }).click();
      await expect(
        adminPage.getByText(/Đã phê duyệt đúng phiên bản v2/),
      ).toBeVisible();
    } finally {
      await adminCtx.close();
    }

    // 6. Parent A refreshes -> Add button is NOW ENABLED -> adds v2 -> Child A reads!
    await page.getByRole("button", { name: /Làm mới trạng thái/ }).click();
    await expect(
      page.getByText("Đã duyệt — có thể thêm trang").first(),
    ).toBeVisible();
    const unlockedAddBtn = page.getByRole("button", {
      name: /Thêm trang vào sách/,
    });
    await expect(unlockedAddBtn).toBeEnabled();
    await unlockedAddBtn.click();
    await expect(page.getByText("Đã thêm vào sách đọc").first()).toBeVisible();

    await page.getByRole("link", { name: /Mở đọc cùng bé/ }).click();
    await page.waitForURL(new RegExp(`/books/${bookId}$`));
    await expect(page.getByRole("heading", { name: bookTitle })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Chuẩn bị đọc" }),
    ).toBeEnabled();

    // Parent B is STILL rejected with 404
    const tokenB = await getAccessToken(
      info.auth_url,
      info.users.parent_b.email,
      info.users.parent_b.password,
    );
    const bRes = await fetch(`${info.api_url}/books/catalog/${bookId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(bRes.status).toBe(404);
  });

  test("Scenario 3: Provider error -> stage-preserving retry -> late stale worker result discarded after replace", async ({
    page,
  }, testInfo) => {
    const info = readStackInfo();
    const tag = testInfo.project.name.includes("mobile") ? "mobile" : "desktop";
    const runId = Date.now().toString().slice(-4);
    const bookTitle = `Truyện Thử Lại (${tag}-${runId})`;

    await setE2EMode(info.api_url, "fail_tool_check_once", {
      reset_fail_once: true,
    });

    await loginParent(
      page,
      info.users.parent_a.email,
      info.users.parent_a.password,
      info.users.parent_a.child_alias,
    );
    await page.getByRole("link", { name: "Sách của tôi" }).first().click();
    await page.waitForURL(/\/my-books$/);
    await page.getByRole("button", { name: /Tạo sách riêng/ }).click();
    await page.getByLabel(/Tên sách/).fill(bookTitle);
    await page.getByRole("button", { name: "Lưu và thêm trang" }).click();
    await page.waitForURL(/\/my-books\/[0-9a-f-]+$/i);

    // 1. Upload page -> Stage 1 OCR + Stage 2 Proofreading pass, Stage 3 fails ONCE -> CHECK_FAILED
    await page
      .getByLabel(/Chọn tệp trang sách hoặc tài liệu/)
      .setInputFiles(info.assets.retry_png);
    await page.getByRole("button", { name: /Tải lên & kiểm tra/ }).click();

    await expect(
      page.getByText("Kiểm tra lỗi — có thể thử lại").first(),
    ).toBeVisible({ timeout: 45_000 });
    // Stage 1 & Stage 2 preserved as Hoàn tất!
    await expect(page.getByText("Hoàn tất").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Thêm trang vào sách/ }),
    ).toBeDisabled();

    // 2. Click Thử lại kiểm tra -> Stage 3 retries via REAL local Ollama -> PASSED_READY_TO_ADD
    await page.getByRole("button", { name: /Thử lại kiểm tra/ }).click();
    await expect(page.getByText("Đạt — có thể thêm trang").first()).toBeVisible(
      { timeout: 90_000 },
    );
    await expect(
      page.getByRole("button", { name: /Thêm trang vào sách/ }),
    ).toBeEnabled();

    // 3. Stale worker discard when Parent A replaces file while v1 worker is in-flight!
    await setE2EMode(info.api_url, "slow_then_stale", {
      slow_delay_seconds: 3.0,
    });
    await page
      .getByLabel(/Chọn tệp trang sách hoặc tài liệu/)
      .setInputFiles(info.assets.retry_png);
    await page.getByRole("button", { name: /Tải lên & kiểm tra/ }).click();

    // Wait until slow v1 worker has actually started Stage 3
    const startedRes = await fetch(
      `${info.api_url}/_e2e/wait-slow-started?timeout=15`,
    );
    const startedJson = (await startedRes.json()) as { started: boolean };
    expect(startedJson.started).toBe(true);

    // Switch next worker run to flagged_medium & replace file on that in-flight submission -> v2
    await setE2EMode(info.api_url, "flagged_medium");
    const checkingCard = page.locator(
      'article[data-workflow-status="CHECKING"]',
    );
    await expect(checkingCard).toBeVisible();
    await checkingCard
      .locator('input[type="file"]')
      .setInputFiles(info.assets.replaced_png);

    // Wait > 4s so the old slow v1 worker finishes AND v2 worker finishes
    await expect(
      checkingCard.or(page.locator("article", { hasText: "Phiên bản v2" })),
    ).toContainText("Phiên bản v2", { timeout: 45_000 });
    const v2Card = page.locator("article", { hasText: "Phiên bản v2" });
    await expect(v2Card.getByText("Cần Admin duyệt")).toBeVisible({
      timeout: 45_000,
    });
    // Stale v1 PASSED result MUST NOT have overwritten v2!
    await expect(
      v2Card.getByRole("button", { name: /Thêm trang vào sách/ }),
    ).toBeDisabled();
  });
});
