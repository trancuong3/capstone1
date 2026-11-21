import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

interface AcceptanceAccountsFile {
  parent_a: {
    email: string;
    password: string;
    user_id: string;
    child_id: string;
    child_alias: string;
  };
  parent_b: {
    email: string;
    password: string;
    user_id: string;
    child_id: string;
    child_alias: string;
  };
  eligible_book: {
    book_id: string;
    book_title: string;
    page_id: string;
    page_revision_id: string;
    page_number: number;
    sample_image_path: string;
  };
}

const ACCOUNTS_PATH =
  process.env.VIREAD_ACCEPTANCE_ACCOUNTS ||
  "F:\\c1\\viread-host-runtime\\acceptance-accounts.json";

const BACKEND_LOG_PATH =
  process.env.VIREAD_BACKEND_ERR_LOG ||
  "F:\\c1\\viread-host-runtime\\logs\\backend.err.log";
const BACKEND_OUT_LOG_PATH =
  process.env.VIREAD_BACKEND_OUT_LOG ||
  "F:\\c1\\viread-host-runtime\\logs\\backend.out.log";

function loadAccounts(): AcceptanceAccountsFile {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    throw new Error(
      `Missing acceptance accounts file at ${ACCOUNTS_PATH}. Run scripts/windows/Setup-ViReadAcceptanceAccounts.py first.`,
    );
  }
  return JSON.parse(
    fs.readFileSync(ACCOUNTS_PATH, "utf-8"),
  ) as AcceptanceAccountsFile;
}

async function signInRealParent(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel(/Email/i).fill(email);
  await page.getByLabel(/Mật khẩu/i).fill(password);
  await page.getByRole("button", { name: /^Đăng nhập$/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

test.describe("ViRead real LAN HTTPS + Windows Local OCR end-to-end acceptance", () => {
  test("full flow: real login -> select child -> local OCR photo scan -> matched page -> reading session -> finish -> reload history -> cross-account A/B isolation -> logout", async ({
    browser,
    baseURL,
  }) => {
    const accounts = loadAccounts();
    const lanOrigin = (baseURL || "https://192.168.1.4:8443").replace(
      /\/+$/,
      "",
    );
    const contextA = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
    const pageA = await contextA.newPage();

    // 1. Real Supabase email/password sign-in as Parent A
    await signInRealParent(
      pageA,
      accounts.parent_a.email,
      accounts.parent_a.password,
    );

    // 2. Select child profile on Dashboard and click "Quét sách" (exact real user flow)
    const childButton = pageA.getByRole("button", {
      name: new RegExp(accounts.parent_a.child_alias, "i"),
    });
    await expect(childButton).toBeVisible({ timeout: 20_000 });
    await childButton.click();

    const scanBookButton = pageA.getByRole("button", { name: /Quét sách/i });
    await expect(scanBookButton).toBeVisible({ timeout: 10_000 });
    await scanBookButton.click();
    await pageA.waitForURL(/\/book-scanner/, { timeout: 20_000 });
    await expect(
      pageA.getByRole("heading", { name: /Đưa trang sách vào khung camera/i }),
    ).toBeVisible({ timeout: 20_000 });

    // 3. Upload Vietnamese page photo via system file input -> real Windows FastAPI Local OCR
    let capturedScanResponse: Record<string, unknown> | null = null;
    let capturedRequestId = "";
    const ocrResponsePromise = pageA.waitForResponse(
      (res) =>
        res.url().includes("/_viread_api/reading/scan-page-ocr") &&
        res.request().method() === "POST",
      { timeout: 150_000 },
    );

    const fileInput = pageA.getByTestId("local-ocr-file-input");
    await fileInput.setInputFiles(accounts.eligible_book.sample_image_path);

    const ocrRes = await ocrResponsePromise;
    expect(ocrRes.status()).toBe(200);
    capturedRequestId = ocrRes.headers()["x-request-id"] || "";
    capturedScanResponse = (await ocrRes.json()) as Record<string, unknown>;

    expect(capturedScanResponse.status).toBe("SUCCEEDED");
    expect(
      (capturedScanResponse.provenance as Record<string, unknown>)
        .cloud_ocr_used,
    ).toBe(false);
    expect(capturedScanResponse.matched).toBe(true);
    expect(capturedScanResponse.matched_book_id).toBe(
      accounts.eligible_book.book_id,
    );
    expect(capturedRequestId).toBeTruthy();

    // Verify UI displays real Vietnamese OCR text and correlation IDs
    await expect(pageA.getByTestId("local-ocr-result")).toBeVisible({
      timeout: 15_000,
    });
    const uiText = await pageA.getByTestId("local-ocr-text").innerText();
    expect(uiText.trim().length).toBeGreaterThan(20);
    await expect(
      pageA.getByText(String(capturedScanResponse.scan_job_id)),
    ).toBeVisible();

    // Verify correlation ID in Windows backend logs (and zero OCR plaintext or Bearer JWT leaked!)
    const combinedLogs = [BACKEND_OUT_LOG_PATH, BACKEND_LOG_PATH]
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, "utf-8"))
      .join("\n");
    expect(combinedLogs).toContain(String(capturedScanResponse.scan_job_id));
    if (capturedRequestId) {
      expect(combinedLogs).toContain(capturedRequestId);
    }
    const plaintextSnippet = uiText.trim().slice(0, 24);
    if (plaintextSnippet.length >= 12) {
      expect(combinedLogs).not.toContain(plaintextSnippet);
    }
    expect(combinedLogs).not.toContain("Bearer ");

    // Grab Parent A's real Authorization header strictly in-memory from the authenticated OCR call
    const authHeaderA = ocrRes.request().headers()["authorization"] || "";
    expect(authHeaderA.startsWith("Bearer ")).toBe(true);

    // 4. Open matched book page -> start a REAL reading session -> complete it
    await pageA
      .getByRole("button", {
        name: new RegExp(
          `Mở Trang ${accounts.eligible_book.page_number} để bắt đầu đọc`,
          "i",
        ),
      })
      .click();
    await pageA.waitForURL(
      new RegExp(`/books/${accounts.eligible_book.book_id}`),
      { timeout: 20_000 },
    );

    // Create & finish a real reading session against Windows FastAPI using Parent A's real JWT
    const apiBase = `${lanOrigin}/_viread_api`;
    const headersA = {
      Authorization: authHeaderA,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const createRes = await pageA.request.post(`${apiBase}/reading/sessions`, {
      headers: headersA,
      data: {
        child_id: accounts.parent_a.child_id,
        book_id: accounts.eligible_book.book_id,
        mode: "PRACTICE",
        state: "CREATED",
        selected_page_id: accounts.eligible_book.page_id,
        selected_page_revision_id: accounts.eligible_book.page_revision_id,
        end_page_id: accounts.eligible_book.page_id,
      },
    });
    expect([200, 201]).toContain(createRes.status());
    const created = (await createRes.json()) as { Id: string };
    const createdSessionId = String(created.Id);
    expect(createdSessionId).toBeTruthy();

    const completeRes = await pageA.request.post(
      `${apiBase}/reading/sessions/${createdSessionId}/pages/${accounts.eligible_book.page_id}/complete`,
      { headers: headersA },
    );
    expect(completeRes.status()).toBe(200);

    const finishRes = await pageA.request.post(
      `${apiBase}/reading/sessions/${createdSessionId}/finish`,
      { headers: headersA },
    );
    expect(finishRes.status()).toBe(200);

    // 5. Open /sessions history, reload, verify history list & detail both persist!
    await pageA.goto(`/sessions?childId=${accounts.parent_a.child_id}`, {
      waitUntil: "networkidle",
    });
    await pageA.reload({ waitUntil: "networkidle" });
    await expect(
      pageA
        .getByText(new RegExp(accounts.eligible_book.book_title, "i"))
        .first(),
    ).toBeVisible({ timeout: 20_000 });

    await pageA.goto(`/sessions/${createdSessionId}`, {
      waitUntil: "networkidle",
    });
    await expect(
      pageA
        .getByText(new RegExp(accounts.eligible_book.book_title, "i"))
        .first(),
    ).toBeVisible({ timeout: 20_000 });

    // 6. Cross-account isolation: Parent B MUST NOT access Parent A's child or session!
    const contextB = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
    const pageB = await contextB.newPage();
    let authHeaderB = "";
    pageB.on("request", (req) => {
      if (
        !authHeaderB &&
        req.url().includes("/_viread_api/") &&
        req.headers()["authorization"]?.startsWith("Bearer ")
      ) {
        authHeaderB = req.headers()["authorization"];
      }
    });
    await signInRealParent(
      pageB,
      accounts.parent_b.email,
      accounts.parent_b.password,
    );
    await expect
      .poll(() => authHeaderB.startsWith("Bearer "), { timeout: 20_000 })
      .toBe(true);

    const headersB = {
      Authorization: authHeaderB,
      Accept: "application/json",
    };
    const rChild = await pageB.request.get(
      `${apiBase}/profiles/children/${accounts.parent_a.child_id}`,
      { headers: headersB },
    );
    const rHistory = await pageB.request.get(
      `${apiBase}/reading/history?child_id=${accounts.parent_a.child_id}`,
      { headers: headersB },
    );
    const rSession = await pageB.request.get(
      `${apiBase}/reading/history/${createdSessionId}`,
      { headers: headersB },
    );
    const isolation = {
      childStatus: rChild.status(),
      historyStatus: rHistory.status(),
      sessionStatus: rSession.status(),
    };

    expect(isolation.childStatus).toBe(404);
    expect(isolation.historyStatus).toBe(404);
    expect(isolation.sessionStatus).toBe(404);

    // 7. Parent A Logout + verify protected /dashboard redirects back to /login
    await pageA.goto("/dashboard", { waitUntil: "networkidle" });
    await pageA.getByRole("button", { name: /Mở menu tài khoản/i }).click();
    await pageA.getByRole("menuitem", { name: /Đăng xuất/i }).click();
    await pageA.waitForURL(/\/login/, { timeout: 20_000 });
    await pageA.goto("/dashboard", { waitUntil: "networkidle" });
    await expect(pageA).toHaveURL(/\/login/);

    // Save non-sensitive E2E proof JSON (zero credentials/tokens/plaintext)
    const proofPath = path.resolve(
      CURRENT_DIR,
      "../../../docs/android/E2E_REAL_LAN_PROOF.json",
    );
    fs.writeFileSync(
      proofPath,
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          lanOrigin,
          ocrScanJobId: capturedScanResponse.scan_job_id,
          ocrRequestId: capturedRequestId,
          ocrProvenance: capturedScanResponse.provenance,
          ocrWordCount: capturedScanResponse.word_count,
          matchedBookId: capturedScanResponse.matched_book_id,
          matchedPageNumber: accounts.eligible_book.page_number,
          readingSessionId: createdSessionId,
          historyPersistedAfterReload: true,
          logPrivacyVerified: true,
          logoutVerified: true,
          crossAccountIsolation: isolation,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    await contextB.close();
    await contextA.close();
  });
});
