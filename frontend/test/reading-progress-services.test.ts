import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReportService } from "@/lib/api/report-service";
import { mapReportMetrics } from "@/lib/utils/report-mappers";
import {
  formatProgressDuration,
  parseProgressPeriod,
  progressHref,
} from "@/lib/utils/progress-report-state";
import {
  progressReportFixture as report,
  TEST_CHILD_ID,
  TEST_FOREIGN_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";

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
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const option = {
  id: report.id,
  child_id: report.child_id,
  period_start: report.period_start,
  period_end: report.period_end,
  generated_at: report.generated_at,
};

describe("Saved progress API adapter", () => {
  it("requests latest without injecting today's dates and uses existing auth", async () => {
    fetchMock.mockResolvedValue(Response.json(report));
    expect(await createReportService().get(TEST_CHILD_ID)).toEqual(report);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:8000/system/progress/${TEST_CHILD_ID}`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer isolated-test-token" },
    });
  });
  it("loads bounded period pages and validates metadata", async () => {
    const page = { items: [option], next_cursor: "page-3" };
    fetchMock.mockResolvedValue(Response.json(page));
    expect(
      await createReportService().listPeriods(TEST_CHILD_ID, {
        cursor: "page-2",
        limit: 2,
      }),
    ).toEqual(page);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/periods?cursor=page-2&limit=2",
    );
  });
  it.each([
    {
      items: [{ ...option, child_id: TEST_FOREIGN_CHILD_ID }],
      next_cursor: null,
    },
    { items: [option, option], next_cursor: null },
    { items: [option], next_cursor: "page-100001" },
    { items: [option], next_cursor: "https://example.test/private" },
  ])("rejects unsafe or inconsistent period metadata", async (page) => {
    fetchMock.mockResolvedValue(Response.json(page));
    await expect(
      createReportService().listPeriods(TEST_CHILD_ID),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
  it("preserves nullable partial data and explicit legacy values", async () => {
    const partial = {
      ...report,
      completed_sessions: null,
      reading_duration_ms: null,
      difficult_words: null,
      legacy: { avg_fluency: 80, total_books: 2 },
      data_status: "partial",
    };
    fetchMock.mockResolvedValue(Response.json(partial));
    const result = await createReportService().get(TEST_CHILD_ID);
    expect(result.completed_sessions).toBeNull();
    expect(result.legacy?.total_books).toBe(2);
    expect(mapReportMetrics(result)[0].value).toBe("Chưa có dữ liệu");
  });
  it.each([404, 403, 501, 503])(
    "does not turn HTTP %s into an empty or zero report",
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json({ detail: "private sql token" }, { status }),
      );
      await expect(
        createReportService().get(TEST_CHILD_ID),
      ).rejects.toMatchObject({ status });
    },
  );
  it("keeps real zero distinct from missing values", () => {
    expect(
      mapReportMetrics({ ...report, completed_sessions: 0 })[0],
    ).toMatchObject({ value: "0 buổi", unavailable: false });
    expect(formatProgressDuration(null)).toBe("Chưa có dữ liệu");
    expect(formatProgressDuration(0)).toBe("0 giây");
  });
});

describe("Progress URL state", () => {
  it("defaults to latest only when neither bound is supplied", () => {
    expect(parseProgressPeriod()).toBeNull();
    expect(parseProgressPeriod("2026-10-01")).toBe("invalid");
  });
  it.each([
    ["2026-02-30", "2026-03-01"],
    ["2026-10-02", "2026-10-01"],
    ["", ""],
    [["2026-10-01"], "2026-10-02"],
  ] as const)("rejects invalid or repeated date params", (start, end) => {
    expect(
      parseProgressPeriod(typeof start === "string" ? start : [...start], end),
    ).toBe("invalid");
  });
  it("accepts a leap-day period and counts dates inclusively", () => {
    expect(parseProgressPeriod("2024-02-29", "2024-03-01")).toMatchObject({
      days: 2,
    });
    expect(progressHref(TEST_CHILD_ID)).toBe(
      `/reports?childId=${TEST_CHILD_ID}`,
    );
  });
});
