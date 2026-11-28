import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import {
  createVoiceStudioService,
  type VoiceStudioService,
} from "@/lib/api/voice-studio-service";
import { buildPhonicsLesson } from "@/lib/reading/phonics-lesson";
import * as ttsAudioCache from "@/lib/reading/tts-audio-cache";
import { TtsPlayback } from "@/lib/reading/tts-playback";

vi.mock("@/lib/api/browser-auth", () => ({
  getBrowserAccessToken: vi.fn(async () => "ephemeral-test-token"),
  invalidateBrowserTokenCache: vi.fn(),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

function makeTinyWavBase64(): string {
  // Minimal 44-byte RIFF WAV header + 4 PCM bytes
  const bytes = new Uint8Array(48);
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      bytes[offset + i] = str.charCodeAt(i);
    }
  };
  writeAscii(0, "RIFF");
  new DataView(bytes.buffer).setUint32(4, 40, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  new DataView(bytes.buffer).setUint32(16, 16, true);
  new DataView(bytes.buffer).setUint16(20, 1, true);
  new DataView(bytes.buffer).setUint16(22, 1, true);
  new DataView(bytes.buffer).setUint32(24, 16000, true);
  new DataView(bytes.buffer).setUint32(28, 32000, true);
  new DataView(bytes.buffer).setUint16(32, 2, true);
  new DataView(bytes.buffer).setUint16(34, 16, true);
  writeAscii(36, "data");
  new DataView(bytes.buffer).setUint32(40, 4, true);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("Ephemeral TTS Cache Isolation ('chơi xong rồi xóa')", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    if (typeof globalThis.indexedDB === "undefined") {
      vi.stubGlobal("indexedDB", {});
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("speechService.synthesize with ephemeral: true skips IndexedDB read/write and omits cache_scope & book refs", async () => {
    const getCacheSpy = vi
      .spyOn(ttsAudioCache, "getCachedTtsAudio")
      .mockResolvedValue(new Blob(["cached"], { type: "audio/mpeg" }));
    const putCacheSpy = vi
      .spyOn(ttsAudioCache, "putCachedTtsAudio")
      .mockResolvedValue(false);

    fetchMock.mockResolvedValue(
      new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "public, max-age=86400",
          "X-TTS-Scope": "CATALOG",
        },
      }),
    );

    const service = createSpeechService();
    const blob = await service.synthesize(
      "Đèn ông sao tỏa sáng lung linh trên bầu trời đêm.",
      {
        ephemeral: true,
        bookId: "11000000-0000-4000-8000-000000000001",
        pageId: "11000000-0000-4000-8000-000000000002",
        pageRevisionId: "11000000-0000-4000-8000-000000000003",
        cacheScope: "CATALOG",
      },
    );

    expect(blob.size).toBeGreaterThan(0);
    expect(getCacheSpy).not.toHaveBeenCalled();
    expect(putCacheSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body));
    expect(sentBody.text).toBe(
      "Đèn ông sao tỏa sáng lung linh trên bầu trời đêm.",
    );
    expect(sentBody.cache_scope).toBeUndefined();
    expect(sentBody.book_id).toBeUndefined();
    expect(sentBody.page_id).toBeUndefined();
    expect(sentBody.page_revision_id).toBeUndefined();
  });

  it("speechService.synthesizePhonics with ephemeral: true skips IndexedDB phonics cache and omits cache_scope & book refs", async () => {
    const getPhonicsSpy = vi
      .spyOn(ttsAudioCache, "getCachedPhonicsTts")
      .mockResolvedValue(null);
    const putPhonicsSpy = vi
      .spyOn(ttsAudioCache, "putCachedPhonicsTts")
      .mockResolvedValue(false);

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          audio_base64: makeTinyWavBase64(),
          content_type: "audio/wav",
          duration_seconds: 0.5,
          step_timings: [{ id: "step-1", index: 0, start: 0, end: 0.5 }],
          provider: "local",
          resolved_voice_id: "vi_female_north",
          region: "north",
          model_version: "v1",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=86400",
          },
        },
      ),
    );

    const service = createSpeechService();
    const res = await service.synthesizePhonics!(
      [{ id: "step-1", spokenText: "lung", pauseAfterMs: 300 }],
      {
        ephemeral: true,
        bookId: "11000000-0000-4000-8000-000000000001",
        cacheScope: "COACHING",
      },
    );

    expect(res.audio.size).toBeGreaterThan(0);
    expect(getPhonicsSpy).not.toHaveBeenCalled();
    expect(putPhonicsSpy).not.toHaveBeenCalled();

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body));
    expect(sentBody.cache_scope).toBeUndefined();
    expect(sentBody.book_id).toBeUndefined();
  });

  it("voiceStudioService.synthesizeTimed with ephemeral: true skips IndexedDB timed cache and omits cache_scope & book refs", async () => {
    const getTimedSpy = vi
      .spyOn(ttsAudioCache, "getCachedTimedTts")
      .mockResolvedValue(null);
    const putTimedSpy = vi
      .spyOn(ttsAudioCache, "putCachedTimedTts")
      .mockResolvedValue(false);

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          audio_base64: makeTinyWavBase64(),
          content_type: "audio/wav",
          duration_seconds: 0.6,
          words: [
            { index: 0, start: 0, end: 0.3 },
            { index: 1, start: 0.3, end: 0.6 },
          ],
          provider: "local",
          resolved_voice_id: "vi_female_north",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=86400",
          },
        },
      ),
    );

    const studio = createVoiceStudioService();
    const res = await studio.synthesizeTimed(["lung", "linh"], {
      ephemeral: true,
      bookId: "11000000-0000-4000-8000-000000000001",
      cacheScope: "CATALOG",
    });

    expect(res.words).toHaveLength(2);
    expect(getTimedSpy).not.toHaveBeenCalled();
    expect(putTimedSpy).not.toHaveBeenCalled();

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body));
    expect(sentBody.cache_scope).toBeUndefined();
    expect(sentBody.book_id).toBeUndefined();
  });

  it("TtsPlayback propagates ephemeral: true, skips prefetch, and avoids retaining shortCache / phonicsCache entries", async () => {
    const synthesizeSpy = vi.fn<SpeechService["synthesize"]>(
      async () =>
        new Blob([Uint8Array.from([1, 2, 3, 4])], { type: "audio/wav" }),
    );
    const synthesizePhonicsSpy = vi.fn<
      NonNullable<SpeechService["synthesizePhonics"]>
    >(async (steps) => ({
      audio: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: "audio/wav" }),
      durationSeconds: 0.4,
      stepTimings: steps.map((s, idx) => ({
        id: s.id,
        index: idx,
        start: idx * 0.1,
        end: (idx + 1) * 0.1,
      })),
      provider: "local",
      resolvedVoiceId: "vi_female_north",
      region: "north",
      modelVersion: "v1",
    }));

    const mockSpeech: SpeechService = {
      synthesize: synthesizeSpy,
      synthesizePhonics: synthesizePhonicsSpy,
      transcribe: vi.fn(),
    };
    const mockStudio: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn(),
    };

    const playback = new TtsPlayback(mockSpeech, mockStudio);
    // Stub internal audio playback element so TtsPlayback resolves deterministically in jsdom
    vi.spyOn(
      playback as unknown as {
        playAudio: () => Promise<number>;
      },
      "playAudio",
    ).mockResolvedValue(0.25);

    // 1. Ephemeral prefetch is a strict no-op
    await playback.prefetch("Câu chuyện phép thuật tạm thời.", {
      ephemeral: true,
      coaching: true,
    });
    expect(synthesizeSpy).not.toHaveBeenCalled();

    // 2. Ephemeral play forwards { ephemeral: true } with zero cacheScope/bookId, and does not cache in shortCache
    await playback.play("Câu chuyện phép thuật tạm thời.", {
      ephemeral: true,
      coaching: true,
      bookId: "book-should-be-omitted",
      cacheScope: "COACHING",
    });
    await playback.play("Câu chuyện phép thuật tạm thời.", {
      ephemeral: true,
      coaching: true,
      bookId: "book-should-be-omitted",
      cacheScope: "COACHING",
    });
    expect(synthesizeSpy).toHaveBeenCalledTimes(2);
    expect(synthesizeSpy.mock.calls[0]?.[1]).toMatchObject({
      ephemeral: true,
    });
    expect(synthesizeSpy.mock.calls[0]?.[1]?.cacheScope).toBeUndefined();
    expect(synthesizeSpy.mock.calls[0]?.[1]?.bookId).toBeUndefined();

    // 3. Ephemeral playPhonicsLesson forwards { ephemeral: true } and does not retain phonicsCache
    const lesson = buildPhonicsLesson("lung linh");
    expect(lesson.supported).toBe(true);
    if (lesson.supported) {
      await playback.playPhonicsLesson(lesson, {
        ephemeral: true,
        bookId: "book-should-be-omitted",
        cacheScope: "COACHING",
      });
      await playback.playPhonicsLesson(lesson, {
        ephemeral: true,
        bookId: "book-should-be-omitted",
        cacheScope: "COACHING",
      });
      expect(synthesizePhonicsSpy).toHaveBeenCalledTimes(2);
      expect(synthesizePhonicsSpy.mock.calls[0]?.[1]).toMatchObject({
        ephemeral: true,
      });
      expect(
        synthesizePhonicsSpy.mock.calls[0]?.[1]?.cacheScope,
      ).toBeUndefined();
      expect(synthesizePhonicsSpy.mock.calls[0]?.[1]?.bookId).toBeUndefined();
    }

    playback.dispose();
  });
});
