import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/lib/api/service-error";
import type { SpeechService } from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";
import {
  isTechnicalSttUnavailabilityError,
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
  shouldPreferAndroidNativeStt,
} from "@/lib/reading/local-segment-speech-recognition";
import {
  AndroidNativeSpeechRecognition,
  getAndroidSpeechCapabilities,
  getPostTtsMicSettleMs,
  isAndroidNativeSpeechAvailable,
  notifyAndroidWebAudioEnded,
  openAndroidTtsInstallSettings,
  resetAndroidNativeSpeechBridgeForTests,
  speakWithAndroidNativeTts,
  stopAndroidNativeTts,
  waitForPostTtsMicSettle,
  type ViReadNativeSpeechPort,
} from "@/lib/reading/native-speech-bridge";
import { resetVoiceLockAndPolicyForTests } from "@/lib/reading/session-voice-lock";
import { resetSpeechPreferencesCache } from "@/lib/reading/speech-preferences";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import {
  getVoiceEngineStatus,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";

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

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetAndroidNativeSpeechBridgeForTests();
  resetVoiceLockAndPolicyForTests();
  resetSpeechPreferencesCache();
  resetVoiceEngineStatus();
  resetLocalSttEmergencyStateForTests();
  installAndroidPort(undefined);
});

afterEach(() => {
  resetAndroidNativeSpeechBridgeForTests();
  installAndroidPort(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Android Native Speech Bridge Client (window.ViReadNativeSpeech)", () => {
  it("reports availability and resolves capabilities & install settings", async () => {
    expect(isAndroidNativeSpeechAvailable()).toBe(false);
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);
    expect(isAndroidNativeSpeechAvailable()).toBe(true);

    const capPromise = getAndroidSpeechCapabilities();
    expect(port.sent[0]).toMatchObject({ action: "getCapabilities" });
    const reqId = String(port.sent[0].requestId);
    port.emit({
      type: "capabilities",
      requestId: reqId,
      ttsAvailable: true,
      viVoicesCount: 2,
      sttAvailable: true,
      onDeviceSttAvailable: true,
      platform: "android-webview",
    });

    await expect(capPromise).resolves.toEqual({
      ttsAvailable: true,
      viVoicesCount: 2,
      sttAvailable: true,
      onDeviceSttAvailable: true,
      platform: "android-webview",
    });

    const settingsPromise = openAndroidTtsInstallSettings();
    const settingsReqId = String(port.sent[1].requestId);
    expect(port.sent[1]).toMatchObject({ action: "openTtsInstallSettings" });
    port.emit({ type: "tts_settings_opened", requestId: settingsReqId });
    await expect(settingsPromise).resolves.toBe(true);
  });

  it("bridges Android native TTS with clamped rate, tts_range word sync, and abort stopSpeak", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);

    const onStart = vi.fn();
    const ranges: Array<[number, number]> = [];
    const speakPromise = speakWithAndroidNativeTts("Mèo con đi học", {
      rate: 2.0,
      pitch: 1.0,
      onStart,
      onRangeStart: (s, e) => ranges.push([s, e]),
    });

    expect(port.sent[0]).toMatchObject({
      action: "speak",
      text: "Mèo con đi học",
      rate: 1.4,
      pitch: 1.0,
    });
    const reqId = String(port.sent[0].requestId);
    port.emit({ type: "tts_start", requestId: reqId });
    port.emit({ type: "tts_range", requestId: reqId, start: 0, end: 3 });
    port.emit({ type: "tts_range", requestId: reqId, start: 4, end: 7 });
    port.emit({ type: "tts_done", requestId: reqId });

    await speakPromise;
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(ranges).toEqual([
      [0, 3],
      [4, 7],
    ]);

    const controller = new AbortController();
    const abortedSpeak = speakWithAndroidNativeTts("Xin chào", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(abortedSpeak).rejects.toMatchObject({ name: "AbortError" });
    expect(port.sent.some((m) => m.action === "stopSpeak")).toBe(true);
    stopAndroidNativeTts();
    expect(port.sent.at(-1)?.action).toBe("stopSpeak");
  });

  it("bridges AndroidNativeSpeechRecognition with onsetAt normalization, rmsDb, partial & final alternatives", () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);

    const rec = new AndroidNativeSpeechRecognition();
    const partials: string[] = [];
    const finals: Array<{
      transcript: string;
      alternatives: string[];
      onsetAt: number | null | undefined;
    }> = [];
    const errors: string[] = [];
    const onEnd = vi.fn();

    rec.onresult = (event) => {
      const item = event.results[event.resultIndex];
      if (!item.isFinal) {
        partials.push(item[0].transcript);
      } else {
        const alts: string[] = [];
        for (let i = 0; i < item.length; i += 1) {
          alts.push(item[i].transcript);
        }
        finals.push({
          transcript: item[0].transcript,
          alternatives: alts,
          onsetAt: item.onsetAt,
        });
      }
    };
    rec.onerror = (e) => errors.push(String(e.error));
    rec.onend = onEnd;

    rec.start();
    const startReq = port.sent[0];
    expect(startReq).toMatchObject({
      action: "startStt",
      lang: "vi-VN",
      partialResults: true,
    });
    const reqId = String(startReq.requestId);

    port.emit({ type: "stt_ready", requestId: reqId });
    const epochOnset = Date.now() - 120;
    port.emit({ type: "stt_onset", requestId: reqId, onsetAt: epochOnset });
    port.emit({ type: "stt_rms", requestId: reqId, rmsDb: 7.5 });
    port.emit({ type: "stt_partial", requestId: reqId, transcript: "hoa" });
    port.emit({
      type: "stt_final",
      requestId: reqId,
      transcript: "hoa thơm",
      alternatives: ["hoa thơm", "hoa thôm"],
      onsetAt: epochOnset,
    });
    port.emit({ type: "stt_end", requestId: reqId });

    expect(rec.rmsDb).toBe(7.5);
    expect(typeof rec.onsetAt).toBe("number");
    // Epoch timestamp must be converted to monotonic performance.now() scale (<< 1e12).
    expect(rec.onsetAt!).toBeLessThan(1_000_000_000_000);
    expect(partials).toEqual(["hoa"]);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      transcript: "hoa thơm",
      alternatives: ["hoa thơm", "hoa thôm"],
    });
    expect(finals[0].onsetAt).toBe(rec.onsetAt);
    expect(errors).toEqual([]);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe("Deterministic 0-VND TTS & STT Routing", () => {
  it("routes TTS Tier 1 (precomputed verified-catalog MP3 in Cache Storage) with 0 backend calls and 0 repeat fetches", async () => {
    const cacheStore = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        match: vi.fn(async (url: string) => cacheStore.get(url)?.clone()),
        put: vi.fn(async (url: string, res: Response) => {
          cacheStore.set(url, res);
        }),
      })),
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class InstantAudio {
      duration = 1.2;
      currentTime = 0;
      defaultPlaybackRate = 1;
      playbackRate = 1;
      preservesPitch = true;
      volume = 1;
      paused = false;
      ended = false;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeupdate: (() => void) | null = null;
      onloadedmetadata: (() => void) | null = null;
      play = vi.fn(async () => {
        queueMicrotask(() => {
          this.ended = true;
          this.onended?.();
        });
      });
      pause = vi.fn();
    }
    vi.stubGlobal("Audio", InstantAudio);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:catalog-mp3"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    const speech = {
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    } as unknown as SpeechService;
    const studio = {
      synthesizeTimed: vi.fn(),
      listVoices: vi.fn(),
    } as unknown as VoiceStudioService;

    const player = new TtsPlayback(speech, studio);
    const publicCatalogUrl =
      "https://cdn.example.test/storage/v1/object/public/viread-catalog-tts/truc_ly/1.0/abc123.mp3";

    await player.play("Hoa thơm ngát.", {
      precomputedAudioUrl: publicCatalogUrl,
    });
    await player.play("Hoa thơm ngát.", {
      precomputedAudioUrl: publicCatalogUrl,
    });

    expect(speech.synthesize).not.toHaveBeenCalled();
    // Second play served strictly from Cache Storage (0 bytes egress).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getVoiceEngineStatus().tts.tier).toBe("catalog_cache");
  });

  it("routes TTS Tier 3 (Android Native TTS with tts_range highlighting) immediately when cached /voice/status reports local & Google down", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);

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

    const speech = {
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    } as unknown as SpeechService;
    const studio = {
      synthesizeTimed: vi.fn(),
      listVoices: vi.fn(),
    } as unknown as VoiceStudioService;

    const player = new TtsPlayback(speech, studio);
    const highlighted: number[] = [];

    const playPromise = player.playWithWordTimings(["Hoa", "thơm", "ngát"], {
      text: "Hoa thơm ngát",
      onWordChange: (idx) => highlighted.push(idx),
    });

    // Wait for async waitIfPaused microtasks before speak command dispatch
    await new Promise((r) => setTimeout(r, 0));
    expect(port.sent[0]).toMatchObject({
      action: "speak",
      text: "Hoa thơm ngát",
    });
    const reqId = String(port.sent[0].requestId);
    port.emit({ type: "tts_start", requestId: reqId });
    port.emit({ type: "tts_range", requestId: reqId, start: 4, end: 8 });
    port.emit({ type: "tts_range", requestId: reqId, start: 9, end: 13 });
    port.emit({ type: "tts_done", requestId: reqId });

    await playPromise;

    expect(studio.synthesizeTimed).not.toHaveBeenCalled();
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(highlighted).toEqual([0, 1, 2]);
    expect(getVoiceEngineStatus().tts.tier).toBe("android_native");
  });

  it("handles LOCAL_VOICE_UNCONFIGURED by releasing WebView mic and failing over immediately to Android Native STT", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);

    expect(
      isTechnicalSttUnavailabilityError(
        new ServiceError({
          code: "STT_TEMPORARILY_UNAVAILABLE",
          status: 503,
          request_id: "test-req-1",
          retryable: true,
          message: "LOCAL_VOICE_UNCONFIGURED",
        }),
      ),
    ).toBe(true);

    const onBeforeExternalMicStart = vi.fn();
    const transcribe = vi.fn().mockRejectedValue(
      new ServiceError({
        code: "STT_TEMPORARILY_UNAVAILABLE",
        status: 503,
        request_id: "test-req-2",
        message: "LOCAL_VOICE_UNCONFIGURED",
        retryable: true,
      }),
    );

    const rec = new LocalSegmentSpeechRecognition(
      { transcribe } as unknown as SpeechService,
      undefined,
      undefined,
      onBeforeExternalMicStart,
    );
    const results: string[] = [];
    rec.onresult = (ev) => {
      const item = ev.results[ev.resultIndex];
      if (item.isFinal) results.push(item[0].transcript);
    };

    const internal = rec as unknown as {
      active: boolean;
      consumeSamples16k: (chunk: Float32Array) => void;
    };
    internal.active = true;

    const voiced = new Float32Array(640).fill(0.05);
    const silent = new Float32Array(640).fill(0);
    for (let i = 0; i < 8; i += 1) internal.consumeSamples16k(voiced);
    for (let i = 0; i < 18; i += 1) internal.consumeSamples16k(silent);

    await new Promise((r) => setTimeout(r, 30));

    // Must release parallel MediaRecorder BEFORE Android native SpeechRecognizer starts!
    expect(onBeforeExternalMicStart).toHaveBeenCalledTimes(1);
    const startSttCmd = port.sent.find((m) => m.action === "startStt");
    expect(startSttCmd).toBeTruthy();

    port.emit({
      type: "stt_final",
      requestId: String(startSttCmd?.requestId),
      transcript: "hoa thơm",
      onsetAt: Date.now() - 50,
    });
    expect(results).toEqual(["hoa thơm"]);
    expect(getVoiceEngineStatus().stt.tier).toBe("android_native");
    expect(shouldPreferAndroidNativeStt()).toBe(true);

    rec.abort();
  });

  it("passes optional gender in speak command and parses viMaleVoicesCount / viFemaleVoicesCount in capabilities", async () => {
    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);

    const capsPromise = getAndroidSpeechCapabilities({ forceRefresh: true });
    const capReqId = String(port.sent[0].requestId);
    port.emit({
      type: "capabilities",
      requestId: capReqId,
      ttsAvailable: true,
      viVoicesCount: 5,
      viMaleVoicesCount: 2,
      viFemaleVoicesCount: 3,
      sttAvailable: true,
      onDeviceSttAvailable: true,
      platform: "android-webview",
    });
    const caps = await capsPromise;
    expect(caps).toEqual({
      ttsAvailable: true,
      viVoicesCount: 5,
      viMaleVoicesCount: 2,
      viFemaleVoicesCount: 3,
      sttAvailable: true,
      onDeviceSttAvailable: true,
      platform: "android-webview",
    });

    const speakMale = speakWithAndroidNativeTts("Xin chào", {
      rate: 0.9,
      gender: "male",
    });
    const maleCmd = port.sent.find((m) => m.action === "speak");
    expect(maleCmd).toMatchObject({
      action: "speak",
      text: "Xin chào",
      rate: 0.9,
      gender: "male",
    });
    port.emit({ type: "tts_done", requestId: String(maleCmd?.requestId) });
    await speakMale;

    const speakDefault = speakWithAndroidNativeTts("Chào con");
    const defaultCmd = port.sent.filter((m) => m.action === "speak")[1];
    expect(defaultCmd).not.toHaveProperty("gender");
    port.emit({ type: "tts_done", requestId: String(defaultCmd?.requestId) });
    await speakDefault;
  });

  it("dispatches notifyAudioEnded when Android bridge is present and is a no-op when absent", () => {
    notifyAndroidWebAudioEnded();

    const port = new FakeAndroidSpeechPort();
    installAndroidPort(port);
    notifyAndroidWebAudioEnded();
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({
      action: "notifyAudioEnded",
    });
    expect(typeof port.sent[0].requestId).toBe("string");
  });

  it("computes post-TTS mic settle delay (180ms Android, 80ms desktop, 0ms jsdom) and supports cancellation", async () => {
    const originalUa = navigator.userAgent;
    try {
      // Plain jsdom without bridge -> 0ms
      expect(getPostTtsMicSettleMs()).toBe(0);

      // Android native bridge -> 180ms
      installAndroidPort(new FakeAndroidSpeechPort());
      expect(getPostTtsMicSettleMs()).toBe(180);

      // Desktop browser UA -> 80ms
      delete (window as unknown as { ViReadNativeSpeech?: unknown })
        .ViReadNativeSpeech;
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0",
      });
      expect(getPostTtsMicSettleMs()).toBe(80);

      // Android UA without bridge -> 180ms
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36",
      });
      expect(getPostTtsMicSettleMs()).toBe(180);

      // Cancelable settle wait
      vi.useFakeTimers();
      let cancelled = false;
      const activeWait = waitForPostTtsMicSettle(() => cancelled, 180);
      await vi.advanceTimersByTimeAsync(180);
      expect(await activeWait).toBe(true);

      const cancelledWait = waitForPostTtsMicSettle(() => cancelled, 180);
      await vi.advanceTimersByTimeAsync(90);
      cancelled = true;
      await vi.advanceTimersByTimeAsync(90);
      expect(await cancelledWait).toBe(false);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: originalUa,
      });
    }
  });
});
