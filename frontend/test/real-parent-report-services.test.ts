import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "@/lib/api/session-service";
import { createReportService } from "@/lib/api/report-service";
import { createDifficultWordService } from "@/lib/api/difficult-word-service";
import { parseHistoryPage } from "@/lib/utils/report-state";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const childId = "22222222-2222-4222-8222-222222222222";
const sessionId = "44444444-4444-4444-8444-444444444444";
const bookId = "33333333-3333-4333-8333-333333333333";
const summary = {
  id: sessionId,
  child_id: childId,
  book_id: bookId,
  state: "ABORTED",
  started_at: "2026-10-08T01:00:00Z",
  ended_at: null,
  duration_ms: null,
};
const detail = {
  ...summary,
  selected_page_revision_ids: [],
  reference_page_revision_ids: [],
  events: [],
  fluency_assessment: null,
  comprehension: [],
  report_id: null,
};
const report = {
  child_id: childId,
  period_start: "2026-09-09",
  period_end: "2026-10-08",
  completed_sessions: 2,
  reading_duration_ms: 120000,
  omission_count: 1,
  repetition_count: 0,
  long_pause_count: 0,
  omission_rate: null,
  repetition_rate: null,
  long_pause_rate: null,
  comprehension_accuracy: null,
  difficult_words: [],
  previous_period: null,
  trend_deltas: {
    completed_sessions: null,
    reading_duration_ms: null,
    omission_rate: null,
    repetition_rate: null,
    long_pause_rate: null,
    comprehension_accuracy: null,
  },
};
const window = {
  period_start: "2026-09-09",
  period_end: "2026-10-08",
  days: 30,
  timezone: "Asia/Ho_Chi_Minh" as const,
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("real Parent report services", () => {
  it("encodes child/cursor/limit and preserves null duration", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ sessions: [summary], next_cursor: "page-3" }),
    );
    const result = await createSessionService().list(childId, {
      cursor: "page-2",
      limit: 2,
    });
    expect(result.sessions[0].duration_ms).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:8000/reading/history?child_id=${childId}&cursor=page-2&limit=2`,
    );
  });
  it("accepts an actual empty history", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ sessions: [], next_cursor: null }),
    );
    expect(await createSessionService().list(childId)).toEqual({
      sessions: [],
      next_cursor: null,
    });
  });
  it("rejects records for a different child", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        sessions: [{ ...summary, child_id: bookId }],
        next_cursor: null,
      }),
    );
    await expect(createSessionService().list(childId)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("rejects legacy session enums instead of remapping", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        sessions: [{ ...summary, state: "COMPLETED" }],
        next_cursor: null,
      }),
    );
    await expect(createSessionService().list(childId)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("keeps optional assessment/report unknown", async () => {
    fetchMock.mockResolvedValue(Response.json(detail));
    expect(await createSessionService().get(sessionId)).toEqual(detail);
  });
  it("rejects a different session detail", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...detail, id: bookId }));
    await expect(createSessionService().get(sessionId)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("loads a retired historical book only through the owned session endpoint", async () => {
    const book = {
      id: bookId,
      title: "Sách lịch sử",
      author: null,
      min_grade: 1,
      max_grade: 3,
      lifecycle_status: "RETIRED",
    };
    fetchMock.mockResolvedValue(Response.json(book));
    expect(await createSessionService().getBook(sessionId)).toEqual(book);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:8000/reading/history/${sessionId}/book`,
    );
  });
  it("reads exact report period without inventing previous metrics", async () => {
    fetchMock.mockResolvedValue(Response.json(report));
    expect(await createReportService().get(childId, window)).toEqual(report);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "period_start=2026-09-09&period_end=2026-10-08",
    );
  });
  it.each([
    { ...report, child_id: bookId },
    { ...report, period_start: "2026-09-01" },
    { avg_fluency: 80, total_books: 2 },
  ])("rejects mismatched or incomplete reports", async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(
      createReportService().get(childId, window),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
  it("reads actual empty word evidence through its scoped endpoint", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    expect(await createDifficultWordService().list(childId, window)).toEqual(
      [],
    );
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/system/difficult-words/${childId}?period_start=`,
    );
  });
  it("does not call a practice API or report fake success", async () => {
    await expect(
      createDifficultWordService().practice(childId, "mèo"),
    ).rejects.toMatchObject({ status: 501, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 501, 503])(
    "preserves safe failure status %i",
    async (status) => {
      fetchMock.mockImplementation(async () =>
        Response.json({ detail: "private sql token" }, { status }),
      );
      await expect(createSessionService().list(childId)).rejects.toMatchObject({
        status,
      });
      await expect(createReportService().get(childId)).rejects.not.toThrow(
        "private sql token",
      );
    },
  );
  it("allows a valid bounded page", () =>
    expect(parseHistoryPage("2")).toBe(2));
});
