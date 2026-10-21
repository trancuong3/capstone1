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

const progress = {
  session_id: sessionId,
  persisted: true,
  start_page_id: pageId,
  end_page_id: pageId,
  current_page_id: pageId,
  start_page_number: 1,
  end_page_number: 1,
  current_page_number: 1,
  current_index: 0,
  total_pages: 1,
  completed_pages: 0,
  pages: [
    {
      page_id: pageId,
      page_revision_id: revisionId,
      page_number: 1,
      page_order: 0,
      status: "IN_PROGRESS",
      started_at: null,
      completed_at: null,
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
  it("persists page selection within the session range before loading content", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(progress))
      .mockResolvedValueOnce(Response.json(page));

    expect(
      await createPageMatchService().selectPage(sessionId, pageId),
    ).toEqual(page);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const navigationUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(navigationUrl.origin).toBe("http://127.0.0.1:8000");
    expect(navigationUrl.pathname).toBe(
      `/reading/sessions/${sessionId}/navigate`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        Accept: "application/json",
      },
      body: JSON.stringify({ target_page_id: pageId }),
    });

    expect(fetchMock.mock.calls[1][0]).toBe(
      `http://127.0.0.1:8000/reading/sessions/${sessionId}/page`,
    );
  });

  it("retries the current session page", async () => {
    fetchMock.mockResolvedValue(Response.json(page));

    expect(await createPageMatchService().retryCurrentPage(sessionId)).toEqual(
      page,
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:8000/reading/sessions/${sessionId}/page`,
    );
  });
});
