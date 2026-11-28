import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/lib/api/service-error";
import type { SpeechService } from "@/lib/api/speech-service";
import { resetBrowserWasmSttForTests } from "@/lib/reading/browser-wasm-stt";
import { EchoGuard } from "@/lib/reading/echo-guard";
import {
  encodeFloat32ToWav16kBlob,
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
  shouldPreferAndroidNativeStt,
} from "@/lib/reading/local-segment-speech-recognition";
import { resetAndroidNativeSpeechBridgeForTests } from "@/lib/reading/native-speech-bridge";
import {
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import { resetSpeechPreferencesCache } from "@/lib/reading/speech-preferences";
import {
  getVoiceEngineStatus,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import {
  getVoicePreloadState,
  preloadReadingVoiceEngines,
  resetVoicePreloaderForTests,
} from "@/lib/reading/voice-preloader";
import { evaluateRecordedShortWord } from "@/lib/reading/word-practice-engine";

function makeFakeWasmWorkerClass(options?: {
  readonly decodeText?: string;
  readonly onInit?: () => void;
}) {
  return class FakeWasmWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    postMessage(msg: { type: string; id: string }) {
      queueMicrotask(() => {
        if (msg.type === "init") {
          options?.onInit?.();
          this.onmessage?.({
            data: { type: "ready", id: msg.id },
          } as MessageEvent);
        } else if (msg.type === "transcribe") {
          this.onmessage?.({
            data: {
              type: "result",
              id: msg.id,
              text: options?.decodeText ?? "mèo",
              decodeMs: 12,
            },
          } as MessageEvent);
        }
      });
    }
    terminate() {}
  };
}

describe("First-word EchoGuard grace window & non-overlapping child speech", () => {
  afterEach(() => {
    resetAndroidNativeSpeechBridgeForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts a non-overlapping first book word immediately (+40ms) after 'Đến lượt con đọc nhé.' ends while blocking overlapping prompt reverb within 150ms", () => {
    const guard = new EchoGuard();
    guard.playbackStarted("prompt-1", "Đến lượt con đọc nhé.", 1_000);
    guard.playbackEnded("prompt-1", 2_000);

    // 1. Speech starting strictly DURING playback (onsetAt <= endedAt) is always blocked
    expect(
      guard.evaluate({
        text: "mèo",
        receivedAt: 2_300,
        onsetAt: 1_980,
      }),
    ).toMatchObject({ accept: false, reason: "onset-during-playback" });

    // 2. Overlapping prompt reverb at +100ms (inside Web 150ms grace) is blocked
    expect(
      guard.evaluate({
        text: "đọc nhé",
        receivedAt: 2_300,
        onsetAt: 2_100,
      }),
    ).toMatchObject({ accept: false, reason: "onset-during-playback" });

    // 3. First book word ("mèo") starting at +40ms AFTER playback ended has 0% overlap -> ACCEPTED!
    expect(
      guard.evaluate({
        text: "mèo",
        receivedAt: 2_300,
        onsetAt: 2_040,
      }),
    ).toMatchObject({ accept: true, reason: "ok" });

    // 4. Single-letter / short first word ("a") at +20ms AFTER playback ended -> ACCEPTED!
    expect(
      guard.evaluate({
        text: "a",
        receivedAt: 2_250,
        onsetAt: 2_020,
      }),
    ).toMatchObject({ accept: true, reason: "ok" });
  });

  it("uses 250ms grace for Android Native bridge on overlapping reverb while still accepting non-overlapping book words right after prompt end", () => {
    vi.stubGlobal("ViReadNativeSpeech", {
      postMessage: vi.fn(),
    });
    const guard = new EchoGuard();
    guard.playbackStarted("prompt-android", "Đến lượt con đọc nhé.", 1_000);
    guard.playbackEnded("prompt-android", 2_000);

    // Overlapping reverb at +200ms (< 250ms Android native grace) -> blocked
    expect(
      guard.evaluate({
        text: "nhé",
        receivedAt: 2_500,
        onsetAt: 2_200,
      }),
    ).toMatchObject({ accept: false, reason: "onset-during-playback" });

    // Non-overlapping first book word ("bà") at +80ms -> accepted immediately!
    expect(
      guard.evaluate({
        text: "bà",
        receivedAt: 2_500,
        onsetAt: 2_080,
      }),
    ).toMatchObject({ accept: true, reason: "ok" });
  });
});

describe("Sherpa WASM STT worker warmup & lead-silence consonant safety margin", () => {
  it("runs a 0.25s silent dummy decode during init() before posting ready and preserves an 80ms safety margin before firstActive on short words", async () => {
    const workerSource = fs.readFileSync(
      path.resolve(process.cwd(), "public/workers/sherpa-stt-worker.js"),
      "utf8",
    );

    const postedMessages: Array<Record<string, unknown>> = [];
    const decodeWaveforms: Array<{ sr: number; samples: Float32Array }> = [];
    let freedStreams = 0;

    class MockOfflineRecognizer {
      handle = 1;
      createStream() {
        let accepted: { sr: number; samples: Float32Array } | null = null;
        return {
          acceptWaveform: (sr: number, samples: Float32Array) => {
            accepted = { sr, samples: new Float32Array(samples) };
          },
          getAccepted: () => accepted,
          free: () => {
            freedStreams += 1;
          },
        };
      }
      decode(stream: {
        getAccepted: () => { sr: number; samples: Float32Array } | null;
      }) {
        const rec = stream.getAccepted();
        if (rec) decodeWaveforms.push(rec);
      }
      getResult() {
        return { text: "cá" };
      }
      free() {}
    }

    const fakeSelf: Record<string, unknown> = {
      postMessage: (msg: Record<string, unknown>) => {
        postedMessages.push(msg);
      },
      indexedDB: undefined,
      performance: { now: () => 100 },
      crypto: {
        subtle: {
          digest: async (_algo: string, buf: ArrayBuffer) => {
            const len = buf.byteLength;
            const hexByLen: Record<number, string> = {
              27699063:
                "8ef5286dd427eb108055c2ddc1982aa31e544706072d5ea228729292dacade68",
              5165084:
                "cf2aa385b82c9d5d40cd29c3188af52d0249b3b78f0d4b7eb84ad502d50c7e7f",
              1033417:
                "7311d2e17b810ecea515d79c71cc4668af8759256a06fa01d27047772320c821",
              23238:
                "ca8171f8bbd516c050b627582f2125c8f5f1f6ed967ab41b0fa9aae2cf61b492",
            };
            const hex = hexByLen[len] ?? "0".repeat(64);
            const out = new Uint8Array(32);
            for (let i = 0; i < 32; i += 1) {
              out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            }
            return out.buffer;
          },
        },
      },
      OfflineRecognizer: MockOfflineRecognizer,
      importScripts: () => {
        const mod = fakeSelf.Module as {
          onRuntimeInitialized?: () => void;
          FS_unlink?: (p: string) => void;
          FS_createDataFile?: (...args: unknown[]) => void;
        };
        mod.FS_unlink = () => undefined;
        mod.FS_createDataFile = () => undefined;
        queueMicrotask(() => mod.onRuntimeInitialized?.());
      },
      fetch: async (url: string) => {
        const sizeByName: Record<string, number> = {
          "encoder.int8.onnx": 27699063,
          "decoder.onnx": 5165084,
          "joiner.int8.onnx": 1033417,
          "tokens.txt": 23238,
        };
        const fileName = url.split("/").pop() ?? "";
        const byteLen = sizeByName[fileName] ?? 0;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(byteLen),
        };
      },
    };

    const runner = new Function(
      "self",
      "importScripts",
      "fetch",
      "OfflineRecognizer",
      workerSource,
    );
    runner(
      fakeSelf,
      fakeSelf.importScripts,
      fakeSelf.fetch,
      MockOfflineRecognizer,
    );

    const onmessage = fakeSelf.onmessage as (ev: {
      data: Record<string, unknown>;
    }) => Promise<void>;

    // 1. init() MUST execute the 0.25s (4000-sample) silent dummy decode BEFORE posting ready
    await onmessage({ data: { type: "init", id: "init-1" } });

    expect(
      postedMessages.some((m) => m.type === "ready" && m.id === "init-1"),
    ).toBe(true);
    expect(decodeWaveforms).toHaveLength(1);
    expect(decodeWaveforms[0].sr).toBe(16000);
    expect(decodeWaveforms[0].samples.length).toBe(4000);
    expect(freedStreams).toBe(1);

    // 2. Transcribe a short word preceded by 0.44s silence + quiet consonant at 0.38s + loud vowel at 0.44s
    const sr = 16000;
    const totalSamples = Math.round(sr * 0.85);
    const clip = new Float32Array(totalSamples);
    // Quiet consonant burst between 0.38s..0.42s (below 14% of loud vowel peak)
    const consonantStart = Math.round(sr * 0.38);
    const consonantEnd = Math.round(sr * 0.42);
    for (let i = consonantStart; i < consonantEnd; i += 1) {
      clip[i] = 0.008 * Math.sin((2 * Math.PI * 2400 * i) / sr);
    }
    // Loud vowel nucleus between 0.44s..0.68s
    const vowelStart = Math.round(sr * 0.44);
    const vowelEnd = Math.round(sr * 0.68);
    for (let i = vowelStart; i < vowelEnd; i += 1) {
      clip[i] = 0.25 * Math.sin((2 * Math.PI * 320 * i) / sr);
    }

    await onmessage({
      data: {
        type: "transcribe",
        id: "tx-1",
        samples: clip,
        sampleRate: sr,
        voicedDurationMs: 260,
      },
    });

    expect(decodeWaveforms).toHaveLength(2);
    const decodedClip = decodeWaveforms[1].samples;
    // With 0.18s lead pad + 0.08s safety margin = 0.26s preserved before vowel at 0.44s,
    // trim removes at most (0.44 - 0.26) = 0.18s (2880 samples), so the quiet consonant
    // starting at 0.38s (6080 samples) is STILL ~0.20s inside the decoded waveform!
    const keptLeadBeforeVowel =
      decodedClip.length - (totalSamples - vowelStart);
    expect(keptLeadBeforeVowel).toBeGreaterThanOrEqual(Math.round(sr * 0.24));
  });
});

describe("Strict Offline-First STT fallback order & short first-word VAD", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetSpeechPreferencesCache();
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetVoicePreloaderForTests();
    resetBrowserWasmSttForTests();
    resetLocalSttEmergencyStateForTests();
    resetAndroidNativeSpeechBridgeForTests();
  });

  afterEach(() => {
    resetBrowserWasmSttForTests();
    resetAndroidNativeSpeechBridgeForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("prefers On-Device Offline WASM BEFORE Browser Web Speech API in recordTechnicalFailureAndMaybeFallback even when localUnconfigured + cloud fallback opted in", async () => {
    vi.stubGlobal("Worker", makeFakeWasmWorkerClass());
    if (!globalThis.crypto?.subtle) {
      vi.stubGlobal("crypto", { subtle: { digest: vi.fn() } });
    }

    let browserStarted = 0;
    class FakeBrowserSpeechRec {
      continuous = true;
      interimResults = true;
      lang = "vi-VN";
      maxAlternatives = 1;
      onresult = null;
      onerror = null;
      onend = null;
      start() {
        browserStarted += 1;
      }
      stop() {}
      abort() {}
    }
    vi.stubGlobal("SpeechRecognition", FakeBrowserSpeechRec);

    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
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
      },
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });

    const transcribe = vi.fn().mockRejectedValue(
      new ServiceError({
        code: "STT_UNAVAILABLE",
        message: "LOCAL_VOICE_UNCONFIGURED",
        status: 503,
        request_id: "req-unconf",
        retryable: false,
      }),
    );
    const rec = new LocalSegmentSpeechRecognition({
      transcribe,
    } as unknown as SpeechService);

    const internal = rec as unknown as {
      active: boolean;
      usingWasmStt: boolean;
      recordTechnicalFailureAndMaybeFallback: (err: unknown) => boolean;
    };
    internal.active = true;
    const switched = internal.recordTechnicalFailureAndMaybeFallback(
      new ServiceError({
        code: "STT_UNAVAILABLE",
        message: "LOCAL_VOICE_UNCONFIGURED",
        status: 503,
        request_id: "req-unconf",
        retryable: false,
      }),
    );

    expect(switched).toBe(true);
    expect(internal.usingWasmStt).toBe(true);
    expect(browserStarted).toBe(0);
    expect(getVoiceEngineStatus().stt.tier).toBe("browser_wasm");
    rec.abort();
  });

  it("prefers Android Native STT on APK whenever Local Worker STT is not confirmed ready (even when Google STT is configured or health is null)", () => {
    vi.stubGlobal("ViReadNativeSpeech", { postMessage: vi.fn() });

    // Cold start (health === null) -> prefer Android Native immediately
    expect(shouldPreferAndroidNativeStt()).toBe(true);

    // Local down, Google STT configured -> still prefer Android Native (offline-first!)
    setCachedVoiceEngineHealth({
      default_mode: "local_with_google_fallback",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    expect(shouldPreferAndroidNativeStt()).toBe(true);

    // Local Worker healthy & stt_ready -> Tier 1 Local Worker wins
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: true, stt_ready: true, tts_ready: true },
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    expect(shouldPreferAndroidNativeStt()).toBe(false);
  });

  it("evaluateRecordedShortWord tries On-Device Offline WASM BEFORE Cloud backend STT when local worker is unavailable", async () => {
    vi.stubGlobal("Worker", makeFakeWasmWorkerClass({ decodeText: "mèo" }));
    if (!globalThis.crypto?.subtle) {
      vi.stubGlobal("crypto", { subtle: { digest: vi.fn() } });
    }
    setCachedVoiceEngineHealth({
      default_mode: "local_with_google_fallback",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });

    const cloudTranscribe = vi.fn().mockResolvedValue({
      text: "mèo",
      language_code: "vi",
      language_probability: 0.99,
      words: [],
    });

    const res = await evaluateRecordedShortWord({
      expectedWord: "mèo",
      audioBlob: encodeFloat32ToWav16kBlob(new Float32Array(3200).fill(0.05)),
      speechService: { transcribe: cloudTranscribe },
    });

    expect(res.source).toBe("BROWSER_WASM");
    expect(res.status).toBe("CORRECT");
    expect(cloudTranscribe).not.toHaveBeenCalled();
  });

  it("voice-preloader warms On-Device WASM even when Google STT is configured if local worker is unavailable", async () => {
    let wasmInitCalled = 0;
    vi.stubGlobal(
      "Worker",
      makeFakeWasmWorkerClass({
        onInit: () => {
          wasmInitCalled += 1;
        },
      }),
    );
    if (!globalThis.crypto?.subtle) {
      vi.stubGlobal("crypto", { subtle: { digest: vi.fn() } });
    }
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            default_mode: "local_with_google_fallback",
            default_voice_id: "local_north_truc_ly",
            local: {
              configured: true,
              available: false,
              stt_ready: false,
              tts_ready: false,
            },
            google: {
              stt_configured: true,
              tts_configured: true,
              stt_cooldown: false,
              tts_cooldown: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    setCachedVoiceEngineHealth({
      default_mode: "local_with_google_fallback",
      default_voice_id: "local_north_truc_ly",
      local: {
        configured: true,
        available: false,
        stt_ready: false,
        tts_ready: false,
      },
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });

    await preloadReadingVoiceEngines({ warmTts: false });
    expect(wasmInitCalled).toBe(1);
    expect(getVoicePreloadState().sttEngineLabel).toBe("Offline (WASM)");
    expect(getVoicePreloadState().sttStatus).toBe("ready");
  });

  it("flushes crisp 100ms 1-syllable first words (>= 90ms MIN_SPEECH_MS) and exposes whenAudioGraphReady()", async () => {
    const transcribe = vi.fn();
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "s-short", pageId: "p-1" }),
    );
    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
      flushCurrentSegment: (carry?: boolean) => void;
      resetSegmentState: () => void;
      audioGraphReady: boolean;
    };
    const flushSpy = vi
      .spyOn(internal, "flushCurrentSegment")
      .mockImplementation(() => {
        internal.resetSegmentState();
      });

    internal.active = true;
    internal.audioGraphReady = true;
    expect(await rec.whenAudioGraphReady(100)).toBe(true);

    // 100ms (1600 samples = 5 frames of 320 samples @ 16kHz) of voiced speech + 500ms silence
    const voiced20ms = new Float32Array(320);
    for (let i = 0; i < voiced20ms.length; i += 1) {
      voiced20ms[i] = 0.06 * Math.sin((2 * Math.PI * 300 * i) / 16_000);
    }
    const silent20ms = new Float32Array(320).fill(0.0001);
    for (let i = 0; i < 5; i += 1) internal.consumeSamples16k(voiced20ms);
    for (let i = 0; i < 25; i += 1) internal.consumeSamples16k(silent20ms);

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });
});
