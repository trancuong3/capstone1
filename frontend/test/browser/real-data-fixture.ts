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
  };
  await seedBrowserSession(page);
  const headers = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-allow-methods": "GET,OPTIONS",
  };
  async function respond(route: Route, json: unknown, status = 200) {
    await route.fulfill({
      status,
      headers,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
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
    if (request.method() !== "GET") {
      state.unexpected.push(`write:${request.method()}:${url.pathname}`);
      return respond(route, { detail: "Test forbids writes" }, 405);
    }
    state.requests.push(`${url.pathname}${url.search}`);
    const path = url.pathname;
    if (path === "/test-page.svg")
      return route.fulfill({
        headers,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#fff9e8"/><text x="100" y="220" font-size="38">Stored page - test fixture</text></svg>',
      });
    expect(request.headers().authorization).toMatch(/^Bearer /);
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
        },
        state.historyStatus,
      );
    if (path.startsWith("/reading/history/")) return respond(route, {}, 404);
    if (path.startsWith("/system/progress/"))
      return respond(
        route,
        {
          child_id: ids.child,
          period_start: url.searchParams.get("period_start"),
          period_end: url.searchParams.get("period_end"),
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
      return respond(route, [
        {
          book,
          page_count: 1,
          processing_count: 0,
          needs_review_count: 0,
          verified_count: 1,
          parent_catalog_eligible: true,
        },
      ]);
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
        {
          page_revision_id: ids.revision,
          revision_no: 2,
          verification_status: "VERIFIED",
          created_at: timestamp,
          is_current_verified: true,
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
