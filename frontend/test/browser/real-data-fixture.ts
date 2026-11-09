import { expect, type Page, type Route } from "@playwright/test";
import { createPlaywrightAuthFixtureHeaders } from "../../lib/auth/playwright-auth-fixture";

export const ids = {
  parent: "11111111-1111-4111-8111-111111111111",
  child: "22222222-2222-4222-8222-222222222222",
  book: "33333333-3333-4333-8333-333333333333",
  session: "44444444-4444-4444-8444-444444444444",
  page: "55555555-5555-4555-8555-555555555555",
  revision: "66666666-6666-4666-8666-666666666666",
  oldRevision: "77777777-7777-4777-8777-777777777777",
  draftRevision: "88888888-8888-4888-8888-888888888888",
};
const timestamp = "2026-10-08T00:00:00Z";
export const child = {
  id: ids.child,
  parent_id: ids.parent,
  alias: "Bé API",
  grade: 2,
  settings: {},
  created_at: timestamp,
};
export const book = {
  id: ids.book,
  name: "Tên sách từ API",
  title: "Câu chuyện từ API",
  author: "Tác giả API",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
};
const processing = {
  page_id: ids.page,
  page_revision_id: ids.revision,
  revision_no: 2,
  verification_status: "VERIFIED",
  lifecycle_status: "ACTIVE",
  ocr_preview_metadata: {},
  verified_at: timestamp,
  current_verified_revision_id: ids.revision,
};
const summary = {
  id: ids.session,
  child_id: ids.child,
  book_id: ids.book,
  state: "ABORTED",
  started_at: timestamp,
  ended_at: null,
  duration_ms: null,
};
const word = {
  normalized_word: "meo",
  display_text: "Mèo API",
  difficulty_score: 3,
  omission_count: 1,
  repetition_count: 0,
  long_pause_count: 0,
  read_example_count: 0,
  session_count: 1,
  last_seen_at: timestamp,
  evidence_word_ids: [ids.revision],
};

export interface BrowserApiState {
  catalogStatus: number;
  emptyCatalog: boolean;
  emptyChildren: boolean;
  reportStatus: number;
  previewStatus: number;
  adminPagesStatus: number;
  historyStatus: number;
  unexpected: string[];
  requests: string[];
  createBookRequest: {
    name: string;
    title: string;
    author: string | null;
    min_grade: number;
    max_grade: number;
  } | null;
  createdBook: {
    id: string;
    name: string;
    title: string;
    author: string | null;
    min_grade: number;
    max_grade: number;
    lifecycle_status: "ACTIVE";
  } | null;
  draftCreateSourceRevisionId: string | null;
  aiCorrectionText: string | null;
  draftSaveRequest: Record<string, unknown> | null;
  verifyRequest: Record<string, unknown> | null;
}

export async function setRole(page: Page, role: "parent" | "admin") {
  const fixtureToken = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN;
  if (!fixtureToken) throw new Error("Missing isolated auth fixture token");
  await page.setExtraHTTPHeaders(
    createPlaywrightAuthFixtureHeaders(role, fixtureToken),
  );
}

/** Unverified SDK session only, accepted solely by the intercepted test API. */
async function seedBrowserSession(page: Page) {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(
    JSON.stringify({
      sub: ids.parent,
      exp: expiry,
      aud: "authenticated",
      role: "authenticated",
    }),
  ).toString("base64url");
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.isolated-test-signature`,
    refresh_token: "isolated-test-refresh",
    token_type: "bearer",
    expires_at: expiry,
    expires_in: 3600,
    user: {
      id: ids.parent,
      aud: "authenticated",
      role: "authenticated",
      email: "parent@example.test",
      app_metadata: {},
      user_metadata: { display_name: "Ba mẹ API" },
      created_at: timestamp,
    },
  };
  await page.context().addCookies([
    {
      name: "sb-example-auth-token",
      value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
      expires: expiry,
    },
  ]);
}

export async function installApiFixture(page: Page): Promise<BrowserApiState> {
  const state: BrowserApiState = {
    catalogStatus: 200,
    emptyCatalog: false,
    emptyChildren: false,
    reportStatus: 200,
    previewStatus: 503,
    adminPagesStatus: 200,
    historyStatus: 200,
    unexpected: [],
    requests: [],
    createBookRequest: null,
    createdBook: null,
    draftCreateSourceRevisionId: null,
    aiCorrectionText: null,
    draftSaveRequest: null,
    verifyRequest: null,
  };
  await seedBrowserSession(page);
  const headers = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  };
  async function respond(route: Route, json: unknown, status = 200) {
    await route.fulfill({
      status,
      headers,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  }
  function draftDetail() {
    const words = ["Văn", "bản", "đã", "lưu"].map((text, index) => ({
      word_index: index,
      line_index: 0,
      text,
      normalized_text: text.toLocaleLowerCase("vi"),
      bbox: [0.1 + index * 0.16, 0.2, 0.14, 0.05],
      ocr_confidence: 0.8,
    }));
    const saved = state.draftSaveRequest;
    const verified = state.verifyRequest;
    const savedWords = (saved?.words ?? words) as typeof words;
    const correctedWords = (verified?.words ?? savedWords) as typeof words;
    return {
      page_id: ids.page,
      page_revision_id: ids.draftRevision,
      revision_no: 3,
      verification_status: verified ? "VERIFIED" : "NEEDS_REVIEW",
      lifecycle_status: "ACTIVE",
      draft_text:
        (verified?.corrected_text as string | undefined) ??
        (saved?.draft_text as string | undefined) ??
        "Văn bản đã lưu",
      words: correctedWords,
      ocr_metadata: { source_revision_id: ids.revision },
      created_at: timestamp,
      verified_at: verified ? timestamp : null,
      verified_by: verified ? ids.parent : null,
    };
  }
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === "http://127.0.0.1:3106") return route.continue();
    // Every other origin is intercepted: no real network calls can escape.
    if (url.origin !== "http://127.0.0.1:8000") {
      state.unexpected.push(`external:${url.hostname}`);
      return route.abort();
    }
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const path = url.pathname;
    if (request.method() === "POST" && path === "/books/admin/catalog") {
      expect(request.headers().authorization).toMatch(/^Bearer /);
      const body = request.postDataJSON() as Record<string, unknown>;
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        typeof body.title !== "string" ||
        !body.title.trim() ||
        !(body.author === null || typeof body.author === "string") ||
        !Number.isInteger(body.min_grade) ||
        !Number.isInteger(body.max_grade) ||
        Number(body.min_grade) < 1 ||
        Number(body.max_grade) > 5 ||
        Number(body.min_grade) > Number(body.max_grade)
      ) {
        return respond(route, { detail: "Invalid create book payload" }, 422);
      }
      const requestPayload = {
        name: body.name.trim(),
        title: body.title.trim(),
        author: body.author as string | null,
        min_grade: Number(body.min_grade),
        max_grade: Number(body.max_grade),
      };
      state.createBookRequest = requestPayload;
      state.createdBook = {
        id: "88888888-8888-4888-8888-888888888888",
        ...requestPayload,
        lifecycle_status: "ACTIVE",
      };
      return respond(route, state.createdBook);
    }
    if (
      request.method() === "POST" &&
      path === `/books/admin/pages/${ids.page}/revisions/draft`
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.draftCreateSourceRevisionId =
        typeof body.expected_source_revision_id === "string"
          ? body.expected_source_revision_id
          : null;
      if (state.draftCreateSourceRevisionId !== ids.revision)
        return respond(route, { detail: "Invalid source revision" }, 409);
      return respond(route, draftDetail());
    }
    if (
      request.method() === "POST" &&
      path === `/books/admin/pages/${ids.page}/ai-correct/jobs`
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.aiCorrectionText =
        typeof body.draft_text === "string" ? body.draft_text : null;
      if (!state.draftCreateSourceRevisionId || !state.aiCorrectionText)
        return respond(route, { detail: "No editable draft" }, 409);
      return respond(
        route,
        {
          job_id: "99999999-9999-4999-8999-999999999999",
          page_id: ids.page,
          status: "SUCCEEDED",
          completed_chunks: 1,
          total_chunks: 1,
          result: "Văn bản đã sửa",
          error: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
        202,
      );
    }
    if (
      request.method() === "PUT" &&
      path ===
        `/books/admin/pages/${ids.page}/revisions/${ids.draftRevision}/draft`
    ) {
      state.draftSaveRequest = request.postDataJSON() as Record<
        string,
        unknown
      >;
      if (!state.draftCreateSourceRevisionId)
        return respond(route, { detail: "No editable draft" }, 409);
      return respond(route, draftDetail());
    }
    if (
      request.method() === "POST" &&
      path === `/books/admin/pages/${ids.page}/verify`
    ) {
      state.verifyRequest = request.postDataJSON() as Record<string, unknown>;
      if (state.verifyRequest.page_revision_id !== ids.draftRevision)
        return respond(route, { detail: "Invalid draft revision" }, 409);
      return respond(route, draftDetail());
    }
    // The AI progress card is a separate feature with its own tests; here it
    // only needs to settle quietly ("not enough data" -> no AI call is made).
    const assessmentChild =
      /^\/tutor\/children\/([^/]+)\/progress-assessment$/.exec(path)?.[1];
    if (request.method() === "GET" && assessmentChild) {
      const day = timestamp.slice(0, 10);
      return respond(route, {
        child_id: assessmentChild,
        period_start: day,
        period_end: day,
        days: 30,
        generated_at: timestamp,
        data_status: "INSUFFICIENT",
        score: {
          overall: null,
          previous_overall: null,
          delta: null,
          grade: null,
          grade_label: null,
          components: [],
        },
        metrics: {
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
        assessment: {
          source: "RULE_BASED",
          model: null,
          headline: "Chưa đủ dữ liệu để đánh giá",
          summary: "Bé cần đọc thêm vài buổi để có đánh giá.",
          strengths: [],
          weaknesses: [],
          actions: [
            {
              title: "Đọc cùng bé",
              detail: "Dành vài phút mỗi ngày để đọc cùng bé.",
              audience: "PARENT",
            },
          ],
          practice_words: [],
          encouragement: "Bé cố gắng lên nhé!",
        },
        ai_cached: false,
      });
    }
    if (request.method() !== "GET") {
      state.unexpected.push(`write:${request.method()}:${url.pathname}`);
      return respond(route, { detail: "Test forbids writes" }, 405);
    }
    state.requests.push(`${url.pathname}${url.search}`);
    if (path === "/test-page.svg")
      return route.fulfill({
        headers,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#fff9e8"/><text x="100" y="220" font-size="38">Stored page - test fixture</text></svg>',
      });
    expect(request.headers().authorization).toMatch(/^Bearer /);
    if (
      path === "/reading-management/collections" ||
      path === "/reading-management/goals" ||
      path === "/reading-management/reminders" ||
      path === "/reading-management/reminders/due"
    )
      return respond(route, []);
    if (path === "/profiles/me")
      return respond(route, {
        id: ids.parent,
        role: "parent",
        display_name: "Ba mẹ API",
        created_at: timestamp,
      });
    if (path === "/profiles/children")
      return respond(route, state.emptyChildren ? [] : [child]);
    if (path === `/profiles/children/${ids.child}`)
      return respond(route, child);
    if (path.startsWith("/profiles/children/")) return respond(route, {}, 404);
    if (path === "/books/catalog") {
      if (state.catalogStatus !== 200)
        return respond(
          route,
          { detail: "private sql token" },
          state.catalogStatus,
        );
      const search =
        url.searchParams.get("search")?.toLocaleLowerCase("vi") ?? "";
      return respond(
        route,
        state.emptyCatalog ||
          (search &&
            !`${book.title} ${book.author}`
              .toLocaleLowerCase("vi")
              .includes(search))
          ? []
          : [book],
      );
    }
    if (path === `/books/catalog/${ids.book}`) return respond(route, book);
    if (path === `/books/catalog/${ids.book}/preview`)
      return respond(route, [], state.previewStatus);
    if (path.startsWith("/books/catalog/")) return respond(route, {}, 404);
    if (path === "/reading/history")
      return respond(
        route,
        { sessions: [summary], next_cursor: null },
        state.historyStatus,
      );
    if (path === `/reading/history/${ids.session}/book`)
      return respond(route, { ...book, lifecycle_status: "RETIRED" });
    if (path === `/reading/history/${ids.session}`)
      return respond(
        route,
        {
          ...summary,
          selected_page_revision_ids: [],
          reference_page_revision_ids: [],
          events: [],
          fluency_assessment: null,
          comprehension: [],
          report_id: null,
          availability: {
            events: "absent",
            fluency: "absent",
            comprehension: "absent",
          },
        },
        state.historyStatus,
      );
    if (path.startsWith("/reading/history/")) return respond(route, {}, 404);
    const reportPathParts = path.split("/");
    if (
      reportPathParts.length === 5 &&
      reportPathParts[1] === "reading" &&
      reportPathParts[2] === "sessions" &&
      reportPathParts[4] === "reports"
    ) {
      return respond(
        route,
        { session_id: reportPathParts[3], total: 0, reports: [] },
        state.reportStatus,
      );
    }
    if (path.startsWith("/system/progress/") && path.endsWith("/periods"))
      return respond(
        route,
        {
          items: [
            {
              id: ids.session,
              child_id: ids.child,
              period_start: "2026-09-09",
              period_end: "2026-10-08",
              generated_at: timestamp,
            },
          ],
          next_cursor: null,
        },
        state.reportStatus,
      );
    if (path.startsWith("/system/progress/"))
      return respond(
        route,
        {
          id: ids.session,
          generated_at: timestamp,
          legacy: null,
          data_status: "complete",
          availability: {
            metrics: "available",
            difficult_words: "available",
            comparison: "absent",
          },
          child_id: ids.child,
          period_start: url.searchParams.get("period_start") ?? "2026-09-09",
          period_end: url.searchParams.get("period_end") ?? "2026-10-08",
          completed_sessions: 2,
          reading_duration_ms: 120000,
          omission_count: 1,
          repetition_count: 0,
          long_pause_count: 0,
          omission_rate: null,
          repetition_rate: null,
          long_pause_rate: null,
          comprehension_accuracy: null,
          difficult_words: [word],
          previous_period: null,
          trend_deltas: {
            completed_sessions: null,
            reading_duration_ms: null,
            omission_rate: null,
            repetition_rate: null,
            long_pause_rate: null,
            comprehension_accuracy: null,
          },
        },
        state.reportStatus,
      );
    if (path.startsWith("/system/difficult-words/"))
      return respond(route, [word], state.reportStatus);
    if (path === "/books/admin/catalog")
      return respond(
        route,
        [book, ...(state.createdBook ? [state.createdBook] : [])].map(
          (catalogBook) => ({
            book: catalogBook,
            page_count: catalogBook.id === book.id ? 1 : 0,
            processing_count: 0,
            needs_review_count: 0,
            verified_count: catalogBook.id === book.id ? 1 : 0,
            parent_catalog_eligible: catalogBook.id === book.id,
          }),
        ),
      );
    if (
      state.createdBook &&
      path === `/books/admin/catalog/${state.createdBook.id}`
    )
      return respond(route, state.createdBook);
    if (
      state.createdBook &&
      path === `/books/admin/catalog/${state.createdBook.id}/pages`
    )
      return respond(route, []);
    if (path === `/books/admin/catalog/${ids.book}`)
      return respond(route, book);
    if (path === `/books/admin/catalog/${ids.book}/pages`)
      return respond(
        route,
        [{ book_id: ids.book, page_number: 2, processing }],
        state.adminPagesStatus,
      );
    if (path === `/books/admin/pages/${ids.page}/image`)
      return respond(route, {
        page_id: ids.page,
        page_number: 2,
        preview_url: "http://127.0.0.1:8000/test-page.svg",
        width: 800,
        height: 1000,
      });
    if (path === `/books/admin/pages/${ids.page}/revisions`)
      return respond(route, [
        ...(state.draftCreateSourceRevisionId
          ? [
              {
                page_revision_id: ids.draftRevision,
                revision_no: 3,
                verification_status: state.verifyRequest
                  ? "VERIFIED"
                  : "NEEDS_REVIEW",
                created_at: timestamp,
                is_current_verified: Boolean(state.verifyRequest),
              },
            ]
          : []),
        {
          page_revision_id: ids.revision,
          revision_no: 2,
          verification_status: "VERIFIED",
          created_at: timestamp,
          is_current_verified: !state.verifyRequest,
        },
        {
          page_revision_id: ids.oldRevision,
          revision_no: 1,
          verification_status: "VERIFIED",
          created_at: timestamp,
          is_current_verified: false,
        },
      ]);
    if (path.startsWith(`/books/admin/pages/${ids.page}/revisions/`)) {
      if (path.endsWith(ids.draftRevision) && state.draftCreateSourceRevisionId)
        return respond(route, draftDetail());
      const old = path.endsWith(ids.oldRevision);
      return respond(route, {
        ...processing,
        page_revision_id: old ? ids.oldRevision : ids.revision,
        revision_no: old ? 1 : 2,
        draft_text: old ? "Văn bản revision cũ" : "Văn bản đã lưu",
        words: [
          {
            word_index: 0,
            line_index: 0,
            text: "Văn",
            normalized_text: "van",
            bbox: [0.1, 0.2, 0.15, 0.05],
            ocr_confidence: 0.8,
          },
        ],
        ocr_metadata: {},
        created_at: timestamp,
        verified_by: null,
      });
    }
    if (path === "/system/admin/audit-logs")
      return respond(route, {
        items: [
          {
            id: ids.revision,
            actor_id: null,
            resource_id: null,
            request_id: null,
            action: "book.read",
            resource_type: "book",
            created_at: timestamp,
            metadata: {},
          },
        ],
        next_cursor: null,
      });
    if (path === "/system/admin/health")
      return respond(route, {
        overall_status: "HEALTHY",
        checked_at: timestamp,
        services: [
          {
            id: "database",
            label: "Database",
            status: "HEALTHY",
            checked_at: timestamp,
            safe_message: "Database đã phản hồi truy vấn đọc.",
          },
        ],
      });
    state.unexpected.push(`unknown:${path}`);
    return respond(route, {}, 404);
  });
  return state;
}
