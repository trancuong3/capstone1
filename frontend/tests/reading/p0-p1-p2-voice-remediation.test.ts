import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/api/service-error";
import type { SpeechService } from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";
import { EchoGuard } from "@/lib/reading/echo-guard";
import { InteractivePromptSelector } from "@/lib/reading/interactive-prompts";
import {
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
  type SegmentSpeechEvent,
  type SegmentSpeechRecognitionLike,
} from "@/lib/reading/local-segment-speech-recognition";
import { generateSpokenPhonicsGuide } from "@/lib/reading/phonics-spelling";
import {
  getSessionVoiceAudit,
  getSessionVoiceLock,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  setActiveVoiceSession,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import {
  getFreshVoiceEngineHealth,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
  VOICE_HEALTH_FRESHNESS_MS,
} from "@/lib/reading/voice-engine-status";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";

/**
 * Simulates real browser WebIDL SpeechRecognitionResult where `isFinal`, `length`,
 * and indexed alternatives live on non-enumerable prototype getters — so `{ ...item }`
 * drops `isFinal` and `length`.
 */
class WebIdlSpeechRecognitionResult {
  private readonly _isFinal: boolean;
  private readonly _alts: Array<{
    readonly transcript: string;
    readonly confidence: number;
  }>;

  constructor(isFinal: boolean, transcript: string, confidence = 0.94) {
    this._isFinal = isFinal;
    this._alts = [{ transcript, confidence }];
    Object.defineProperty(this, 0, {
      enumerable: false,
      get: () => this._alts[0],
    });
  }

  get isFinal(): boolean {
    return this._isFinal;
  }

  get length(): number {
    return this._alts.length;
  }
}

class FakeBrowserSpeechRec implements SegmentSpeechRecognitionLike {
  static instances: FakeBrowserSpeechRec[] = [];
  continuous = true;
  interimResults = true;
  lang = "vi-VN";
  maxAlternatives = 1;
  onresult: ((event: SegmentSpeechEvent) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart?: (() => void) | null = null;
  onsoundstart?: (() => void) | null = null;
  starts = 0;
  aborted = false;
  stopped = false;

  constructor() {
    FakeBrowserSpeechRec.instances.push(this);
  }

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stopped = true;
    this.onend?.();
  }

  abort(): void {
    this.aborted = true;
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  sent: Array<string | ArrayBuffer> = [];
  closed = false;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe("P0 / P1 / P2 voice engine remediation suite", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeBrowserSpeechRec.instances = [];
    FakeWebSocket.instances = [];
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetLocalSttEmergencyStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>)
      .webkitSpeechRecognition;
  });

  it("P0-1 & P0-2 & P1-17: preserves WebIDL SpeechRecognitionResult isFinal/length, keeps resultsHistory dense across restarts, and captures onsetAt", () => {
    (
      window as unknown as {
        SpeechRecognition?: new () => SegmentSpeechRecognitionLike;
      }
    ).SpeechRecognition = FakeBrowserSpeechRec;

    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });
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

    const speechService: SpeechService = {
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    };
    const rec = new LocalSegmentSpeechRecognition(speechService, () => ({
      sessionId: "sess-p0",
      pageId: "page-1",
    }));

    const received: SegmentSpeechEvent[] = [];
    rec.onresult = (ev) => received.push(ev);
    rec.start();

    expect(FakeBrowserSpeechRec.instances).toHaveLength(1);
    const native = FakeBrowserSpeechRec.instances[0];

    // Simulate speech onset right after TTS ended (P1-17)
    const guard = new EchoGuard();
    const ttsStart = performance.now();
    guard.playbackStarted("tts-1", "Mèo", ttsStart);
    guard.playbackEnded("tts-1", ttsStart + 400);
    vi.advanceTimersByTime(700); // now = ttsStart + 700 > endedAt + 250ms onsetGraceMs
    native.onspeechstart?.();

    // Emit out-of-order WebIDL results (index 0 interim, index 1 final) -> previously created sparse hole + lost isFinal!
    const r0 = new WebIdlSpeechRecognitionResult(false, "đang nói");
    const r1 = new WebIdlSpeechRecognitionResult(true, "Mèo", 0.95);
    native.onresult?.({
      resultIndex: 0,
      results: {
        length: 2,
        0: r0 as unknown as SegmentSpeechEvent["results"][number],
        1: r1 as unknown as SegmentSpeechEvent["results"][number],
      },
    });

    expect(received).toHaveLength(1);
    const firstEv = received[0];
    expect(firstEv.results.length).toBe(2);
    // Dense index 0 is the committed final result with preserved WebIDL getters!
    expect(firstEv.results[0]).toBeDefined();
    expect(firstEv.results[0].isFinal).toBe(true);
    expect(firstEv.results[0].length).toBe(1);
    expect(firstEv.results[0][0].transcript).toBe("Mèo");
    expect(firstEv.results[0].onsetAt).not.toBeNull();
    // EchoGuard accepts child repeat using real onsetAt!
    expect(
      guard.evaluate({
        text: firstEv.results[0][0].transcript,
        receivedAt: performance.now(),
        onsetAt: firstEv.results[0].onsetAt ?? null,
      }).accept,
    ).toBe(true);
    // Dense index 1 is the uncommitted interim (zero undefined holes!)
    expect(firstEv.results[1]).toBeDefined();
    expect(firstEv.results[1].isFinal).toBe(false);

    // Trigger restart and verify second cycle stays 100% dense with zero undefined slots
    native.onend?.();
    vi.advanceTimersByTime(100);
    expect(native.starts).toBe(2);

    const r2 = new WebIdlSpeechRecognitionResult(true, "con", 0.92);
    native.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: r2 as unknown as SegmentSpeechEvent["results"][number],
      },
    });
    const secondEv = received[1];
    expect(secondEv.results.length).toBe(2);
    for (let i = 0; i < secondEv.results.length; i += 1) {
      expect(secondEv.results[i]).toBeDefined();
      expect(secondEv.results[i].isFinal).toBe(true);
    }

    // P1-13: visibilitychange / android-background listener stays attached during Browser fallback!
    document.dispatchEvent(new Event("viread:android-background"));
    expect(native.aborted).toBe(true);
  });

  it("P1-11: browser fallback applies exponential backoff and stops after 3 consecutive network errors", () => {
    (
      window as unknown as {
        SpeechRecognition?: new () => SegmentSpeechRecognitionLike;
      }
    ).SpeechRecognition = FakeBrowserSpeechRec;

    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });
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

    const rec = new LocalSegmentSpeechRecognition({
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    });
    const ended = vi.fn();
    rec.onend = ended;
    rec.start();
    const native = FakeBrowserSpeechRec.instances[0];
    expect(native.starts).toBe(1);

    // Error 1 -> NOT synchronous restart, waits 500ms
    native.onerror?.({ error: "network" });
    native.onend?.();
    expect(native.starts).toBe(1);
    vi.advanceTimersByTime(499);
    expect(native.starts).toBe(1);
    vi.advanceTimersByTime(1);
    expect(native.starts).toBe(2);

    // Error 2 -> waits 1000ms
    native.onerror?.({ error: "network" });
    native.onend?.();
    vi.advanceTimersByTime(999);
    expect(native.starts).toBe(2);
    vi.advanceTimersByTime(1);
    expect(native.starts).toBe(3);

    // Error 3 -> terminates cleanly without restarting again
    native.onerror?.({ error: "network" });
    native.onend?.();
    vi.advanceTimersByTime(10_000);
    expect(native.starts).toBe(3);
    expect(ended).toHaveBeenCalledOnce();
  });

  it("P1-3, P1-4, P1-12, P1-13: emits local-stt-unavailable in local_only, avoids preRoll RMS dilution, propagates WS fallback 503, and closes leaked WS on fallback", async () => {
    (
      window as unknown as {
        SpeechRecognition?: new () => SegmentSpeechRecognitionLike;
      }
    ).SpeechRecognition = FakeBrowserSpeechRec;

    // 1. P1-4 client RMS & activeSpeechMs: 450ms quiet preRoll + 250ms soft speech (0.004) + 520ms silence => NOT LOW_VOLUME
    const transcribeMock = vi.fn().mockRejectedValue(
      new ServiceError({
        code: "STT_TEMPORARILY_UNAVAILABLE",
        message: "local down",
        status: 503,
        request_id: "r1",
        retryable: true,
      }),
    );
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
    });
    const rec = new LocalSegmentSpeechRecognition(
      { synthesize: vi.fn(), transcribe: transcribeMock },
      () => ({ sessionId: "s1", pageId: "p1" }),
    );
    const errors: Array<{ error?: string }> = [];
    rec.onerror = (e) => errors.push(e);

    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
      computeAudioQuality: (ms: number) => { status: string; rms: number };
      segmentPreRollSamples: number;
      segmentVoicedSamples: number;
      ws: FakeWebSocket | null;
      wsReady: boolean;
      wsPendingByTurnId: Map<string, unknown>;
      fallbackAllPendingWsSegments: () => void;
      tryActivateBrowserFallback: () => boolean;
      recordTechnicalFailureAndMaybeFallback: () => boolean;
    };
    internal.active = true;

    // Push 450ms quiet pre-roll
    for (let i = 0; i < 15; i += 1) {
      const quiet = new Float32Array(512).fill(0.0005);
      internal.consumeSamples16k(quiet);
    }
    // Push ~256ms soft child speech (amplitude 0.004 -> rms = 0.004, peak = 0.004 < 0.01)
    for (let i = 0; i < 8; i += 1) {
      const soft = new Float32Array(512).fill(0.004);
      internal.consumeSamples16k(soft);
    }
    expect(internal.segmentPreRollSamples).toBeGreaterThan(4000);
    expect(internal.segmentVoicedSamples).toBe(8 * 512);
    const q = internal.computeAudioQuality(256);
    expect(q.status).toBe("OK");
    expect(q.rms).toBeGreaterThanOrEqual(0.0039);

    // 2. P1-3: in local_only mode, 2 technical failures emit "local-stt-unavailable" to UI
    expect(internal.recordTechnicalFailureAndMaybeFallback()).toBe(false);
    expect(internal.recordTechnicalFailureAndMaybeFallback()).toBe(false);
    expect(errors).toEqual([{ error: "local-stt-unavailable" }]);

    // 3. P1-13: tryActivateBrowserFallback closes open WebSocket cleanly (no WS leak!)
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });
    const fakeWs = new FakeWebSocket("ws://127.0.0.1:8010/stt/stream");
    internal.ws = fakeWs;
    internal.wsReady = true;
    expect(internal.tryActivateBrowserFallback()).toBe(true);
    expect(fakeWs.closed).toBe(true);
  });

  it("P0-5 & P1-2 & P1-14 & P2-4: playBrowserSpeech avoids sync cancel+speak & uses watchdog; prefetch skips backend when local+google down; gender-aware voice pick; auditUtterance runs after resolution", async () => {
    expect(VOICE_HEALTH_FRESHNESS_MS).toBeGreaterThanOrEqual(60_000);

    // P1-2: prefetch skips backend when health shows local down + google unconfigured
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
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
    expect(getFreshVoiceEngineHealth()).not.toBeNull();

    const maleVoice = {
      lang: "vi-VN",
      name: "Microsoft NamMinh Online (Natural) - Vietnamese",
    } as SpeechSynthesisVoice;
    const femaleVoice = {
      lang: "vi-VN",
      name: "Microsoft HoaiMy Online (Natural) - Vietnamese",
    } as SpeechSynthesisVoice;

    let voicesList: SpeechSynthesisVoice[] = [];
    const listeners = new Map<string, Array<() => void>>();
    const spokenUtterances: Array<{
      text: string;
      voice: SpeechSynthesisVoice | null;
    }> = [];
    const callOrder: string[] = [];

    class FakeUtterance {
      lang = "";
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onboundary: ((ev: { charIndex: number }) => void) | null = null;
      constructor(public readonly text: string) {}
    }

    const fakeSynth = {
      speaking: true,
      pending: false,
      getVoices: vi.fn(() => voicesList),
      addEventListener: vi.fn((ev: string, fn: () => void) => {
        listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
      }),
      removeEventListener: vi.fn(),
      cancel: vi.fn(() => {
        callOrder.push("cancel");
        fakeSynth.speaking = false;
      }),
      speak: vi.fn((u: FakeUtterance) => {
        callOrder.push("speak");
        spokenUtterances.push({ text: u.text, voice: u.voice });
        // Simulate Chrome/WebView swallowing `onend` completely (never calls onstart/onend)!
      }),
      pause: vi.fn(),
      resume: vi.fn(),
    };

    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: fakeSynth,
    });

    lockSessionVoice("sess-tts-p05", {
      voiceId: "local_north_thien_minh",
      forceUpdate: true,
    });
    setActiveVoiceSession("sess-tts-p05");

    const speechMock: SpeechService = {
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    };
    const studioMock = {} as VoiceStudioService;
    const playback = new TtsPlayback(speechMock, studioMock);

    // P1-2: prefetch does NOT call speech.synthesize when skipping backend for browser fallback
    await playback.prefetch("Đáp án B: Quả táo.");
    expect(speechMock.synthesize).not.toHaveBeenCalled();

    // P0-5 + P1-2: play waits for voiceschanged when getVoices() is initially [], selects male voice,
    // defers speak() after cancel() instead of calling synchronously, and resolves via watchdog even when onend never fires!
    const playPromise = playback.play("Chào con.");
    // Flush microtasks so playBrowserSpeech finishes waitIfPaused() and registers voiceschanged
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
    expect(fakeSynth.addEventListener).toHaveBeenCalledWith(
      "voiceschanged",
      expect.any(Function),
      { once: true },
    );
    // Deliver voices asynchronously
    voicesList = [femaleVoice, maleVoice];
    listeners.get("voiceschanged")?.forEach((fn) => fn());
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }

    // cancel() ran, speak() MUST NOT have fired synchronously in the same tick
    expect(callOrder).toEqual(["cancel"]);
    vi.advanceTimersByTime(45);
    expect(callOrder).toEqual(["cancel", "speak"]);
    expect(spokenUtterances[0]?.voice?.name).toBe(maleVoice.name);

    // Advance watchdog past 3.5s when synth is idle & onend swallowed -> resolves cleanly (never hangs!)
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(playPromise).resolves.toBeUndefined();
    expect(getSessionVoiceAudit("sess-tts-p05")).toHaveLength(1);
  });

  it("P1-10: male Thầy persona preserves quoted story characters ('Cô Tấm gặp cô tiên') while adapting teacher self-reference", () => {
    expect(
      adaptTextToTeacherPersona(
        "Cô mời con đọc câu “Cô Tấm gặp cô tiên” cùng cô nhé!",
        "male",
      ),
    ).toBe("Thầy mời con đọc câu “Cô Tấm gặp cô tiên” cùng thầy nhé!");

    const selector = new InteractivePromptSelector();
    const prompt = selector.next(
      "comfortStep3Phrase",
      { phrase: "Cô Tấm gặp cô tiên" },
      "male",
    );
    expect(prompt).toContain("Cô Tấm gặp cô tiên");
    expect(prompt).toContain("thầy");
  });

  it("P2-2: sanitizeSessionLock preserves gender field across sessionStorage reloads", () => {
    window.sessionStorage.setItem(
      "viread.session-voice-lock.v1.sess-reload",
      JSON.stringify({
        sessionId: "sess-reload",
        provider: "local",
        voiceId: "local_north_thien_minh",
        gender: "male",
        region: "north",
        modelVersion: "vieneu-v3-turbo-onnx-hybrid-3.8.5",
        speed: 0.9,
        lockedAt: "2026-11-26T00:00:00.000Z",
      }),
    );
    const restored = getSessionVoiceLock("sess-reload");
    expect(restored).not.toBeNull();
    expect(restored?.gender).toBe("male");
  });

  it("P0-4 & P1-12: rolling interim strictly pins local_only/allowGoogleStt:false, and WS->HTTP 503 propagates to technical failure fallback", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });

    const transcribeMock = vi
      .fn()
      .mockResolvedValueOnce({ text: "mèo con", words: [] })
      .mockRejectedValue(
        new ServiceError({
          code: "STT_TEMPORARILY_UNAVAILABLE",
          message: "local down",
          status: 503,
          request_id: "r-ws-fb",
          retryable: true,
        }),
      );

    const rec = new LocalSegmentSpeechRecognition(
      { synthesize: vi.fn(), transcribe: transcribeMock },
      () => ({ sessionId: "s-p04", pageId: "p-1", keyterms: ["mèo con"] }),
    );
    const errors: Array<{ error?: string }> = [];
    rec.onerror = (e) => errors.push(e);

    const internal = rec as unknown as {
      active: boolean;
      inSpeech: boolean;
      speechChunks: Float32Array[];
      speechSamples: number;
      segmentVoicedSamples: number;
      segmentSumSq: number;
      segmentPeak: number;
      dispatchRollingInterim: () => void;
      wsPendingByTurnId: Map<
        string,
        {
          turnId: string;
          audioToEncode: Float32Array;
          capturedInterims: readonly string[];
          keyterms?: readonly string[];
          sessionId: string | null;
          pageId: string | null;
          capturedEpoch: number;
          settled: boolean;
          fallbackTimer: ReturnType<typeof setTimeout>;
          resolve: (value: unknown) => void;
        }
      >;
      fallbackAllPendingWsSegments: () => void;
    };
    internal.active = true;
    internal.inSpeech = true;
    const chunk = new Float32Array(8000).fill(0.05);
    internal.speechChunks = [chunk];
    internal.speechSamples = chunk.length;
    internal.segmentVoicedSamples = chunk.length;
    internal.segmentSumSq = chunk.length * 0.05 * 0.05;
    internal.segmentPeak = 0.05;

    // P0-4: rolling interim MUST pass providerMode: "local_only" and allowGoogleStt: false even when user policy allows Google fallback
    internal.dispatchRollingInterim();
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
    }
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    const interimOptions = transcribeMock.mock.calls[0]?.[1];
    expect(interimOptions).toMatchObject({
      source: "local_live_interim",
      providerMode: "local_only",
      allowGoogleStt: false,
    });

    // P1-12: WS->HTTP fallback 503 must call recordTechnicalFailureAndMaybeFallback() instead of swallowing error
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const turnId = `turn-fb-${attempt}`;
      internal.wsPendingByTurnId.set(turnId, {
        turnId,
        audioToEncode: new Float32Array(3200).fill(0.05),
        capturedInterims: [],
        sessionId: "s-p04",
        pageId: "p-1",
        capturedEpoch: 0,
        settled: false,
        fallbackTimer: setTimeout(() => {}, 5_000),
        resolve: vi.fn(),
      });
      internal.fallbackAllPendingWsSegments();
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    }
    expect(errors).toEqual([{ error: "local-stt-unavailable" }]);
  });

  it("P1-17: Browser STT captures onsetAt via first interim even without onspeechstart so child repeat is accepted while EchoGuard preserves 1500ms tail protection when onsetAt is absent", () => {
    (
      window as unknown as {
        SpeechRecognition?: new () => SegmentSpeechRecognitionLike;
      }
    ).SpeechRecognition = FakeBrowserSpeechRec;

    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });
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

    const guard = new EchoGuard();
    const ttsStart = performance.now();
    guard.playbackStarted("tts-model", "Mèo", ttsStart);
    guard.playbackEnded("tts-model", ttsStart + 500);

    // Without onsetAt, calibrated 1500ms tail-overlap window still blocks TTS echo at 1000ms
    expect(
      guard.evaluate({
        text: "Mèo",
        receivedAt: ttsStart + 1500,
        onsetAt: null,
      }),
    ).toMatchObject({ accept: false, reason: "tail-overlap" });

    // With Browser STT fallback (even if WebView skips onspeechstart), first interim stamps onsetAt >= endedAt + 250ms
    const rec = new LocalSegmentSpeechRecognition({
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    });
    const received: SegmentSpeechEvent[] = [];
    rec.onresult = (ev) => received.push(ev);
    rec.start();
    const native = FakeBrowserSpeechRec.instances[0];

    vi.advanceTimersByTime(850); // 350ms after ttsEnd (> 250ms onsetGraceMs)
    native.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: new WebIdlSpeechRecognitionResult(
          false,
          "Mèo",
        ) as unknown as SegmentSpeechEvent["results"][number],
      },
    });
    vi.advanceTimersByTime(200); // 550ms after ttsEnd (inside 1500ms tailMs, but real onsetAt is known!)
    native.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: new WebIdlSpeechRecognitionResult(
          true,
          "Mèo",
        ) as unknown as SegmentSpeechEvent["results"][number],
      },
    });

    const finalItem = received[1]?.results[0];
    expect(finalItem?.isFinal).toBe(true);
    expect(finalItem?.onsetAt).not.toBeNull();
    expect(
      guard.evaluate({
        text: finalItem![0].transcript,
        receivedAt: performance.now(),
        onsetAt: finalItem!.onsetAt ?? null,
      }),
    ).toMatchObject({ accept: true, reason: "ok" });
  });

  it("P1-17 (continuous utterance #2): already-committed final slot 0 must NOT wipe browserSpeechOnsetAt during utterance #2 interim", () => {
    (
      window as unknown as {
        SpeechRecognition?: new () => SegmentSpeechRecognitionLike;
      }
    ).SpeechRecognition = FakeBrowserSpeechRec;

    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });
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

    const guard = new EchoGuard();
    const rec = new LocalSegmentSpeechRecognition({
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    });
    const received: SegmentSpeechEvent[] = [];
    rec.onresult = (ev) => received.push(ev);
    rec.start();
    const native = FakeBrowserSpeechRec.instances[0];

    // Utterance #1 finalizes at slot 0
    const u1Final = new WebIdlSpeechRecognitionResult(true, "Xin chào", 0.95);
    native.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: u1Final as unknown as SegmentSpeechEvent["results"][number],
      },
    });
    expect(received).toHaveLength(1);

    // TTS models "Quả táo" and finishes at t = ttsEnd
    const ttsStart = performance.now();
    guard.playbackStarted("tts-u2", "Quả táo", ttsStart);
    guard.playbackEnded("tts-u2", ttsStart + 400);

    // Child starts speaking Utterance #2 350ms after TTS ends (> 250ms onsetGraceMs)
    vi.advanceTimersByTime(750);
    native.onspeechstart?.();

    // Browser fires interim for Utterance #2 alongside already-committed final slot 0
    const u2Interim = new WebIdlSpeechRecognitionResult(false, "Quả", 0);
    native.onresult?.({
      resultIndex: 1,
      results: {
        length: 2,
        0: u1Final as unknown as SegmentSpeechEvent["results"][number],
        1: u2Interim as unknown as SegmentSpeechEvent["results"][number],
      },
    });

    // Utterance #2 finalizes 250ms later (still within 1500ms tailMs -> would be rejected if onsetAt were wiped!)
    vi.advanceTimersByTime(250);
    const u2Final = new WebIdlSpeechRecognitionResult(true, "Quả táo", 0.96);
    native.onresult?.({
      resultIndex: 1,
      results: {
        length: 2,
        0: u1Final as unknown as SegmentSpeechEvent["results"][number],
        1: u2Final as unknown as SegmentSpeechEvent["results"][number],
      },
    });

    const latestEv = received[received.length - 1];
    const u2Item = latestEv?.results[1];
    expect(u2Item?.isFinal).toBe(true);
    expect(u2Item?.[0].transcript).toBe("Quả táo");
    expect(u2Item?.onsetAt).not.toBeNull();
    expect(
      guard.evaluate({
        text: u2Item![0].transcript,
        receivedAt: performance.now(),
        onsetAt: u2Item!.onsetAt ?? null,
      }),
    ).toMatchObject({ accept: true, reason: "ok" });
  });

  it("P1-3 (stop drain): local_only emits local-stt-unavailable even when failure happens while stopping=true, but not after abort()", () => {
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
    });
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

    const rec = new LocalSegmentSpeechRecognition({
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    });
    const errors: Array<{ error?: string }> = [];
    rec.onerror = (e) => errors.push(e);

    const internal = rec as unknown as {
      active: boolean;
      stopping: boolean;
      recordTechnicalFailureAndMaybeFallback: () => boolean;
    };
    internal.active = true;
    internal.stopping = true;
    expect(internal.recordTechnicalFailureAndMaybeFallback()).toBe(false);
    expect(errors).toEqual([{ error: "local-stt-unavailable" }]);

    // After abort(), active is false so no error is emitted
    const rec2 = new LocalSegmentSpeechRecognition({
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    });
    const errors2: Array<{ error?: string }> = [];
    rec2.onerror = (e) => errors2.push(e);
    const internal2 = rec2 as unknown as {
      active: boolean;
      stopping: boolean;
      recordTechnicalFailureAndMaybeFallback: () => boolean;
    };
    internal2.active = false;
    internal2.stopping = false;
    internal2.recordTechnicalFailureAndMaybeFallback();
    expect(errors2).toEqual([]);
  });

  it("P1-10: generateSpokenPhonicsGuide preserves book words 'cô' and 'cổ' under male Thầy persona", () => {
    const guideCo = generateSpokenPhonicsGuide("cô", "male");
    expect(guideCo).toContain("thầy");
    expect(guideCo).toContain("cờ... ô... cô");
    expect(guideCo).toContain("Đọc trơn là: cô.");
    expect(guideCo).not.toContain("Đọc trơn là: thầy");

    const guideCoHoi = generateSpokenPhonicsGuide("cổ", "male");
    expect(guideCoHoi).toContain("thầy");
    expect(guideCoHoi).toContain("cờ... ô... cô... hỏi... cổ");
    expect(guideCoHoi).not.toContain("cờ... ô... thầy");
  });

  it("P1-2: Vietnamese browser voice gender picker handles diacritic endings ('Nữ', 'Mỹ', 'Sơn') and Windows female 'Microsoft An'", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
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

    const voiceAn = {
      lang: "vi-VN",
      name: "Microsoft An - Vietnamese (Vietnam)",
    } as SpeechSynthesisVoice;
    const voiceNu = {
      lang: "vi-VN",
      name: "Tiếng Việt (Nữ)",
    } as SpeechSynthesisVoice;
    const voiceSon = {
      lang: "vi-VN",
      name: "Tiếng Việt Quang Sơn",
    } as SpeechSynthesisVoice;

    const spoken: Array<SpeechSynthesisVoice | null> = [];
    class FakeUtterance {
      lang = "";
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onboundary: ((ev: { charIndex: number }) => void) | null = null;
      constructor(public readonly text: string) {}
    }
    const fakeSynth = {
      speaking: false,
      pending: false,
      getVoices: vi.fn(() => [voiceAn, voiceNu, voiceSon]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel: vi.fn(),
      speak: vi.fn((u: FakeUtterance) => {
        spoken.push(u.voice);
        u.onstart?.();
        u.onend?.();
      }),
      pause: vi.fn(),
      resume: vi.fn(),
    };
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: fakeSynth,
    });

    const playback = new TtsPlayback(
      { synthesize: vi.fn(), transcribe: vi.fn() },
      {} as VoiceStudioService,
    );

    // Male lock -> must pick Quang Sơn, NOT Windows female Microsoft An
    lockSessionVoice("sess-gender-male", {
      voiceId: "local_central_quang_son",
      forceUpdate: true,
    });
    setActiveVoiceSession("sess-gender-male");
    await playback.play("Xin chào.");
    expect(spoken[0]?.name).toBe(voiceSon.name);

    // Female lock with only [voiceSon, voiceNu] -> must match Vietnamese diacritic "Nữ"
    fakeSynth.getVoices.mockReturnValue([voiceSon, voiceNu]);
    lockSessionVoice("sess-gender-female", {
      voiceId: "local_north_truc_ly",
      forceUpdate: true,
    });
    setActiveVoiceSession("sess-gender-female");
    await playback.play("Xin chào.");
    expect(spoken[1]?.name).toBe(voiceNu.name);
  });

  it("P2-4: playPhonicsLesson defers auditUtterance until after Google fallback resolution", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    lockSessionVoice("sess-phonics-audit", {
      voiceId: "local_north_truc_ly",
      forceUpdate: true,
    });
    setActiveVoiceSession("sess-phonics-audit");

    const synthPhonics = vi
      .fn()
      .mockRejectedValueOnce(new Error("local worker down"))
      .mockResolvedValueOnce({
        audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
        durationSeconds: 0.6,
        stepTimings: [{ id: "step-1", index: 0, start: 0, end: 0.5 }],
        provider: "google",
        resolvedVoiceId: "google_vi_vn_neural2_a",
        region: "north",
        modelVersion: "google-cloud-tts-v1",
      });

    class FakeAudio {
      duration = 0.6;
      currentTime = 0;
      paused = false;
      ended = false;
      defaultPlaybackRate = 1;
      playbackRate = 1;
      preservesPitch = true;
      volume = 1;
      src = "";
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeupdate: (() => void) | null = null;
      onloadedmetadata: (() => void) | null = null;
      pause() {
        this.paused = true;
      }
      async play() {
        queueMicrotask(() => {
          this.ended = true;
          this.onended?.();
        });
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:phonics-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const playback = new TtsPlayback(
      {
        synthesize: vi.fn(),
        synthesizePhonics: synthPhonics,
        transcribe: vi.fn(),
      },
      {} as VoiceStudioService,
    );

    await playback.playPhonicsLesson({
      word: "cô",
      displaySyllable: "cô",
      steps: [
        {
          id: "step-1",
          index: 0,
          label: "cô",
          spokenText: "cô",
          pauseAfterMs: 120,
        },
      ],
    } as never);

    const audit = getSessionVoiceAudit("sess-phonics-audit");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.provider).toBe("google");
    expect(audit[0]?.voiceId).toBe("google_vi_vn_neural2_a");
    expect(playback.getFallbackNotice()).toMatch(/giọng dự phòng/i);
  });

  it("P2-4: playWithWordTimings defers auditUtterance until after Local -> Google failover and records provider 'google'", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    lockSessionVoice("sess-timed-audit", {
      voiceId: "local_north_truc_ly",
      forceUpdate: true,
    });
    setActiveVoiceSession("sess-timed-audit");

    const synthTimed = vi
      .fn()
      .mockRejectedValueOnce(new Error("local worker down"))
      .mockResolvedValueOnce({
        audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
        words: [
          { index: 0, text: "Bé", start: 0, end: 0.25 },
          { index: 1, text: "đọc", start: 0.25, end: 0.5 },
        ],
        durationSeconds: 0.5,
        usedFallbackVoice: false,
      });

    class FakeAudio {
      duration = 0.5;
      currentTime = 0;
      paused = false;
      ended = false;
      defaultPlaybackRate = 1;
      playbackRate = 1;
      preservesPitch = true;
      volume = 1;
      src = "";
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeupdate: (() => void) | null = null;
      onloadedmetadata: (() => void) | null = null;
      pause() {
        this.paused = true;
      }
      async play() {
        queueMicrotask(() => {
          this.ended = true;
          this.onended?.();
        });
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:timed-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const playback = new TtsPlayback(
      {
        synthesize: vi.fn(),
        transcribe: vi.fn(),
      },
      {
        listVoices: vi.fn(),
        synthesizeTimed: synthTimed,
      } as unknown as VoiceStudioService,
    );

    const onEnded = vi.fn();
    await playback.playWithWordTimings(["Bé", "đọc"], { onEnded });

    expect(synthTimed).toHaveBeenCalledTimes(2);
    expect(synthTimed).toHaveBeenNthCalledWith(
      1,
      ["Bé", "đọc"],
      expect.objectContaining({ voiceId: "local_north_truc_ly" }),
    );
    expect(synthTimed).toHaveBeenNthCalledWith(
      2,
      ["Bé", "đọc"],
      expect.objectContaining({ voiceId: "google_vi_vn_neural2_a" }),
    );
    expect(onEnded).toHaveBeenCalledTimes(1);

    const audit = getSessionVoiceAudit("sess-timed-audit");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.provider).toBe("google");
    expect(audit[0]?.voiceId).toBe("google_vi_vn_neural2_a");
    expect(audit[0]?.kind).toBe("page_sample");
    expect(playback.getFallbackNotice()).toMatch(/giọng dự phòng/i);

    // SessionVoiceLock remains anchored to local so later utterances auto-recover once local is back.
    const lock = getSessionVoiceLock("sess-timed-audit");
    expect(lock?.provider).toBe("local");
    expect(lock?.voiceId).toBe("local_north_truc_ly");
  });
});
