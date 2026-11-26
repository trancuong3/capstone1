import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isServiceError, ServiceError } from "@/lib/api/service-error";
import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";
import {
  acquireUnlockedAudioElement,
  resetAndroidAudioUnlockForTest,
  unlockAudioNow,
} from "@/lib/reading/android-audio-unlock";
import {
  getBrowserWasmSttClient,
  resetBrowserWasmSttForTests,
} from "@/lib/reading/browser-wasm-stt";
import {
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
  shouldPreferAndroidNativeStt,
} from "@/lib/reading/local-segment-speech-recognition";
import {
  resetAndroidNativeSpeechBridgeForTests,
  type ViReadNativeSpeechPort,
} from "@/lib/reading/native-speech-bridge";
import { buildPhonicsLesson } from "@/lib/reading/phonics-lesson";
import {
  getVoicePolicyPreferences,
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import { resetSpeechPreferencesCache } from "@/lib/reading/speech-preferences";
import { TtsPlayback, type ActiveAudioKind } from "@/lib/reading/tts-playback";
import {
  getVoiceEngineStatus,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";

vi.mock("@/lib/api/browser-auth", () => ({
  getBrowserAccessToken: vi.fn().mockResolvedValue("test-token"),
  invalidateBrowserTokenCache: vi.fn(),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

class FakeAndroidSpeechPort implements ViReadNativeSpeechPort {
  sent: Array<Record<string, unknown>> = [];
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  postMessage = vi.fn((raw: string) => {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  });
  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function installAndroidPort(port: FakeAndroidSpeechPort | undefined) {
  const win = window as unknown as {
    ViReadNativeSpeech?: ViReadNativeSpeechPort;
  };
  if (port) {
    win.ViReadNativeSpeech = port;
  } else {
    delete win.ViReadNativeSpeech;
  }
}

function makeHealth(localReady: boolean) {
  return {
    default_mode: "local",
    default_voice_id: "vi_VN-vais1000-medium",
    local: {
      available: localReady,
      stt_ready: localReady,
      tts_ready: localReady,
      stt_model_version: localReady ? "small" : null,
      tts_model_version: localReady ? "vi_VN" : null,
    },
    google: {
      stt_configured: false,
      tts_configured: false,
      stt_cooldown: false,
      tts_cooldown: false,
    },
  };
}

function makeFakeAudioClass(durationSeconds = 0.8) {
  return class FakeAudio {
    preload = "";
    src = "";
    defaultPlaybackRate = 1;
    playbackRate = 1;
    preservesPitch = false;
    volume = 1;
    currentTime = 0;
    duration = durationSeconds;
    ended = false;
    paused = true;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeupdate: (() => void) | null = null;
    onloadedmetadata: (() => void) | null = null;

    constructor(src?: string) {
      if (src) this.src = src;
    }

    play() {
      this.paused = false;
      queueMicrotask(() => {
        this.onloadedmetadata?.();
        queueMicrotask(() => {
          this.ended = true;
          this.paused = true;
          this.onended?.();
        });
      });
      return Promise.resolve();
    }

    pause() {
      this.paused = true;
    }

    load() {
      // no-op
    }
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetAndroidNativeSpeechBridgeForTests();
  resetBrowserWasmSttForTests();
  resetAndroidAudioUnlockForTest();
  resetVoiceLockAndPolicyForTests();
  resetSpeechPreferencesCache();
  resetVoiceEngineStatus();
  resetLocalSttEmergencyStateForTests();
  installAndroidPort(undefined);
});

afterEach(() => {
  resetAndroidNativeSpeechBridgeForTests();
  resetBrowserWasmSttForTests();
  resetAndroidAudioUnlockForTest();
  installAndroidPort(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("speech-service timeout vs user-abort classification", () => {
  it("throws ServiceError (504 LOCAL_TTS_TIMEOUT) on deadline timeout instead of AbortError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            reject(
              signal?.reason ?? new DOMException("Timed out", "TimeoutError"),
            );
          };
          if (signal?.aborted) {
            onAbort();
          } else {
            signal?.addEventListener("abort", onAbort, { once: true });
          }
        });
      }),
    );

    const svc = createSpeechService();
    let caught: unknown = null;
    try {
      await svc.synthesize("Xin chào bé", { timeoutMs: 25 });
    } catch (err) {
      caught = err;
    }

    expect(isServiceError(caught)).toBe(true);
    if (isServiceError(caught)) {
      expect(caught.status).toBe(504);
      expect(caught.code).toBe("TTS_UNAVAILABLE");
      expect(caught.provider_code).toBe("LOCAL_TTS_TIMEOUT");
      expect(caught.retryable).toBe(true);
    }
  });

  it("still throws AbortError when caller explicitly aborts signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Stopped by user", "AbortError")),
            { once: true },
          );
        });
      }),
    );

    const svc = createSpeechService();
    const promise = svc.synthesize("Xin chào bé", {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("LocalSegmentSpeechRecognition WASM-first priority, Android Native fallback & debounce", () => {
  it("prioritizes Browser WASM STT ahead of Android Native when Worker & crypto.subtle exist, and skips rolling interim while init() is warming", async () => {
    vi.useFakeTimers();
    try {
      const port = new FakeAndroidSpeechPort();
      installAndroidPort(port);

      class SlowInitWasmWorker {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: ErrorEvent) => void) | null = null;
        postMessage(msg: { type: string; id: string }) {
          if (msg.type === "init") {
            setTimeout(() => {
              this.onmessage?.({
                data: { type: "ready", id: msg.id },
              } as MessageEvent);
            }, 6_000);
          } else if (msg.type === "transcribe") {
            setTimeout(() => {
              this.onmessage?.({
                data: {
                  type: "result",
                  id: msg.id,
                  text: "mèo nhỏ",
                  decodeMs: 30,
                },
              } as MessageEvent);
            }, 20);
          }
        }
        terminate() {}
      }

      vi.stubGlobal("Worker", SlowInitWasmWorker);
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: { subtle: { digest: vi.fn() } },
      });

      setVoicePolicyPreferences({ providerMode: "local_only" });
      expect(getVoicePolicyPreferences().providerMode).toBe("local_only");
      setCachedVoiceEngineHealth(makeHealth(false));

      // Must keep speechRecorder active for WASM instead of skipping to Android
      expect(shouldPreferAndroidNativeStt()).toBe(false);

      const transcribe = vi.fn();
      const rec = new LocalSegmentSpeechRecognition(
        { transcribe } as unknown as SpeechService,
        () => ({ sessionId: "sess-1", pageId: "page-1" }),
      );
      const transcripts: string[] = [];
      rec.onresult = (ev) => {
        const item = ev.results[ev.resultIndex];
        if (item?.isFinal) transcripts.push(item[0]?.transcript ?? "");
      };

      rec.start();
      expect(getVoiceEngineStatus().stt.tier).toBe("browser_wasm");
      expect(port.sent.some((m) => m.action === "startStt")).toBe(false);

      // Simulate speech during cold-start > 4_000ms while init() is still warming
      const internal = rec as unknown as {
        active: boolean;
        consumeSamples16k: (chunk: Float32Array) => void;
      };
      internal.active = true;
      for (let i = 0; i < 10; i += 1) {
        internal.consumeSamples16k(new Float32Array(640).fill(0.05));
      }
      await vi.advanceTimersByTimeAsync(4_500);
      // Must NOT flip to Android on 4s rolling-interim window while init() warms!
      expect(port.sent.some((m) => m.action === "startStt")).toBe(false);
      expect(getVoiceEngineStatus().stt.tier).toBe("browser_wasm");

      // Complete 6_000ms cold init() -> flush segment -> decodes via WASM!
      await vi.advanceTimersByTimeAsync(1_600);
      for (let i = 0; i < 20; i += 1) {
        internal.consumeSamples16k(new Float32Array(640).fill(0));
      }
      await vi.advanceTimersByTimeAsync(50);

      expect(transcripts).toContain("mèo nhỏ");
      expect(port.sent.some((m) => m.action === "startStt")).toBe(false);
      rec.stop();
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("activates Browser WASM STT on 503 outage and falls back to Android Native with WASM_INIT_FAILED when WASM init rejects", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);

    class FailingInitWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: { type: string; id: string }) {
        if (msg.type === "init") {
          setTimeout(() => {
            this.onmessage?.({
              data: {
                type: "error",
                id: msg.id,
                message: "Model fetch failed (encoder.int8.onnx): HTTP 502",
              },
            } as MessageEvent);
          }, 15);
        }
      }
      terminate() {}
    }

    vi.stubGlobal("Worker", FailingInitWorker);
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { subtle: { digest: vi.fn() } },
    });
    setVoicePolicyPreferences({ providerMode: "local_only" });
    setCachedVoiceEngineHealth(makeHealth(true));

    const transcribe = vi.fn().mockRejectedValue(
      new ServiceError({
        code: "STT_UNAVAILABLE",
        message: "Voice worker offline",
        status: 503,
        request_id: "req-outage",
        retryable: true,
      }),
    );
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "sess-2", pageId: "page-2" }),
    );

    const internal = rec as unknown as {
      active: boolean;
      abortController: AbortController;
      speechChunks: Float32Array[];
      speechSamples: number;
      inSpeech: boolean;
      flushCurrentSegment: (carry?: boolean) => void;
    };
    internal.active = true;
    internal.abortController = new AbortController();
    internal.speechChunks = [new Float32Array(3200).fill(0.05)];
    internal.speechSamples = 3200;
    internal.inSpeech = true;

    internal.flushCurrentSegment(false);
    await vi.waitFor(() => {
      expect(port.sent.some((m) => m.action === "startStt")).toBe(true);
    });

    const sttStatus = getVoiceEngineStatus().stt;
    expect(sttStatus.tier).toBe("android_native");
    expect(sttStatus.fallbackReason).toBe("WASM_INIT_FAILED");

    const startMsg = port.sent.find((m) => m.action === "startStt");
    port.emit({
      type: "stt_ready",
      requestId: startMsg?.requestId,
      onDevice: true,
    });
    expect(getVoiceEngineStatus().stt.androidOnDevice).toBe(true);
    expect(getVoiceEngineStatus().stt.fallbackReason).toBe("WASM_INIT_FAILED");

    rec.stop();
  });

  it("handles too-many-requests debounce, 50ms clean stt_final restart, and up to 2 transient network glitches on Android STT", async () => {
    vi.useFakeTimers();
    try {
      const port = new FakeAndroidSpeechPort();
      installAndroidPort(port);
      setCachedVoiceEngineHealth(makeHealth(false));

      const rec = new LocalSegmentSpeechRecognition(
        { transcribe: vi.fn() } as unknown as SpeechService,
        () => ({ sessionId: "sess-resilient", pageId: "page-resilient" }),
      );
      rec.continuous = true;
      const errors: string[] = [];
      rec.onerror = (ev) => errors.push(String(ev.error ?? ""));
      rec.start();

      // 1. Clean stt_final + stt_end restarts in 50ms (not 120ms)
      const firstId = String(
        port.sent.find((m) => m.action === "startStt")?.requestId,
      );
      port.emit({
        type: "stt_final",
        requestId: firstId,
        transcript: "mèo con",
      });
      port.emit({ type: "stt_end", requestId: firstId });
      await vi.advanceTimersByTimeAsync(55);
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(2);

      // 2. too-many-requests maps to aborted (350ms backoff, non-fatal)
      const secondId = String(
        port.sent.filter((m) => m.action === "startStt")[1]?.requestId,
      );
      port.emit({
        type: "stt_error",
        requestId: secondId,
        code: "too-many-requests",
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(160);
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(3);

      // 3. Up to 2 transient network glitches retry after 500ms without fatal stt-unavailable
      const thirdId = String(
        port.sent.filter((m) => m.action === "startStt")[2]?.requestId,
      );
      port.emit({ type: "stt_error", requestId: thirdId, code: "network" });
      await vi.advanceTimersByTimeAsync(510);
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(4);
      expect(errors).not.toContain("network");

      rec.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces Android Native STT restart after aborted/busy error instead of 0ms spin loop", async () => {
    vi.useFakeTimers();
    try {
      const port = new FakeAndroidSpeechPort();
      installAndroidPort(port);
      setCachedVoiceEngineHealth(makeHealth(false));

      const rec = new LocalSegmentSpeechRecognition(
        { transcribe: vi.fn() } as unknown as SpeechService,
        () => ({ sessionId: "sess-3", pageId: "page-3" }),
      );
      rec.continuous = true;
      rec.start();
      const firstReqId = port.sent.find(
        (m) => m.action === "startStt",
      )?.requestId;
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(1);

      // Simulate Android ERROR_RECOGNIZER_BUSY ("recognizer_busy" -> "aborted")
      port.emit({
        type: "stt_error",
        requestId: firstReqId,
        code: "recognizer_busy",
      });
      port.emit({ type: "stt_end", requestId: firstReqId });

      // Must NOT immediately restart at 0ms or 150ms!
      vi.advanceTimersByTime(150);
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(1);

      // Should restart cleanly after >= 350ms backoff
      vi.advanceTimersByTime(250);
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(2);

      rec.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits onend immediately when stop() is called during Android Native STT restart debounce (no 1.5s hang)", () => {
    vi.useFakeTimers();
    try {
      const port = new FakeAndroidSpeechPort();
      installAndroidPort(port);
      setCachedVoiceEngineHealth(makeHealth(false));

      const rec = new LocalSegmentSpeechRecognition(
        { transcribe: vi.fn() } as unknown as SpeechService,
        () => ({ sessionId: "sess-debounce-stop", pageId: "page-debounce" }),
      );
      rec.continuous = true;
      const onend = vi.fn();
      rec.onend = onend;

      rec.start();
      const firstReqId = port.sent.find(
        (m) => m.action === "startStt",
      )?.requestId;
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(1);

      // Android native ends with recognizer_busy -> schedules 350ms restart timer
      port.emit({
        type: "stt_error",
        requestId: firstReqId,
        code: "recognizer_busy",
      });
      port.emit({ type: "stt_end", requestId: firstReqId });
      expect(onend).not.toHaveBeenCalled();

      // Call stop() mid-debounce (50ms later) -> MUST emit onend immediately without waiting
      vi.advanceTimersByTime(50);
      rec.stop();
      expect(onend).toHaveBeenCalledTimes(1);

      // Pending restart timer must be cancelled -> zero extra startStt even after advancing 2s
      vi.advanceTimersByTime(2_000);
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(1);

      // Recognizer is cleanly idle and can be restarted
      rec.start();
      expect(port.sent.filter((m) => m.action === "startStt")).toHaveLength(2);
      rec.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers Android Native STT when providerMode allows Google fallback but allowGoogleSttFallback is false", () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: true,
    });
    setCachedVoiceEngineHealth({
      ...makeHealth(false),
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });

    expect(shouldPreferAndroidNativeStt()).toBe(true);

    const rec = new LocalSegmentSpeechRecognition(
      { transcribe: vi.fn() } as unknown as SpeechService,
      () => ({ sessionId: "sess-policy-guard", pageId: "page-policy" }),
    );
    rec.start();
    expect(port.sent.some((m) => m.action === "startStt")).toBe(true);
    rec.abort();
  });
});

describe("TtsPlayback audioKind tracking, chunk pipelining, and Android fast-path", () => {
  it("tracks activeAudioKind across sample, word, phonics, and coaching playback", async () => {
    vi.stubGlobal("Audio", makeFakeAudioClass(0.8));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-audio"),
      revokeObjectURL: vi.fn(),
    });
    setCachedVoiceEngineHealth(makeHealth(true));

    const lesson = buildPhonicsLesson("mèo");
    expect(lesson.supported).toBe(true);
    if (!lesson.supported) return;

    const speechService = {
      synthesize: vi
        .fn()
        .mockResolvedValue(new Blob(["mp3"], { type: "audio/mpeg" })),
      synthesizePhonics: vi.fn().mockResolvedValue({
        audio: new Blob(["mp3"], { type: "audio/mpeg" }),
        durationSeconds: 0.72,
        stepTimings: lesson.steps.map((s, idx) => ({
          id: s.id,
          index: idx,
          start: (idx / lesson.steps.length) * 0.7,
          end: ((idx + 1) / lesson.steps.length) * 0.7,
        })),
      }),
    } as unknown as SpeechService;

    const voiceStudioService = {
      listVoices: vi
        .fn()
        .mockResolvedValue({ voices: [], default_voice_id: "" }),
      synthesizeTimed: vi.fn().mockResolvedValue({
        audio: new Blob(["mp3"], { type: "audio/mpeg" }),
        durationSeconds: 0.7, // tests +0.15s padding tolerance against Audio.duration=0.8
        words: [
          { index: 0, start: 0, end: 0.3 },
          { index: 1, start: 0.3, end: 0.7 },
        ],
      }),
    } as unknown as VoiceStudioService;

    const seenKinds: ActiveAudioKind[] = [];
    const player = new TtsPlayback(speechService, voiceStudioService);
    player.subscribe(() => {
      const kind = player.getActiveAudioKind();
      if (seenKinds[seenKinds.length - 1] !== kind) {
        seenKinds.push(kind);
      }
    });

    expect(player.getActiveAudioKind()).toBe("idle");

    await player.play("mèo", { wordSample: true });
    expect(seenKinds).toContain("word");
    expect(player.getActiveAudioKind()).toBe("idle");

    await player.play("Con đọc rất tốt!", { coaching: true });
    expect(seenKinds).toContain("coaching");
    expect(player.getActiveAudioKind()).toBe("idle");

    await player.playWithWordTimings(["Bé", "đọc"], {});
    expect(seenKinds).toContain("sample");
    expect(player.getActiveAudioKind()).toBe("idle");

    await player.playPhonicsLesson(lesson);
    expect(seenKinds).toContain("phonics");
    expect(player.getActiveAudioKind()).toBe("idle");
  });

  it("splits multi-sentence local timed samples (>120 chars) into sentence chunks and prefetches", async () => {
    vi.stubGlobal("Audio", makeFakeAudioClass(0.6));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-chunk"),
      revokeObjectURL: vi.fn(),
    });
    setCachedVoiceEngineHealth(makeHealth(true));

    const synthesizeTimed = vi
      .fn()
      .mockImplementation(async (chunkWords: readonly string[]) => {
        return {
          audio: new Blob(["wav-chunk"], { type: "audio/wav" }),
          durationSeconds: 0.6,
          words: chunkWords.map((_word, i) => ({
            index: i,
            start: (i / Math.max(1, chunkWords.length)) * 0.55,
            end: ((i + 1) / Math.max(1, chunkWords.length)) * 0.55,
          })),
        };
      });

    const player = new TtsPlayback(
      { synthesize: vi.fn() } as unknown as SpeechService,
      {
        listVoices: vi
          .fn()
          .mockResolvedValue({ voices: [], default_voice_id: "" }),
        synthesizeTimed,
      } as unknown as VoiceStudioService,
    );

    const longText =
      "Buổi sáng mùa thu trời trong xanh và mát mẻ lắm. Bé Nam cùng chú mèo nhỏ chạy ra vườn hoa ngắm bướm bay. Chim hót líu lo trên cành cây cao đón nắng mới. Mọi người trong nhà đều vui vẻ bắt đầu một ngày mới.";
    const words = longText.split(/\s+/);

    await player.playWithWordTimings(words, { text: longText });

    expect(synthesizeTimed.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("jumps directly to Android Native TTS with onRangeStart highlighting when local timed TTS fails on Android", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);
    // Health claims local is ready so it attempts synthesizeTimed first, then fails over on 504!
    setCachedVoiceEngineHealth(makeHealth(true));

    const fallback = vi.fn().mockResolvedValue(undefined);
    const synthesizeTimed = vi.fn().mockRejectedValue(
      new ServiceError({
        code: "TTS_UNAVAILABLE",
        message: "Timeout",
        status: 504,
        request_id: "req-timeout",
        retryable: true,
        provider_code: "LOCAL_TTS_TIMEOUT",
      }),
    );

    const player = new TtsPlayback(
      { synthesize: vi.fn() } as unknown as SpeechService,
      {
        listVoices: vi
          .fn()
          .mockResolvedValue({ voices: [], default_voice_id: "" }),
        synthesizeTimed,
      } as unknown as VoiceStudioService,
    );

    const highlightedIndices: number[] = [];
    const playPromise = player.playWithWordTimings(
      ["Bé", "đọc", "sách"],
      {
        onWordChange: (idx) => highlightedIndices.push(idx),
      },
      fallback,
    );

    await vi.waitFor(() => {
      expect(port.sent.some((m) => m.action === "speak")).toBe(true);
    });

    const ttsMsg = port.sent.find((m) => m.action === "speak");
    const reqId = String(ttsMsg?.requestId);
    port.emit({ type: "tts_start", requestId: reqId });
    port.emit({ type: "tts_range", requestId: reqId, start: 0, end: 2 });
    port.emit({ type: "tts_range", requestId: reqId, start: 3, end: 6 });
    port.emit({ type: "tts_range", requestId: reqId, start: 7, end: 11 });
    port.emit({ type: "tts_done", requestId: reqId });

    await playPromise;

    expect(synthesizeTimed).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(highlightedIndices).toContain(0);
    expect(highlightedIndices).toContain(1);
    expect(highlightedIndices).toContain(2);

    // Second click within the 15s cooldown MUST skip /tts/timed immediately and
    // go straight to Android Native TTS (zero extra backend wait).
    const secondPromise = player.playWithWordTimings(
      ["Con", "mèo"],
      {},
      fallback,
    );
    await vi.waitFor(() => {
      expect(port.sent.filter((m) => m.action === "speak")).toHaveLength(2);
    });
    const secondReqId = String(
      port.sent.filter((m) => m.action === "speak")[1]?.requestId,
    );
    port.emit({ type: "tts_start", requestId: secondReqId });
    port.emit({ type: "tts_done", requestId: secondReqId });
    await secondPromise;

    expect(synthesizeTimed).toHaveBeenCalledOnce();
  });

  it("skips backend /voice/text-to-speech on Android for private-book word playback when local worker is offline", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);
    setCachedVoiceEngineHealth(makeHealth(false));

    const synthesize = vi.fn();
    const player = new TtsPlayback(
      { synthesize } as unknown as SpeechService,
      {
        listVoices: vi
          .fn()
          .mockResolvedValue({ voices: [], default_voice_id: "" }),
        synthesizeTimed: vi.fn(),
      } as unknown as VoiceStudioService,
    );

    const playPromise = player.play("mèo", {
      wordSample: true,
      isPrivateBook: true,
    });
    await vi.waitFor(() => {
      expect(port.sent.some((m) => m.action === "speak")).toBe(true);
    });
    const reqId = String(
      port.sent.find((m) => m.action === "speak")?.requestId,
    );
    port.emit({ type: "tts_start", requestId: reqId });
    port.emit({ type: "tts_done", requestId: reqId });
    await playPromise;

    expect(synthesize).not.toHaveBeenCalled();
  });

  it("enforces timedCooldownUntil even when Google TTS policy is enabled if Google TTS is unconfigured or in cooldown", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    // Local initially claims ready so 1st click tries /tts/timed, while Google TTS is NOT configured
    setCachedVoiceEngineHealth({
      ...makeHealth(true),
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });

    const synthesizeTimed = vi.fn().mockRejectedValue(
      new ServiceError({
        code: "TTS_UNAVAILABLE",
        message: "Timeout",
        status: 504,
        request_id: "req-cooldown-bypass",
        retryable: true,
        provider_code: "LOCAL_TTS_TIMEOUT",
      }),
    );

    const player = new TtsPlayback(
      { synthesize: vi.fn() } as unknown as SpeechService,
      {
        listVoices: vi
          .fn()
          .mockResolvedValue({ voices: [], default_voice_id: "" }),
        synthesizeTimed,
      } as unknown as VoiceStudioService,
    );

    const firstPlay = player.playWithWordTimings(["Bé", "đọc"], {});
    await vi.waitFor(() => {
      expect(port.sent.filter((m) => m.action === "speak")).toHaveLength(1);
    });
    const firstReqId = String(
      port.sent.filter((m) => m.action === "speak")[0]?.requestId,
    );
    port.emit({ type: "tts_start", requestId: firstReqId });
    port.emit({ type: "tts_done", requestId: firstReqId });
    await firstPlay;
    expect(synthesizeTimed).toHaveBeenCalledTimes(1);

    // 2nd click within 15s cooldown MUST NOT bypass timedCooldownUntil!
    const secondPlay = player.playWithWordTimings(["Con", "mèo"], {});
    await vi.waitFor(() => {
      expect(port.sent.filter((m) => m.action === "speak")).toHaveLength(2);
    });
    const secondReqId = String(
      port.sent.filter((m) => m.action === "speak")[1]?.requestId,
    );
    port.emit({ type: "tts_start", requestId: secondReqId });
    port.emit({ type: "tts_done", requestId: secondReqId });
    await secondPlay;
    expect(synthesizeTimed).toHaveBeenCalledTimes(1);

    // Also verify google.tts_cooldown === true still enforces cooldown
    setCachedVoiceEngineHealth({
      ...makeHealth(true),
      google: {
        stt_configured: false,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: true,
      },
    });
    const thirdPlay = player.playWithWordTimings(["Cây", "xanh"], {});
    await vi.waitFor(() => {
      expect(port.sent.filter((m) => m.action === "speak")).toHaveLength(3);
    });
    const thirdReqId = String(
      port.sent.filter((m) => m.action === "speak")[2]?.requestId,
    );
    port.emit({ type: "tts_start", requestId: thirdReqId });
    port.emit({ type: "tts_done", requestId: thirdReqId });
    await thirdPlay;
    expect(synthesizeTimed).toHaveBeenCalledTimes(1);
  });

  it("skips backend phonics & word synthesize immediately on Android for private books when local TTS is offline", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);
    setCachedVoiceEngineHealth(makeHealth(false));

    const lesson = buildPhonicsLesson("mèo");
    expect(lesson.supported).toBe(true);
    if (!lesson.supported) return;

    const synthesizePhonics = vi.fn();
    const synthesize = vi.fn();
    const player = new TtsPlayback(
      { synthesize, synthesizePhonics } as unknown as SpeechService,
      {
        listVoices: vi
          .fn()
          .mockResolvedValue({ voices: [], default_voice_id: "" }),
        synthesizeTimed: vi.fn(),
      } as unknown as VoiceStudioService,
    );
    player.setCacheContext({
      bookId: "11111111-1111-4111-8111-111111111111",
      pageId: "22222222-2222-4222-8222-222222222222",
      isPrivateBook: true,
    });

    const playPromise = player.playPhonicsLesson(lesson);
    for (let i = 0; i < lesson.steps.length; i += 1) {
      await vi.waitFor(() => {
        expect(port.sent.filter((m) => m.action === "speak").length).toBe(
          i + 1,
        );
      });
      const reqId = String(
        port.sent.filter((m) => m.action === "speak")[i]?.requestId,
      );
      port.emit({ type: "tts_start", requestId: reqId });
      port.emit({ type: "tts_done", requestId: reqId });
    }
    await playPromise;

    expect(synthesizePhonics).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("passes 4.5s probe timeout to cached-word phonics synthesize on Android and falls back cleanly on non-user timeout AbortError", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);
    setCachedVoiceEngineHealth(makeHealth(false));

    const lesson = buildPhonicsLesson("mèo");
    expect(lesson.supported).toBe(true);
    if (!lesson.supported) return;

    const synthesizePhonics = vi
      .fn()
      .mockRejectedValue(new DOMException("Backend timed out", "AbortError"));
    const synthesize = vi
      .fn()
      .mockRejectedValue(
        new DOMException("Word cache probe timed out", "AbortError"),
      );

    const player = new TtsPlayback(
      { synthesize, synthesizePhonics } as unknown as SpeechService,
      {
        listVoices: vi
          .fn()
          .mockResolvedValue({ voices: [], default_voice_id: "" }),
        synthesizeTimed: vi.fn(),
      } as unknown as VoiceStudioService,
    );
    // Public catalog book -> still probes backend cache with 4.5s budget, then falls back cleanly!
    player.setCacheContext({
      bookId: "11111111-1111-4111-8111-111111111111",
      pageId: "22222222-2222-4222-8222-222222222222",
      isPrivateBook: false,
    });

    const playPromise = player.playPhonicsLesson(lesson);
    for (let i = 0; i < lesson.steps.length; i += 1) {
      await vi.waitFor(() => {
        expect(port.sent.filter((m) => m.action === "speak").length).toBe(
          i + 1,
        );
      });
      const reqId = String(
        port.sent.filter((m) => m.action === "speak")[i]?.requestId,
      );
      port.emit({ type: "tts_start", requestId: reqId });
      port.emit({ type: "tts_done", requestId: reqId });
    }
    await playPromise;

    expect(synthesizePhonics).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 4_500 }),
    );
    expect(synthesize).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeoutMs: 4_500 }),
    );
  });

  it("does not wipe leased sharedAudioElement when unlockAudioNow probe settles during first-tap playback", async () => {
    let resolveProbePlay!: () => void;
    const probeEl = {
      src: "",
      muted: false,
      volume: 1,
      play: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveProbePlay = resolve;
          }),
      ),
      pause: vi.fn(),
    };
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "audio"
        ? (probeEl as unknown as HTMLAudioElement)
        : origCreateElement(tag)) as typeof document.createElement);

    unlockAudioNow({ force: true });
    const leased = acquireUnlockedAudioElement();
    expect(leased).not.toBeNull();
    leased!.audio.src = "blob:active-sample-tts";

    resolveProbePlay();
    await Promise.resolve();
    await Promise.resolve();

    expect(leased!.audio.src).toBe("blob:active-sample-tts");
    expect(probeEl.pause).not.toHaveBeenCalled();
    leased!.release();
  });

  it("falls back immediately with WASM_OFFLINE_UNCACHED when navigator.onLine is false and IndexedDB model cache is empty", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);

    class HangingInitWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal("Worker", HangingInitWorker);
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { subtle: { digest: vi.fn() } },
    });
    const prevMediaDevices = Object.getOwnPropertyDescriptor(
      navigator,
      "mediaDevices",
    );
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(() => new Promise(() => {})),
      },
    });
    setCachedVoiceEngineHealth(makeHealth(false));

    const rec = new LocalSegmentSpeechRecognition(
      { transcribe: vi.fn() } as unknown as SpeechService,
      () => ({ sessionId: "sess-offline-uncached", pageId: "page-1" }),
    );
    try {
      rec.start();

      await vi.waitFor(() => {
        expect(port.sent.some((m) => m.action === "startStt")).toBe(true);
      });
      expect(getVoiceEngineStatus().stt.tier).toBe("android_native");
      expect(getVoiceEngineStatus().stt.fallbackReason).toBe(
        "WASM_OFFLINE_UNCACHED",
      );
      rec.abort();
    } finally {
      if (prevMediaDevices) {
        Object.defineProperty(navigator, "mediaDevices", prevMediaDevices);
      } else {
        Reflect.deleteProperty(navigator, "mediaDevices");
      }
    }
  });

  it("reports WASM_OFFLINE_UNCACHED when prewarm() already probed uncached IndexedDB offline prior to rec.start()", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);

    class NeverCalledWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal("Worker", NeverCalledWorker);
    vi.stubGlobal("indexedDB", undefined);
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { subtle: { digest: vi.fn() } },
    });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    setCachedVoiceEngineHealth(makeHealth(false));

    const prewarmOk = await getBrowserWasmSttClient().prewarm();
    expect(prewarmOk).toBe(false);
    expect(getBrowserWasmSttClient().getCachedModelReady()).toBe(false);

    const rec = new LocalSegmentSpeechRecognition(
      { transcribe: vi.fn() } as unknown as SpeechService,
      () => ({ sessionId: "sess-prewarm-offline", pageId: "page-1" }),
    );
    rec.start();

    expect(port.sent.some((m) => m.action === "startStt")).toBe(true);
    expect(getVoiceEngineStatus().stt.tier).toBe("android_native");
    expect(getVoiceEngineStatus().stt.fallbackReason).toBe(
      "WASM_OFFLINE_UNCACHED",
    );
    rec.abort();
  });
});
