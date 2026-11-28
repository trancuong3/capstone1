import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { I18nProvider } from "@/components/i18n/i18n-provider";
import { PhonicsLessonCard } from "@/components/reading/phonics-lesson-card";
import { useKaraokeScoring } from "@/hooks/use-karaoke-scoring";
import { requestApi } from "@/lib/api/api-client";
import { invalidateApiReadCache } from "@/lib/api/read-cache";
import type { SpeechService } from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";
import { browserSingingProvider } from "@/lib/karaoke/recognition-provider";
import {
  acquireUnlockedAudioElement,
  resetAndroidAudioUnlockForTest,
  unlockAudioNow,
} from "@/lib/reading/android-audio-unlock";
import {
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
  shouldPreferAndroidNativeStt,
} from "@/lib/reading/local-segment-speech-recognition";
import {
  getAndroidSpeechCapabilities,
  getCachedAndroidSpeechCapabilities,
  resetAndroidNativeSpeechBridgeForTests,
  type ViReadNativeSpeechPort,
} from "@/lib/reading/native-speech-bridge";
import { buildPhonicsLesson } from "@/lib/reading/phonics-lesson";
import {
  lockSessionVoice,
  releaseSessionVoiceLock,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import {
  fetchVoiceEngineHealth,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
  VOICE_HEALTH_FRESHNESS_MS,
  type VoiceEngineHealthSnapshot,
} from "@/lib/reading/voice-engine-status";
import { syllableLyrics } from "@/test/karaoke-fixtures";
import { viMessages } from "@/messages/vi";

const { getSessionMock, initializeMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  initializeMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: initializeMock,
      getSession: getSessionMock,
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const HOSTED_UNCONFIGURED_HEALTH: VoiceEngineHealthSnapshot = {
  default_mode: "local_only",
  default_voice_id: "local_north_truc_ly",
  local: {
    configured: false,
    mode: "remote",
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
  elevenlabs: {
    configured: true,
    stt_configured: true,
    tts_configured: true,
    model_id: "eleven_flash_v2_5",
    voice_id: "female-voice-only",
  },
};

function installMockNativePort() {
  const sent: Record<string, unknown>[] = [];
  let listener: ((event: { data: string }) => void) | null = null;
  const port: ViReadNativeSpeechPort = {
    postMessage: vi.fn((raw: string) => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      sent.push(parsed);
      if (parsed.action === "speak") {
        const reqId = String(parsed.requestId ?? "");
        queueMicrotask(() => {
          listener?.({
            data: JSON.stringify({
              type: "tts_start",
              requestId: reqId,
              actualVoiceGender: parsed.voiceGender,
            }),
          });
          listener?.({
            data: JSON.stringify({ type: "tts_done", requestId: reqId }),
          });
        });
      }
    }),
    addEventListener: (_type, cb) => {
      listener = cb as (event: { data: string }) => void;
    },
    removeEventListener: (_type, cb) => {
      if (listener === cb) listener = null;
    },
  };
  (
    window as unknown as { ViReadNativeSpeech?: ViReadNativeSpeechPort }
  ).ViReadNativeSpeech = port;
  resetAndroidNativeSpeechBridgeForTests();
  return {
    port,
    sent,
    emit: (payload: Record<string, unknown>) =>
      listener?.({ data: JSON.stringify(payload) }),
  };
}

describe("Phone QA regressions: Android STT/TTS, Karaoke, AudioUnlock, Phonics UI & GET 503 retry", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    initializeMock.mockReset().mockResolvedValue({ error: null });
    getSessionMock.mockReset().mockResolvedValue({
      data: { session: { access_token: "qa-test-token" } },
      error: null,
    });
    resetVoiceEngineStatus();
    resetLocalSttEmergencyStateForTests();
    resetAndroidNativeSpeechBridgeForTests();
    resetAndroidAudioUnlockForTest();
    invalidateApiReadCache();
    setVoicePolicyPreferences({
      region: "north",
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });
  });

  afterEach(() => {
    releaseSessionVoiceLock("sess-phone-qa");
    delete (
      window as unknown as { ViReadNativeSpeech?: ViReadNativeSpeechPort }
    ).ViReadNativeSpeech;
    delete (window as unknown as { webkitSpeechRecognition?: unknown })
      .webkitSpeechRecognition;
    resetAndroidNativeSpeechBridgeForTests();
    resetVoiceEngineStatus();
    resetLocalSttEmergencyStateForTests();
    resetAndroidAudioUnlockForTest();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("speaks immediately via Android native TTS with gender forwarding under hosted LOCAL_VOICE_UNCONFIGURED + local_only + session lock", async () => {
    const { sent } = installMockNativePort();
    // Simulate health fetched 90s ago (> 30s freshness TTL)
    setCachedVoiceEngineHealth(
      HOSTED_UNCONFIGURED_HEALTH,
      Date.now() - VOICE_HEALTH_FRESHNESS_MS * 3,
    );
    lockSessionVoice("sess-phone-qa", {
      voiceId: "local_north_thien_minh",
      forceUpdate: true,
    });

    const synthesize = vi.fn();
    const speech: SpeechService = {
      synthesize,
      transcribe: vi.fn(),
    };
    const studio = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn(),
    } as unknown as VoiceStudioService;

    const player = new TtsPlayback(speech, studio);
    await player.play("Xin chào bé yêu.");

    expect(synthesize).not.toHaveBeenCalled();
    const speakCmd = sent.find((m) => m.action === "speak");
    expect(speakCmd).toBeTruthy();
    expect(speakCmd?.voiceGender).toBe("male");
    expect(speakCmd?.voiceId).toBe("local_north_thien_minh");
    player.dispose();
  });

  it("retains hosted LOCAL_VOICE_UNCONFIGURED beyond 30s TTL so Android STT stays preferred without doomed WS", () => {
    const { sent } = installMockNativePort();
    setCachedVoiceEngineHealth(
      HOSTED_UNCONFIGURED_HEALTH,
      Date.now() - VOICE_HEALTH_FRESHNESS_MS * 4,
    );

    expect(shouldPreferAndroidNativeStt()).toBe(true);

    const onBeforeExternalMicStart = vi.fn();
    const rec = new LocalSegmentSpeechRecognition(
      { transcribe: vi.fn() } as unknown as SpeechService,
      undefined,
      async () => ({
        wsUrl: "wss://example.test/voice/stt-stream",
        token: "t",
      }),
      onBeforeExternalMicStart,
    );
    rec.start();

    expect(onBeforeExternalMicStart).toHaveBeenCalledOnce();
    const startCmd = sent.find((m) => m.action === "startStt");
    expect(startCmd).toBeTruthy();
    expect(startCmd?.preferOnDevice).toBe(true);
    rec.abort();
  });

  it("immediately fails over from WebSocket LOCAL_VOICE_UNCONFIGURED error to Android native STT", async () => {
    const { sent } = installMockNativePort();
    const onBeforeExternalMicStart = vi.fn();

    const sockets: MockWebSocket[] = [];
    class MockWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor() {
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", MockWebSocket);

    const rec = new LocalSegmentSpeechRecognition(
      { transcribe: vi.fn() } as unknown as SpeechService,
      undefined,
      async () => ({
        wsUrl: "wss://example.test/voice/stt-stream",
        token: "t",
      }),
      onBeforeExternalMicStart,
    );

    const internal = rec as unknown as {
      active: boolean;
      openSttWebSocket: () => Promise<void>;
    };
    internal.active = true;
    await internal.openSttWebSocket();
    const fakeSocket = sockets[0];
    expect(fakeSocket).toBeDefined();

    fakeSocket.onmessage?.({
      data: JSON.stringify({
        type: "error",
        code: "LOCAL_VOICE_UNCONFIGURED",
        retryable: false,
      }),
    } as MessageEvent);

    expect(onBeforeExternalMicStart).toHaveBeenCalledOnce();
    expect(sent.some((m) => m.action === "startStt")).toBe(true);
    rec.abort();
    vi.unstubAllGlobals();
  });

  it("prefers Android native SpeechRecognizer for Karaoke even when broken webkitSpeechRecognition exists", () => {
    const { sent, emit } = installMockNativePort();
    const brokenWebkitStart = vi.fn();
    (
      window as unknown as { webkitSpeechRecognition?: unknown }
    ).webkitSpeechRecognition = class BrokenWebkit {
      start = brokenWebkitStart;
      stop = vi.fn();
      abort = vi.fn();
    };

    expect(browserSingingProvider.supported()).toBe(true);
    const rec = browserSingingProvider.create();
    expect(rec).not.toBeNull();
    expect(rec?.managesOwnMicrophone).toBe(true);

    const onstart = vi.fn();
    const onspeechstart = vi.fn();
    const onresult = vi.fn();
    rec!.onstart = onstart;
    rec!.onspeechstart = onspeechstart;
    rec!.onresult = onresult;

    rec!.start();
    expect(brokenWebkitStart).not.toHaveBeenCalled();
    const startCmd = sent.find((m) => m.action === "startStt");
    expect(startCmd).toBeTruthy();

    const reqId = String(startCmd?.requestId);
    emit({ type: "stt_ready", requestId: reqId });
    emit({ type: "stt_onset", requestId: reqId, onsetAt: Date.now() });
    emit({
      type: "stt_final",
      requestId: reqId,
      transcript: "cháu lên ba",
      onsetAt: Date.now(),
    });

    expect(onstart).toHaveBeenCalledOnce();
    expect(onspeechstart).toHaveBeenCalledOnce();
    expect(onresult).toHaveBeenCalledOnce();
    rec!.abort();
  });

  it("does not pause or clear shared audio element when unlock probe resolves while TTS owns it", async () => {
    let resolveProbe!: () => void;
    const pauseSpy = vi.fn();
    const fakeAudio = {
      src: "",
      muted: false,
      volume: 1,
      pause: pauseSpy,
      play: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveProbe = resolve;
          }),
      ),
    } as unknown as HTMLAudioElement;
    const createSpy = vi
      .spyOn(document, "createElement")
      .mockReturnValue(fakeAudio as unknown as HTMLElement);

    unlockAudioNow();
    const lease = acquireUnlockedAudioElement();
    expect(lease).not.toBeNull();
    lease!.audio.src = "blob:https://viread-frontend.vercel.app/real-tts";
    lease!.audio.muted = false;

    resolveProbe();
    await Promise.resolve();
    await Promise.resolve();

    expect(pauseSpy).not.toHaveBeenCalled();
    expect(lease!.audio.src).toBe(
      "blob:https://viread-frontend.vercel.app/real-tts",
    );
    lease!.release();
    createSpy.mockRestore();
  });

  it("renders PhonicsLessonCard close button in top header row and fires onClose", () => {
    const lesson = buildPhonicsLesson("khéo");
    expect(lesson.supported).toBe(true);
    const onClose = vi.fn();
    render(
      <I18nProvider initialLocale="vi" initialMessages={viMessages}>
        <PhonicsLessonCard
          lesson={lesson}
          activeStepIndex={0}
          onPlayWord={vi.fn()}
          onPlayPhonics={vi.fn()}
          onClose={onClose}
        />
      </I18nProvider>,
    );

    const closeBtn = screen.getByRole("button", {
      name: /Đóng hướng dẫn đánh vần/i,
    });
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retries non-JSON gateway 502 on GET without retrying structured 503/504 or POST mutations", async () => {
    vi.useFakeTimers();
    try {
      // 1. GET retries non-JSON gateway 502 (Render cold-start) and recovers
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("Bad Gateway", {
            status: 502,
            headers: { "Content-Type": "text/html" },
          }),
        )
        .mockResolvedValueOnce(Response.json({ ok: true }));
      global.fetch = fetchMock as typeof fetch;

      const getPromise = requestApi("/books/", z.object({ ok: z.boolean() }));
      await vi.advanceTimersByTimeAsync(600);
      await expect(getPromise).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // 2. GET must NOT retry structured FastAPI JSON 503 or 504 application errors
      const dbBusyFetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { detail: "Database temporarily unavailable" },
            { status: 503 },
          ),
        );
      global.fetch = dbBusyFetchMock as typeof fetch;
      await expect(
        requestApi("/books/db-busy-503", z.object({ ok: z.boolean() })),
      ).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("đang bận"),
      });
      expect(dbBusyFetchMock).toHaveBeenCalledTimes(1);

      const syncTimeoutFetchMock = vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            detail:
              "Remote OCR worker did not finish before sync timeout; poll job status asynchronously.",
          },
          { status: 504 },
        ),
      );
      global.fetch = syncTimeoutFetchMock as typeof fetch;
      await expect(
        requestApi("/reading/scan-page-ocr", z.object({ ok: z.boolean() })),
      ).rejects.toMatchObject({
        status: 504,
        message: expect.stringContaining("xếp hàng"),
      });
      expect(syncTimeoutFetchMock).toHaveBeenCalledTimes(1);

      // 3. POST mutations must NEVER auto-retry even on non-JSON gateway 502
      const postFetchMock = vi.fn().mockResolvedValue(
        new Response("Bad Gateway", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      );
      global.fetch = postFetchMock as typeof fetch;
      await expect(
        requestApi("/books/", z.object({ ok: z.boolean() }), undefined, {
          method: "POST",
          body: { name: "test" },
        }),
      ).rejects.toMatchObject({ status: 502 });
      expect(postFetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires degraded Android capabilities snapshot after 5000ms and re-queries bridge", async () => {
    vi.useFakeTimers();
    try {
      const { sent, emit } = installMockNativePort();

      const firstPromise = getAndroidSpeechCapabilities();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.action).toBe("getCapabilities");
      emit({
        type: "capabilities",
        requestId: sent[0]?.requestId,
        ttsAvailable: false,
        viVoicesCount: 0,
        sttAvailable: true,
        onDeviceSttAvailable: true,
        platform: "android-webview",
      });
      const firstCaps = await firstPromise;
      expect(firstCaps?.ttsAvailable).toBe(false);
      expect(getCachedAndroidSpeechCapabilities()?.ttsAvailable).toBe(false);

      // Before 5000ms -> still cached
      await vi.advanceTimersByTimeAsync(2_000);
      const midCaps = await getAndroidSpeechCapabilities();
      expect(midCaps?.ttsAvailable).toBe(false);
      expect(sent).toHaveLength(1);

      // After 5000ms -> degraded snapshot expired, re-queries bridge
      await vi.advanceTimersByTimeAsync(3_500);
      expect(getCachedAndroidSpeechCapabilities()).toBeNull();
      const secondPromise = getAndroidSpeechCapabilities();
      expect(sent).toHaveLength(2);
      emit({
        type: "capabilities",
        requestId: sent[1]?.requestId,
        ttsAvailable: true,
        viVoicesCount: 2,
        sttAvailable: true,
        onDeviceSttAvailable: true,
        platform: "android-webview",
      });
      const recoveredCaps = await secondPromise;
      expect(recoveredCaps?.ttsAvailable).toBe(true);
      expect(recoveredCaps?.viVoicesCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses elevenlabs health & cooldown from /voice/status and gates TtsPlayback backend vs Android native fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({
        ...HOSTED_UNCONFIGURED_HEALTH,
        elevenlabs: {
          configured: true,
          stt_configured: true,
          tts_configured: true,
          stt_cooldown: false,
          tts_cooldown: false,
          model_id: "eleven_flash_v2_5",
          voice_id: "voice-123",
        },
      }),
    );
    global.fetch = fetchMock as typeof fetch;

    const health = await fetchVoiceEngineHealth();
    expect(health?.elevenlabs).toEqual({
      configured: true,
      stt_configured: true,
      tts_configured: true,
      stt_cooldown: false,
      tts_cooldown: false,
      model_id: "eleven_flash_v2_5",
      voice_id: "voice-123",
    });

    const { sent } = installMockNativePort();
    setVoicePolicyPreferences({
      region: "north",
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
      allowGoogleTtsFallback: true,
    });

    class MockHtmlAudio {
      duration = 0.5;
      currentTime = 0;
      defaultPlaybackRate = 1;
      playbackRate = 1;
      preservesPitch = false;
      volume = 1;
      paused = true;
      ended = false;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeupdate: (() => void) | null = null;
      onloadedmetadata: (() => void) | null = null;
      play = vi.fn(async () => {
        this.paused = false;
        queueMicrotask(() => {
          this.ended = true;
          this.onended?.();
        });
      });
      pause = vi.fn();
    }
    vi.stubGlobal("Audio", MockHtmlAudio);

    try {
      const synthesize = vi
        .fn()
        .mockResolvedValue(new Blob(["mp3"], { type: "audio/mpeg" }));
      const speech: SpeechService = { synthesize, transcribe: vi.fn() };
      const studio = {
        listVoices: vi.fn(),
        synthesizeTimed: vi.fn(),
      } as unknown as VoiceStudioService;

      const player = new TtsPlayback(speech, studio);
      // 1. Not in cooldown -> attempts backend synthesis (ElevenLabs)
      await player.play("Xin chào bé.", { bypassSessionLock: true });
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(sent.filter((m) => m.action === "speak")).toHaveLength(0);

      // 2. In tts_cooldown -> skips backend synthesis and speaks via Android native TTS
      setCachedVoiceEngineHealth({
        ...HOSTED_UNCONFIGURED_HEALTH,
        elevenlabs: {
          configured: true,
          stt_configured: true,
          tts_configured: true,
          stt_cooldown: false,
          tts_cooldown: true,
          model_id: "eleven_flash_v2_5",
          voice_id: "voice-123",
        },
      });
      await player.play("Bé đọc tiếp nhé.", { bypassSessionLock: true });
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(sent.filter((m) => m.action === "speak")).toHaveLength(1);
      player.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recovers Karaoke on Android native ViReadNativeSpeech across up to 3 transient aborted errors and fails on the 4th", async () => {
    vi.useFakeTimers();
    try {
      const { sent, emit } = installMockNativePort();
      const lyrics = syllableLyrics();
      const clock = () => 1200;
      const { result, unmount } = renderHook(() =>
        useKaraokeScoring(lyrics, clock),
      );

      let armPromise!: Promise<boolean>;
      act(() => {
        armPromise = result.current.arm();
      });
      const probeReqId = String(
        sent.filter((m) => m.action === "startStt").at(-1)?.requestId,
      );
      act(() => {
        emit({ type: "stt_ready", requestId: probeReqId });
      });
      await act(async () => {
        await expect(armPromise).resolves.toBe(true);
      });
      expect(result.current.status).toBe("armed");

      act(() => {
        result.current.resume();
      });
      let activeReqId = String(
        sent.filter((m) => m.action === "startStt").at(-1)?.requestId,
      );
      act(() => {
        emit({ type: "stt_ready", requestId: activeReqId });
      });
      expect(result.current.status).toBe("listening");

      // Transient aborted errors #1..#3 should pause briefly (120ms) and recover cleanly
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const countBefore = sent.filter((m) => m.action === "startStt").length;
        act(() => {
          emit({
            type: "stt_error",
            requestId: activeReqId,
            code: "aborted",
            message: "Transient recognizer reset",
          });
        });
        expect(result.current.status).toBe("armed");
        expect(sent.filter((m) => m.action === "startStt").length).toBe(
          countBefore,
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(120);
        });
        const startsAfter = sent.filter((m) => m.action === "startStt");
        expect(startsAfter).toHaveLength(countBefore + 1);
        activeReqId = String(startsAfter.at(-1)?.requestId);
        act(() => {
          emit({ type: "stt_ready", requestId: activeReqId });
        });
        expect(result.current.status).toBe("listening");
      }

      // 4th transient aborted error exceeds cap -> transitions to unavailable
      act(() => {
        emit({
          type: "stt_error",
          requestId: activeReqId,
          code: "aborted",
          message: "Persistent failure",
        });
      });
      expect(result.current.status).toBe("unavailable");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
