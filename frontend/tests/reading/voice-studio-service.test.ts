import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVoiceStudioService } from "@/lib/api/voice-studio-service";

const { getSession, initialize, fetchMock } = vi.hoisted(() => ({
  getSession: vi.fn(),
  initialize: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({ auth: { initialize, getSession } }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

beforeEach(() => {
  initialize.mockReset().mockResolvedValue({ error: null });
  getSession.mockReset().mockResolvedValue({
    data: { session: { access_token: "isolated-test-token" } },
    error: null,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const timedBody = {
  audio_base64: btoa("mp3-bytes"),
  content_type: "audio/mpeg",
  duration_seconds: 1.3,
  words: [
    { index: 0, start: 0, end: 0.4 },
    { index: 1, start: 0.5, end: 0.9 },
  ],
};

describe("voice studio service", () => {
  it("lists the voices with the user's token", async () => {
    fetchMock.mockResolvedValue(
      json({
        voices: [{ voice_id: "v1", name: "Sarah", gender: "female" }],
        default_voice_id: "v1",
      }),
    );

    const list = await createVoiceStudioService().listVoices();

    expect(list.default_voice_id).toBe("v1");
    expect(list.voices[0]?.name).toBe("Sarah");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/voice/voices",
      expect.objectContaining({ method: "GET", credentials: "omit" }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer isolated-test-token");
  });

  it("requests timed speech and decodes the audio and timings", async () => {
    fetchMock.mockResolvedValue(json(timedBody));

    const speech = await createVoiceStudioService().synthesizeTimed(
      ["Bé", "Na"],
      { voiceId: "v1", speed: 0.85 },
    );

    expect(await speech.audio.text()).toBe("mp3-bytes");
    expect(speech.audio.type).toBe("audio/mpeg");
    expect(speech.durationSeconds).toBe(1.3);
    expect(speech.words).toHaveLength(2);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      words: ["Bé", "Na"],
      voice_id: "v1",
      speed: 0.85,
    });
  });

  it("omits the voice when the default is used", async () => {
    fetchMock.mockResolvedValue(json(timedBody));
    await createVoiceStudioService().synthesizeTimed(["Bé", "Na"], {
      voiceId: null,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      words: ["Bé", "Na"],
    });
  });

  it("rejects timings that do not describe every word", async () => {
    fetchMock.mockResolvedValue(json(timedBody));
    await expect(
      createVoiceStudioService().synthesizeTimed(["a", "b", "c"]),
    ).rejects.toBeDefined();
  });

  it("maps backend failures to safe service errors", async () => {
    fetchMock.mockResolvedValue(
      json({ detail: { code: "SPEECH_UNAVAILABLE" } }, 503),
    );
    await expect(
      createVoiceStudioService().synthesizeTimed(["a"]),
    ).rejects.toMatchObject({ code: "TTS_UNAVAILABLE", retryable: true });

    fetchMock.mockResolvedValue(json({}, 401));
    await expect(createVoiceStudioService().listVoices()).rejects.toMatchObject(
      { code: "AUTH_REQUIRED" },
    );
  });
});
