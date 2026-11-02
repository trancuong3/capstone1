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

/** Small, structurally valid mono PCM WAV fixture (not text mislabeled as audio). */
function createWavRecording(): Blob {
  const sampleRate = 16_000;
  const sampleCount = 1_600;
  const dataLength = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 4_000,
    );
    view.setInt16(44 + index * 2, sample, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
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
    const recording = createWavRecording();

    await expect(
      createSpeechService().transcribe(recording, {
        filename: "reading.wav",
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
    const uploadedFile = body.get("file") as File;
    expect(uploadedFile).toBeInstanceOf(File);
    expect(uploadedFile.name).toBe("reading.wav");
    expect(uploadedFile.type).toBe("audio/wav");
    expect(uploadedFile.size).toBe(recording.size);
    expect(headersFromCall().has("content-type")).toBe(false);
  });

  it("preserves provider word timestamps for reading alignment", async () => {
    const words = [
      { text: "Con", start: 0.1, end: 0.2, logprob: -0.08 },
      { text: "mèo", start: 0.21, end: 0.4, logprob: -0.12 },
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
      createSpeechService().transcribe(createWavRecording()),
    ).resolves.toMatchObject({ words });
  });

  it("rejects missing or mismatched audio MIME metadata instead of relabeling bytes", async () => {
    await expect(
      createSpeechService().transcribe(new Blob([new Uint8Array([1, 2, 3])])),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createSpeechService().transcribe(createWavRecording(), {
        filename: "recording.webm",
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports invalid recorded audio as a non-retryable validation error", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ detail: { code: "INVALID_AUDIO" } }, { status: 422 }),
    );

    await expect(
      createSpeechService().transcribe(createWavRecording()),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 422,
      retryable: false,
      message: "Đoạn ghi âm không hợp lệ. Bé vui lòng đọc lại để thử lần nữa.",
    });
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
      createSpeechService().transcribe(createWavRecording()),
    ).rejects.toMatchObject({ code: "STT_UNAVAILABLE" });
  });
});
