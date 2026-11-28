import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechPlayer } from "@/hooks/use-speech-player";
import * as browserAuth from "@/lib/api/browser-auth";
import { buildSpeechServiceError } from "@/lib/api/speech-error";
import type { SpeechService } from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";
import {
  buildPhonicsLesson,
  normalizeAiPhonicsResponse,
} from "@/lib/reading/phonics-lesson";
import {
  lockSessionVoice,
  releaseSessionVoiceLock,
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import {
  clearPinnedBrowserVoices,
  TtsPlayback,
} from "@/lib/reading/tts-playback";
import {
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import {
  getVoicePreloadState,
  preloadReadingVoiceEngines,
  resetVoicePreloaderForTests,
} from "@/lib/reading/voice-preloader";

describe("Grade-1 phonics ALL-CAPS Vietnamese, expanded rhymes, and AI normalization", () => {
  it("supports ALL-CAPS Vietnamese words like TRƯỜNG, HỌC, TỰ, TOÁN, PHAN, QUÝ while still rejecting real acronyms", () => {
    for (const word of ["TRƯỜNG", "HỌC", "TỰ", "TOÁN", "PHAN", "QUÝ", "MỐT"]) {
      const plan = buildPhonicsLesson(word);
      expect(plan.supported, `Expected ${word} to have Grade-1 phonics`).toBe(
        true,
      );
      if (plan.supported) {
        expect(plan.steps.length).toBeGreaterThanOrEqual(2);
        expect(plan.focusSyllable).toBe(word.toLowerCase());
      }
    }

    for (const acronym of ["SGK", "UBND", "TV"]) {
      const plan = buildPhonicsLesson(acronym);
      expect(plan.supported).toBe(false);
      if (!plan.supported) {
        expect(plan.reason).toBe("ACRONYM");
      }
    }
  });

  it("supports expanded valid Vietnamese rhymes (oam, oong, ooc, qu+yu, uyp, uêt)", () => {
    for (const word of ["ngoạm", "xoong", "soóc", "quỵu", "tuýp", "khuệt"]) {
      const plan = buildPhonicsLesson(word);
      expect(plan.supported, `Expected ${word} to be supported`).toBe(true);
    }
  });

  it("normalizes AI phonics responses and strips unsafe TTS symbols from spokenText", () => {
    const plan = normalizeAiPhonicsResponse(
      {
        supported: true,
        source: "ai",
        raw_text: "sô-cô-la",
        clean_phrase: "sô-cô-la",
        syllables: ["sô", "cô", "la"],
        focus_syllable_index: 0,
        focus_syllable: "sô",
        focus_range_start: 0,
        focus_range_end: 2,
        onset: { written: "s", spoken: "sờ" },
        rhyme: {
          written: "ô",
          untoned: "ô",
          nucleus: "ô",
          coda: "",
          spoken: "ô",
        },
        tone: { key: "ngang", label: "thanh ngang", spoken: null },
        steps: [
          {
            id: "onset_blend",
            index: 0,
            kind: "onset_blend",
            display_text: "sờ + ô → sô",
            spoken_text: "sờ + ô → sô",
            highlight_part: "onset_and_rhyme",
            highlight_start: 0,
            highlight_end: 2,
            pause_after_ms: 420,
          },
          {
            id: "whole_syllable",
            index: 1,
            kind: "whole_syllable",
            display_text: "sô",
            spoken_text: "sô.",
            highlight_part: "whole_syllable",
            highlight_start: 0,
            highlight_end: 2,
            pause_after_ms: 480,
          },
        ],
      },
      "sô-cô-la",
    );
    expect(plan).not.toBeNull();
    expect(plan?.source).toBe("ai");
    expect(plan?.steps[0].spokenText).not.toContain("+");
    expect(plan?.steps[0].spokenText).not.toContain("→");
  });
});

describe("Unified voice & speed sync across guidance, reading, phonics, comprehension, and difficult words", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetSpeechPreferencesCache();
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetVoicePreloaderForTests();
    clearPinnedBrowserVoices();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("pins ONE gender-matched Vietnamese browser voice (treating Microsoft An as female and NamMinh as male) across guidance, phonics, comprehension, and difficult words on hosted LOCAL_VOICE_UNCONFIGURED at exact user speed", async () => {
    const spokenUtterances: Array<{
      text: string;
      rate: number;
      voiceName: string | null;
    }> = [];
    const femaleAnVoice = {
      name: "Microsoft An - Vietnamese (Vietnam)",
      voiceURI: "Microsoft An - Vietnamese (Vietnam)",
      lang: "vi-VN",
      localService: true,
      default: true,
    } as SpeechSynthesisVoice;
    const maleNamMinhVoice = {
      name: "Microsoft NamMinh Online (Natural) - Vietnamese (Vietnam)",
      voiceURI: "Microsoft NamMinh",
      lang: "vi-VN",
      localService: false,
      default: false,
    } as SpeechSynthesisVoice;

    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onboundary: ((ev: { charIndex: number }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }

    const speakMock = vi.fn((u: FakeUtterance) => {
      spokenUtterances.push({
        text: u.text,
        rate: u.rate,
        voiceName: u.voice?.name ?? null,
      });
      queueMicrotask(() => {
        u.onstart?.();
        u.onend?.();
      });
    });

    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      speak: speakMock,
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      getVoices: () => [femaleAnVoice, maleNamMinhVoice],
    });

    // Hosted Vercel deployment with default local_only and LOCAL_VOICE_UNCONFIGURED
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: {
        configured: false,
        available: false,
        stt_ready: false,
        tts_ready: false,
        error_code: "LOCAL_VOICE_UNCONFIGURED",
        stt_error_code: "LOCAL_VOICE_UNCONFIGURED",
        tts_error_code: "LOCAL_VOICE_UNCONFIGURED",
      },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    } as never);

    // Child picks MALE teacher voice at speed 0.85
    setSpeechPreferences({
      voiceId: "local_north_thien_minh",
      speed: 0.85,
    });
    lockSessionVoice("sess-hosted-male-sync", {
      voiceId: "local_north_thien_minh",
      speed: 0.85,
      forceUpdate: true,
    });

    const err503 = buildSpeechServiceError({
      capability: "TTS_UNAVAILABLE",
      status: 503,
      providerCode: "LOCAL_VOICE_UNCONFIGURED",
    });
    const speech: SpeechService = {
      synthesize: vi.fn().mockRejectedValue(err503),
      synthesizePhonics: vi.fn().mockRejectedValue(err503),
      transcribe: vi.fn(),
    };
    const studio = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn().mockRejectedValue(err503),
    } as unknown as VoiceStudioService;

    const player = new TtsPlayback(speech, studio);

    // 1. Guidance cue
    await player.play("Không sao hết con ơi!", { coaching: true });
    // 2. Phonics lesson for "tròn" — MUST NOT fail with "Giọng đánh vần đã khóa đang tạm bận"!
    const plan = buildPhonicsLesson("tròn");
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    await player.playPhonicsLesson(plan, { cacheScope: "COACHING" });
    // 3. Comprehension question
    await player.play("Bạn Miu thích làm gì vào buổi sáng?", {
      coaching: true,
    });
    // 4. Difficult word sample
    await player.play("tròn", { wordSample: true });

    // Every single utterance used the EXACT same MALE voice (NamMinh, NOT Microsoft An!)
    // and the EXACT user-chosen speed 0.85!
    expect(spokenUtterances.length).toBe(3 + plan.steps.length);
    for (const utt of spokenUtterances) {
      expect(utt.voiceName).toBe(maleNamMinhVoice.name);
      expect(utt.rate).toBe(0.85);
    }

    // Now user explicitly switches to FEMALE voice at speed 1.05
    setSpeechPreferences({
      voiceId: "local_north_truc_ly",
      speed: 1.05,
    });
    lockSessionVoice("sess-hosted-male-sync", {
      voiceId: "local_north_truc_ly",
      speed: 1.05,
      forceUpdate: true,
    });
    player.handlePreferencesChange();
    spokenUtterances.length = 0;

    await player.play("Con đọc giỏi lắm!", { coaching: true });
    expect(spokenUtterances).toHaveLength(1);
    expect(spokenUtterances[0].voiceName).toBe(femaleAnVoice.name);
    expect(spokenUtterances[0].rate).toBe(1.05);

    releaseSessionVoiceLock("sess-hosted-male-sync");
    player.dispose();
  });

  it("spells every phonics step sequentially via speech.synthesize in the exact locked voice when /phonics transiently fails on a live server", async () => {
    class FakeAudio {
      src = "";
      preload = "";
      playbackRate = 1;
      defaultPlaybackRate = 1;
      preservesPitch = true;
      currentTime = 0;
      duration = 0.25;
      paused = true;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onloadedmetadata: (() => void) | null = null;
      play = vi.fn(async () => {
        this.paused = false;
        queueMicrotask(() => {
          this.onloadedmetadata?.();
          this.onended?.();
        });
      });
      pause = vi.fn();
      removeAttribute = vi.fn();
      load = vi.fn();
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:step-audio"),
      revokeObjectURL: vi.fn(),
    });

    setSpeechPreferences({ voiceId: "local_south_thuc_doan", speed: 0.95 });
    lockSessionVoice("sess-live-phonics-fallback", {
      voiceId: "local_south_thuc_doan",
      speed: 0.95,
      forceUpdate: true,
    });

    const speech: SpeechService = {
      synthesizePhonics: vi
        .fn()
        .mockRejectedValueOnce(new Error("phonics endpoint 500")),
      synthesize: vi
        .fn()
        .mockResolvedValue(new Blob(["wav"], { type: "audio/wav" })),
      transcribe: vi.fn(),
    };
    const studio = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn(),
    } as unknown as VoiceStudioService;

    const plan = buildPhonicsLesson("tròn");
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;

    const stepIndices: number[] = [];
    const player = new TtsPlayback(speech, studio);
    await player.playPhonicsLesson(plan, {
      onStepChange: (idx) => stepIndices.push(idx),
    });

    expect(speech.synthesize).toHaveBeenCalledTimes(plan.steps.length);
    for (const call of vi.mocked(speech.synthesize).mock.calls) {
      expect(call[1]).toMatchObject({
        voiceId: "local_south_thuc_doan",
        speed: 0.95,
        wordSample: true,
      });
    }
    expect(stepIndices).toEqual(plan.steps.map((s) => s.index));

    releaseSessionVoiceLock("sess-live-phonics-fallback");
    player.dispose();
  });

  it("preloads voice engines cleanly and updates reactive preload state", async () => {
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: {
        configured: true,
        available: true,
        stt_ready: true,
        tts_ready: true,
      },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    } as never);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            default_mode: "local_only",
            default_voice_id: "local_north_truc_ly",
            local: {
              configured: true,
              available: true,
              stt_ready: true,
              tts_ready: true,
            },
            google: {
              stt_configured: false,
              tts_configured: false,
              stt_cooldown: false,
              tts_cooldown: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await preloadReadingVoiceEngines({ warmTts: false });
    const snap = getVoicePreloadState();
    expect(snap.sttStatus).toBe("ready");
    expect(snap.ttsStatus).toBe("ready");
    expect(snap.startedAt).not.toBeNull();
  });

  it("does not probe /voice/text-to-speech when local TTS is unavailable during initial or concurrent preload", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://127.0.0.1:8000");
    vi.spyOn(browserAuth, "getBrowserAccessToken").mockResolvedValue(
      "test-access-token",
    );

    const voiceChangeListeners: Array<() => void> = [];
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [],
      addEventListener: (_event: string, listener: () => void) => {
        voiceChangeListeners.push(listener);
      },
      removeEventListener: vi.fn(),
    });

    const ttsBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/voice/status")) {
          return new Response(
            JSON.stringify({
              default_mode: "local_only",
              default_voice_id: "local_north_truc_ly",
              local: {
                available: false,
                stt_ready: false,
                tts_ready: false,
              },
              google: {
                stt_configured: false,
                tts_configured: false,
                stt_cooldown: false,
                tts_cooldown: false,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/voice/text-to-speech")) {
          ttsBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(
            JSON.stringify({ detail: { code: "LOCAL_TTS_UNAVAILABLE" } }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }),
    );

    const firstPreload = preloadReadingVoiceEngines();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    // Second call arrives while first preload is still waiting on browser voices
    const secondPreload = preloadReadingVoiceEngines({
      previewWords: ["Bé", "mèo"],
    });
    voiceChangeListeners.forEach((listener) => listener());
    await Promise.all([firstPreload, secondPreload]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ttsBodies).toEqual([]);
  });

  it("normalizes and deduplicates preloaded preview words and uses the active session lock speed", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://127.0.0.1:8000");
    vi.spyOn(browserAuth, "getBrowserAccessToken").mockResolvedValue(
      "test-access-token",
    );

    setSpeechPreferences({
      voiceId: "local_north_truc_ly",
      speed: 1.0,
    });
    lockSessionVoice("sess-preload-norm", {
      voiceId: "local_north_truc_ly",
      speed: 0.75,
      forceUpdate: true,
    });

    const ttsPayloads: Array<{
      text: string;
      speed?: number;
      voice_id?: string;
      word_sample?: boolean;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/voice/status")) {
          return new Response(
            JSON.stringify({
              default_mode: "local_only",
              default_voice_id: "local_north_truc_ly",
              local: {
                configured: true,
                available: true,
                stt_ready: true,
                tts_ready: true,
              },
              google: {
                stt_configured: false,
                tts_configured: false,
                stt_cooldown: false,
                tts_cooldown: false,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/voice/text-to-speech")) {
          ttsPayloads.push(JSON.parse(String(init?.body ?? "{}")));
          // Use bytes across the Node Response and jsdom Blob boundary.
          return new Response(new Uint8Array([82, 73, 70, 70, 119, 97, 118]), {
            status: 200,
            headers: { "Content-Type": "audio/wav" },
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }),
    );

    await preloadReadingVoiceEngines({
      previewWords: ["Bé", "mẹ.", "mèo", "Bé"],
    });
    await vi.waitFor(() => {
      expect(ttsPayloads).toHaveLength(4);
    });

    expect(ttsPayloads[0]).toMatchObject({
      text: "Đến lượt con đọc nhé.",
      voice_id: "local_north_truc_ly",
      speed: 0.75,
    });
    expect(ttsPayloads[0]?.word_sample).toBeUndefined();
    expect(
      ttsPayloads.slice(1).map((payload) => ({
        text: payload.text,
        voice_id: payload.voice_id,
        speed: payload.speed,
        word_sample: payload.word_sample,
      })),
    ).toEqual([
      {
        text: "bé",
        voice_id: "local_north_truc_ly",
        speed: 0.75,
        word_sample: true,
      },
      {
        text: "mẹ",
        voice_id: "local_north_truc_ly",
        speed: 0.75,
        word_sample: true,
      },
      {
        text: "mèo",
        voice_id: "local_north_truc_ly",
        speed: 0.75,
        word_sample: true,
      },
    ]);

    releaseSessionVoiceLock("sess-preload-norm");
  });

  it("exposes useSpeechPlayer cleanly without crashing", () => {
    const { result } = renderHook(() => useSpeechPlayer());
    expect(result.current.state).toBe("idle");
    act(() => result.current.stop());
  });
});
