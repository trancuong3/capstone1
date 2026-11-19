import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingScreen } from "@/components/reading/reading-screen";
import type { ReadingServices } from "@/hooks/use-reading-services";
import {
  bookFixture,
  childFixture,
  sessionSummaryFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type {
  ReadingPageDTO,
  ReadingSessionPageProgressDTO,
  TutorAction,
} from "@/types/reading";

let previousSpeechRecognition: PropertyDescriptor | undefined;

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
    getQuality: vi.fn(),
  },
  speechPlayerMock: {
    isPlaying: false,
    isPaused: false,
    state: "idle" as const,
    play: vi.fn(),
    playWithWordTimings: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
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
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => speechRecorderMock,
}));
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

const PAGE_ID = "30000000-0000-4000-8000-000000000099";
const REV_ID = "40000000-0000-4000-8000-000000000099";

const flowerPage: ReadingPageDTO = {
  page_id: PAGE_ID,
  page_revision_id: REV_ID,
  page_number: 1,
  confidence: 0.98,
  width: 600,
  height: 800,
  text: "Bé có một bông hoa.",
  words: ["Bé", "có", "một", "bông", "hoa."].map((text, index) => ({
    word_id: `50000000-0000-4000-8000-00000000090${index}`,
    word_index: index,
    text,
    bbox: [0.05 + index * 0.16, 0.2, 0.12, 0.05] as const,
  })),
};

const coWord = flowerPage.words[1];

const pageProgress: ReadingSessionPageProgressDTO = {
  session_id: TEST_SESSION_ID,
  persisted: true,
  start_page_id: PAGE_ID,
  end_page_id: PAGE_ID,
  current_page_id: PAGE_ID,
  start_page_number: 1,
  end_page_number: 1,
  current_page_number: 1,
  current_index: 0,
  total_pages: 1,
  completed_pages: 0,
  pages: [
    {
      page_id: PAGE_ID,
      page_revision_id: REV_ID,
      page_number: 1,
      page_order: 0,
      status: "IN_PROGRESS",
      started_at: null,
      completed_at: null,
    },
  ],
};

const tutorAction: TutorAction = {
  action: "READ_EXAMPLE",
  action_id: "70000000-0000-4000-8000-000000000001",
  page_revision_word_id: coWord.word_id,
  tts_text: "có",
};

describe("ReadingScreen short-word 'có' retry state synchronization", () => {
  let services: ReadingServices;

  beforeEach(() => {
    previousSpeechRecognition = Object.getOwnPropertyDescriptor(
      window,
      "SpeechRecognition",
    );
    services = {
      bookService: {
        list: vi.fn().mockResolvedValue([bookFixture]),
        get: vi.fn().mockResolvedValue(bookFixture),
        listPages: vi.fn().mockResolvedValue([
          {
            page_id: PAGE_ID,
            page_number: 1,
            lifecycle_status: "ACTIVE",
            current_verified_revision_id: REV_ID,
            preview_url: "https://example.com/page-1.png",
          },
        ]),
      },
      childService: {
        list: vi.fn().mockResolvedValue([childFixture]),
        get: vi.fn().mockResolvedValue(childFixture),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        uploadAvatar: vi.fn(),
        removeAvatar: vi.fn(),
      },
      comprehensionService: {
        getQuestion: vi.fn().mockRejectedValue(new Error("none")),
        submitAnswer: vi.fn(),
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
          message: "Device is available",
          mediaRecorderSupported: true,
        }),
        retry: vi.fn().mockResolvedValue("ready"),
      },
      pageMatchService: {
        retryCurrentPage: vi.fn().mockResolvedValue(flowerPage),
        selectPage: vi.fn().mockResolvedValue(flowerPage),
      },
      readingService: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue({
          ...sessionSummaryFixture,
          state: "PAGE_READY",
          ended_at: null,
          duration_ms: null,
        }),
        getCurrentPage: vi.fn().mockResolvedValue(flowerPage),
        getPageProgress: vi.fn().mockResolvedValue(pageProgress),
        navigateToPage: vi.fn().mockResolvedValue(pageProgress),
        completeCurrentPage: vi.fn().mockResolvedValue({
          ...pageProgress,
          completed_pages: 1,
        }),
        createRetryEvent: vi.fn().mockResolvedValue(undefined),
        getPracticeState: vi.fn().mockResolvedValue({
          session_id: TEST_SESSION_ID,
          legacy_evidence_present: false,
          pages: [
            {
              page_id: PAGE_ID,
              page_revision_id: REV_ID,
              page_number: 1,
              transcript: "Bé một bông hoa",
              initial_assessment: flowerPage.words.map((word) => ({
                word_id: word.word_id,
                word_index: word.word_index,
                text: word.text,
                status:
                  word.word_id === coWord.word_id ? "OMISSION" : "CORRECT",
              })),
            },
          ],
          words: [],
        }),
        getCompletionSummary: vi.fn().mockResolvedValue({
          duration_minutes: 2,
          pages_explored: 1,
          practiced_words: 1,
        }),
        finish: vi.fn().mockResolvedValue({
          duration_minutes: 2,
          pages_explored: 1,
          practiced_words: 1,
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
      tutorService: {
        requestReadExample: vi.fn().mockResolvedValue(tutorAction),
        retryReadExample: vi.fn().mockResolvedValue(tutorAction),
      },
    };
    servicesHook.mockReset().mockReturnValue(services);
    speechRecorderMock.start.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.prepare.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.stop
      .mockReset()
      .mockResolvedValue(new Blob(["synthetic-co"], { type: "audio/webm" }));
    speechRecorderMock.cancel.mockReset();
    speechRecorderMock.getStream.mockReset().mockReturnValue(null);
    speechRecorderMock.getIsSpeaking.mockReset().mockReturnValue(false);
    speechRecorderMock.getQuality.mockReset().mockReturnValue({
      status: "SPEECH_DETECTED",
      durationMs: 1400,
      speechDurationMs: 900,
      silenceDurationMs: 300,
      rms: 0.04,
      peak: 0.1,
      noiseFloor: 0.002,
      clipped: false,
      isSpeaking: false,
    });
    speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
    speechPlayerMock.playWithWordTimings
      .mockReset()
      .mockResolvedValue(undefined);
    speechPlayerMock.stop.mockReset();
    speechServiceMock.transcribe.mockReset();
    compareTranscriptMock.mockReset().mockResolvedValue({
      session_id: TEST_SESSION_ID,
      page_id: PAGE_ID,
      page_revision_id: REV_ID,
      distance: 1,
      alignment: [
        {
          book_word: "Bé",
          spoken_word: "Bé",
          book_index: 0,
          spoken_index: 0,
          status: "MATCH",
        },
        {
          book_word: "có",
          spoken_word: null,
          book_index: 1,
          spoken_index: null,
          status: "DELETE",
        },
        {
          book_word: "một",
          spoken_word: "một",
          book_index: 2,
          spoken_index: 1,
          status: "MATCH",
        },
        {
          book_word: "bông",
          spoken_word: "bông",
          book_index: 3,
          spoken_index: 2,
          status: "MATCH",
        },
        {
          book_word: "hoa",
          spoken_word: "hoa",
          book_index: 4,
          spoken_index: 3,
          status: "MATCH",
        },
      ],
      summary: {
        missing_words: ["có"],
        extra_words: [],
        substitutions: [],
        repeated_count: 0,
        repeated_words: [],
        hesitations: [],
        hesitation_seconds: null,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousSpeechRecognition) {
      Object.defineProperty(
        window,
        "SpeechRecognition",
        previousSpeechRecognition,
      );
    } else {
      Reflect.deleteProperty(window, "SpeechRecognition");
    }
  });

  it("renders 'có' red -> active retry yellow -> speaks 'có' once softly -> persists CONFIRMED -> turns green", async () => {
    const user = userEvent.setup();

    render(
      <ReadingScreen
        initialUiState="ready"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    // 1) Wait for retry prompt after restoring page 'Bé có một bông hoa.' with missed 'có'
    const agreeBtn = await screen.findByRole("button", {
      name: "Đồng ý, đọc lại",
    });

    // Before retry confirmation, 'có' starts RED
    const coBtnRed = screen.getByRole("button", { name: "có" });
    expect(coBtnRed.className).toContain("bg-red-200");

    // 2) Enter active retry for 'có' -> opens short-word mic mode
    await user.click(agreeBtn);
    await waitFor(() => {
      expect(speechRecorderMock.start).toHaveBeenCalledWith(
        expect.objectContaining({ retainStream: true, mode: "short-word" }),
      );
    });

    // Simulate soft Grade-1 child voice on retry (LOW_VOLUME passes short-word gate!)
    speechRecorderMock.getQuality.mockReturnValue({
      status: "LOW_VOLUME",
      durationMs: 700,
      speechDurationMs: 220,
      silenceDurationMs: 420,
      rms: 0.006,
      peak: 0.01,
      noiseFloor: 0.002,
      clipped: false,
      isSpeaking: false,
    });

    // Active retry target 'có' shows yellow active ring
    const coBtnListening = screen.getByRole("button", { name: "có" });
    expect(coBtnListening.className).toContain("ring-yellow-500");

    // 3) Child speaks 'có' once -> stop mic -> CONFIRMED -> turns GREEN
    speechServiceMock.transcribe.mockResolvedValueOnce({
      text: "có",
      language_code: "vie",
      language_probability: 0.99,
      words: [{ text: "có", start: 0, end: 0.22, logprob: -0.04 }],
    });

    await user.click(
      await screen.findByRole("button", { name: "Dừng nhận diện giọng nói" }),
    );

    await waitFor(() => {
      expect(services.readingService.createRetryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: TEST_SESSION_ID,
          wordId: coWord.word_id,
          status: "CONFIRMED",
          metadata: expect.objectContaining({
            target_word: "có",
            recognized_text: "có",
            resolution_status: "SELF_CORRECTED",
          }),
        }),
      );
    });

    const coBtnConfirmed = screen.getByRole("button", { name: "có" });
    expect(coBtnConfirmed.className).toContain("bg-green-200");
    expect(coBtnConfirmed).toHaveAccessibleDescription("Bé đã tự sửa đúng");
  });
});
