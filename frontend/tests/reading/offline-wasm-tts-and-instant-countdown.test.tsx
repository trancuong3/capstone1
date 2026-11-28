import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizePhonicsSpeechTextForTts,
  resetBrowserWasmTtsForTests,
} from "@/lib/reading/browser-wasm-tts";
import { LocalSegmentSpeechRecognition } from "@/lib/reading/local-segment-speech-recognition";
import { buildPhonicsLesson } from "@/lib/reading/phonics-lesson";
import {
  clearSessionDeviceTransports,
  getSessionDeviceTransport,
  inferRegionFromVoiceId,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import {
  getVoiceEngineStatus,
  isPermanentlyHostedLocalUnconfigured,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
  type VoiceEngineHealthSnapshot,
} from "@/lib/reading/voice-engine-status";
import {
  resetVoicePreloaderForTests,
  shouldWarmWasmTts,
  warmWasmTtsIfNeeded,
} from "@/lib/reading/voice-preloader";
import type { SpeechService } from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";

function buildFakeWavBuffer(
  sampleRate = 22050,
  durationSec = 0.4,
): ArrayBuffer {
  const numSamples = Math.round(sampleRate * durationSec);
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1)
      view.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
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
            synthMs: 18,
          },
        } as MessageEvent);
      }
    });
  }

  terminate() {}
}

class MockAudioElement {
  static instances: MockAudioElement[] = [];
  duration = 0.4;
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
    window.setTimeout(() => {
      if (this.paused || this.ended) return;
      this.onloadedmetadata?.();
      this.currentTime = 0.02;
      this.ontimeupdate?.();
    }, 5);
    window.setTimeout(() => {
      if (this.paused || this.ended) return;
      this.currentTime = 0.16;
      this.ontimeupdate?.();
    }, 15);
    window.setTimeout(() => {
      if (this.paused || this.ended) return;
      this.currentTime = 0.3;
      this.ontimeupdate?.();
    }, 25);
    window.setTimeout(() => {
      if (this.paused || this.ended) return;
      this.currentTime = this.duration;
      this.ended = true;
      this.paused = true;
      this.onended?.();
    }, 35);
  });

  pause = vi.fn(() => {
    this.paused = true;
  });
}

describe("Offline WASM Vietnamese TTS, sticky unconfigured latch & countdown standby", () => {
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetVoiceEngineStatus();
    resetVoiceLockAndPolicyForTests();
    resetSpeechPreferencesCache();
    resetBrowserWasmTtsForTests();
    clearSessionDeviceTransports();
    MockWasmTtsWorker.instances = [];
    MockWasmTtsWorker.synthesizedPayloads = [];
    MockAudioElement.instances = [];
    vi.stubGlobal("Worker", MockWasmTtsWorker);
    vi.stubGlobal("Audio", MockAudioElement);
    URL.createObjectURL = vi.fn(() => "blob:mock-wasm-wav");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
  });

  it("normalizes phonics symbols cleanly for natural Vietnamese WASM synthesis", () => {
    expect(normalizePhonicsSpeechTextForTts("bờ + ô → bô")).toBe("bờ, ô, bô");
    expect(normalizePhonicsSpeechTextForTts("nặng — bộ")).toBe("nặng, bộ");
  });

  it("handles Hosted LOCAL_VOICE_UNCONFIGURED + elevenlabs=true + local_only even past 30s health TTL using gender-locked WASM TTS", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleTtsFallback: false,
      allowGoogleSttFallback: false,
    });
    setSpeechPreferences({ voiceId: "local_north_thien_minh", speed: 1.0 });
    lockSessionVoice("hosted-male-wasm", {
      voiceId: "local_north_thien_minh",
      forceUpdate: true,
    });

    // Browser OS speechSynthesis only offers a female voice whose label contains "Miền Nam"
    const synthSpeak = vi.fn();
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [
        {
          name: "Microsoft An - Vietnamese (Miền Nam)",
          voiceURI: "ms-an-vi",
          lang: "vi-VN",
          localService: true,
        },
      ],
      speak: synthSpeak,
      cancel: vi.fn(),
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
        tts_error_code: "LOCAL_VOICE_UNCONFIGURED",
      },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
      elevenlabs: {
        configured: true,
        stt_configured: false,
        tts_configured: true,
        tts_cooldown: false,
      },
    });

    const speechMock: SpeechService = {
      synthesize: vi.fn().mockRejectedValue(
        Object.assign(new Error("LOCAL_VOICE_UNCONFIGURED"), {
          status: 503,
          providerCode: "LOCAL_VOICE_UNCONFIGURED",
        }),
      ),
      transcribe: vi.fn(),
    };
    const studioMock: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn().mockRejectedValue(
        Object.assign(new Error("LOCAL_VOICE_UNCONFIGURED"), {
          status: 503,
          providerCode: "LOCAL_VOICE_UNCONFIGURED",
        }),
      ),
    };

    const player = new TtsPlayback(speechMock, studioMock);

    // 1. Word sample plays via Male WASM TTS immediately and NEVER touches female Microsoft An
    const p1 = player.play("Xin chào", { wordSample: true });
    await vi.runAllTimersAsync();
    await p1;

    expect(MockWasmTtsWorker.synthesizedPayloads).toHaveLength(1);
    expect(MockWasmTtsWorker.synthesizedPayloads[0].gender).toBe("male");
    expect(synthSpeak).not.toHaveBeenCalled();
    expect(getVoiceEngineStatus().tts.tier).toBe("browser_wasm");
    expect(
      getSessionDeviceTransport("hosted-male-wasm::local_north_thien_minh"),
    ).toBe("wasm_tts");

    // 2. Advance past 30_000ms VOICE_HEALTH_FRESHNESS_MS -> permanently latched as hosted unconfigured
    vi.advanceTimersByTime(45_000);
    expect(isPermanentlyHostedLocalUnconfigured()).toBe(true);

    const synthCallsBeforeTimed = (
      speechMock.synthesize as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    const stepChanges: number[] = [];
    const lesson = buildPhonicsLesson("bộ");
    expect(lesson.supported).toBe(true);
    if (lesson.supported) {
      const pPhonics = player.playPhonicsLesson(lesson, {
        onStepChange: (idx) => stepChanges.push(idx),
      });
      await vi.runAllTimersAsync();
      await pPhonics;
      expect(stepChanges.length).toBeGreaterThan(0);
    }

    const wordHighlights: number[] = [];
    const pTimed = player.playWithWordTimings(["Bé", "đọc", "bài"], {
      onWordChange: (idx) => wordHighlights.push(idx),
    });
    await vi.runAllTimersAsync();
    await pTimed;
    // Skipped broken backend timed+short retry after sticky latch engaged
    expect(
      (speechMock.synthesize as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(synthCallsBeforeTimed);
    expect(wordHighlights.length).toBeGreaterThan(0);
    expect(
      MockWasmTtsWorker.synthesizedPayloads.every((p) => p.gender === "male"),
    ).toBe(true);
  });

  it("slices single words at 0ms from cached page AudioBuffer (Tier 0) without calling backend or WASM", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleTtsFallback: false,
    });
    setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 1.0 });
    lockSessionVoice("tier0-page-slice", {
      voiceId: "local_north_truc_ly",
      forceUpdate: true,
    });

    const pageWav = buildFakeWavBuffer(16000, 1.0);
    const decodeAudioData = vi.fn(async () => ({
      sampleRate: 16000,
      length: 16000,
      duration: 1.0,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(16000).fill(0.1),
    }));
    vi.stubGlobal(
      "AudioContext",
      class MockAudioCtx {
        decodeAudioData = decodeAudioData;
        close = vi.fn(async () => undefined);
      },
    );

    const speechMock: SpeechService = {
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    };
    const studioMock: VoiceStudioService = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn().mockResolvedValue({
        audio: new Blob([pageWav], { type: "audio/wav" }),
        durationSeconds: 1.0,
        words: [
          { index: 0, start: 0.05, end: 0.45 },
          { index: 1, start: 0.5, end: 0.9 },
        ],
        provider: "local",
        resolvedVoiceId: "local_north_truc_ly",
      }),
    };

    const player = new TtsPlayback(speechMock, studioMock);
    player.setCacheContext({ pageId: "page-tier0" });

    await player.playWithWordTimings(["Nhà", "mèo"], {});
    await player.play("mèo", { wordSample: true });

    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(speechMock.synthesize).not.toHaveBeenCalled();
    expect(MockWasmTtsWorker.synthesizedPayloads).toHaveLength(0);
  });

  it("never misclassifies North male voice IDs containing 'nam' as southern dialect", () => {
    expect(inferRegionFromVoiceId("local_north_hoang_nam")).toBe("north");
    expect(inferRegionFromVoiceId("local_north_nam_minh")).toBe("north");
    expect(inferRegionFromVoiceId("local_south_thai_son")).toBe("south");
    expect(inferRegionFromVoiceId("custom_mien_nam_female")).toBe("south");
  });

  it("arms standby calibration during 3s countdown, promotes at 0ms, and latches WS LOCAL_VOICE_UNCONFIGURED", async () => {
    vi.stubGlobal(
      "MediaStream",
      class MockMediaStream {
        constructor(public tracks: MediaStreamTrack[]) {}
        getAudioTracks() {
          return this.tracks;
        }
        getTracks() {
          return this.tracks;
        }
      },
    );
    const mockTrack = {
      readyState: "live",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaStreamTrack;
    const mockGain = { gain: { value: 0 }, connect: vi.fn() };
    const mockProcessor = {
      onaudioprocess: null as ((e: unknown) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    vi.stubGlobal(
      "AudioContext",
      class StandbyAudioCtx {
        state = "running";
        sampleRate = 16_000;
        destination = {};
        createMediaStreamSource = () => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        });
        createGain = () => mockGain;
        createScriptProcessor = () => mockProcessor;
        resume = vi.fn(async () => undefined);
        close = vi.fn(async () => undefined);
      },
    );

    const sockets: Array<{
      onmessage: ((e: { data: string }) => void) | null;
      onopen: (() => void) | null;
    }> = [];
    vi.stubGlobal(
      "WebSocket",
      class StandbyWs {
        static OPEN = 1;
        static CONNECTING = 0;
        readyState = 1;
        onopen: (() => void) | null = null;
        onmessage: ((e: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor() {
          sockets.push(this);
        }
        send() {}
        close() {}
      },
    );

    const rec = new LocalSegmentSpeechRecognition(
      { transcribe: vi.fn() } as unknown as SpeechService,
      () => ({ sessionId: "s-standby", pageId: "p-1" }),
      async () => ({ wsUrl: "wss://api.test/voice/stt-stream", token: "tok" }),
    );
    const onResult = vi.fn();
    rec.onresult = onResult;

    const ok = await rec.armStandby(mockTrack);
    expect(ok).toBe(true);
    // Simulate ambient room noise while countdown runs -> must NOT trigger speech or onresult
    const internal = rec as unknown as {
      consumeSamples16k: (chunk: Float32Array) => void;
      preRoll: Float32Array;
      inSpeech: boolean;
    };
    internal.consumeSamples16k(new Float32Array(320).fill(0.08));
    expect(internal.inSpeech).toBe(false);
    expect(internal.preRoll.length).toBe(320);
    expect(onResult).not.toHaveBeenCalled();

    // Countdown hits 0 -> promotes instantaneously
    rec.start(mockTrack);
    expect(await rec.whenAudioGraphReady(0)).toBe(true);
    expect(internal.preRoll.length).toBe(320);

    await vi.waitFor(() => {
      expect(sockets.length).toBeGreaterThan(0);
    });
    sockets[0].onmessage?.({
      data: JSON.stringify({
        type: "error",
        code: "LOCAL_VOICE_UNCONFIGURED",
      }),
    });
    expect(isPermanentlyHostedLocalUnconfigured()).toBe(true);
    rec.abort();
  });

  it("gates background WASM TTS warmup behind healthy server TTS vs offline/unconfigured", async () => {
    resetVoicePreloaderForTests();
    const healthyLocalSnapshot: VoiceEngineHealthSnapshot = {
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: {
        configured: true,
        available: true,
        stt_ready: true,
        tts_ready: true,
        error_code: null,
      },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
      elevenlabs: {
        configured: false,
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    };
    const unconfiguredLocalSnapshot: VoiceEngineHealthSnapshot = {
      ...healthyLocalSnapshot,
      local: {
        configured: false,
        available: false,
        stt_ready: false,
        tts_ready: false,
        error_code: "LOCAL_VOICE_UNCONFIGURED",
      },
    };

    expect(shouldWarmWasmTts(healthyLocalSnapshot)).toBe(false);
    await expect(
      warmWasmTtsIfNeeded("male", healthyLocalSnapshot),
    ).resolves.toBe(false);
    expect(MockWasmTtsWorker.instances).toHaveLength(0);

    expect(shouldWarmWasmTts(unconfiguredLocalSnapshot)).toBe(true);
    await expect(
      warmWasmTtsIfNeeded("male", unconfiguredLocalSnapshot),
    ).resolves.toBe(true);
    expect(MockWasmTtsWorker.instances.length).toBeGreaterThanOrEqual(1);
    resetVoicePreloaderForTests();
  });
});
