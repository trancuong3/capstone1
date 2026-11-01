import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSpeechService } from "@/lib/api/speech-service";

const { getSession, fetchMock } = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({ auth: { getSession } }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue({
    data: { session: { access_token: "isolated-test-token" } },
    error: null,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function headersFromCall(): Headers {
  return fetchMock.mock.calls[0]?.[1]?.headers as Headers;
}

describe("speech service", () => {
  it("keeps ElevenLabs credentials server-side while requesting binary TTS audio", async () => {
    fetchMock.mockResolvedValue(
      new Response("audio-bytes", {
        headers: { "content-type": "audio/mpeg" },
      }),
    );

    const audio = await createSpeechService().synthesize(
      "  Bé đọc cùng mình nhé.  ",
    );

    expect(await audio.text()).toBe("audio-bytes");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/voice/text-to-speech",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "Bé đọc cùng mình nhé." }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      }),
    );
    expect(headersFromCall().get("authorization")).toBe(
      "Bearer isolated-test-token",
    );
    expect(headersFromCall().get("content-type")).toBe("application/json");
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain("ELEVENLABS");
  });

  it("uploads a recorded Blob as FormData and validates the STT response", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        text: "Con mèo đang ngủ.",
        language_code: "vi",
        language_probability: 0.99,
      }),
    );
    const recording = new Blob(["recorded-audio"], { type: "audio/webm" });

    await expect(
      createSpeechService().transcribe(recording, {
        filename: "reading.webm",
        languageCode: "vi",
      }),
    ).resolves.toEqual({
      text: "Con mèo đang ngủ.",
      language_code: "vi",
      language_probability: 0.99,
      words: null,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/voice/speech-to-text",
      expect.objectContaining({ method: "POST" }),
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("language_code")).toBe("vi");
    expect(body.get("file")).toBeTruthy();
    expect(headersFromCall().has("content-type")).toBe(false);
  });

  it("preserves provider word timestamps for reading alignment", async () => {
    const words = [
      { text: "Con", start: 0.1, end: 0.2 },
      { text: "mèo", start: 0.21, end: 0.4 },
    ];
    fetchMock.mockResolvedValue(
      Response.json({
        text: "Con mèo",
        language_code: "vi",
        language_probability: 0.99,
        words,
      }),
    );

    await expect(
      createSpeechService().transcribe(new Blob(["recorded-audio"])),
    ).resolves.toMatchObject({ words });
  });

  it("does not call the API without a browser session", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(
      createSpeechService().synthesize("Xin chào"),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports safe STT and TTS errors without reflecting provider responses", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { detail: "private ElevenLabs quota diagnostic" },
        { status: 503, headers: { "x-request-id": "voice-request" } },
      ),
    );
    await expect(
      createSpeechService().synthesize("Xin chào"),
    ).rejects.toMatchObject({
      code: "TTS_UNAVAILABLE",
      status: 503,
      request_id: "voice-request",
      retryable: true,
    });

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ text: 42 }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      createSpeechService().transcribe(new Blob(["audio"])),
    ).rejects.toMatchObject({ code: "STT_UNAVAILABLE" });
  });
});
