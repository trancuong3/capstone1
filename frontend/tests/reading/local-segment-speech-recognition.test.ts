import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/api/service-error";
import type { SpeechService } from "@/lib/api/speech-service";
import {
  isTechnicalSttUnavailabilityError,
  LocalSegmentSpeechRecognition,
  reconcileSegmentTranscriptWithInterims,
  resetLocalSttEmergencyStateForTests,
  type SegmentSpeechEvent,
  type SegmentSpeechRecognitionLike,
} from "@/lib/reading/local-segment-speech-recognition";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import {
  getVoiceEngineStatus,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import type { ReadingPageWordDTO } from "@/types/reading";

const SCREENSHOT_PASSAGE =
  "Nhà em có một chú mèo tên là Miu. Bộ lông của Miu mềm mượt như nhung. Đôi mắt chú tròn xoe và sáng long lanh. Mỗi buổi sáng, Miu thường nằm sưởi nắng ở hiên nhà. Em rất yêu chú mèo của mình.";

const SCREENSHOT_KEYTERMS = SCREENSHOT_PASSAGE.split(/\s+/);

function toWords(text: string): ReadingPageWordDTO[] {
  return text.split(/\s+/).map((word, index) => ({
    word_id: `w-${index}`,
    word_index: index,
    text: word,
    bbox: [0, 0, 1, 1],
  }));
}

describe("reconcileSegmentTranscriptWithInterims", () => {
  it("rescues 'mèo' when rolling interim decoded 'chú mèo tên' and trailing-silence final flipped it to 'chú em tên'", () => {
    const reconciled = reconcileSegmentTranscriptWithInterims(
      "nhà em có một chú em tên là miu",
      ["nhà em có một", "nhà em có một chú mèo tên là miu"],
      SCREENSHOT_KEYTERMS,
    );

    expect(reconciled).toBe("nhà em có một chú mèo tên là miu");

    const engine = new RealtimeAlignmentEngine(
      toWords(SCREENSHOT_PASSAGE),
      3,
      1,
    );
    const snapshot = engine.addFinalTranscript(reconciled);
    expect(snapshot.statusByWordId.get("w-5")?.text).toBe("mèo");
    expect(snapshot.statusByWordId.get("w-5")?.status).toBe("MATCH");
    expect(snapshot.currentWordIndex).toBe(9);
  });

  it("rescues a completed middle word dropped in the final decode when bounded by exact book trigram", () => {
    const reconciled = reconcileSegmentTranscriptWithInterims(
      "nhà em có một chú tên là miu",
      ["nhà em có một chú mèo tên là miu"],
      SCREENSHOT_KEYTERMS,
    );
    expect(reconciled).toBe("nhà em có một chú mèo tên là miu");
  });

  it("rescues leading words corrupted by silence tail when right-anchored to book sequence", () => {
    const reconciled = reconcileSegmentTranscriptWithInterims(
      "kèm có một chú mèo tên là miu",
      ["nhà em có một chú mèo tên là miu"],
      SCREENSHOT_KEYTERMS,
    );
    expect(reconciled).toBe("nhà em có một chú mèo tên là miu");
  });

  it("NEVER hallucinates 'mèo' when child genuinely misread it as 'méo' or 'em' in both interim and final", () => {
    expect(
      reconcileSegmentTranscriptWithInterims(
        "nhà em có một chú méo tên là miu",
        ["nhà em có một chú méo tên là miu"],
        SCREENSHOT_KEYTERMS,
      ),
    ).toBe("nhà em có một chú méo tên là miu");

    expect(
      reconcileSegmentTranscriptWithInterims(
        "nhà em có một chú em tên là miu",
        ["nhà em có một chú em tên là miu"],
        SCREENSHOT_KEYTERMS,
      ),
    ).toBe("nhà em có một chú em tên là miu");
  });

  it("NEVER inserts a skipped word that was absent from both interim and final", () => {
    expect(
      reconcileSegmentTranscriptWithInterims(
        "nhà em có một chú tên là miu",
        ["nhà em có một chú tên là miu"],
        SCREENSHOT_KEYTERMS,
      ),
    ).toBe("nhà em có một chú tên là miu");
  });

  it("NEVER lets an unanchored trailing interim token override a completed tone error in the final", () => {
    // Interim cut off mid-syllable at the very end ("mèo" has no right anchor);
    // final completed the child's actual tone error ("méo"). Final must win!
    expect(
      reconcileSegmentTranscriptWithInterims(
        "nhà em có một chú méo",
        ["nhà em có một chú mèo"],
        SCREENSHOT_KEYTERMS,
      ),
    ).toBe("nhà em có một chú méo");
  });

  it("preserves Vietnamese tones: interim with wrong tone ('meo') never matches 'mèo'", () => {
    expect(
      reconcileSegmentTranscriptWithInterims(
        "nhà em có một chú em tên là miu",
        ["nhà em có một chú meo tên là miu"],
        SCREENSHOT_KEYTERMS,
      ),
    ).toBe("nhà em có một chú em tên là miu");
  });
});

describe("LocalSegmentSpeechRecognition live segment lifecycle", () => {
  it("trims excess 720ms trailing silence on flush and reconciles degraded final against same-segment interim", async () => {
    const uploadedSizes: Record<string, number> = {};
    const transcribe = vi.fn(
      async (blob: Blob, opts?: { filename?: string; source?: string }) => {
        const key = opts?.filename ?? "unknown";
        uploadedSizes[key] = blob.size;
        if (opts?.source === "local_live_interim") {
          return {
            text: "nhà em có một chú mèo tên là miu",
            language_code: "vi",
          };
        }
        return {
          text: "nhà em có một chú em tên là miu",
          language_code: "vi",
        };
      },
    );
    const speechService = { transcribe } as unknown as SpeechService;
    const rec = new LocalSegmentSpeechRecognition(speechService, () => ({
      sessionId: "sess-1",
      pageId: "page-1",
      keyterms: SCREENSHOT_KEYTERMS,
    }));

    const emitted: Array<{ isFinal: boolean; transcript: string }> = [];
    rec.onresult = (ev) => {
      const item = ev.results[ev.resultIndex];
      emitted.push({
        isFinal: item.isFinal,
        transcript: item[0].transcript,
      });
    };

    // Drive internal sample consumer directly (no real WebAudio hardware needed)
    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
    };
    internal.active = true;

    const frameSamples = 640; // 40ms @ 16kHz
    const voicedFrame = new Float32Array(frameSamples).fill(0.05);
    const silentFrame = new Float32Array(frameSamples).fill(0);

    // 400ms of speech -> triggers rolling interim (>= 280ms)
    for (let i = 0; i < 10; i += 1) {
      internal.consumeSamples16k(voicedFrame);
    }
    await Promise.resolve();
    await Promise.resolve();

    // 800ms of trailing silence -> triggers silence flush (>= 720ms)
    for (let i = 0; i < 20; i += 1) {
      internal.consumeSamples16k(silentFrame);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    // WAV header (44B) + 400ms speech (12,800B) + <=180ms trimmed tail (5,760B) << full 1200ms (38,444B)
    expect(uploadedSizes["segment.wav"]).toBeLessThan(26_000);

    const finals = emitted.filter((e) => e.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.transcript).toBe("nhà em có một chú mèo tên là miu");
  });
});

describe("LocalSegmentSpeechRecognition 503 Offline -> Online browser fallback", () => {
  let prevSpeechRecognition: PropertyDescriptor | undefined;
  let prevWebkitSpeechRecognition: PropertyDescriptor | undefined;

  class FakeNativeBrowserSpeechRecognition implements SegmentSpeechRecognitionLike {
    static instances: FakeNativeBrowserSpeechRecognition[] = [];
    continuous = true;
    interimResults = true;
    lang = "vi-VN";
    maxAlternatives = 1;
    onresult: ((event: SegmentSpeechEvent) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    stopped = false;

    constructor() {
      FakeNativeBrowserSpeechRecognition.instances.push(this);
    }

    start(): void {
      this.started = true;
    }

    stop(): void {
      this.stopped = true;
      this.onend?.();
    }

    abort(): void {
      this.stopped = true;
    }

    emitResult(transcript: string, isFinal = true): void {
      this.onresult?.({
        resultIndex: 0,
        results: {
          length: 1,
          0: {
            isFinal,
            length: 1,
            0: { transcript, confidence: 0.94 },
          },
        },
      });
    }
  }

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetLocalSttEmergencyStateForTests();
    FakeNativeBrowserSpeechRecognition.instances = [];
    prevSpeechRecognition = Object.getOwnPropertyDescriptor(
      window,
      "SpeechRecognition",
    );
    prevWebkitSpeechRecognition = Object.getOwnPropertyDescriptor(
      window,
      "webkitSpeechRecognition",
    );
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FakeNativeBrowserSpeechRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: FakeNativeBrowserSpeechRecognition,
    });
  });

  afterEach(() => {
    if (prevSpeechRecognition) {
      Object.defineProperty(window, "SpeechRecognition", prevSpeechRecognition);
    } else {
      Reflect.deleteProperty(window, "SpeechRecognition");
    }
    if (prevWebkitSpeechRecognition) {
      Object.defineProperty(
        window,
        "webkitSpeechRecognition",
        prevWebkitSpeechRecognition,
      );
    } else {
      Reflect.deleteProperty(window, "webkitSpeechRecognition");
    }
  });

  function make503Error(): ServiceError {
    return new ServiceError({
      code: "STT_TEMPORARILY_UNAVAILABLE",
      message: "Local STT worker unavailable",
      status: 503,
      request_id: "req-503",
      retryable: true,
    });
  }

  it("stays 100% local in local_only mode and NEVER invokes browser SpeechRecognition on 503", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
    });
    const transcribe = vi.fn().mockRejectedValue(make503Error());
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "sess-local", pageId: "p-1" }),
    );

    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
    };
    internal.active = true;

    const voiced = new Float32Array(640).fill(0.05);
    const silent = new Float32Array(640).fill(0);
    for (let i = 0; i < 10; i += 1) internal.consumeSamples16k(voiced);
    for (let i = 0; i < 20; i += 1) internal.consumeSamples16k(silent);
    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(FakeNativeBrowserSpeechRecognition.instances).toHaveLength(0);
    expect(getVoiceEngineStatus().stt.tier).toBe("idle");
  });

  it("seamlessly activates browser SpeechRecognition on 503 when Google STT fallback is enabled, forwards onresult, and flips badge to Online", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });
    const transcribe = vi.fn().mockRejectedValue(make503Error());
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "sess-online", pageId: "p-1" }),
    );

    const emitted: Array<{ isFinal: boolean; transcript: string }> = [];
    rec.onresult = (ev) => {
      const item = ev.results[ev.resultIndex];
      emitted.push({
        isFinal: item.isFinal,
        transcript: item[0].transcript,
      });
    };

    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
    };
    internal.active = true;

    const voiced = new Float32Array(640).fill(0.05);
    const silent = new Float32Array(640).fill(0);
    for (let i = 0; i < 10; i += 1) internal.consumeSamples16k(voiced);
    for (let i = 0; i < 20; i += 1) internal.consumeSamples16k(silent);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(FakeNativeBrowserSpeechRecognition.instances).toHaveLength(1);
    const nativeRec = FakeNativeBrowserSpeechRecognition.instances[0]!;
    expect(nativeRec.started).toBe(true);
    expect(nativeRec.lang).toBe("vi-VN");
    expect(nativeRec.continuous).toBe(true);
    expect(nativeRec.interimResults).toBe(true);

    // Voice engine status flipped to Online browser fallback
    const status = getVoiceEngineStatus();
    expect(status.stt.tier).toBe("browser_default");
    expect(status.stt.shortLabel).toBe("Online (Google/Trình duyệt)");
    expect(status.stt.fallbackUsed).toBe(true);
    expect(status.stt.fallbackReason).toBe("LOCAL_STT_UNAVAILABLE");

    // Emitted interim & final results flow cleanly through rec.onresult
    nativeRec.emitResult("nhà em có", false);
    nativeRec.emitResult("nhà em có một chú mèo", true);
    expect(emitted).toEqual([
      { isFinal: false, transcript: "nhà em có" },
      { isFinal: true, transcript: "nhà em có một chú mèo" },
    ]);

    rec.stop();
    expect(nativeRec.stopped).toBe(true);
  });

  it("immediately activates browser Online STT on start() with zero 503 uploads on default policy when cached voice health reports local down and Google unconfigured", () => {
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    const transcribe = vi.fn();
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "sess-default-auto", pageId: "p-1" }),
    );

    rec.start();

    expect(transcribe).not.toHaveBeenCalled();
    expect(FakeNativeBrowserSpeechRecognition.instances).toHaveLength(1);
    expect(FakeNativeBrowserSpeechRecognition.instances[0]?.started).toBe(true);
    expect(getVoiceEngineStatus().stt.tier).toBe("browser_default");
    rec.stop();
  });

  it("does NOT jump to Online on a single transient 503 hiccup — retries Local Offline and recovers with zero Online calls", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });
    let callNum = 0;
    const transcribe = vi.fn(async () => {
      callNum += 1;
      if (callNum === 1) {
        throw make503Error();
      }
      return {
        text: "nhà em có một chú mèo",
        language_code: "vi",
      };
    });
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "sess-transient", pageId: "p-1" }),
    );
    rec.interimResults = false;

    const emitted: Array<{ isFinal: boolean; transcript: string }> = [];
    rec.onresult = (ev) => {
      const item = ev.results[ev.resultIndex];
      emitted.push({
        isFinal: item.isFinal,
        transcript: item[0].transcript,
      });
    };

    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
    };
    internal.active = true;

    const voiced = new Float32Array(640).fill(0.05);
    const silent = new Float32Array(640).fill(0);
    for (let i = 0; i < 10; i += 1) internal.consumeSamples16k(voiced);
    for (let i = 0; i < 20; i += 1) internal.consumeSamples16k(silent);
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Stayed 100% Local Offline — never spawned Browser SpeechRecognition!
    expect(FakeNativeBrowserSpeechRecognition.instances).toHaveLength(0);
    expect(getVoiceEngineStatus().stt.tier).toBe("idle");
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual([
      { isFinal: true, transcript: "nhà em có một chú mèo" },
    ]);
  });

  it("auto-recovers back Online -> Offline when local STT health becomes ready again", () => {
    // First simulate emergency Online state during a confirmed outage
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    const transcribe = vi.fn();
    const rec1 = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "sess-rec-1", pageId: "p-1" }),
    );
    rec1.start();
    expect(getVoiceEngineStatus().stt.tier).toBe("browser_default");
    expect(FakeNativeBrowserSpeechRecognition.instances).toHaveLength(1);
    rec1.stop();

    // Now local worker recovers -> fresh health reports ready!
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: true, stt_ready: true, tts_ready: true },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    const rec2 = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({ sessionId: "sess-rec-2", pageId: "p-1" }),
    );
    rec2.start();

    // Badge restored to Offline (Sherpa-ONNX) and did NOT spawn another browser recognizer!
    expect(getVoiceEngineStatus().stt.tier).toBe("local_offline");
    expect(getVoiceEngineStatus().stt.shortLabel).toBe("Offline");
    expect(FakeNativeBrowserSpeechRecognition.instances).toHaveLength(1);
    rec2.abort();
  });

  it("recognizes all technical 5xx/429/network/code STT unavailability error shapes", () => {
    expect(
      isTechnicalSttUnavailabilityError(
        new ServiceError({
          code: "STT_UNAVAILABLE",
          message: "down",
          status: 504,
          request_id: "r1",
          retryable: true,
        }),
      ),
    ).toBe(true);
    expect(
      isTechnicalSttUnavailabilityError({
        code: "LOCAL_STT_BUSY",
        status: 503,
      }),
    ).toBe(true);
    expect(
      isTechnicalSttUnavailabilityError({
        code: "GOOGLE_STT_UNAVAILABLE",
      }),
    ).toBe(true);
    expect(
      isTechnicalSttUnavailabilityError(new TypeError("Failed to fetch")),
    ).toBe(true);
    expect(
      isTechnicalSttUnavailabilityError(
        new DOMException("aborted", "AbortError"),
      ),
    ).toBe(false);
  });

  it("reduces rolling interim HTTP amplification via VAD voiced gating and speech-pause boundaries", async () => {
    const sources: string[] = [];
    const transcribe = vi.fn(
      async (_blob: Blob, opts?: { source?: string }) => {
        sources.push(opts?.source ?? "unknown");
        return { text: "nhà em có một", language_code: "vi" };
      },
    );
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      () => ({
        sessionId: "sess-vad",
        pageId: "p-1",
        keyterms: SCREENSHOT_KEYTERMS,
      }),
    );

    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
    };
    internal.active = true;

    const frame = 640; // 40ms @ 16kHz
    const voiced = new Float32Array(frame).fill(0.05);
    const silent = new Float32Array(frame).fill(0);

    // 1.6s continuous speech (40 frames) -> gated to <= 4 interims (was 10+ at 160ms step)
    for (let i = 0; i < 40; i += 1) {
      internal.consumeSamples16k(voiced);
      await Promise.resolve();
    }
    const interimsAfterContinuous = sources.filter(
      (s) => s === "local_live_interim",
    ).length;
    expect(interimsAfterContinuous).toBeGreaterThanOrEqual(2);
    expect(interimsAfterContinuous).toBeLessThanOrEqual(4);

    // 600ms trailing silence -> VAD prevents redundant re-uploads over silence, then flushes once
    for (let i = 0; i < 15; i += 1) {
      internal.consumeSamples16k(silent);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    const totalInterims = sources.filter(
      (s) => s === "local_live_interim",
    ).length;
    const totalFinals = sources.filter(
      (s) => s === "local_live_segment",
    ).length;
    expect(totalInterims).toBeLessThanOrEqual(4);
    expect(totalFinals).toBe(1);
  });
});
