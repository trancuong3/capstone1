import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "@/lib/api/session-service";
import { createReportService } from "@/lib/api/report-service";
import { createDifficultWordService } from "@/lib/api/difficult-word-service";
import {
  apiFetchFixture,
  installApiFetchFixture,
  requestedApiUrl,
} from "@/test/fixtures/api-test-fixture";
import {
  TEST_CHILD_ID,
  TEST_FOREIGN_CHILD_ID,
  TEST_SESSION_ID,
  sessionSummaryFixture,
  sessionDetailFixture,
  progressReportFixture,
  difficultWordFixture,
  reportWindowFixture,
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
beforeEach(() => installApiFetchFixture());
afterEach(() => vi.unstubAllGlobals());

describe("Report/Session real API contracts", () => {
  it("forwards an opaque cursor and preserves server session order", async () => {
    const older = {
      ...sessionSummaryFixture,
      id: "12000000-0000-4000-8000-000000000002",
      started_at: "2026-09-30T00:00:00Z",
      ended_at: "2026-09-30T00:08:00Z",
    };
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({
        sessions: [sessionSummaryFixture, older],
        next_cursor: "opaque & next",
      }),
    );
    const first = await createSessionService().list(TEST_CHILD_ID, {
      limit: 2,
    });
    expect(first.sessions.map((session) => session.id)).toEqual([
      sessionSummaryFixture.id,
      older.id,
    ]);
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({ sessions: [], next_cursor: null }),
    );
    const second = await createSessionService().list(TEST_CHILD_ID, {
      cursor: first.next_cursor ?? undefined,
      limit: 2,
    });
    expect(second).toEqual({ sessions: [], next_cursor: null });
    expect(requestedApiUrl(1).searchParams.get("cursor")).toBe("opaque & next");
    expect(requestedApiUrl(1).searchParams.get("child_id")).toBe(TEST_CHILD_ID);
    expect(requestedApiUrl(1).searchParams.get("limit")).toBe("2");
  });

  it("preserves stored historical revisions and unavailable fluency score", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(sessionDetailFixture));
    const detail = await createSessionService().get(TEST_SESSION_ID);
    expect(detail).toEqual(sessionDetailFixture);
    expect(
      detail.events.every((event) =>
        detail.reference_page_revision_ids.includes(event.page_revision_id),
      ),
    ).toBe(true);
    expect(detail.fluency_assessment).toBeNull();
  });

  it("propagates the same safe 404 for foreign sessions and child reports", async () => {
    apiFetchFixture.mockImplementation(async () =>
      Response.json({ detail: "private account info" }, { status: 404 }),
    );
    await expect(
      createSessionService().get("12000000-0000-4000-8000-000000000002"),
    ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
    await expect(
      createReportService().get(TEST_FOREIGN_CHILD_ID),
    ).rejects.toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND",
      message: "Có lỗi xảy ra. Vui lòng thử lại sau.",
    });
  });

  it("does not manufacture previous metrics or evidence when practice is unavailable", async () => {
    apiFetchFixture
      .mockResolvedValueOnce(Response.json(progressReportFixture))
      .mockResolvedValueOnce(Response.json([difficultWordFixture]));
    const report = await createReportService().get(
      TEST_CHILD_ID,
      reportWindowFixture,
    );
    expect(report.previous_period).toBeNull();
    expect(
      Object.values(report.trend_deltas).every((value) => value === null),
    ).toBe(true);
    const service = createDifficultWordService();
    const words = await service.list(TEST_CHILD_ID, reportWindowFixture);
    expect(words).toEqual([difficultWordFixture]);
    const before = structuredClone(words);
    await expect(
      service.practice(TEST_CHILD_ID, words[0].normalized_word),
    ).rejects.toMatchObject({ status: 501, retryable: false });
    expect(apiFetchFixture).toHaveBeenCalledTimes(2);
    expect(words).toEqual(before);
  });

  it("rejects history for a different child rather than displaying it", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({
        sessions: [
          { ...sessionSummaryFixture, child_id: TEST_FOREIGN_CHILD_ID },
        ],
        next_cursor: null,
      }),
    );
    await expect(
      createSessionService().list(TEST_CHILD_ID),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("rejects session events that belong to a different session", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({
        ...sessionDetailFixture,
        events: [
          {
            ...sessionDetailFixture.events[0],
            session_id: "12000000-0000-4000-8000-000000000002",
          },
        ],
      }),
    );
    await expect(
      createSessionService().get(TEST_SESSION_ID),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("preserves genuinely empty difficult-word data", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json([]));
    expect(await createDifficultWordService().list(TEST_CHILD_ID)).toEqual([]);
  });
});
