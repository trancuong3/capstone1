import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReadingService } from "@/lib/api/reading-service";

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

const eventResponse = {
  Id: "91000000-0000-4000-8000-000000000001",
  SessionId: "92000000-0000-4000-8000-000000000001",
  PageId: "93000000-0000-4000-8000-000000000001",
  PageRevisionId: "94000000-0000-4000-8000-000000000001",
  WordId: "95000000-0000-4000-8000-000000000001",
  Type: "MISPRONUNCIATION",
  StartMs: 1_250,
  EndMs: null,
  Confidence: 0.92,
  Status: "DETECTED",
  Metadata: {
    source: "SEQUENTIAL_READING_ALIGNMENT",
    reason: "CONFIDENTLY_INCORRECT",
    expected_word: "khỏe",
    recognized_word: "khỏ",
    word_index: 2,
  },
  CreatedAt: "2026-11-02T04:00:00.000Z",
};

describe("Reading event persistence", () => {
  it("writes exact session, page revision and word occurrence through the existing event API", async () => {
    fetchMock.mockResolvedValue(Response.json(eventResponse));
    const input = {
      SessionId: eventResponse.SessionId,
      PageId: eventResponse.PageId,
      PageRevisionId: eventResponse.PageRevisionId,
      WordId: eventResponse.WordId,
      Type: "MISPRONUNCIATION" as const,
      StartMs: 1_250,
      EndMs: null,
      Confidence: 0.92,
      Status: "DETECTED" as const,
      Metadata: eventResponse.Metadata,
    };

    await expect(createReadingService().createEvent(input)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8000/reading/events");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer isolated-test-token" },
      body: JSON.stringify(input),
    });
  });

  it("does not treat an ignored-by-gate uncertain event as a confirmed error", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...eventResponse,
        Type: "MISPRONUNCIATION",
        Confidence: null,
        Status: "IGNORED_BY_GATE",
        Metadata: { reason: "NO_SPEECH" },
      }),
    );

    await expect(
      createReadingService().createEvent({
        SessionId: eventResponse.SessionId,
        PageId: eventResponse.PageId,
        PageRevisionId: eventResponse.PageRevisionId,
        WordId: eventResponse.WordId,
        Type: "MISPRONUNCIATION",
        StartMs: 1_250,
        EndMs: null,
        Confidence: null,
        Status: "IGNORED_BY_GATE",
        Metadata: { reason: "NO_SPEECH" },
      }),
    ).resolves.toBeUndefined();
  });
});
