import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/api/service-error";
import type { ReadingUiState } from "@/types/reading";
import type { WordTimedPlayOptions } from "@/hooks/use-speech-player";
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
const TEST_QUESTION_ID = "80000000-0000-4000-8000-000000000001";
let previousSpeechRecognition: PropertyDescriptor | undefined;
const {
  servicesHook,
  speechRecorderMock,
  speechPlayerMock,
  speechServiceMock,
  compareTranscriptMock,
  recorderErrorHandler,
} = vi.hoisted(() => ({
  recorderErrorHandler: {
    current: undefined as ((error: Error) => void) | undefined,
  },
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
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: (onError?: (error: Error) => void) => {
    recorderErrorHandler.current = onError;
    return speechRecorderMock;
  },
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

// Typed, test-local responses only. The application provider still uses
// unavailable Reading/AI services; these fixtures exercise existing UI handlers.
const pageFour: ReadingPageDTO = {
  page_id: "30000000-0000-4000-8000-000000000014",
  page_revision_id: "40000000-0000-4000-8000-000000000014",
  page_number: 4,
  confidence: 0.95,
  width: 600,
  height: 800,
  words: ["Bé", "mèo", "nhỏ", "đang"].map((text, index) => ({
    word_id: `50000000-0000-4000-8000-00000000040${index}`,
    word_index: index,
    text,
    bbox: [0.1 + index * 0.15, 0.2, 0.1, 0.05] as const,
  })),
};
const pageFive: ReadingPageDTO = {
  ...pageFour,
  page_id: "30000000-0000-4000-8000-000000000015",
  page_revision_id: "40000000-0000-4000-8000-000000000015",
  page_number: 5,
  words: pageFour.words.map((word, index) => ({
    ...word,
    word_id: `50000000-0000-4000-8000-00000000050${index}`,
  })),
};
function assessmentFor(
  page: ReadingPageDTO,
  statuses: readonly string[] = page.words.map(() => "CORRECT"),
) {
  return page.words.map((word, index) => ({
    word_id: word.word_id,
    status: statuses[index],
  }));
}
const previews = [pageFour, pageFive].map((page) => ({
  page_id: page.page_id,
  page_number: page.page_number,
  lifecycle_status: "ACTIVE" as const,
  current_verified_revision_id: page.page_revision_id,
  preview_url: "https://example.com/test-page.png",
}));
const pageProgressFixture: ReadingSessionPageProgressDTO = {
  session_id: TEST_SESSION_ID,
  persisted: true,
  start_page_id: pageFour.page_id,
  end_page_id: pageFive.page_id,
  current_page_id: pageFour.page_id,
  start_page_number: pageFour.page_number,
  end_page_number: pageFive.page_number,
  current_page_number: pageFour.page_number,
  current_index: 0,
  total_pages: 2,
  completed_pages: 0,
  pages: [
    {
      page_id: pageFour.page_id,
      page_revision_id: pageFour.page_revision_id,
      page_number: pageFour.page_number,
      page_order: 0,
      status: "IN_PROGRESS",
      started_at: null,
      completed_at: null,
    },
    {
      page_id: pageFive.page_id,
      page_revision_id: pageFive.page_revision_id,
      page_number: pageFive.page_number,
      page_order: 1,
      status: "PENDING",
      started_at: null,
      completed_at: null,
    },
  ],
};
const tutorAction: TutorAction = {
  action: "READ_EXAMPLE",
  action_id: "70000000-0000-4000-8000-000000000001",
  page_revision_word_id: pageFour.words[3].word_id,
  tts_text: "đang",
};
function createReadingFixtures() {
  return {
    bookService: {
      list: vi
        .fn<ReadingServices["bookService"]["list"]>()
        .mockResolvedValue([bookFixture]),
      get: vi
        .fn<ReadingServices["bookService"]["get"]>()
        .mockResolvedValue(bookFixture),
      listPages: vi
        .fn<ReadingServices["bookService"]["listPages"]>()
        .mockResolvedValue(previews),
    },
    childService: {
      list: vi
        .fn<ReadingServices["childService"]["list"]>()
        .mockResolvedValue([childFixture]),
      get: vi
        .fn<ReadingServices["childService"]["get"]>()
        .mockResolvedValue(childFixture),
      create: vi
        .fn<ReadingServices["childService"]["create"]>()
        .mockRejectedValue(new Error("Unused test write")),
      update: vi
        .fn<ReadingServices["childService"]["update"]>()
        .mockRejectedValue(new Error("Unused test write")),
      delete: vi
        .fn<ReadingServices["childService"]["delete"]>()
        .mockRejectedValue(new Error("Unused test write")),
      uploadAvatar: vi
        .fn<ReadingServices["childService"]["uploadAvatar"]>()
        .mockRejectedValue(new Error("Unused test write")),
      removeAvatar: vi
        .fn<ReadingServices["childService"]["removeAvatar"]>()
        .mockRejectedValue(new Error("Unused test write")),
    },
    comprehensionService: {
      getQuestion: vi
        .fn<ReadingServices["comprehensionService"]["getQuestion"]>()
        .mockResolvedValue({
          question: {
            id: TEST_QUESTION_ID,
            type: "FACTUAL",
            prompt: "Bé mèo nằm ở đâu?",
            page_revision_id: pageFour.page_revision_id,
            source_span: {
              start_word_index: 0,
              end_word_index_exclusive: 4,
              sentence_index: 0,
            },
            difficulty: 1,
            answered: false,
          },
          progress_label: "Câu 1",
          choices: [
            { id: "A", label: "Trên bàn", value: "Trên bàn" },
            { id: "B", label: "Bên cửa sổ", value: "Bên cửa sổ" },
          ],
        }),
      submitAnswer: vi
        .fn<ReadingServices["comprehensionService"]["submitAnswer"]>()
        .mockRejectedValue(
          new Error("Configure the answer response in its test"),
        ),
    },
    devicePermissionService: {
      getSnapshot: vi
        .fn<ReadingServices["devicePermissionService"]["getSnapshot"]>()
        .mockResolvedValue({ camera: "ready", microphone: "ready" }),
      getMicrophonePermissionState: vi.fn().mockResolvedValue("prompt"),
      watchMicrophonePermissionState: vi
        .fn()
        .mockResolvedValue(() => undefined),
      requestAccess: vi
        .fn<ReadingServices["devicePermissionService"]["requestAccess"]>()
        .mockResolvedValue({
          status: "granted",
          verified: true,
          message: "Device is available",
          mediaRecorderSupported: true,
        }),
      retry: vi
        .fn<ReadingServices["devicePermissionService"]["retry"]>()
        .mockResolvedValue("ready"),
    },
    pageMatchService: {
      retryCurrentPage: vi
        .fn<ReadingServices["pageMatchService"]["retryCurrentPage"]>()
        .mockResolvedValue(pageFour),
      selectPage: vi
        .fn<ReadingServices["pageMatchService"]["selectPage"]>()
        .mockResolvedValue(pageFive),
    },
    readingService: {
      create: vi
        .fn<ReadingServices["readingService"]["create"]>()
        .mockRejectedValue(new Error("Unused test write")),
      get: vi.fn<ReadingServices["readingService"]["get"]>().mockResolvedValue({
        ...sessionSummaryFixture,
        state: "PAGE_READY",
        ended_at: null,
        duration_ms: null,
      }),
      getCurrentPage: vi
        .fn<ReadingServices["readingService"]["getCurrentPage"]>()
        .mockResolvedValue(pageFour),
      getPageProgress: vi
        .fn<ReadingServices["readingService"]["getPageProgress"]>()
        .mockResolvedValue(pageProgressFixture),
      navigateToPage: vi
        .fn<ReadingServices["readingService"]["navigateToPage"]>()
        .mockResolvedValue(pageProgressFixture),
      completeCurrentPage: vi
        .fn<ReadingServices["readingService"]["completeCurrentPage"]>()
        .mockResolvedValue({
          ...pageProgressFixture,
          completed_pages: 1,
          pages: [
            {
              ...pageProgressFixture.pages[0],
              status: "COMPLETED",
              completed_at: "2026-10-21T07:00:00Z",
            },
            pageProgressFixture.pages[1],
          ],
        }),
      getCompletionSummary: vi
        .fn<ReadingServices["readingService"]["getCompletionSummary"]>()
        .mockResolvedValue({
          duration_minutes: 8,
          pages_explored: 2,
          practiced_words: 0,
        }),
      finish: vi.fn().mockResolvedValue({
        // Giữ nguyên dữ liệu hiện tại
      }),
      createRetryEvent: vi.fn().mockResolvedValue(undefined),
    },
    readingSocketAdapter: {
      subscribe: vi
        .fn<ReadingServices["readingSocketAdapter"]["subscribe"]>()
        .mockReturnValue(vi.fn()),
      sendControl: vi
        .fn<ReadingServices["readingSocketAdapter"]["sendControl"]>()
        .mockResolvedValue("LISTENING"),
      reconnect: vi
        .fn<ReadingServices["readingSocketAdapter"]["reconnect"]>()
        .mockResolvedValue("recovered"),
      getSafetySnapshot: vi
        .fn<ReadingServices["readingSocketAdapter"]["getSafetySnapshot"]>()
        .mockReturnValue({
          connection: "connected",
          scoring_active: false,
          evidence_valid: false,
          child_error_events: [],
        }),
    },
    tutorService: {
      requestReadExample: vi
        .fn<ReadingServices["tutorService"]["requestReadExample"]>()
        .mockResolvedValue(tutorAction),
      retryReadExample: vi
        .fn<ReadingServices["tutorService"]["retryReadExample"]>()
        .mockResolvedValue(tutorAction),
    },
  } satisfies ReadingServices;
}

let services: ReturnType<typeof createReadingFixtures>;
beforeEach(() => {
  previousSpeechRecognition = Object.getOwnPropertyDescriptor(
    window,
    "SpeechRecognition",
  );
  services = createReadingFixtures();
  servicesHook.mockReset().mockReturnValue(services);
  speechRecorderMock.start.mockReset().mockResolvedValue(undefined);
  speechRecorderMock.prepare.mockReset().mockResolvedValue(undefined);
  speechRecorderMock.stop
    .mockReset()
    .mockResolvedValue(new Blob(["x".repeat(256)], { type: "audio/webm" }));
  speechRecorderMock.cancel.mockReset();
  speechRecorderMock.getStream.mockReset().mockReturnValue(null);
  speechRecorderMock.getIsSpeaking.mockReset().mockReturnValue(false);
  speechRecorderMock.getQuality.mockReset().mockReturnValue(undefined);
  speechPlayerMock.isPlaying = false;
  speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
  speechPlayerMock.playWithWordTimings.mockReset().mockResolvedValue(undefined);
  speechPlayerMock.stop.mockReset();
  speechServiceMock.synthesize.mockReset();
  speechServiceMock.transcribe.mockReset().mockRejectedValue(
    new ServiceError({
      code: "STT_QUOTA_EXCEEDED",
      status: 503,
      message: "Dịch vụ nhận diện giọng nói đã hết lượt sử dụng.",
      request_id: "quota-test",
      retryable: false,
    }),
  );
  compareTranscriptMock.mockReset().mockResolvedValue({
    session_id: TEST_SESSION_ID,
    page_id: pageFour.page_id,
    page_revision_id: pageFour.page_revision_id,
    distance: 0,
    alignment: [],
    summary: {
      missing_words: [],
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
function renderReading(
  state: ReadingUiState,
  requestedSessionId = TEST_SESSION_ID,
) {
  return render(
    <ReadingScreen
      initialUiState={state}
      reconnectMode="recover"
      sessionId={requestedSessionId}
    />,
  );
}

describe("ReadingScreen presentation with typed test-local service responses", () => {
  it("recovers from a live recorder failure without a false transcript or stale listening indicator", async () => {
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await screen.findByRole("button", { name: "Dừng nhận diện giọng nói" });
    act(() =>
      recorderErrorHandler.current?.(new Error("Microphone disconnected")),
    );
    await screen.findByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" });
    expect(
      screen.queryByRole("button", { name: "Dừng nhận diện giọng nói" }),
    ).not.toBeInTheDocument();
    expect(speechServiceMock.transcribe).not.toHaveBeenCalled();
    expect(compareTranscriptMock).not.toHaveBeenCalled();
    expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    await screen.findByRole("button", { name: "Dừng nhận diện giọng nói" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(speechRecorderMock.start).toHaveBeenCalledTimes(2);
  });
  it("restores a saved initial error and retry counter after refresh without opening the microphone", async () => {
    const getPracticeState = vi.fn().mockResolvedValue({
      session_id: TEST_SESSION_ID,
      legacy_evidence_present: false,
      pages: [
        {
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          page_number: 4,
          transcript: "Bé chó nhỏ đang",
          initial_assessment: pageFour.words.map((word, index) => ({
            word_id: word.word_id,
            word_index: word.word_index,
            text: word.text,
            status: index === 1 ? "MISPRONUNCIATION" : "CORRECT",
          })),
        },
      ],
      words: [
        {
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          word_id: pageFour.words[1].word_id,
          retry_attempt_count: 2,
          incorrect_retry_count: 2,
          resolution_status: "RETRYING",
        },
      ],
    });
    Object.assign(services.readingService, { getPracticeState });
    speechServiceMock.transcribe.mockResolvedValue({
      text: "chó",
      language_code: "vi",
      language_probability: 0.98,
      words: [],
    });
    const user = userEvent.setup();
    renderReading("ready");
    await screen.findByRole("button", { name: "Đồng ý, đọc lại" });
    expect(speechRecorderMock.prepare).not.toHaveBeenCalled();
    expect(speechRecorderMock.start).not.toHaveBeenCalled();
    expect(compareTranscriptMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Đồng ý, đọc lại" }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledOnce(),
    );
    await user.click(
      await screen.findByRole("button", { name: "Dừng nhận diện giọng nói" }),
    );
    await waitFor(() =>
      expect(services.readingService.createRetryEvent).toHaveBeenCalledOnce(),
    );
    expect(services.readingService.createRetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        wordId: pageFour.words[1].word_id,
        metadata: expect.objectContaining({
          retry_attempt: 3,
          incorrect_retry_count: 3,
          resolution_status: "UNRESOLVED",
        }),
      }),
    );
    await screen.findByText(/Đúng 3\/4 từ/);
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(compareTranscriptMock).not.toHaveBeenCalled();
  });
  it("keeps the newer single-word sample active after an older word is canceled", async () => {
    const user = userEvent.setup();
    let cancelFirst!: (error: Error) => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((_resolve, reject) => {
      cancelFirst = reject;
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    speechPlayerMock.play
      .mockImplementationOnce(() => {
        speechPlayerMock.isPlaying = true;
        return first;
      })
      .mockImplementationOnce(() => {
        speechPlayerMock.isPlaying = true;
        return second;
      });
    speechPlayerMock.stop.mockImplementation(() => {
      speechPlayerMock.isPlaying = false;
      cancelFirst(new DOMException("Stopped", "AbortError"));
    });
    renderReading("reading");
    await user.click(await screen.findByRole("button", { name: /^Bé$/ }));
    await waitFor(() => expect(speechPlayerMock.play).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: /^mèo$/ }));
    await waitFor(() => expect(speechPlayerMock.play).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Đọc mẫu 1 chữ:")).toBeInTheDocument();
    expect(screen.queryByText("Đọc mẫu cả đoạn:")).not.toBeInTheDocument();
    await act(async () => finishSecond());
    expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
  });

  it("cancels a page sample on navigation and ignores every stale sample callback", async () => {
    const user = userEvent.setup();
    let callbacks!: WordTimedPlayOptions;
    let cancel!: (error: Error) => void;
    const playback = new Promise<void>((_resolve, reject) => {
      cancel = reject;
    });
    speechPlayerMock.playWithWordTimings.mockImplementationOnce(
      (_words, options: WordTimedPlayOptions) => {
        callbacks = options;
        speechPlayerMock.isPlaying = true;
        options.onWordChange?.(1);
        return playback;
      },
    );
    speechPlayerMock.stop.mockImplementation(() => {
      speechPlayerMock.isPlaying = false;
      cancel(new DOMException("Stopped", "AbortError"));
    });
    services.readingService.getCurrentPage
      .mockResolvedValueOnce(pageFour)
      .mockResolvedValue(pageFive);
    services.readingService.navigateToPage.mockResolvedValue({
      ...pageProgressFixture,
      current_page_id: pageFive.page_id,
      current_page_number: 5,
      current_index: 1,
    });
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", {
        name: "Nghe đọc mẫu cả trang",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Trang tiếp theo" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Trang tiếp theo" }));
    await screen.findByLabelText("Trang sách 5");
    const firstWord = document.querySelector(
      `[data-word-id="${pageFive.words[0].word_id}"]`,
    );
    const previousClass = firstWord?.className;
    act(() => {
      callbacks.onPlay?.();
      callbacks.onWordChange?.(2);
      callbacks.onEnded?.();
    });
    expect(firstWord?.className).toBe(previousClass);
    expect(speechPlayerMock.stop).toHaveBeenCalled();
    expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
    expect(compareTranscriptMock).not.toHaveBeenCalled();
  });

  it.each([
    [false, "Bé chó nhỏ đang", "Bé mèo nhỏ đang", true],
    [false, "Bé mèo nhỏ đang", "Bé chó nhỏ đang", false],
    [true, "Bé chó nhỏ đang", "Bé mèo nhỏ đang", true],
    [true, "Bé mèo nhỏ đang", "Bé chó nhỏ đang", false],
  ] as const)(
    "keeps report and retry on the same final source (auto-page=%s, browser=%s)",
    async (autoPage, browserText, providerText, needsRetry) => {
      class Recognition {
        static instances: Recognition[] = [];
        onresult:
          | ((event: {
              resultIndex: number;
              results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
            }) => void)
          | null = null;
        onend: (() => void) | null = null;
        constructor() {
          Recognition.instances.push(this);
        }
        start() {}
        stop() {
          this.onend?.();
        }
      }
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: Recognition,
      });
      services.readingService.getPageProgress.mockResolvedValue({
        ...pageProgressFixture,
        persisted: autoPage,
      });
      speechServiceMock.transcribe.mockResolvedValue({
        text: providerText,
        language_code: "vi",
        words: [{ text: "provider-only-timing", start: 0, end: 1 }],
      });
      const user = userEvent.setup();
      renderReading("reading");
      await user.click(
        await screen.findByRole("button", {
          name: "Bé đọc với nhận diện giọng nói",
        }),
      );
      await waitFor(() => expect(Recognition.instances).toHaveLength(1));
      // Hold automatic next-page capture only; page completion still runs.
      const realSetTimeout = globalThis.setTimeout.bind(globalThis);
      const timer = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((handler, delay, ...args) =>
          realSetTimeout(handler, delay === 400 ? 60_000 : delay, ...args),
        );
      try {
        act(() =>
          Recognition.instances[0].onresult?.({
            resultIndex: 0,
            results: [{ isFinal: true, 0: { transcript: browserText } }],
          }),
        );
        if (autoPage) await screen.findByLabelText("Trang sách 5");
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
          ).toBeEnabled(),
        );
        await user.click(
          screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
        );
        await user.click(
          await screen.findByRole("button", { name: "Lưu và dừng" }),
        );
        await waitFor(() =>
          expect(compareTranscriptMock).toHaveBeenCalledWith(
            TEST_SESSION_ID,
            browserText,
            [],
            {
              page_id: pageFour.page_id,
              page_revision_id: pageFour.page_revision_id,
              initial_assessment: assessmentFor(pageFour, [
                "CORRECT",
                needsRetry ? "MISPRONUNCIATION" : "CORRECT",
                "CORRECT",
                "CORRECT",
              ]),
            },
          ),
        );
        if (needsRetry) {
          expect(
            await screen.findByRole("button", { name: "Đồng ý, đọc lại" }),
          ).toBeInTheDocument();
          expect(
            screen.getByText(/Bé còn 1 từ cần đọc lại/),
          ).toBeInTheDocument();
          expect(services.readingService.finish).not.toHaveBeenCalled();
        } else {
          await waitFor(() =>
            expect(services.readingService.finish).toHaveBeenCalledOnce(),
          );
          expect(
            screen.queryByRole("button", { name: "Đồng ý, đọc lại" }),
          ).not.toBeInTheDocument();
        }
        expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
      } finally {
        timer.mockRestore();
      }
    },
  );

  it.each(["played", "failed"] as const)(
    "releases a prepared microphone before voice preview: %s",
    async (outcome) => {
      let settlePreview: () => void = () => undefined;
      const playback = new Promise<void>((resolve, reject) => {
        settlePreview = () =>
          outcome === "played"
            ? resolve()
            : reject(new Error("Preview unavailable"));
      });
      let captureReleasedBeforePlayback = false;
      speechPlayerMock.playWithWordTimings.mockImplementationOnce(() => {
        captureReleasedBeforePlayback =
          speechRecorderMock.cancel.mock.calls.length === 1 &&
          speechRecorderMock.start.mock.calls.length === 0;
        return playback;
      });

      const user = userEvent.setup();
      renderReading("reading");
      await user.click(
        await screen.findByRole("button", { name: "Giọng đọc" }),
      );
      speechRecorderMock.cancel.mockClear();
      await user.click(screen.getByRole("button", { name: "Nghe thử" }));
      await waitFor(() =>
        expect(speechPlayerMock.playWithWordTimings).toHaveBeenCalledOnce(),
      );
      expect(captureReleasedBeforePlayback).toBe(true);
      expect(speechRecorderMock.cancel).toHaveBeenCalledOnce();
      expect(speechRecorderMock.start).not.toHaveBeenCalled();
      await act(async () => settlePreview());
      expect(speechRecorderMock.start).not.toHaveBeenCalled();
      expect(speechServiceMock.transcribe).not.toHaveBeenCalled();
      expect(compareTranscriptMock).not.toHaveBeenCalled();
      expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps browser final speech page-scoped without duplicate alignment: %s",
    async (duplicate) => {
      class FakeSpeechRecognition {
        static instances: FakeSpeechRecognition[] = [];
        onresult:
          | ((event: {
              resultIndex: number;
              results: Array<{
                isFinal: boolean;
                0: { transcript: string };
              }>;
            }) => void)
          | null = null;
        onerror: ((event: { error?: string }) => void) | null = null;
        onend: (() => void) | null = null;
        continuous = false;
        interimResults = false;
        lang = "";
        maxAlternatives = 1;

        constructor() {
          FakeSpeechRecognition.instances.push(this);
        }

        start() {}
        stop() {
          this.onend?.();
        }
      }

      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: FakeSpeechRecognition,
      });

      const user = userEvent.setup();
      renderReading("ready");
      await user.click(
        await screen.findByRole("button", { name: "Bắt đầu đọc" }),
      );

      await user.click(
        await screen.findByRole("button", {
          name: "Bé đọc với nhận diện giọng nói",
        }),
      );
      await screen.findByRole("button", {
        name: "Dừng nhận diện giọng nói",
      });
      await waitFor(() => {
        expect(speechRecorderMock.start).toHaveBeenCalledOnce();
        expect(FakeSpeechRecognition.instances).toHaveLength(1);
      });

      const recognition = FakeSpeechRecognition.instances[0];
      act(() => {
        recognition.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: false, 0: { transcript: "Bé mèo" } }],
        });
      });
      const finalEvent = {
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: "Bé mèo" } }],
      };
      act(() => {
        recognition.onresult?.(finalEvent);
        if (duplicate) recognition.onresult?.(finalEvent);
      });
      expect(screen.getByRole("button", { name: "Bé" })).toHaveClass(
        "bg-green-200",
      );
      expect(screen.getByRole("button", { name: "mèo" })).toHaveClass(
        "bg-green-200",
      );
      expect(screen.getByRole("button", { name: "nhỏ" })).not.toHaveClass(
        "bg-orange-200",
      );

      await user.click(
        screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Lưu và dừng" }),
      );
      await user.click(await screen.findByRole("button", { name: "Bỏ qua" }));
      await waitFor(() => {
        expect(speechServiceMock.transcribe).toHaveBeenCalledOnce();
        expect(compareTranscriptMock).toHaveBeenCalledOnce();
        expect(services.readingService.finish).toHaveBeenCalledOnce();
      });

      expect(compareTranscriptMock).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        "Bé mèo",
        [],
        {
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          initial_assessment: assessmentFor(pageFour, [
            "CORRECT",
            "CORRECT",
            "OMISSION",
            "OMISSION",
          ]),
        },
      );
      expect(
        screen.queryByText("Báo cáo đọc chưa sẵn sàng"),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    "correct",
    "incorrect-limit",
    "technical-error",
    "third-correct",
    "save-recovery",
    "stale-restart",
    "multiple-words",
    "low-confidence-keyterm",
    "wrong-language-keyterm",
    "browser-corroborated-keyterm",
    "pause-retry",
  ] as const)(
    "uses recorded Vietnamese STT for retry outcome: %s",
    async (outcome) => {
      class FakeSpeechRecognition {
        static instances: FakeSpeechRecognition[] = [];
        onresult:
          | ((event: {
              resultIndex: number;
              results: Array<{
                isFinal: boolean;
                length: number;
                0: { transcript: string };
              }>;
            }) => void)
          | null = null;
        onerror: ((event: { error?: string }) => void) | null = null;
        onend: (() => void) | null = null;
        continuous = false;
        interimResults = false;
        lang = "";
        maxAlternatives = 1;

        constructor() {
          FakeSpeechRecognition.instances.push(this);
        }

        start() {}
        stop() {
          this.onend?.();
        }
      }

      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: FakeSpeechRecognition,
      });

      const user = userEvent.setup();
      renderReading("ready");
      await user.click(
        await screen.findByRole("button", { name: "Bắt đầu đọc" }),
      );
      await user.click(
        await screen.findByRole("button", {
          name: "Bé đọc với nhận diện giọng nói",
        }),
      );
      await screen.findByRole("button", {
        name: "Dừng nhận diện giọng nói",
      });

      await waitFor(() => {
        expect(FakeSpeechRecognition.instances).toHaveLength(1);
        expect(speechRecorderMock.start).toHaveBeenCalledOnce();
      });

      // Hold only the page-turn resume window: this scenario finishes before
      // next-page capture. Automatic resume itself has a separate regression.
      const realSetTimeout = globalThis.setTimeout.bind(globalThis);
      const pageResumeTimer = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((handler, delay, ...args) =>
          realSetTimeout(handler, delay === 400 ? 60_000 : delay, ...args),
        );
      act(() => {
        FakeSpeechRecognition.instances[0].onresult?.({
          resultIndex: 0,
          results: [
            {
              isFinal: true,
              length: 1,
              0: {
                transcript:
                  outcome === "multiple-words" ? "Bé đang" : "Bé nhỏ đang",
              },
            },
          ],
        });
      });

      await screen.findByLabelText("Trang sách 5");
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
        ).toBeEnabled();
      });
      await user.click(
        screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Lưu và dừng" }),
      );
      const retryConsent = await screen.findByRole("button", {
        name: "Đồng ý, đọc lại",
      });
      pageResumeTimer.mockRestore();
      await waitFor(() => expect(retryConsent).toBeEnabled());
      expect(
        screen.getByText(
          outcome === "multiple-words"
            ? /Bé còn 2 từ cần đọc lại/
            : /Bé còn 1 từ cần đọc lại/,
        ),
      ).toBeInTheDocument();

      await user.click(retryConsent);
      await screen.findByText(/Bé đọc lại từ/);
      expect(screen.getByText("Từ cần luyện: “mèo”")).toBeInTheDocument();
      await waitFor(() => {
        expect(services.readingService.navigateToPage).toHaveBeenCalledWith(
          TEST_SESSION_ID,
          pageFour.page_id,
        );
      });
      await waitFor(() => {
        expect(speechRecorderMock.prepare).toHaveBeenCalledOnce();
        expect(speechRecorderMock.start).toHaveBeenCalledTimes(2);
        expect(speechPlayerMock.play).toHaveBeenNthCalledWith(
          1,
          "Bé hãy đọc lại từ mèo nhé.",
        );
        expect(speechPlayerMock.play).toHaveBeenNthCalledWith(2, "mèo");
      });
      expect(
        screen.queryByRole("button", {
          name: "Bé đọc với nhận diện giọng nói",
        }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Chuẩn bị đọc:/)).not.toBeInTheDocument();

      await waitFor(() => {
        expect(FakeSpeechRecognition.instances).toHaveLength(2);
        expect(speechRecorderMock.start).toHaveBeenCalledTimes(2);
      });

      if (outcome === "pause-retry") {
        await user.click(
          screen.getByRole("button", { name: "Tạm dừng buổi đọc" }),
        );
        await screen.findByText("Bé đang nghỉ một chút");
        expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
        expect(speechRecorderMock.cancel).toHaveBeenCalled();
        expect(speechPlayerMock.stop).toHaveBeenCalled();
        expect(speechRecorderMock.start).toHaveBeenCalledTimes(2);
        await user.click(screen.getByRole("button", { name: "Đọc tiếp" }));
        await waitFor(() =>
          expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
        );
        expect(screen.getByText("Từ cần luyện: “mèo”")).toBeInTheDocument();
        expect(speechPlayerMock.play).toHaveBeenCalledTimes(4);
        expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
        return;
      }

      if (
        outcome === "low-confidence-keyterm" ||
        outcome === "wrong-language-keyterm" ||
        outcome === "browser-corroborated-keyterm"
      ) {
        speechServiceMock.transcribe
          .mockResolvedValueOnce({
            text: "mèo",
            language_code: outcome === "wrong-language-keyterm" ? "en" : "vi",
            words: [{ text: "mèo", start: 0, end: 1, logprob: -5 }],
          })
          .mockResolvedValueOnce({
            text: "mèo",
            language_code: "vi",
            words: [{ text: "mèo", start: 0, end: 1, logprob: -0.1 }],
          });
        if (outcome === "browser-corroborated-keyterm") {
          act(() =>
            FakeSpeechRecognition.instances[1].onresult?.({
              resultIndex: 0,
              results: [{ isFinal: true, length: 1, 0: { transcript: "mèo" } }],
            }),
          );
          await waitFor(() =>
            expect(
              services.readingService.createRetryEvent,
            ).toHaveBeenCalledOnce(),
          );
          expect(services.readingService.createRetryEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              status: "CONFIRMED",
              metadata: expect.objectContaining({
                resolution_status: "SELF_CORRECTED",
              }),
            }),
          );
        } else {
          await user.click(
            screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
          );
          // An unclear capture resumes listening without saving a scored retry.
          await waitFor(() =>
            expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
          );
          expect(
            services.readingService.createRetryEvent,
          ).not.toHaveBeenCalled();
          expect(services.readingService.finish).not.toHaveBeenCalled();
          expect(screen.getByRole("button", { name: "mèo" })).not.toHaveClass(
            "bg-green-200",
          );
        }
        expect(speechServiceMock.transcribe).toHaveBeenLastCalledWith(
          expect.any(Blob),
          expect.objectContaining({ keyterms: ["mèo"] }),
        );
        return;
      }

      if (outcome === "multiple-words") {
        for (let count = 1; count <= 3; count += 1) {
          speechServiceMock.transcribe.mockResolvedValueOnce({
            text: "chó",
            language_code: "vi",
            words: [],
          });
          await user.click(
            screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
          );
          await waitFor(() =>
            expect(
              services.readingService.createRetryEvent,
            ).toHaveBeenCalledTimes(count),
          );
          if (count < 3) {
            await waitFor(() =>
              expect(speechRecorderMock.start).toHaveBeenCalledTimes(count + 2),
            );
          }
        }
        await screen.findByText("Từ cần luyện: “nhỏ”");
        await waitFor(() =>
          expect(speechRecorderMock.start).toHaveBeenCalledTimes(5),
        );
        expect(services.readingService.finish).not.toHaveBeenCalled();
        expect(
          services.readingService.createRetryEvent,
        ).toHaveBeenLastCalledWith(
          expect.objectContaining({
            wordId: pageFour.words[1].word_id,
            metadata: expect.objectContaining({
              retry_attempt: 3,
              incorrect_retry_count: 3,
              resolution_status: "UNRESOLVED",
            }),
          }),
        );
        // A callback retained by the browser for the previous word is obsolete.
        act(() =>
          FakeSpeechRecognition.instances[1].onresult?.({
            resultIndex: 0,
            results: [{ isFinal: true, length: 1, 0: { transcript: "mèo" } }],
          }),
        );
        expect(services.readingService.createRetryEvent).toHaveBeenCalledTimes(
          3,
        );
        speechServiceMock.transcribe.mockResolvedValueOnce({
          text: "nhỏ",
          language_code: "vi",
          words: [],
        });
        await user.click(
          screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
        );
        await waitFor(() =>
          expect(services.readingService.finish).toHaveBeenCalledOnce(),
        );
        expect(services.readingService.createRetryEvent).toHaveBeenCalledTimes(
          4,
        );
        expect(
          services.readingService.createRetryEvent,
        ).toHaveBeenLastCalledWith(
          expect.objectContaining({
            wordId: pageFour.words[2].word_id,
            status: "CONFIRMED",
            metadata: expect.objectContaining({
              retry_attempt: 1,
              incorrect_retry_count: 0,
              resolution_status: "SELF_CORRECTED",
            }),
          }),
        );
        expect(await screen.findByText(/Đúng 2\/4 từ/)).toHaveTextContent(
          "Bỏ sót 2 từ",
        );
        expect(screen.getByText("50%")).toBeInTheDocument();
        return;
      }

      if (outcome === "stale-restart") {
        const restartCallbacks: Array<() => void> = [];
        const setTimeout = globalThis.setTimeout.bind(globalThis);
        const timeoutSpy = vi
          .spyOn(globalThis, "setTimeout")
          .mockImplementation((handler, delay, ...args) => {
            if (delay === 250 && typeof handler === "function") {
              restartCallbacks.push(() => handler(...args));
              return setTimeout(() => undefined, 0);
            }
            return setTimeout(handler, delay, ...args);
          });
        let finishCaptureStart: () => void = () => undefined;
        speechRecorderMock.start.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishCaptureStart = resolve;
            }),
        );
        try {
          act(() => FakeSpeechRecognition.instances[1].onend?.());
          expect(restartCallbacks).toHaveLength(1);
          await user.click(
            screen.getByRole("button", { name: "Nghe mẫu từ cần đọc lại" }),
          );
          await waitFor(() =>
            expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
          );
          act(() => restartCallbacks[0]());
          expect(speechRecorderMock.start).toHaveBeenCalledTimes(3);
          expect(FakeSpeechRecognition.instances).toHaveLength(2);
        } finally {
          timeoutSpy.mockRestore();
          await act(async () => finishCaptureStart());
        }
        await waitFor(() =>
          expect(FakeSpeechRecognition.instances).toHaveLength(3),
        );
        expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
        return;
      }

      act(() => {
        FakeSpeechRecognition.instances[1].onresult?.({
          resultIndex: 0,
          results: [
            {
              isFinal: true,
              length: 1,
              0: { transcript: "méo" },
            },
          ],
        });
      });
      expect(
        screen.getByText("Đang nghe bé đọc từ này..."),
      ).toBeInTheDocument();
      if (outcome === "technical-error") {
        await user.click(
          screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
        );
        expect(
          await screen.findByText(/Chưa kết nối được dịch vụ nhận diện/),
        ).toBeInTheDocument();
        expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
        expect(services.readingService.finish).not.toHaveBeenCalled();
        await user.click(
          screen.getByRole("button", { name: "Nghe lại và thử" }),
        );
        await waitFor(() =>
          expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
        );
      }
      if (outcome === "save-recovery") {
        services.readingService.createRetryEvent.mockRejectedValueOnce(
          new Error("Temporary save failure"),
        );
      }
      speechServiceMock.transcribe.mockResolvedValueOnce({
        text:
          outcome === "correct" ||
          outcome === "technical-error" ||
          outcome === "save-recovery"
            ? "mèo"
            : "chó",
        language_code: "vi",
        language_probability: 0.98,
        words: [],
      });
      await user.click(
        await screen.findByRole("button", {
          name: "Dừng nhận diện giọng nói",
        }),
      );

      if (outcome === "save-recovery") {
        await screen.findByText("Chưa lưu được kết quả đọc lại.");
        expect(services.readingService.finish).not.toHaveBeenCalled();
        const originalPayload =
          services.readingService.createRetryEvent.mock.calls[0][0];
        await user.click(screen.getByRole("button", { name: "Thử lưu lại" }));
        await waitFor(() =>
          expect(services.readingService.finish).toHaveBeenCalledOnce(),
        );
        expect(services.readingService.createRetryEvent).toHaveBeenCalledTimes(
          2,
        );
        expect(
          services.readingService.createRetryEvent.mock.calls[1][0],
        ).toEqual(originalPayload);
        expect(await screen.findByText(/Đúng 3\/4 từ/)).toHaveTextContent(
          "Bỏ sót 1 từ",
        );
        return;
      }

      if (outcome === "incorrect-limit" || outcome === "third-correct") {
        for (let incorrectCount = 1; incorrectCount <= 3; incorrectCount += 1) {
          await waitFor(() => {
            expect(
              services.readingService.createRetryEvent,
            ).toHaveBeenCalledTimes(incorrectCount);
          });
          expect(
            services.readingService.createRetryEvent,
          ).toHaveBeenLastCalledWith(
            expect.objectContaining({
              status:
                outcome === "third-correct" && incorrectCount === 3
                  ? "CONFIRMED"
                  : "FAILED",
              metadata: expect.objectContaining({
                retry_attempt: incorrectCount,
                incorrect_retry_count:
                  outcome === "third-correct" && incorrectCount === 3
                    ? 2
                    : incorrectCount,
                resolution_status:
                  incorrectCount === 3
                    ? outcome === "third-correct"
                      ? "SELF_CORRECTED"
                      : "UNRESOLVED"
                    : "RETRYING",
              }),
            }),
          );
          if (incorrectCount === 3) break;
          await waitFor(() => {
            expect(speechRecorderMock.start).toHaveBeenCalledTimes(
              incorrectCount + 2,
            );
          });
          speechServiceMock.transcribe.mockResolvedValueOnce({
            text:
              outcome === "third-correct" && incorrectCount === 2
                ? "mèo"
                : "chó",
            language_code: "vi",
            words: [],
          });
          await user.click(
            await screen.findByRole("button", {
              name: "Dừng nhận diện giọng nói",
            }),
          );
        }
        await waitFor(() => {
          expect(services.readingService.finish).toHaveBeenCalledOnce();
        });
        expect(services.readingService.createRetryEvent).toHaveBeenCalledTimes(
          3,
        );
        expect(await screen.findByText(/Đúng 3\/4 từ/)).toHaveTextContent(
          "Bỏ sót 1 từ",
        );
        expect(screen.getByText("75%")).toBeInTheDocument();
        return;
      }

      await waitFor(() => {
        expect(speechServiceMock.transcribe).toHaveBeenCalledTimes(
          outcome === "technical-error" ? 3 : 2,
        );
        expect(services.readingService.finish).toHaveBeenCalledOnce();
      });
      expect(services.readingService.createRetryEvent).toHaveBeenCalledOnce();
      expect(services.readingService.createRetryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "CONFIRMED",
          pageId: pageFour.page_id,
          pageRevisionId: pageFour.page_revision_id,
          wordId: pageFour.words[1].word_id,
          metadata: expect.objectContaining({
            retry_attempt: 1,
            incorrect_retry_count: 0,
            resolution_status: "SELF_CORRECTED",
            original_status: "OMISSION",
            recognized_text: "mèo",
            target_word: "mèo",
          }),
        }),
      );
      expect(await screen.findByText(/Đúng 3\/4 từ/)).toHaveTextContent(
        "Bỏ sót 1 từ",
      );
      expect(screen.getByText("75%")).toBeInTheDocument();
      expect(compareTranscriptMock).toHaveBeenCalledOnce();
      expect(compareTranscriptMock).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        "Bé nhỏ đang",
        [],
        {
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          initial_assessment: assessmentFor(pageFour, [
            "CORRECT",
            "OMISSION",
            "CORRECT",
            "CORRECT",
          ]),
        },
      );
    },
  );

  it("preserves a retry candidate and offers page recovery when its original revision cannot be reopened", async () => {
    class FakeSpeechRecognition {
      static instances: FakeSpeechRecognition[] = [];
      onresult:
        | ((event: {
            resultIndex: number;
            results: Array<{
              isFinal: boolean;
              length: number;
              0: { transcript: string };
            }>;
          }) => void)
        | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 1;

      constructor() {
        FakeSpeechRecognition.instances.push(this);
      }

      start() {}
      stop() {
        this.onend?.();
      }
    }

    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
    services.readingService.getCurrentPage
      .mockResolvedValueOnce(pageFour)
      .mockResolvedValueOnce(pageFour);
    services.readingService.navigateToPage.mockRejectedValueOnce(
      new Error("temporary retry navigation failure"),
    );

    const user = userEvent.setup();
    renderReading("ready");
    await user.click(
      await screen.findByRole("button", { name: "Bắt đầu đọc" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await waitFor(() => {
      expect(FakeSpeechRecognition.instances).toHaveLength(1);
      expect(speechRecorderMock.start).toHaveBeenCalledOnce();
    });

    act(() => {
      FakeSpeechRecognition.instances[0].onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal: true,
            length: 1,
            0: { transcript: "Bé nhỏ đang" },
          },
        ],
      });
    });

    await screen.findByLabelText("Trang sách 5");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
      ).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: "Kết thúc buổi đọc" }));
    await user.click(
      await screen.findByRole("button", { name: "Lưu và dừng" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Đồng ý, đọc lại" }),
    );

    await screen.findByText(/Bé đọc lại từ/);
    await waitFor(() => {
      expect(services.readingService.navigateToPage).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        pageFour.page_id,
      );
    });
    expect(services.readingService.navigateToPage).toHaveBeenCalledOnce();
    expect(screen.getByText("Từ cần luyện: “mèo”")).toBeInTheDocument();
    expect(screen.getByText(/Chưa mở lại được trang 4/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Thử mở lại trang" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Bật mic" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Bỏ qua từ này" }),
    ).toBeDisabled();
    expect(services.readingService.finish).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Thử mở lại trang" }));
    await waitFor(() => {
      expect(services.readingService.navigateToPage).toHaveBeenCalledTimes(2);
      expect(services.readingService.navigateToPage).toHaveBeenNthCalledWith(
        2,
        TEST_SESSION_ID,
        pageFour.page_id,
      );
    });
    const restoredPage = await screen.findByLabelText("Trang sách 4");
    await waitFor(() => {
      expect(restoredPage).toHaveAttribute(
        "data-page-revision-id",
        pageFour.page_revision_id,
      );
    });
    expect(screen.getByText("Từ cần luyện: “mèo”")).toBeInTheDocument();
    expect(
      screen.queryByText(/Chưa mở lại được trang 4/),
    ).not.toBeInTheDocument();
    const skipWordButton = screen.getByRole("button", {
      name: "Bỏ qua từ này",
    });
    expect(skipWordButton).toBeEnabled();
    expect(screen.getByText(/Bé đọc lại từ ·/)).toHaveTextContent("1/1");
    await user.click(skipWordButton);

    await waitFor(() => {
      expect(services.readingService.finish).toHaveBeenCalledOnce();
    });
    expect(services.readingService.createRetryEvent).toHaveBeenCalledOnce();
    expect(services.readingService.createRetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: pageFour.page_id,
        pageRevisionId: pageFour.page_revision_id,
        wordId: pageFour.words[1].word_id,
        status: "UNCERTAIN",
        metadata: expect.objectContaining({
          retry_attempt: 1,
          incorrect_retry_count: 0,
          resolution_status: "UNRESOLVED",
          skip_reason: "TECHNICAL_OR_MANUAL",
        }),
      }),
    );
  });

  it("does not finish twice on compare or socket failure", async () => {
    class FakeSpeechRecognition {
      static instances: FakeSpeechRecognition[] = [];
      onresult:
        | ((event: {
            resultIndex: number;
            results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
          }) => void)
        | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 1;

      constructor() {
        FakeSpeechRecognition.instances.push(this);
      }
      start() {}
      stop() {
        this.onend?.();
      }
    }

    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
    compareTranscriptMock.mockRejectedValueOnce(
      new Error("temporary comparison failure"),
    );
    services.readingSocketAdapter.sendControl.mockImplementation(
      async (_sessionId, command) => {
        if (command === "finish") {
          throw new Error("websocket unavailable");
        }
        return "LISTENING";
      },
    );

    const user = userEvent.setup();
    renderReading("ready");
    await user.click(
      await screen.findByRole("button", { name: "Bắt đầu đọc" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await screen.findByRole("button", {
      name: "Dừng nhận diện giọng nói",
    });
    await waitFor(() => {
      expect(FakeSpeechRecognition.instances).toHaveLength(1);
    });

    act(() => {
      FakeSpeechRecognition.instances[0].onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: "Con mèo" } }],
      });
    });
    await user.click(screen.getByRole("button", { name: "Kết thúc buổi đọc" }));
    await user.click(
      await screen.findByRole("button", { name: "Lưu và dừng" }),
    );
    await screen.findByText(/Chưa lưu được bài đọc/);
    expect(compareTranscriptMock).toHaveBeenCalledOnce();
    expect(services.readingService.finish).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Đồng ý, đọc lại" }),
    ).not.toBeInTheDocument();
    const originalSnapshot = compareTranscriptMock.mock.calls[0];
    await user.click(screen.getByRole("button", { name: "Lưu và dừng" }));
    await user.click(await screen.findByRole("button", { name: "Bỏ qua" }));

    await waitFor(() => {
      expect(compareTranscriptMock).toHaveBeenCalledTimes(2);
      expect(services.readingService.finish).toHaveBeenCalledOnce();
      expect(services.readingService.getCompletionSummary).toHaveBeenCalled();
    });
    expect(compareTranscriptMock.mock.calls[1]).toEqual(originalSnapshot);
    expect(services.readingSocketAdapter.sendControl).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      "finish",
    );
  });

  it("finishes the session without inventing a report when neither STT source has final text", async () => {
    class EmptySpeechRecognition {
      static instances: EmptySpeechRecognition[] = [];
      onresult:
        | ((event: {
            resultIndex: number;
            results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
          }) => void)
        | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 1;

      constructor() {
        EmptySpeechRecognition.instances.push(this);
      }
      start() {}
      stop() {
        this.onend?.();
      }
    }

    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: EmptySpeechRecognition,
    });

    const user = userEvent.setup();
    renderReading("ready");
    await user.click(
      await screen.findByRole("button", { name: "Bắt đầu đọc" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await screen.findByRole("button", {
      name: "Dừng nhận diện giọng nói",
    });
    await waitFor(() => {
      expect(EmptySpeechRecognition.instances).toHaveLength(1);
    });

    await user.click(screen.getByRole("button", { name: "Kết thúc buổi đọc" }));
    await user.click(
      await screen.findByRole("button", { name: "Lưu và dừng" }),
    );

    await waitFor(() => {
      expect(services.readingService.finish).toHaveBeenCalledOnce();
      expect(screen.getByText("Báo cáo đọc chưa sẵn sàng")).toBeInTheDocument();
    });
    expect(compareTranscriptMock).not.toHaveBeenCalled();
  });

  it.each(["pause", "navigate"] as const)(
    "cancels the microphone countdown on %s",
    async (action) => {
      services.readingService.getCurrentPage
        .mockResolvedValueOnce(pageFour)
        .mockResolvedValue(pageFive);
      renderReading("ready");
      const startButton = await screen.findByRole("button", {
        name: "Bắt đầu đọc",
      });
      vi.useFakeTimers();
      try {
        await act(async () => {
          fireEvent.click(startButton);
        });
        expect(speechRecorderMock.start).not.toHaveBeenCalled();
        await act(async () => {
          fireEvent.click(
            screen.getByRole("button", {
              name:
                action === "pause" ? "Tạm dừng buổi đọc" : "Trang tiếp theo",
            }),
          );
        });
        if (action === "pause") {
          expect(
            screen.getByRole("dialog", { name: "Bé đang nghỉ một chút" }),
          ).toBeInTheDocument();
        } else {
          expect(screen.getByLabelText("Trang sách 5")).toBeInTheDocument();
        }
        for (let tick = 0; tick < 5; tick += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
          });
        }
        expect(speechRecorderMock.start).not.toHaveBeenCalled();
        expect(speechRecorderMock.cancel).toHaveBeenCalled();
        expect(speechServiceMock.transcribe).not.toHaveBeenCalled();
        expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not start a second recorder when countdown ends during microphone setup", async () => {
    let finishStart: () => void = () => undefined;
    speechRecorderMock.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    renderReading("ready");
    const startButton = await screen.findByRole("button", {
      name: "Bắt đầu đọc",
    });
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(startButton);
      });
      act(() => {
        fireEvent.click(
          screen.getByRole("button", {
            name: "Bé đọc với nhận diện giọng nói",
          }),
        );
      });
      expect(speechRecorderMock.start).toHaveBeenCalledOnce();
      for (let tick = 0; tick < 5; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(speechRecorderMock.start).toHaveBeenCalledOnce();
    } finally {
      await act(async () => finishStart());
      vi.useRealTimers();
    }
  });

  it("cancels pending microphone setup before finishing an empty session", async () => {
    let finishStart: () => void = () => undefined;
    speechRecorderMock.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    renderReading("ready");
    const start = await screen.findByRole("button", { name: "Bắt đầu đọc" });
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.click(start));
      for (let tick = 0; tick < 5; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(speechRecorderMock.start).toHaveBeenCalledOnce();
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
        ),
      );
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Lưu và dừng" })),
      );
      expect(services.readingService.finish).toHaveBeenCalledOnce();
      const browserConstructor = vi.fn();
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: browserConstructor,
      });
      await act(async () => finishStart());
      expect(browserConstructor).not.toHaveBeenCalled();
      expect(compareTranscriptMock).not.toHaveBeenCalled();
    } finally {
      await act(async () => finishStart());
      vi.useRealTimers();
    }
  });

  it("ignores microphone setup that resolves after the reading screen unmounts", async () => {
    let finishStart: () => void = () => undefined;
    speechRecorderMock.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    const { unmount } = renderReading("reading");
    const button = await screen.findByRole("button", {
      name: "Bé đọc với nhận diện giọng nói",
    });
    fireEvent.click(button);
    expect(speechRecorderMock.start).toHaveBeenCalledOnce();
    const browserConstructor = vi.fn();
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: browserConstructor,
    });
    unmount();
    speechRecorderMock.cancel.mockClear();
    await act(async () => finishStart());
    expect(browserConstructor).not.toHaveBeenCalled();
    expect(speechRecorderMock.cancel).toHaveBeenCalled();
    expect(compareTranscriptMock).not.toHaveBeenCalled();
    expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
  });

  it("does not restart an obsolete browser recognizer after a TTS handoff", async () => {
    class Recognition {
      static instances: Recognition[] = [];
      onresult = null;
      onerror = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      constructor() {
        Recognition.instances.push(this);
      }
      stop() {
        this.onend?.();
      }
    }
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: Recognition,
    });
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    expect(Recognition.instances).toHaveLength(1);
    const old = Recognition.instances[0];
    const callbacks: Array<() => void> = [];
    const originalTimeout = globalThis.setTimeout.bind(globalThis);
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 200) {
          callbacks.push(() => callback(...args));
          return originalTimeout(() => undefined, 0);
        }
        return originalTimeout(callback, delay, ...args);
      });
    try {
      act(() => old.onend?.());
      expect(callbacks).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: "Bé" }));
      await waitFor(() => expect(Recognition.instances).toHaveLength(2));
      act(() => callbacks[0]());
      expect(old.start).toHaveBeenCalledOnce();
      expect(Recognition.instances[1].start).toHaveBeenCalledOnce();
      expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("opens the reading controls after start without claiming the microphone is already recording", async () => {
    const user = userEvent.setup();
    renderReading("ready");
    expect(
      await screen.findAllByRole("heading", { name: "Sẵn sàng đọc chưa nào?" }),
    ).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Bắt đầu đọc" }));
    expect(
      await screen.findByRole("navigation", { name: "Điều khiển buổi đọc" }),
    ).toBeInTheDocument();
    expect(services.readingSocketAdapter.sendControl).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      "start",
    );
    expect(screen.getByText("Mình đang chờ bé")).toBeInTheDocument();
    expect(screen.queryByText("Mình đang nghe bé đọc")).not.toBeInTheDocument();
    expect(speechRecorderMock.start).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Trạng thái kết nối: đã kết nối\./),
    ).toBeInTheDocument();
  });

  it("shows the selected range and navigates only to a saved next page", async () => {
    const user = userEvent.setup();
    renderReading("reading");

    expect(
      await screen.findByText(/Phạm vi đọc: Trang 4–5/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trang trước" })).toBeDisabled();
    const nextButton = screen.getByRole("button", { name: "Trang tiếp theo" });
    expect(nextButton).toBeEnabled();

    await user.click(nextButton);

    await waitFor(() => {
      expect(services.readingService.navigateToPage).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        pageFive.page_id,
      );
    });
  });

  it.each(["manual", "automatic"] as const)(
    "preserves first-page errors and ignores old callbacks across %s page transitions",
    async (transition) => {
      class Recognition {
        static instances: Recognition[] = [];
        onresult:
          | ((event: {
              resultIndex: number;
              results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
            }) => void)
          | null = null;
        onerror: ((event: { error: string }) => void) | null = null;
        onend: (() => void) | null = null;
        start = vi.fn();
        constructor() {
          Recognition.instances.push(this);
        }
        stop() {
          this.onend?.();
        }
        say(text: string) {
          this.onresult?.({
            resultIndex: 0,
            results: [{ isFinal: true, 0: { transcript: text } }],
          });
        }
      }
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: Recognition,
      });
      const nextProgress: ReadingSessionPageProgressDTO = {
        ...pageProgressFixture,
        current_page_id: pageFive.page_id,
        current_page_number: 5,
        current_index: 1,
        completed_pages: transition === "automatic" ? 1 : 0,
        pages: [
          pageProgressFixture.pages[0],
          { ...pageProgressFixture.pages[1], status: "IN_PROGRESS" },
        ],
      };
      services.readingService.getCurrentPage
        .mockResolvedValueOnce(pageFour)
        .mockResolvedValue(pageFive);
      services.readingService.getPageProgress
        .mockResolvedValueOnce(pageProgressFixture)
        .mockResolvedValue(nextProgress);
      services.readingService.navigateToPage.mockResolvedValue(nextProgress);
      const completedFirst = await services.readingService.completeCurrentPage(
        TEST_SESSION_ID,
        pageFour.page_id,
      );
      services.readingService.completeCurrentPage
        .mockClear()
        .mockImplementation(async (_sessionId, pageId) =>
          pageId === pageFour.page_id
            ? completedFirst
            : {
                ...nextProgress,
                pages: [
                  nextProgress.pages[0],
                  { ...nextProgress.pages[1], status: "COMPLETED" },
                ],
              },
        );
      speechServiceMock.transcribe.mockResolvedValue({
        text: "Bé nhỏ đang",
        words: [],
      });
      const user = userEvent.setup();
      renderReading("reading");
      await user.click(
        await screen.findByRole("button", {
          name: "Bé đọc với nhận diện giọng nói",
        }),
      );
      const old = Recognition.instances[0];
      act(() => old.say(transition === "manual" ? "Bé nhỏ" : "Bé nhỏ đang"));
      if (transition === "manual") {
        await user.click(
          screen.getByRole("button", { name: "Trang tiếp theo" }),
        );
      }
      await screen.findByLabelText("Trang sách 5");
      if (transition === "automatic") {
        await waitFor(() =>
          expect(speechRecorderMock.start).toHaveBeenCalledTimes(2),
        );
        expect(
          screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
        ).toBeInTheDocument();
      } else {
        await user.click(
          screen.getByRole("button", {
            name: "Bé đọc với nhận diện giọng nói",
          }),
        );
      }
      expect(Recognition.instances).toHaveLength(2);
      const current = Recognition.instances[1];
      act(() => {
        old.onerror?.({ error: "not-allowed" });
        old.say("Bé mèo nhỏ đang");
        current.say("Bé mèo nhỏ đang");
      });
      speechServiceMock.transcribe.mockResolvedValue({
        text: "Bé mèo nhỏ đang",
        words: [],
      });
      await user.click(
        screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Lưu và dừng" }),
      );
      await user.click(await screen.findByRole("button", { name: "Bỏ qua" }));
      await screen.findByText(
        transition === "manual" ? /Đúng 6\/8 từ/ : /Đúng 7\/8 từ/,
      );
      expect(compareTranscriptMock).toHaveBeenCalledTimes(2);
      expect(compareTranscriptMock).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        // The report must preserve the exact finals used for each page's
        // initial assessment, including a manually stopped partial capture.
        transition === "manual" ? "Bé nhỏ" : "Bé nhỏ đang",
        [],
        {
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          initial_assessment: assessmentFor(pageFour, [
            "CORRECT",
            "OMISSION",
            "CORRECT",
            transition === "manual" ? "OMISSION" : "CORRECT",
          ]),
        },
      );
      expect(compareTranscriptMock).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        "Bé mèo nhỏ đang",
        [],
        {
          page_id: pageFive.page_id,
          page_revision_id: pageFive.page_revision_id,
          initial_assessment: assessmentFor(pageFive),
        },
      );
    },
  );

  it("does not apply a late first-page STT response to the next page", async () => {
    let resolveTranscript: (value: { text: string; words: [] }) => void = () =>
      undefined;
    speechServiceMock.transcribe.mockImplementationOnce(
      () =>
        new Promise<{ text: string; words: [] }>((resolve) => {
          resolveTranscript = resolve;
        }),
    );
    services.readingService.getCurrentPage
      .mockResolvedValueOnce(pageFour)
      .mockResolvedValue(pageFive);
    services.readingService.navigateToPage.mockResolvedValue({
      ...pageProgressFixture,
      current_page_id: pageFive.page_id,
      current_page_number: 5,
      current_index: 1,
    });
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    // A word sample stops capture; page navigation can overlap its pending STT.
    await user.click(screen.getByRole("button", { name: "Bé" }));
    await waitFor(() =>
      expect(speechServiceMock.transcribe).toHaveBeenCalledOnce(),
    );
    await user.click(screen.getByRole("button", { name: "Trang tiếp theo" }));
    expect(speechRecorderMock.stop).toHaveBeenCalledOnce();
    expect(speechServiceMock.transcribe).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Trang sách 4")).toBeInTheDocument();
    await act(async () =>
      resolveTranscript({ text: "Bé mèo nhỏ đang", words: [] }),
    );
    await screen.findByLabelText("Trang sách 5");
    const nextWord = screen.getByRole("button", { name: "Bé" });
    expect(nextWord.className).not.toContain("bg-green-200");
    expect(speechPlayerMock.play).not.toHaveBeenCalled();
    expect(speechRecorderMock.start).toHaveBeenCalledOnce();
    expect(services.readingService.completeCurrentPage).not.toHaveBeenCalled();
  });

  it("does not turn an unread completed page into child omissions", async () => {
    services.readingService.getCurrentPage.mockResolvedValue(pageFive);
    services.readingService.getPageProgress.mockResolvedValue({
      ...pageProgressFixture,
      current_page_id: pageFive.page_id,
      current_page_number: 5,
      current_index: 1,
    });
    services.readingService.completeCurrentPage.mockResolvedValue({
      ...pageProgressFixture,
      current_page_id: pageFive.page_id,
      current_page_number: 5,
      current_index: 1,
      pages: [
        pageProgressFixture.pages[0],
        { ...pageProgressFixture.pages[1], status: "COMPLETED" },
      ],
    });
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", { name: "Đánh dấu trang đã đọc xong" }),
    );
    await waitFor(() =>
      expect(
        services.readingService.completeCurrentPage,
      ).toHaveBeenCalledOnce(),
    );
    await user.click(screen.getByRole("button", { name: "Kết thúc buổi đọc" }));
    await user.click(
      await screen.findByRole("button", { name: "Lưu và dừng" }),
    );
    await waitFor(() =>
      expect(services.readingService.finish).toHaveBeenCalledOnce(),
    );
    expect(compareTranscriptMock).not.toHaveBeenCalled();
    expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Bé còn 4 từ cần đọc lại/),
    ).not.toBeInTheDocument();
  });

  it.each(["pause", "microphone-stop"] as const)(
    "continues sequential alignment after a partial-reading %s",
    async (action) => {
      services.readingService.getPageProgress.mockResolvedValue({
        ...pageProgressFixture,
        persisted: false,
      });
      speechServiceMock.transcribe
        .mockResolvedValueOnce({ text: "Bé", words: [] })
        .mockResolvedValueOnce({ text: "mèo nhỏ đang", words: [] });
      const user = userEvent.setup();
      renderReading("reading");
      await user.click(
        await screen.findByRole("button", {
          name: "Bé đọc với nhận diện giọng nói",
        }),
      );
      await user.click(
        screen.getByRole("button", {
          name:
            action === "pause"
              ? "Tạm dừng buổi đọc"
              : "Dừng nhận diện giọng nói",
        }),
      );
      if (action === "pause") {
        await user.click(
          await screen.findByRole("button", { name: "Đọc tiếp" }),
        );
      }
      await user.click(
        await screen.findByRole("button", {
          name: "Bé đọc với nhận diện giọng nói",
        }),
      );
      await user.click(
        screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Lưu và dừng" }),
      );
      await waitFor(() =>
        expect(services.readingService.finish).toHaveBeenCalledOnce(),
      );
      expect(await screen.findByText(/Đúng 4\/4 từ/)).toBeInTheDocument();
      expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
      expect(compareTranscriptMock).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        "Bé mèo nhỏ đang",
        [],
        {
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          initial_assessment: assessmentFor(pageFour),
        },
      );
    },
  );

  it.each([
    "SILENCE",
    "LOW_VOLUME",
    "BACKGROUND_NOISE",
    "INVALID_AUDIO",
    "AUDIO_TOO_SHORT",
  ])("does not upload or score %s capture", async (status) => {
    services.readingService.getPageProgress.mockResolvedValue({
      ...pageProgressFixture,
      persisted: false,
    });
    speechRecorderMock.getQuality.mockReturnValue({ status, durationMs: 1200 });
    speechServiceMock.transcribe.mockResolvedValue({
      text: "Bé chó nhỏ đang",
      words: [],
    });
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Kết thúc buổi đọc" }));
    await user.click(
      await screen.findByRole("button", { name: "Lưu và dừng" }),
    );
    await waitFor(() =>
      expect(services.readingService.finish).toHaveBeenCalledOnce(),
    );
    expect(speechServiceMock.transcribe).not.toHaveBeenCalled();
    expect(compareTranscriptMock).not.toHaveBeenCalled();
    expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
  });

  it("keeps confirmed words and records unknown words after a failed later capture", async () => {
    services.readingService.getPageProgress.mockResolvedValue({
      ...pageProgressFixture,
      persisted: false,
    });
    speechServiceMock.transcribe
      .mockResolvedValueOnce({ text: "Bé", words: [] })
      .mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Kết thúc buổi đọc" }));
    await user.click(
      await screen.findByRole("button", { name: "Lưu và dừng" }),
    );
    await waitFor(() =>
      expect(services.readingService.finish).toHaveBeenCalledOnce(),
    );
    expect(compareTranscriptMock).toHaveBeenCalledExactlyOnceWith(
      TEST_SESSION_ID,
      "Bé",
      [],
      {
        page_id: pageFour.page_id,
        page_revision_id: pageFour.page_revision_id,
        initial_assessment: assessmentFor(pageFour, [
          "CORRECT",
          "UNCERTAIN",
          "UNCERTAIN",
          "UNCERTAIN",
        ]),
      },
    );
    expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
  });

  it("preserves the first completed page assessment when revisiting and reading it correctly", async () => {
    const nextProgress = {
      ...pageProgressFixture,
      current_page_id: pageFive.page_id,
      current_page_number: 5,
      current_index: 1,
    };
    services.readingService.getCurrentPage
      .mockResolvedValueOnce(pageFour)
      .mockResolvedValueOnce(pageFive)
      .mockResolvedValue(pageFour);
    services.readingService.navigateToPage
      .mockResolvedValueOnce(nextProgress)
      .mockResolvedValueOnce(pageProgressFixture);
    speechServiceMock.transcribe
      .mockResolvedValueOnce({ text: "Bé chó nhỏ đang", words: [] })
      .mockResolvedValueOnce({ text: "Bé mèo nhỏ đang", words: [] });
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Trang tiếp theo" }));
    await screen.findByLabelText("Trang sách 5");
    await user.click(screen.getByRole("button", { name: "Trang trước" }));
    await screen.findByLabelText("Trang sách 4");
    await user.click(
      screen.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
    );
    await user.click(screen.getByRole("button", { name: "Kết thúc buổi đọc" }));
    await user.click(
      await screen.findByRole("button", { name: "Lưu và dừng" }),
    );
    await waitFor(() =>
      expect(compareTranscriptMock).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        "Bé chó nhỏ đang",
        [],
        {
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          initial_assessment: assessmentFor(pageFour, [
            "CORRECT",
            "MISPRONUNCIATION",
            "CORRECT",
            "CORRECT",
          ]),
        },
      ),
    );
    expect(
      await screen.findByText(/Bé còn 1 từ cần đọc lại/),
    ).toBeInTheDocument();
    expect(services.readingService.finish).not.toHaveBeenCalled();
  });

  it("keeps confirmed initial errors eligible for retry after an uncertain later capture", async () => {
    services.readingService.getPageProgress.mockResolvedValue({
      ...pageProgressFixture,
      persisted: false,
    });
    speechServiceMock.transcribe
      .mockResolvedValueOnce({ text: "Bé chó nhỏ", words: [] })
      .mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Kết thúc buổi đọc" }));
    await user.click(
      await screen.findByRole("button", { name: "Lưu và dừng" }),
    );
    await waitFor(() =>
      expect(compareTranscriptMock).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        "Bé chó nhỏ",
        [],
        {
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          initial_assessment: assessmentFor(pageFour, [
            "CORRECT",
            "MISPRONUNCIATION",
            "CORRECT",
            "UNCERTAIN",
          ]),
        },
      ),
    );
    expect(
      await screen.findByText(/Bé còn 1 từ cần đọc lại/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "mèo" })).toHaveAttribute(
      "data-reading-state",
      "incorrect",
    );
    expect(screen.getByRole("button", { name: "đang" })).toHaveAttribute(
      "data-reading-state",
      "uncertain",
    );
    expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
    expect(services.readingService.finish).not.toHaveBeenCalled();
  });

  it("counts correctly read repeated words as correct while preserving the repeated transcript", async () => {
    services.readingService.getPageProgress.mockResolvedValue({
      ...pageProgressFixture,
      persisted: false,
    });
    speechServiceMock.transcribe.mockResolvedValue({
      text: "Bé mèo mèo nhỏ đang",
      words: [],
    });
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Kết thúc buổi đọc" }));
    await user.click(
      await screen.findByRole("button", { name: "Lưu và dừng" }),
    );
    await waitFor(() =>
      expect(compareTranscriptMock).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        "Bé mèo mèo nhỏ đang",
        [],
        {
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          initial_assessment: assessmentFor(pageFour),
        },
      ),
    );
    expect(await screen.findByText(/Đúng 4\/4 từ/)).toBeInTheDocument();
    expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
  });

  it.each(["low-confidence", "empty", "other-language"])(
    "does not score %s provider speech",
    async (kind) => {
      services.readingService.getPageProgress.mockResolvedValue({
        ...pageProgressFixture,
        persisted: false,
      });
      speechServiceMock.transcribe.mockResolvedValue({
        text: kind === "empty" ? "" : "Bé chó nhỏ đang",
        language_code: kind === "other-language" ? "en" : "vi",
        words:
          kind === "low-confidence"
            ? [{ text: "chó", start: 0, end: 1, logprob: -5 }]
            : [],
      });
      const user = userEvent.setup();
      renderReading("reading");
      await user.click(
        await screen.findByRole("button", {
          name: "Bé đọc với nhận diện giọng nói",
        }),
      );
      await user.click(
        screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Lưu và dừng" }),
      );
      await waitFor(() =>
        expect(services.readingService.finish).toHaveBeenCalledOnce(),
      );
      expect(compareTranscriptMock).not.toHaveBeenCalled();
      expect(services.readingService.createRetryEvent).not.toHaveBeenCalled();
    },
  );

  it("lets the child explicitly confirm the current page completion", async () => {
    const user = userEvent.setup();
    services.readingService.getCurrentPage.mockResolvedValue(pageFive);
    services.readingService.getPageProgress.mockResolvedValue({
      ...pageProgressFixture,
      current_page_id: pageFive.page_id,
      current_page_number: pageFive.page_number,
      current_index: 1,
      pages: [
        {
          ...pageProgressFixture.pages[0],
          status: "COMPLETED",
          completed_at: "2026-10-21T07:00:00Z",
        },
        {
          ...pageProgressFixture.pages[1],
          status: "IN_PROGRESS",
          started_at: "2026-10-21T07:00:00Z",
        },
      ],
      completed_pages: 1,
    });
    renderReading("reading");

    const completePageButton = await screen.findByRole("button", {
      name: "Đánh dấu trang đã đọc xong",
    });
    await user.click(completePageButton);

    await waitFor(() => {
      expect(services.readingService.completeCurrentPage).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        pageFive.page_id,
      );
    });
  });

  it("displays supplied paused/reconnecting safety status without adding evidence", async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderReading("paused");
    expect(
      await screen.findByRole("dialog", { name: "Bé đang nghỉ một chút" }),
    ).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute(
      "data-child-error-count",
      "0",
    );
    expect(container.firstElementChild).toHaveAttribute(
      "data-scoring-active",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Đọc tiếp" }));
    expect(await screen.findByText("Mình đang chờ bé")).toBeInTheDocument();
    expect(screen.queryByText("Mình đang nghe bé đọc")).not.toBeInTheDocument();
    expect(speechRecorderMock.start).not.toHaveBeenCalled();
    expect(services.readingSocketAdapter.sendControl).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      "resume",
    );
    unmount();
    renderReading("reconnecting");
    expect(
      await screen.findByRole("dialog", { name: "Đợi mình một chút nhé…" }),
    ).toHaveTextContent("không tạo lỗi đọc");
  });

  it("never requests camera permission from the reading screen", async () => {
    renderReading("camera-denied");
    expect(await screen.findByText(/Phạm vi đọc: Trang/)).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Camera chưa sẵn sàng" }),
    ).not.toBeInTheDocument();
    expect(services.devicePermissionService.retry).not.toHaveBeenCalledWith(
      "camera",
    );
  });

  it("offers safe-exit confirmation without immediately finishing the session", async () => {
    const user = userEvent.setup();
    renderReading("microphone-denied");
    await screen.findByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" });
    await user.click(screen.getByRole("button", { name: "Kết thúc an toàn" }));
    expect(
      screen.getByRole("dialog", { name: "Bé muốn nghỉ hôm nay?" }),
    ).toBeInTheDocument();
    expect(services.readingService.finish).not.toHaveBeenCalled();
  });

  it("offers camera retry and safe exit without a manual page picker", async () => {
    const user = userEvent.setup();
    renderReading("page-confidence-low");
    await screen.findByRole("dialog", {
      name: "Mình chưa nhìn rõ trang sách",
    });
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Kết thúc an toàn" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Chọn trang")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Bé đang đọc trang nào?" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(services.pageMatchService.retryCurrentPage).toHaveBeenCalledWith(
      TEST_SESSION_ID,
    );
    expect(await screen.findByLabelText("Trang sách 4")).toBeInTheDocument();
  });

  it("does not open the microphone when completing an idle page", async () => {
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(
      await screen.findByRole("button", { name: "Đánh dấu trang đã đọc xong" }),
    );
    await screen.findByLabelText("Trang sách 5");
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(speechRecorderMock.start).not.toHaveBeenCalled();
      expect(compareTranscriptMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebinds the highlighted word to the new immutable page revision", async () => {
    renderReading("page-turn");
    const page = await screen.findByLabelText("Trang sách 5");
    await waitFor(() =>
      expect(page).toHaveAttribute(
        "data-page-revision-id",
        pageFive.page_revision_id,
      ),
    );
    expect(page.querySelector('[data-word-id$="000000000503"]')).toBeTruthy();
    expect(page.querySelector('[data-word-id$="000000000403"]')).toBeNull();
  });

  it("displays question results from service responses without exposing an expected answer", async () => {
    const result = {
      answer_id: "90000000-0000-4000-8000-000000000001",
      question_id: TEST_QUESTION_ID,
      submitted_answer: "Trên bàn",
      is_correct: false,
      score: 0,
      feedback_code: null,
    };
    services.comprehensionService.submitAnswer
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce({
        ...result,
        submitted_answer: "Bên cửa sổ",
        is_correct: true,
        score: 1,
      });
    const user = userEvent.setup();
    renderReading("question");
    await screen.findByRole("heading", { name: "Mình cùng trả lời nhé!" });
    expect(document.body.textContent).not.toContain("expected_answer");
    await user.click(await screen.findByRole("button", { name: /Trên bàn/ }));
    expect(
      await screen.findByText("Gần đúng rồi, thử lại nhé."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Bên cửa sổ/ }));
    expect(
      await screen.findByText("Đúng rồi! Bé nhớ rất tốt."),
    ).toBeInTheDocument();
    expect(services.comprehensionService.submitAnswer).toHaveBeenLastCalledWith(
      TEST_SESSION_ID,
      TEST_QUESTION_ID,
      "Bên cửa sổ",
    );
  });

  it("renders safe not-found when the service rejects an inaccessible session", async () => {
    services.readingService.get.mockRejectedValueOnce(
      new ServiceError({
        code: "RESOURCE_NOT_FOUND",
        status: 404,
        message: "Private session details",
        request_id: "test",
        retryable: false,
      }),
    );
    renderReading("ready", "ffffffff-ffff-4fff-8fff-ffffffffffff");
    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy buổi đọc" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/không tồn tại hoặc không thuộc tài khoản hiện tại/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Private session details"),
    ).not.toBeInTheDocument();
    expect(services.readingService.getCurrentPage).not.toHaveBeenCalled();
  });

  it("shows a retryable error instead of a fabricated session for an unavailable service", async () => {
    services.readingService.get.mockRejectedValueOnce(
      new Error("ReadingService is not implemented yet."),
    );
    renderReading("ready");
    expect(
      await screen.findByRole("heading", { name: "Chưa mở được buổi đọc" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Về thư viện" })).toHaveAttribute(
      "href",
      "/books",
    );
    expect(
      screen.queryByText("ReadingService is not implemented yet."),
    ).not.toBeInTheDocument();
    expect(services.readingSocketAdapter.subscribe).not.toHaveBeenCalled();
  });
});
