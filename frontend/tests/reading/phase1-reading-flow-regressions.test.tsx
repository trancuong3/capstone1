import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { createSpeechService, type SpeechService } from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";
import {
  getBrowserWasmSttClient,
  resetBrowserWasmSttForTests,
} from "@/lib/reading/browser-wasm-stt";
import {
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
} from "@/lib/reading/local-segment-speech-recognition";
import {
  resetAndroidNativeSpeechBridgeForTests,
  type ViReadNativeSpeechPort,
} from "@/lib/reading/native-speech-bridge";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  lockSessionVoice,
  releaseSessionVoiceLock,
  resetVoiceLockAndPolicyForTests,
  setActiveVoiceSession,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import {
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import type { ReadingPageWordDTO } from "@/types/reading";

const { getSession, initialize, fetchMock } = vi.hoisted(() => ({
  getSession: vi.fn(),
  initialize: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({ auth: { initialize, getSession } }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

function pageWords(sentence: string): ReadingPageWordDTO[] {
  return sentence.split(/\s+/u).map((text, index) => ({
    word_id: `w-${index}`,
    word_index: index,
    text,
    bbox: [0, 0, 1, 1] as const,
  }));
}

describe("Phase 1 Reading Flow Regressions (STT, TTS, SessionLock, Preview Highlighting)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetBrowserWasmSttForTests();
    resetLocalSttEmergencyStateForTests();
    resetAndroidNativeSpeechBridgeForTests();
    initialize.mockReset().mockResolvedValue({ error: null });
    getSession.mockReset().mockResolvedValue({
      data: { session: { access_token: "test-token" } },
      error: null,
    });
    fetchMock.mockReset();
  });

  afterEach(() => {
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetBrowserWasmSttForTests();
    resetLocalSttEmergencyStateForTests();
    resetAndroidNativeSpeechBridgeForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("useSpeechRecorder.start() waits for pendingStop to finish instead of rejecting immediately", async () => {
    const recorders: SlowStopRecorder[] = [];
    class SlowStopRecorder {
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      static isTypeSupported = () => false;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
      }
    }
    const track = { readyState: "live", stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    vi.stubGlobal("MediaRecorder", SlowStopRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });

    const { result } = renderHook(() => useSpeechRecorder());
    await act(async () => result.current.start());

    let stopPromise!: Promise<Blob | null>;
    let restartPromise!: Promise<void>;
    let restarted = false;
    act(() => {
      stopPromise = result.current.stop();
      restartPromise = result.current.start().then(() => {
        restarted = true;
      });
    });

    expect(restarted).toBe(false);

    await act(async () => {
      const recorderInstance = recorders[0]!;
      recorderInstance.ondataavailable?.({
        data: new Blob(["ok"]),
      } as BlobEvent);
      recorderInstance.onstop?.();
      await Promise.all([stopPromise, restartPromise]);
    });

    expect(restarted).toBe(true);
    expect(result.current.isRecording).toBe(true);
    act(() => result.current.cancel());
  });

  it("WASM interim skips cold-start decode when not ready and preserves WASM mode; stop() bounds hanging upload", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
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
    const client = getBrowserWasmSttClient();
    const transcribeSpy = vi
      .spyOn(client, "transcribeSamples")
      .mockRejectedValue(new Error("cold start timeout"));
    vi.spyOn(client, "isReady").mockReturnValue(false);
    vi.spyOn(client, "init").mockResolvedValue(undefined);

    const rec = new LocalSegmentSpeechRecognition(
      { transcribe: vi.fn() } as unknown as SpeechService,
      () => ({ sessionId: "sess-wasm", pageId: "p-1" }),
    );
    const internal = rec as unknown as {
      active: boolean;
      usingWasmStt: boolean;
      inSpeech: boolean;
      speechChunks: Float32Array[];
      pendingUploads: Set<Promise<void>>;
      dispatchRollingInterim: () => void;
    };
    internal.active = true;
    internal.usingWasmStt = true;
    internal.inSpeech = true;
    internal.speechChunks = [new Float32Array(3200).fill(0.05)];

    internal.dispatchRollingInterim();
    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(internal.usingWasmStt).toBe(true);

    // Bounded stop() completes in <= 1500ms even if an upload never resolves
    const neverResolves = new Promise<void>(() => undefined);
    internal.pendingUploads.add(neverResolves);
    let stopped = false;
    rec.onend = () => {
      stopped = true;
    };
    rec.stop();
    expect(stopped).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_550);
    });
    expect(stopped).toBe(true);
  });

  it("SessionVoiceLock updates do not abort active useSpeechPlayer playback and forceUpdate sends X-Voice-Lock-Update: 1", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(
      () =>
        new Promise(() => {
          /* keep pending to prove lockSessionVoice never aborts active synthesis */
        }),
    );

    const { result } = renderHook(() => useSpeechPlayer());
    let abortedByLock = false;
    act(() => {
      void result.current.play("Chào con nhé.").catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") {
          abortedByLock = true;
        }
      });
    });

    act(() => {
      lockSessionVoice("sess-no-abort", { voiceId: "local_north_truc_ly" });
      setActiveVoiceSession("sess-no-abort");
      releaseSessionVoiceLock("sess-no-abort");
    });

    expect(abortedByLock).toBe(false);

    // forceUpdate sets X-Voice-Lock-Update: 1 on speechService requests
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    lockSessionVoice("sess-hdr", { voiceId: "local_north_truc_ly" });
    lockSessionVoice("sess-hdr", {
      voiceId: "local_south_thuc_doan",
      forceUpdate: true,
    });

    await createSpeechService().synthesize("Xin chào.", {
      sessionId: "sess-hdr",
      voiceId: "local_south_thuc_doan",
    });
    const headers = fetchMock.mock.calls.at(-1)?.[1]?.headers as Headers | Record<string, string>;
    const headerValue =
      headers instanceof Headers
        ? headers.get("x-voice-lock-update")
        : (headers as Record<string, string>)["X-Voice-Lock-Update"];
    expect(headerValue).toBe("1");
  });

  it("allows LOCAL_VOICE_UNCONFIGURED fallback inside locked session only when opted-in and supports Android TTS pause/resume", async () => {
    const spokenTexts: string[] = [];
    let currentReqId = "";
    const port: ViReadNativeSpeechPort = {
      onmessage: null,
      postMessage: vi.fn((raw: string) => {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        if (msg.action === "speak") {
          currentReqId = String(msg.requestId);
          const spoke = String(msg.text ?? "");
          spokenTexts.push(spoke);
          queueMicrotask(() => {
            port.onmessage?.({
              data: JSON.stringify({ type: "tts_start", requestId: currentReqId }),
            });
            port.onmessage?.({
              data: JSON.stringify({
                type: "tts_range",
                requestId: currentReqId,
                start: 5,
                end: 9,
              }),
            });
            if (spokenTexts.length >= 2) {
              port.onmessage?.({
                data: JSON.stringify({ type: "tts_done", requestId: currentReqId }),
              });
            }
          });
        } else if (msg.action === "stopSpeak") {
          const stoppedId = currentReqId;
          queueMicrotask(() => {
            port.onmessage?.({
              data: JSON.stringify({ type: "tts_stopped", requestId: stoppedId }),
            });
          });
        }
      }),
    };
    const win = window as unknown as { ViReadNativeSpeech?: ViReadNativeSpeechPort };
    win.ViReadNativeSpeech = port;
    resetAndroidNativeSpeechBridgeForTests();

    const speech: SpeechService = {
      synthesize: vi.fn().mockRejectedValue(
        Object.assign(new Error("LOCAL_VOICE_UNCONFIGURED"), {
          status: 503,
          code: "TTS_UNAVAILABLE",
          providerCode: "LOCAL_VOICE_UNCONFIGURED",
        }),
      ),
      transcribe: vi.fn(),
    };
    const studio = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn(),
    } as unknown as VoiceStudioService;

    // 1. local_only + locked session -> blocked
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleTtsFallback: false,
    });
    lockSessionVoice("sess-android-pause", { voiceId: "local_north_truc_ly" });
    const player = new TtsPlayback(speech, studio);
    await expect(player.play("Chào các bạn nhỏ.")).rejects.toThrow();
    expect(spokenTexts).toHaveLength(0);

    // 2. Opted-in local_with_google_fallback + LOCAL_VOICE_UNCONFIGURED -> speaks & supports pause/resume
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    const playbackPromise = player.play("Chào các bạn nhỏ.");
    await vi.waitFor(() => expect(spokenTexts).toHaveLength(1));

    player.pause();
    expect(player.getState()).toBe("paused");
    await act(async () => {
      await player.resume();
      await playbackPromise;
    });

    expect(spokenTexts).toHaveLength(2);
    expect(spokenTexts[1]).toBe("các bạn nhỏ.");
    player.dispose();
  });

  it("previewAlignment avoids 18-30-word far jump and defers unconfirmed skips or function words", () => {
    const words = pageWords(
      "Nhà em có một chú mèo tên là Miu và chú thích cá tươi",
    );
    const engine = new RealtimeAlignmentEngine(words, 3, 1);

    // Unconfirmed high-freq word "là" (w-7) at skip gap must NOT advance cursor prematurely
    const fnSnap = engine.previewAlignment("là");
    expect(fnSnap.currentWordIndex).toBe(0);

    // Far single lookahead >= 2 words ahead without next-word confirmation must hold cursor
    const skipSnap = engine.previewAlignment("tên");
    expect(skipSnap.currentWordIndex).toBe(0);
    expect(skipSnap.statusByWordId.get("w-1")?.status).not.toBe("DELETE");
    expect(skipSnap.statusByWordId.get("w-2")?.status).not.toBe("DELETE");

    // 30-word findReanchor jump must NOT trigger in previewAlignment even for 2 words far ahead
    const longText = [
      ...Array.from({ length: 18 }, (_, i) => `từ${i}`),
      "mái",
      "nhà",
    ].join(" ");
    const longEngine = new RealtimeAlignmentEngine(pageWords(longText), 3, 1);
    const farPreview = longEngine.previewAlignment("mái nhà");
    expect(farPreview.currentWordIndex).toBe(0);
    expect(farPreview.statusByWordId.get("w-0")?.status).not.toBe("DELETE");
  });
});
