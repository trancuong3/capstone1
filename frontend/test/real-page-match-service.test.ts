import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageMatchService } from "@/lib/api/page-match-service";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const sessionId = "11111111-1111-4111-8111-111111111111";
const pageId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const wordId = "44444444-4444-4444-8444-444444444444";

const page = {
  page_id: pageId,
  page_revision_id: revisionId,
  page_number: 1,
  confidence: 0.91,
  width: 600,
  height: 800,
  image_url: null,
  text: "Chú mèo",
  words: [
    {
      word_id: wordId,
      word_index: 0,
      text: "Chú",
      bbox: [0.1, 0.2, 0.12, 0.04],
    },
  ],
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("real PageMatchService", () => {
  it("scopes selected page requests to the existing reading session", async () => {
      fetchMock.mockResolvedValue(Response.json(page));

      expect(
        await createPageMatchService().selectPage(sessionId, pageId),
      ).toEqual(page);

      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.origin).toBe("http://127.0.0.1:8000");
      expect(url.pathname).toBe(`/reading/pages/${pageId}`);
      expect(url.searchParams.get("session_id")).toBe(sessionId);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        method: "GET",
        headers: {
          Authorization: "Bearer test-token",
          Accept: "application/json",
        },
      });
  });

  it("uses the session-bound current page endpoint when retrying", async () => {
    fetchMock.mockResolvedValue(Response.json(page));

    expect(
      await createPageMatchService().retryCurrentPage(sessionId),
    ).toEqual(page);

    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:8000/reading/sessions/${sessionId}/page`,
    );
  });
});
