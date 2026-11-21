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
} from "@/types/reading";
import {
  resetAutomationPreferencesCache,
  setAutomationPreferences,
} from "@/lib/reading/automation-preferences";

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
    play: vi.fn(),
    playWithWordTimings: vi.fn(),
    stop: vi.fn(),
  },
  speechServiceMock: { synthesize: vi.fn(), transcribe: vi.fn() },
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
  pages: [pageFour, pageFive].map((page, order) => ({
    page_id: page.page_id,
    page_revision_id: page.page_revision_id,
    page_number: page.page_number,
    page_order: order,
    status: order === 0 ? ("IN_PROGRESS" as const) : ("PENDING" as const),
    started_at: null,
    completed_at: null,
  })),
};

function createServices() {
  return {
    bookService: {
      list: vi.fn().mockResolvedValue([bookFixture]),
      get: vi.fn().mockResolvedValue(bookFixture),
      listPages: vi.fn().mockResolvedValue(previews),
    },
    childService: {
      list: vi.fn().mockResolvedValue([childFixture]),
      get: vi.fn().mockResolvedValue(childFixture),
      create: vi.fn().mockRejectedValue(new Error("Unused test write")),
      update: vi.fn().mockRejectedValue(new Error("Unused test write")),
      delete: vi.fn().mockRejectedValue(new Error("Unused test write")),
      uploadAvatar: vi.fn().mockRejectedValue(new Error("Unused test write")),
      removeAvatar: vi.fn().mockRejectedValue(new Error("Unused test write")),
    },
    comprehensionService: {
      getQuestion: vi.fn().mockRejectedValue(new Error("No question")),
      submitAnswer: vi.fn().mockRejectedValue(new Error("No answer")),
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
      retryCurrentPage: vi.fn().mockResolvedValue(pageFour),
      selectPage: vi.fn().mockResolvedValue(pageFive),
    },
    readingService: {
      create: vi.fn().mockRejectedValue(new Error("Unused test write")),
      get: vi.fn().mockResolvedValue({
        ...sessionSummaryFixture,
        state: "PAGE_READY",
        ended_at: null,
        duration_ms: null,
      }),
      getCurrentPage: vi.fn().mockResolvedValue(pageFour),
      getPageProgress: vi.fn().mockResolvedValue(pageProgressFixture),
      navigateToPage: vi.fn().mockResolvedValue(pageProgressFixture),
      completeCurrentPage: vi.fn().mockResolvedValue({
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
      getCompletionSummary: vi.fn().mockResolvedValue({
        duration_minutes: 8,
        pages_explored: 2,
        practiced_words: 0,
      }),
      finish: vi.fn().mockResolvedValue({}),
      createRetryEvent: vi.fn().mockResolvedValue(undefined),
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
  } as unknown as ReadingServices & {
    readingService: {
      completeCurrentPage: ReturnType<typeof vi.fn>;
      finish: ReturnType<typeof vi.fn>;
    };
  };
}

/** Browser SpeechRecognition double. Results accumulate like the real API. */
class AutoRecognition {
  static instances: AutoRecognition[] = [];
  onend: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  private results: {
    isFinal: boolean;
    length: number;
    0: { transcript: string; confidence: number };
  }[] = [];
  constructor() {
    AutoRecognition.instances.push(this);
  }
  start() {}
  abort() {}
  stop() {
    this.onend?.();
  }
  say(transcript: string, confidence = 0.95) {
    this.results.push({
      isFinal: true,
      length: 1,
      0: { transcript, confidence },
    });
    this.onresult?.({
      resultIndex: this.results.length - 1,
      results: [...this.results],
    });
  }
}
const lastRecognition = () =>
  AutoRecognition.instances[AutoRecognition.instances.length - 1];

let services: ReturnType<typeof createServices>;
beforeEach(() => {
  window.localStorage.clear();
  resetAutomationPreferencesCache();
  previousSpeechRecognition = Object.getOwnPropertyDescriptor(
    window,
    "SpeechRecognition",
  );
  AutoRecognition.instances.length = 0;
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: AutoRecognition,
  });
  services = createServices();
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
  speechServiceMock.transcribe.mockReset().mockRejectedValue(
    new ServiceError({
      code: "STT_QUOTA_EXCEEDED",
      status: 503,
      message: "quota",
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
  vi.useRealTimers();
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

function renderReading(state: ReadingUiState) {
  return render(
    <ReadingScreen
      initialUiState={state}
      reconnectMode="recover"
      sessionId={TEST_SESSION_ID}
    />,
  );
}
const MIC_BUTTON = { name: "Bé đọc với nhận diện giọng nói" } as const;

/** Mount in "reading", start the mic, then switch to fake timers. */
async function startWithFakeClock() {
  await act(async () => {
    renderReading("reading");
  });
  const start = await screen.findByRole("button", MIC_BUTTON);
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  await act(async () => fireEvent.click(start));
  return lastRecognition();
}
const word = (name: string) => screen.getByRole("button", { name });
const SUCCESS = "bg-success-surface";

describe("automatic reading flow on the reading screen", () => {
  it("needs no click after Start: the mic opens by itself, a fluent page saves once, the next page keeps listening (G5)", async () => {
    const user = userEvent.setup();
    renderReading("ready");
    await user.click(
      await screen.findByRole("button", { name: "Bắt đầu đọc" }),
    );
    // No further interaction from here on.
    await waitFor(() => expect(AutoRecognition.instances).toHaveLength(1), {
      timeout: 8000,
    });
    expect(speechRecorderMock.start).toHaveBeenCalledOnce();
    act(() => lastRecognition().say("Bé mèo nhỏ đang"));
    await screen.findByLabelText("Trang sách 5");
    await waitFor(() =>
      expect(services.readingService.completeCurrentPage).toHaveBeenCalledTimes(
        1,
      ),
    );
    await waitFor(
      () => expect(AutoRecognition.instances.length).toBeGreaterThan(1),
      {
        timeout: 5000,
      },
    );
    expect(services.readingService.completeCurrentPage).toHaveBeenCalledTimes(
      1,
    );
    expect(speechPlayerMock.play).not.toHaveBeenCalled(); // no needless help
  }, 30_000);

  it("with automatic page turning off the page is not turned or saved until the child asks", async () => {
    setAutomationPreferences({ autoAdvance: false });
    const user = userEvent.setup();
    renderReading("reading");
    await user.click(await screen.findByRole("button", MIC_BUTTON));
    act(() => lastRecognition().say("Bé mèo nhỏ đang"));
    await waitFor(() => expect(word("đang")).toHaveClass(SUCCESS));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(services.readingService.completeCurrentPage).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Trang sách 5")).toBeNull();
    await user.click(
      await screen.findByRole("button", { name: "Đánh dấu trang đã đọc xong" }),
    );
    await waitFor(() =>
      expect(services.readingService.completeCurrentPage).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        pageFour.page_id,
      ),
    );
  });

  it("ignores the echo of its own help sample but accepts the child's later imitation (G4)", async () => {
    const recognition = await startWithFakeClock();
    act(() => recognition.say("Bé mèo"));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(speechPlayerMock.play).toHaveBeenCalledWith("nhỏ", {
      wordSample: true,
    });
    const listening = lastRecognition();
    expect(listening).not.toBe(recognition);

    act(() => listening.say("nhỏ")); // echo, straight after the sample ended
    expect(word("nhỏ")).not.toHaveClass(SUCCESS);
    expect(word("nhỏ")).not.toHaveClass("underline");

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    act(() => listening.say("nhỏ")); // the child's own try
    expect(word("nhỏ")).not.toHaveClass(SUCCESS); // helped: never plain green
    expect(word("nhỏ")).toHaveClass("underline"); // marked "assisted", not colour alone
    act(() => listening.say("đang"));
    expect(word("đang")).toHaveClass(SUCCESS);
  });

  it("walks the help ladder: model, slower model, phrase, then encourages and moves on without a green word (G9)", async () => {
    await startWithFakeClock();
    act(() => lastRecognition().say("Bé mèo"));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    const calls = speechPlayerMock.play.mock.calls;
    expect(calls).toEqual(
      expect.arrayContaining([
        ["Cô đọc mẫu cho con nhé."],
        ["nhỏ", { wordSample: true }],
        ["nhỏ", { wordSample: true, speedScale: 0.8 }],
        ["nhỏ đang"],
        ["Con đã cố gắng rất tốt rồi. Mình đọc tiếp nhé!"],
      ]),
    );
    const order = calls.map(([text]) => text);
    expect(order.indexOf("Cô đọc mẫu cho con nhé.")).toBeLessThan(
      order.indexOf("Con đã cố gắng rất tốt rồi. Mình đọc tiếp nhé!"),
    );
    expect(word("nhỏ")).not.toHaveClass(SUCCESS);
    expect(compareTranscriptMock).not.toHaveBeenCalled();
  });

  it("a spoken stop command pauses and nothing reopens the microphone by itself", async () => {
    const recognition = await startWithFakeClock();
    const starts = speechRecorderMock.start.mock.calls.length;
    act(() => recognition.say("dừng lại"));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(
      screen.getByRole("dialog", { name: "Bé đang nghỉ một chút" }),
    ).toBeInTheDocument();
    expect(
      speechRecorderMock.stop.mock.calls.length +
        speechRecorderMock.cancel.mock.calls.length,
    ).toBeGreaterThan(0);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(speechRecorderMock.start.mock.calls.length).toBe(starts);
    expect(speechPlayerMock.play).not.toHaveBeenCalled();
  });

  it("'đợi con' holds back automatic help for a while, then help resumes", async () => {
    const recognition = await startWithFakeClock();
    act(() => recognition.say("đợi con"));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(speechPlayerMock.play).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(25_000));
    expect(speechPlayerMock.play).toHaveBeenCalledWith("Bé", {
      wordSample: true,
    });
  });

  it("with automatic help off it never intervenes on silence, but still answers a spoken request", async () => {
    setAutomationPreferences({ assist: false });
    const recognition = await startWithFakeClock();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(speechPlayerMock.play).not.toHaveBeenCalled();
    act(() => recognition.say("đọc mẫu giúp con"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(speechPlayerMock.play).toHaveBeenCalledWith("Bé", {
      wordSample: true,
    });
  });

  it("does not colour or keep speech that does not follow the book", async () => {
    const recognition = await startWithFakeClock();
    act(() => recognition.say("hôm nay trời mưa to lắm"));
    for (const name of ["Bé", "mèo", "nhỏ", "đang"]) {
      expect(word(name)).not.toHaveClass(SUCCESS);
      expect(word(name)).not.toHaveClass("bg-red-200");
    }
    act(() => recognition.say("Bé mèo"));
    expect(word("Bé")).toHaveClass(SUCCESS);
    expect(word("mèo")).toHaveClass(SUCCESS);
  });

  it("stays on the page with a Chưa lưu notice when saving fails, then recovers on retry (G10)", async () => {
    const completedProgress = {
      ...pageProgressFixture,
      completed_pages: 1,
      pages: [
        {
          ...pageProgressFixture.pages[0],
          status: "COMPLETED" as const,
          completed_at: "2026-10-21T07:00:00Z",
        },
        pageProgressFixture.pages[1],
      ],
    };
    services.readingService.completeCurrentPage
      .mockRejectedValueOnce(new Error("Network offline"))
      .mockResolvedValueOnce(completedProgress);

    const user = userEvent.setup();
    renderReading("reading");
    await user.click(await screen.findByRole("button", MIC_BUTTON));
    act(() => lastRecognition().say("Bé mèo nhỏ đang"));

    await screen.findByText(/Chưa lưu được trang này/i);
    expect(screen.queryByLabelText("Trang sách 5")).toBeNull();
    expect(screen.getByLabelText("Trang sách 4")).toBeInTheDocument();
    expect(services.readingService.completeCurrentPage).toHaveBeenCalledTimes(
      1,
    );

    await user.click(
      screen.getByRole("button", { name: "Đánh dấu trang đã đọc xong" }),
    );
    await screen.findByLabelText("Trang sách 5");
    expect(services.readingService.completeCurrentPage).toHaveBeenCalledTimes(
      2,
    );
  });

  it("completes the final page in range cleanly, saves once, and keeps the microphone closed", async () => {
    const finalProgress: ReadingSessionPageProgressDTO = {
      ...pageProgressFixture,
      current_page_id: pageFive.page_id,
      current_page_number: pageFive.page_number,
      current_index: 1,
      completed_pages: 1,
      pages: [
        {
          ...pageProgressFixture.pages[0],
          status: "COMPLETED",
          completed_at: "2026-10-21T07:00:00Z",
        },
        {
          ...pageProgressFixture.pages[1],
          status: "IN_PROGRESS",
        },
      ],
    };
    (
      services.readingService.getCurrentPage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(pageFive);
    (
      services.readingService.getPageProgress as ReturnType<typeof vi.fn>
    ).mockResolvedValue(finalProgress);
    services.readingService.completeCurrentPage.mockResolvedValue({
      ...finalProgress,
      completed_pages: 2,
      pages: [
        finalProgress.pages[0],
        {
          ...finalProgress.pages[1],
          status: "COMPLETED",
          completed_at: "2026-10-21T07:01:00Z",
        },
      ],
    });

    const user = userEvent.setup();
    renderReading("reading");
    await user.click(await screen.findByRole("button", MIC_BUTTON));
    const startsBeforeFinish = speechRecorderMock.start.mock.calls.length;
    act(() => lastRecognition().say("Bé mèo nhỏ đang"));

    await waitFor(() =>
      expect(services.readingService.completeCurrentPage).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        pageFive.page_id,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", MIC_BUTTON)).toBeInTheDocument(),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(services.readingService.completeCurrentPage).toHaveBeenCalledTimes(
      1,
    );
    expect(speechRecorderMock.start.mock.calls.length).toBe(startsBeforeFinish);
  });

  it("does not trigger false scoring or automatic help on an image-only page with no OCR words", async () => {
    const imageOnlyPage: ReadingPageDTO = {
      ...pageFour,
      words: [],
    };
    (
      services.readingService.getCurrentPage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(imageOnlyPage);

    await startWithFakeClock();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(speechPlayerMock.play).not.toHaveBeenCalled();
    expect(compareTranscriptMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Trang tiếp theo" }),
    ).toBeEnabled();
  });
});
