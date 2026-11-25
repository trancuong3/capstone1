import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { getSession, initialize, fetchMock } = vi.hoisted(() => ({
  getSession: vi.fn(),
  initialize: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({ auth: { initialize, getSession } }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "https://api.example.com",
}));

import { requestApi } from "@/lib/api/api-client";
import {
  clearApiReadCache,
  setApiReadCacheActorScope,
  setApiReadCacheEnabled,
} from "@/lib/api/read-cache";
import { createSpeechService } from "@/lib/api/speech-service";
import { createVoiceStudioService } from "@/lib/api/voice-studio-service";

const itemSchema = z.object({ id: z.string(), title: z.string() });

describe("coalesced browser auth and bounded user-scoped read cache", () => {
  beforeEach(() => {
    initialize.mockReset().mockResolvedValue({ error: null });
    getSession.mockReset().mockResolvedValue({
      data: { session: { access_token: "token-parent-a" } },
      error: null,
    });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces concurrent auth initialize and getSession calls across apiClient, speechService, and voiceStudioService", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/catalog")) {
        return new Response(JSON.stringify({ id: "1", title: "Book" }), {
          status: 200,
        });
      }
      if (String(url).includes("/voice/voices")) {
        return new Response(
          JSON.stringify({
            voices: [{ voice_id: "local_north_truc_ly", name: "Trúc Ly" }],
            default_voice_id: "local_north_truc_ly",
          }),
          { status: 200 },
        );
      }
      // Use bytes across the Node Response and jsdom Blob boundary.
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });

    await Promise.all([
      requestApi("/catalog/1", itemSchema),
      createVoiceStudioService().listVoices(),
      createSpeechService().synthesize("Xin chào"),
    ]);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("caches eligible GET reads per user and invalidates cleanly on mutation, bypassCache, and user switch", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "2", title: "Updated" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ id: "1", title: "Cached Book" }), {
        status: 200,
      });
    });

    setApiReadCacheEnabled(true);
    setApiReadCacheActorScope("parent-a");
    const first = await requestApi("/catalog/1", itemSchema);
    const second = await requestApi("/catalog/1", itemSchema);
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Switching actor scope must never leak parent-a cache to parent-b
    setApiReadCacheActorScope("parent-b");
    await requestApi("/catalog/1", itemSchema);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Explicit bypassCache refreshes live state
    await requestApi("/catalog/1", itemSchema, undefined, {
      bypassCache: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Mutation clears cached reads
    await requestApi("/catalog/1", itemSchema, undefined, {
      method: "POST",
      body: { title: "New" },
    });
    await requestApi("/catalog/1", itemSchema);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    clearApiReadCache();
  });

  it("maps LOCAL_TTS_*, LOCAL_STT_*, and GOOGLE_* errors to concise Vietnamese with X-Request-ID", async () => {
    const cases = [
      {
        code: "LOCAL_TTS_UNAVAILABLE",
        requestId: "req-tts-unavail-1",
        expectedFragment: "Giọng đọc mẫu đang tạm dừng",
      },
      {
        code: "LOCAL_TTS_TIMEOUT",
        requestId: "req-tts-timeout-2",
        expectedFragment: "quá thời gian chờ",
      },
      {
        code: "LOCAL_TTS_BUSY",
        requestId: "req-tts-busy-3",
        expectedFragment: "đang bận",
      },
      {
        code: "GOOGLE_TTS_UNAVAILABLE",
        requestId: "req-gtts-4",
        expectedFragment: "dự phòng đang tạm bận",
      },
    ];

    for (const testCase of cases) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { code: testCase.code } }), {
          status: 503,
          headers: { "x-request-id": testCase.requestId },
        }),
      );

      await expect(
        createSpeechService().synthesize("Con mèo"),
      ).rejects.toMatchObject({
        code: "TTS_UNAVAILABLE",
        retryable: true,
        request_id: testCase.requestId,
        message: expect.stringContaining(`Mã yêu cầu: ${testCase.requestId}.`),
      });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { code: testCase.code } }), {
          status: 503,
          headers: { "x-request-id": testCase.requestId },
        }),
      );
      try {
        await createSpeechService().synthesize("Con mèo");
      } catch (err) {
        expect((err as Error).message).toContain(testCase.expectedFragment);
      }
    }

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { code: "LOCAL_STT_TIMEOUT" } }), {
        status: 504,
        headers: { "x-request-id": "req-stt-timeout-9" },
      }),
    );
    await expect(
      createSpeechService().transcribe(
        new Blob(["audio"], { type: "audio/wav" }),
      ),
    ).rejects.toMatchObject({
      code: "STT_TIMEOUT",
      retryable: true,
      request_id: "req-stt-timeout-9",
      message: expect.stringContaining("Mã yêu cầu: req-stt-timeout-9."),
    });
  });
});
