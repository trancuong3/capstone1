import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "@/lib/api/session-service";
import {
  formatDuration,
  formatHistoryDuration,
  historyPageFromCursor,
  mapSessionHistoryItem,
} from "@/lib/utils/report-mappers";
import {
  bookFixture,
  childFixture,
  sessionDetailFixture,
  sessionSummaryFixture,
  TEST_SESSION_ID,
  TEST_CHILD_ID,
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

describe("History-only read contract", () => {
  it.each([
    "IN_PROGRESS",
    "PAUSED",
    "ABORTED",
    "FINISHED",
    "PAGE_READY",
    "LISTENING",
  ])("accepts %s without changing live reading types", async (state) => {
    fetchMock.mockResolvedValue(
      Response.json({
        sessions: [{ ...sessionSummaryFixture, state }],
        next_cursor: null,
      }),
    );
    expect(
      (await createSessionService().list(TEST_CHILD_ID)).sessions[0].state,
    ).toBe(state);
  });
  it.each(["UNKNOWN", "COMPLETED"])(
    "rejects unmapped public state %s",
    async (state) => {
      fetchMock.mockResolvedValue(
        Response.json({
          sessions: [{ ...sessionSummaryFixture, state }],
          next_cursor: null,
        }),
      );
      await expect(
        createSessionService().list(TEST_CHILD_ID),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    },
  );
  it.each([
    "page-0",
    "page-100001",
    "page-2x",
    "https://external.test",
    "page-01",
  ])("rejects an invalid next cursor %s", async (next_cursor) => {
    fetchMock.mockResolvedValue(Response.json({ sessions: [], next_cursor }));
    await expect(
      createSessionService().list(TEST_CHILD_ID),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
  it.each(["DETECTED", "FEEDBACK_GIVEN", "IGNORED_BY_GATE"])(
    "preserves event status %s without treating it as confirmed",
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json({
          ...sessionDetailFixture,
          events: [
            {
              ...sessionDetailFixture.events[0],
              type: "MISPRONUNCIATION",
              status,
            },
          ],
        }),
      );
      const detail = await createSessionService().get(TEST_SESSION_ID);
      expect(detail.events[0]).toMatchObject({
        type: "MISPRONUNCIATION",
        status,
      });
    },
  );
  it("preserves text difficulty, null source and partial availability", async () => {
    const payload = {
      ...sessionDetailFixture,
      comprehension: [
        {
          question: {
            id: TEST_SESSION_ID,
            type: "FACTUAL",
            prompt: "Câu hỏi đã lưu",
            page_revision_id: bookFixture.id,
            source_span: null,
            difficulty: "EASY",
            answered: false,
          },
          answer: null,
        },
      ],
      availability: {
        events: "available",
        fluency: "unsupported",
        comprehension: "partial",
      },
    };
    fetchMock.mockResolvedValue(Response.json(payload));
    expect(await createSessionService().get(TEST_SESSION_ID)).toEqual(payload);
  });
  it("rejects mismatched event ownership or inverted event times", async () => {
    for (const event of [
      { ...sessionDetailFixture.events[0], session_id: TEST_CHILD_ID },
      { ...sessionDetailFixture.events[0], end_ms: 0 },
    ]) {
      fetchMock.mockResolvedValue(
        Response.json({ ...sessionDetailFixture, events: [event] }),
      );
      await expect(
        createSessionService().get(TEST_SESSION_ID),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    }
  });
  it("does not hide malformed availability behind an empty section", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...sessionDetailFixture,
        availability: { events: "unknown" },
      }),
    );
    await expect(
      createSessionService().get(TEST_SESSION_ID),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
  it("labels completed-without-end honestly and leaves Progress formatting unchanged", () => {
    const item = mapSessionHistoryItem(
      { ...sessionSummaryFixture, ended_at: null, duration_ms: null },
      childFixture,
      bookFixture,
    );
    expect(item.state_label).toBe("Đã hoàn thành");
    expect(item.duration_label).toBe("Chưa có dữ liệu thời lượng");
    expect(formatDuration(null)).toBe("Chưa hoàn tất");
    expect(formatHistoryDuration(0)).toBe("0 giây");
    expect(formatHistoryDuration(90500)).toBe("1 phút 30 giây");
    expect(
      mapSessionHistoryItem(
        { ...sessionSummaryFixture, state: "IN_PROGRESS" },
        childFixture,
        bookFixture,
      ).state_label,
    ).toBe("Đang thực hiện");
  });
  it("uses Vietnam time even across a UTC date boundary", () => {
    const item = mapSessionHistoryItem(
      { ...sessionSummaryFixture, started_at: "2026-10-07T18:30:00Z" },
      childFixture,
      bookFixture,
    );
    expect(item.started_label).toContain("8/10/26");
    expect(item.started_label).toContain("01:30");
  });
  it("accepts only bounded ASCII cursors", () => {
    expect(historyPageFromCursor("page-100000")).toBe(100000);
    expect(historyPageFromCursor("page-1")).toBe(1);
    expect(historyPageFromCursor("page-²")).toBeNull();
  });
});
