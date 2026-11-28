import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PhonicsLessonCard } from "@/components/reading/phonics-lesson-card";
import { ReadingLayout } from "@/components/reading/reading-layout";
import { ReadingScreen } from "@/components/reading/reading-screen";
import type { ReadingServices } from "@/hooks/use-reading-services";
import type { AudioQualitySnapshot } from "@/lib/reading/audio-quality";
import {
  buildPhonicsLesson,
  type SupportedPhonicsLessonPlan,
} from "@/lib/reading/phonics-lesson";
import { resetAutomationPreferencesCache } from "@/lib/reading/automation-preferences";
import { resetVoiceLockAndPolicyForTests } from "@/lib/reading/session-voice-lock";
import { resetSpeechPreferencesCache } from "@/lib/reading/speech-preferences";
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

const {
  servicesHook,
  speechRecorderMock,
  speechPlayerMock,
  speechServiceMock,
} = vi.hoisted(() => ({
  servicesHook: vi.fn<() => ReadingServices>(),
  speechRecorderMock: {
    isRecording: false,
    isSpeaking: false,
    audioLevel: 0,
    prepare: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => new Blob(["wav-bytes"], { type: "audio/webm" })),
    cancel: vi.fn(),
    getStream: vi.fn(() => null),
    getIsSpeaking: vi.fn(() => false),
    getQuality: vi.fn<() => AudioQualitySnapshot>(),
    getSettings: vi.fn(() => ({})),
  },
  speechPlayerMock: {
    isPlaying: false,
    isPaused: false,
    state: "idle" as const,
    fallbackNotice: null,
    play: vi.fn<(text: string, options?: unknown) => Promise<void>>(
      async () => {},
    ),
    playWithWordTimings: vi.fn(async () => {}),
    playPhonicsLesson: vi.fn<
      (
        lesson: SupportedPhonicsLessonPlan,
        opts?: { readonly onStepChange?: (stepIndex: number) => void },
      ) => Promise<void>
    >(async () => {}),
    pause: vi.fn(),
    resume: vi.fn(async () => {}),
    stop: vi.fn(),
  },
  speechServiceMock: {
    synthesize: vi.fn(),
    synthesizePhonics: vi.fn(),
    transcribe: vi.fn(),
    getVoiceStatus: vi.fn(),
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
vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => ({
    listVoices: async () => ({
      voices: [],
      default_voice_id: "local_north_truc_ly",
    }),
  }),
}));

function makePage(
  words: readonly string[],
  pageNum = 1,
  text?: string,
): ReadingPageDTO {
  return {
    page_id: `30000000-0000-4000-8000-0000000000${String(pageNum).padStart(2, "0")}`,
    page_revision_id: `40000000-0000-4000-8000-0000000000${String(pageNum).padStart(2, "0")}`,
    page_number: pageNum,
    text: text ?? words.join(" "),
    confidence: 0.98,
    width: 600,
    height: 800,
    words: words.map((w, index) => ({
      word_id: `50000000-0000-4000-8000-00000000${String(pageNum).padStart(2, "0")}${String(index).padStart(2, "0")}`,
      word_index: index,
      text: w,
      bbox: [
        0.06 + (index % 5) * 0.16,
        0.18 + Math.floor(index / 5) * 0.1,
        0.12,
        0.05,
      ] as const,
    })),
  };
}

function createReadingServices(activePage: ReadingPageDTO): ReadingServices {
  const secondPage = makePage(["Sang", "trang", "hai."], 2);
  const progress: ReadingSessionPageProgressDTO = {
    session_id: TEST_SESSION_ID,
    persisted: true,
    start_page_id: activePage.page_id,
    end_page_id: secondPage.page_id,
    current_page_id: activePage.page_id,
    start_page_number: activePage.page_number,
    end_page_number: secondPage.page_number,
    current_page_number: activePage.page_number,
    current_index: 0,
    total_pages: 2,
    completed_pages: 0,
    pages: [activePage, secondPage].map((p, order) => ({
      page_id: p.page_id,
      page_revision_id: p.page_revision_id,
      page_number: p.page_number,
      page_order: order,
      status: order === 0 ? ("IN_PROGRESS" as const) : ("PENDING" as const),
      started_at: null,
      completed_at: null,
    })),
  };

  return {
    bookService: {
      list: vi.fn().mockResolvedValue([bookFixture]),
      get: vi.fn().mockResolvedValue(bookFixture),
      listPages: vi.fn().mockResolvedValue([]),
    },
    childService: {
      list: vi.fn().mockResolvedValue([childFixture]),
      get: vi.fn().mockResolvedValue(childFixture),
    },
    comprehensionService: {
      getQuestion: vi.fn().mockRejectedValue(new Error("No question")),
      submitAnswer: vi.fn().mockRejectedValue(new Error("No answer")),
    },
    devicePermissionService: {
      getSnapshot: vi
        .fn()
        .mockResolvedValue({ camera: "ready", microphone: "ready" }),
      getMicrophonePermissionState: vi.fn().mockResolvedValue("granted"),
      watchMicrophonePermissionState: vi
        .fn()
        .mockResolvedValue(() => undefined),
      requestAccess: vi.fn().mockResolvedValue({
        status: "granted",
        verified: true,
        message: "OK",
        mediaRecorderSupported: true,
      }),
      retry: vi.fn().mockResolvedValue("ready"),
    },
    pageMatchService: {
      retryCurrentPage: vi.fn().mockResolvedValue(activePage),
      selectPage: vi.fn().mockResolvedValue(secondPage),
    },
    readingService: {
      get: vi.fn().mockResolvedValue({
        ...sessionSummaryFixture,
        state: "PAGE_READY",
        ended_at: null,
        duration_ms: null,
      }),
      getCurrentPage: vi.fn().mockResolvedValue(activePage),
      getPageProgress: vi.fn().mockResolvedValue(progress),
      navigateToPage: vi.fn().mockResolvedValue(progress),
      completeCurrentPage: vi.fn().mockResolvedValue({
        ...progress,
        completed_pages: 1,
      }),
      getCompletionSummary: vi.fn().mockResolvedValue({
        duration_minutes: 3,
        pages_explored: 1,
        practiced_words: 1,
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
  } as unknown as ReadingServices;
}

describe("Reading focus decluttering & phonics auto-hide", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceLockAndPolicyForTests();
    resetSpeechPreferencesCache();
    resetAutomationPreferencesCache();
    speechPlayerMock.play.mockResolvedValue(undefined);
    speechPlayerMock.playPhonicsLesson.mockResolvedValue(undefined);
    speechRecorderMock.getQuality.mockReturnValue({
      status: "SPEECH_DETECTED",
      durationMs: 1200,
      speechDurationMs: 700,
      silenceDurationMs: 500,
      rms: 0.05,
      peak: 0.08,
      noiseFloor: 0.005,
      clipped: false,
      isSpeaking: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders PhonicsLessonCard auto-hide bar and notifies onUserInteract on Meaning tab or Listen word", () => {
    const lesson = buildPhonicsLesson("bông");
    const onUserInteract = vi.fn();
    const onPlayWord = vi.fn();

    render(
      <PhonicsLessonCard
        activeStepIndex={null}
        autoHideDurationMs={1800}
        compact
        isAutoHiding
        lesson={lesson}
        onPlayWord={onPlayWord}
        onUserInteract={onUserInteract}
      />,
    );

    const card = screen.getByTestId("phonics-lesson-card");
    expect(card).toHaveAttribute("data-phonics-auto-hiding", "true");
    expect(screen.getByTestId("phonics-auto-hide-bar")).toBeInTheDocument();
    expect(
      screen.getByText("Đánh vần xong · Tự ẩn để bé nhìn rõ chữ…"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Nghe từ" }));
    expect(onUserInteract).toHaveBeenCalledTimes(1);
    expect(onPlayWord).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("phonics-tab-meaning"));
    expect(onUserInteract).toHaveBeenCalledTimes(2);
  });

  it("keeps ReadingLayout feedback slot collapsed during smooth reading and lets companion bubble dismiss", () => {
    const page = makePage(["Nắng", "sáng", "rồi."], 1);
    const onDismissCompanion = vi.fn();

    const { rerender, container } = render(
      <ReadingLayout
        bookTitle="Chuyện buổi sáng"
        currentWordId={page.words[0]!.word_id}
        currentWordText="Nắng"
        exitHref="/books"
        isListening
        isMicRecording
        latestTranscript="Nắng sáng"
        onFinish={vi.fn()}
        onHelp={vi.fn()}
        onPause={vi.fn()}
        page={page}
      />,
    );

    const root = container.querySelector("section[data-reading-focus]");
    expect(root).toHaveAttribute("data-reading-focus", "active");
    expect(
      container.querySelector('[data-reading-feedback="true"]'),
    ).toBeNull();

    rerender(
      <ReadingLayout
        bookTitle="Chuyện buổi sáng"
        companionBubble={{
          mood: "celebrating",
          title: "Khen bé",
          message: "Con đọc rất rõ ràng!",
        }}
        currentWordId={page.words[0]!.word_id}
        currentWordText="Nắng"
        exitHref="/books"
        isListening={false}
        isMicRecording={false}
        onDismissCompanion={onDismissCompanion}
        onFinish={vi.fn()}
        onHelp={vi.fn()}
        onPause={vi.fn()}
        page={page}
      />,
    );

    expect(screen.getByTestId("reading-companion-bubble")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("dismiss-companion-bubble-btn"));
    expect(onDismissCompanion).toHaveBeenCalledTimes(1);
  });

  it("auto-hides phonics card after spelling completes, pauses auto-hide on Meaning tab, and keeps utility tools collapsed by default", async () => {
    const multiSentencePage = makePage(
      ["Nắng", "vàng", "chiếu", "nhẹ.", "Mèo", "nhỏ", "nằm", "ngoan."],
      1,
      "Nắng vàng chiếu nhẹ. Mèo nhỏ nằm ngoan.",
    );
    servicesHook.mockReturnValue(createReadingServices(multiSentencePage));

    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    await screen.findByLabelText("Trang sách 1");

    // Secondary tools (prosody cues, co-reading, duet mode) are collapsed out of the reading flow by default!
    expect(screen.queryByTestId("reading-tools-popover")).toBeNull();
    expect(screen.queryByTestId("prosody-breathing-cues-bar")).toBeNull();
    expect(screen.queryByTestId("duet-mode-toggle")).toBeNull();

    // Clicking the single Options/Tools chip reveals all secondary study tools cleanly on demand.
    fireEvent.click(screen.getByTestId("reading-tools-toggle"));
    expect(screen.getByTestId("reading-tools-popover")).toBeVisible();
    expect(screen.getByTestId("prosody-breathing-cues-bar")).toBeVisible();
    expect(screen.getByTestId("reading-open-co-reading-btn")).toBeVisible();
    expect(screen.getByTestId("duet-mode-toggle")).toBeVisible();
    fireEvent.click(screen.getByTestId("reading-tools-toggle"));
    expect(screen.queryByTestId("reading-tools-popover")).toBeNull();

    // Pre-load the dynamic PhonicsLessonCard chunk before switching to fake timers.
    fireEvent.click(screen.getByRole("button", { name: "Nghe đánh vần" }));
    const firstCard = await screen.findByTestId(
      "phonics-lesson-card",
      {},
      { timeout: 5000 },
    );
    expect(firstCard).toBeVisible();

    // Clicking a word on the page immediately dismisses the phonics frame for clear reading.
    fireEvent.click(screen.getByRole("button", { name: "vàng" }));
    expect(screen.queryByTestId("phonics-lesson-card")).toBeNull();

    // Now test auto-hide after spelling completes with fake timers.
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Nghe đánh vần" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const autoHideCard = screen.getByTestId("phonics-lesson-card");
    expect(autoHideCard).toHaveAttribute("data-phonics-auto-hiding", "true");
    expect(screen.getByTestId("phonics-auto-hide-bar")).toBeInTheDocument();

    // Before 1800ms it is still visible; after 1800ms it hides automatically!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId("phonics-lesson-card")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(screen.queryByTestId("phonics-lesson-card")).toBeNull();

    // Re-open phonics, then switch to "Nghĩa từ" tab while auto-hiding -> auto-hide cancels!
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Nghe đánh vần" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("phonics-lesson-card")).toHaveAttribute(
      "data-phonics-auto-hiding",
      "true",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("phonics-tab-meaning"));
    });
    expect(screen.getByTestId("phonics-lesson-card")).not.toHaveAttribute(
      "data-phonics-auto-hiding",
      "true",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByTestId("phonics-lesson-card")).toBeInTheDocument();
  });
});
