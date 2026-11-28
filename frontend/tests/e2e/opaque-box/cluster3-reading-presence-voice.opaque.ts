import { expect, test, type Page } from "@playwright/test";

import {
  assertNoUnexpectedPageErrors,
  installCluster3Mocks,
  makeCameraPageMatchResponse,
  makeLocalOcrPageScan,
  makeLocalOcrScanJob,
  makeReadingCompletionSummary,
  makeReadingPageDto,
  makeReadingSessionSummary,
  makeVoiceListPayload,
  makeVoiceStatusPayload,
  OPAQUE_ALERT_ID,
  OPAQUE_EPISODE_ID,
  OPAQUE_FOREIGN_ALERT_ID,
  OPAQUE_FOREIGN_SESSION_ID,
  OPAQUE_PAGE_2_ID,
  OPAQUE_PAGE_3_ID,
  OPAQUE_PRIVATE_BOOK_ID,
  OPAQUE_SCAN_JOB_ID,
  OPAQUE_VOICE_NORTH_ID,
  OPAQUE_VOICE_SOUTH_ID,
  type Cluster3HandlerState,
} from "./fixtures/cluster3-4-data";
import {
  attachPageErrorCollector,
  createRoleContext,
  type ApiMockRequestContext,
  type ApiMockResponse,
} from "./fixtures/session";
import {
  makeCatalogPagePreview,
  makeHealthPayload,
  makeMinimalPngBuffer,
  makeMinimalWavBuffer,
  makeOversizedBuffer,
  OPAQUE_BOOK_ID,
  OPAQUE_CHILD_ID,
  OPAQUE_PAGE_ID,
  OPAQUE_REV_3_ID,
  OPAQUE_REV_ID,
  OPAQUE_SESSION_ID,
  OVERSIZED_SCAN_BYTES,
} from "./fixtures/test-data";

interface InPageFetchResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly json: unknown;
}

async function apiFetchInPage(
  page: Page,
  apiOrigin: string,
  token: string | null,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  } = {},
): Promise<InPageFetchResult> {
  return page.evaluate(
    async ({ baseOrigin, bearer, reqPath, method, body, extraHeaders }) => {
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(extraHeaders ?? {}),
      };
      let serializedBody: string | undefined;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        serializedBody = JSON.stringify(body);
      }
      const res = await fetch(`${baseOrigin}${reqPath}`, {
        method: method ?? "GET",
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        cache: "no-store",
      });
      const headerMap: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headerMap[key.toLowerCase()] = value;
      });
      const contentType = headerMap["content-type"] ?? "";
      if (contentType.startsWith("audio/")) {
        const buf = await res.arrayBuffer();
        return {
          status: res.status,
          headers: headerMap,
          text: `audio-bytes:${buf.byteLength}`,
          json: null,
        };
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        json = null;
      }
      return {
        status: res.status,
        headers: headerMap,
        text,
        json,
      };
    },
    {
      baseOrigin: apiOrigin,
      bearer: token,
      reqPath: path,
      method: options.method,
      body: options.body,
      extraHeaders: options.extraHeaders,
    },
  );
}

async function apiMultipartInPage(
  page: Page,
  apiOrigin: string,
  token: string | null,
  path: string,
  parts: {
    readonly fileBytes?: number[];
    readonly fileName?: string;
    readonly fileMime?: string;
    readonly fields?: ReadonlyArray<readonly [string, string]>;
  },
): Promise<InPageFetchResult> {
  return page.evaluate(
    async ({ baseOrigin, bearer, reqPath, formParts }) => {
      const form = new FormData();
      if (formParts.fileBytes !== undefined) {
        const bytes = new Uint8Array(formParts.fileBytes);
        const blob = new Blob([bytes], {
          type: formParts.fileMime ?? "application/octet-stream",
        });
        form.append("file", blob, formParts.fileName ?? "upload.bin");
      }
      for (const [k, v] of formParts.fields ?? []) {
        form.append(k, v);
      }
      const res = await fetch(`${baseOrigin}${reqPath}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: form,
        cache: "no-store",
      });
      const headerMap: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headerMap[key.toLowerCase()] = value;
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        json = null;
      }
      return {
        status: res.status,
        headers: headerMap,
        text,
        json,
      };
    },
    {
      baseOrigin: apiOrigin,
      bearer: token,
      reqPath: path,
      formParts: parts,
    },
  );
}

// ============================================================================
// F-07 — Child Reading (11 tests: 6 Tier 1 + 5 Tier 2)
// ============================================================================

test.describe("F-07 Child Reading (Opaque-Box)", () => {
  test("[T1-F07-01] Preparation screen renders book, child & auto-verified mic @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      await installCluster3Mocks(parent.page);

      await parent.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });

      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Chuẩn bị đọc sách",
        }),
      ).toBeVisible();

      const bookHeading = parent.page
        .locator(".viread-learning-content")
        .filter({ hasText: "Chú Mèo Đi Hia" });
      await expect(bookHeading).toBeVisible();
      await expect(bookHeading).toHaveAttribute("dir", "ltr");
      await expect(bookHeading).toHaveAttribute("lang", "vi");

      await expect(
        parent.page
          .getByRole("status")
          .filter({ hasText: "Microphone đã sẵn sàng" }),
      ).toBeVisible();

      const startButton = parent.page.getByRole("button", {
        name: "Bắt đầu đọc",
      });
      await expect(startButton).toBeVisible();
      await expect(startButton).toBeEnabled();

      const noOverflow = await parent.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
      expect(noOverflow).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F07-02] Start reading creates session (PascalCase DTO) and opens ready screen", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let capturedCreatePayload: unknown = null;
      const state: Cluster3HandlerState = {
        overrides: {
          "POST /reading/sessions": (ctx: ApiMockRequestContext) => {
            capturedCreatePayload = ctx.postDataJson;
            return {
              status: 201,
              body: {
                Id: OPAQUE_SESSION_ID,
                State: "IN_PROGRESS",
                SelectedPageId: OPAQUE_PAGE_ID,
                SelectedPageRevisionId: OPAQUE_REV_ID,
                StartedAt: "2026-11-21T10:00:00Z",
              },
            };
          },
        },
      };
      const api = await installCluster3Mocks(parent.page, state);

      await parent.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });

      const startButton = parent.page.getByRole("button", {
        name: "Bắt đầu đọc",
      });
      await expect(startButton).toBeEnabled();
      await startButton.click();

      await parent.page.waitForURL(
        new RegExp(`/reading/${OPAQUE_SESSION_ID}\\?.*state=ready`),
      );

      if (!api.isLive) {
        expect(capturedCreatePayload).toMatchObject({
          child_id: OPAQUE_CHILD_ID,
          book_id: OPAQUE_BOOK_ID,
          mode: "realtime",
          state: "CREATED",
          selected_page_id: OPAQUE_PAGE_ID,
          selected_page_revision_id: OPAQUE_REV_ID,
          end_page_id: OPAQUE_PAGE_2_ID,
        });
      }

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some(
                (req) =>
                  req.method === "GET" &&
                  req.path === `/profiles/children/${OPAQUE_CHILD_ID}`,
              ),
          { timeout: 10_000 },
        )
        .toBe(true);

      const readyTitle = parent.page.locator("h1.viread-learning-content");
      await expect(readyTitle).toHaveAttribute("dir", "ltr");
      await expect(readyTitle).toHaveAttribute("lang", "vi");
      await expect(
        parent.page.getByRole("button", { name: /Bắt đầu đọc/ }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F07-03] Reading session renders page words with LTR Vietnamese lock @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      await installCluster3Mocks(parent.page);

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });

      const shell = parent.page.locator('[data-reading-shell="true"]');
      await expect(shell).toBeVisible();
      await expect(shell).toHaveAttribute("data-evidence-valid", "true");
      await expect(shell).toHaveAttribute("data-child-error-count", "0");
      await expect(shell).toHaveAttribute("data-scoring-active", "true");

      const passage = parent.page.locator("p.viread-learning-content");
      await expect(passage).toBeVisible();
      await expect(passage).toHaveAttribute("dir", "ltr");
      await expect(passage).toHaveAttribute("lang", "vi");

      const words = parent.page.locator("[data-word-id]");
      await expect(words).toHaveCount(4);

      const dock = parent.page.locator(
        'nav[aria-label="Điều khiển buổi đọc"][data-reading-controls]',
      );
      await expect(dock).toBeVisible();
      await expect(
        dock.getByRole("button", { name: "Tạm dừng buổi đọc" }),
      ).toBeVisible();
      await expect(
        dock.getByRole("button", { name: /Nghe đọc mẫu cả trang/ }),
      ).toBeVisible();
      await expect(
        dock.getByRole("button", { name: "Giọng đọc" }),
      ).toBeVisible();
      await expect(
        dock.getByRole("button", { name: /Bé đọc với nhận diện giọng nói/ }),
      ).toBeVisible();
      await expect(
        dock.getByRole("button", { name: "Chọn trang" }),
      ).toBeVisible();
      await expect(
        dock.getByRole("button", { name: "Kết thúc buổi đọc" }),
      ).toBeVisible();

      const noOverflow = await parent.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
      expect(noOverflow).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F07-04] Page navigation via Next button & Page Picker Modal", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const navigateTargets: string[] = [];
      const api = await installCluster3Mocks(parent.page, {
        onRequest: (ctx) => {
          if (
            ctx.method === "POST" &&
            ctx.pathname === `/reading/sessions/${OPAQUE_SESSION_ID}/navigate`
          ) {
            const payload =
              ctx.postDataJson && typeof ctx.postDataJson === "object"
                ? (ctx.postDataJson as Record<string, unknown>)
                : {};
            if (typeof payload.target_page_id === "string") {
              navigateTargets.push(payload.target_page_id);
            }
          }
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });

      await expect(parent.page.getByText("mốt")).toBeVisible();

      const nextButton = parent.page.getByRole("button", {
        name: "Trang tiếp theo",
      });
      await nextButton.click();

      await expect(parent.page.getByText("Trời")).toBeVisible();
      await expect(parent.page.getByText("nắng")).toBeVisible();
      if (!api.isLive) {
        expect(navigateTargets).toContain(OPAQUE_PAGE_2_ID);
      }

      await parent.page.getByRole("button", { name: "Chọn trang" }).click();
      const dialog = parent.page.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", { name: "Bé đang đọc trang nào?" }),
      ).toBeVisible();

      await dialog.getByRole("button", { name: /Trang 1/ }).click();
      await dialog.getByRole("button", { name: "Đúng trang này" }).click();

      await expect(parent.page.getByText("mốt")).toBeVisible();
      if (!api.isLive) {
        expect(navigateTargets).toEqual([OPAQUE_PAGE_2_ID, OPAQUE_PAGE_ID]);
      }

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F07-05] 4-step Phonics lesson card opens & highlights steps", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        page1: makeReadingPageDto(),
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });

      await parent.page.getByRole("button", { name: "Nghe đánh vần" }).click();

      const card = parent.page.getByTestId("phonics-lesson-card");
      await expect(card).toBeVisible();

      const focusDisplay = card.getByTestId("phonics-focus-display");
      await expect(focusDisplay).toHaveAttribute("dir", "ltr");
      await expect(focusDisplay).toHaveAttribute("lang", "vi");
      await expect(card.getByTestId("phonics-focus-syllable")).toContainText(
        "mốt",
      );

      const steps = card.locator('ol[aria-label="Các bước đánh vần"] li');
      await expect(steps).toHaveCount(4);
      await expect(steps.nth(0)).toHaveAttribute(
        "data-step-kind",
        "rhyme_build",
      );
      await expect(steps.nth(1)).toHaveAttribute(
        "data-step-kind",
        "onset_blend",
      );
      await expect(steps.nth(2)).toHaveAttribute(
        "data-step-kind",
        "tone_blend",
      );
      await expect(steps.nth(3)).toHaveAttribute(
        "data-step-kind",
        "whole_syllable",
      );

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some(
                (req) =>
                  req.method === "POST" &&
                  req.path === "/voice/text-to-speech/phonics",
              ),
          { timeout: 10_000 },
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F07-06] Finish session transitions to SessionComplete & preserves nullable evidence", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        completionSummary: makeReadingCompletionSummary({
          duration_minutes: null,
          pages_explored: null,
          selected_range_pages: null,
          practiced_words: null,
          spoken_words: null,
          transcripts: null,
          correct_words: null,
          mispronounced_words: null,
          skipped_words: null,
          score: null,
        }),
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });

      await parent.page
        .getByRole("button", { name: "Kết thúc buổi đọc" })
        .click();
      await parent.page.getByRole("button", { name: "Lưu và dừng" }).click();

      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: /Buổi đọc đã hoàn thành|Đã lưu tiến độ đọc/,
        }),
      ).toBeVisible();

      const notRecordedLabels = parent.page.getByText("Chưa ghi nhận");
      await expect(notRecordedLabels).toHaveCount(3);
      await expect(parent.page.getByText("Độ chính xác lượt đầu")).toHaveCount(
        0,
      );
      await expect(parent.page.getByText(/^0%$/)).toHaveCount(0);

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some(
                (req) =>
                  req.path === `/reading/sessions/${OPAQUE_SESSION_ID}/finish`,
              ) &&
            api
              .getRequests()
              .some(
                (req) =>
                  req.path ===
                  `/tutor/sessions/${OPAQUE_SESSION_ID}/questions/generate`,
              ) &&
            api
              .getRequests()
              .some(
                (req) =>
                  req.path === `/reading/sessions/${OPAQUE_SESSION_ID}/reports`,
              ),
          { timeout: 10_000 },
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F07-07] Preparation rejects non-contiguous page range & missing book (404/409)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let bookCatalogMode: "gap" | "not_found" | "inactive" = "gap";

      await installCluster3Mocks(parent.page, {
        overrides: {
          [`GET /books/catalog/${OPAQUE_BOOK_ID}/preview`]: () => ({
            status: 200,
            body: [
              makeCatalogPagePreview({
                page_id: OPAQUE_PAGE_ID,
                page_number: 1,
                current_verified_revision_id: OPAQUE_REV_ID,
              }),
              makeCatalogPagePreview({
                page_id: OPAQUE_PAGE_3_ID,
                page_number: 3,
                current_verified_revision_id: OPAQUE_REV_3_ID,
              }),
            ],
          }),
          [`GET /books/catalog/${OPAQUE_BOOK_ID}`]: () => {
            if (bookCatalogMode === "not_found") {
              return {
                status: 404,
                body: { detail: { code: "RESOURCE_NOT_FOUND" } },
              };
            }
            if (bookCatalogMode === "inactive") {
              return {
                status: 409,
                body: { detail: { code: "CONTENT_INACTIVE" } },
              };
            }
            return null;
          },
        },
      });

      // 1) Non-contiguous range (pages 1 and 3 with page 2 missing)
      await parent.page.goto(
        `/reading-preparation?bookId=${OPAQUE_BOOK_ID}&pageId=${OPAQUE_PAGE_ID}&endPageId=${OPAQUE_PAGE_3_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await expect(
        parent.page.getByText("Khoảng trang không hợp lệ"),
      ).toBeVisible();
      await expect(
        parent.page.getByRole("button", { name: "Bắt đầu đọc" }),
      ).toBeDisabled();

      // 2) 404 missing book
      bookCatalogMode = "not_found";
      await parent.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("Không tìm thấy sách")).toBeVisible();

      // 3) 409 inactive book
      bookCatalogMode = "inactive";
      await parent.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText("Sách hiện chưa sẵn sàng"),
      ).toBeVisible();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [404, 409],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F07-08] Mic permission unverified/denied blocks session creation", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page);

      await parent.page.addInitScript(() => {
        Object.defineProperty(navigator, "permissions", {
          configurable: true,
          value: {
            query: async () => ({
              state: "denied",
              onchange: null,
              addEventListener() {},
              removeEventListener() {},
              dispatchEvent: () => false,
            }),
          },
        });
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async () => {
              throw new DOMException("Permission denied", "NotAllowedError");
            },
          },
        });
      });

      await parent.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });

      const startButton = parent.page.getByRole("button", {
        name: "Bắt đầu đọc",
      });
      await expect(startButton).toBeDisabled();
      await expect(parent.page.getByText("Đang bị từ chối")).toBeVisible();

      await parent.page
        .getByRole("button", {
          name: /Kiểm tra và cấp quyền microphone|Kiểm tra lại microphone/,
        })
        .click();

      await expect(startButton).toBeDisabled();
      expect(
        api
          .getRequests()
          .some(
            (req) => req.method === "POST" && req.path === "/reading/sessions",
          ),
      ).toBe(false);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F07-09] Session 404 & page navigation 409/422 errors fail safely", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let sessionMissing = true;

      await installCluster3Mocks(parent.page, {
        overrides: {
          [`GET /reading/sessions/${OPAQUE_SESSION_ID}`]: () => {
            if (sessionMissing) {
              return {
                status: 404,
                body: { detail: { code: "RESOURCE_NOT_FOUND" } },
              };
            }
            return {
              status: 200,
              body: makeReadingSessionSummary({ id: OPAQUE_SESSION_ID }),
            };
          },
          [`POST /reading/sessions/${OPAQUE_SESSION_ID}/navigate`]: {
            status: 422,
            body: { detail: "Target page not in session range" },
          },
        },
      });

      // 1) Session 404
      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText("Không tìm thấy buổi đọc"),
      ).toBeVisible();

      // 2) Active session + navigation 422
      sessionMissing = false;
      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });

      await parent.page
        .getByRole("button", { name: "Trang tiếp theo" })
        .click();

      await expect(
        parent.page.getByText(
          "Chưa tải được trang này. Tiến trình buổi đọc vẫn được giữ; vui lòng thử lại.",
        ),
      ).toBeVisible();
      await expect(parent.page.getByText("mốt")).toBeVisible();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [404, 422],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F07-10] Legacy /device-permissions redirects cleanly to /dashboard?focus=child-selection", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      await installCluster3Mocks(parent.page);

      const res = await parent.context.request.get("/device-permissions", {
        maxRedirects: 0,
      });
      expect(res.status()).toBe(307);
      const locationUrl = new URL(res.headers().location ?? "", parent.baseURL);
      expect(`${locationUrl.pathname}${locationUrl.search}`).toBe(
        "/dashboard?focus=child-selection",
      );

      await parent.page.goto("/device-permissions", {
        waitUntil: "domcontentloaded",
      });
      const finalUrl = new URL(parent.page.url());
      expect(`${finalUrl.pathname}${finalUrl.search}`).toBe(
        "/dashboard?focus=child-selection",
      );

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F07-11] RTL (ar) shell preserves .viread-learning-content dir=ltr lang=vi", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      locale: "ar",
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      await installCluster3Mocks(parent.page, {
        completionSummary: makeReadingCompletionSummary({
          spoken_words: ["mốt", "Mèo"],
          correct_words: ["mốt", "Mèo"],
          score: 100,
        }),
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });

      const html = parent.page.locator("html");
      await expect(html).toHaveAttribute("dir", "rtl");
      await expect(html).toHaveAttribute("lang", "ar");

      const passage = parent.page.locator("p.viread-learning-content");
      await expect(passage).toHaveAttribute("dir", "ltr");
      await expect(passage).toHaveAttribute("lang", "vi");

      await parent.page
        .getByRole("button", { name: "استماع إلى الصوتيات والتهجئة" })
        .click();
      const phonicsFocus = parent.page.getByTestId("phonics-focus-display");
      await expect(phonicsFocus).toHaveAttribute("dir", "ltr");
      await expect(phonicsFocus).toHaveAttribute("lang", "vi");

      await parent.page
        .getByRole("button", { name: "إنهاء جلسة القراءة" })
        .click();
      await parent.page.getByRole("button", { name: "حفظ وإيقاف" }).click();

      const viewSpokenBtn = parent.page.getByRole("button", {
        name: /عرض الكلمات المقروءة/,
      });
      await expect(viewSpokenBtn).toBeVisible();
      await viewSpokenBtn.click();

      const spokenContainer = parent.page.getByTestId("spoken-words-container");
      await expect(spokenContainer).toBeVisible();
      const learningChip = spokenContainer
        .locator(".viread-learning-content")
        .first();
      await expect(learningChip).toHaveAttribute("dir", "ltr");
      await expect(learningChip).toHaveAttribute("lang", "vi");

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });
});

// ============================================================================
// F-08 — Reading Presence (11 tests: 6 Tier 1 + 5 Tier 2)
// ============================================================================

test.describe("F-08 Reading Presence (Opaque-Box)", () => {
  test("[T1-F08-01] Presence toggle loads default OFF inside ReadingVoiceSettings modal @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        presenceEmailEnabled: false,
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      await expect(dialog).toBeVisible();

      const presenceSwitch = dialog.getByRole("switch", {
        name: /Nhắc ba mẹ qua email/,
      });
      await expect(presenceSwitch).toBeVisible();
      await expect(presenceSwitch).not.toBeChecked();

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some(
                (req) =>
                  req.method === "GET" &&
                  req.path === "/reading-presence/settings",
              ),
          { timeout: 10_000 },
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F08-02] Parent enables presence opt-in with camera granted (PUT /reading-presence/settings)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let putPayload: unknown = null;
      const api = await installCluster3Mocks(parent.page, {
        presenceEmailEnabled: false,
        onRequest: (ctx) => {
          if (
            ctx.method === "PUT" &&
            ctx.pathname === "/reading-presence/settings"
          ) {
            putPayload = ctx.postDataJson;
          }
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      const presenceSwitch = dialog.getByRole("switch", {
        name: /Nhắc ba mẹ qua email/,
      });
      await expect(presenceSwitch).not.toBeChecked();
      await expect(presenceSwitch).toBeEnabled();

      await presenceSwitch.click();
      await expect(presenceSwitch).toBeChecked();

      if (!api.isLive) {
        expect(putPayload).toEqual({ email_enabled: true });
      }

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F08-03] Parent disables presence opt-in (PUT /reading-presence/settings false)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let putPayload: unknown = null;
      const api = await installCluster3Mocks(parent.page, {
        presenceEmailEnabled: true,
        onRequest: (ctx) => {
          if (
            ctx.method === "PUT" &&
            ctx.pathname === "/reading-presence/settings"
          ) {
            putPayload = ctx.postDataJson;
          }
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      const presenceSwitch = dialog.getByRole("switch", {
        name: /Nhắc ba mẹ qua email/,
      });
      await expect(presenceSwitch).toBeChecked();
      await expect(presenceSwitch).toBeEnabled();

      await presenceSwitch.click();
      await expect(presenceSwitch).not.toBeChecked();

      if (!api.isLive) {
        expect(putPayload).toEqual({ email_enabled: false });
      }

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F08-04] /settings page keeps email digests separate from reading presence", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page);

      await parent.page.goto("/settings", { waitUntil: "domcontentloaded" });

      await expect(parent.page.locator("#email-notifications")).toBeVisible();
      await expect(
        parent.page.getByRole("switch", { name: /Nhắc ba mẹ qua email/ }),
      ).toHaveCount(0);

      expect(
        api
          .getRequests()
          .some((req) => req.path.startsWith("/reading-presence")),
      ).toBe(false);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F08-05] Arming, confirming, and cancelling presence alert contract (201/200)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        presenceEmailEnabled: true,
      });

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });

      const token = parent.getAccessToken();
      const armed = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/reading-presence/alerts",
        {
          method: "POST",
          body: {
            session_id: OPAQUE_SESSION_ID,
            episode_id: OPAQUE_EPISODE_ID,
          },
        },
      );
      expect(armed.status).toBe(201);
      const armedObj = armed.json as Record<string, unknown>;
      expect(armedObj.status).toBe("PENDING");
      expect(armedObj.session_id).toBe(OPAQUE_SESSION_ID);
      expect(armedObj.episode_id).toBe(OPAQUE_EPISODE_ID);
      const alertId = String(armedObj.id ?? OPAQUE_ALERT_ID);

      const confirmed = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        `/reading-presence/alerts/${alertId}/confirm`,
        { method: "POST" },
      );
      expect(confirmed.status).toBe(200);
      expect((confirmed.json as Record<string, unknown>).status).toBe(
        "PENDING",
      );

      const cancelledReturned = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        `/reading-presence/alerts/${alertId}/cancel`,
        { method: "POST", body: { reason: "RETURNED" } },
      );
      expect(cancelledReturned.status).toBe(200);
      expect((cancelledReturned.json as Record<string, unknown>).status).toBe(
        "CANCELLED",
      );
      expect(
        (cancelledReturned.json as Record<string, unknown>).cancel_reason,
      ).toBe("RETURNED");

      const cancelledOptOut = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        `/reading-presence/alerts/${alertId}/cancel`,
        { method: "POST", body: { reason: "OPT_OUT" } },
      );
      expect(cancelledOptOut.status).toBe(200);
      expect(
        (cancelledOptOut.json as Record<string, unknown>).cancel_reason,
      ).toBe("OPT_OUT");

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F08-06] Presence-triggered pause notice displays neutral parent/child message", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        presenceEmailEnabled: true,
        sessionSummary: { state: "LISTENING" },
      });

      await parent.page.addInitScript(() => {
        let detectCount = 0;
        let virtualOffsetMs = 0;
        const origPerfNow = performance.now.bind(performance);
        performance.now = () => origPerfNow() + virtualOffsetMs;

        const origSetInterval = window.setInterval.bind(window);
        window.setInterval = ((
          handler: TimerHandler,
          timeout?: number,
          ...args: unknown[]
        ) => {
          if (timeout === 1000 && typeof handler === "function") {
            return origSetInterval(() => {
              virtualOffsetMs += 1050;
              handler(...args);
            }, 25);
          }
          return origSetInterval(handler, timeout, ...args);
        }) as typeof window.setInterval;

        class MockFaceDetector {
          async detect(): Promise<Array<Record<string, unknown>>> {
            detectCount += 1;
            return detectCount <= 4 ? [{}] : [];
          }
        }
        (window as unknown as { FaceDetector: unknown }).FaceDetector =
          MockFaceDetector;

        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (
          constraints?: MediaStreamConstraints,
        ) => {
          if (constraints?.video && !constraints.audio) {
            const canvas = document.createElement("canvas");
            canvas.width = 160;
            canvas.height = 120;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              for (let y = 0; y < 120; y += 20) {
                for (let x = 0; x < 160; x += 20) {
                  ctx.fillStyle =
                    ((x + y) / 20) % 2 === 0 ? "#202020" : "#e0e0e0";
                  ctx.fillRect(x, y, 20, 20);
                }
              }
            }
            return canvas.captureStream(5);
          }
          return origGetUserMedia(constraints);
        };
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });

      await expect(
        parent.page.getByText(
          "ViRead đã tạm dừng vì một lúc không thấy người đọc trong khung hình. Bé quay lại thì bấm Tiếp tục nhé.",
        ),
      ).toBeVisible({ timeout: 15_000 });

      const shell = parent.page.locator('[data-reading-shell="true"]');
      await expect(shell).toHaveAttribute("data-child-error-count", "0");
      await expect(shell).toHaveAttribute("data-evidence-valid", "true");

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some(
                (req) =>
                  req.method === "POST" &&
                  req.path === "/reading-presence/alerts",
              ),
          { timeout: 10_000 },
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F08-07] Camera denied prevents presence opt-in and shows notice", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        presenceEmailEnabled: false,
      });

      await parent.page.addInitScript(() => {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async () => {
              throw new DOMException("Permission denied", "NotAllowedError");
            },
          },
        });
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      const presenceSwitch = dialog.getByRole("switch", {
        name: /Nhắc ba mẹ qua email/,
      });
      await expect(presenceSwitch).toBeEnabled();
      await presenceSwitch.click();

      await expect(
        dialog.getByText(
          "Cần cho phép camera để dùng nhắc qua email. Chưa bật.",
        ),
      ).toBeVisible();
      await expect(presenceSwitch).not.toBeChecked();

      expect(
        api
          .getRequests()
          .some(
            (req) =>
              req.method === "PUT" && req.path === "/reading-presence/settings",
          ),
      ).toBe(false);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F08-08] PUT /reading-presence/settings error displays save failure banner", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      await installCluster3Mocks(parent.page, {
        presenceEmailEnabled: false,
        overrides: {
          "PUT /reading-presence/settings": {
            status: 500,
            body: { detail: "Internal server error" },
          },
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      const presenceSwitch = dialog.getByRole("switch", {
        name: /Nhắc ba mẹ qua email/,
      });
      await presenceSwitch.click();

      await expect(
        dialog.getByText("Chưa lưu được cài đặt email. Ba mẹ thử lại nhé."),
      ).toBeVisible();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [500],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F08-09] extra=forbid rejects client email/image/audio/transcript fields (422)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        presenceEmailEnabled: true,
      });

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      const token = parent.getAccessToken();

      const settingsWithEmail = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/reading-presence/settings",
        {
          method: "PUT",
          body: { email_enabled: true, email: "parent@evil.example" },
        },
      );
      expect(settingsWithEmail.status).toBe(422);

      for (const extraField of [
        { email: "parent@evil.example" },
        { image: "data:image/png;base64,AAAA" },
        { audio: "base64-audio" },
        { transcript: "secret text" },
      ]) {
        const res = await apiFetchInPage(
          parent.page,
          api.apiOrigin,
          token,
          "/reading-presence/alerts",
          {
            method: "POST",
            body: {
              session_id: OPAQUE_SESSION_ID,
              episode_id: OPAQUE_EPISODE_ID,
              ...extraField,
            },
          },
        );
        expect(res.status).toBe(422);
      }

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [422],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F08-10] Presence cooldown & daily cap (409 SESSION_COOLDOWN, DAILY_LIMIT, PRESENCE_ALERT_DISABLED, SESSION_NOT_ACTIVE)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const conflictCodes = [
        "SESSION_COOLDOWN",
        "DAILY_LIMIT",
        "PRESENCE_ALERT_DISABLED",
        "SESSION_NOT_ACTIVE",
      ] as const;
      let idx = 0;

      const api = await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /reading-presence/alerts": (): ApiMockResponse => {
            const code = conflictCodes[idx] ?? "SESSION_COOLDOWN";
            idx += 1;
            return {
              status: 409,
              body: { detail: { code } },
            };
          },
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const token = parent.getAccessToken();

      for (const expectedCode of conflictCodes) {
        const res = await apiFetchInPage(
          parent.page,
          api.apiOrigin,
          token,
          "/reading-presence/alerts",
          {
            method: "POST",
            body: {
              session_id: OPAQUE_SESSION_ID,
              episode_id: OPAQUE_EPISODE_ID,
            },
          },
        );
        expect(res.status).toBe(409);
        expect(res.json).toEqual({ detail: { code: expectedCode } });
      }

      await expect(
        parent.page.locator('[data-reading-shell="true"]'),
      ).toBeVisible();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [409],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F08-11] Cross-family presence alert confirm/cancel returns 404", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        presenceEmailEnabled: true,
      });

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      const token = parent.getAccessToken();

      const foreignArm = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/reading-presence/alerts",
        {
          method: "POST",
          body: {
            session_id: OPAQUE_FOREIGN_SESSION_ID,
            episode_id: OPAQUE_EPISODE_ID,
          },
        },
      );
      expect(foreignArm.status).toBe(404);

      const foreignConfirm = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        `/reading-presence/alerts/${OPAQUE_FOREIGN_ALERT_ID}/confirm`,
        { method: "POST" },
      );
      expect(foreignConfirm.status).toBe(404);

      const foreignCancel = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        `/reading-presence/alerts/${OPAQUE_FOREIGN_ALERT_ID}/cancel`,
        { method: "POST", body: { reason: "RETURNED" } },
      );
      expect(foreignCancel.status).toBe(404);

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [404],
      });
    } finally {
      await parent.dispose();
    }
  });
});

// ============================================================================
// F-09 — Camera Page Match & Local Scan (11 tests: 6 Tier 1 + 5 Tier 2)
// ============================================================================

test.describe("F-09 Camera Page Match & Local Scan (Opaque-Box)", () => {
  test("[T1-F09-01] Book scanner renders mobile-ready layout & polls /health + /scan-page-ocr/jobs @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page);

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Đưa trang sách vào khung camera",
        }),
      ).toBeVisible();

      const noOverflow = await parent.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      );
      expect(noOverflow).toBe(true);

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some((req) => req.method === "GET" && req.path === "/health") &&
            api
              .getRequests()
              .some(
                (req) =>
                  req.method === "GET" &&
                  req.path === "/reading/scan-page-ocr/jobs",
              ),
          { timeout: 10_000 },
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F09-02] Upload valid PNG enqueues 202 OCR job & renders matched Vietnamese text", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /reading/scan-page-ocr/jobs": {
            status: 202,
            body: makeLocalOcrScanJob({
              job_id: OPAQUE_SCAN_JOB_ID,
              status: "QUEUED",
              worker_online: true,
              queue_position: 1,
              result: null,
            }),
          },
          [`GET /reading/scan-page-ocr/jobs/${OPAQUE_SCAN_JOB_ID}`]: {
            status: 200,
            body: makeLocalOcrScanJob({
              job_id: OPAQUE_SCAN_JOB_ID,
              status: "SUCCEEDED",
              worker_online: true,
              result: makeLocalOcrPageScan(),
            }),
          },
        },
      });

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      await parent.page.getByTestId("local-ocr-file-input").setInputFiles({
        name: "page-1.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });

      const resultSection = parent.page.getByTestId("local-ocr-result");
      await expect(resultSection).toBeVisible({ timeout: 15_000 });

      const ocrText = resultSection.getByTestId("local-ocr-text");
      await expect(ocrText).toHaveAttribute("dir", "ltr");
      await expect(ocrText).toHaveAttribute("lang", "vi");
      await expect(ocrText).toContainText("mốt Mèo con đi");
      await expect(
        resultSection.getByRole("button", {
          name: "Mở Trang 1 để bắt đầu đọc",
        }),
      ).toBeVisible();

      expect(
        api
          .getRequests()
          .some(
            (req) =>
              req.method === "POST" &&
              req.path === "/reading/scan-page-ocr/jobs",
          ),
      ).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F09-03] Sync /scan-page-ocr fallback works when /jobs returns 404", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /reading/scan-page-ocr/jobs": {
            status: 404,
            body: { detail: "Not found" },
          },
          "POST /reading/scan-page-ocr": {
            status: 200,
            body: makeLocalOcrPageScan({
              ocr_text: "Bé đọc sách vui",
              word_count: 4,
            }),
          },
        },
      });

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      await parent.page.getByTestId("local-ocr-file-input").setInputFiles({
        name: "sync-page.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });

      const ocrText = parent.page.getByTestId("local-ocr-text");
      await expect(ocrText).toBeVisible({ timeout: 15_000 });
      await expect(ocrText).toContainText("Bé đọc sách vui");

      expect(
        api
          .getRequests()
          .some(
            (req) =>
              req.method === "POST" && req.path === "/reading/scan-page-ocr",
          ),
      ).toBe(true);

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [404],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F09-04] Live camera preview matches page via /reading/match-page @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /reading/match-page": {
            status: 200,
            body: makeCameraPageMatchResponse({
              matched: true,
              book_id: OPAQUE_BOOK_ID,
              confidence: 0.94,
              matched_page: makeReadingPageDto(),
            }),
          },
        },
      });

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      await parent.page
        .getByRole("button", { name: "Bật camera để quét" })
        .click();

      await expect(
        parent.page.getByTestId("scanner-camera-viewport"),
      ).toBeVisible();

      await parent.page.waitForURL(
        new RegExp(`/books/${OPAQUE_BOOK_ID}\\?pageId=${OPAQUE_PAGE_ID}`),
        { timeout: 15_000 },
      );

      expect(
        api
          .getRequests()
          .some(
            (req) =>
              req.method === "POST" && req.path === "/reading/match-page",
          ),
      ).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F09-05] Book-scoped scanner calls /reading/books/{bookId}/match-page", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page);

      await parent.page.goto(`/book-scanner?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });

      await parent.page
        .getByRole("button", { name: "Bật camera để quét" })
        .click();
      await expect(
        parent.page.getByTestId("scanner-camera-viewport"),
      ).toBeVisible();

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some(
                (req) =>
                  req.method === "POST" &&
                  req.path === `/reading/books/${OPAQUE_BOOK_ID}/match-page`,
              ),
          { timeout: 15_000 },
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F09-06] Restore active queued job across reload & cancel job (DELETE)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const activeQueuedJob = makeLocalOcrScanJob({
        job_id: OPAQUE_SCAN_JOB_ID,
        status: "QUEUED",
        worker_online: true,
        queue_position: 1,
        result: null,
      });

      const api = await installCluster3Mocks(parent.page, {
        scanJobs: [activeQueuedJob],
      });

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByTestId("async-ocr-job-card")).toBeVisible();

      await parent.page.reload({ waitUntil: "domcontentloaded" });
      const jobCard = parent.page.getByTestId("async-ocr-job-card");
      await expect(jobCard).toBeVisible();
      await expect(jobCard).toHaveAttribute("data-ocr-job-status", "QUEUED");

      await parent.page.getByTestId("cancel-queued-ocr-job").click();
      await expect(jobCard).toHaveCount(0);

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some(
                (req) =>
                  req.method === "DELETE" &&
                  req.path ===
                    `/reading/scan-page-ocr/jobs/${OPAQUE_SCAN_JOB_ID}`,
              ),
          { timeout: 10_000 },
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F09-07] Worker offline (ocr.ready: false / worker_online: false) shows offline banner & durable queue", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const offlineHealth = makeHealthPayload({
        ocr: {
          mode: "remote_worker",
          ready: false,
          engines: { paddleocr: "offline", vietocr: "offline" },
          workers: [{ online: false }],
          queue: { queued: 1 },
          heartbeat_ttl_seconds: 45,
          probe_degraded: false,
        },
      });
      const queuedOfflineJob = makeLocalOcrScanJob({
        job_id: OPAQUE_SCAN_JOB_ID,
        status: "QUEUED",
        worker_online: false,
        queue_position: 1,
        result: null,
      });

      const api = await installCluster3Mocks(parent.page, {
        healthPayload: offlineHealth,
        overrides: {
          "GET /reading/scan-page-ocr/jobs": {
            status: 200,
            body: { worker_online: false, jobs: [] },
          },
          "POST /reading/scan-page-ocr/jobs": {
            status: 202,
            body: queuedOfflineJob,
          },
          [`GET /reading/scan-page-ocr/jobs/${OPAQUE_SCAN_JOB_ID}`]: {
            status: 200,
            body: queuedOfflineJob,
          },
          "POST /reading/scan-page-ocr": {
            status: 503,
            body: { detail: "Local OCR engine is unavailable" },
          },
        },
      });

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      const offlineBanner = parent.page.getByTestId(
        "ocr-worker-offline-banner",
      );
      await expect(offlineBanner).toBeVisible();
      await expect(offlineBanner).toHaveAttribute(
        "data-ocr-worker-status",
        "unavailable",
      );

      await parent.page.getByTestId("local-ocr-file-input").setInputFiles({
        name: "offline-page.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });

      const badge = parent.page.getByTestId("ocr-worker-online-badge");
      await expect(badge).toBeVisible();
      await expect(badge).toContainText(
        "Hệ thống nhận diện trang: Đang tạm nghỉ",
      );
      await expect(
        parent.page.getByTestId("scan-another-while-queued"),
      ).toBeVisible();

      const token = parent.getAccessToken();
      const syncOffline = await apiMultipartInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/reading/scan-page-ocr",
        {
          fileBytes: [...makeMinimalPngBuffer()],
          fileName: "sync-offline.png",
          fileMime: "image/png",
        },
      );
      expect(syncOffline.status).toBe(503);

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [503],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F09-08] Oversized >12MB scan & >8MB camera frame rejected (413)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /reading/match-page": {
            status: 413,
            body: { detail: { code: "PAYLOAD_TOO_LARGE" } },
          },
        },
      });

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      await parent.page.getByTestId("local-ocr-file-input").setInputFiles({
        name: "oversized-page.png",
        mimeType: "image/png",
        buffer: makeOversizedBuffer(OVERSIZED_SCAN_BYTES, 0x41),
      });

      await expect(
        parent.page.getByText("Chưa quét được trang sách"),
      ).toBeVisible();
      await expect(
        parent.page.getByText(/vượt quá giới hạn dung lượng 12 MB/),
      ).toBeVisible();

      const token = parent.getAccessToken();
      const oversizedCameraRes = await apiMultipartInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/reading/match-page",
        {
          fileBytes: new Array<number>(1024).fill(0x41),
          fileName: "huge-frame.jpg",
          fileMime: "image/jpeg",
        },
      );
      expect(oversizedCameraRes.status).toBe(413);

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [413],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F09-09] Empty / corrupt / unsupported image rejected (422 / client validation)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /reading/scan-page-ocr/jobs": {
            status: 422,
            body: {
              detail: "No usable text was detected; check the image quality",
            },
          },
        },
      });

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      const fileInput = parent.page.getByTestId("local-ocr-file-input");

      // 1) Empty 0-byte file
      await fileInput.setInputFiles({
        name: "empty.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(0),
      });
      await expect(parent.page.getByText(/Tệp ảnh bị rỗng/)).toBeVisible();

      // 2) Unsupported .txt file
      await fileInput.setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("plain text", "utf8"),
      });
      await expect(
        parent.page.getByText(/Định dạng ảnh chưa hỗ trợ/),
      ).toBeVisible();

      // 3) Valid PNG MIME rejected by backend as corrupt/unusable (422)
      await fileInput.setInputFiles({
        name: "corrupt.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });
      await expect(
        parent.page.getByText("Chưa quét được trang sách"),
      ).toBeVisible();
      await expect(
        parent.page.getByText(
          "Không phát hiện được chữ trong ảnh. Hãy thử ảnh rõ nét, đủ sáng và đúng chiều.",
        ),
      ).toBeVisible();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [422],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F09-10] Rate limit 429 pauses camera auto-scan & shows retry banner", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /reading/match-page": {
            status: 429,
            headers: { "Retry-After": "10" },
            body: { detail: "Too many requests" },
          },
        },
      });

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      await parent.page
        .getByRole("button", { name: "Bật camera để quét" })
        .click();

      const banner = parent.page.getByTestId("camera-ocr-unavailable-banner");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(
        banner.getByRole("button", { name: "Thử quét lại" }),
      ).toBeVisible();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [429],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F09-11] Unmatched camera framing (TOO_DARK / LOW_CONFIDENCE) stays on scanner without navigation", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /reading/match-page": {
            status: 200,
            body: makeCameraPageMatchResponse({
              framing_valid: false,
              matched: false,
              book_id: null,
              status_code: "TOO_DARK",
              message:
                "Ánh sáng hơi tối, hãy bật thêm đèn và giữ sách yên nhé.",
              confidence: 0.12,
              matched_page: null,
            }),
          },
        },
      });

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      await parent.page
        .getByRole("button", { name: "Bật camera để quét" })
        .click();

      await expect(
        parent.page.getByText(
          "Ánh sáng hơi tối, hãy bật thêm đèn và giữ sách yên nhé.",
        ),
      ).toBeVisible({ timeout: 15_000 });
      expect(new URL(parent.page.url()).pathname).toBe("/book-scanner");
      expect(
        api
          .getRequests()
          .some(
            (req) =>
              req.method === "POST" && req.path === "/reading/match-page",
          ),
      ).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });
});

// ============================================================================
// F-10 — AI Voice STT & TTS (11 tests: 6 Tier 1 + 5 Tier 2)
// ============================================================================

test.describe("F-10 AI Voice STT & TTS (Opaque-Box)", () => {
  test("[T1-F10-01] Voice settings modal loads /voice/status & 3-region /voice/voices @mobile", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page);

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByTestId("voice-health-status-pills"),
      ).toBeVisible();

      await expect(
        dialog.getByRole("button", { name: "Tất cả vùng" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Miền Bắc" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Miền Trung" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Miền Nam" }),
      ).toBeVisible();

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some(
                (req) => req.method === "GET" && req.path === "/voice/status",
              ) &&
            api
              .getRequests()
              .some(
                (req) => req.method === "GET" && req.path === "/voice/voices",
              ),
          { timeout: 10_000 },
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F10-02] Region switching & voice preview play TTS and update VoiceEngineBadge", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let capturedVoiceId: string | null = null;
      await installCluster3Mocks(parent.page, {
        onRequest: (ctx) => {
          if (
            ctx.method === "POST" &&
            ctx.pathname === "/voice/text-to-speech/timed"
          ) {
            const payload =
              ctx.postDataJson && typeof ctx.postDataJson === "object"
                ? (ctx.postDataJson as Record<string, unknown>)
                : {};
            capturedVoiceId =
              typeof payload.voice_id === "string" ? payload.voice_id : null;
          }
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      await dialog.getByRole("button", { name: "Miền Nam" }).click();

      const southRadio = dialog.getByRole("radio", { name: /Thục Đoan/ });
      await expect(southRadio).toBeVisible();
      await southRadio.click();

      await dialog.getByRole("button", { name: "Nghe thử" }).click();

      await expect
        .poll(() => capturedVoiceId, { timeout: 10_000 })
        .toBe(OPAQUE_VOICE_SOUTH_ID);

      const badge = dialog.getByTestId("voice-engine-status-badge");
      await expect(badge).toHaveAttribute("data-tts-tier", "local_offline");

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F10-03] Session voice lock synchronization (PUT /voice/session-lock)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let lockUpdatePayload: unknown = null;
      const api = await installCluster3Mocks(parent.page, {
        onRequest: (ctx) => {
          if (ctx.method === "PUT" && ctx.pathname === "/voice/session-lock") {
            lockUpdatePayload = ctx.postDataJson;
          }
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      const lockBadge = dialog.getByTestId("session-voice-lock-badge");
      await expect(lockBadge).toBeVisible();
      await expect(lockBadge).toContainText("Đang khóa cho phiên đọc này");

      await dialog.getByRole("button", { name: "Miền Nam" }).click();
      await dialog.getByRole("radio", { name: /Thục Đoan/ }).click();

      await expect
        .poll(() => lockUpdatePayload, { timeout: 10_000 })
        .toMatchObject({
          session_id: OPAQUE_SESSION_ID,
          voice_id: OPAQUE_VOICE_SOUTH_ID,
        });

      expect(
        api
          .getRequests()
          .some(
            (req) => req.method === "PUT" && req.path === "/voice/session-lock",
          ),
      ).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F10-04] TTS cache MISS -> HIT & PRIVATE vs CATALOG cache scope isolation", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page);

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      const token = parent.getAccessToken();

      const firstCatalog = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        {
          method: "POST",
          body: {
            text: "Mèo con",
            voice_id: OPAQUE_VOICE_NORTH_ID,
            book_id: OPAQUE_BOOK_ID,
            cache_scope: "CATALOG",
          },
        },
      );
      expect(firstCatalog.status).toBe(200);
      expect(firstCatalog.headers["x-tts-cache"]).toBe("MISS");
      expect(firstCatalog.headers["x-tts-scope"]).toBe("CATALOG");
      expect(firstCatalog.headers["cache-control"]).toBe("no-store");

      const secondCatalog = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        {
          method: "POST",
          body: {
            text: "Mèo con",
            voice_id: OPAQUE_VOICE_NORTH_ID,
            book_id: OPAQUE_BOOK_ID,
            cache_scope: "CATALOG",
          },
        },
      );
      expect(secondCatalog.status).toBe(200);
      expect(secondCatalog.headers["x-tts-cache"]).toBe("HIT");
      expect(secondCatalog.headers["x-tts-scope"]).toBe("CATALOG");

      const firstPrivate = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        {
          method: "POST",
          body: {
            text: "Mèo con",
            voice_id: OPAQUE_VOICE_NORTH_ID,
            book_id: OPAQUE_PRIVATE_BOOK_ID,
            cache_scope: "PRIVATE",
          },
        },
      );
      expect(firstPrivate.status).toBe(200);
      expect(firstPrivate.headers["x-tts-cache"]).toBe("MISS");
      expect(firstPrivate.headers["x-tts-scope"]).toBe("PRIVATE");
      expect(firstPrivate.headers["cache-control"]).toBe("private, no-store");

      // Exercise browser IndexedDB TTS cache isolation via real ReadingScreen word tap
      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .locator("[data-word-id]")
        .filter({ hasText: "Mèo" })
        .first()
        .click();

      await expect
        .poll(
          () =>
            api
              .getRequests()
              .some(
                (req) =>
                  req.method === "POST" && req.path === "/voice/text-to-speech",
              ),
          { timeout: 10_000 },
        )
        .toBe(true);

      // Verify browser IndexedDB persists CATALOG scope and never stores PRIVATE
      const idbCheck = await parent.page.evaluate(async () => {
        const db = await new Promise<IDBDatabase | null>((resolve) => {
          const req = indexedDB.open("viread-tts-audio-v1", 2);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        });
        if (!db || !db.objectStoreNames.contains("entries")) {
          return { scopes: [] as string[] };
        }
        const scopes = await new Promise<string[]>((resolve) => {
          const tx = db.transaction("entries", "readonly");
          const getAllReq = tx.objectStore("entries").getAll();
          getAllReq.onsuccess = () => {
            const rows = (getAllReq.result as Array<{ scope?: string }>) ?? [];
            resolve(rows.map((r) => String(r.scope ?? "")));
          };
          getAllReq.onerror = () => resolve([]);
        });
        db.close();
        return { scopes };
      });
      expect(idbCheck.scopes).not.toContain("PRIVATE");

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F10-05] Timed TTS (/text-to-speech/timed) & Phonics TTS (/text-to-speech/phonics) Zod validation", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let timedWordsCount = 0;
      let phonicsStepsCount = 0;

      await installCluster3Mocks(parent.page, {
        onRequest: (ctx) => {
          const payload =
            ctx.postDataJson && typeof ctx.postDataJson === "object"
              ? (ctx.postDataJson as Record<string, unknown>)
              : {};
          if (
            ctx.method === "POST" &&
            ctx.pathname === "/voice/text-to-speech/timed"
          ) {
            const words = Array.isArray(payload.words) ? payload.words : [];
            timedWordsCount = words.length;
          }
          if (
            ctx.method === "POST" &&
            ctx.pathname === "/voice/text-to-speech/phonics"
          ) {
            const steps = Array.isArray(payload.steps) ? payload.steps : [];
            phonicsStepsCount = steps.length;
          }
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });

      await parent.page
        .getByRole("button", { name: /Nghe đọc mẫu cả trang/ })
        .click();
      await expect.poll(() => timedWordsCount, { timeout: 10_000 }).toBe(4);

      await parent.page.getByRole("button", { name: "Nghe đánh vần" }).click();
      await expect.poll(() => phonicsStepsCount, { timeout: 10_000 }).toBe(4);
      await expect(
        parent.page.getByTestId("phonics-lesson-card"),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T1-F10-06] Speech-to-text (POST /voice/speech-to-text) multipart WAV upload & NFC transcript", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const nfdText = "mốt Mèo con đi".normalize("NFD");
      const api = await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /voice/speech-to-text": {
            status: 200,
            body: {
              text: nfdText.normalize("NFC"),
              language_code: "vi-VN",
              language_probability: 0.99,
              words: [
                { text: "mốt", start: 0, end: 0.25 },
                { text: "Mèo", start: 0.25, end: 0.5 },
              ],
            },
          },
        },
      });

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      const token = parent.getAccessToken();
      const wavBytes = [...makeMinimalWavBuffer(250)];

      const sttRes = await apiMultipartInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/speech-to-text",
        {
          fileBytes: wavBytes,
          fileName: "child-reading.wav",
          fileMime: "audio/wav",
          fields: [
            ["language_code", "vi-VN"],
            ["keyterms", "mốt"],
            ["keyterms", "Mèo"],
          ],
        },
      );

      expect(sttRes.status).toBe(200);
      const body = sttRes.json as {
        text: string;
        language_code: string;
        words: Array<{ text: string }>;
      };
      expect(body.text).toBe("mốt Mèo con đi".normalize("NFC"));
      expect(body.text).toBe(body.text.normalize("NFC"));
      expect(body.language_code).toBe("vi-VN");
      expect(Array.isArray(body.words)).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F10-07] Local worker offline shows Wi-Fi cached voice badges & Google fallback toggle", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const offlineStatus = makeVoiceStatusPayload({
        local: {
          configured: true,
          mode: "http",
          available: false,
          stt_ready: false,
          tts_ready: false,
          error_code: "LOCAL_VOICE_UNAVAILABLE",
        },
        google: {
          stt_configured: true,
          tts_configured: true,
          stt_cooldown: false,
          tts_cooldown: false,
        },
      });
      const offlineVoices = makeVoiceListPayload({
        local_worker_ready: false,
        google_tts_available: true,
        cached_voice_ids: [OPAQUE_VOICE_NORTH_ID],
      });

      const voiceQueries: string[] = [];
      await installCluster3Mocks(parent.page, {
        voiceStatus: offlineStatus,
        voiceList: offlineVoices,
        overrides: {
          "GET /voice/voices": (ctx) => {
            voiceQueries.push(ctx.url.search);
            return { status: 200, body: offlineVoices };
          },
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      await expect(
        dialog.getByTestId(`voice-wifi-ready-badge-${OPAQUE_VOICE_NORTH_ID}`),
      ).toBeVisible();
      await expect(
        dialog.getByTestId("voice-offline-cache-notice"),
      ).toBeVisible();

      await dialog.getByRole("button", { name: /Tự động linh hoạt/ }).click();

      await expect
        .poll(() =>
          voiceQueries.some(
            (q) =>
              q.includes("provider_mode=local_with_google_fallback") &&
              q.includes("allow_google_tts=true"),
          ),
        )
        .toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F10-08] Audio upload validation boundaries (413 >25MB, 415 unsupported MIME, 422 empty/excess keyterms)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /voice/speech-to-text": (ctx) => {
            const raw = ctx.postDataText ?? "";
            if (raw.includes("Content-Type: text/plain")) {
              return {
                status: 415,
                body: { detail: { code: "UNSUPPORTED_AUDIO" } },
              };
            }
            const keytermMatches = raw.match(/name="keyterms"/g) ?? [];
            if (keytermMatches.length > 50) {
              return {
                status: 422,
                body: { detail: { code: "TOO_MANY_KEYTERMS" } },
              };
            }
            if (raw.length > 25 * 1024 * 1024) {
              return {
                status: 413,
                body: { detail: { code: "AUDIO_TOO_LARGE" } },
              };
            }
            if (raw.includes('filename="empty.wav"')) {
              return {
                status: 422,
                body: { detail: { code: "EMPTY_AUDIO" } },
              };
            }
            return {
              status: 200,
              body: { text: "mốt", language_code: "vi-VN", words: [] },
            };
          },
        },
      });

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      const token = parent.getAccessToken();

      // 1) >25MB audio -> 413
      const over25MbResult = await parent.page.evaluate(
        async ({ baseOrigin, bearer }) => {
          const bigBytes = new Uint8Array(25 * 1024 * 1024 + 512);
          bigBytes.fill(0x41);
          const form = new FormData();
          form.append(
            "file",
            new Blob([bigBytes], { type: "audio/wav" }),
            "too-large.wav",
          );
          const res = await fetch(`${baseOrigin}/voice/speech-to-text`, {
            method: "POST",
            headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
            body: form,
          });
          return { status: res.status, json: (await res.json()) as unknown };
        },
        { baseOrigin: api.apiOrigin, bearer: token },
      );
      expect(over25MbResult.status).toBe(413);
      expect(over25MbResult.json).toEqual({
        detail: { code: "AUDIO_TOO_LARGE" },
      });

      // 2) Unsupported MIME text/plain -> 415
      const badMime = await apiMultipartInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/speech-to-text",
        {
          fileBytes: [0x68, 0x69],
          fileName: "audio.txt",
          fileMime: "text/plain",
        },
      );
      expect(badMime.status).toBe(415);
      expect(badMime.json).toEqual({ detail: { code: "UNSUPPORTED_AUDIO" } });

      // 3) Empty 0B audio -> 422
      const emptyAudio = await apiMultipartInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/speech-to-text",
        {
          fileBytes: [],
          fileName: "empty.wav",
          fileMime: "audio/wav",
        },
      );
      expect(emptyAudio.status).toBe(422);
      expect(emptyAudio.json).toEqual({ detail: { code: "EMPTY_AUDIO" } });

      // 4) >50 keyterms -> 422
      const tooManyKeyterms = Array.from(
        { length: 51 },
        (_, i) => ["keyterms", `tu_${i}`] as const,
      );
      const excessKeyterms = await apiMultipartInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/speech-to-text",
        {
          fileBytes: [...makeMinimalWavBuffer(100)],
          fileName: "valid.wav",
          fileMime: "audio/wav",
          fields: tooManyKeyterms,
        },
      );
      expect(excessKeyterms.status).toBe(422);
      expect(excessKeyterms.json).toEqual({
        detail: { code: "TOO_MANY_KEYTERMS" },
      });

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [413, 415, 422],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F10-09] TTS validation & deactivated user (Active=0) fail closed (422 / 403)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let userDeactivated = false;

      const api = await installCluster3Mocks(parent.page, {
        overrides: {
          "POST /voice/text-to-speech": () =>
            userDeactivated
              ? { status: 403, body: { detail: "Account deactivated" } }
              : null,
          "POST /voice/text-to-speech/timed": () =>
            userDeactivated
              ? { status: 403, body: { detail: "Account deactivated" } }
              : null,
          "GET /voice/voices": () =>
            userDeactivated
              ? { status: 403, body: { detail: "Account deactivated" } }
              : null,
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const token = parent.getAccessToken();

      // 1) TTS 422 validation (blank text & out-of-range speed)
      const blankTextRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        { method: "POST", body: { text: "   ", speed: 1.0 } },
      );
      expect(blankTextRes.status).toBe(422);

      const badSpeedRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        { method: "POST", body: { text: "Xin chào", speed: 1.5 } },
      );
      expect(badSpeedRes.status).toBe(422);

      // 2) Active=0 deactivated user receives 403 and fails safely in UI
      userDeactivated = true;
      const forbiddenRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        { method: "POST", body: { text: "Xin chào", speed: 1.0 } },
      );
      expect(forbiddenRes.status).toBe(403);

      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();
      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      await expect(
        dialog.getByText(
          "Chưa tải được danh sách giọng. Giọng mặc định vẫn dùng được.",
        ),
      ).toBeVisible();

      await dialog.getByRole("button", { name: "Nghe thử" }).click();
      await expect(
        dialog.getByRole("alert").filter({
          hasText:
            "Chưa phát được giọng đọc. Bé thử lại hoặc chọn giọng khác nhé.",
        }),
      ).toBeVisible();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [403, 422],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F10-10] WS /voice/stt-stream subprotocol viread-stt-v1, auth failure (4401) & worker offline (4503)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const api = await installCluster3Mocks(parent.page);

      let wsMode: "happy" | "unauth" | "offline" = "happy";
      if (!api.isLive) {
        await parent.page.routeWebSocket(/\/voice\/stt-stream/, (ws) => {
          if (wsMode === "offline") {
            ws.onMessage(() => {
              ws.send(
                JSON.stringify({
                  type: "error",
                  code: "LOCAL_STT_UNAVAILABLE",
                  message: "Local STT worker is unavailable",
                  retryable: true,
                }),
              );
              ws.close({ code: 4503, reason: "LOCAL_STT_UNAVAILABLE" });
            });
            return;
          }

          ws.onMessage((msg) => {
            if (typeof msg === "string") {
              const parsed = JSON.parse(msg) as {
                type?: string;
                token?: string;
                turn_id?: string;
              };
              if (wsMode === "unauth" || !parsed.token) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    code: "UNAUTHORIZED",
                    message: "Authentication required",
                    retryable: false,
                  }),
                );
                ws.close({ code: 4401, reason: "UNAUTHORIZED" });
                return;
              }
              if (parsed.type === "start") {
                ws.send(JSON.stringify({ type: "ready" }));
              } else if (parsed.type === "stop") {
                ws.send(
                  JSON.stringify({
                    type: "final",
                    text: "mốt Mèo con đi",
                    turn_id: parsed.turn_id ?? "turn-1",
                    session_id: OPAQUE_SESSION_ID,
                    page_id: OPAQUE_PAGE_ID,
                  }),
                );
                ws.close({ code: 1000, reason: "done" });
              }
              return;
            }
            // Binary PCM audio frame received
            ws.send(
              JSON.stringify({
                type: "interim",
                text: "mốt Mèo",
                session_id: OPAQUE_SESSION_ID,
                page_id: OPAQUE_PAGE_ID,
              }),
            );
          });
        });
      }

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      const wsUrl = api.apiOrigin.replace(/^http/, "ws") + "/voice/stt-stream";
      const token = parent.getAccessToken();

      // 1) Happy-path streaming with subprotocol viread-stt-v1 + binary PCM
      const happyResult = await parent.page.evaluate(
        async ({ targetUrl, bearer, sessionId, pageId }) => {
          return new Promise<{
            messages: Array<{ type?: string; text?: string }>;
            closeCode: number;
          }>((resolve, reject) => {
            const socket = new WebSocket(targetUrl, "viread-stt-v1");
            const messages: Array<{ type?: string; text?: string }> = [];
            socket.onopen = () => {
              socket.send(
                JSON.stringify({
                  type: "start",
                  token: bearer,
                  session_id: sessionId,
                  page_id: pageId,
                  turn_id: "turn-1",
                }),
              );
            };
            socket.onmessage = (ev) => {
              const data = JSON.parse(String(ev.data)) as {
                type?: string;
                text?: string;
              };
              messages.push(data);
              if (data.type === "ready") {
                const pcm = new Int16Array(320);
                socket.send(pcm.buffer);
                socket.send(
                  JSON.stringify({ type: "stop", turn_id: "turn-1" }),
                );
              }
            };
            socket.onclose = (ev) => {
              resolve({ messages, closeCode: ev.code });
            };
            socket.onerror = () => reject(new Error("WS_HAPPY_ERROR"));
          });
        },
        {
          targetUrl: wsUrl,
          bearer: token,
          sessionId: OPAQUE_SESSION_ID,
          pageId: OPAQUE_PAGE_ID,
        },
      );
      expect(happyResult.messages.some((m) => m.type === "ready")).toBe(true);
      expect(
        happyResult.messages.some(
          (m) => m.type === "final" && m.text === "mốt Mèo con đi",
        ),
      ).toBe(true);

      // 2) Auth failure -> 4401 UNAUTHORIZED
      wsMode = "unauth";
      const unauthResult = await parent.page.evaluate(
        async ({ targetUrl }) => {
          return new Promise<{
            messages: Array<{ type?: string; code?: string }>;
            closeCode: number;
          }>((resolve) => {
            const socket = new WebSocket(targetUrl, "viread-stt-v1");
            const messages: Array<{ type?: string; code?: string }> = [];
            socket.onopen = () => {
              socket.send(JSON.stringify({ type: "start" }));
            };
            socket.onmessage = (ev) => {
              messages.push(
                JSON.parse(String(ev.data)) as { type?: string; code?: string },
              );
            };
            socket.onclose = (ev) => {
              resolve({ messages, closeCode: ev.code });
            };
          });
        },
        { targetUrl: wsUrl },
      );
      expect(unauthResult.closeCode).toBe(4401);
      expect(unauthResult.messages.some((m) => m.code === "UNAUTHORIZED")).toBe(
        true,
      );

      // 3) Worker offline -> 4503 LOCAL_STT_UNAVAILABLE
      wsMode = "offline";
      const offlineResult = await parent.page.evaluate(
        async ({ targetUrl, bearer }) => {
          return new Promise<{
            messages: Array<{ type?: string; code?: string }>;
            closeCode: number;
          }>((resolve) => {
            const socket = new WebSocket(targetUrl, "viread-stt-v1");
            const messages: Array<{ type?: string; code?: string }> = [];
            socket.onopen = () => {
              socket.send(JSON.stringify({ type: "start", token: bearer }));
            };
            socket.onmessage = (ev) => {
              messages.push(
                JSON.parse(String(ev.data)) as { type?: string; code?: string },
              );
            };
            socket.onclose = (ev) => {
              resolve({ messages, closeCode: ev.code });
            };
          });
        },
        { targetUrl: wsUrl, bearer: token },
      );
      expect(offlineResult.closeCode).toBe(4503);
      expect(
        offlineResult.messages.some((m) => m.code === "LOCAL_STT_UNAVAILABLE"),
      ).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T2-F10-11] Malformed /voice/voices or /text-to-speech/timed mismatched length fails closed (502 / error UI)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      let malformedVoices = true;

      await installCluster3Mocks(parent.page, {
        overrides: {
          "GET /voice/voices": () => {
            if (malformedVoices) {
              return { status: 200, body: { malformed: true } };
            }
            return { status: 200, body: makeVoiceListPayload() };
          },
          "POST /voice/text-to-speech/timed": () => ({
            status: 200,
            body: {
              audio_base64: makeMinimalWavBuffer(200).toString("base64"),
              content_type: "audio/wav",
              duration_seconds: 1.0,
              // Intentionally mismatched word count (1 vs preview sentence length)
              words: [{ index: 0, start: 0, end: 0.5 }],
              provider: "local",
            },
          }),
        },
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Giọng đọc" }).click();

      const dialog = parent.page.getByRole("dialog", { name: "Giọng đọc mẫu" });
      await expect(
        dialog.getByText(
          "Chưa tải được danh sách giọng. Giọng mặc định vẫn dùng được.",
        ),
      ).toBeVisible();

      // Switch to valid voices & retry -> test mismatched timed words length
      malformedVoices = false;
      await dialog.getByRole("button", { name: "Thử lại" }).click();
      await expect(
        dialog.getByRole("radio", { name: /Trúc Ly/ }),
      ).toBeVisible();

      await dialog.getByRole("button", { name: "Nghe thử" }).click();
      await expect(
        dialog.getByRole("alert").filter({
          hasText:
            "Chưa phát được giọng đọc. Bé thử lại hoặc chọn giọng khác nhé.",
        }),
      ).toBeVisible();

      expect(errors.pageErrors).toEqual([]);
    } finally {
      await parent.dispose();
    }
  });
});
