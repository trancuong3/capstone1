import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { stringToBase64URL } from "@supabase/ssr";

import { authFixtureHeaders } from "./auth-fixture";

const API_BASE = "http://127.0.0.1:8000";
const NOW = "2026-11-21T10:00:00Z";
const BOOK_ID = "82000000-0000-4000-8000-000000000010";
const PAGE_ID = "83000000-0000-4000-8000-000000000011";
const PAGE_2_ID = "83000000-0000-4000-8000-000000000012";
const PAGE_4_ID = "83000000-0000-4000-8000-000000000014";
const REV_ID = "84000000-0000-4000-8000-000000000011";
const WORKFLOW_ID = "85000000-0000-4000-8000-000000000011";
const ADMIN_ID = "90000000-0000-4000-8000-000000000001";
const PARENT_A_ID = "91000000-0000-4000-8000-000000000001";
const PARENT_B_ID = "91000000-0000-4000-8000-000000000002";
const CHILD_ID = "92000000-0000-4000-8000-000000000001";
const IMAGE_SHA = "a".repeat(64);

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n+UAAAAASUVORK5CYII=",
  "base64",
);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeFakeJwt(sub: string, role: "admin" | "parent"): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 36000,
      iat: Math.floor(Date.now() / 1000) - 60,
      role: "authenticated",
      sub,
      user_metadata: { role },
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-e2e-signature`;
}

async function seedBrowserSession(
  context: BrowserContext,
  role: "admin" | "parent",
  userId = role === "admin" ? ADMIN_ID : PARENT_A_ID,
) {
  const accessToken = makeFakeJwt(userId, role);
  const sessionPayload = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 36000,
    expires_at: Math.floor(Date.now() / 1000) + 36000,
    refresh_token: "synthetic-refresh-token",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${role}@viread.local`,
      user_metadata: { role },
      app_metadata: { provider: "email" },
      created_at: NOW,
    },
  };
  const encoded = `base64-${stringToBase64URL(JSON.stringify(sessionPayload))}`;
  await context.addCookies([
    {
      name: "sb-example-auth-token",
      value: encoded,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await context.route("https://example.supabase.co/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionPayload.user),
    }),
  );
  return accessToken;
}

function attachHealthMonitors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("response", (res) => {
    if (res.status() >= 500) {
      serverErrors.push(`${res.status()} ${res.url()}`);
    }
  });

  return {
    assertClean(
      label: string,
      options?: { expectedHttpStatuses?: readonly number[] },
    ) {
      const allowedStatuses = options?.expectedHttpStatuses ?? [];
      const unexpectedConsoleErrors = consoleErrors.filter((message) => {
        if (
          allowedStatuses.some((status) =>
            message.includes(
              `Failed to load resource: the server responded with a status of ${status}`,
            ),
          )
        ) {
          return false;
        }
        return true;
      });
      expect(pageErrors, `[${label}] Unexpected uncaught page errors`).toEqual(
        [],
      );
      expect(serverErrors, `[${label}] Unexpected HTTP 5xx responses`).toEqual(
        [],
      );
      expect(
        unexpectedConsoleErrors,
        `[${label}] Unexpected console.error messages`,
      ).toEqual([]);
    },
  };
}

async function captureScreenshot(
  page: Page,
  projectName: string,
  name: string,
) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: path.join(dir, `${projectName}-${name}.png`),
    fullPage: true,
  });
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    metrics.scrollWidth,
    `[${label}] Horizontal overflow (${metrics.scrollWidth}px > ${metrics.clientWidth}px)`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 2);
}

interface MockWorkflowOptions {
  originalText?: string;
  proofreadText?: string;
  suitability?:
    | "SUITABLE"
    | "SUITABLE_WITH_GUIDANCE"
    | "REVIEW_REQUIRED"
    | "NOT_RECOMMENDED";
  safetyStatus?:
    | "PENDING"
    | "STALE"
    | "PROVISIONAL"
    | "CONFIRMED"
    | "AUTO_CONFIRMED"
    | "FAILED";
  imageSafetyStatus?:
    | "UNASSESSED_NO_VISION_MODEL"
    | "ADMIN_CONFIRMED_SAFE"
    | "ADMIN_FLAGGED_UNSAFE";
  findings?: Array<Record<string, unknown>>;
  provider?: string;
  model?: string;
  providerEvents?: Array<Record<string, unknown>>;
  rightsStatus?:
    | "UNASSESSED"
    | "INSUFFICIENT_EVIDENCE"
    | "CONCERN_FLAGGED"
    | "RIGHTS_REVIEWED";
  preloadWorkflow?: boolean;
}

function buildWords(text: string) {
  return text.split(/\s+/).map((word, index) => ({
    word_index: index,
    line_index: 0,
    text: word,
    normalized_text: word.toLowerCase(),
    bbox: [0.05 + index * 0.14, 0.2, 0.12, 0.08] as [
      number,
      number,
      number,
      number,
    ],
    ocr_confidence: 0.94,
    ocr_score_source: "paddleocr",
    ocr_review_status: "verified_candidate",
    review_color_group: "green",
    ocr_evidence: null,
  }));
}

async function setupOcrStateMock(page: Page, opts: MockWorkflowOptions = {}) {
  const originalText = opts.originalText ?? "Con meo nho di hoc";
  const proofreadText = opts.proofreadText ?? "Con mèo nhỏ đi học";
  const rightsStatus = opts.rightsStatus ?? "RIGHTS_REVIEWED";
  let revisionStatus: "NEEDS_REVIEW" | "VERIFIED" = "NEEDS_REVIEW";
  let draftText = originalText;

  const makeWorkflow = (overrides: Record<string, unknown> = {}) => {
    const candidateText =
      (overrides.candidate_text as string | undefined) ?? proofreadText;
    const candidateHash = sha256(candidateText);
    const safetyInputHash =
      (overrides.safety_input_hash as string | undefined) ?? candidateHash;
    return {
      workflow_id: WORKFLOW_ID,
      page_id: PAGE_ID,
      book_id: BOOK_ID,
      page_revision_id: REV_ID,
      status: "READY_FOR_ADMIN_REVIEW",
      stage: "READY_FOR_ADMIN_REVIEW",
      progress: { completed_chunks: 1, total_chunks: 1 },
      attempts: 1,
      error_code: null,
      original_ocr_hash: sha256(originalText),
      admin_input_hash: sha256(originalText),
      proofread_text: proofreadText,
      proofread_output_hash: sha256(proofreadText),
      corrections: [
        {
          word_index: 1,
          original: "meo",
          suggested: "mèo",
          reason: "Thiếu dấu huyền tiếng Việt",
          confidence: 0.96,
        },
      ],
      uncertain_word_indices: [],
      proofread_metadata: {
        provider: opts.provider ?? "ollama",
        model: opts.model ?? "qwen3-vl:4b-instruct-q4_K_M",
        run_id: "run-e2e-001",
        prompt_version: "ocr-proofread-v4",
        fallback_used: opts.provider === "ollama",
      },
      safety_metadata: {
        provider: opts.provider ?? "ollama",
        model: opts.model ?? "qwen3-vl:4b-instruct-q4_K_M",
        chunks_total: 1,
        chunks_completed: 1,
        all_chunks_completed: true,
        text_safety_status: opts.safetyStatus ?? "CONFIRMED",
        image_safety_status:
          opts.imageSafetyStatus ?? "UNASSESSED_NO_VISION_MODEL",
      },
      candidate_history: [],
      safety_history: [],
      review_history: [],
      candidate_text: candidateText,
      candidate_hash: candidateHash,
      candidate_version: 1,
      safety_input_hash: safetyInputHash,
      hash_match: candidateHash === safetyInputHash,
      suitability: opts.suitability ?? "SUITABLE",
      safety_status: opts.safetyStatus ?? "CONFIRMED",
      text_safety_status: opts.safetyStatus ?? "CONFIRMED",
      image_safety_status:
        opts.imageSafetyStatus ?? "UNASSESSED_NO_VISION_MODEL",
      image_safety_reviewed_at:
        opts.imageSafetyStatus === "ADMIN_CONFIRMED_SAFE" ? NOW : null,
      image_safety_reviewed_by:
        opts.imageSafetyStatus === "ADMIN_CONFIRMED_SAFE" ? ADMIN_ID : null,
      image_safety_image_sha256:
        opts.imageSafetyStatus === "ADMIN_CONFIRMED_SAFE" ? IMAGE_SHA : null,
      image_safety_reason:
        opts.imageSafetyStatus === "ADMIN_CONFIRMED_SAFE"
          ? "Ảnh minh họa rõ nét, an toàn"
          : null,
      source_image_sha256: IMAGE_SHA,
      all_chunks_completed: true,
      findings: opts.findings ?? [],
      provider_events: opts.providerEvents ?? [],
      ocr_approved_at: null,
      final_approved_text_hash: null,
      created_at: NOW,
      updated_at: NOW,
      ...overrides,
    };
  };

  let workflow: ReturnType<typeof makeWorkflow> | null = opts.preloadWorkflow
    ? makeWorkflow()
    : null;

  await page.route(`${API_BASE}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const method = req.method();

    if (pathname === "/e2e-assets/page-1.png") {
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: ONE_BY_ONE_PNG,
      });
    }

    if (pathname === `/books/admin/catalog/${BOOK_ID}` && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: BOOK_ID,
          name: "truyen-meo-nho",
          title: "Truyện Chú Mèo Nhỏ (Synthetic QA)",
          author: "Nhóm Biên Tập ViRead",
          min_grade: 1,
          max_grade: 3,
          lifecycle_status: "ACTIVE",
        }),
      });
    }

    if (
      pathname === `/books/admin/catalog/${BOOK_ID}/pages` &&
      method === "GET"
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            book_id: BOOK_ID,
            page_number: 1,
            processing: {
              page_id: PAGE_ID,
              page_revision_id: REV_ID,
              revision_no: 1,
              verification_status: revisionStatus,
              lifecycle_status: "ACTIVE",
              ocr_preview_metadata: {},
              verified_at: revisionStatus === "VERIFIED" ? NOW : null,
              current_verified_revision_id:
                revisionStatus === "VERIFIED" ? REV_ID : null,
            },
            text_preview: draftText,
          },
        ]),
      });
    }

    if (
      pathname === `/books/admin/pages/${PAGE_ID}/revisions` &&
      method === "GET"
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            page_revision_id: REV_ID,
            revision_no: 1,
            verification_status: revisionStatus,
            created_at: NOW,
            is_current_verified: revisionStatus === "VERIFIED",
          },
        ]),
      });
    }

    if (
      pathname === `/books/admin/pages/${PAGE_ID}/image` &&
      method === "GET"
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          page_id: PAGE_ID,
          page_revision_id: REV_ID,
          page_number: 1,
          preview_url: `${API_BASE}/e2e-assets/page-1.png`,
          width: 800,
          height: 1200,
        }),
      });
    }

    if (
      pathname === `/books/admin/pages/${PAGE_ID}/revisions/${REV_ID}` &&
      method === "GET"
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          page_id: PAGE_ID,
          page_revision_id: REV_ID,
          revision_no: 1,
          verification_status: revisionStatus,
          lifecycle_status: "ACTIVE",
          draft_text: draftText,
          words: buildWords(draftText),
          ocr_metadata: { source_image_sha256: IMAGE_SHA },
          created_at: NOW,
          verified_at: revisionStatus === "VERIFIED" ? NOW : null,
          verified_by: revisionStatus === "VERIFIED" ? ADMIN_ID : null,
        }),
      });
    }

    if (
      pathname === `/books/admin/pages/${PAGE_ID}/revisions/${REV_ID}/draft` &&
      method === "PUT"
    ) {
      const body = req.postDataJSON() as { draft_text: string };
      draftText = body.draft_text;
      if (workflow) {
        workflow = {
          ...workflow,
          safety_status: "STALE",
          text_safety_status: "STALE",
          hash_match: false,
        };
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          page_id: PAGE_ID,
          page_revision_id: REV_ID,
          revision_no: 1,
          verification_status: revisionStatus,
          lifecycle_status: "ACTIVE",
          draft_text: draftText,
          words: buildWords(draftText),
          ocr_metadata: { source_image_sha256: IMAGE_SHA },
          created_at: NOW,
          verified_at: null,
          verified_by: null,
        }),
      });
    }

    if (
      pathname ===
        `/books/admin/pages/${PAGE_ID}/revisions/${REV_ID}/ai-workflows/latest` &&
      method === "GET"
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(workflow),
      });
    }

    if (
      pathname === `/books/admin/pages/${PAGE_ID}/ai-workflows` &&
      method === "POST"
    ) {
      workflow = makeWorkflow();
      draftText = workflow.candidate_text ?? draftText;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(workflow),
      });
    }

    if (
      pathname ===
        `/books/admin/pages/${PAGE_ID}/ai-workflows/${WORKFLOW_ID}/candidate` &&
      method === "PATCH"
    ) {
      const body = req.postDataJSON() as {
        candidate_text: string;
        expected_candidate_version: number;
      };
      draftText = body.candidate_text;
      const newHash = sha256(body.candidate_text);
      const scannedHash = workflow?.safety_input_hash ?? sha256(proofreadText);
      const matchesSafety = newHash === scannedHash;
      workflow = makeWorkflow({
        ...(workflow ?? {}),
        candidate_text: body.candidate_text,
        candidate_hash: newHash,
        candidate_version: body.expected_candidate_version + 1,
        safety_input_hash: scannedHash,
        hash_match: matchesSafety,
        safety_status: matchesSafety
          ? (workflow?.safety_status ?? "CONFIRMED")
          : "STALE",
        text_safety_status: matchesSafety
          ? (workflow?.text_safety_status ?? "CONFIRMED")
          : "STALE",
        image_safety_status:
          workflow?.image_safety_status ?? "UNASSESSED_NO_VISION_MODEL",
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(workflow),
      });
    }

    if (
      pathname ===
        `/books/admin/pages/${PAGE_ID}/ai-workflows/${WORKFLOW_ID}/image-safety-decision` &&
      method === "POST"
    ) {
      const body = req.postDataJSON() as {
        status: "ADMIN_CONFIRMED_SAFE" | "ADMIN_FLAGGED_UNSAFE";
        reason?: string;
      };
      workflow = makeWorkflow({
        ...(workflow ?? {}),
        image_safety_status: body.status,
        image_safety_reviewed_at: NOW,
        image_safety_reviewed_by: ADMIN_ID,
        image_safety_image_sha256: IMAGE_SHA,
        image_safety_reason: body.reason ?? null,
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(workflow),
      });
    }

    if (
      pathname === `/books/admin/pages/${PAGE_ID}/verify` &&
      method === "POST"
    ) {
      const body = req.postDataJSON() as {
        workflow_id?: string;
        corrected_text: string;
        proofread_audit?: { mode?: string };
      };
      if (body.proofread_audit?.mode === "AI_AUTO_VERIFIED") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: { code: "AI_AUTO_VERIFY_DISABLED", message: "Disabled" },
          }),
        });
      }
      if (!body.workflow_id || !workflow) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: { code: "WORKFLOW_REQUIRED", message: "Workflow required" },
          }),
        });
      }
      if (rightsStatus !== "RIGHTS_REVIEWED") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: {
              code:
                rightsStatus === "CONCERN_FLAGGED"
                  ? "RIGHTS_CONCERN_BLOCKED"
                  : "RIGHTS_EVIDENCE_REQUIRED",
              message: "Rights evidence required",
            },
          }),
        });
      }
      if (
        !workflow.hash_match ||
        sha256(body.corrected_text) !== workflow.candidate_hash
      ) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: {
              code: "CANDIDATE_HASH_MISMATCH",
              message: "Candidate hash mismatch",
            },
          }),
        });
      }
      const hasHigh =
        workflow.suitability === "NOT_RECOMMENDED" ||
        workflow.findings.some(
          (f) => String(f.severity ?? "").toUpperCase() === "HIGH",
        );
      if (hasHigh) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: {
              code: "TEXT_SAFETY_HIGH_RISK_BLOCKED",
              message: "High risk blocked",
            },
          }),
        });
      }
      if (workflow.image_safety_status !== "ADMIN_CONFIRMED_SAFE") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: {
              code:
                workflow.image_safety_status === "ADMIN_FLAGGED_UNSAFE"
                  ? "IMAGE_SAFETY_FLAGGED_UNSAFE"
                  : "IMAGE_SAFETY_UNASSESSED",
              message: "Image safety confirmation required",
            },
          }),
        });
      }

      revisionStatus = "VERIFIED";
      draftText = body.corrected_text;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          page_id: PAGE_ID,
          page_revision_id: REV_ID,
          revision_no: 1,
          verification_status: "VERIFIED",
          lifecycle_status: "ACTIVE",
          draft_text: draftText,
          words: buildWords(draftText),
          ocr_metadata: { source_image_sha256: IMAGE_SHA },
          created_at: NOW,
          verified_at: NOW,
          verified_by: ADMIN_ID,
        }),
      });
    }

    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Not found" }),
    });
  });
}

test.describe("Admin AI Quality, Rights, Safety & Parent Reports E2E", () => {
  test("E2E 1: AI proofreading + Child Safety clean + Admin image confirmation -> Verify -> VERIFIED", async ({
    page,
    context,
  }, testInfo) => {
    await page.setExtraHTTPHeaders(authFixtureHeaders("admin"));
    await seedBrowserSession(context, "admin");
    const monitor = attachHealthMonitors(page);
    await setupOcrStateMock(page, {
      rightsStatus: "RIGHTS_REVIEWED",
      imageSafetyStatus: "UNASSESSED_NO_VISION_MODEL",
      preloadWorkflow: false,
    });

    await page.goto(`/admin/books/${BOOK_ID}/pages/${PAGE_ID}`);
    await expect(
      page.getByRole("heading", { name: /Kiểm tra OCR · R1/ }),
    ).toBeVisible();

    // Run combined AI workflow (Proofreading + Child Safety)
    await page.getByRole("button", { name: "XÁC NHẬN & CHẠY AI" }).click();
    await expect(page.getByTestId("admin-ai-workflow")).toBeVisible();

    // Accept AI suggestions first
    await page
      .getByRole("button", { name: "Chọn tất cả", exact: true })
      .click();
    await page.getByRole("button", { name: "Xác nhận lựa chọn gợi ý" }).click();

    // Image safety panel is visible and blocks Verify until Admin reviews the image
    await expect(page.getByTestId("image-safety-review-panel")).toBeVisible();
    const verifyBtn = page.getByRole("button", {
      name: "XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG",
    });
    await expect(verifyBtn).toBeDisabled();

    // Admin manually confirms image safety
    await page
      .getByPlaceholder("Ví dụ: Ảnh minh họa rõ nét, phù hợp học sinh tiểu học")
      .fill("Ảnh minh họa rõ nét, an toàn cho học sinh tiểu học");
    await page.getByRole("button", { name: /Xác nhận ảnh an toàn/ }).click();
    await expect(page.getByTestId("image-safety-status")).toContainText(
      "Admin đã xác nhận ảnh an toàn",
    );

    // Now Verify button unlocks and Admin verifies explicitly
    await expect(verifyBtn).toBeEnabled();
    await verifyBtn.click();

    await expect(page.getByText(/Đã xác minh revision/).first()).toBeVisible();
    await assertNoHorizontalOverflow(page, "E2E 1");
    await captureScreenshot(page, testInfo.project.name, "e2e1-ocr-verified");
    monitor.assertClean("E2E 1");
  });

  test("E2E 2: Cloud failure -> Ollama local fallback provenance visible, never auto-verifies", async ({
    page,
    context,
  }, testInfo) => {
    await page.setExtraHTTPHeaders(authFixtureHeaders("admin"));
    await seedBrowserSession(context, "admin");
    const monitor = attachHealthMonitors(page);
    await setupOcrStateMock(page, {
      provider: "ollama",
      model: "qwen3-vl:4b-instruct-q4_K_M",
      providerEvents: [
        {
          stage: "proofread",
          provider: "gemini",
          status: "failed",
          error_code: "HTTP_429",
        },
        {
          stage: "proofread",
          provider: "groq",
          status: "failed",
          error_code: "HTTP_503",
        },
        {
          stage: "proofread",
          provider: "ollama",
          model: "qwen3-vl:4b-instruct-q4_K_M",
          status: "succeeded",
        },
      ],
      preloadWorkflow: false,
    });

    await page.goto(`/admin/books/${BOOK_ID}/pages/${PAGE_ID}`);
    await page.getByRole("button", { name: "XÁC NHẬN & CHẠY AI" }).click();

    const workflowCard = page.getByTestId("admin-ai-workflow");
    await expect(workflowCard).toBeVisible();
    await expect(workflowCard).toContainText(/ollama/i);
    // Must stay NEEDS_REVIEW (AI never auto-verifies)
    await expect(page.getByText("Đã xác minh revision")).toHaveCount(0);

    await assertNoHorizontalOverflow(page, "E2E 2");
    await captureScreenshot(
      page,
      testInfo.project.name,
      "e2e2-ollama-fallback",
    );
    monitor.assertClean("E2E 2");
  });

  test("E2E 3: Child Safety HIGH / NOT_RECOMMENDED blocks verification in UI and backend API", async ({
    page,
    context,
  }, testInfo) => {
    await page.setExtraHTTPHeaders(authFixtureHeaders("admin"));
    const token = await seedBrowserSession(context, "admin");
    const monitor = attachHealthMonitors(page);
    await setupOcrStateMock(page, {
      originalText: "Nội dung bạo lực nguy hiểm",
      proofreadText: "Nội dung bạo lực nguy hiểm",
      suitability: "NOT_RECOMMENDED",
      safetyStatus: "CONFIRMED",
      imageSafetyStatus: "ADMIN_CONFIRMED_SAFE",
      findings: [
        {
          category: "VIOLENCE",
          severity: "HIGH",
          evidence_text: "bạo lực nguy hiểm",
          explanation: "Chứa nội dung bạo lực không phù hợp trẻ tiểu học",
          recommendation: "Loại bỏ hoặc thay thế trước khi sử dụng",
        },
      ],
      preloadWorkflow: true,
    });

    await page.goto(`/admin/books/${BOOK_ID}/pages/${PAGE_ID}`);
    await expect(page.getByTestId("admin-ai-workflow")).toBeVisible();
    // Verify stays disabled even though image is confirmed safe
    await expect(
      page.getByRole("button", {
        name: "XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG",
      }),
    ).toBeDisabled();

    // Direct API bypass attempt must also be rejected with 409 TEXT_SAFETY_HIGH_RISK_BLOCKED
    const directRes = await page.evaluate(
      async ({ apiBase, pageId, revId, workflowId, authToken }) => {
        const res = await fetch(
          `${apiBase}/books/admin/pages/${pageId}/verify`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              page_revision_id: revId,
              workflow_id: workflowId,
              corrected_text: "Nội dung bạo lực nguy hiểm",
              words: [],
            }),
          },
        );
        return { status: res.status, body: await res.json() };
      },
      {
        apiBase: API_BASE,
        pageId: PAGE_ID,
        revId: REV_ID,
        workflowId: WORKFLOW_ID,
        authToken: token,
      },
    );
    expect(directRes.status).toBe(409);
    expect(directRes.body.detail.code).toBe("TEXT_SAFETY_HIGH_RISK_BLOCKED");

    await assertNoHorizontalOverflow(page, "E2E 3");
    await captureScreenshot(
      page,
      testInfo.project.name,
      "e2e3-child-safety-blocked",
    );
    monitor.assertClean("E2E 3", { expectedHttpStatuses: [409] });
  });

  test("E2E 4: Editing draft after AI invalidates safety hash (CANDIDATE_HASH_MISMATCH)", async ({
    page,
    context,
  }) => {
    await page.setExtraHTTPHeaders(authFixtureHeaders("admin"));
    const token = await seedBrowserSession(context, "admin");
    const monitor = attachHealthMonitors(page);
    await setupOcrStateMock(page, {
      originalText: "Con mèo nhỏ đi học",
      proofreadText: "Con mèo nhỏ đi học",
      suitability: "SUITABLE",
      safetyStatus: "CONFIRMED",
      imageSafetyStatus: "ADMIN_CONFIRMED_SAFE",
      preloadWorkflow: true,
    });

    await page.goto(`/admin/books/${BOOK_ID}/pages/${PAGE_ID}`);
    await expect(page.getByTestId("admin-ai-workflow")).toBeVisible();
    const verifyBtn = page.getByRole("button", {
      name: "XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG",
    });
    await expect(verifyBtn).toBeEnabled();

    // Edit text in editor -> candidate sync marks safety STALE / hash_match=false
    const editor = page.getByLabel("Nội dung trang");
    await editor.fill("Con mèo nhỏ đi chợ mới");
    await expect(
      page.getByText(/Chưa khớp \/ cần quét lại|cần quét lại/i).first(),
    ).toBeVisible();
    await expect(verifyBtn).toBeDisabled();

    // Direct API verify attempt with stale text must return 409 CANDIDATE_HASH_MISMATCH
    const directRes = await page.evaluate(
      async ({ apiBase, pageId, revId, workflowId, authToken }) => {
        const res = await fetch(
          `${apiBase}/books/admin/pages/${pageId}/verify`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              page_revision_id: revId,
              workflow_id: workflowId,
              corrected_text: "Con mèo nhỏ đi chợ mới",
              words: [],
            }),
          },
        );
        return { status: res.status, body: await res.json() };
      },
      {
        apiBase: API_BASE,
        pageId: PAGE_ID,
        revId: REV_ID,
        workflowId: WORKFLOW_ID,
        authToken: token,
      },
    );
    expect(directRes.status).toBe(409);
    expect(directRes.body.detail.code).toBe("CANDIDATE_HASH_MISMATCH");

    await assertNoHorizontalOverflow(page, "E2E 4");
    monitor.assertClean("E2E 4", { expectedHttpStatuses: [409] });
  });

  test("E2E 5 & E2E 7: Book Quality rights gate + page diagnostics + unknown-page-count disclaimer", async ({
    page,
    context,
  }, testInfo) => {
    await page.setExtraHTTPHeaders(authFixtureHeaders("admin"));
    await seedBrowserSession(context, "admin");
    const monitor = attachHealthMonitors(page);

    let rightsState = {
      id: "86000000-0000-4000-8000-000000000001",
      book_id: BOOK_ID,
      page_id: null,
      scope: "BOOK" as const,
      status: "UNASSESSED" as
        | "UNASSESSED"
        | "INSUFFICIENT_EVIDENCE"
        | "CONCERN_FLAGGED"
        | "RIGHTS_REVIEWED",
      effective_status: "UNASSESSED",
      is_stale: false,
      source_description: null as string | null,
      author_or_rights_holder: null as string | null,
      usage_basis: null as string | null,
      evidence_url_or_ref: null as string | null,
      notes: null as string | null,
      version: 0,
      content_fingerprint: null as string | null,
      current_content_fingerprint: "b".repeat(64),
      reviewed_by: null as string | null,
      reviewed_by_name: null as string | null,
      reviewed_at: null as string | null,
      updated_at: null as string | null,
      history: [] as Array<Record<string, unknown>>,
    };
    let approvalStatus: "PENDING_ADMIN_REVIEW" | "APPROVED_BY_ADMIN" =
      "PENDING_ADMIN_REVIEW";
    const decisionHistory: Array<Record<string, unknown>> = [];

    const makeAssessment = () => ({
      status: approvalStatus,
      page_count: 3,
      ocr_completed_pages: 3,
      ocr_approval_valid_pages: 3,
      proofreading_status: "COMPLETED",
      proofreading_completed_pages: 3,
      proofreading_suggestion_count: 1,
      child_safety_status: "COMPLETED",
      child_safety_completed_pages: 3,
      processing_pages: 0,
      failed_pages: 0,
      stale_pages: 0,
      copyright_status: rightsState.effective_status,
      copyright_finding_count: null,
      finding_count: 0,
      high_finding_count: 0,
      medium_finding_count: 0,
      warning_page_count: 0,
      failed_or_unscanned_page_count: 0,
      finding_groups: [],
      assessment_hash: "c".repeat(64),
      assessed_at: NOW,
      admin_approved_at: approvalStatus === "APPROVED_BY_ADMIN" ? NOW : null,
      admin_approved_by:
        approvalStatus === "APPROVED_BY_ADMIN" ? ADMIN_ID : null,
      admin_approved_by_name:
        approvalStatus === "APPROVED_BY_ADMIN" ? "Admin QA" : null,
      admin_reason:
        approvalStatus === "APPROVED_BY_ADMIN"
          ? "Đã đối chiếu toàn bộ nội dung và bằng chứng quyền sử dụng"
          : null,
      publication_source:
        approvalStatus === "APPROVED_BY_ADMIN" ? "ADMIN_APPROVAL" : null,
      rights_confirmed: rightsState.effective_status === "RIGHTS_REVIEWED",
      blockers:
        rightsState.effective_status === "RIGHTS_REVIEWED"
          ? []
          : ["Chưa có hồ sơ bằng chứng quyền sử dụng được rà soát."],
    });

    await page.route(`${API_BASE}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const pathname = url.pathname;
      const method = req.method();

      if (pathname === "/books/admin/metadata-quality" && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            summary: {
              total_books: 1,
              books_with_issues: 0,
              missing_title: 0,
              missing_author: 0,
              invalid_grade_range: 0,
              possible_duplicate_groups: 0,
              books_in_duplicate_groups: 0,
              checked_at: NOW,
            },
            items: [],
            total: 0,
            limit: 20,
            offset: 0,
          }),
        });
      }

      if (pathname === "/books/admin/quality/reports" && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [],
            total: 0,
            summary: {
              OPEN: 0,
              UNDER_REVIEW: 0,
              RESOLVED: 0,
              REJECTED: 0,
            },
            limit: 20,
            offset: 0,
          }),
        });
      }

      if (pathname === "/books/admin/quality/books" && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [
              {
                book_id: BOOK_ID,
                book_title: "Truyện Chú Mèo Nhỏ (Synthetic QA)",
                report_count: 0,
                open_report_count: 0,
                finding_count: 0,
                needs_review_finding_count: 0,
                latest_scan: null,
                assessment: makeAssessment(),
              },
            ],
            total: 1,
            limit: 20,
            offset: 0,
            summary: { PENDING_ADMIN_REVIEW: 1 },
            alert_summary: { CHILD_SAFETY: 0, COPYRIGHT: 1, BOTH: 0 },
          }),
        });
      }

      if (
        pathname === `/books/admin/quality/books/${BOOK_ID}` &&
        method === "GET"
      ) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            book_id: BOOK_ID,
            book_title: "Truyện Chú Mèo Nhỏ (Synthetic QA)",
            reports: [],
            scans: [],
            latest_scan_detail: null,
            ai_workflows: [],
            ai_workflow_summary: {},
            assessment: makeAssessment(),
            rights_evidence: rightsState,
            page_diagnostics: [
              {
                page_id: PAGE_ID,
                page_number: 1,
                lifecycle_status: "ACTIVE",
                verification_status: "VERIFIED",
                codes: ["OK"],
                image_safety_status: "ADMIN_CONFIRMED_SAFE",
                text_safety_status: "CONFIRMED",
                summary: "Trang 1 đã xác minh đầy đủ",
              },
              {
                page_id: PAGE_2_ID,
                page_number: 2,
                lifecycle_status: "ACTIVE",
                verification_status: "NEEDS_REVIEW",
                codes: ["EMPTY_OCR", "UNVERIFIED_PAGE"],
                image_safety_status: "UNASSESSED_NO_VISION_MODEL",
                text_safety_status: "PENDING",
                summary:
                  "Trang 2 thiếu văn bản OCR và chưa được Admin xác minh",
              },
              {
                page_id: null,
                page_number: 3,
                lifecycle_status: null,
                verification_status: null,
                codes: ["SUSPECTED_MISSING_PAGE"],
                image_safety_status: null,
                text_safety_status: null,
                summary: "Nghi thiếu trang 3 giữa trang 2 và trang 4",
              },
              {
                page_id: PAGE_4_ID,
                page_number: 4,
                lifecycle_status: "ACTIVE",
                verification_status: "VERIFIED",
                codes: ["OK"],
                image_safety_status: "ADMIN_CONFIRMED_SAFE",
                text_safety_status: "CONFIRMED",
                summary: "Trang 4 đã xác minh đầy đủ",
              },
            ],
            completeness_disclaimer:
              "Hệ thống không biết tổng số trang vật lý gốc của sách; các khoảng trống số trang chỉ là dấu hiệu nghi thiếu trang để Admin đối chiếu bản gốc.",
            decision_history: decisionHistory,
          }),
        });
      }

      if (
        pathname === `/books/admin/quality/books/${BOOK_ID}/rights` &&
        method === "PUT"
      ) {
        const body = req.postDataJSON() as {
          status:
            | "UNASSESSED"
            | "INSUFFICIENT_EVIDENCE"
            | "CONCERN_FLAGGED"
            | "RIGHTS_REVIEWED";
          source_description?: string;
          author_or_rights_holder?: string;
          usage_basis?: string;
          evidence_url_or_ref?: string;
          notes?: string;
        };
        const nextVersion = rightsState.version + 1;
        rightsState = {
          ...rightsState,
          status: body.status,
          effective_status: body.status,
          source_description: body.source_description ?? null,
          author_or_rights_holder: body.author_or_rights_holder ?? null,
          usage_basis: body.usage_basis ?? null,
          evidence_url_or_ref: body.evidence_url_or_ref ?? null,
          notes: body.notes ?? null,
          version: nextVersion,
          content_fingerprint: "b".repeat(64),
          reviewed_by: ADMIN_ID,
          reviewed_by_name: "Admin QA",
          reviewed_at: NOW,
          updated_at: NOW,
          history: [
            {
              id: "87000000-0000-4000-8000-000000000001",
              version: nextVersion,
              from_status: "UNASSESSED",
              to_status: body.status,
              source_description: body.source_description ?? null,
              author_or_rights_holder: body.author_or_rights_holder ?? null,
              usage_basis: body.usage_basis ?? null,
              evidence_url_or_ref: body.evidence_url_or_ref ?? null,
              notes: body.notes ?? null,
              content_fingerprint: "b".repeat(64),
              actor_id: ADMIN_ID,
              actor_name: "Admin QA",
              created_at: NOW,
            },
          ],
        };
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(rightsState),
        });
      }

      if (
        pathname === `/books/admin/quality/books/${BOOK_ID}/decision` &&
        method === "POST"
      ) {
        const body = req.postDataJSON() as {
          decision: string;
          reason: string;
          rights_confirmed: boolean;
        };
        if (
          body.decision === "APPROVE" &&
          rightsState.effective_status !== "RIGHTS_REVIEWED"
        ) {
          return route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              detail: {
                code: "RIGHTS_EVIDENCE_REQUIRED",
                message: "Rights evidence required",
              },
            }),
          });
        }
        approvalStatus = "APPROVED_BY_ADMIN";
        decisionHistory.unshift({
          action: "APPROVE",
          actor_id: ADMIN_ID,
          actor_name: "Admin QA",
          created_at: NOW,
          reason: body.reason,
          assessment_hash: "c".repeat(64),
          category: null,
          rights_confirmed: true,
        });
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            book_id: BOOK_ID,
            assessment: makeAssessment(),
            decision_history: decisionHistory,
          }),
        });
      }

      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Not found" }),
      });
    });

    await page.goto("/admin/metadata-quality?tab=approval");
    await expect(
      page.getByRole("heading", { name: "Truyện Chú Mèo Nhỏ (Synthetic QA)" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Xem kết quả" }).first().click();

    // E2E 7: Per-page diagnostics & unknown physical page count disclaimer
    const diagnostics = page.getByTestId("book-page-diagnostics");
    await expect(diagnostics).toBeVisible();
    await expect(diagnostics).toContainText(/tổng số trang vật lý gốc/i);
    await expect(diagnostics).toContainText("Trang 2 thiếu văn bản OCR");
    await expect(diagnostics).toContainText("Nghi thiếu trang 3");

    await diagnostics.getByRole("button", { name: "Lỗi ảnh / OCR" }).click();
    await expect(diagnostics).toContainText("Trang 2");
    await diagnostics.getByRole("button", { name: "Tất cả" }).click();

    // E2E 5: Approve button must be locked until Rights Evidence is RIGHTS_REVIEWED
    const rightsPanel = page.getByTestId("book-rights-panel");
    await expect(rightsPanel).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Phê duyệt toàn bộ sách" }),
    ).toBeDisabled();

    // Admin fills and saves RIGHTS_REVIEWED with real evidence metadata
    await rightsPanel.locator("select").first().selectOption("RIGHTS_REVIEWED");
    const inputs = rightsPanel.locator("input[type='text']");
    await inputs.nth(0).fill("OPEN_LICENSE");
    await inputs.nth(1).fill("Truyện nội bộ ViRead biên soạn");
    await inputs.nth(2).fill("Nhóm ViRead");
    await inputs.nth(3).fill("docs/rights/viread-synthetic-001.pdf");
    await rightsPanel
      .getByRole("button", { name: "Lưu hồ sơ quyền sử dụng" })
      .click();

    await expect(page.getByText(/Đã lưu hồ sơ quyền sử dụng/)).toBeVisible();
    await expect(page.getByTestId("book-rights-status")).toContainText(
      "Đã rà soát quyền sử dụng",
    );

    // Book approval unlocks after rights review & reason entered
    const reasonInput = page.getByLabel("Lý do / ghi chú quyết định");
    await reasonInput.fill(
      "Đã đối chiếu toàn bộ nội dung, an toàn trẻ em và bằng chứng quyền sử dụng",
    );
    const approveBtn = page.getByRole("button", {
      name: "Phê duyệt toàn bộ sách",
    });
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();
    await expect(page.getByText(/Admin đã phê duyệt/).first()).toBeVisible();

    await assertNoHorizontalOverflow(page, "E2E 5 & 7");
    await captureScreenshot(
      page,
      testInfo.project.name,
      "e2e5-e2e7-book-quality-rights-diagnostics",
    );
    monitor.assertClean("E2E 5 & 7");
  });

  test("E2E 6: Parent submits CHILD_SAFETY_CONCERN -> Admin resolves -> Parent A views response -> Parent B isolated", async ({
    page,
    context,
  }, testInfo) => {
    const monitor = attachHealthMonitors(page);
    const REPORT_ID = "88000000-0000-4000-8000-000000000001";
    const reportsStore: Array<Record<string, unknown>> = [];

    // Shared stateful API router supporting Parent A, Admin, and Parent B checks
    await context.route(`${API_BASE}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const pathname = url.pathname;
      const method = req.method();
      const authHeader = req.headers()["authorization"] ?? "";
      const tokenPart = authHeader.replace(/^Bearer\s+/i, "");
      let callerSub = PARENT_A_ID;
      let callerRole: "admin" | "parent" = "parent";
      try {
        const decoded = JSON.parse(
          Buffer.from(tokenPart.split(".")[1] ?? "", "base64url").toString(
            "utf8",
          ),
        ) as { sub?: string; user_metadata?: { role?: "admin" | "parent" } };
        if (decoded.sub) callerSub = decoded.sub;
        if (decoded.user_metadata?.role)
          callerRole = decoded.user_metadata.role;
      } catch {
        // default parent A
      }

      const childProfile = {
        id: CHILD_ID,
        parent_id: PARENT_A_ID,
        alias: "Bé An",
        grade: 2,
        created_at: NOW,
        updated_at: NOW,
        settings: {},
        avatar_url: null,
      };

      if (pathname === "/profiles/me" && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: callerSub,
            display_name:
              callerRole === "admin" ? "Admin QA" : "Phụ huynh A (QA)",
            role: callerRole,
            created_at: NOW,
            email: `${callerRole}@viread.local`,
            email_verified: true,
            contact_info_status: "verified",
            children:
              callerRole === "parent"
                ? [{ id: CHILD_ID, alias: "Bé An", grade: 2 }]
                : [],
            avatar_url: null,
          }),
        });
      }

      if (pathname === "/profiles/children" && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([childProfile]),
        });
      }

      if (pathname === `/profiles/children/${CHILD_ID}` && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(childProfile),
        });
      }

      if (pathname === "/books/catalog" && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              id: BOOK_ID,
              title: "Truyện Chú Mèo Nhỏ (Synthetic QA)",
              author: "Nhóm ViRead",
              min_grade: 1,
              max_grade: 3,
              lifecycle_status: "ACTIVE",
            },
          ]),
        });
      }

      if (pathname === `/books/catalog/${BOOK_ID}` && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: BOOK_ID,
            title: "Truyện Chú Mèo Nhỏ (Synthetic QA)",
            author: "Nhóm ViRead",
            min_grade: 1,
            max_grade: 3,
            lifecycle_status: "ACTIVE",
          }),
        });
      }

      if (
        pathname === `/books/catalog/${BOOK_ID}/preview` &&
        method === "GET"
      ) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              page_id: PAGE_ID,
              page_number: 1,
              lifecycle_status: "ACTIVE",
              current_verified_revision_id: REV_ID,
              preview_url: `${API_BASE}/e2e-assets/page-1.png`,
            },
          ]),
        });
      }

      if (pathname === "/e2e-assets/page-1.png") {
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: ONE_BY_ONE_PNG,
        });
      }

      if (
        pathname === `/books/catalog/${BOOK_ID}/reports` &&
        method === "POST"
      ) {
        const body = req.postDataJSON() as {
          issue_type: string;
          description: string;
          page_id?: string;
        };
        const created = {
          id: REPORT_ID,
          book_id: BOOK_ID,
          book_title: "Truyện Chú Mèo Nhỏ (Synthetic QA)",
          reporter_id: callerSub,
          reporter_name: "Phụ huynh A (QA)",
          page_id: body.page_id ?? null,
          page_number: body.page_id ? 1 : null,
          page_revision_id: null,
          issue_type: body.issue_type,
          description: body.description,
          reported_text: null,
          suggested_correction: null,
          status: "OPEN",
          scan_run_id: null,
          verified_text_snapshot: null,
          content_hash_snapshot: null,
          admin_resolution_note: null,
          reviewed_by: null,
          reviewed_by_name: null,
          resolved_at: null,
          history: [
            {
              actor_name: "Phụ huynh A (QA)",
              from_status: null,
              to_status: "OPEN",
              note: null,
              created_at: NOW,
            },
          ],
          related_findings: [],
          created_at: NOW,
          updated_at: NOW,
        };
        reportsStore.push(created);
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(created),
        });
      }

      if (pathname === "/books/reports/mine" && method === "GET") {
        const mine = reportsStore.filter((r) => r.reporter_id === callerSub);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: mine,
            total: mine.length,
            limit: 20,
            offset: 0,
          }),
        });
      }

      if (pathname === `/books/reports/mine/${REPORT_ID}` && method === "GET") {
        const found = reportsStore.find(
          (r) => r.id === REPORT_ID && r.reporter_id === callerSub,
        );
        if (!found) {
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Resource not found" }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...found,
            // Internal admin scan findings are ALWAYS stripped for Parents
            related_findings: [],
          }),
        });
      }

      if (pathname === "/books/admin/metadata-quality" && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            summary: {
              total_books: 1,
              books_with_issues: 0,
              missing_title: 0,
              missing_author: 0,
              invalid_grade_range: 0,
              possible_duplicate_groups: 0,
              books_in_duplicate_groups: 0,
              checked_at: NOW,
            },
            items: [],
            total: 0,
            limit: 20,
            offset: 0,
          }),
        });
      }

      if (pathname === "/books/admin/quality/books" && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [],
            total: 0,
            limit: 20,
            offset: 0,
            summary: {},
            alert_summary: {},
          }),
        });
      }

      if (pathname === "/books/admin/quality/reports" && method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: reportsStore,
            total: reportsStore.length,
            summary: {
              OPEN: reportsStore.filter((r) => r.status === "OPEN").length,
              UNDER_REVIEW: reportsStore.filter(
                (r) => r.status === "UNDER_REVIEW",
              ).length,
              RESOLVED: reportsStore.filter((r) => r.status === "RESOLVED")
                .length,
              REJECTED: 0,
            },
            limit: 20,
            offset: 0,
          }),
        });
      }

      if (
        pathname === `/books/admin/quality/reports/${REPORT_ID}` &&
        method === "GET"
      ) {
        const found = reportsStore.find((r) => r.id === REPORT_ID);
        return route.fulfill({
          status: found ? 200 : 404,
          contentType: "application/json",
          body: JSON.stringify(found ?? { detail: "Resource not found" }),
        });
      }

      if (
        pathname === `/books/admin/quality/reports/${REPORT_ID}/status` &&
        method === "PATCH"
      ) {
        const body = req.postDataJSON() as {
          status: string;
          resolution_note?: string;
        };
        const found = reportsStore.find((r) => r.id === REPORT_ID);
        if (!found) {
          return route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Resource not found" }),
          });
        }
        found.status = body.status;
        found.admin_resolution_note = body.resolution_note ?? null;
        found.reviewed_by = ADMIN_ID;
        found.reviewed_by_name = "Admin QA";
        found.resolved_at = body.status === "RESOLVED" ? NOW : null;
        (found.history as Array<Record<string, unknown>>).push({
          actor_name: "Admin QA",
          from_status: "OPEN",
          to_status: body.status,
          note: body.resolution_note ?? null,
          created_at: NOW,
        });
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(found),
        });
      }

      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Not found" }),
      });
    });

    // Phase A: Parent A selects child profile, navigates via app router to book, submits CHILD_SAFETY_CONCERN report
    await page.setExtraHTTPHeaders(authFixtureHeaders("parent"));
    await seedBrowserSession(context, "parent", PARENT_A_ID);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /Bé An/ }).click();
    await page.getByRole("button", { name: "Chọn sách" }).click();
    await expect(page).toHaveURL(/\/books/, { timeout: 15_000 });
    await page
      .getByRole("link", { name: /Truyện Chú Mèo Nhỏ/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/books/${BOOK_ID}`), {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Báo lỗi sách" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("select").selectOption("CHILD_SAFETY_CONCERN");
    await dialog
      .locator("textarea")
      .first()
      .fill(
        "Đoạn văn có chi tiết đáng sợ cần Admin kiểm tra lại cho trẻ lớp 1.",
      );
    await dialog.getByRole("button", { name: /Gửi báo cáo/ }).click();
    await expect(dialog).toContainText(/Báo cáo đã được lưu thành công/i);

    // Phase B: Admin opens inbox, inspects and resolves report with resolution note
    await page.setExtraHTTPHeaders(authFixtureHeaders("admin"));
    await seedBrowserSession(context, "admin", ADMIN_ID);
    await page.goto("/admin/metadata-quality?tab=reports");
    await expect(page.getByText(/Đoạn văn có chi tiết đáng sợ/)).toBeVisible();
    await page.getByRole("button", { name: "Xem chi tiết" }).first().click();
    await page
      .locator("#report-resolution-note")
      .fill("Admin đã kiểm tra lại toàn bộ sách và chỉnh sửa từ ngữ phù hợp.");
    await page.getByRole("button", { name: "Giải quyết báo cáo" }).click();
    await expect(page.getByText("Đã giải quyết").first()).toBeVisible();

    // Phase C: Parent A visits /book-reports and sees Admin resolution response
    await page.setExtraHTTPHeaders(authFixtureHeaders("parent"));
    await seedBrowserSession(context, "parent", PARENT_A_ID);
    await page.goto("/book-reports");
    await expect(page.getByText("Đã xử lý")).toBeVisible();
    await page
      .getByRole("button", { name: "Xem chi tiết & phản hồi Admin" })
      .first()
      .click();
    await expect(
      page.getByText(
        "Admin đã kiểm tra lại toàn bộ sách và chỉnh sửa từ ngữ phù hợp.",
        { exact: true },
      ),
    ).toBeVisible();

    // Phase D: Parent B cannot read Parent A's report (404 IDOR check)
    const parentBToken = makeFakeJwt(PARENT_B_ID, "parent");
    const idorStatus = await page.evaluate(
      async ({ apiBase, reportId, token }) => {
        const res = await fetch(`${apiBase}/books/reports/mine/${reportId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return res.status;
      },
      { apiBase: API_BASE, reportId: REPORT_ID, token: parentBToken },
    );
    expect(idorStatus).toBe(404);

    await assertNoHorizontalOverflow(page, "E2E 6");
    await captureScreenshot(
      page,
      testInfo.project.name,
      "e2e6-parent-reports-resolved",
    );
    monitor.assertClean("E2E 6", { expectedHttpStatuses: [404] });
  });
});
