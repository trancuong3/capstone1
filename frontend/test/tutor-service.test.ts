// Kept in test/ because the repository ignores new files beneath tests/.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/lib/api/service-error";
import { createTutorService } from "@/lib/api/tutor-service";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({ auth: { getSession } }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "https://api.example",
}));

const sessionId = "77777777-7777-4777-8777-777777777777";
const input = {
  page_revision_id: "55555555-5555-4555-8555-555555555555",
  word_id: "66666666-6666-4666-8666-666666666666",
};
const explanation = {
  ...input,
  word: "nghiêng",
  explanation: "Lệch sang một bên.",
  reading_hint: "Bé đọc lại câu nhé.",
};
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock
    .mockReset()
    .mockResolvedValue(new Response(JSON.stringify(explanation)));
  getSession.mockReset().mockResolvedValue({
    data: { session: { access_token: "isolated-test-token" } },
    error: null,
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Tutor API service", () => {
  it("sends only revision/word IDs with the existing Bearer client and abort signal", async () => {
    const controller = new AbortController();
    await expect(
      createTutorService().explainWord(sessionId, input, controller.signal),
    ).resolves.toEqual(explanation);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example/tutor/sessions/${sessionId}/explain-word`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        signal: controller.signal,
        headers: expect.objectContaining({
          Authorization: "Bearer isolated-test-token",
        }),
        cache: "no-store",
      }),
    );
  });

  it("rejects invalid IDs and client-supplied context before requesting auth or network", async () => {
    const service = createTutorService();
    await expect(service.explainWord("invalid", input)).rejects.toMatchObject({
      status: 422,
    });
    const extraContext = { ...input, prompt: "ignored client context" };
    await expect(
      service.explainWord(sessionId, extraContext),
    ).rejects.toMatchObject({ status: 422 });
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send a request without a session", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(
      createTutorService().explainWord(sessionId, input),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a response associated with another word or revision", async () => {
    for (const field of ["word_id", "page_revision_id"] as const) {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...explanation,
            [field]: "88888888-8888-4888-8888-888888888888",
          }),
        ),
      );
      await expect(
        createTutorService().explainWord(sessionId, input),
      ).rejects.toMatchObject({ status: 409 });
    }
  });

  it("rejects blank, oversized and private response fields", async () => {
    for (const response of [
      { ...explanation, explanation: " " },
      { ...explanation, explanation: "x".repeat(601) },
      { ...explanation, provider_metadata: "private" },
    ]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response)));
      await expect(
        createTutorService().explainWord(sessionId, input),
      ).rejects.toBeInstanceOf(ServiceError);
    }
  });

  it("preserves provider unavailability without reflecting upstream details", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ detail: "private key/model information" }),
        { status: 503 },
      ),
    );
    await expect(
      createTutorService().explainWord(sessionId, input),
    ).rejects.toMatchObject({ status: 503, retryable: true });
  });
});
