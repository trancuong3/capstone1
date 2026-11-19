import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingReport } from "@/components/reading/ReadingReport";
import { ReadingScreen } from "@/components/reading/reading-screen";
import { SessionReadingReports } from "@/components/reports/session-reading-reports";
import type { ReadingServices } from "@/hooks/use-reading-services";
import {
  AudioQualityMonitor,
  hasShortWordBlockingAudioIssue,
} from "@/lib/reading/audio-quality";
import {
  classifyPracticePhraseTranscript,
  classifyRetryTranscript,
} from "@/lib/reading/retry-word-recognition";
import { evaluateRecordedShortWord } from "@/lib/reading/word-practice-engine";
import {
  bookFixture,
  childFixture,
  sessionSummaryFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type {
  ReadingPageDTO,
  ReadingSessionPageProgressDTO,
} from "@/types/reading";

let previousSpeechRecognition: PropertyDescriptor | undefined;

const {
  servicesHook,
  speechRecorderMock,
  speechPlayerMock,
  speechServiceMock,
  comparisonApiMock,
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
  comparisonApiMock: {
    compareTranscript: vi.fn(),
    getSessionReports: vi.fn(),
    getReadingPage: vi.fn(),
  },
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
vi.mock("@/lib/api/comparison-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/comparison-service")>();
  return {
    ...actual,
    compareTranscript: comparisonApiMock.compareTranscript,
    getSessionReports: comparisonApiMock.getSessionReports,
    getReadingPage: comparisonApiMock.getReadingPage,
  };
});
vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => ({
    listVoices: async () => ({ voices: [], default_voice_id: "test-voice" }),
  }),
}));

const PAGE_ID = "30000000-0000-4000-8000-000000000109";
const REV_ID = "40000000-0000-4000-8000-000000000109";
const REPORT_ID = "60000000-0000-4000-8000-000000000109";

const sentencePage: ReadingPageDTO = {
  page_id: PAGE_ID,
  page_revision_id: REV_ID,
  page_number: 1,
  confidence: 0.99,
  width: 600,
  height: 800,
  text: "Bé có một bông hoa.",
  words: ["Bé", "có", "một", "bông", "hoa."].map((text, index) => ({
    word_id: `50000000-0000-4000-8000-00000000091${index}`,
    word_index: index,
    text,
    bbox: [0.05 + index * 0.16, 0.2, 0.12, 0.05] as const,
  })),
};

const motWord = sentencePage.words[2];

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

function makeShortWordFrame(amplitude: number): Float32Array {
  return Float32Array.from({ length: 128 }, (_, idx) =>
    idx % 2 === 0 ? amplitude : -amplitude,
  );
}

describe("QA Audit Scenarios A & C — Short-word 'một' retry, green sync, immutable error & sensitivity", () => {
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
        retryCurrentPage: vi.fn().mockResolvedValue(sentencePage),
        selectPage: vi.fn().mockResolvedValue(sentencePage),
      },
      readingService: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue({
          ...sessionSummaryFixture,
          state: "PAGE_READY",
          ended_at: null,
          duration_ms: null,
        }),
        getCurrentPage: vi.fn().mockResolvedValue(sentencePage),
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
              transcript: "Bé có mốt bông hoa",
              initial_assessment: sentencePage.words.map((word) => ({
                word_id: word.word_id,
                word_index: word.word_index,
                text: word.text,
                status:
                  word.word_id === motWord.word_id
                    ? "MISPRONUNCIATION"
                    : "CORRECT",
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
        requestReadExample: vi.fn(),
        retryReadExample: vi.fn(),
      },
    };
    servicesHook.mockReset().mockReturnValue(services);
    speechRecorderMock.start.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.prepare.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.stop
      .mockReset()
      .mockResolvedValue(new Blob(["synthetic-mot"], { type: "audio/webm" }));
    speechRecorderMock.cancel.mockReset();
    speechRecorderMock.getStream.mockReset().mockReturnValue(null);
    speechRecorderMock.getIsSpeaking.mockReset().mockReturnValue(false);
    speechRecorderMock.audioLevel = 0;
    speechRecorderMock.getQuality.mockReset().mockReturnValue({
      status: "LOW_VOLUME",
      durationMs: 740,
      speechDurationMs: 210,
      silenceDurationMs: 420,
      rms: 0.006,
      peak: 0.011,
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
    comparisonApiMock.compareTranscript.mockReset();
    comparisonApiMock.getReadingPage.mockReset().mockResolvedValue({
      page_id: PAGE_ID,
      page_revision_id: REV_ID,
      page_number: 1,
      confidence: 0.99,
      width: 600,
      height: 800,
      text: sentencePage.text,
      words: sentencePage.words.map((w) => ({
        ...w,
        bbox: [...w.bbox] as [number, number, number, number],
      })),
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

  it("Scenario A1: retries missed word 'một' hands-free via Acoustic VAD in 1 read -> red to yellow to green", async () => {
    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="ready"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    const agreeBtn = await screen.findByRole("button", {
      name: "Đồng ý, đọc lại",
    });

    // Starts red before retry confirmation.
    const motBefore = screen.getByRole("button", { name: "một" });
    expect(motBefore).toHaveClass("bg-red-200");

    // Simulate child speaking 'một' clearly once during first ~220ms then silence,
    // without browser Web Speech API emitting anything and WITHOUT clicking Stop button.
    speechRecorderMock.getIsSpeaking.mockReturnValue(true);
    speechRecorderMock.audioLevel = 0.045;
    speechServiceMock.transcribe.mockResolvedValueOnce({
      text: "một",
      language_code: "vie",
      language_probability: 0.99,
      words: [{ text: "một", start: 0, end: 0.24, logprob: -0.05 }],
    });

    await user.click(agreeBtn);
    await waitFor(() => {
      expect(speechRecorderMock.start).toHaveBeenCalledWith(
        expect.objectContaining({ retainStream: true, mode: "short-word" }),
      );
    });

    // Active retry target highlights YELLOW immediately
    expect(screen.getByRole("button", { name: "một" }).className).toContain(
      "ring-yellow-500",
    );

    // Release speaking into post-speech silence -> Acoustic VAD auto-stops (~1.2s)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
      speechRecorderMock.getIsSpeaking.mockReturnValue(false);
      speechRecorderMock.audioLevel = 0.001;
    });

    await waitFor(
      () => {
        expect(services.readingService.createRetryEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: TEST_SESSION_ID,
            wordId: motWord.word_id,
            status: "CONFIRMED",
            metadata: expect.objectContaining({
              target_word: "một",
              recognized_text: "một",
              resolution_status: "SELF_CORRECTED",
            }),
          }),
        );
      },
      { timeout: 4000 },
    );

    const motConfirmed = screen.getByRole("button", { name: "một" });
    expect(motConfirmed.className).toContain("bg-green-200");
    expect(motConfirmed).toHaveAccessibleDescription("Bé đã tự sửa đúng");
  });

  it("Scenario A2: reports show 'một' green (self-corrected) while keeping first-pass error & 80% accuracy immutable", async () => {
    const initialAssessment = sentencePage.words.map((w) => ({
      word_id: w.word_id,
      word_index: w.word_index,
      text: w.text,
      status:
        w.word_id === motWord.word_id
          ? ("MISPRONUNCIATION" as const)
          : ("CORRECT" as const),
    }));

    const reportPayload = {
      report_id: REPORT_ID,
      page_id: PAGE_ID,
      page_revision_id: REV_ID,
      transcript: "Bé có mốt bông hoa.",
      created_at: "2026-11-18T02:00:00Z",
      distance: 1,
      alignment: [
        {
          book_word: "Bé",
          spoken_word: "Bé",
          book_index: 0,
          spoken_index: 0,
          status: "MATCH" as const,
        },
        {
          book_word: "có",
          spoken_word: "có",
          book_index: 1,
          spoken_index: 1,
          status: "MATCH" as const,
        },
        {
          book_word: "một",
          spoken_word: "mốt",
          book_index: 2,
          spoken_index: 2,
          status: "SUBSTITUTE" as const,
        },
        {
          book_word: "bông",
          spoken_word: "bông",
          book_index: 3,
          spoken_index: 3,
          status: "MATCH" as const,
        },
        {
          book_word: "hoa",
          spoken_word: "hoa",
          book_index: 4,
          spoken_index: 4,
          status: "MATCH" as const,
        },
      ],
      summary: {
        assessment_version: 1 as const,
        initial_assessment: initialAssessment,
        missing_words: [],
        extra_words: [],
        substitutions: [
          { book_word: "một", spoken_word: "mốt", book_index: 2 },
        ],
        repeated_count: 0,
        repeated_words: [],
        repeated_book_indices: [],
        repeated_items: [],
        hesitations: [],
        hesitation_seconds: null,
      },
      self_corrected_word_ids: [motWord.word_id],
    };

    comparisonApiMock.getSessionReports.mockResolvedValue({
      session_id: TEST_SESSION_ID,
      total: 1,
      reports: [reportPayload],
      assessment: {
        first_pass_correct: 4,
        first_pass_incorrect: 1,
        self_corrected_words: 1,
        unresolved_words: 0,
        retry_attempts: 1,
        skipped_after_retry_limit: 0,
        recognition_uncertain: 0,
      },
    });

    const { unmount } = render(
      <SessionReadingReports sessionId={TEST_SESSION_ID} />,
    );

    expect(
      await screen.findByText(/Đã đọc lại đúng: 1 từ/),
    ).toBeInTheDocument();

    // Word 'một' is visually GREEN on page overlay (`bg-green-200`)
    const motSpan = screen.getByText("một", { exact: true });
    expect(motSpan.className).toContain("bg-green-200");

    // Immutable first-pass metrics STILL report 4 correct, 1 error, and separate self-corrected count
    const summarySection = screen.getByLabelText(
      "Kết quả lượt đầu và luyện lại",
    );
    expect(summarySection).toHaveTextContent("Đúng lượt đầu4");
    expect(summarySection).toHaveTextContent("Cần luyện ở lượt đầu1");
    expect(summarySection).toHaveTextContent("Bé đã tự sửa đúng1");

    unmount();

    render(
      <ReadingReport result={reportPayload} sessionId={TEST_SESSION_ID} />,
    );
    await waitFor(() => {
      expect(screen.getByText("một", { exact: true }).className).toContain(
        "bg-green-200",
      );
    });
    expect(screen.getByText("Từ đọc đúng").nextSibling).toHaveTextContent("4");
    expect(screen.getByText("Từ đọc nhầm").nextSibling).toHaveTextContent("1");
  });

  it("Scenario C: verifies acoustic DSP 'short-word' sensitivity & zero-false-positive matrix for 'một'", async () => {
    // 1) Speech bursts right at 40ms after mic opens -> must NOT poison calibration floor
    const monitor = new AudioQualityMonitor({ mode: "short-word" });
    for (let t = 0; t < 40; t += 20) {
      monitor.addFrame(makeShortWordFrame(0.001), t);
    }
    for (let t = 40; t <= 120; t += 20) {
      monitor.addFrame(makeShortWordFrame(0.025), t);
    }
    for (let t = 140; t <= 260; t += 20) {
      monitor.addFrame(makeShortWordFrame(0.007), t);
    }
    const snap = monitor.getSnapshot();
    expect(snap.noiseFloor).toBeLessThanOrEqual(0.008);
    expect(snap.speechDurationMs).toBeGreaterThanOrEqual(60);
    expect(hasShortWordBlockingAudioIssue(snap)).toBe(false);

    // 2) Full transcript classification matrix (accepted vs rejected vs uncertain)
    const contextPhrase = "Bé có một bông hoa.";
    for (const valid of [
      "một",
      "Một.",
      "[tiếng đập] một",
      "một một",
      "một bông hoa",
      "bé có một bông hoa",
    ]) {
      expect(classifyRetryTranscript("một", valid, { contextPhrase })).toBe(
        "CORRECT",
      );
      expect(
        classifyPracticePhraseTranscript("một", valid, { contextPhrase }),
      ).toBe("CORRECT");
    }

    for (const wrong of ["mốt", "mọt", "bột", "tốt", "hột"]) {
      expect(classifyRetryTranscript("một", wrong, { contextPhrase })).toBe(
        "INCORRECT",
      );
    }

    expect(
      classifyRetryTranscript("một", "một hai ba bốn năm", { contextPhrase }),
    ).toBe("UNCERTAIN");
    expect(classifyRetryTranscript("một", "[tiếng đập]")).toBe(
      "NOT_RECOGNIZED",
    );

    // 3) evaluateRecordedShortWord lets LOW_VOLUME through Pass 1 STT cleanly
    const evaluated = await evaluateRecordedShortWord({
      expectedWord: "một",
      contextPhrase,
      audioBlob: new Blob(["mot"], { type: "audio/webm" }),
      audioQuality: { ...snap, status: "LOW_VOLUME" },
      speechService: {
        transcribe: vi.fn().mockResolvedValueOnce({
          text: "bé có một bông hoa",
          language_code: "vie",
          language_probability: 0.97,
          words: [],
        }),
      },
    });
    expect(evaluated.status).toBe("CORRECT");
    expect(evaluated.source).toBe("SERVER_STT");
  });
});
