import { expect, test, type Page } from "@playwright/test";

import {
  OPAQUE_SUBMISSION_ID,
  makePrivateBookDetail,
  makePrivateBookListItem,
  makePrivateBookSubmission,
} from "./fixtures/cluster1-2-data";
import {
  OPAQUE_C4_KARAOKE_SONG_ID,
  OPAQUE_C4_OCCURRENCE_ID,
  OPAQUE_EPISODE_ID,
  OPAQUE_PAGE_2_ID,
  OPAQUE_PRIVATE_BOOK_ID,
  OPAQUE_SCAN_JOB_ID,
  OPAQUE_VOICE_NORTH_ID,
  makeCameraPageMatchResponse,
  makeLocalOcrPageScan,
  makeLocalOcrScanJob,
  makeReadingPage2Dto,
  makeReadingPageDto,
} from "./fixtures/cluster3-4-data";
import {
  OPAQUE_PARENT_ID,
  attachPageErrorCollector,
  createRoleContext,
  installApiMock,
} from "./fixtures/session";
import {
  OPAQUE_BOOK_ID,
  OPAQUE_CHILD_ID,
  OPAQUE_CRON_SECRET,
  OPAQUE_PAGE_ID,
  OPAQUE_REV_ID,
  OPAQUE_SESSION_ID,
  OVERSIZED_AVATAR_BYTES,
  OVERSIZED_SCAN_BYTES,
  makeMinimalPdfBuffer,
  makeMinimalPngBuffer,
  makeMinimalWavBuffer,
  makeOpaqueUuid,
  makeOversizedBuffer,
} from "./fixtures/test-data";
import {
  assertNoUnexpectedPageErrors,
  createTier34ApiHandler,
  createTier34State,
  fillHydrated,
  getProjectViewport,
  makeMinimalMp3Buffer,
  mockSupabasePasswordAuth,
  mockSupabaseStorageImages,
} from "./fixtures/tier3-4-data";

async function apiFetchInPage(
  page: Page,
  apiOrigin: string,
  token: string | null,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  status: number;
  headers: Record<string, string>;
  json: unknown;
}> {
  return page.evaluate(
    async ({ baseUrl, bearer, routePath, reqInit }) => {
      const headers: Record<string, string> = {
        ...(reqInit.headers ?? {}),
      };
      if (bearer) {
        headers.Authorization = `Bearer ${bearer}`;
      }
      let body: BodyInit | undefined;
      if (reqInit.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(reqInit.body);
      }
      const response = await fetch(`${baseUrl}${routePath}`, {
        method: reqInit.method ?? "GET",
        headers,
        body,
      });
      const resHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        resHeaders[key.toLowerCase()] = value;
      });
      const ct = response.headers.get("content-type") ?? "";
      const json = ct.includes("application/json")
        ? await response.json().catch(() => null)
        : null;
      return { status: response.status, headers: resHeaders, json };
    },
    { baseUrl: apiOrigin, bearer: token, routePath: path, reqInit: init },
  );
}

test.describe("Tier 4: End-to-End Real-World Application Workflows (14 Scenarios)", () => {
  test("[T4-W01] Parent Onboarding -> Child Setup -> First Guided Reading -> Completion (F-01->F-03->F-05->F-07->F-10->F-12)", async ({
    browser,
  }) => {
    const guest = await createRoleContext(browser, "guest");
    try {
      const errors = attachPageErrorCollector(guest.page);
      const state = createTier34State();
      const api = await installApiMock(
        guest.page,
        createTier34ApiHandler(state),
      );
      await mockSupabaseStorageImages(guest.page);
      await mockSupabasePasswordAuth(guest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
      });

      // 1. Login -> /dashboard
      await guest.page.goto("/login", { waitUntil: "load" });
      await fillHydrated(
        guest.page.getByLabel("Email của ba mẹ"),
        "parent@viread.local",
      );
      await fillHydrated(
        guest.page.getByLabel("Mật khẩu", { exact: true }),
        "SecretPass123!",
      );
      await guest.page.getByRole("button", { name: "Đăng nhập" }).click();
      await expect(guest.page).toHaveURL(/\/dashboard$/);

      // 2. Child setup + avatar boundary (>5MB rejected)
      await guest.page.goto("/children/new", { waitUntil: "load" });
      await fillHydrated(
        guest.page.getByLabel("Tên gọi của bé"),
        "Bé Thảo Nguyên",
      );
      await guest.page.getByLabel("Lớp của bé").selectOption("2");
      await guest.page.getByRole("button", { name: "Lưu hồ sơ" }).click();
      await expect(guest.page).toHaveURL(/\/children\/([^/?]+)\?created=1$/);
      const childId = new URL(guest.page.url()).pathname.split("/").pop()!;

      const avatarInput = guest.page.locator('input[type="file"]').first();
      if ((await avatarInput.count()) > 0) {
        await avatarInput.setInputFiles({
          name: "too-big.png",
          mimeType: "image/png",
          buffer: makeOversizedBuffer(OVERSIZED_AVATAR_BYTES),
        });
        await expect(
          guest.page.locator('[role="alert"]:not(#__next-route-announcer__)'),
        ).toBeVisible();
        await avatarInput.setInputFiles({
          name: "avatar.png",
          mimeType: "image/png",
          buffer: makeMinimalPngBuffer(),
        });
      }

      await guest.page.evaluate(
        ({ ownerId, cid }) => {
          window.sessionStorage.setItem(
            `viread:selected-child:${ownerId}`,
            cid,
          );
        },
        { ownerId: OPAQUE_PARENT_ID, cid: childId },
      );

      // 3. Catalog -> Book detail -> Reading preparation
      await guest.page.goto("/books?grade=2", {
        waitUntil: "domcontentloaded",
      });
      await expect(guest.page.getByText("Chú Mèo Đi Hia")).toBeVisible();
      await guest.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await guest.page.goto(`/reading-preparation?bookId=${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await guest.page.getByRole("button", { name: "Bắt đầu đọc" }).click();
      await expect(guest.page).toHaveURL(
        new RegExp(`/reading/${OPAQUE_SESSION_ID}`),
      );

      // 4. Voice TTS MISS->HIT, Phonics, WORD_RETRY event, Finish
      const token = guest.getAccessToken();
      const tts1 = await apiFetchInPage(
        guest.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        {
          method: "POST",
          body: {
            text: "Chú mèo",
            voice_id: OPAQUE_VOICE_NORTH_ID,
            book_id: OPAQUE_BOOK_ID,
            cache_scope: "CATALOG",
          },
        },
      );
      expect(tts1.headers["x-tts-cache"]).toBe("MISS");

      const tts2 = await apiFetchInPage(
        guest.page,
        api.apiOrigin,
        token,
        "/voice/text-to-speech",
        {
          method: "POST",
          body: {
            text: "Chú mèo",
            voice_id: OPAQUE_VOICE_NORTH_ID,
            book_id: OPAQUE_BOOK_ID,
            cache_scope: "CATALOG",
          },
        },
      );
      expect(tts2.headers["x-tts-cache"]).toBe("HIT");

      await apiFetchInPage(
        guest.page,
        api.apiOrigin,
        token,
        "/reading/events",
        {
          method: "POST",
          body: {
            SessionId: OPAQUE_SESSION_ID,
            PageId: OPAQUE_PAGE_ID,
            PageRevisionId: OPAQUE_REV_ID,
            Type: "WORD_RETRY",
            Status: "CONFIRMED",
            StartMs: 1000,
            Metadata: { word: "lấp lánh" },
          },
        },
      );

      await apiFetchInPage(
        guest.page,
        api.apiOrigin,
        token,
        `/reading/sessions/${OPAQUE_SESSION_ID}/pages/${OPAQUE_PAGE_ID}/complete`,
        { method: "POST" },
      );

      await guest.page
        .getByRole("button", { name: "Kết thúc buổi đọc" })
        .click();
      await guest.page.getByRole("button", { name: "Lưu và dừng" }).click();
      await expect(
        guest.page.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
      ).toBeVisible();

      // 5. Verify /sessions/[id] & /reports preserve nullable unassessed fields
      await guest.page.goto(`/sessions/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        guest.page.getByTestId("session-primary-reading-report"),
      ).toBeVisible();

      await guest.page.goto("/reports", { waitUntil: "domcontentloaded" });
      await expect(guest.page.getByText("lấp lánh").first()).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await guest.dispose();
    }
  });

  test("[T4-W02] Post-Reading Voice Comprehension & Difficult Words Practice Loop (F-07->F-11->F-12->F-14)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      let leakedExpectedAnswer = false;
      const baseHandler = createTier34ApiHandler(state);
      const api = await installApiMock(parent.page, async (ctx) => {
        const res =
          typeof baseHandler === "function"
            ? await baseHandler(ctx)
            : undefined;
        if (
          ctx.method === "GET" &&
          ctx.pathname.endsWith("/questions/next") &&
          res?.body
        ) {
          const raw = JSON.stringify(res.body);
          if (
            raw.includes("expected_answer") ||
            raw.includes("ExpectedAnswer")
          ) {
            leakedExpectedAnswer = true;
          }
        }
        return res;
      });

      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByRole("button", { name: "Kết thúc buổi đọc" })
        .click();
      await parent.page.getByRole("button", { name: "Lưu và dừng" }).click();

      await expect(
        parent.page.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
      ).toBeVisible();
      expect(leakedExpectedAnswer).toBe(false);

      await parent.page
        .getByRole("button", { name: "Một giỏ dâu rừng đỏ mọng" })
        .click();
      await parent.page.getByRole("button", { name: "Câu tiếp theo" }).click();
      await parent.page.getByRole("button", { name: "lấp lánh" }).click();
      await parent.page.getByRole("button", { name: "Hoàn thành" }).click();

      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: /Buổi đọc đã hoàn thành|Đã lưu tiến độ đọc/,
        }),
      ).toBeVisible();

      // Difficult Words practice loop
      await parent.page.goto(
        `/reports/difficult-words?childId=${OPAQUE_CHILD_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await expect(parent.page.getByText("lấp lánh").first()).toBeVisible();

      const startRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/start`,
        {
          method: "POST",
          body: {
            request_id: makeOpaqueUuid(2, "f1200010"),
            normalized_word: "lấp lánh",
            display_text: "lấp lánh",
          },
        },
      );
      const attemptId = (startRes.json as { attempt_id: string }).attempt_id;

      const wavB64 = makeMinimalWavBuffer(300).toString("base64");
      const evalStatus = await parent.page.evaluate(
        async ({ baseUrl, bearer, cid, aid, b64 }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const form = new FormData();
          form.append("completion_request_id", "w02-eval");
          form.append("file", new Blob([bin], { type: "audio/wav" }), "w.wav");
          const r = await fetch(
            `${baseUrl}/system/difficult-words/${cid}/practice/${aid}/evaluate-audio`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${bearer}` },
              body: form,
            },
          );
          return r.status;
        },
        {
          baseUrl: api.apiOrigin,
          bearer: parent.getAccessToken() ?? "",
          cid: OPAQUE_CHILD_ID,
          aid: attemptId,
          b64: wavB64,
        },
      );
      expect(evalStatus).toBe(200);

      await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/${attemptId}/complete`,
        { method: "POST", body: { completion_request_id: "w02-done" } },
      );

      // Launch Sentence Shooter -> complete round -> verify /reports analytics
      await parent.page.goto(
        `/entertainment/sentence-shooter?book_id=${OPAQUE_BOOK_ID}&source=reading-completion&reading_session_id=${OPAQUE_SESSION_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await parent.page
        .getByRole("button", { name: /Bắt đầu|Chơi ngay/ })
        .first()
        .click();
      await parent.page.getByRole("button", { name: "Ánh nắng" }).click();
      await parent.page.getByRole("button", { name: "lấp lánh" }).click();
      await expect(
        parent.page.getByTestId("practiced-difficult-words"),
      ).toBeVisible();

      await parent.page.goto("/reports", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByText("Kỹ năng ngôn ngữ 1", { exact: true }),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T4-W03] Parent Private Book Ingestion -> Flow 2 Contribution -> Reading (F-06->F-18->F-10->F-07->F-20)", async ({
    browser,
  }) => {
    const sharedState = createTier34State();
    sharedState.cluster2.privateBooks = [
      makePrivateBookDetail({
        book: makePrivateBookListItem({
          id: OPAQUE_PRIVATE_BOOK_ID,
          title: "Truyện Ba Mẹ Tự Viết",
          source_type: "SELF_AUTHORED",
          rights_eligible_for_training: true,
          committed_page_count: 0,
          readable_for_children: false,
        }),
        pages: [],
        submissions: [
          makePrivateBookSubmission({
            id: OPAQUE_SUBMISSION_ID,
            book_id: OPAQUE_PRIVATE_BOOK_ID,
            spelling_accepted: false,
            can_add_to_book: false,
            proofread_suggestions: [
              {
                word_index: 0,
                original: "meo",
                suggested: "mèo",
                uncertain: false,
              },
            ],
          }),
        ],
      }),
    ];

    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const admin = await createRoleContext(browser, "admin");
    try {
      const parentErrors = attachPageErrorCollector(parent.page);
      const adminErrors = attachPageErrorCollector(admin.page);

      const parentApi = await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );
      await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      await mockSupabaseStorageImages(parent.page);

      // 1. Create SELF_AUTHORED book on /my-books
      await parent.page.goto("/my-books", { waitUntil: "domcontentloaded" });
      await fillHydrated(
        parent.page.getByLabel(/Tên sách|Tiêu đề/i).first(),
        "Sách Đọc Tối Nay",
      );
      await parent.page
        .getByRole("button", { name: /Tạo sách|Thêm sách/i })
        .first()
        .click();
      await expect(parent.page).toHaveURL(/\/my-books\/[^/?]+$/);

      // 2. Open existing private book with PDF upload, spelling accept, Flow 2 opt-in & addPage
      await parent.page.goto(`/my-books/${OPAQUE_PRIVATE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const fileInput = parent.page.locator('input[type="file"]').first();
      await fileInput.setInputFiles({
        name: "trang-moi.pdf",
        mimeType: "application/pdf",
        buffer: makeMinimalPdfBuffer("Mèo con đi học"),
      });

      await parent.page
        .getByRole("button", { name: "Chấp nhận đề xuất chính tả" })
        .click();
      await parent.page
        .getByLabel(
          "Tôi xác nhận có quyền cho phép ViRead sử dụng ảnh cắt từng dòng chữ và nội dung tương ứng của cuốn sách này để cải thiện nhận diện chữ.",
        )
        .check();
      await parent.page
        .getByRole("button", { name: "Bật đóng góp mẫu nhận diện" })
        .click();

      // Admin verifies Flow 2 candidate
      await admin.page.goto("/admin/metadata-quality?tab=user-books", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("tab", { name: "Xác minh mẫu đóng góp" })
        .click();
      await admin.page
        .getByRole("button", { name: "Xác nhận nhãn (Đạt · Đẩy đồng bộ)" })
        .click();
      await expect
        .poll(() => sharedState.flow2Candidates[0]?.status)
        .toBe("APPROVED");

      // Parent commits page & reads private book with PRIVATE TTS isolation
      await parent.page
        .getByRole("button", { name: "Thêm trang vào sách" })
        .click();
      await expect(
        parent.page.getByText("Các trang đã thêm vào sách đọc (1)"),
      ).toBeVisible();

      await parent.page.goto(
        `/reading-preparation?bookId=${OPAQUE_PRIVATE_BOOK_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await parent.page.getByRole("button", { name: "Bắt đầu đọc" }).click();
      await expect(parent.page).toHaveURL(
        new RegExp(`/reading/${OPAQUE_SESSION_ID}`),
      );

      const ttsRes = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        "/voice/text-to-speech",
        {
          method: "POST",
          body: {
            text: "Mèo con đi học",
            voice_id: OPAQUE_VOICE_NORTH_ID,
            book_id: OPAQUE_PRIVATE_BOOK_ID,
            cache_scope: "PRIVATE",
          },
        },
      );
      expect(ttsRes.status).toBe(200);
      expect(ttsRes.headers["x-tts-scope"]).toBe("PRIVATE");
      expect(ttsRes.headers["cache-control"]).toBe("private, no-store");

      // Foreign private book ID returns 404
      const foreignRes = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        `/books/my-books/${makeOpaqueUuid(999, "82000000")}`,
      );
      expect(foreignRes.status).toBe(404);

      assertNoUnexpectedPageErrors(parentErrors, {
        allowFailedResourceStatuses: [404],
      });
      adminErrors.assertNoErrors();
    } finally {
      await Promise.all([parent.dispose(), admin.dispose()]);
    }
  });

  test("[T4-W04] Camera Page Match & Offline-Capable Book Scanner Recovery (F-09->F-05->F-07)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      state.cluster3.page1 = makeReadingPageDto();
      state.cluster3.page2 = makeReadingPage2Dto();
      let jobPolls = 0;
      state.cluster3.overrides = {
        [`GET /reading/scan-page-ocr/jobs/${OPAQUE_SCAN_JOB_ID}`]: () => {
          jobPolls += 1;
          return {
            status: 200,
            body: makeLocalOcrScanJob({
              job_id: OPAQUE_SCAN_JOB_ID,
              status: jobPolls >= 2 ? "SUCCEEDED" : "QUEUED",
              worker_online: true,
              result:
                jobPolls >= 2
                  ? makeLocalOcrPageScan({
                      ocr_text: "Ánh nắng lấp lánh trên mặt hồ xanh.",
                      match_confidence: 0.94,
                      matched_page: makeReadingPageDto({
                        page_id: OPAQUE_PAGE_2_ID,
                      }),
                      matched_book_id: OPAQUE_BOOK_ID,
                    })
                  : null,
            }),
          };
        },
      };
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );
      await mockSupabaseStorageImages(parent.page);

      await parent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });

      // Upload valid PNG -> 202 job card -> SUCCEEDED LTR result
      await parent.page.getByTestId("local-ocr-file-input").setInputFiles({
        name: "page2.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });
      await expect(parent.page.getByTestId("async-ocr-job-card")).toBeVisible();
      await expect(
        parent.page.getByTestId("ocr-worker-online-badge"),
      ).toBeVisible();
      await expect(parent.page.getByTestId("local-ocr-result")).toBeVisible({
        timeout: 15_000,
      });
      await expect(parent.page.getByTestId("local-ocr-text")).toHaveAttribute(
        "dir",
        "ltr",
      );

      // Boundary: >12MB scan rejected cleanly (413) & worker_offline queue cancel
      state.faults["POST /reading/scan-page-ocr/jobs"] = {
        status: 413,
        body: { detail: "SCAN_FILE_TOO_LARGE" },
      };
      await parent.page.getByTestId("local-ocr-file-input").setInputFiles({
        name: "oversized.png",
        mimeType: "image/png",
        buffer: makeOversizedBuffer(OVERSIZED_SCAN_BYTES),
      });
      await expect(
        parent.page.locator('[role="alert"]:not(#__next-route-announcer__)'),
      ).toBeVisible();

      delete state.faults["POST /reading/scan-page-ocr/jobs"];
      state.faults["POST /reading/scan-page-ocr/jobs"] = {
        status: 429,
        body: { detail: "RATE_LIMITED" },
      };
      const burstRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/reading/scan-page-ocr/jobs",
        { method: "POST", body: {} },
      );
      expect(burstRes.status).toBe(429);

      // Navigate matched page into reading-preparation & reading session
      await parent.page.goto(
        `/books/${OPAQUE_BOOK_ID}?pageId=${OPAQUE_PAGE_2_ID}&confidence=0.94`,
        { waitUntil: "domcontentloaded" },
      );
      await parent.page.goto(
        `/reading-preparation?bookId=${OPAQUE_BOOK_ID}&pageId=${OPAQUE_PAGE_2_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await parent.page.getByRole("button", { name: "Bắt đầu đọc" }).click();
      await expect(parent.page).toHaveURL(
        new RegExp(`/reading/${OPAQUE_SESSION_ID}`),
      );
      expect(
        state.readingSessionsById[OPAQUE_SESSION_ID]?.selected_page_id,
      ).toBe(OPAQUE_PAGE_2_ID);

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [413, 429],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T4-W05] Opt-In Reading Presence Pause & Cron Email Alert Lifecycle (F-08->F-07->F-13)", async ({
    browser,
    request,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const state = createTier34State();
    state.cluster3.sessionSummary = { state: "LISTENING" };
    const apiOrigin = (
      process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim() ||
      process.env.NEXT_PUBLIC_API_URL?.trim() ||
      `http://127.0.0.1:${process.env.VIREAD_OPAQUE_API_PORT?.trim() || "18180"}`
    ).replace(/\/+$/, "");

    try {
      await request.post(`${apiOrigin}/__contract/reset`);
      const errors = attachPageErrorCollector(parent.page);
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

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
              ctx.fillStyle = "#202020";
              ctx.fillRect(0, 0, 160, 120);
            }
            return canvas.captureStream(5);
          }
          return origGetUserMedia(constraints);
        };
      });

      // Enable presence opt-in & verify extra=forbid rejection
      await parent.page.goto("/settings", { waitUntil: "domcontentloaded" });
      const forbidRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/reading-presence/settings",
        {
          method: "PUT",
          body: { email_enabled: true, parent_email: "forged@evil.com" },
        },
      );
      expect(forbidRes.status).toBe(422);

      const enableRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/reading-presence/settings",
        { method: "PUT", body: { email_enabled: true } },
      );
      expect(enableRes.status).toBe(200);

      // Scenario A: absence pauses UI, arms alert, confirms & dispatches cron
      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByText(
          "ViRead đã tạm dừng vì một lúc không thấy người đọc trong khung hình. Bé quay lại thì bấm Tiếp tục nhé.",
        ),
      ).toBeVisible({ timeout: 15_000 });

      const alertIds = Object.keys(state.cluster3.presenceAlertsById ?? {});
      expect(alertIds.length).toBeGreaterThanOrEqual(1);
      await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/reading-presence/alerts/${alertIds[0]}/confirm`,
        { method: "POST" },
      );

      const cronRes = await request.post(
        "/api/cron/parent-emails?scope=presence",
        { headers: { Authorization: `Bearer ${OPAQUE_CRON_SECRET}` } },
      );
      expect(cronRes.status()).toBe(200);
      const statsRes = await request.get(`${apiOrigin}/__contract/stats`);
      const statsJson = (await statsRes.json()) as {
        cronAttempts: number;
        requests: Array<{
          path: string;
          headers: Record<string, string>;
        }>;
      };
      expect(statsJson.cronAttempts).toBe(1);
      expect(
        statsJson.requests.some(
          (r) =>
            r.path === "/parent-notifications/cron/dispatch" &&
            r.headers["x-cron-secret"] === OPAQUE_CRON_SECRET,
        ),
      ).toBe(true);

      // Scenario B: RETURNED cancel prevents further dispatch
      await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/reading-presence/alerts/${alertIds[0]}/cancel`,
        { method: "POST", body: { reason: "RETURNED" } },
      );
      const dispatchAfterReturn = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/parent-notifications/cron/dispatch?scope=presence",
        { method: "POST" },
      );
      expect(
        (dispatchAfterReturn.json as { presence_sent: number }).presence_sent,
      ).toBe(0);

      // Keep unused constant check clean
      expect(OPAQUE_EPISODE_ID).toBeTruthy();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [422],
      });
    } finally {
      await request
        .post(`${apiOrigin}/__contract/reset`)
        .catch(() => undefined);
      await parent.dispose();
    }
  });

  test("[T4-W06] Reading Management Goals, Plans, Reminders & Weekly Digest Cron (F-13->F-07->F-17)", async ({
    browser,
    request,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      locale: "en",
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const apiOrigin = (
      process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim() ||
      process.env.NEXT_PUBLIC_API_URL?.trim() ||
      `http://127.0.0.1:${process.env.VIREAD_OPAQUE_API_PORT?.trim() || "18180"}`
    ).replace(/\/+$/, "");

    try {
      await request.post(`${apiOrigin}/__contract/reset`);
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      state.readingGoals[0] = {
        ...state.readingGoals[0]!,
        target_value: 30,
        current_value: 0,
        progress_percent: 0,
      };
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

      // 1. /reading-management loads top-level arrays & creates goal + acknowledges occurrence
      await parent.page.goto("/reading-management", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.locator("section.reading-organizer"),
      ).toBeVisible();
      await expect(
        parent.page.locator(`[data-due-id="${OPAQUE_C4_OCCURRENCE_ID}"]`),
      ).toBeVisible();
      await parent.page
        .locator(`[data-due-id="${OPAQUE_C4_OCCURRENCE_ID}"]`)
        .getByRole("button")
        .first()
        .click();
      await expect
        .poll(() => state.dueOccurrences[0]?.status)
        .toBe("ACKNOWLEDGED");

      // 2. /settings updates notification preferences with X-ViRead-Locale: en
      await parent.page.goto("/settings", { waitUntil: "domcontentloaded" });
      const emailSection = parent.page.locator("#email-notifications");
      await expect(emailSection).toBeVisible();
      await emailSection.getByRole("switch").first().click();
      await emailSection.locator('button[type="submit"]').first().click();
      await expect
        .poll(() =>
          state.seenLocaleHeaders.some(
            (h) =>
              h.path === "/parent-notifications/preferences" &&
              h.locale === "en",
          ),
        )
        .toBe(true);

      // 3. Complete reading session -> goal progress advances
      await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        `/reading/sessions/${OPAQUE_SESSION_ID}/finish`,
        { method: "POST", body: { duration_ms: 900_000 } },
      );
      await parent.page.goto("/reading-management", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByText("15 / 30")).toBeVisible();

      // 4. Cron retry on transient 502 + 401 guard + delivery history on /settings
      const badCron = await request.post("/api/cron/parent-emails?scope=all", {
        headers: { Authorization: "Bearer bad_secret" },
      });
      expect(badCron.status()).toBe(401);

      await request.post(`${apiOrigin}/__contract/fault`, {
        data: {
          method: "POST",
          path: "/parent-notifications/cron/dispatch",
          status: 502,
          remaining: 1,
          body: { detail: "TRANSIENT_502" },
        },
      });
      const goodCron = await request.post("/api/cron/parent-emails?scope=all", {
        headers: { Authorization: `Bearer ${OPAQUE_CRON_SECRET}` },
      });
      expect(goodCron.status()).toBe(200);

      await parent.page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByText("Email thử nghiệm từ ViRead"),
      ).toBeVisible();

      errors.assertNoErrors();
    } finally {
      await request
        .post(`${apiOrigin}/__contract/reset`)
        .catch(() => undefined);
      await parent.dispose();
    }
  });

  test("[T4-W07] Entertainment V4 Multi-Game & Adaptive Analytics Journey (F-14->F-03->F-12)", async ({
    browser,
  }) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      const api = await installApiMock(
        parent.page,
        createTier34ApiHandler(state),
      );

      // 1. Hub child selector & recommendations
      await parent.page.goto("/entertainment", {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.getByTestId("hub-child-selector")).toBeVisible();
      await expect(parent.page.getByText("lấp lánh").first()).toBeVisible();

      // 2. Game 1: Sentence Shooter + idempotent client_shot_id
      await parent.page.goto("/entertainment/sentence-shooter", {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByRole("button", { name: /Bắt đầu|Chơi ngay/ })
        .first()
        .click();
      await expect(parent.page.getByTestId("session-score")).toBeVisible();
      await parent.page.getByRole("button", { name: "Ánh nắng" }).click();
      await parent.page.getByRole("button", { name: "lấp lánh" }).click();
      await expect(
        parent.page.getByTestId("practiced-difficult-words"),
      ).toBeVisible();

      // 3. Game 2: Picture Description sample + 422 UNSAFE_PICTURE fail-closed check
      await parent.page.goto("/entertainment/picture-description", {
        waitUntil: "domcontentloaded",
      });
      await parent.page
        .getByRole("button", { name: /Khu vườn buổi sáng|Bắt đầu/ })
        .first()
        .click();
      await parent.page
        .locator("textarea")
        .first()
        .fill("Khu vườn có hoa vàng và gió thổi rì rào.");
      await parent.page
        .getByRole("button", { name: /Gửi|Chấm điểm/ })
        .first()
        .click();
      await expect(
        parent.page.getByText("Câu miêu tả của con rất sinh động!"),
      ).toBeVisible();

      const unsafeRes = await apiFetchInPage(
        parent.page,
        api.apiOrigin,
        parent.getAccessToken(),
        "/games/picture-description/sessions",
        {
          method: "POST",
          body: { child_id: OPAQUE_CHILD_ID, source_type: "unsafe" },
        },
      );
      expect(unsafeRes.status).toBe(422);

      // 4. Game 3: Memory Game observe -> recall -> creative
      await parent.page.goto("/entertainment/memory-game", {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByTestId("timer-option-30S").click();
      await parent.page.getByTestId("start-memory-game-btn").click();
      await expect(parent.page.getByTestId("observe-stage")).toBeVisible();
      const readyBtn = parent.page.getByRole("button", {
        name: /Sẵn sàng nhớ lại|Bắt đầu nhớ lại/,
      });
      if ((await readyBtn.count()) > 0) {
        await readyBtn.first().click();
      }
      await expect(parent.page.getByTestId("recall-stage")).toBeVisible();
      await parent.page
        .getByTestId("recall-textarea")
        .fill("Quả bóng đỏ ở giữa vườn.");
      await parent.page.getByTestId("submit-recall-btn").click();
      await expect(parent.page.getByTestId("reveal-stage")).toBeVisible();

      // 5. /reports 16-skill mastery & null UNKNOWN preservation
      await parent.page.goto("/reports", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByText("Kỹ năng ngôn ngữ 1", { exact: true }),
      ).toBeVisible();
      await expect(
        parent.page.getByText("Kỹ năng ngôn ngữ 16", { exact: true }),
      ).toBeVisible();

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [422],
      });
    } finally {
      await parent.dispose();
    }
  });

  test("[T4-W08] Karaoke Practice & Admin Simple-Import Lifecycle (F-15->F-14->F-17)", async ({
    browser,
  }) => {
    const sharedState = createTier34State({ actorRole: "admin" });
    const admin = await createRoleContext(browser, "admin");
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const adminErrors = attachPageErrorCollector(admin.page);
      const parentErrors = attachPageErrorCollector(parent.page);

      await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      const parentApi = await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );

      // 1. Admin /admin/karaoke/new simple-import -> simple-publish
      await admin.page.goto("/admin/karaoke/new", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .locator('input[type="file"][accept*=".mp3"]')
        .first()
        .setInputFiles({
          name: "bai-hat-moi.mp3",
          mimeType: "audio/mpeg",
          buffer: makeMinimalMp3Buffer(),
        });
      await admin.page
        .getByRole("button", { name: "Tự động tạo karaoke" })
        .click();

      await expect(admin.page.getByTestId("audio-type-badge")).toBeVisible();
      await expect(
        admin.page.getByTestId("simple-pipeline-card"),
      ).toBeVisible();
      await expect(
        admin.page.getByTestId("simple-pipeline-lifecycle"),
      ).toBeVisible();

      await admin.page
        .getByLabel("Tôi xác nhận quyền sử dụng bài hát phù hợp")
        .check();
      await admin.page
        .getByLabel("Tôi xác nhận nội dung phù hợp trẻ em lớp 1–5")
        .check();
      await admin.page.getByRole("button", { name: "Xuất bản ngay" }).click();
      await expect(admin.page.getByText("Đã xuất bản bài hát")).toBeVisible();

      const publishedCard = sharedState.karaokeCatalogSongs[0] as {
        song_id: string;
        version_id: string;
      };

      // 2. Parent /karaoke -> /karaoke/[songId] -> save practice -> /reports
      await parent.page.goto("/karaoke", { waitUntil: "domcontentloaded" });
      await parent.page
        .locator(`a[href*="/karaoke/${publishedCard.song_id}"]`)
        .first()
        .click();
      await expect(parent.page).toHaveURL(
        new RegExp(`/karaoke/${publishedCard.song_id}`),
      );
      await expect(parent.page.getByTestId("karaoke-stage")).toBeVisible();
      await expect(
        parent.page.getByTestId("karaoke-active-line"),
      ).toBeVisible();
      await expect(
        parent.page.locator(".viread-learning-content").first(),
      ).toHaveAttribute("dir", "ltr");

      const saveRes = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        "/karaoke/practice-sessions",
        {
          method: "POST",
          body: {
            child_id: OPAQUE_CHILD_ID,
            song_id: publishedCard.song_id,
            song_version_id: publishedCard.version_id,
            practice_mode: "FULL_SONG",
            scoring_mode: "FULL_MUSICAL",
            playback_rate: 0.9,
            headphone_mode: false,
            overall_score: 91,
            rhythm_score: 90,
            pitch_score: 92,
            lyrics_score: 90,
            fluency_score: 91,
            stars: 3,
            segment_start_ms: null,
            segment_end_ms: null,
            report_payload: {},
          },
        },
      );
      expect(saveRes.status).toBe(201);

      await parent.page.goto("/reports", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByText("Karaoke thiếu nhi").first(),
      ).toBeVisible();

      adminErrors.assertNoErrors();
      parentErrors.assertNoErrors();
    } finally {
      await Promise.all([admin.dispose(), parent.dispose()]);
    }
  });

  test("[T4-W09] @mobile RTL Internationalization (ar/he) + Child Reading LTR Lock (F-17->F-07->F-16)", async ({
    browser,
  }, testInfo) => {
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      viewport: getProjectViewport(testInfo),
    });
    try {
      const errors = attachPageErrorCollector(parent.page);
      const state = createTier34State();
      await installApiMock(parent.page, createTier34ApiHandler(state));

      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      await parent.page
        .locator('button[aria-haspopup="dialog"][aria-expanded]')
        .first()
        .click();
      await parent.page
        .locator('[role="option"][data-locale-code="ar"]')
        .click();

      await expect(parent.page.locator("html")).toHaveAttribute("lang", "ar");
      await expect(parent.page.locator("html")).toHaveAttribute("dir", "rtl");

      // Navigate /books & /settings under RTL
      await parent.page.goto("/books", { waitUntil: "domcontentloaded" });
      await expect(parent.page.locator("html")).toHaveAttribute("dir", "rtl");

      // Reading page preserves .viread-learning-content dir=ltr lang=vi
      await parent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(parent.page.locator("html")).toHaveAttribute("dir", "rtl");
      const readingLtr = parent.page
        .locator(".viread-learning-content")
        .first();
      await expect(readingLtr).toHaveAttribute("dir", "ltr");
      await expect(readingLtr).toHaveAttribute("lang", "vi");

      // Karaoke page preserves .viread-learning-content dir=ltr lang=vi
      await parent.page.goto(`/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.locator(".viread-learning-content").first(),
      ).toHaveAttribute("dir", "ltr");

      // Assistant sends locale: "ar" inside JSON body (and requestApi sends X-ViRead-Locale: ar)
      await parent.page.getByTestId("viread-assistant-launcher").click();
      await parent.page.locator('input[maxlength="800"]').fill("مرحبا");
      await parent.page.locator('input[maxlength="800"]').press("Enter");
      await expect
        .poll(() =>
          state.seenAssistantRequests.some((r) => r.body.locale === "ar"),
        )
        .toBe(true);
      expect(state.seenLocaleHeaders.some((h) => h.locale === "ar")).toBe(true);

      const noOverflow = await parent.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      );
      expect(noOverflow).toBe(true);

      errors.assertNoErrors();
    } finally {
      await parent.dispose();
    }
  });

  test("[T4-W10] Admin Book Creation -> OCR -> Smart Studio Blocks/Cover -> Quality/Rights Gate -> Publish (F-18->F-19->F-05)", async ({
    browser,
  }) => {
    const sharedState = createTier34State({ actorRole: "admin" });
    const admin = await createRoleContext(browser, "admin");
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    try {
      const adminErrors = attachPageErrorCollector(admin.page);
      const parentErrors = attachPageErrorCollector(parent.page);

      await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );
      await mockSupabaseStorageImages(admin.page);
      await mockSupabaseStorageImages(parent.page);

      // 1. Create book on /admin/books/new
      await admin.page.goto("/admin/books/new", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByLabel(/Tên hệ thống|Mã định danh/i)
        .fill("su-tich-banh-chung");
      await admin.page
        .getByLabel(/Tiêu đề|Tên sách/i)
        .fill("Sự Tích Bánh Chưng");
      await admin.page.getByLabel(/Tác giả/i).fill("Dân gian Việt Nam");
      await admin.page.getByRole("button", { name: /Tạo sách|Lưu/i }).click();
      await expect(admin.page).toHaveURL(/\/admin\/books\/([^/?]+)$/);
      const newBookId = new URL(admin.page.url()).pathname.split("/").pop()!;

      // 2. Upload page PNG on /admin/books/[bookId]
      await admin.page.locator('input[type="file"]').first().setInputFiles({
        name: "page-1.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });
      await admin.page
        .getByRole("button", { name: /Tải lên|Upload/i })
        .first()
        .click();
      await expect
        .poll(
          () => (sharedState.cluster2.adminPagesByBook[newBookId] ?? []).length,
        )
        .toBeGreaterThanOrEqual(1);
      const newPageId =
        sharedState.cluster2.adminPagesByBook[newBookId]![0]!.processing
          .page_id;

      // 3. Cover Studio upload on /admin/books/[bookId]/edit
      await admin.page.goto(`/admin/books/${newBookId}/edit`, {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("button", { name: "Mở Cover Studio" }).click();
      await admin.page.getByTestId("cover-gallery-input").setInputFiles({
        name: "cover.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });
      await admin.page.getByRole("button", { name: "Cắt giữa 80%" }).click();
      await admin.page.getByRole("button", { name: "Lưu ảnh bìa" }).click();
      await expect(admin.page.getByText("Đã lưu ảnh bìa mới")).toBeVisible();

      // 4. Smart OCR Block Review -> apply-to-draft -> verify page
      await admin.page.goto(`/admin/books/${newBookId}/pages/${newPageId}`, {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("tab", { name: /Khối thông minh V2/i })
        .click();
      await admin.page
        .getByRole("button", { name: "Mở phân loại khối chữ thông minh" })
        .click();
      await admin.page.getByRole("button", { name: "Loại bỏ" }).first().click();
      await admin.page.getByTestId("apply-ocr-to-draft-btn").click();
      await admin.page
        .getByRole("button", { name: "XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG" })
        .click();
      await expect
        .poll(
          () =>
            sharedState.cluster2.adminRevisionsByPage[newPageId]
              ?.verification_status,
        )
        .toBe("VERIFIED");

      // 5. Quality & Rights Gate -> Approve
      await admin.page.goto("/admin/metadata-quality?tab=approval", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: "Xem kết quả" })
        .first()
        .click();
      const rightsPanel = admin.page.getByTestId("book-rights-panel");
      await rightsPanel.locator("select").selectOption("RIGHTS_REVIEWED");
      await rightsPanel.locator("input").nth(0).fill("PUBLIC_DOMAIN");
      await rightsPanel.locator("input").nth(1).fill("Truyện cổ tích Việt Nam");
      await rightsPanel
        .getByRole("button", { name: "Lưu hồ sơ quyền sử dụng" })
        .click();
      await expect(rightsPanel.getByRole("status")).toBeVisible();

      await admin.page
        .locator("textarea")
        .last()
        .fill("Đủ điều kiện xuất bản cho thiếu nhi.");
      await admin.page
        .getByRole("button", { name: "Phê duyệt toàn bộ sách" })
        .click();
      await expect
        .poll(() =>
          sharedState.cluster2.catalogBooks.some((b) => b.id === newBookId),
        )
        .toBe(true);

      // 6. Parent sees published book & cover on /books & /books/[bookId]
      await parent.page.goto("/books", { waitUntil: "domcontentloaded" });
      await expect(parent.page.getByText("Sự Tích Bánh Chưng")).toBeVisible();
      await parent.page.goto(`/books/${newBookId}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        parent.page.getByRole("heading", { name: "Sự Tích Bánh Chưng" }),
      ).toBeVisible();

      adminErrors.assertNoErrors();
      parentErrors.assertNoErrors();
    } finally {
      await Promise.all([admin.dispose(), parent.dispose()]);
    }
  });

  test("[T4-W11] User Content Report -> Admin Resolution Loop (F-18->F-05)", async ({
    browser,
  }) => {
    const sharedState = createTier34State();
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const admin = await createRoleContext(browser, "admin");
    try {
      const parentErrors = attachPageErrorCollector(parent.page);
      const adminErrors = attachPageErrorCollector(admin.page);

      await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );
      await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      await mockSupabaseStorageImages(parent.page);
      await mockSupabaseStorageImages(admin.page);

      // 1. Parent reports book content error on /books/[bookId]
      await parent.page.goto(`/books/${OPAQUE_BOOK_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Báo lỗi sách" }).click();
      const dialog = parent.page.getByRole("dialog");
      await dialog
        .locator("#book-report-description")
        .fill("Từ cuối trang 1 bị sai dấu thanh.");
      await dialog.getByRole("button", { name: "Gửi báo cáo" }).click();
      await expect(
        dialog.getByText("Báo cáo đã được lưu thành công."),
      ).toBeVisible();
      await dialog.getByRole("link", { name: "Xem báo cáo của tôi" }).click();
      await expect(parent.page).toHaveURL(/\/book-reports$/);

      // 2. Admin edits/verifies page & resolves report on /admin/metadata-quality?tab=reports
      await admin.page.goto(
        `/admin/books/${OPAQUE_BOOK_ID}/pages/${OPAQUE_PAGE_ID}`,
        { waitUntil: "domcontentloaded" },
      );
      await admin.page.locator("#ocr-text").fill("Chú mèo đi hia đã sửa dấu.");
      await admin.page.getByRole("button", { name: "Lưu bản nháp" }).click();
      await admin.page
        .getByRole("button", { name: "XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG" })
        .click();

      await admin.page.goto("/admin/metadata-quality?tab=reports", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: "Xem chi tiết" })
        .first()
        .click();
      await admin.page
        .locator("#report-resolution-note")
        .fill("Đã cập nhật dấu thanh chuẩn ở trang 1.");
      await admin.page
        .getByRole("button", { name: "Giải quyết báo cáo" })
        .click();
      await expect
        .poll(() => sharedState.cluster2.qualityReports[0]?.status)
        .toBe("RESOLVED");

      // 3. Parent reloads /book-reports & views Admin resolution note
      await parent.page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByText("Đã giải quyết").first(),
      ).toBeVisible();
      await parent.page
        .getByRole("button", { name: "Xem phản hồi Admin" })
        .first()
        .click();
      await expect(
        parent.page.getByTestId("parent-report-detail"),
      ).toContainText("Đã cập nhật dấu thanh chuẩn ở trang 1.");

      parentErrors.assertNoErrors();
      adminErrors.assertNoErrors();
    } finally {
      await Promise.all([parent.dispose(), admin.dispose()]);
    }
  });

  test("[T4-W12] Admin User Governance & Fail-Closed Deactivation (Active=0) (F-04->F-01->F-10->F-22)", async ({
    browser,
  }) => {
    const sharedState = createTier34State({ actorRole: "admin" });
    const admin = await createRoleContext(browser, "admin");
    const parent = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const unheadered = await createRoleContext(browser, "guest");
    try {
      const adminErrors = attachPageErrorCollector(admin.page);
      const parentErrors = attachPageErrorCollector(parent.page);

      await installApiMock(
        admin.page,
        createTier34ApiHandler(sharedState, { roleOverride: "admin" }),
      );
      const parentApi = await installApiMock(
        parent.page,
        createTier34ApiHandler(sharedState, { roleOverride: "parent" }),
      );

      // 1. Admin creates parent & updates profile
      await admin.page.goto("/admin/parents", {
        waitUntil: "load",
      });
      await expect(admin.page.getByText("Phụ huynh Kiểm thử")).toBeVisible();
      const createDialog = admin.page.getByRole("dialog");
      await expect(async () => {
        await admin.page.getByRole("button", { name: "Thêm Parent" }).click();
        await expect(createDialog).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });
      await fillHydrated(
        createDialog.getByLabel("Tên hiển thị"),
        "Phạm Hải Yến",
      );
      await fillHydrated(createDialog.getByLabel("Email"), "yen@viread.local");
      await createDialog.getByRole("button", { name: "Tạo Parent" }).click();
      await expect(admin.page.getByText("Phạm Hải Yến")).toBeVisible();

      await admin.page.goto(`/admin/parents/${OPAQUE_PARENT_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByRole("button", { name: "Sửa hồ sơ" }).click();
      const editDialog = admin.page.getByRole("dialog");
      await editDialog
        .getByLabel("Tên hiển thị")
        .fill("Phụ huynh Kiểm thử Cập Nhật");
      await editDialog.getByRole("button", { name: "Lưu thay đổi" }).click();

      // 2. Parent active -> /dashboard & /help-support & /voice/status succeed
      await parent.page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      await expect(
        parent.page.getByRole("heading", {
          level: 1,
          name: "Góc đọc gia đình",
        }),
      ).toBeVisible();
      const voiceOk = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        "/voice/status",
      );
      expect(voiceOk.status).toBe(200);
      await parent.page.goto("/help-support", {
        waitUntil: "domcontentloaded",
      });

      // 3. Admin soft-deactivates parent
      await admin.page.goto("/admin/parents", {
        waitUntil: "domcontentloaded",
      });
      await admin.page
        .getByRole("button", { name: "Vô hiệu hóa" })
        .first()
        .click();
      await admin.page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Vô hiệu hóa Parent" })
        .click();
      await expect
        .poll(() =>
          sharedState.cluster1.deactivatedParentIds.includes(OPAQUE_PARENT_ID),
        )
        .toBe(true);
      adminErrors.assertNoErrors();

      // 4. Three-layer fail-closed check:
      // Layer A: Client API calls return 403
      const voiceBlocked = await apiFetchInPage(
        parent.page,
        parentApi.apiOrigin,
        parent.getAccessToken(),
        "/voice/status",
      );
      expect(voiceBlocked.status).toBe(403);

      await parent.page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await fillHydrated(parent.page.locator("#support-subject"), "Bị khóa");
      await fillHydrated(
        parent.page.locator("#support-message"),
        "Kiểm tra chặn 403 sau khi vô hiệu hóa.",
      );
      await fillHydrated(
        parent.page.locator("#support-contact-email"),
        "parent@viread.local",
      );
      await parent.page.locator('form button[type="submit"]').click();
      await expect(
        parent.page.locator('[role="alert"]:not(#__next-route-announcer__)'),
      ).toBeVisible();

      // Layer B: Clear fixture headers -> real SSR guard redirects 307 /login
      await parent.context.setExtraHTTPHeaders({});
      const ssrRes = await parent.context.request.get("/dashboard", {
        maxRedirects: 0,
      });
      expect(ssrRes.status()).toBe(307);
      expect(
        new URL(ssrRes.headers().location ?? "", parent.baseURL).pathname,
      ).toBe("/login");

      // Layer C: Un-headered login with Supabase active=0 fails closed
      await installApiMock(
        unheadered.page,
        createTier34ApiHandler(sharedState),
      );
      await mockSupabasePasswordAuth(unheadered.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
        active: 0,
      });
      await unheadered.page.goto("/login", { waitUntil: "load" });
      await fillHydrated(
        unheadered.page.getByLabel("Email của ba mẹ"),
        "parent@viread.local",
      );
      await fillHydrated(
        unheadered.page.getByLabel("Mật khẩu", { exact: true }),
        "SecretPass123!",
      );
      await unheadered.page.getByRole("button", { name: "Đăng nhập" }).click();
      await expect(
        unheadered.page.locator(
          '[role="alert"]:not(#__next-route-announcer__)',
        ),
      ).toBeVisible();

      assertNoUnexpectedPageErrors(parentErrors, {
        allowFailedResourceStatuses: [403],
      });
    } finally {
      await Promise.all([
        admin.dispose(),
        parent.dispose(),
        unheadered.dispose(),
      ]);
    }
  });

  test("[T4-W13] @mobile Role-Isolated AI Assistant & Offline Support Fallback (F-16->F-22->F-01)", async ({
    browser,
  }, testInfo) => {
    const viewport = getProjectViewport(testInfo);
    const guest = await createRoleContext(browser, "guest", { viewport });
    const parent = await createRoleContext(browser, "parent", { viewport });
    const admin = await createRoleContext(browser, "admin", { viewport });
    try {
      const guestState = createTier34State({ actorRole: "guest" });
      const parentState = createTier34State({ actorRole: "parent" });
      const adminState = createTier34State({ actorRole: "admin" });
      const parentErrors = attachPageErrorCollector(parent.page);

      await installApiMock(
        guest.page,
        createTier34ApiHandler(guestState, { roleOverride: "guest" }),
      );
      await installApiMock(
        parent.page,
        createTier34ApiHandler(parentState, { roleOverride: "parent" }),
      );
      await installApiMock(
        admin.page,
        createTier34ApiHandler(adminState, { roleOverride: "admin" }),
      );

      // 1. Guest public scope on /login
      await guest.page.goto("/login", { waitUntil: "domcontentloaded" });
      await guest.page.getByTestId("viread-assistant-launcher").click();
      await guest.page
        .locator('input[maxlength="800"]')
        .fill("Hỗ trợ đăng nhập");
      await guest.page.locator('input[maxlength="800"]').press("Enter");
      await expect(
        guest.page.getByText("Gợi ý (public): Hỗ trợ đăng nhập"),
      ).toBeVisible();

      // 2. Parent on /help-support: submit feedback & check verified Vietnamese success copy
      await parent.page.goto("/help-support", {
        waitUntil: "domcontentloaded",
      });
      await parent.page.getByRole("button", { name: "Gửi phản hồi" }).click();
      await fillHydrated(
        parent.page.locator("#support-subject"),
        "Hỏi về gói đọc",
      );
      await fillHydrated(
        parent.page.locator("#support-message"),
        "Cần tư vấn chọn sách lớp 2 cho bé.",
      );
      await fillHydrated(
        parent.page.locator("#support-contact-email"),
        "parent@viread.local",
      );
      await parent.page.locator('form button[type="submit"]').click();
      await expect(
        parent.page.getByText(
          "Hệ thống đã tiếp nhận phản hồi của ba mẹ. ViRead sẽ sử dụng email liên hệ để phản hồi khi có thông tin cập nhật.",
        ),
      ).toBeVisible();

      // 3. Admin scope on /admin/health
      await admin.page.goto("/admin/health", {
        waitUntil: "domcontentloaded",
      });
      await admin.page.getByTestId("viread-assistant-launcher").click();
      await admin.page.locator('input[maxlength="800"]').fill("Kiểm tra OCR");
      await admin.page.locator('input[maxlength="800"]').press("Enter");
      await expect(
        admin.page.getByText("Gợi ý (admin): Kiểm tra OCR"),
      ).toBeVisible();

      // 4. Offline network fallback on parent assistant without uncaught pageErrors
      await parent.page
        .getByRole("button", { name: "Mở Trợ lý ViRead" })
        .click();
      await parent.context.setOffline(true);
      await parent.page
        .locator('input[maxlength="800"]')
        .fill("Hướng dẫn khi mất mạng");
      await parent.page.locator('input[maxlength="800"]').press("Enter");
      await expect(
        parent.page.getByTestId("viread-assistant-source-meta").last(),
      ).toContainText("Hướng dẫn ngoại tuyến");
      await expect(
        parent.page.getByTestId("viread-assistant-bandwidth-btn"),
      ).toContainText("Ngoại tuyến");

      expect(parentErrors.pageErrors).toEqual([]);
    } finally {
      await Promise.all([guest.dispose(), parent.dispose(), admin.dispose()]);
    }
  });

  test("[T4-W14] @mobile Android WebView Origin, OAuth Loopback & Native Bridge Contract (F-23->F-02->F-01->F-10)", async ({
    browser,
  }, testInfo) => {
    const viewport = getProjectViewport(testInfo);
    const desktopGuest = await createRoleContext(browser, "guest", {
      viewport,
    });
    const androidGuest = await createRoleContext(browser, "android", {
      appRole: "guest",
      viewport,
    });
    const androidAdmin = await createRoleContext(browser, "android", {
      appRole: "admin",
      viewport,
    });
    const androidParent = await createRoleContext(browser, "android", {
      appRole: "parent",
      selectedChildId: OPAQUE_CHILD_ID,
      viewport,
    });

    try {
      // 1. Origin & Health Preflight Contract
      const rootRes = await desktopGuest.context.request.get("/", {
        maxRedirects: 0,
      });
      expect(rootRes.status()).toBe(307);
      const rootLoc = new URL(
        rootRes.headers().location ?? "",
        desktopGuest.baseURL,
      );
      expect(rootLoc.pathname).toBe("/login");
      expect(rootLoc.search).toBe("");

      const loginRes = await desktopGuest.context.request.get("/login", {
        maxRedirects: 0,
      });
      expect(loginRes.status()).toBe(200);
      expect(loginRes.headers()["content-type"]).toContain("text/html");
      const loginHtml = await loginRes.text();
      expect(loginHtml.toLowerCase()).toContain("<html");
      expect(loginHtml).toContain("/_next/");
      expect(loginHtml.toLowerCase()).toContain("viread");
      expect(loginHtml.toLowerCase()).not.toContain("viread project hub");

      const apiOrigin = (
        process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim() ||
        process.env.NEXT_PUBLIC_API_URL?.trim() ||
        `http://127.0.0.1:${process.env.VIREAD_OPAQUE_API_PORT?.trim() || "18180"}`
      ).replace(/\/+$/, "");
      const healthRes = await desktopGuest.context.request.get(
        `${apiOrigin}/health`,
      );
      expect(healthRes.status()).toBe(200);
      const healthBody = (await healthRes.json()) as {
        status?: string;
        database?: unknown;
      };
      expect(["ok", "degraded"]).toContain(healthBody.status);
      expect(typeof healthBody.database).toBe("object");

      // 2. OAuth Loopback & Deep-Link Contract
      let capturedAuthorizeUrl: URL | null = null;
      await mockSupabasePasswordAuth(androidGuest.page, {
        userId: OPAQUE_PARENT_ID,
        email: "parent@viread.local",
        role: "parent",
        onAuthorize: (url) => {
          capturedAuthorizeUrl = url;
        },
      });
      await androidGuest.page.goto("/login", { waitUntil: "domcontentloaded" });
      await androidGuest.page
        .getByRole("button", { name: "Tiếp tục với Google" })
        .click();
      await expect.poll(() => capturedAuthorizeUrl !== null).toBe(true);
      const redir = new URL(
        capturedAuthorizeUrl!.searchParams.get("redirect_to") ?? "",
      );
      expect(redir.origin).toBe("http://127.0.0.1:3000");
      expect(redir.pathname).toBe("/auth/callback");
      expect(
        (redir.searchParams.get("viread_nonce") ?? "").length,
      ).toBeGreaterThanOrEqual(16);

      const deepRes = await desktopGuest.context.request.get(
        "/auth/callback?app_shell=android&code=test_pkce_code&next=%2Fbooks",
        { maxRedirects: 0 },
      );
      expect(deepRes.status()).toBe(307);
      expect(deepRes.headers().location).toBe(
        "viread://auth/callback?code=test_pkce_code&next=%2Fbooks",
      );

      const unsafeDeepRes = await desktopGuest.context.request.get(
        "/auth/callback?app_shell=android&error=access%20denied&next=%2F%2Fevil.com",
        { maxRedirects: 0 },
      );
      expect(unsafeDeepRes.status()).toBe(307);
      expect(unsafeDeepRes.headers().location).toBe(
        "viread://auth/callback?error=oauth_failed",
      );

      const androidErrRes = await androidGuest.context.request.get(
        "/auth/callback?app_shell=android&error=access_denied",
        { maxRedirects: 0 },
      );
      expect(androidErrRes.status()).toBe(307);
      expect(
        (androidErrRes.headers().location ?? "").startsWith("viread://"),
      ).toBe(false);

      // 3. Android Device Detection + ViReadNativeSpeech + viread:android-background
      const adminErrors = attachPageErrorCollector(androidAdmin.page);
      const adminState = createTier34State({ actorRole: "admin" });
      await installApiMock(
        androidAdmin.page,
        createTier34ApiHandler(adminState, { roleOverride: "admin" }),
      );
      await androidAdmin.page.goto("/admin/health", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        androidAdmin.page.getByTestId("admin-client-device-capabilities"),
      ).toContainText("ViRead Android WebView");
      adminErrors.assertNoErrors();

      const parentErrors = attachPageErrorCollector(androidParent.page);
      const parentState = createTier34State();
      parentState.cluster3.overrides = {
        "POST /reading/match-page": {
          status: 200,
          body: makeCameraPageMatchResponse({
            matched: false,
            status_code: "TOO_DARK",
            matched_page: null,
          }),
        },
      };
      await installApiMock(
        androidParent.page,
        createTier34ApiHandler(parentState),
      );
      await androidParent.page.addInitScript(() => {
        const calls: Array<{ method: string; args: unknown }> = [];
        let messageHandler: ((event: { data: string }) => void) | null = null;
        (
          window as unknown as {
            __nativeSpeechCalls: typeof calls;
            ViReadNativeSpeech: {
              postMessage(raw: string): void;
              onmessage: ((event: { data: string }) => void) | null;
            };
          }
        ).__nativeSpeechCalls = calls;
        (
          window as unknown as {
            ViReadNativeSpeech: {
              postMessage(raw: string): void;
              onmessage: ((event: { data: string }) => void) | null;
            };
          }
        ).ViReadNativeSpeech = {
          get onmessage() {
            return messageHandler;
          },
          set onmessage(fn: ((event: { data: string }) => void) | null) {
            messageHandler = fn;
          },
          postMessage(raw: string) {
            const parsed = JSON.parse(raw) as {
              id?: string;
              type?: string;
              text?: string;
              rate?: number;
              pitch?: number;
            };
            calls.push({ method: parsed.type ?? "unknown", args: parsed });
            if (parsed.type === "getCapabilities") {
              messageHandler?.({
                data: JSON.stringify({
                  id: parsed.id,
                  type: "capabilities",
                  ttsReady: true,
                  sttReady: true,
                  voices: ["vi-VN"],
                }),
              });
            }
            if (parsed.type === "speak") {
              messageHandler?.({
                data: JSON.stringify({ id: parsed.id, type: "tts_start" }),
              });
              messageHandler?.({
                data: JSON.stringify({
                  id: parsed.id,
                  type: "tts_done",
                  clampedRate: Math.min(1.4, Math.max(0.6, parsed.rate ?? 1)),
                  clampedPitch: Math.min(2.0, Math.max(0.5, parsed.pitch ?? 1)),
                }),
              });
            }
          },
        };
      });

      await androidParent.page.goto(`/reading/${OPAQUE_SESSION_ID}`, {
        waitUntil: "domcontentloaded",
      });
      const bridgeResult = await androidParent.page.evaluate(() => {
        const events: string[] = [];
        const bridge = (
          window as unknown as {
            ViReadNativeSpeech?: {
              postMessage(raw: string): void;
              onmessage: ((event: { data: string }) => void) | null;
            };
          }
        ).ViReadNativeSpeech;
        if (!bridge) return { present: false, events };
        bridge.onmessage = (evt) => {
          events.push(evt.data);
        };
        bridge.postMessage(
          JSON.stringify({ id: "cap-1", type: "getCapabilities" }),
        );
        bridge.postMessage(
          JSON.stringify({
            id: "spk-1",
            type: "speak",
            text: "Xin chào ViRead",
            rate: 1.0,
            pitch: 1.0,
          }),
        );
        return { present: true, events };
      });
      expect(bridgeResult.present).toBe(true);
      expect(
        bridgeResult.events.some((e) => e.includes("tts_start")) &&
          bridgeResult.events.some((e) => e.includes("tts_done")),
      ).toBe(true);

      // Camera releases on viread:android-background & offers "Bật lại camera"
      await androidParent.page.goto("/book-scanner", {
        waitUntil: "domcontentloaded",
      });
      await androidParent.page
        .getByRole("button", { name: "Bật camera để quét" })
        .click();
      await expect(
        androidParent.page.getByTestId("scanner-camera-viewport"),
      ).toBeVisible();
      await androidParent.page.evaluate(() => {
        document.dispatchEvent(new Event("viread:android-background"));
      });
      const resumeBtn = androidParent.page.getByRole("button", {
        name: "Bật lại camera",
      });
      await expect(resumeBtn).toBeVisible();
      await resumeBtn.click();

      parentErrors.assertNoErrors();
    } finally {
      await Promise.all([
        desktopGuest.dispose(),
        androidGuest.dispose(),
        androidAdmin.dispose(),
        androidParent.dispose(),
      ]);
    }
  });
});
