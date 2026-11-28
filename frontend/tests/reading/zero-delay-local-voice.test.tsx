import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechService } from "@/lib/api/speech-service";
import type {
  TimedSpeech,
  VoiceStudioService,
} from "@/lib/api/voice-studio-service";
import { resetBrowserWasmTtsForTests } from "@/lib/reading/browser-wasm-tts";
import { buildPhonicsLesson } from "@/lib/reading/phonics-lesson";
import {
  clearSessionDeviceTransports,
  getSessionDeviceTransport,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import {
  FEMALE_VOICE_PREVIEW_TEXT,
  fetchStaticVoicePreviewBlob,
  isStaticVoicePreviewEnabled,
  MALE_VOICE_PREVIEW_TEXT,
  resetStaticVoicePreviewsForTests,
  resolveStaticVoicePreview,
  setStaticVoicePreviewEnabledForTests,
  STATIC_VOICE_PREVIEWS,
  warmStaticVoicePreview,
} from "@/lib/reading/static-voice-previews";
import { setSynthesizedAudioMeta } from "@/lib/reading/synthesized-audio-meta";
import {
  computeEffectivePlaybackRate,
  TtsPlayback,
} from "@/lib/reading/tts-playback";
import {
  getVoiceEngineStatus,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
  type VoiceEngineHealthSnapshot,
} from "@/lib/reading/voice-engine-status";
import {
  resetVoicePreloaderForTests,
  shouldWarmWasmTts,
  warmWasmTtsIfNeeded,
} from "@/lib/reading/voice-preloader";

function buildFakeWavBuffer(
  sampleRate = 22050,
  durationSec = 0.4,
): ArrayBuffer {
  const numSamples = Math.round(sampleRate * durationSec);
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      view.setUint8(off + i, s.charCodeAt(i));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
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
  view.setUint32(40, dataBytes, true);
  return buf;
}

class MockWasmTtsWorker {
  static instances: MockWasmTtsWorker[] = [];
  static synthesizedPayloads: Array<{
    text: string;
    gender: string;
    speed: number;
  }> = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  activeGender = "female";

  constructor() {
    MockWasmTtsWorker.instances.push(this);
  }

  postMessage(msg: {
    type: string;
    id: string;
    gender?: string;
    text?: string;
    speed?: number;
  }) {
    queueMicrotask(() => {
      if (msg.type === "init") {
        this.activeGender = msg.gender ?? "female";
        this.onmessage?.({
          data: {
            type: "ready",
            id: msg.id,
            gender: this.activeGender,
            modelVersion: "test-wasm-v1",
          },
        } as MessageEvent);
      } else if (msg.type === "synthesize") {
        const text = msg.text ?? "";
        const gender = msg.gender ?? this.activeGender;
        MockWasmTtsWorker.synthesizedPayloads.push({
          text,
          gender,
          speed: msg.speed ?? 1,
        });
        const wav = buildFakeWavBuffer(22050, 0.4);
        this.onmessage?.({
          data: {
            type: "result",
            id: msg.id,
            wavBuffer: wav,
            sampleRate: 22050,
            durationSeconds: 0.4,
            gender,
            synthMs: 12,
          },
        } as MessageEvent);
      }
    });
  }

  terminate() {}
}

class MockAudioElement {
  static instances: MockAudioElement[] = [];
  static nextDuration = 5.5;
  duration = MockAudioElement.nextDuration;
  currentTime = 0;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  preservesPitch = true;
  volume = 1;
  src = "";
  paused = true;
  ended = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onpause: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  onstalled: (() => void) | null = null;
  onwaiting: (() => void) | null = null;

  constructor(src = "") {
    this.src = src;
    MockAudioElement.instances.push(this);
  }

  play = vi.fn(async () => {
    this.paused = false;
    setTimeout(() => {
      if (this.paused || this.ended) return;
      this.onloadedmetadata?.();
      this.currentTime = 0.25;
      this.ontimeupdate?.();
    }, 5);
    setTimeout(() => {
      if (this.paused || this.ended) return;
      this.currentTime = 2.1;
      this.ontimeupdate?.();
    }, 15);
    setTimeout(() => {
      if (this.paused || this.ended) return;
      this.currentTime = this.duration;
      this.ended = true;
      this.paused = true;
      this.onended?.();
    }, 30);
  });

  pause = vi.fn(() => {
    this.paused = true;
  });
}

const OFFLINE_LOCAL_HEALTH: VoiceEngineHealthSnapshot = {
  default_mode: "local_only",
  default_voice_id: "local_north_truc_ly",
  local: {
    configured: true,
    mode: "http",
    available: false,
    stt_ready: false,
    tts_ready: false,
    error_code: "LOCAL_VOICE_UNAVAILABLE",
    tts_error_code: "LOCAL_TTS_UNAVAILABLE",
  },
  google: {
    stt_configured: false,
    tts_configured: false,
    stt_cooldown: false,
    tts_cooldown: false,
  },
};

const HEALTHY_LOCAL_HEALTH: VoiceEngineHealthSnapshot = {
  default_mode: "local_only",
  default_voice_id: "local_north_truc_ly",
  local: {
    configured: true,
    mode: "http",
    available: true,
    stt_ready: true,
    tts_ready: true,
    error_code: null,
    tts_error_code: null,
  },
  google: {
    stt_configured: false,
    tts_configured: false,
    stt_cooldown: false,
    tts_cooldown: false,
  },
};

describe("Zero-delay local voice previews, speed-invariant caches & dead-worker fast-skip", () => {
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetVoiceEngineStatus();
    resetVoiceLockAndPolicyForTests();
    resetSpeechPreferencesCache();
    resetBrowserWasmTtsForTests();
    resetVoicePreloaderForTests();
    resetStaticVoicePreviewsForTests();
    clearSessionDeviceTransports();
    MockWasmTtsWorker.instances = [];
    MockWasmTtsWorker.synthesizedPayloads = [];
    MockAudioElement.instances = [];
    MockAudioElement.nextDuration = 5.5;
    vi.stubGlobal("Audio", MockAudioElement);
    URL.createObjectURL = vi.fn(() => "blob:zero-delay-audio");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    resetStaticVoicePreviewsForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
  });

  it("exports all 16 precomputed VieNeu preview entries with 17-word timings and disables interception by default in NODE_ENV=test", async () => {
    expect(STATIC_VOICE_PREVIEWS).toHaveLength(16);
    for (const entry of STATIC_VOICE_PREVIEWS) {
      expect(entry.cachedSpeed).toBe(0.9);
      expect(entry.durationSeconds).toBeGreaterThan(3.5);
      expect(entry.words).toHaveLength(17);
      expect(entry.words[0]?.index).toBe(0);
      expect(entry.words[16]?.index).toBe(16);
    }

    // Default test-env guard keeps existing JSDOM timeout tests untouched
    expect(isStaticVoicePreviewEnabled()).toBe(false);
    setStaticVoicePreviewEnabledForTests(true);
    expect(isStaticVoicePreviewEnabled()).toBe(true);

    // Matches NFD input by normalizing to NFC
    const matched = resolveStaticVoicePreview(
      "local_south_thuc_doan",
      FEMALE_VOICE_PREVIEW_TEXT.normalize("NFD"),
    );
    expect(matched?.url).toBe(
      "/audio/voice-previews/local_south_thuc_doan__female.mp3",
    );

    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      warmStaticVoicePreview(
        "local_south_thuc_doan",
        FEMALE_VOICE_PREVIEW_TEXT,
      ),
    ).resolves.toBe(true);
    const secondBlob = await fetchStaticVoicePreviewBlob(matched!);
    expect(secondBlob?.type).toBe("audio/mpeg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("plays static VieNeu previews in 0ms when local worker is offline in both play() and playWithWordTimings() across 0.85x and 1.15x", async () => {
    vi.useFakeTimers();
    setStaticVoicePreviewEnabledForTests(true);
    setCachedVoiceEngineHealth(OFFLINE_LOCAL_HEALTH);
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleTtsFallback: false,
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const speechMock: SpeechService = {
      synthesize: vi.fn().mockRejectedValue(new Error("should-not-call")),
      transcribe: vi.fn(),
    };
    const studioMock: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn().mockRejectedValue(new Error("should-not-call")),
    };
    const player = new TtsPlayback(speechMock, studioMock);

    // 1. play() at 0.85x -> starts immediately at 0ms without calling speech.synthesize
    setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 0.85 });
    let playStarted = false;
    const p1 = player.play(FEMALE_VOICE_PREVIEW_TEXT, {
      coaching: true,
      cacheScope: "COACHING",
      bypassSessionLock: true,
      utteranceKind: "voice_preview",
      onPlay: () => {
        playStarted = true;
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(playStarted).toBe(true);
    expect(MockAudioElement.instances).toHaveLength(1);
    expect(MockAudioElement.instances[0]!.playbackRate).toBeCloseTo(
      computeEffectivePlaybackRate(0.85, 0.9),
      5,
    );
    expect(getVoiceEngineStatus().tts.tier).toBe("local_offline");
    expect(getVoiceEngineStatus().tts.provider).toBe("local");
    await vi.advanceTimersByTimeAsync(40);
    await p1;
    expect(speechMock.synthesize).not.toHaveBeenCalled();

    // 2. playWithWordTimings() at 1.15x -> starts at 0ms with 17-word highlights & zero fallback calls
    setSpeechPreferences({ voiceId: "local_south_thai_son", speed: 1.15 });
    const highlightedWords: number[] = [];
    const fallbackSpy = vi.fn(async () => undefined);
    const words = MALE_VOICE_PREVIEW_TEXT.split(" ");
    expect(words).toHaveLength(17);

    const p2 = player.playWithWordTimings(
      words,
      {
        text: MALE_VOICE_PREVIEW_TEXT,
        cacheScope: "COACHING",
        bypassSessionLock: true,
        utteranceKind: "voice_preview",
        onWordChange: (idx) => highlightedWords.push(idx),
      },
      fallbackSpy,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(MockAudioElement.instances).toHaveLength(2);
    expect(MockAudioElement.instances[1]!.playbackRate).toBeCloseTo(
      computeEffectivePlaybackRate(1.15, 0.9),
      5,
    );
    await vi.advanceTimersByTimeAsync(40);
    await p2;

    expect(studioMock.synthesizeTimed).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(highlightedWords.length).toBeGreaterThan(0);
    expect(highlightedWords.every((idx) => idx >= 0 && idx < 17)).toBe(true);
    expect(getVoiceEngineStatus().tts.tier).toBe("local_offline");
  });

  it("races backend synthesis against 80ms static VieNeu fallback when health is healthy/null across 0.85x and 1.15x and swallows late rejections", async () => {
    vi.useFakeTimers();
    setStaticVoicePreviewEnabledForTests(true);
    setCachedVoiceEngineHealth(HEALTHY_LOCAL_HEALTH);

    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let rejectLateShort!: (err: Error) => void;
    let rejectLateTimed!: (err: Error) => void;
    const speechMock: SpeechService = {
      synthesize: vi.fn(
        () =>
          new Promise<Blob>((_resolve, reject) => {
            rejectLateShort = reject;
          }),
      ),
      transcribe: vi.fn(),
    };
    const studioMock: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn(
        () =>
          new Promise<TimedSpeech>((_resolve, reject) => {
            rejectLateTimed = reject;
          }),
      ),
    };
    const player = new TtsPlayback(speechMock, studioMock);

    // 1. play() at 0.85x with slow backend -> wins at 80ms!
    setSpeechPreferences({ voiceId: "local_central_ngoc_tran", speed: 0.85 });
    const shortPromise = player.play(FEMALE_VOICE_PREVIEW_TEXT, {
      coaching: true,
      cacheScope: "COACHING",
      bypassSessionLock: true,
      utteranceKind: "voice_preview",
    });

    await vi.advanceTimersByTimeAsync(75);
    expect(speechMock.synthesize).toHaveBeenCalledTimes(1);
    expect(MockAudioElement.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);
    expect(MockAudioElement.instances).toHaveLength(1);
    expect(MockAudioElement.instances[0]!.playbackRate).toBeCloseTo(
      computeEffectivePlaybackRate(0.85, 0.9),
      5,
    );
    expect(getVoiceEngineStatus().tts.tier).toBe("local_offline");

    // Late backend failure while static audio is playing must NOT abort active audio
    rejectLateShort(new Error("504 LOCAL_TTS_TIMEOUT"));
    await vi.advanceTimersByTimeAsync(40);
    await shortPromise;
    expect(player.getState()).toBe("completed");

    // 2. playWithWordTimings() at 1.15x with null health -> wins at 80ms with 17-word timings!
    resetVoiceEngineStatus();
    setSpeechPreferences({ voiceId: "local_central_quang_son", speed: 1.15 });
    const wordEvents: number[] = [];
    const words = MALE_VOICE_PREVIEW_TEXT.split(" ");
    const timedPromise = player.playWithWordTimings(words, {
      text: MALE_VOICE_PREVIEW_TEXT,
      cacheScope: "COACHING",
      bypassSessionLock: true,
      utteranceKind: "voice_preview",
      onWordChange: (idx) => wordEvents.push(idx),
    });

    await vi.advanceTimersByTimeAsync(85);
    expect(studioMock.synthesizeTimed).toHaveBeenCalledTimes(1);
    expect(MockAudioElement.instances).toHaveLength(2);
    expect(MockAudioElement.instances[1]!.playbackRate).toBeCloseTo(
      computeEffectivePlaybackRate(1.15, 0.9),
      5,
    );

    rejectLateTimed(new Error("503 LOCAL_TTS_UNAVAILABLE"));
    await vi.advanceTimersByTimeAsync(40);
    await timedPromise;
    expect(wordEvents.length).toBeGreaterThan(0);
    expect(getVoiceEngineStatus().tts.tier).toBe("local_offline");

    // 3. Fast 403 authorization rejection still fails closed (never masked by static preview)
    const forbiddenStudio: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Account deactivated"), { status: 403 }),
        ),
    };
    const strictPlayer = new TtsPlayback(speechMock, forbiddenStudio);
    await expect(
      strictPlayer.playWithWordTimings(words, {
        text: MALE_VOICE_PREVIEW_TEXT,
        cacheScope: "COACHING",
        bypassSessionLock: true,
        utteranceKind: "voice_preview",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("reuses speed-invariant shortCache and timed cache across speeds without extra backend calls", async () => {
    vi.useFakeTimers();
    const cachedShortBlob = new Blob(["short-0p90-mp3"], {
      type: "audio/mpeg",
    });
    setSynthesizedAudioMeta(cachedShortBlob, {
      resolvedVoiceId: "local_north_truc_ly",
      usedFallbackVoice: false,
      provider: "precomputed_cache",
      cachedSpeed: 0.9,
    });

    const cachedTimedSpeech: TimedSpeech = {
      audio: new Blob(["timed-0p90-mp3"], { type: "audio/mpeg" }),
      durationSeconds: 5.5,
      words: [
        { index: 0, start: 0.1, end: 0.9 },
        { index: 1, start: 0.9, end: 1.8 },
      ],
      provider: "precomputed_cache",
      resolvedVoiceId: "local_north_truc_ly",
      cachedSpeed: 0.9,
    };

    const speechMock: SpeechService = {
      synthesize: vi.fn().mockResolvedValue(cachedShortBlob),
      transcribe: vi.fn(),
    };
    const studioMock: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn().mockResolvedValue(cachedTimedSpeech),
    };
    const player = new TtsPlayback(speechMock, studioMock);

    // Short TTS at 0.85x -> 1 backend call; replay at 1.15x -> 0 extra backend calls & scaled rate!
    setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 0.85 });
    const s1 = player.play("Đến lượt con đọc nhé.", { coaching: true });
    await vi.runAllTimersAsync();
    await s1;
    expect(speechMock.synthesize).toHaveBeenCalledTimes(1);
    expect(MockAudioElement.instances[0]!.playbackRate).toBeCloseTo(
      0.85 / 0.9,
      5,
    );

    setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 1.15 });
    const s2 = player.play("Đến lượt con đọc nhé.", { coaching: true });
    await vi.runAllTimersAsync();
    await s2;
    expect(speechMock.synthesize).toHaveBeenCalledTimes(1);
    expect(MockAudioElement.instances[1]!.playbackRate).toBeCloseTo(
      1.15 / 0.9,
      5,
    );

    // Timed TTS at 0.85x -> 1 backend call; replay at 1.15x -> 0 extra backend calls & scaled rate!
    setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 0.85 });
    const t1 = player.playWithWordTimings(["Mèo", "con"], {});
    await vi.runAllTimersAsync();
    await t1;
    expect(studioMock.synthesizeTimed).toHaveBeenCalledTimes(1);
    expect(MockAudioElement.instances[2]!.playbackRate).toBeCloseTo(
      0.85 / 0.9,
      5,
    );

    setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 1.15 });
    const t2 = player.playWithWordTimings(["Mèo", "con"], {});
    await vi.runAllTimersAsync();
    await t2;
    expect(studioMock.synthesizeTimed).toHaveBeenCalledTimes(1);
    expect(MockAudioElement.instances[3]!.playbackRate).toBeCloseTo(
      1.15 / 0.9,
      5,
    );
  });

  it("fast-skips dead localhost worker at 0ms with WASM TTS, keeps session pinned, warms stale-health WASM, and preserves JSDOM local_only lock invariant", async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleTtsFallback: false,
      allowGoogleSttFallback: false,
    });
    setSpeechPreferences({ voiceId: "local_north_thien_minh", speed: 1.0 });
    lockSessionVoice("localhost-dead-worker-wasm", {
      voiceId: "local_north_thien_minh",
      speed: 1.0,
      forceUpdate: true,
    });

    const browserSpeakSpy = vi.fn();
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [
        { name: "Vi Voice", voiceURI: "vi", lang: "vi-VN", localService: true },
      ],
      speak: browserSpeakSpy,
      cancel: vi.fn(),
    });
    vi.stubGlobal("SpeechSynthesisUtterance", class {});
    setCachedVoiceEngineHealth(OFFLINE_LOCAL_HEALTH);

    const speechMock: SpeechService = {
      synthesize: vi.fn().mockRejectedValue(
        Object.assign(new Error("503 LOCAL_TTS_UNAVAILABLE"), {
          status: 503,
          providerCode: "LOCAL_TTS_UNAVAILABLE",
        }),
      ),
      transcribe: vi.fn(),
    };
    const studioMock: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn(),
    };

    // 1. JSDOM invariant (Worker undefined -> wasmAvailable=false): locked local_only NEVER calls speechSynthesis
    const jsdomPlayer = new TtsPlayback(speechMock, studioMock);
    await expect(jsdomPlayer.play("Hãy đọc từ con mèo nhé.")).rejects.toThrow();
    expect(browserSpeakSpy).not.toHaveBeenCalled();
    speechMock.synthesize = vi.fn().mockRejectedValue(
      Object.assign(new Error("503 LOCAL_TTS_UNAVAILABLE"), {
        status: 503,
        providerCode: "LOCAL_TTS_UNAVAILABLE",
      }),
    );

    // 2. Real browser (Worker supported -> wasmAvailable=true):
    vi.stubGlobal("Worker", MockWasmTtsWorker);

    // Even when health snapshot is >30s old on localhost (getFreshVoiceEngineHealth() === null),
    // shouldWarmWasmTts() falls back to getCachedVoiceEngineHealth() and warms WASM!
    vi.advanceTimersByTime(45_000);
    expect(shouldWarmWasmTts()).toBe(true);
    const warmPromise = warmWasmTtsIfNeeded("male");
    await vi.runAllTimersAsync();
    await expect(warmPromise).resolves.toBe(true);

    // Refresh offline health and verify 0ms fast-skip on dynamic prompt (0 backend calls!)
    setCachedVoiceEngineHealth(OFFLINE_LOCAL_HEALTH);
    const wasmPlayer = new TtsPlayback(speechMock, studioMock);
    const dynamicPlay = wasmPlayer.play("Hãy đọc từ bông hoa nhé.");
    await vi.runAllTimersAsync();
    await dynamicPlay;

    expect(speechMock.synthesize).not.toHaveBeenCalled();
    expect(MockWasmTtsWorker.synthesizedPayloads).toHaveLength(1);
    expect(MockWasmTtsWorker.synthesizedPayloads[0]?.gender).toBe("male");
    expect(
      getSessionDeviceTransport(
        "localhost-dead-worker-wasm::local_north_thien_minh",
      ),
    ).toBe("wasm_tts");

    // Subsequent coaching/wordSample utterances stay pinned to WASM TTS (error === undefined -> 0 backend calls!)
    const pinnedCoaching = wasmPlayer.play("Con giỏi lắm!", {
      coaching: true,
      cacheScope: "COACHING",
    });
    await vi.runAllTimersAsync();
    await pinnedCoaching;

    expect(speechMock.synthesize).not.toHaveBeenCalled();
    expect(MockWasmTtsWorker.synthesizedPayloads).toHaveLength(2);
    expect(browserSpeakSpy).not.toHaveBeenCalled();
  });

  it("eliminates 2x/3x retry stalls in playWithWordTimings and playPhonicsLesson on local worker outage", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", MockWasmTtsWorker);
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleTtsFallback: false,
    });
    setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 0.9 });
    lockSessionVoice("no-double-triple-retries", {
      voiceId: "local_north_truc_ly",
      speed: 0.9,
      forceUpdate: true,
    });
    setCachedVoiceEngineHealth(HEALTHY_LOCAL_HEALTH);

    const speechMock: SpeechService = {
      synthesize: vi.fn().mockRejectedValue(
        Object.assign(new Error("504 LOCAL_TTS_TIMEOUT"), {
          status: 504,
          providerCode: "LOCAL_TTS_TIMEOUT",
        }),
      ),
      synthesizePhonics: vi.fn().mockRejectedValue(
        Object.assign(new Error("504 LOCAL_TTS_TIMEOUT"), {
          status: 504,
          providerCode: "LOCAL_TTS_TIMEOUT",
        }),
      ),
      transcribe: vi.fn(),
    };
    const studioMock: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn().mockRejectedValue(
        Object.assign(new Error("503 LOCAL_TTS_UNAVAILABLE"), {
          status: 503,
          providerCode: "LOCAL_TTS_UNAVAILABLE",
        }),
      ),
    };

    const player = new TtsPlayback(speechMock, studioMock);

    // 1. playWithWordTimings skips fallback() on LOCAL_TTS_UNAVAILABLE and plays straight through WASM with word timings
    const fallbackSpy = vi.fn(async () => {
      await player.play("Bé đọc sách");
    });
    const wordHighlights: number[] = [];
    const timedPlay = player.playWithWordTimings(
      ["Bé", "đọc", "sách"],
      {
        text: "Bé đọc sách",
        bookId: "book-1",
        pageId: "page-1",
        onWordChange: (idx) => wordHighlights.push(idx),
      },
      fallbackSpy,
    );
    await vi.runAllTimersAsync();
    await timedPlay;

    expect(studioMock.synthesizeTimed).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(speechMock.synthesize).not.toHaveBeenCalled();
    expect(wordHighlights.length).toBeGreaterThan(0);

    // 2. Fresh session without prior pin: playPhonicsLesson skips BOTH per-step synthesize AND cached-word synthesize on LOCAL_TTS_TIMEOUT
    clearSessionDeviceTransports();
    lockSessionVoice("phonics-no-triple-stall", {
      voiceId: "local_north_truc_ly",
      speed: 0.9,
      forceUpdate: true,
    });
    const freshPlayer = new TtsPlayback(speechMock, studioMock);
    freshPlayer.setCacheContext({ bookId: "book-1", pageId: "page-1" });

    const lesson = buildPhonicsLesson("mốt");
    expect(lesson.supported).toBe(true);
    if (lesson.supported) {
      const stepIndices: number[] = [];
      const phonicsPlay = freshPlayer.playPhonicsLesson(lesson, {
        onStepChange: (idx) => stepIndices.push(idx),
      });
      await vi.runAllTimersAsync();
      await phonicsPlay;

      expect(speechMock.synthesizePhonics).toHaveBeenCalledTimes(1);
      expect(speechMock.synthesize).not.toHaveBeenCalled();
      expect(stepIndices.length).toBe(lesson.steps.length);
    }

    // 3. Even in JSDOM without WASM, playPhonicsLesson fails fast after 1 call (0 per-step or whole-word retries)
    vi.unstubAllGlobals();
    vi.stubGlobal("Audio", MockAudioElement);
    clearSessionDeviceTransports();
    lockSessionVoice("phonics-jsdom-no-triple-stall", {
      voiceId: "local_north_truc_ly",
      speed: 0.9,
      forceUpdate: true,
    });
    (speechMock.synthesizePhonics as ReturnType<typeof vi.fn>)
      .mockClear()
      .mockRejectedValueOnce(
        Object.assign(new Error("503 LOCAL_TTS_UNAVAILABLE"), {
          status: 503,
          providerCode: "LOCAL_TTS_UNAVAILABLE",
        }),
      );
    (speechMock.synthesize as ReturnType<typeof vi.fn>).mockClear();

    const jsdomPhonicsPlayer = new TtsPlayback(speechMock, studioMock);
    jsdomPhonicsPlayer.setCacheContext({ bookId: "book-1", pageId: "page-1" });
    if (lesson.supported) {
      await expect(
        jsdomPhonicsPlayer.playPhonicsLesson(lesson),
      ).rejects.toThrow();
      expect(speechMock.synthesizePhonics).toHaveBeenCalledTimes(1);
      expect(speechMock.synthesize).not.toHaveBeenCalled();
    }
  });
});
