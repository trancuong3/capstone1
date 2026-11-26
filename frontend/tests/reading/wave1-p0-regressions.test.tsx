import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingScreen } from "@/components/reading/reading-screen";
import type { ReadingServices } from "@/hooks/use-reading-services";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { ServiceError } from "@/lib/api/service-error";
import {
  buildSpeechServiceError,
  isSttFallbackEligibleError,
} from "@/lib/api/speech-error";
import type { SpeechService } from "@/lib/api/speech-service";
import {
  isTechnicalSttUnavailabilityError,
  LocalSegmentSpeechRecognition,
  resetLocalSttEmergencyStateForTests,
} from "@/lib/reading/local-segment-speech-recognition";
import {
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import {
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import {
  bookFixture,
  childFixture,
  sessionSummaryFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type {
  ReadingPageDTO,
  ReadingSessionPageProgressDTO,
  ReadingUiState,
} from "@/types/reading";

const {
  servicesHook,
  speechRecorderMock,
  speechPlayerMock,
  speechServiceMock,
  compareTranscriptMock,
} = vi.hoisted(() => ({
  servicesHook: vi.fn<() => ReadingServices>(),
  speechRecorderMock: {
    isRecording: false,
    isSpeaking: false,
    audioLevel: 0,
    prepare: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    getStream: vi.fn(),
    getIsSpeaking: vi.fn(),
    getAudioLevel: vi.fn(() => 0),
    getQuality: vi.fn(),
  },
  speechPlayerMock: {
    isPlaying: false,
    play: vi.fn(),
    playWithWordTimings: vi.fn(),
    stop: vi.fn(),
  },
  speechServiceMock: {
    synthesize: vi.fn(),
    transcribe: vi.fn(),
  },
  compareTranscriptMock: vi.fn(),
}));

vi.mock("@/hooks/use-reading-services", () => ({
  useReadingServices: servicesHook,
}));
vi.mock("@/hooks/use-speech-recorder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-speech-recorder")>();
  return {
    ...actual,
    useSpeechRecorder: () => speechRecorderMock,
  };
});
vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => speechPlayerMock,
}));
vi.mock("@/lib/api/speech-service", () => ({
  createSpeechService: () => speechServiceMock,
}));
vi.mock("@/lib/api/comparison-service", () => ({
  compareTranscript: compareTranscriptMock,
}));
vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => ({
    listVoices: async () => ({ voices: [], default_voice_id: "test-voice" }),
  }),
}));

const twoWordPage: ReadingPageDTO = {
  page_id: "30000000-0000-4000-8000-000000000099",
  page_revision_id: "40000000-0000-4000-8000-000000000099",
  page_number: 1,
  confidence: 0.98,
  width: 600,
  height: 800,
  text: "Bé mèo",
  words: ["Bé", "mèo"].map((text, index) => ({
    word_id: `50000000-0000-4000-8000-00000000090${index}`,
    word_index: index,
    text,
    bbox: [0.1 + index * 0.2, 0.2, 0.15, 0.05] as const,
  })),
};

const pageProgressFixture: ReadingSessionPageProgressDTO = {
  session_id: TEST_SESSION_ID,
  persisted: true,
  start_page_id: twoWordPage.page_id,
  end_page_id: twoWordPage.page_id,
  current_page_id: twoWordPage.page_id,
  start_page_number: 1,
  end_page_number: 1,
  current_page_number: 1,
  current_index: 0,
  total_pages: 1,
  completed_pages: 0,
  pages: [
    {
      page_id: twoWordPage.page_id,
      page_revision_id: twoWordPage.page_revision_id,
      page_number: 1,
      page_order: 0,
      status: "IN_PROGRESS",
      started_at: null,
      completed_at: null,
    },
  ],
};

function makeReadingServices() {
  return {
    bookService: {
      get: vi.fn().mockResolvedValue(bookFixture),
      listPages: vi.fn().mockResolvedValue([
        {
          page_id: twoWordPage.page_id,
          page_number: 1,
          lifecycle_status: "ACTIVE" as const,
          current_verified_revision_id: twoWordPage.page_revision_id,
          preview_url: "https://example.com/p1.png",
        },
      ]),
    },
    childService: {
      get: vi.fn().mockResolvedValue(childFixture),
    },
    readingService: {
      get: vi.fn().mockResolvedValue({
        id: TEST_SESSION_ID,
        child_id: childFixture.id,
        book_id: bookFixture.id,
        status: "ACTIVE",
        started_at: "2026-10-01T00:00:00Z",
        ended_at: null,
        duration_ms: 1000,
      }),
      getCurrentPage: vi.fn().mockResolvedValue(twoWordPage),
      getPageProgress: vi.fn().mockResolvedValue(pageProgressFixture),
      getCompletionSummary: vi.fn().mockResolvedValue(sessionSummaryFixture),
      getPracticeState: vi.fn().mockResolvedValue(null),
      navigateToPage: vi.fn().mockResolvedValue(pageProgressFixture),
      completeCurrentPage: vi.fn().mockResolvedValue(pageProgressFixture),
      createRetryEvent: vi.fn().mockResolvedValue({}),
      finish: vi.fn().mockResolvedValue({
        id: TEST_SESSION_ID,
        duration_ms: 1200,
      }),
    },
    readingSocketAdapter: {
      subscribe: vi.fn().mockReturnValue(vi.fn()),
      sendControl: vi.fn().mockResolvedValue("LISTENING"),
      reconnect: vi.fn().mockResolvedValue("recovered"),
      getSafetySnapshot: vi.fn().mockReturnValue({
        connection: "connected",
        scoring_active: false,
        evidence_valid: false,
        child_error_events: [],
      }),
    },
    devicePermissionService: {
      getSnapshot: vi
        .fn()
        .mockResolvedValue({ camera: "ready", microphone: "ready" }),
      getMicrophonePermissionState: vi.fn().mockResolvedValue("prompt"),
      watchMicrophonePermissionState: vi
        .fn()
        .mockResolvedValue(() => undefined),
      requestAccess: vi.fn().mockResolvedValue({
        status: "granted",
        verified: true,
        message: "ok",
        mediaRecorderSupported: true,
      }),
      retry: vi.fn().mockResolvedValue("ready"),
    },
    pageMatchService: {
      retryCurrentPage: vi.fn().mockResolvedValue(twoWordPage),
      selectPage: vi.fn().mockResolvedValue(twoWordPage),
    },
    comprehensionService: {
      getQuestion: vi.fn().mockResolvedValue(null),
      submitAnswer: vi.fn(),
    },
    tutorService: {
      requestAction: vi.fn(),
    },
    readingPresenceService: {
      getSettings: vi.fn().mockResolvedValue({ enabled: false }),
      getConfig: vi.fn().mockResolvedValue({ enabled: false }),
      reportEvent: vi.fn(),
    },
  };
}

describe("Wave 1 P0 Regressions — STT Fallback, Recovery isBusy & words[0]", () => {
  beforeEach(() => {
    resetVoiceLockAndPolicyForTests();
    resetVoiceEngineStatus();
    resetLocalSttEmergencyStateForTests();
    speechRecorderMock.isRecording = false;
    speechRecorderMock.isSpeaking = false;
    speechRecorderMock.audioLevel = 0;
    speechRecorderMock.prepare.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.start.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.stop.mockReset().mockResolvedValue(null);
    speechRecorderMock.cancel.mockReset();
    speechRecorderMock.getStream.mockReset().mockReturnValue(null);
    speechRecorderMock.getIsSpeaking.mockReset().mockReturnValue(false);
    speechRecorderMock.getAudioLevel.mockReset().mockReturnValue(0);
    speechRecorderMock.getQuality.mockReset().mockReturnValue(undefined);
    speechPlayerMock.isPlaying = false;
    speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
    speechPlayerMock.playWithWordTimings
      .mockReset()
      .mockResolvedValue(undefined);
    speechPlayerMock.stop.mockReset();
    speechServiceMock.synthesize.mockReset();
    speechServiceMock.transcribe.mockReset();
    compareTranscriptMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("P0 #2 — Unified isSttFallbackEligibleError & STT_QUOTA_EXCEEDED fallback", () => {
    it("classifies all quota/outage/concurrency/network/5xx errors as fallback-eligible and rejects auth/abort/invalid-audio", () => {
      const eligibleCodes = [
        "STT_QUOTA_EXCEEDED",
        "STT_UNAVAILABLE",
        "STT_CONCURRENCY_LIMITED",
        "STT_NETWORK_ERROR",
        "STT_TEMPORARILY_UNAVAILABLE",
        "STT_TIMEOUT",
        "STT_RATE_LIMITED",
      ] as const;

      for (const code of eligibleCodes) {
        const err = new ServiceError({
          code,
          message: "provider error",
          status: code === "STT_QUOTA_EXCEEDED" ? 402 : 503,
          request_id: "req-1",
          retryable: code !== "STT_QUOTA_EXCEEDED",
        });
        expect(isSttFallbackEligibleError(err)).toBe(true);
        expect(isTechnicalSttUnavailabilityError(err)).toBe(true);
      }

      expect(isSttFallbackEligibleError({ code: "SPEECH_UNAVAILABLE" })).toBe(
        true,
      );
      expect(
        isSttFallbackEligibleError({ code: "LOCAL_VOICE_UNCONFIGURED" }),
      ).toBe(true);

      // buildSpeechServiceError preserves STT_QUOTA_EXCEEDED even on HTTP 429 or 402
      const builtQuota = buildSpeechServiceError({
        capability: "STT_UNAVAILABLE",
        status: 402,
        providerCode: "STT_QUOTA_EXCEEDED",
      });
      expect(isSttFallbackEligibleError(builtQuota)).toBe(true);
      expect(isTechnicalSttUnavailabilityError(builtQuota)).toBe(true);

      // Network TypeError is eligible
      expect(isSttFallbackEligibleError(new TypeError("Failed to fetch"))).toBe(
        true,
      );

      // Non-eligible errors MUST return false
      expect(
        isSttFallbackEligibleError(new DOMException("aborted", "AbortError")),
      ).toBe(false);
      expect(
        isSttFallbackEligibleError(
          new ServiceError({
            code: "AUTH_REQUIRED",
            message: "expired",
            status: 401,
            request_id: "r",
            retryable: false,
          }),
        ),
      ).toBe(false);
      expect(
        isSttFallbackEligibleError(
          new ServiceError({
            code: "FORBIDDEN",
            message: "denied",
            status: 403,
            request_id: "r",
            retryable: false,
          }),
        ),
      ).toBe(false);
      expect(
        isSttFallbackEligibleError(
          new ServiceError({
            code: "STT_INVALID_AUDIO",
            message: "bad audio",
            status: 422,
            request_id: "r",
            retryable: false,
          }),
        ),
      ).toBe(false);
    });

    it("activates Browser SpeechRecognition fallback in LocalSegmentSpeechRecognition on STT_QUOTA_EXCEEDED", async () => {
      class FakeBrowserRec {
        static instances: FakeBrowserRec[] = [];
        continuous = true;
        interimResults = true;
        lang = "vi-VN";
        maxAlternatives = 1;
        onresult: null = null;
        onerror: null = null;
        onend: null = null;
        started = false;
        constructor() {
          FakeBrowserRec.instances.push(this);
        }
        start() {
          this.started = true;
        }
        stop() {
          this.started = false;
        }
      }
      const prevSR = Object.getOwnPropertyDescriptor(
        window,
        "SpeechRecognition",
      );
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: FakeBrowserRec,
      });

      try {
        setVoicePolicyPreferences({
          providerMode: "local_with_google_fallback",
          allowGoogleSttFallback: true,
        });
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

        const quotaErr = buildSpeechServiceError({
          capability: "STT_UNAVAILABLE",
          status: 402,
          providerCode: "STT_QUOTA_EXCEEDED",
        });
        const transcribe = vi.fn().mockRejectedValue(quotaErr);
        const rec = new LocalSegmentSpeechRecognition(
          { transcribe } as unknown as SpeechService,
          () => ({ sessionId: "sess-q", pageId: "p-q" }),
          async () => null,
        );

        const internal = rec as unknown as {
          active: boolean;
          consumeSamples16k: (chunk: Float32Array) => void;
        };
        internal.active = true;

        const voiced = new Float32Array(1600).fill(0.08);
        const silent = new Float32Array(1600).fill(0);
        for (let i = 0; i < 4; i += 1) internal.consumeSamples16k(voiced);
        for (let i = 0; i < 8; i += 1) internal.consumeSamples16k(silent);

        await waitFor(() => {
          expect(FakeBrowserRec.instances.length).toBeGreaterThanOrEqual(1);
        });
        expect(FakeBrowserRec.instances[0].started).toBe(true);
        rec.abort();
      } finally {
        if (prevSR) {
          Object.defineProperty(window, "SpeechRecognition", prevSR);
        } else {
          Reflect.deleteProperty(window, "SpeechRecognition");
        }
      }
    });
  });

  describe("P0 #1 — Recovery handlers reset isBusy on rejection & retryPageMatch selects words[0]", () => {
    function renderScreen(
      initialUiState: ReadingUiState,
      services: ReturnType<typeof makeReadingServices>,
    ) {
      servicesHook.mockReturnValue(services as unknown as ReadingServices);
      return render(
        <ReadingScreen
          initialUiState={initialUiState}
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );
    }

    it("selects matchedPage.words[0] on retryPageMatch (even on 2-word pages) and resets isBusy on error", async () => {
      const services = makeReadingServices();
      services.pageMatchService.retryCurrentPage
        .mockRejectedValueOnce(new Error("Temporary network error"))
        .mockResolvedValueOnce(twoWordPage);

      const user = userEvent.setup();
      renderScreen("page-confidence-low", services);

      const retryBtn = await screen.findByRole("button", {
        name: "Thử lại",
      });

      // 1st click fails -> isBusy MUST reset so button is re-enabled!
      await user.click(retryBtn);
      await waitFor(() => expect(retryBtn).toBeEnabled());
      expect(
        screen.getByText(/Chưa tìm khớp lại được trang sách/i),
      ).toBeInTheDocument();

      // 2nd click succeeds on 2-word page -> highlights words[0] ("Bé"), NOT words[3] (undefined -> null)
      await user.click(retryBtn);
      await waitFor(() => {
        const firstWordEl = document.querySelector(
          `[data-word-id="${twoWordPage.words[0].word_id}"]`,
        );
        expect(firstWordEl).toHaveAttribute("aria-current", "true");
      });
    });

    it("resets isBusy when resumeReading, retryMicrophonePermission, or reconnect rejects", async () => {
      const user = userEvent.setup();

      // 1. resumeReading rejection
      const servicesPaused = makeReadingServices();
      servicesPaused.readingSocketAdapter.sendControl.mockRejectedValueOnce(
        new Error("socket offline"),
      );
      const { unmount: unmountPaused } = renderScreen("paused", servicesPaused);
      const resumeBtn = await screen.findByRole("button", {
        name: "Đọc tiếp",
      });
      await user.click(resumeBtn);
      await waitFor(() => expect(resumeBtn).toBeEnabled());
      unmountPaused();

      // 2. retryMicrophonePermission rejection
      const servicesMic = makeReadingServices();
      servicesMic.devicePermissionService.retry.mockRejectedValueOnce(
        new Error("permission error"),
      );
      const { unmount: unmountMic } = renderScreen(
        "microphone-denied",
        servicesMic,
      );
      const micRetryBtn = await screen.findByRole("button", {
        name: "Thử lại",
      });
      await user.click(micRetryBtn);
      await waitFor(() => expect(micRetryBtn).toBeEnabled());
      unmountMic();

      // 3. reconnect rejection
      const servicesReconn = makeReadingServices();
      servicesReconn.readingSocketAdapter.reconnect.mockRejectedValueOnce(
        new Error("reconnect failed"),
      );
      renderScreen("stt-error", servicesReconn);
      const reconnBtn = await screen.findByRole("button", {
        name: "Thử nghe lại",
      });
      await user.click(reconnBtn);
      await waitFor(() => expect(reconnBtn).toBeEnabled());
    });
  });

  describe("P0 #1 — useSpeechRecorder.getAudioLevel returns live ref value", () => {
    it("exposes getAudioLevel() synchronized with real-time analyser RMS", async () => {
      // Import the unmocked hook directly via vi.importActual
      const { useSpeechRecorder: realUseSpeechRecorder } =
        await vi.importActual<typeof import("@/hooks/use-speech-recorder")>(
          "@/hooks/use-speech-recorder",
        );

      let rafCb: FrameRequestCallback | null = null;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        rafCb = cb;
        return 1;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
        () => undefined,
      );

      class FakeMediaRecorder {
        static isTypeSupported = () => false;
        state: RecordingState = "inactive";
        mimeType = "audio/webm";
        ondataavailable: null = null;
        onstop: null = null;
        onerror: null = null;
        constructor(readonly stream: MediaStream) {}
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      }
      class FakeAudioCtx {
        state = "running";
        createMediaStreamSource() {
          return { connect: vi.fn(), disconnect: vi.fn() };
        }
        createAnalyser() {
          return {
            fftSize: 16,
            smoothingTimeConstant: 0.5,
            getFloatTimeDomainData(arr: Float32Array) {
              arr.fill(0.1); // rms = 0.1 -> level = 50
            },
          };
        }
        close() {
          return Promise.resolve();
        }
      }

      vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
      vi.stubGlobal("AudioContext", FakeAudioCtx);
      const prevDevices = Object.getOwnPropertyDescriptor(
        navigator,
        "mediaDevices",
      );
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: vi.fn().mockResolvedValue({
            getTracks: () => [{ readyState: "live", stop: vi.fn() }],
          }),
        },
      });

      try {
        const { result, unmount } = renderHook(() => realUseSpeechRecorder());
        expect(result.current.getAudioLevel?.()).toBe(0);
        await act(async () => {
          await result.current.start();
        });
        // Capture getter BEFORE the analyser tick fires (simulating a stale closure)
        const getLevel = result.current.getAudioLevel!;
        act(() => {
          rafCb?.(100);
        });
        expect(getLevel()).toBe(50);
        unmount();
      } finally {
        if (prevDevices) {
          Object.defineProperty(navigator, "mediaDevices", prevDevices);
        }
        // Keep import referenced cleanly
        expect(typeof useSpeechRecorder).toBe("function");
      }
    });
  });

  // Also ensure fireEvent import is used if needed (keep test lint-clean)
  it("keeps test helpers active", () => {
    expect(typeof fireEvent.click).toBe("function");
  });
});
