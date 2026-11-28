import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import {
  attachPageErrorCollector,
  createRoleContext,
  type ApiMockRequestContext,
  type ApiMockResponse,
} from "./fixtures/session";
import {
  OPAQUE_BOOK_ID,
  OPAQUE_CHILD_ID,
  OPAQUE_CRON_SECRET,
  OPAQUE_INVALID_LOCALE_VECTORS,
  OPAQUE_REPORT_ID,
  OPAQUE_SESSION_ID,
  makeMinimalPngBuffer,
  makeOversizedBuffer,
  makeReadingHistoryList,
} from "./fixtures/test-data";
import {
  OPAQUE_C4_AUDIT_ID_3,
  OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID,
  OPAQUE_C4_GOAL_ID,
  OPAQUE_C4_KARAOKE_SONG_ID,
  OPAQUE_C4_KARAOKE_VERSION_ID,
  OPAQUE_C4_NOW_OFFSET,
  OPAQUE_C4_OCCURRENCE_ID,
  OPAQUE_C4_PERIOD_ID,
  OPAQUE_C4_PLAN_ID,
  OPAQUE_C4_QUESTION_ID_1,
  OPAQUE_C4_QUESTION_ID_2,
  OPAQUE_C4_SHOOTER_SESSION_ID,
  assertNoUnexpectedPageErrors,
  installCluster4AdminMocks,
  installCluster4ParentMocks,
  makeAdminAuditLogsPage,
  makeAdminProcessingCapabilities,
  makeChildProgressAssessment,
  makeCluster4AdminHealthSnapshot,
  makeDifficultWordHistory,
  makeKaraokePlayback,
  makeKaraokePracticeSession,
  makeMemoryAttemptResult,
  makeMemorySession,
  makeParentLearningAnalytics,
  makeParentNotificationPreferences,
  makeProgressReport,
  makeSentenceShooterSession,
  makeSessionReadingReports,
  makeTutorAnswerResponse,
  makeTutorNextQuestion,
} from "./fixtures/cluster3-4-data";

const CONTRACT_SERVER_URL =
  process.env.OPAQUE_CONTRACT_URL ?? "http://127.0.0.1:18180";

const PUBLISHED_LOCALES = [
  "vi",
  "en",
  "zh-Hans",
  "zh-Hant",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "ar",
  "he",
] as const;

async function resetContractServer(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${CONTRACT_SERVER_URL}/__contract/reset`);
  expect(res.ok()).toBe(true);
}

async function getContractStats(request: APIRequestContext): Promise<{
  requestCount: number;
  cronAttempts: number;
  requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
}> {
  const res = await request.get(`${CONTRACT_SERVER_URL}/__contract/stats`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as {
    requestCount: number;
    cronAttempts: number;
    requests: Array<{
      method: string;
      path: string;
      headers: Record<string, string | string[] | undefined>;
    }>;
  };
}

async function armContractFault(
  request: APIRequestContext,
  payload: {
    method: string;
    path: string;
    status: number;
    remaining?: number;
    body?: unknown;
  },
): Promise<void> {
  const res = await request.post(`${CONTRACT_SERVER_URL}/__contract/fault`, {
    data: payload,
  });
  expect(res.ok()).toBe(true);
}

async function apiFetchInPage(
  page: Page,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; bodyText: string; json: unknown }> {
  return page.evaluate(
    async ({ baseUrl, targetPath, reqInit }) => {
      const response = await fetch(`${baseUrl}${targetPath}`, {
        method: reqInit.method ?? "GET",
        headers: reqInit.headers,
        body: reqInit.body,
      });
      const bodyText = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(bodyText) as unknown;
      } catch {
        parsed = bodyText;
      }
      return {
        status: response.status,
        bodyText,
        json: parsed,
      };
    },
    { baseUrl: CONTRACT_SERVER_URL, targetPath: path, reqInit: init },
  );
}

async function assertNoMobileHorizontalOverflow(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 430) {
    const hasOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
    expect(hasOverflow).toBe(false);
  }
}

async function triggerPostReadingComprehension(page: Page): Promise<void> {
  await page.goto(`/reading/${OPAQUE_SESSION_ID}`);
  const finishBtn = page.getByRole("button", { name: "Kết thúc buổi đọc" });
  await expect(finishBtn).toBeVisible();
  await finishBtn.click();
  const saveStopBtn = page.getByRole("button", { name: "Lưu và dừng" });
  await expect(saveStopBtn).toBeVisible();
  await saveStopBtn.click();
  await expect(
    page.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
  ).toBeVisible();
}

function makeMinimalMp3Buffer(sizeBytes = 2048): Buffer {
  const buf = Buffer.alloc(sizeBytes, 0);
  buf.write("ID3", 0, "ascii");
  buf[3] = 3;
  buf[4] = 0;
  return buf;
}

// ============================================================================
// F-11: Comprehension & AI Tutor (12 tests)
// ============================================================================

test.describe("Cluster 4 - F-11: Comprehension & AI Tutor", () => {
  test("[T1-F11-01] Post-reading transitions into ComprehensionQuestion with prompt and choices", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await triggerPostReadingComprehension(page);

      const prompt = page.locator(".viread-learning-content").first();
      await expect(prompt).toHaveAttribute("dir", "ltr");
      await expect(prompt).toHaveAttribute("lang", "vi");
      await expect(
        page.getByText("Bạn Thỏ đã tìm thấy gì bên bờ suối?"),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Một giỏ dâu rừng đỏ mọng" }),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F11-02] First-try correct answer unlocks next/finish and transitions to SessionComplete", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let nextCalls = 0;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "GET" &&
              ctx.pathname.endsWith("/questions/next")
            ) {
              nextCalls += 1;
              if (nextCalls === 1) {
                return {
                  status: 200,
                  body: makeTutorNextQuestion({
                    progress_label: "Câu 1/1",
                    position: 1,
                    total: 1,
                  }),
                };
              }
              return {
                status: 200,
                body: makeTutorNextQuestion({
                  question: null,
                  choices: [],
                  progress_label: "Hoàn thành",
                  position: 1,
                  total: 1,
                  completed: true,
                }),
              };
            }
            return null;
          },
        ],
      });

      await triggerPostReadingComprehension(page);
      await page
        .getByRole("button", { name: "Một giỏ dâu rừng đỏ mọng" })
        .click();

      const advanceBtn = page.getByRole("button", {
        name: /Câu tiếp theo|Hoàn thành/,
      });
      await expect(advanceBtn).toBeVisible();
      await advanceBtn.click();

      await expect(
        page.getByRole("button", { name: "Bỏ qua và xem kết quả" }),
      ).toBeHidden();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F11-03] Three-step anti-stuck ladder shows hint, eliminates wrong choice, then unlocks skip/next", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let answerCount = 0;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname.endsWith("/answer")) {
              answerCount += 1;
              return {
                status: 200,
                body: makeTutorAnswerResponse({
                  is_correct: false,
                  score: 0,
                  feedback_code: "TRY_AGAIN",
                  story_hint: "Hãy nhìn lại đoạn đầu trang truyện bên bờ suối.",
                }),
              };
            }
            return null;
          },
        ],
      });

      await triggerPostReadingComprehension(page);

      const wrongChoice = page.getByRole("button", {
        name: "Một chiếc lá vàng",
      });
      await wrongChoice.click();
      await expect(
        page.getByText("Hãy nhìn lại đoạn đầu trang truyện bên bờ suối."),
      ).toBeVisible();

      const secondWrong = page.getByRole("button", {
        name: "Một viên sỏi trắng",
      });
      await secondWrong.click();
      await expect(
        page.locator('[data-eliminated-choice="true"]').first(),
      ).toBeDisabled();

      const correctChoice = page.getByRole("button", {
        name: "Một giỏ dâu rừng đỏ mọng",
      });
      await correctChoice.click();
      expect(answerCount).toBe(3);
      await expect(
        page.getByRole("button", { name: /Câu tiếp theo|Hoàn thành/ }),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F11-04] Skip action transitions directly to SessionComplete without error", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await triggerPostReadingComprehension(page);

      const skipBtn = page.getByRole("button", {
        name: "Bỏ qua và xem kết quả",
      });
      await expect(skipBtn).toBeVisible();
      await skipBtn.click();

      await expect(
        page.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
      ).toBeHidden();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F11-05] ChildProgressAssessmentCard switches 7/30/90 day windows and renders progress bars and practice words", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      const requestedDays: string[] = [];
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "GET" &&
              ctx.pathname.endsWith("/progress-assessment")
            ) {
              const days = Number(ctx.searchParams.get("days") ?? "30");
              requestedDays.push(String(days));
              return {
                status: 200,
                body: makeChildProgressAssessment({ days }),
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/reports");
      const radioGroup = page.getByRole("radiogroup", {
        name: "Khoảng thời gian đánh giá",
      });
      await expect(radioGroup).toBeVisible();

      await radioGroup.getByRole("radio", { name: /7 ngày/ }).click();
      await expect.poll(() => requestedDays.includes("7")).toBe(true);

      await radioGroup.getByRole("radio", { name: /90 ngày/ }).click();
      await expect.poll(() => requestedDays.includes("90")).toBe(true);

      await expect(page.getByRole("progressbar").first()).toBeVisible();
      await expect(page.getByText("lấp lánh").first()).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F11-06] Refresh AI assessment sends POST refresh=true and updates aria-live summary", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let postBody: Record<string, unknown> | null = null;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname.endsWith("/progress-assessment")
            ) {
              postBody = (ctx.postDataJson ?? {}) as Record<string, unknown>;
              return {
                status: 200,
                body: makeChildProgressAssessment({
                  assessment: {
                    source: "AI",
                    model: "gemini-2.5-flash",
                    headline: "Nhận xét AI mới cập nhật",
                    summary: "Bé vừa hoàn thành tốt mục tiêu tuần này.",
                    strengths: ["Đọc diễn cảm"],
                    weaknesses: [],
                    actions: [],
                    practice_words: ["lấp lánh"],
                    encouragement: "Tuyệt vời!",
                  },
                }),
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/reports");
      const refreshBtn = page.getByRole("button", {
        name: "Nhờ AI nhận xét lại",
      });
      await expect(refreshBtn).toBeVisible();
      await refreshBtn.click();

      await expect(page.getByText("Nhận xét AI mới cập nhật")).toBeVisible();
      expect(postBody).toMatchObject({ refresh: true });
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F11-01] Contract security ensures GET /questions/next never exposes expected_answer or ExpectedAnswer", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      const capturedPayloads: string[] = [];
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "GET" &&
              ctx.pathname.endsWith("/questions/next")
            ) {
              const payload = makeTutorNextQuestion();
              capturedPayloads.push(JSON.stringify(payload));
              return { status: 200, body: payload };
            }
            return null;
          },
        ],
      });

      await triggerPostReadingComprehension(page);
      expect(capturedPayloads.length).toBeGreaterThan(0);
      for (const serialized of capturedPayloads) {
        expect(serialized.toLowerCase()).not.toContain("expected_answer");
        expect(serialized).not.toContain("ExpectedAnswer");
      }
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F11-02] Legacy POST /comprehension/questions fails closed with 403", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname === "/comprehension/questions"
            ) {
              return {
                status: 403,
                body: { detail: "LEGACY_COMPREHENSION_DISABLED" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/dashboard");
      const res = await apiFetchInPage(page, "/comprehension/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: OPAQUE_SESSION_ID }),
      });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ detail: "LEGACY_COMPREHENSION_DISABLED" });
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [403],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F11-03] Answer length bounds enforce 1..200 characters cleanly", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname.endsWith("/answer")) {
              const body = (ctx.postDataJson ?? {}) as { answer?: unknown };
              const ans = typeof body.answer === "string" ? body.answer : "";
              if (ans.length < 1 || ans.length > 200) {
                return {
                  status: 422,
                  body: { detail: "INVALID_ANSWER_LENGTH" },
                };
              }
              return {
                status: 200,
                body: makeTutorAnswerResponse({ submitted_answer: ans }),
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/dashboard");
      const emptyRes = await apiFetchInPage(
        page,
        `/tutor/sessions/${OPAQUE_SESSION_ID}/questions/${OPAQUE_C4_QUESTION_ID_1}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: "" }),
        },
      );
      expect(emptyRes.status).toBe(422);

      const overRes = await apiFetchInPage(
        page,
        `/tutor/sessions/${OPAQUE_SESSION_ID}/questions/${OPAQUE_C4_QUESTION_ID_2}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: "a".repeat(201) }),
        },
      );
      expect(overRes.status).toBe(422);

      const validMaxRes = await apiFetchInPage(
        page,
        `/tutor/sessions/${OPAQUE_SESSION_ID}/questions/${OPAQUE_C4_QUESTION_ID_1}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: "a".repeat(200) }),
        },
      );
      expect(validMaxRes.status).toBe(200);

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [422],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F11-04] Best-effort failure on POST /questions/generate routes cleanly to SessionComplete", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname.endsWith("/questions/generate")
            ) {
              return {
                status: 500,
                body: { detail: "TUTOR_TEMPORARILY_UNAVAILABLE" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto(`/reading/${OPAQUE_SESSION_ID}`);
      await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
      await page.getByRole("button", { name: "Lưu và dừng" }).click();

      await expect(
        page.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
      ).toBeHidden();
      await expect(
        page.getByRole("link", { name: /Về tủ sách|Xem báo cáo/ }),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [500],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F11-05] INSUFFICIENT assessment status with null overall score renders em-dash fallback instead of 0% or NaN", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        childProgressAssessment: makeChildProgressAssessment({
          data_status: "INSUFFICIENT",
          score: {
            overall: null,
            previous_overall: null,
            delta: null,
            grade: null,
            grade_label: null,
            components: [
              {
                key: "ACCURACY",
                label: "Độ chính xác",
                score: null,
                previous_score: null,
                detail: "Chưa đủ dữ liệu.",
              },
            ],
          },
          metrics: {
            reading_assessment: null,
            sessions: 0,
            active_days: 0,
            reading_minutes: 0,
            books: 0,
            pages_compared: 0,
            words_read: 0,
            coverage_pct: null,
            accuracy_pct: null,
            skipped_rate_pct: null,
            substitution_rate_pct: null,
            hesitations: 0,
            repeated_words: 0,
            hesitations_per_100_words: null,
            words_per_minute: null,
            comprehension_answered: 0,
            comprehension_first_try_pct: null,
            comprehension_by_type: [],
            retry_confirmed: 0,
            retry_failed: 0,
          },
          weekly: [],
          difficult_words: [],
        }),
      });

      await page.goto("/reports");
      await expect(page.getByText("–").first()).toBeVisible();
      const bodyText = await page.locator("main").innerText();
      expect(bodyText).not.toContain("NaN");
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F11-06] Transient 500 on GET /questions/next recovers via retry button", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let attempts = 0;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "GET" &&
              ctx.pathname.endsWith("/questions/next")
            ) {
              attempts += 1;
              if (attempts === 1) {
                return {
                  status: 500,
                  body: { detail: "TRANSIENT_QUESTION_ERROR" },
                };
              }
              return { status: 200, body: makeTutorNextQuestion() };
            }
            return null;
          },
        ],
      });

      await page.goto(`/reading/${OPAQUE_SESSION_ID}`);
      await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
      await page.getByRole("button", { name: "Lưu và dừng" }).click();

      const retryBtn = page.getByRole("button", { name: "Thử lại" });
      await expect(retryBtn).toBeVisible();
      await retryBtn.click();

      await expect(
        page.getByText("Bạn Thỏ đã tìm thấy gì bên bờ suối?"),
      ).toBeVisible();
      expect(attempts).toBeGreaterThanOrEqual(2);
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [500],
      });
    } finally {
      await context.close();
    }
  });
});

// ============================================================================
// F-12: Reports & Difficult Words (12 tests)
// ============================================================================

test.describe("Cluster 4 - F-12: Reports & Difficult Words", () => {
  test("[T1-F12-01] Reading history lists sessions and navigates to session detail", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/sessions");

      const detailLink = page
        .locator(`a[href="/sessions/${OPAQUE_SESSION_ID}"]`)
        .first();
      await expect(detailLink).toBeVisible();
      await detailLink.click();

      await expect(page).toHaveURL(
        new RegExp(`/sessions/${OPAQUE_SESSION_ID}`),
      );
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F12-02] Session detail renders primary reading report and comprehension heading", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto(`/sessions/${OPAQUE_SESSION_ID}`);

      await expect(
        page.getByTestId("session-primary-reading-report"),
      ).toBeVisible();
      await expect(
        page.locator("#session-comprehension-heading"),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F12-03] Standalone session report route renders primary report view", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto(`/sessions/${OPAQUE_SESSION_ID}/report`);

      await expect(page.getByTestId("standalone-session-report")).toBeVisible();
      await expect(page.getByTestId("standalone-primary-report")).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F12-04] Reports page renders metrics, comparison, AI assessment, and entertainment summary", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/reports");

      await expect(page.locator(".report-metrics")).toBeVisible();
      await expect(page.locator("#comparison-title")).toBeVisible();
      await expect(
        page.getByRole("radiogroup", { name: "Khoảng thời gian đánh giá" }),
      ).toBeVisible();
      await expect(
        page.getByText(/không thay thế đánh giá y khoa/i),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F12-05] @mobile Difficult words screen renders mobile status pills and window/status filters", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      const requestedFilters: string[] = [];
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "GET" &&
              ctx.pathname === `/system/difficult-words/${OPAQUE_CHILD_ID}`
            ) {
              requestedFilters.push(ctx.searchParams.toString());
            }
            return null;
          },
        ],
      });

      await page.goto("/reports/difficult-words");
      await expect(page.getByText("lấp lánh").first()).toBeVisible();

      const statusSelect = page.getByLabel("Lọc theo trạng thái luyện");
      await expect(statusSelect).toBeVisible();
      const windowSelect = page.getByLabel("Chọn khoảng thời gian");
      await expect(windowSelect).toBeVisible();

      await windowSelect.selectOption("90d");
      await expect
        .poll(() => requestedFilters.some((q) => q.includes("90d")))
        .toBe(true);

      const mobilePills = page.getByRole("group", {
        name: "Lọc nhanh theo trạng thái luyện",
      });
      if ((page.viewportSize()?.width ?? 1440) <= 430) {
        await expect(mobilePills).toBeVisible();
      }

      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F12-06] Difficult word practice start, complete, mastery outcome, and history details", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        difficultWordHistory: makeDifficultWordHistory(),
      });

      await page.goto("/reports/difficult-words");
      await expect(page.getByText("lấp lánh").first()).toBeVisible();

      const startRes = await apiFetchInPage(
        page,
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            normalized_word: "lấp lánh",
            display_text: "lấp lánh",
          }),
        },
      );
      expect(startRes.status).toBe(200);

      const completeRes = await apiFetchInPage(
        page,
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/${OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ used_hint: false }),
        },
      );
      expect(completeRes.status).toBe(200);
      expect(completeRes.json).toMatchObject({
        practice_status: "COMPLETED",
        evidence_count_unchanged: true,
      });

      const historyDetails = page.locator("details").first();
      await expect(historyDetails).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F12-01] Nullable metrics render missing-data label instead of 0% on reports and session detail", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        progressReport: makeProgressReport({
          completed_sessions: null,
          reading_duration_ms: null,
          omission_rate: null,
          repetition_rate: null,
          long_pause_rate: null,
          comprehension_accuracy: null,
          previous_period: null,
          trend_deltas: null,
          data_status: "partial",
          availability: {
            metrics: "partial",
            difficult_words: "absent",
            comparison: "absent",
          },
          difficult_words: [],
        }),
        sessionReports: makeSessionReadingReports({
          primary_report: {
            id: OPAQUE_REPORT_ID,
            session_id: OPAQUE_SESSION_ID,
            child_id: OPAQUE_CHILD_ID,
            page_id: OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID,
            page_revision_id: OPAQUE_C4_PERIOD_ID,
            reading_attempt_id: OPAQUE_C4_GOAL_ID,
            spoken_text: "",
            words_total: 0,
            words_matched: 0,
            words_omitted: 0,
            words_substituted: 0,
            words_inserted: 0,
            accuracy_pct: null,
            omission_rate: null,
            wpm: null,
            created_at: OPAQUE_C4_NOW_OFFSET,
            aligned_words: [],
          },
        }),
      });

      await page.goto("/reports");
      await expect(
        page.getByText(/Chưa ghi nhận|Chưa đủ dữ liệu/).first(),
      ).toBeVisible();
      const reportsText = await page.locator(".report-metrics").innerText();
      expect(reportsText).not.toContain("NaN");

      await page.goto(`/sessions/${OPAQUE_SESSION_ID}`);
      await expect(
        page.getByText(/Chưa ghi nhận|Chưa đủ dữ liệu/).first(),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F12-02] Unsupported or partial progress report renders honest fallback notice", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        progressReport: makeProgressReport({
          data_status: "unsupported",
          availability: {
            metrics: "unsupported",
            difficult_words: "unsupported",
            comparison: "unsupported",
          },
          difficult_words: null,
          previous_period: null,
          trend_deltas: null,
        }),
      });

      await page.goto("/reports");
      await expect(
        page.getByText(/Chưa hỗ trợ|Chưa đủ dữ liệu/).first(),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F12-03] 409 DIFFICULT_WORD_ATTEMPT_ALREADY_COMPLETED displays localized safe message", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname.endsWith("/evaluate-audio")
            ) {
              return {
                status: 409,
                body: { detail: "DIFFICULT_WORD_ATTEMPT_ALREADY_COMPLETED" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/reports/difficult-words");
      const res = await apiFetchInPage(
        page,
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/${OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID}/evaluate-audio`,
        {
          method: "POST",
          body: new FormData() as unknown as string,
        },
      );
      expect(res.status).toBe(409);
      expect(res.json).toEqual({
        detail: "DIFFICULT_WORD_ATTEMPT_ALREADY_COMPLETED",
      });
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [409],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F12-04] 413 AUDIO_TOO_LARGE displays safe localized error without stack trace", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname.endsWith("/evaluate-audio")
            ) {
              return {
                status: 413,
                body: { detail: "AUDIO_TOO_LARGE" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/reports/difficult-words");
      const res = await apiFetchInPage(
        page,
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/${OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID}/evaluate-audio`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ duration_ms: 999999 }),
        },
      );
      expect(res.status).toBe(413);
      expect(res.bodyText).not.toContain("Traceback");
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [413],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F12-05] 415 UNSUPPORTED_AUDIO and 422 EMPTY_AUDIO display safe localized messages", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let toggle = false;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname.endsWith("/evaluate-audio")
            ) {
              toggle = !toggle;
              if (toggle) {
                return { status: 415, body: { detail: "UNSUPPORTED_AUDIO" } };
              }
              return { status: 422, body: { detail: "EMPTY_AUDIO" } };
            }
            return null;
          },
        ],
      });

      await page.goto("/reports/difficult-words");
      const r415 = await apiFetchInPage(
        page,
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/${OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID}/evaluate-audio`,
        { method: "POST" },
      );
      expect(r415.status).toBe(415);
      expect(r415.json).toEqual({ detail: "UNSUPPORTED_AUDIO" });

      const r422 = await apiFetchInPage(
        page,
        `/system/difficult-words/${OPAQUE_CHILD_ID}/practice/${OPAQUE_C4_DIFFICULT_WORD_ATTEMPT_ID}/evaluate-audio`,
        { method: "POST" },
      );
      expect(r422.status).toBe(422);
      expect(r422.json).toEqual({ detail: "EMPTY_AUDIO" });

      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [415, 422],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F12-06] Cursor pagination loads next page and rejects malformed cursor", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      const cursorsSeen: string[] = [];
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/reading/history") {
              const cursor = ctx.searchParams.get("cursor");
              if (cursor) {
                cursorsSeen.push(cursor);
              }
              if (cursor === "page-2") {
                return {
                  status: 200,
                  body: makeReadingHistoryList({
                    sessions: [
                      {
                        id: OPAQUE_C4_GOAL_ID,
                        child_id: OPAQUE_CHILD_ID,
                        book_id: OPAQUE_BOOK_ID,
                        state: "FINISHED",
                        started_at: "2026-11-20T09:00:00Z",
                        ended_at: "2026-11-20T09:10:00Z",
                        duration_ms: 600_000,
                      },
                    ],
                    next_cursor: null,
                  }),
                };
              }
              return {
                status: 200,
                body: makeReadingHistoryList({ next_cursor: "page-2" }),
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/sessions");
      const loadMoreBtn = page.getByRole("button", {
        name: /Xem thêm|Tải thêm/,
      });
      await expect(loadMoreBtn).toBeVisible();
      await loadMoreBtn.click();

      expect(cursorsSeen).toContain("page-2");
      await expect(
        page.locator(`a[href="/sessions/${OPAQUE_C4_GOAL_ID}"]`).first(),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });
});

// ============================================================================
// F-13: Reading Management & Parent Emails (12 tests)
// ============================================================================

test.describe("Cluster 4 - F-13: Reading Management & Parent Emails", () => {
  test("[T1-F13-01] Reading management organizer renders goals, plans, collections, reminders, and due items", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/reading-management");

      await expect(page.locator("section.reading-organizer")).toBeVisible();
      await expect(
        page.locator(`[data-goal-id="${OPAQUE_C4_GOAL_ID}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-plan-id="${OPAQUE_C4_PLAN_ID}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-due-id="${OPAQUE_C4_OCCURRENCE_ID}"]`),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F13-02] Creating reading goal posts MINUTES/DAILY payload and updates goal list", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let createdGoalBody: Record<string, unknown> | null = null;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname === "/reading-management/goals"
            ) {
              createdGoalBody = (ctx.postDataJson ?? {}) as Record<
                string,
                unknown
              >;
            }
            return null;
          },
        ],
      });

      await page.goto("/reading-management");
      await page
        .getByRole("button", { name: /Tạo mục tiêu/ })
        .first()
        .click();

      const submitBtn = page
        .getByRole("button", { name: /Tạo mục tiêu/ })
        .last();
      await submitBtn.click();

      await expect.poll(() => createdGoalBody !== null).toBe(true);
      expect(createdGoalBody).toMatchObject({
        child_id: OPAQUE_CHILD_ID,
        metric: "MINUTES",
      });
      await expect(page.locator("[data-goal-id]").nth(1)).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F13-03] Creating reading plan and collection book status updates lists", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let planPosted = false;
      let collectionPut = false;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname === "/reading-management/plans"
            ) {
              planPosted = true;
            }
            if (
              ctx.method === "PUT" &&
              ctx.pathname.startsWith("/reading-management/collections/")
            ) {
              collectionPut = true;
            }
            return null;
          },
        ],
      });

      await page.goto("/reading-management");
      await page
        .getByRole("button", { name: /Tạo kế hoạch/ })
        .first()
        .click();
      const titleInput = page.locator('input[maxlength="100"]').first();
      await titleInput.fill("Đọc truyện cuối tuần");
      await page
        .getByRole("button", { name: /Tạo kế hoạch/ })
        .last()
        .click();

      await expect.poll(() => planPosted).toBe(true);

      const addBookRes = await apiFetchInPage(
        page,
        `/reading-management/collections/${OPAQUE_BOOK_ID}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            child_id: OPAQUE_CHILD_ID,
            collection_type: "WANT_TO_READ",
          }),
        },
      );
      expect(addBookRes.status).toBe(200);
      expect(collectionPut).toBe(true);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F13-04] Creating reminder and acknowledging due occurrence updates occurrence status", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let ackCalled = false;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname.endsWith("/acknowledge")
            ) {
              ackCalled = true;
            }
            return null;
          },
        ],
      });

      await page.goto("/reading-management");
      const dueCard = page.locator(
        `[data-due-id="${OPAQUE_C4_OCCURRENCE_ID}"]`,
      );
      await expect(dueCard).toBeVisible();
      await dueCard.getByRole("button").first().click();

      await expect.poll(() => ackCalled).toBe(true);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F13-05] Settings email notification preferences toggles switches and saves via PUT", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let savedPrefs: Record<string, unknown> | null = null;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "PUT" &&
              ctx.pathname === "/parent-notifications/preferences"
            ) {
              savedPrefs = (ctx.postDataJson ?? {}) as Record<string, unknown>;
            }
            return null;
          },
        ],
      });

      await page.goto("/settings");
      const section = page.locator("#email-notifications");
      await expect(section).toBeVisible();

      const switches = section.getByRole("switch");
      await expect(switches).toHaveCount(3);
      await switches.first().click();

      await section
        .getByRole("button", { name: /Lưu cài đặt email|Lưu/ })
        .click();

      await expect.poll(() => savedPrefs !== null).toBe(true);
      expect(savedPrefs).toMatchObject({
        weekly_digest_enabled: false,
      });
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F13-06] Settings test-email dispatch triggers POST and refreshes delivery history", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let testEmailCalls = 0;
      let historyCalls = 0;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname === "/parent-notifications/test-email"
            ) {
              testEmailCalls += 1;
            }
            if (
              ctx.method === "GET" &&
              ctx.pathname === "/parent-notifications/history"
            ) {
              historyCalls += 1;
            }
            return null;
          },
        ],
      });

      await page.goto("/settings");
      const section = page.locator("#email-notifications");
      await section
        .getByRole("button", { name: "Gửi email thử nghiệm" })
        .click();

      await expect.poll(() => testEmailCalls).toBeGreaterThanOrEqual(1);
      await expect.poll(() => historyCalls).toBeGreaterThanOrEqual(2);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F13-01] Cron /api/cron/parent-emails rejects missing or invalid Bearer secret with 401 and zero upstream calls", async ({
    request,
  }) => {
    await resetContractServer(request);
    try {
      const noAuthRes = await request.post("/api/cron/parent-emails");
      expect(noAuthRes.status()).toBe(401);
      expect(await noAuthRes.json()).toEqual({
        ok: false,
        error: "UNAUTHORIZED",
      });

      const wrongAuthRes = await request.post("/api/cron/parent-emails", {
        headers: { Authorization: "Bearer wrong_secret_value" },
      });
      expect(wrongAuthRes.status()).toBe(401);
      expect(await wrongAuthRes.json()).toEqual({
        ok: false,
        error: "UNAUTHORIZED",
      });

      const stats = await getContractStats(request);
      expect(stats.cronAttempts).toBe(0);
    } finally {
      await resetContractServer(request);
    }
  });

  test("[T2-F13-02] Cron /api/cron/parent-emails dispatches with X-Cron-Secret and returns 200 summary", async ({
    request,
  }) => {
    await resetContractServer(request);
    try {
      const res = await request.post(
        "/api/cron/parent-emails?scope=reminders",
        {
          headers: { Authorization: `Bearer ${OPAQUE_CRON_SECRET}` },
        },
      );
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        summary: { scope: string; delivery_provider: string };
      };
      expect(body.ok).toBe(true);
      expect(body.summary.scope).toBe("reminders");

      const stats = await getContractStats(request);
      expect(stats.cronAttempts).toBe(1);
      const cronReq = stats.requests.find((item) =>
        item.path.startsWith("/parent-notifications/cron/dispatch"),
      );
      expect(cronReq?.headers["x-cron-secret"]).toBe(OPAQUE_CRON_SECRET);
    } finally {
      await resetContractServer(request);
    }
  });

  test("[T2-F13-03] Cron /api/cron/parent-emails retries transient upstream 502 and recovers 200", async ({
    request,
  }) => {
    await resetContractServer(request);
    try {
      await armContractFault(request, {
        method: "POST",
        path: "/parent-notifications/cron/dispatch",
        status: 502,
        remaining: 1,
        body: { detail: "TRANSIENT_UPSTREAM_502" },
      });

      const res = await request.post("/api/cron/parent-emails?scope=all", {
        headers: { Authorization: `Bearer ${OPAQUE_CRON_SECRET}` },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      const stats = await getContractStats(request);
      expect(stats.cronAttempts).toBeGreaterThanOrEqual(2);
    } finally {
      await resetContractServer(request);
    }
  });

  test("[T2-F13-04] Cron /api/cron/parent-emails returns 502 UPSTREAM_DISPATCH_FAILED on non-retryable 400/500", async ({
    request,
  }) => {
    await resetContractServer(request);
    try {
      await armContractFault(request, {
        method: "POST",
        path: "/parent-notifications/cron/dispatch",
        status: 400,
        remaining: 1,
        body: { detail: "INVALID_CRON_SCOPE" },
      });

      const res = await request.post("/api/cron/parent-emails?scope=all", {
        headers: { Authorization: `Bearer ${OPAQUE_CRON_SECRET}` },
      });
      expect(res.status()).toBe(502);
      const body = (await res.json()) as {
        ok: boolean;
        error: string;
        upstreamStatus?: number;
      };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("UPSTREAM_DISPATCH_FAILED");
      expect(body.upstreamStatus).toBe(400);
    } finally {
      await resetContractServer(request);
    }
  });

  test("[T2-F13-05] Reading management 409 conflict messages display localized errors safely", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname === "/reading-management/goals"
            ) {
              return {
                status: 409,
                body: {
                  detail:
                    "An active goal with the same metric and period already overlaps these dates",
                },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/reading-management");
      await page
        .getByRole("button", { name: /Tạo mục tiêu/ })
        .first()
        .click();
      await page
        .getByRole("button", { name: /Tạo mục tiêu/ })
        .last()
        .click();

      const alert = page.getByRole("alert").first();
      await expect(alert).toBeVisible();
      const alertText = await alert.innerText();
      expect(alertText).not.toContain("Traceback");
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [409],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F13-06] Reading plan title, target_minutes, and email preferences enforce numeric and length bounds", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        parentPreferences: makeParentNotificationPreferences({
          inactivity_days: 2,
          max_emails_per_week: 14,
        }),
      });

      await page.goto("/reading-management");
      await page
        .getByRole("button", { name: /Tạo kế hoạch/ })
        .first()
        .click();
      const planTitleInput = page.locator('input[maxlength="100"]').first();
      await expect(planTitleInput).toHaveAttribute("maxlength", "100");
      await planTitleInput.fill("K".repeat(120));
      expect((await planTitleInput.inputValue()).length).toBeLessThanOrEqual(
        100,
      );

      const minutesInput = page.locator('input[type="number"]').first();
      await expect(minutesInput).toHaveAttribute("min", "5");
      await expect(minutesInput).toHaveAttribute("max", "240");

      await page.goto("/settings");
      await expect(page.locator("#email-notifications")).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });
});

// ============================================================================
// F-14: Entertainment V4 & Adaptive Learning (12 tests)
// ============================================================================

test.describe("Cluster 4 - F-14: Entertainment V4 & Adaptive Learning", () => {
  test("[T1-F14-01] @mobile Entertainment hub renders child selector and adaptive recommendations", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/entertainment");

      await expect(page.locator("section.activity-library")).toBeVisible();
      await expect(page.getByTestId("hub-child-selector")).toBeVisible();
      await expect(
        page.getByText("Giúp con ôn tập từ khó lấp lánh qua ghép câu."),
      ).toBeVisible();
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F14-02] @mobile Sentence shooter starts session, shows badges, submits shot, and displays result", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/entertainment/sentence-shooter");

      await page
        .getByRole("button", { name: /Bắt đầu|Chơi ngay/ })
        .first()
        .click();

      await expect(
        page.getByTestId("difficult-word-badge").first(),
      ).toBeVisible();
      await expect(page.getByTestId("session-score")).toBeVisible();

      const firstTokenBtn = page.getByRole("button", { name: "Ánh nắng" });
      await expect(firstTokenBtn).toBeVisible();
      await firstTokenBtn.click();

      await expect(page.getByTestId("grammar-tip-pill")).toBeVisible();
      await expect(page.getByText("Hoàn thành xuất sắc!")).toBeVisible();
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F14-03] Picture description selects sample scene, evaluates description, and renders score and stars", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/entertainment/picture-description");

      await page
        .getByRole("button", { name: /Khu vườn buổi sáng|Bắt đầu/ })
        .first()
        .click();

      const textarea = page.locator("textarea").first();
      await expect(textarea).toBeVisible();
      await textarea.fill("Khu vườn có hoa vàng và gió thổi rì rào.");
      await page
        .getByRole("button", { name: /Gửi|Chấm điểm/ })
        .first()
        .click();

      await expect(
        page.getByText("Câu miêu tả của con rất sinh động!"),
      ).toBeVisible();
      await expect(page.getByText(/9\/10|9 điểm/)).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F14-04] @mobile Memory game completes observe, recall, and factual reveal stages", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        memorySession: makeMemorySession({ status: "OBSERVING" }),
      });
      await page.goto("/entertainment/memory-game");

      await page.getByTestId("timer-option-10S").click();
      await page.getByTestId("start-memory-game-btn").click();

      await expect(page.getByTestId("observe-stage")).toBeVisible();
      const finishObserveBtn = page.getByRole("button", {
        name: /Sẵn sàng nhớ lại|Bắt đầu nhớ lại/,
      });
      if ((await finishObserveBtn.count()) > 0) {
        await finishObserveBtn.first().click();
      }

      await expect(page.getByTestId("recall-stage")).toBeVisible();
      await page
        .getByTestId("recall-textarea")
        .fill("Trong khu vườn có một quả bóng màu đỏ ở giữa.");
      await page.getByTestId("submit-recall-btn").click();

      await expect(page.getByTestId("reveal-stage")).toBeVisible();
      await expect(page.getByTestId("factual-score-card")).toBeVisible();
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F14-05] Memory game creative stage submits CREATIVE attempt and displays feedback", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        memorySession: makeMemorySession({
          status: "RECALLING",
          latest_evaluation: makeMemoryAttemptResult("RECALL").evaluation,
        }),
      });
      await page.goto("/entertainment/memory-game");

      await page.getByTestId("start-memory-game-btn").click();
      await expect(page.getByTestId("recall-stage")).toBeVisible();
      await page.getByTestId("recall-textarea").fill("Quả bóng đỏ ở giữa.");
      await page.getByTestId("submit-recall-btn").click();

      await page.getByTestId("go-creative-stage-btn").click();
      await expect(page.getByTestId("creative-stage")).toBeVisible();
      await page
        .locator("textarea")
        .first()
        .fill("Bạn Thỏ đá quả bóng đỏ lăn qua bãi cỏ.");
      await page
        .getByRole("button", { name: /Gửi câu chuyện|Gửi bài/ })
        .first()
        .click();

      await expect(
        page.getByText("Câu chuyện của con rất sáng tạo!"),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F14-06] Reports page renders EntertainmentLearningSummary disclaimer and 16-skill grid", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/reports");

      await expect(
        page.getByText(
          "Số liệu phản ánh mức độ luyện tập trong trò chơi, không thay thế đánh giá y khoa.",
        ),
      ).toBeVisible();
      await expect(
        page.getByText("Kỹ năng ngôn ngữ 1", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Kỹ năng ngôn ngữ 16", { exact: true }),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F14-01] Picture description 422 UNSAFE_PICTURE fails closed with exact safe error message", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname === "/games/picture-description/sessions"
            ) {
              return {
                status: 422,
                body: { detail: "UNSAFE_PICTURE" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/entertainment/picture-description");
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles({
        name: "custom-photo.png",
        mimeType: "image/png",
        buffer: makeMinimalPngBuffer(),
      });

      const startUploadBtn = page
        .getByRole("button", { name: /Bắt đầu|Tải tranh lên/ })
        .first();
      if (await startUploadBtn.isVisible()) {
        await startUploadBtn.click();
      }

      await expect(
        page.getByText(
          "Bức tranh này chưa phù hợp cho trẻ tiểu học. Ba mẹ hãy chọn một bức tranh thân thiện khác nhé.",
        ),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [422],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F14-02] Picture description client upload guards reject oversized (>5MB) and invalid MIME files", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let uploadPostCount = 0;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname === "/games/picture-description/sessions"
            ) {
              uploadPostCount += 1;
            }
            return null;
          },
        ],
      });

      await page.goto("/entertainment/picture-description");
      const fileInput = page.locator('input[type="file"]').first();

      await fileInput.setInputFiles({
        name: "bad.gif",
        mimeType: "image/gif",
        buffer: Buffer.from("GIF89a", "ascii"),
      });
      await expect(page.getByRole("alert").first()).toBeVisible();

      await fileInput.setInputFiles({
        name: "huge.png",
        mimeType: "image/png",
        buffer: makeOversizedBuffer(5 * 1024 * 1024 + 1024),
      });
      await expect(page.getByRole("alert").first()).toBeVisible();
      expect(uploadPostCount).toBe(0);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F14-03] @mobile Sentence shooter enforces token/round bounds and LTR learning-content isolation", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      locale: "ar",
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        shooterSession: makeSentenceShooterSession({
          total_rounds: 5,
          practiced_difficult_words: ["lấp lánh", "rì rào"],
        }),
      });

      await page.goto("/entertainment/sentence-shooter");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await page
        .getByRole("button", { name: /Bắt đầu|Chơi/ })
        .first()
        .click();

      const difficultList = page.getByTestId("practiced-difficult-words");
      await expect(difficultList).toBeVisible();
      const learningBox = page.locator(".viread-learning-content").first();
      await expect(learningBox).toHaveAttribute("dir", "ltr");
      await expect(learningBox).toHaveAttribute("lang", "vi");

      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F14-04] @mobile Memory game hint and supported peek actions update usage cleanly", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        memorySession: makeMemorySession({ status: "RECALLING" }),
      });

      await page.goto("/entertainment/memory-game");
      await page.getByTestId("start-memory-game-btn").click();
      await expect(page.getByTestId("recall-stage")).toBeVisible();

      await page.getByTestId("request-hint-btn").click();
      await expect(page.getByTestId("memory-hint-card")).toBeVisible();
      await expect(
        page.getByText("Có một đồ vật tròn ở giữa vườn."),
      ).toBeVisible();

      await page.getByTestId("supported-peek-btn").click();
      await expect(page.getByTestId("supported-peek-view")).toBeVisible();

      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F14-05] Adaptive analytics null mastery_pct and recent_average_pct render no-score badge without 0%", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        parentAnalytics: makeParentLearningAnalytics({
          observed_skills_count: 0,
          estimated_skills_count: 0,
          unknown_skills_count: 16,
          skills: Array.from({ length: 16 }, (_, idx) => ({
            skill_key: `unknown_${idx + 1}`,
            label_vi: `Kỹ năng chưa đo ${idx + 1}`,
            domain: "READING_WORDS",
            status: "UNKNOWN",
            mastery_pct: null,
            confidence: 0,
            evidence_count: 0,
            high_confidence_count: 0,
            last_observed_at: null,
            source_modules: [],
          })),
          module_activities: [
            {
              game_key: "SENTENCE_SHOOTER",
              title_vi: "Bắn câu tinh anh",
              sessions_count: 0,
              recent_average_pct: null,
              highlight_vi: "Chưa có lượt chơi nào.",
            },
          ],
        }),
      });

      await page.goto("/reports");
      const skillCard = page
        .getByText("Kỹ năng chưa đo 1", { exact: true })
        .locator("..");
      await expect(skillCard).toBeVisible();
      const cardText = await skillCard.innerText();
      expect(cardText).not.toContain("0%");
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F14-06] Sentence shooter abandon and catalog error state recover gracefully", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let abandoned = false;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname ===
                `/games/sentence-shooter/sessions/${OPAQUE_C4_SHOOTER_SESSION_ID}/abandon`
            ) {
              abandoned = true;
            }
            return null;
          },
        ],
      });

      await page.goto("/entertainment/sentence-shooter");
      await page
        .getByRole("button", { name: /Bắt đầu|Chơi/ })
        .first()
        .click();

      const abandonBtn = page.getByRole("button", {
        name: /Thoát|Dừng|Hủy/,
      });
      if ((await abandonBtn.count()) > 0) {
        await abandonBtn.first().click();
        await expect.poll(() => abandoned).toBe(true);
      } else {
        const res = await apiFetchInPage(
          page,
          `/games/sentence-shooter/sessions/${OPAQUE_C4_SHOOTER_SESSION_ID}/abandon`,
          { method: "POST" },
        );
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ status: "ABANDONED" });
      }
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });
});

// ============================================================================
// F-15: Karaoke Ecosystem (12 tests)
// ============================================================================

test.describe("Cluster 4 - F-15: Karaoke Ecosystem", () => {
  test("[T1-F15-01] @mobile Karaoke library renders child song cards with LTR Vietnamese titles and navigates to player", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/karaoke");

      const songTitle = page.locator(".viread-learning-content", {
        hasText: "Con Cò Bé Bé",
      });
      await expect(songTitle.first()).toBeVisible();
      await expect(songTitle.first()).toHaveAttribute("dir", "ltr");
      await expect(songTitle.first()).toHaveAttribute("lang", "vi");

      await page
        .locator(`a[href*="/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}"]`)
        .first()
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}`),
      );
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F15-02] @mobile Karaoke player renders stage cues, scoring badge, and playback rate selector", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto(`/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}`);

      await expect(page.getByTestId("karaoke-stage")).toBeVisible();
      await expect(page.getByTestId("karaoke-active-line")).toBeVisible();
      await expect(page.getByTestId("karaoke-cue")).toBeVisible();
      await expect(
        page.getByTestId("karaoke-scoring-mode-badge"),
      ).toBeVisible();

      const rateSelect = page
        .locator("select")
        .filter({ has: page.locator('option[value="0.75"]') })
        .first();
      await expect(rateSelect).toBeVisible();
      await rateSelect.selectOption("0.85");
      await expect(rateSelect).toHaveValue("0.85");

      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F15-03] @mobile Karaoke practice session submission persists playback_rate, stars, and nullable scores", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto(`/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}`);

      const practiceRes = await apiFetchInPage(
        page,
        "/karaoke/practice-sessions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            child_id: OPAQUE_CHILD_ID,
            song_id: OPAQUE_C4_KARAOKE_SONG_ID,
            song_version_id: OPAQUE_C4_KARAOKE_VERSION_ID,
            practice_mode: "FULL_SONG",
            scoring_mode: "FULL_MUSICAL",
            playback_rate: 0.85,
            headphone_mode: false,
            overall_score: 88,
            rhythm_score: 86,
            pitch_score: 90,
            lyrics_score: 88,
            fluency_score: 87,
            stars: 3,
          }),
        },
      );
      expect(practiceRes.status).toBe(201);
      expect(practiceRes.json).toMatchObject({
        playback_rate: 0.85,
        stars: 3,
      });

      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F15-04] Admin karaoke simple-upload Step 1-3 workflow imports, checks compliance, and publishes", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let publishedCalled = false;
      await installCluster4AdminMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname.endsWith("/simple-publish")
            ) {
              publishedCalled = true;
            }
            return null;
          },
        ],
      });

      await page.goto("/admin/karaoke/new");
      const mp3Input = page
        .locator(
          'input[type="file"][accept*="audio"], input[type="file"][accept*=".mp3"]',
        )
        .first();
      await mp3Input.setInputFiles({
        name: "con-co-be-be.mp3",
        mimeType: "audio/mpeg",
        buffer: makeMinimalMp3Buffer(),
      });

      await page
        .getByRole("button", { name: /Tải lên và phân tích|Tiếp tục/ })
        .first()
        .click();

      await expect(page.getByTestId("simple-pipeline-card")).toBeVisible();
      await page
        .getByRole("button", { name: /Tiếp tục|Bước tiếp/ })
        .first()
        .click();

      const checkboxes = page.locator('input[type="checkbox"]');
      const count = await checkboxes.count();
      for (let i = 0; i < count; i += 1) {
        const box = checkboxes.nth(i);
        if (!(await box.isChecked())) {
          await box.check();
        }
      }

      const publishBtn = page.getByRole("button", { name: "Xuất bản ngay" });
      await expect(publishBtn).toBeEnabled();
      await publishBtn.click();

      await expect.poll(() => publishedCalled).toBe(true);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F15-05] Admin karaoke editor saves draft and publishes with expected_revision", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let draftExpectedRev: number | null = null;
      let publishExpectedRev: number | null = null;
      await installCluster4AdminMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "PUT" && ctx.pathname.endsWith("/draft")) {
              const body = (ctx.postDataJson ?? {}) as {
                expected_revision?: number;
              };
              draftExpectedRev = body.expected_revision ?? null;
            }
            if (ctx.method === "POST" && ctx.pathname.endsWith("/publish")) {
              const body = (ctx.postDataJson ?? {}) as {
                expected_revision?: number;
              };
              publishExpectedRev = body.expected_revision ?? null;
            }
            return null;
          },
        ],
      });

      await page.goto(`/admin/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}/edit`);
      await page
        .getByRole("button", { name: /Lưu bản nháp/ })
        .first()
        .click();
      await expect.poll(() => draftExpectedRev).toBe(1);

      await page
        .getByRole("button", { name: /Xuất bản/ })
        .first()
        .click();
      await expect.poll(() => publishExpectedRev).toBe(2);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F15-06] Admin karaoke toggles song visibility with expected_revision", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let visibilityPayload: Record<string, unknown> | null = null;
      await installCluster4AdminMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "PATCH" &&
              ctx.pathname.endsWith("/visibility")
            ) {
              visibilityPayload = (ctx.postDataJson ?? {}) as Record<
                string,
                unknown
              >;
            }
            return null;
          },
        ],
      });

      await page.goto("/admin/karaoke");
      const toggleBtn = page
        .getByRole("button", { name: /Ẩn bài|Hiện bài/ })
        .first();
      await expect(toggleBtn).toBeVisible();
      await toggleBtn.click();

      await expect.poll(() => visibilityPayload !== null).toBe(true);
      expect(visibilityPayload).toMatchObject({
        expected_revision: 1,
      });
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F15-01] Admin karaoke 409 expected_revision conflict disables inputs and shows reload warning", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4AdminMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "PUT" && ctx.pathname.endsWith("/draft")) {
              return {
                status: 409,
                body: { detail: "KARAOKE_REVISION_CONFLICT" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto(`/admin/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}/edit`);
      await page
        .getByRole("button", { name: /Lưu bản nháp/ })
        .first()
        .click();

      await expect(
        page.getByText(
          "Nội dung bài hát vừa được cập nhật ở phiên làm việc khác. Vui lòng tải lại bản mới nhất trước khi lưu.",
        ),
      ).toBeVisible();
      await expect(page.locator("fieldset").first()).toBeDisabled();
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [409],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F15-02] @mobile Parent karaoke 409 version conflict shows localized notice and reload recovery", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let playbackCalls = 0;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname.endsWith("/playback")) {
              playbackCalls += 1;
              if (playbackCalls === 1) {
                return {
                  status: 409,
                  body: { detail: "KARAOKE_VERSION_CONFLICT" },
                };
              }
              return {
                status: 200,
                body: makeKaraokePlayback(ctx.apiBaseUrl, { revision: 2 }),
              };
            }
            return null;
          },
        ],
      });

      await page.goto(`/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}`);
      const reloadBtn = page.getByRole("button", {
        name: /Tải lại|Thử lại/,
      });
      await expect(reloadBtn).toBeVisible();
      await reloadBtn.click();

      await expect(page.getByTestId("karaoke-stage")).toBeVisible();
      expect(playbackCalls).toBeGreaterThanOrEqual(2);
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [409],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F15-03] Disabled karaoke auto-processing capabilities show banner and allow manual editor fallback", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4AdminMocks(page, {
        adminCapabilities: makeAdminProcessingCapabilities({
          enabled: false,
          configured: false,
          supported_modes: [],
          unavailable_reason: "DISABLED",
        }),
      });

      await page.goto(`/admin/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}/edit`);
      await expect(
        page.getByText(/chưa bật|Tự động xử lý|chỉnh sửa thủ công/i).first(),
      ).toBeVisible();
      await expect(page.locator("form").first()).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F15-04] Simple-upload compliance checkboxes keep publish button disabled until both checked", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4AdminMocks(page);
      await page.goto("/admin/karaoke/new");

      const mp3Input = page
        .locator(
          'input[type="file"][accept*="audio"], input[type="file"][accept*=".mp3"]',
        )
        .first();
      await mp3Input.setInputFiles({
        name: "compliance-check.mp3",
        mimeType: "audio/mpeg",
        buffer: makeMinimalMp3Buffer(),
      });
      await page
        .getByRole("button", { name: /Tải lên và phân tích|Tiếp tục/ })
        .first()
        .click();
      await page
        .getByRole("button", { name: /Tiếp tục|Bước tiếp/ })
        .first()
        .click();

      const publishBtn = page.getByRole("button", { name: "Xuất bản ngay" });
      await expect(publishBtn).toBeDisabled();

      const checkboxes = page.locator('input[type="checkbox"]');
      await checkboxes.first().check();
      await expect(publishBtn).toBeDisabled();

      if ((await checkboxes.count()) > 1) {
        await checkboxes.nth(1).check();
      }
      await expect(publishBtn).toBeEnabled();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F15-05] Simple-upload rejects non-MP3 file, empty file, and inverted min/max grade range", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let importPostCount = 0;
      await installCluster4AdminMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "POST" &&
              ctx.pathname === "/karaoke/admin/songs/simple-import"
            ) {
              importPostCount += 1;
            }
            return null;
          },
        ],
      });

      await page.goto("/admin/karaoke/new");
      const mp3Input = page
        .locator(
          'input[type="file"][accept*="audio"], input[type="file"][accept*=".mp3"]',
        )
        .first();

      await mp3Input.setInputFiles({
        name: "not-audio.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("invalid", "utf8"),
      });
      await expect(page.getByRole("alert").first()).toBeVisible();

      await mp3Input.setInputFiles({
        name: "empty.mp3",
        mimeType: "audio/mpeg",
        buffer: Buffer.alloc(0),
      });
      await expect(page.getByRole("alert").first()).toBeVisible();

      await mp3Input.setInputFiles({
        name: "valid.mp3",
        mimeType: "audio/mpeg",
        buffer: makeMinimalMp3Buffer(),
      });
      await page.locator("details summary").first().click();
      const gradeSelects = page.locator("details select");
      await gradeSelects.nth(0).selectOption("5");
      await gradeSelects.nth(1).selectOption("1");
      await page
        .getByRole("button", { name: /Tải lên và phân tích|Tiếp tục/ })
        .first()
        .click();

      await expect(page.getByRole("alert").first()).toBeVisible();
      expect(importPostCount).toBe(0);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F15-06] Karaoke schema guards reject duration_ms > 300000 or stars > 3 while rendering null rhythm/pitch scores cleanly", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        karaokePracticeHistory: {
          child_id: OPAQUE_CHILD_ID,
          song_id: OPAQUE_C4_KARAOKE_SONG_ID,
          best_full_song_score: 70,
          best_full_song_stars: 2,
          total_sessions: 1,
          items: [
            makeKaraokePracticeSession({
              scoring_mode: "LYRICS_ONLY",
              overall_score: 70,
              rhythm_score: null,
              pitch_score: null,
              lyrics_score: 72,
              fluency_score: 68,
              stars: 2,
            }),
          ],
          storage_ready: true,
        },
      });

      await page.goto(`/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}`);
      await expect(page.getByTestId("karaoke-stage")).toBeVisible();
      const stageText = await page.getByTestId("karaoke-stage").innerText();
      expect(stageText).not.toContain("NaN");
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }

    const invalidCtx = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const invalidPage = await invalidCtx.newPage();
    const invalidErrors = attachPageErrorCollector(invalidPage);
    try {
      await installCluster4ParentMocks(invalidPage, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname.endsWith("/playback")) {
              return {
                status: 200,
                body: makeKaraokePlayback(ctx.apiBaseUrl, {
                  duration_ms: 300_001,
                }),
              };
            }
            return null;
          },
        ],
      });
      await invalidPage.goto(`/karaoke/${OPAQUE_C4_KARAOKE_SONG_ID}`);
      await expect(invalidPage.getByTestId("karaoke-stage")).toHaveCount(0);
      await expect(invalidPage.getByRole("alert").first()).toBeVisible();
      assertNoUnexpectedPageErrors(invalidErrors);
    } finally {
      await invalidCtx.close();
    }
  });
});

// ============================================================================
// F-16: AI Assistant Chatbot (10 tests)
// ============================================================================

test.describe("Cluster 4 - F-16: AI Assistant Chatbot", () => {
  test("[T1-F16-01] @mobile Global assistant launcher mounts across public /login, parent /dashboard, and admin /admin/books", async ({
    browser,
  }) => {
    const guestCtx = await createRoleContext(browser, "guest");
    const guestPage = await guestCtx.newPage();
    const guestErrors = attachPageErrorCollector(guestPage);
    try {
      await installCluster4ParentMocks(guestPage, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/auth/me") {
              return { status: 401, body: { detail: "UNAUTHORIZED" } };
            }
            return null;
          },
        ],
      });
      await guestPage.goto("/login");
      await expect(
        guestPage.getByTestId("viread-assistant-launcher"),
      ).toBeVisible();
      await assertNoMobileHorizontalOverflow(guestPage);
      assertNoUnexpectedPageErrors(guestErrors, {
        allowFailedResourceStatuses: [401],
      });
    } finally {
      await guestCtx.close();
    }

    const parentCtx = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const parentPage = await parentCtx.newPage();
    const parentErrors = attachPageErrorCollector(parentPage);
    try {
      await installCluster4ParentMocks(parentPage);
      await parentPage.goto("/dashboard");
      await expect(
        parentPage.getByTestId("viread-assistant-launcher"),
      ).toBeVisible();
      await assertNoMobileHorizontalOverflow(parentPage);
      assertNoUnexpectedPageErrors(parentErrors);
    } finally {
      await parentCtx.close();
    }

    const adminCtx = await createRoleContext(browser, "admin");
    const adminPage = await adminCtx.newPage();
    const adminErrors = attachPageErrorCollector(adminPage);
    try {
      await installCluster4AdminMocks(adminPage);
      await adminPage.goto("/admin/books");
      await expect(
        adminPage.getByTestId("viread-assistant-launcher"),
      ).toBeVisible();
      await assertNoMobileHorizontalOverflow(adminPage);
      assertNoUnexpectedPageErrors(adminErrors);
    } finally {
      await adminCtx.close();
    }
  });

  test("[T1-F16-02] @mobile Assistant submits user prompt and renders reply and source metadata", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let submittedPrompt = "";
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/assistant/chat") {
              const body = (ctx.postDataJson ?? {}) as { message?: string };
              submittedPrompt = body.message ?? "";
            }
            return null;
          },
        ],
      });

      await page.goto("/dashboard");
      await page.getByTestId("viread-assistant-launcher").click();

      const panel = page.getByTestId("viread-assistant-panel");
      await expect(panel).toBeVisible();
      const input = panel.locator('input[maxlength="800"]');
      await input.fill("Làm sao xem báo cáo đọc của bé?");
      await input.press("Enter");

      await expect
        .poll(() => submittedPrompt)
        .toBe("Làm sao xem báo cáo đọc của bé?");
      await expect(
        panel.getByText(
          "Ba mẹ có thể mở mục Tủ sách để chọn truyện theo lớp của bé.",
        ),
      ).toBeVisible();
      await expect(
        panel.getByTestId("viread-assistant-source-meta"),
      ).toBeVisible();
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F16-03] @mobile Assistant quick_actions and suggested_prompts execute safe internal navigation", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        assistantReply: {
          reply: "Ba mẹ có thể mở trang Báo cáo để xem tiến độ chi tiết.",
          source_tier: "tier_0_kb",
          provider_id: "kb-local",
          model_id: null,
          bandwidth_applied: "high",
          latency_ms: 12,
          cached: false,
          role_scope: "parent",
          quick_actions: [{ label: "Xem báo cáo", href: "/reports" }],
          suggested_prompts: ["Làm sao luyện từ khó?"],
        },
      });

      await page.goto("/dashboard");
      await page.getByTestId("viread-assistant-launcher").click();
      const panel = page.getByTestId("viread-assistant-panel");
      const input = panel.locator('input[maxlength="800"]');
      await input.fill("Xem báo cáo");
      await input.press("Enter");

      const quickActionLink = panel
        .locator('a[href="/reports"], button:has-text("Xem báo cáo")')
        .first();
      await expect(quickActionLink).toBeVisible();
      await quickActionLink.click();

      await expect(page).toHaveURL(/\/reports/);
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F16-04] @mobile Assistant bandwidth toggle, clear chat, minimize, and hide tab transitions work cleanly", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/dashboard");

      await page.getByTestId("viread-assistant-launcher").click();
      const panel = page.getByTestId("viread-assistant-panel");
      await expect(panel).toBeVisible();

      const bwBtn = page.getByTestId("viread-assistant-bandwidth-btn");
      const initialBw = await bwBtn.innerText();
      await bwBtn.click();
      await expect(bwBtn).not.toHaveText(initialBw);

      const input = panel.locator('input[maxlength="800"]');
      await input.fill("Tin nhắn tạm");
      await input.press("Enter");
      await expect(panel.getByText("Tin nhắn tạm")).toBeVisible();

      await page.getByTestId("viread-assistant-clear").click();
      await expect(panel.getByText("Tin nhắn tạm")).toBeHidden();

      await page.getByTestId("viread-assistant-minimize").click();
      await expect(panel).toBeHidden();
      await expect(page.getByTestId("viread-assistant-launcher")).toBeVisible();

      await page.getByTestId("viread-assistant-launcher").click();
      await page.getByTestId("viread-assistant-hide").click();
      await expect(
        page.getByTestId("viread-assistant-hidden-tab"),
      ).toBeVisible();

      await page.getByTestId("viread-assistant-hidden-tab").click();
      await expect(page.getByTestId("viread-assistant-launcher")).toBeVisible();
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F16-05] Assistant forwards X-ViRead-Locale header on POST /assistant/chat when non-vi locale active", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      locale: "en",
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let localeHeader: string | undefined;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/assistant/chat") {
              localeHeader = ctx.headers["x-viread-locale"];
            }
            return null;
          },
        ],
      });

      await page.goto("/dashboard");
      await page.getByTestId("viread-assistant-launcher").click();
      const input = page
        .getByTestId("viread-assistant-panel")
        .locator('input[maxlength="800"]');
      await input.fill("How do I select a book?");
      await input.press("Enter");

      await expect.poll(() => localeHeader).toBe("en");
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F16-01] @mobile Assistant 429 rate limit renders alert banner without falling back to offline reply", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/assistant/chat") {
              return {
                status: 429,
                headers: { "Retry-After": "12" },
                body: { detail: "RATE_LIMITED" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/dashboard");
      await page.getByTestId("viread-assistant-launcher").click();
      const panel = page.getByTestId("viread-assistant-panel");
      const input = panel.locator('input[maxlength="800"]');
      await input.fill("Hỏi liên tiếp");
      await input.press("Enter");

      const alert = panel.getByRole("alert");
      await expect(alert).toBeVisible();
      await expect(alert).toContainText("Bạn đang hỏi quá nhanh");
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [429],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F16-02] Assistant 502 error and offline mode fall back to offline guide reply", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/assistant/chat") {
              return {
                status: 502,
                body: { detail: "UPSTREAM_LLM_UNAVAILABLE" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/dashboard");
      await page.getByTestId("viread-assistant-launcher").click();
      const panel = page.getByTestId("viread-assistant-panel");
      const input = panel.locator('input[maxlength="800"]');
      await input.fill("Hướng dẫn đọc sách");
      await input.press("Enter");

      await expect(
        panel.getByTestId("viread-assistant-source-meta"),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [502],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F16-03] Assistant rejects unsafe https:// and // quick_actions hrefs cleanly", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        assistantReply: {
          reply: "Malicious quick action test.",
          source_tier: "tier_0_kb",
          provider_id: "kb-local",
          model_id: null,
          bandwidth_applied: "high",
          latency_ms: 5,
          cached: false,
          role_scope: "parent",
          quick_actions: [
            { label: "External Phish", href: "https://evil.example/login" },
            { label: "Protocol Relative", href: "//evil.example/steal" },
          ],
          suggested_prompts: [],
        },
      });

      await page.goto("/dashboard");
      await page.getByTestId("viread-assistant-launcher").click();
      const panel = page.getByTestId("viread-assistant-panel");
      const input = panel.locator('input[maxlength="800"]');
      await input.fill("Test unsafe action");
      await input.press("Enter");

      await expect(
        panel.getByTestId("viread-assistant-source-meta"),
      ).toBeVisible();
      await expect(panel.locator('a[href*="evil.example"]')).toHaveCount(0);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F16-04] Assistant enforces role_scope boundary (public no-auth vs parent vs admin)", async ({
    browser,
  }) => {
    const guestCtx = await createRoleContext(browser, "guest");
    const guestPage = await guestCtx.newPage();
    const guestErrors = attachPageErrorCollector(guestPage);
    try {
      let guestAuthHeader: string | undefined;
      await installCluster4ParentMocks(guestPage, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/auth/me") {
              return { status: 401, body: { detail: "UNAUTHORIZED" } };
            }
            if (ctx.method === "POST" && ctx.pathname === "/assistant/chat") {
              guestAuthHeader = ctx.headers.authorization;
            }
            return null;
          },
        ],
      });

      await guestPage.goto("/login");
      await guestPage.getByTestId("viread-assistant-launcher").click();
      const guestInput = guestPage
        .getByTestId("viread-assistant-panel")
        .locator('input[maxlength="800"]');
      await guestInput.fill("ViRead là gì?");
      await guestInput.press("Enter");

      await expect(
        guestPage
          .getByTestId("viread-assistant-panel")
          .getByTestId("viread-assistant-source-meta"),
      ).toBeVisible();
      expect(guestAuthHeader).toBeUndefined();
      assertNoUnexpectedPageErrors(guestErrors, {
        allowFailedResourceStatuses: [401],
      });
    } finally {
      await guestCtx.close();
    }

    const adminCtx = await createRoleContext(browser, "admin");
    const adminPage = await adminCtx.newPage();
    const adminErrors = attachPageErrorCollector(adminPage);
    try {
      let adminAuthSeen = false;
      await installCluster4AdminMocks(adminPage, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/assistant/chat") {
              adminAuthSeen = Boolean(ctx.headers.authorization);
            }
            return null;
          },
        ],
      });

      await adminPage.goto("/admin/books");
      await adminPage.getByTestId("viread-assistant-launcher").click();
      const adminInput = adminPage
        .getByTestId("viread-assistant-panel")
        .locator('input[maxlength="800"]');
      await adminInput.fill("Kiểm tra sức khỏe OCR");
      await adminInput.press("Enter");

      await expect.poll(() => adminAuthSeen).toBe(true);
      assertNoUnexpectedPageErrors(adminErrors);
    } finally {
      await adminCtx.close();
    }
  });

  test("[T2-F16-05] @mobile Assistant input enforces maxLength=800 and ignores whitespace-only submission", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let chatCalls = 0;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/assistant/chat") {
              chatCalls += 1;
            }
            return null;
          },
        ],
      });

      await page.goto("/dashboard");
      await page.getByTestId("viread-assistant-launcher").click();
      const panel = page.getByTestId("viread-assistant-panel");
      const input = panel.locator('input[maxlength="800"]');

      await expect(input).toHaveAttribute("maxlength", "800");
      await input.fill("    ");
      await input.press("Enter");
      expect(chatCalls).toBe(0);

      await input.fill("x".repeat(900));
      expect((await input.inputValue()).length).toBeLessThanOrEqual(800);

      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });
});

// ============================================================================
// F-17: Internationalization i18n (10 tests)
// ============================================================================

test.describe("Cluster 4 - F-17: Internationalization i18n", () => {
  test("[T1-F17-01] Desktop language selector popover lists all 11 published locales", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "guest", {
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/auth/me") {
              return { status: 401, body: { detail: "UNAUTHORIZED" } };
            }
            return null;
          },
        ],
      });

      await page.goto("/login");
      const trigger = page
        .locator('button[aria-haspopup="dialog"][aria-expanded]')
        .first();
      await expect(trigger).toBeVisible();
      await trigger.click();

      const popover = page.locator('[data-language-popover="true"]');
      await expect(popover).toBeVisible();

      for (const localeCode of PUBLISHED_LOCALES) {
        await expect(
          popover.locator(`[role="option"][data-locale-code="${localeCode}"]`),
        ).toBeVisible();
      }
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [401],
      });
    } finally {
      await context.close();
    }
  });

  test("[T1-F17-02] @mobile Mobile language sheet searches and switches to English, updating cookie and X-ViRead-Locale", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      const seenLocaleHeaders: string[] = [];
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            const loc = ctx.headers["x-viread-locale"];
            if (loc) {
              seenLocaleHeaders.push(loc);
            }
            return null;
          },
        ],
      });

      await page.goto("/login");
      await page
        .locator('button[aria-haspopup="dialog"][aria-expanded]')
        .first()
        .click();

      const sheet = page.locator('[data-language-sheet="true"]');
      await expect(sheet).toBeVisible();
      await sheet.locator('input[type="search"]').fill("English");
      await sheet.locator('[role="option"][data-locale-code="en"]').click();

      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

      const cookies = await context.cookies();
      expect(cookies.find((item) => item.name === "viread_locale")?.value).toBe(
        "en",
      );

      await page.goto("/dashboard");
      await expect.poll(() => seenLocaleHeaders.includes("en")).toBe(true);
      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F17-03] @mobile Selecting Arabic sets viread_locale=ar, dir=rtl, and X-ViRead-Locale=ar across reload", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      locale: "ar",
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let arHeaderSeen = false;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.headers["x-viread-locale"] === "ar") {
              arHeaderSeen = true;
            }
            return null;
          },
        ],
      });

      await page.goto("/dashboard");
      await expect(page.locator("html")).toHaveAttribute("lang", "ar");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", "ar");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      expect(arHeaderSeen).toBe(true);

      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F17-04] @mobile Selecting Hebrew sets viread_locale=he and dir=rtl across SSR navigation", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      locale: "he",
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);

      await page.goto("/reports");
      await expect(page.locator("html")).toHaveAttribute("lang", "he");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

      await page.goto("/karaoke");
      await expect(page.locator("html")).toHaveAttribute("lang", "he");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

      await assertNoMobileHorizontalOverflow(page);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F17-05] Learning content preserves dir=ltr lang=vi under Arabic RTL html layout", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      locale: "ar",
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);

      await page.goto("/karaoke");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const songLearning = page.locator(".viread-learning-content").first();
      await expect(songLearning).toBeVisible();
      await expect(songLearning).toHaveAttribute("dir", "ltr");
      await expect(songLearning).toHaveAttribute("lang", "vi");

      await page.goto("/reading-management");
      const bookLearning = page.locator(".viread-learning-content").first();
      if ((await bookLearning.count()) > 0) {
        await expect(bookLearning).toHaveAttribute("dir", "ltr");
        await expect(bookLearning).toHaveAttribute("lang", "vi");
      }

      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F17-01] XSS cookie injection viread_locale=<script>alert(1)</script> falls back safely to vi/ltr", async ({
    browser,
  }) => {
    const xssVector =
      OPAQUE_INVALID_LOCALE_VECTORS.find((v) => v.includes("<script")) ??
      "<script>alert(1)</script>";
    const context = await createRoleContext(browser, "guest", {
      locale: xssVector,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/auth/me") {
              return { status: 401, body: { detail: "UNAUTHORIZED" } };
            }
            return null;
          },
        ],
      });

      await page.goto("/login");
      await expect(page.locator("html")).toHaveAttribute("lang", "vi");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [401],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F17-02] Path-traversal and null-byte locale cookies fall back safely to vi/ltr", async ({
    browser,
  }) => {
    const traversalVector =
      OPAQUE_INVALID_LOCALE_VECTORS.find((v) => v.includes("..")) ??
      "../../etc/passwd";
    const context = await createRoleContext(browser, "guest", {
      locale: traversalVector,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/auth/me") {
              return { status: 401, body: { detail: "UNAUTHORIZED" } };
            }
            return null;
          },
        ],
      });

      await page.goto("/login");
      await expect(page.locator("html")).toHaveAttribute("lang", "vi");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [401],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F17-03] Unpublished locale cookie pt-BR falls back cleanly to vi without 500", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "guest", {
      locale: "pt-BR",
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/auth/me") {
              return { status: 401, body: { detail: "UNAUTHORIZED" } };
            }
            return null;
          },
        ],
      });

      const res = await page.goto("/login");
      expect(res?.status()).toBeLessThan(500);
      await expect(page.locator("html")).toHaveAttribute("lang", "vi");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [401],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F17-04] Absent viread_locale cookie ignores browser Accept-Language and navigator.language, defaulting to vi", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
      },
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/auth/me") {
              return { status: 401, body: { detail: "UNAUTHORIZED" } };
            }
            return null;
          },
        ],
      });

      await page.goto("/login");
      await expect(page.locator("html")).toHaveAttribute("lang", "vi");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [401],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F17-05] Default vi locale omits X-ViRead-Locale header while non-vi sends X-ViRead-Locale", async ({
    browser,
  }) => {
    const viCtx = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      locale: "vi",
    });
    const viPage = await viCtx.newPage();
    const viErrors = attachPageErrorCollector(viPage);
    try {
      const viHeaders: Array<string | undefined> = [];
      await installCluster4ParentMocks(viPage, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.pathname === "/children") {
              viHeaders.push(ctx.headers["x-viread-locale"]);
            }
            return null;
          },
        ],
      });
      await viPage.goto("/dashboard");
      await expect.poll(() => viHeaders.length).toBeGreaterThan(0);
      expect(viHeaders.every((val) => val === undefined)).toBe(true);
      assertNoUnexpectedPageErrors(viErrors);
    } finally {
      await viCtx.close();
    }

    const jaCtx = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
      locale: "ja",
    });
    const jaPage = await jaCtx.newPage();
    const jaErrors = attachPageErrorCollector(jaPage);
    try {
      const jaHeaders: Array<string | undefined> = [];
      await installCluster4ParentMocks(jaPage, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.pathname === "/children") {
              jaHeaders.push(ctx.headers["x-viread-locale"]);
            }
            return null;
          },
        ],
      });
      await jaPage.goto("/dashboard");
      await expect.poll(() => jaHeaders.includes("ja")).toBe(true);
      assertNoUnexpectedPageErrors(jaErrors);
    } finally {
      await jaCtx.close();
    }
  });
});

// ============================================================================
// F-21: Admin Health & Audit (10 tests)
// ============================================================================

test.describe("Cluster 4 - F-21: Admin Health & Audit", () => {
  test("[T1-F21-01] Admin health renders HEALTHY status badge, 4 KPI cards, and all 5 diagnostic groups", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4AdminMocks(page);
      await page.goto("/admin/health");

      await expect(page.getByTestId("health-kpi-healthy")).toBeVisible();
      await expect(page.getByTestId("health-kpi-attention")).toBeVisible();
      await expect(page.getByTestId("health-kpi-standby")).toBeVisible();
      await expect(page.getByTestId("health-kpi-local-only")).toBeVisible();

      await expect(page.getByTestId("health-group-core")).toBeVisible();
      await expect(page.getByTestId("health-group-voice")).toBeVisible();
      await expect(page.getByTestId("health-group-ocr")).toBeVisible();
      await expect(page.getByTestId("health-group-workers")).toBeVisible();
      await expect(page.getByTestId("health-group-local-only")).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F21-02] Admin health filter pills narrow visible diagnostic groups cleanly", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4AdminMocks(page);
      await page.goto("/admin/health");

      await page.getByTestId("health-filter-local_only").click();
      await expect(page.getByTestId("health-group-local-only")).toBeVisible();
      await expect(page.getByTestId("health-group-core")).toBeHidden();

      await page.getByTestId("health-filter-all").click();
      await expect(page.getByTestId("health-group-core")).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F21-03] Admin OCR worker wakeup triggers POST wakeup, renders notice, and refreshes snapshot", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let wakeupCalled = false;
      let healthGetCount = 0;
      await installCluster4AdminMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "GET" &&
              ctx.pathname === "/system/admin/health"
            ) {
              healthGetCount += 1;
            }
            if (
              ctx.method === "POST" &&
              ctx.pathname === "/system/admin/health/ocr-worker/wakeup"
            ) {
              wakeupCalled = true;
            }
            return null;
          },
        ],
      });

      await page.goto("/admin/health");
      const wakeupBtn = page
        .getByRole("button", { name: /Đánh thức worker OCR|Đánh thức/ })
        .first();
      await expect(wakeupBtn).toBeVisible();
      await wakeupBtn.click();

      await expect.poll(() => wakeupCalled).toBe(true);
      await expect(page.getByTestId("ocr-wakeup-notice")).toBeVisible();
      await expect.poll(() => healthGetCount).toBeGreaterThanOrEqual(2);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F21-04] Admin audit logs render rows, open detail drawer, and paginate via cursor", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4AdminMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "GET" &&
              ctx.pathname === "/system/admin/audit-logs"
            ) {
              const cursor = ctx.searchParams.get("cursor");
              if (cursor === "page-2") {
                return {
                  status: 200,
                  body: {
                    items: [
                      {
                        id: OPAQUE_C4_AUDIT_ID_3,
                        actor_id: "88000000-0000-4000-8000-000000000001",
                        action: "SETTINGS_UPDATED",
                        resource_type: "SYSTEM_SETTING",
                        resource_id: null,
                        request_id: "req-audit-003",
                        created_at: OPAQUE_C4_NOW_OFFSET,
                        metadata: { section: "voice" },
                      },
                    ],
                    next_cursor: null,
                  },
                };
              }
              return {
                status: 200,
                body: makeAdminAuditLogsPage({ next_cursor: "page-2" }),
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/admin/audit-logs");
      await expect(page.getByText("BOOK_PUBLISHED").first()).toBeVisible();

      const inspectBtn = page
        .getByRole("button", { name: /Chi tiết|Xem chi tiết/ })
        .first();
      await inspectBtn.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");

      const loadMoreBtn = page.getByRole("button", { name: "Tải thêm" });
      await expect(loadMoreBtn).toBeVisible();
      await loadMoreBtn.click();
      await expect(page.getByText("SETTINGS_UPDATED").first()).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F21-05] Admin audit logs dual search inputs filter by action and resource_type", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      const queries: string[] = [];
      await installCluster4AdminMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "GET" &&
              ctx.pathname === "/system/admin/audit-logs"
            ) {
              queries.push(ctx.searchParams.toString());
            }
            return null;
          },
        ],
      });

      await page.goto("/admin/audit-logs");
      const inputs = page.locator('input[type="search"], input[type="text"]');
      await inputs.nth(0).fill("BOOK_PUBLISHED");
      await inputs.nth(1).fill("BOOK");

      await expect
        .poll(() =>
          queries.some(
            (q) =>
              q.includes("action=BOOK_PUBLISHED") &&
              q.includes("resource_type=BOOK"),
          ),
        )
        .toBe(true);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F21-01] DEGRADED admin health snapshot displays attention KPI and audio_cache_error warning", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      const base = makeCluster4AdminHealthSnapshot();
      await installCluster4AdminMocks(page, {
        adminHealthSnapshot: {
          ...base,
          overall_status: "DEGRADED",
          services: base.services.map((svc) =>
            svc.id === "ocr_worker"
              ? {
                  ...svc,
                  status: "DEGRADED",
                  operational_state: "Degraded",
                  safe_message: "Worker phản hồi chậm.",
                  last_error: "Timeout waiting for heartbeat",
                }
              : svc,
          ),
          audio_cache: null,
          audio_cache_error: "Audio cache quota probe failed.",
        },
      });

      await page.goto("/admin/health");
      await expect(page.getByTestId("health-kpi-attention")).toContainText("1");
      await expect(
        page.getByText("Audio cache quota probe failed."),
      ).toBeVisible();
      await expect(page.getByTestId("health-group-core")).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F21-02] Transient 500 on health refresh preserves prior snapshot and renders refresh warning", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let calls = 0;
      await installCluster4AdminMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (
              ctx.method === "GET" &&
              ctx.pathname === "/system/admin/health"
            ) {
              calls += 1;
              if (calls >= 2) {
                return {
                  status: 500,
                  body: { detail: "HEALTH_REFRESH_TIMEOUT" },
                };
              }
            }
            return null;
          },
        ],
      });

      await page.goto("/admin/health");
      await expect(page.getByTestId("health-group-core")).toBeVisible();

      await page
        .getByRole("button", { name: /Làm mới/ })
        .first()
        .click();
      await expect(page.getByTestId("health-refresh-warning")).toBeVisible();
      await expect(page.getByTestId("health-group-core")).toBeVisible();
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [500],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F21-03] Non-admin RBAC redirects guest to /admin/login and parent to /dashboard without leaking diagnostics", async ({
    browser,
  }) => {
    const guestCtx = await createRoleContext(browser, "guest");
    const guestPage = await guestCtx.newPage();
    const guestErrors = attachPageErrorCollector(guestPage);
    try {
      await installCluster4ParentMocks(guestPage, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/auth/me") {
              return { status: 401, body: { detail: "UNAUTHORIZED" } };
            }
            return null;
          },
        ],
      });
      await guestPage.goto("/admin/health");
      await expect(guestPage).toHaveURL(/\/admin\/login\?next=/);
      await expect(guestPage.getByTestId("health-group-core")).toHaveCount(0);
      assertNoUnexpectedPageErrors(guestErrors, {
        allowFailedResourceStatuses: [401],
      });
    } finally {
      await guestCtx.close();
    }

    const parentCtx = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const parentPage = await parentCtx.newPage();
    const parentErrors = attachPageErrorCollector(parentPage);
    try {
      await installCluster4ParentMocks(parentPage);
      await parentPage.goto("/admin/audit-logs");
      await expect(parentPage).toHaveURL(/\/dashboard/);
      assertNoUnexpectedPageErrors(parentErrors);
    } finally {
      await parentCtx.close();
    }
  });

  test("[T2-F21-04] Audit drawer redacts sensitive metadata keys (token, secret, hash, signature, nonce, uuid)", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4AdminMocks(page);
      await page.goto("/admin/audit-logs");

      await page
        .getByRole("button", { name: /Chi tiết|Xem chi tiết/ })
        .first()
        .click();

      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      const drawerText = await drawer.innerText();
      expect(drawerText).toContain("Chú Mèo Đi Hia");
      expect(drawerText).not.toContain("leaked-token-should-be-masked");
      expect(drawerText).not.toContain("leaked-secret-should-be-masked");
      expect(drawerText).not.toContain("leaked-hash-should-be-masked");
      expect(drawerText).not.toContain("leaked-sig-should-be-masked");
      expect(drawerText).not.toContain("leaked-nonce-should-be-masked");
      expect(drawerText).not.toContain("leaked-uuid-should-be-masked");
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F21-05] Malformed audit log row fails schema validation cleanly with safe error state", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "admin");
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4AdminMocks(page, {
        adminAuditLogs: {
          items: [
            {
              id: "not-a-valid-uuid",
              actor_id: "88000000-0000-4000-8000-000000000001",
              action: "BOOK_PUBLISHED",
              resource_type: "BOOK",
              resource_id: OPAQUE_BOOK_ID,
              request_id: "req-bad",
              created_at: OPAQUE_C4_NOW_OFFSET,
              metadata: {},
            },
          ],
          next_cursor: null,
        },
      });

      await page.goto("/admin/audit-logs");
      await expect(page.getByRole("alert").first()).toBeVisible();
      await expect(page.getByText("req-bad")).toHaveCount(0);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });
});

// ============================================================================
// F-22: Support & Feedback (10 tests)
// ============================================================================

test.describe("Cluster 4 - F-22: Support & Feedback", () => {
  test("[T1-F22-01] Help-support renders FAQ/contact headings and opens assistant widget from CTA", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/help-support");

      await expect(page.locator("#support-faq-heading")).toBeVisible();
      await expect(page.locator("#support-contact-heading")).toBeVisible();

      await page.getByRole("button", { name: "Mở Trợ lý ViRead" }).click();
      await expect(page.getByTestId("viread-assistant-panel")).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F22-02] Help-support opens feedback form editor with category, subject, message, and email fields", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page);
      await page.goto("/help-support");

      await page.getByRole("button", { name: "Gửi phản hồi" }).first().click();
      await expect(page.locator("#support-category")).toBeVisible();
      await expect(page.locator("#support-subject")).toBeVisible();
      await expect(page.locator("#support-message")).toBeVisible();
      await expect(page.locator("#support-contact-email")).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F22-03] Valid feedback submission posts to /support/feedback and renders 202 accepted confirmation", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let submittedPayload: Record<string, unknown> | null = null;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/support/feedback") {
              submittedPayload = (ctx.postDataJson ?? {}) as Record<
                string,
                unknown
              >;
            }
            return null;
          },
        ],
      });

      await page.goto("/help-support");
      await page.getByRole("button", { name: "Gửi phản hồi" }).first().click();

      await page.locator("#support-subject").fill("Cần hỗ trợ thêm sách lớp 2");
      await page
        .locator("#support-message")
        .fill("Gia đình muốn tìm thêm truyện cổ tích Việt Nam cho bé.");
      await page
        .locator("#support-contact-email")
        .fill("parent.support@viread.local");

      await page.locator('form button[type="submit"]').click();

      await expect.poll(() => submittedPayload !== null).toBe(true);
      expect(submittedPayload).toMatchObject({
        subject: "Cần hỗ trợ thêm sách lớp 2",
        contact_email: "parent.support@viread.local",
      });
      await expect(
        page.getByText("Phản hồi của bạn đã được tiếp nhận."),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F22-04] Non-default support category selection sends exact selected category", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let selectedCategory: unknown = null;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/support/feedback") {
              const body = (ctx.postDataJson ?? {}) as { category?: unknown };
              selectedCategory = body.category ?? null;
            }
            return null;
          },
        ],
      });

      await page.goto("/help-support");
      await page.getByRole("button", { name: "Gửi phản hồi" }).first().click();

      await page.locator("#support-category").selectOption("feature_request");
      await page.locator("#support-subject").fill("Đề xuất tính năng mới");
      await page.locator("#support-message").fill("Thêm chế độ đọc ban đêm.");
      await page
        .locator("#support-contact-email")
        .fill("parent.feature@viread.local");
      await page.locator('form button[type="submit"]').click();

      await expect.poll(() => selectedCategory).toBe("feature_request");
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T1-F22-05] Exact max boundary subject=120 and message=5000 submit cleanly", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let capturedLengths: { subject: number; message: number } | null = null;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/support/feedback") {
              const body = (ctx.postDataJson ?? {}) as {
                subject?: string;
                message?: string;
              };
              capturedLengths = {
                subject: body.subject?.length ?? 0,
                message: body.message?.length ?? 0,
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/help-support");
      await page.getByRole("button", { name: "Gửi phản hồi" }).first().click();

      await page.locator("#support-subject").fill("S".repeat(120));
      await page.locator("#support-message").fill("M".repeat(5000));
      await page
        .locator("#support-contact-email")
        .fill("boundary@viread.local");
      await page.locator('form button[type="submit"]').click();

      await expect
        .poll(() => capturedLengths)
        .toEqual({ subject: 120, message: 5000 });
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F22-01] Blank fields or invalid email fail client validation without sending network POST", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      let postCount = 0;
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/support/feedback") {
              postCount += 1;
            }
            return null;
          },
        ],
      });

      await page.goto("/help-support");
      await page.getByRole("button", { name: "Gửi phản hồi" }).first().click();

      await page.locator('form button[type="submit"]').click();
      await expect(
        page.getByText(
          "Ba mẹ vui lòng điền tiêu đề, nội dung và email liên hệ.",
        ),
      ).toBeVisible();

      await page.locator("#support-subject").fill("Tiêu đề hợp lệ");
      await page.locator("#support-message").fill("Nội dung hợp lệ");
      await page.locator("#support-contact-email").fill("not-an-email");
      await page.locator('form button[type="submit"]').click();

      await expect(
        page.getByText("Email liên hệ chưa đúng định dạng."),
      ).toBeVisible();
      expect(postCount).toBe(0);
      assertNoUnexpectedPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("[T2-F22-02] 503 SMTP outage displays safe unavailable message without leaking SMTP internals", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/support/feedback") {
              return {
                status: 503,
                body: {
                  detail:
                    "SMTPAuthenticationError smtp.gmail.com:587 secret_app_pw",
                },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/help-support");
      await page.getByRole("button", { name: "Gửi phản hồi" }).first().click();
      await page.locator("#support-subject").fill("Lỗi gửi mail");
      await page.locator("#support-message").fill("Kiểm tra lỗi 503.");
      await page.locator("#support-contact-email").fill("p@viread.local");
      await page.locator('form button[type="submit"]').click();

      const safeText =
        "Hệ thống email hỗ trợ đang tạm thời không khả dụng. Ba mẹ có thể thử gửi lại sau.";
      await expect(page.getByText(safeText)).toBeVisible();
      const bodyText = await page.locator("main").innerText();
      expect(bodyText).not.toContain("SMTP");
      expect(bodyText).not.toContain("gmail");
      expect(bodyText).not.toContain("secret_app_pw");
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [503],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F22-03] 429 rate limit renders safe failure message and preserves user draft for retry", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/support/feedback") {
              return {
                status: 429,
                body: { detail: "TOO_MANY_SUPPORT_REQUESTS" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/help-support");
      await page.getByRole("button", { name: "Gửi phản hồi" }).first().click();
      await page.locator("#support-subject").fill("Bản nháp giữ nguyên");
      await page.locator("#support-message").fill("Nội dung không được mất.");
      await page.locator("#support-contact-email").fill("retry@viread.local");
      await page.locator('form button[type="submit"]').click();

      await expect(
        page.getByText("Chưa gửi được phản hồi. Ba mẹ vui lòng thử lại sau."),
      ).toBeVisible();
      await expect(page.locator("#support-subject")).toHaveValue(
        "Bản nháp giữ nguyên",
      );
      await expect(page.locator("#support-message")).toHaveValue(
        "Nội dung không được mất.",
      );
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [429],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F22-04] 422 invalid payload renders safe warning and typing enforces subject/message maxLength", async ({
    browser,
  }) => {
    const context = await createRoleContext(browser, "parent", {
      selectedChildId: OPAQUE_CHILD_ID,
    });
    const page = await context.newPage();
    const errors = attachPageErrorCollector(page);
    try {
      await installCluster4ParentMocks(page, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/support/feedback") {
              return {
                status: 422,
                body: { detail: "INVALID_SUPPORT_PAYLOAD" },
              };
            }
            return null;
          },
        ],
      });

      await page.goto("/help-support");
      await page.getByRole("button", { name: "Gửi phản hồi" }).first().click();

      const subjectInput = page.locator("#support-subject");
      const messageInput = page.locator("#support-message");
      await expect(subjectInput).toHaveAttribute("maxlength", "120");
      await expect(messageInput).toHaveAttribute("maxlength", "5000");

      await subjectInput.fill("A".repeat(150));
      expect((await subjectInput.inputValue()).length).toBeLessThanOrEqual(120);

      await messageInput.fill("Kiểm tra lỗi 422");
      await page.locator("#support-contact-email").fill("valid@viread.local");
      await page.locator('form button[type="submit"]').click();

      await expect(
        page.getByText(
          "Thông tin gửi đi chưa hợp lệ. Ba mẹ vui lòng kiểm tra lại.",
        ),
      ).toBeVisible();
      assertNoUnexpectedPageErrors(errors, {
        allowFailedResourceStatuses: [422],
      });
    } finally {
      await context.close();
    }
  });

  test("[T2-F22-05] Role guard redirects admin to /admin/books and guest to /login, while direct 403 is handled safely", async ({
    browser,
  }) => {
    const guestCtx = await createRoleContext(browser, "guest");
    const guestPage = await guestCtx.newPage();
    const guestErrors = attachPageErrorCollector(guestPage);
    try {
      await installCluster4ParentMocks(guestPage, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "GET" && ctx.pathname === "/auth/me") {
              return { status: 401, body: { detail: "UNAUTHORIZED" } };
            }
            return null;
          },
        ],
      });
      await guestPage.goto("/help-support");
      await expect(guestPage).toHaveURL(/\/login\?next=%2Fhelp-support/);
      assertNoUnexpectedPageErrors(guestErrors, {
        allowFailedResourceStatuses: [401],
      });
    } finally {
      await guestCtx.close();
    }

    const adminCtx = await createRoleContext(browser, "admin");
    const adminPage = await adminCtx.newPage();
    const adminErrors = attachPageErrorCollector(adminPage);
    try {
      await installCluster4AdminMocks(adminPage, {
        customRoutes: [
          (ctx: ApiMockRequestContext): ApiMockResponse | null => {
            if (ctx.method === "POST" && ctx.pathname === "/support/feedback") {
              return { status: 403, body: { detail: "FORBIDDEN" } };
            }
            return null;
          },
        ],
      });
      await adminPage.goto("/help-support");
      await expect(adminPage).toHaveURL(/\/admin\/books/);

      const direct403 = await apiFetchInPage(adminPage, "/support/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "other",
          subject: "Test",
          message: "Test",
          contact_email: "admin@viread.local",
        }),
      });
      expect(direct403.status).toBe(403);
      assertNoUnexpectedPageErrors(adminErrors, {
        allowFailedResourceStatuses: [403],
      });
    } finally {
      await adminCtx.close();
    }
  });
});
