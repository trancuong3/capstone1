import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    fallbackNotice: null,
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

const pageFour: ReadingPageDTO = {
  page_id: "30000000-0000-4000-8000-000000000014",
  page_revision_id: "40000000-0000-4000-8000-000000000014",
  page_number: 4,
  confidence: 0.95,
  width: 600,
  height: 800,
  words: ["Bé", "mèo", "nhỏ"].map((text, index) => ({
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
  page_revision_word_id: pageFour.words[0].word_id,
  tts_text: "Bé",
};

function createReadingFixtures(): ReadingServices {
  return {
    bookService: {
      list: vi.fn().mockResolvedValue([bookFixture]),
      get: vi.fn().mockResolvedValue(bookFixture),
      listPages: vi.fn().mockResolvedValue(previews),
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
      getQuestion: vi.fn().mockResolvedValue({
        question: {
          id: "80000000-0000-4000-8000-000000000001",
          type: "FACTUAL",
          prompt: "Bé mèo nằm ở đâu?",
          page_revision_id: pageFour.page_revision_id,
          source_span: {
            start_word_index: 0,
            end_word_index_exclusive: 3,
            sentence_index: 0,
          },
          difficulty: 1,
          answered: false,
        },
        progress_label: "Câu 1",
        choices: [{ id: "A", label: "Trên bàn", value: "Trên bàn" }],
      }),
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
        message: "OK",
        mediaRecorderSupported: true,
      }),
      retry: vi.fn().mockResolvedValue("ready"),
    },
    pageMatchService: {
      retryCurrentPage: vi.fn().mockResolvedValue(pageFour),
      selectPage: vi.fn().mockResolvedValue(pageFive),
    },
    readingService: {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue({
        ...sessionSummaryFixture,
        state: "PAGE_READY",
        ended_at: null,
        duration_ms: null,
      }),
      getCurrentPage: vi.fn().mockResolvedValue(pageFour),
      getPageProgress: vi.fn().mockResolvedValue(pageProgressFixture),
      navigateToPage: vi.fn().mockResolvedValue({
        ...pageProgressFixture,
        current_page_id: pageFive.page_id,
        current_page_number: pageFive.page_number,
        current_index: 1,
      }),
      completeCurrentPage: vi.fn(),
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
      requestReadExample: vi.fn().mockResolvedValue(tutorAction),
      retryReadExample: vi.fn().mockResolvedValue(tutorAction),
    },
  };
}

describe("M4-B ReadingScreen code-splitting", () => {
  beforeEach(() => {
    servicesHook.mockReset().mockReturnValue(createReadingFixtures());
    speechRecorderMock.prepare.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.start.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.stop.mockReset().mockResolvedValue(new Blob());
    speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
    speechPlayerMock.playWithWordTimings
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it("loads ReadingPagePickerModal dynamically when choosing a page and navigates on confirm", async () => {
    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    const choosePageBtn = await screen.findByRole("button", {
      name: "Chọn trang",
    });
    expect(
      screen.queryByRole("dialog", { name: "Bé đang đọc trang nào?" }),
    ).not.toBeInTheDocument();

    await user.click(choosePageBtn);

    const dialog = await screen.findByRole(
      "dialog",
      { name: "Bé đang đọc trang nào?" },
      { timeout: 5000 },
    );
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Trang 5" }));
    await user.click(screen.getByRole("button", { name: "Đúng trang này" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Bé đang đọc trang nào?" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders dynamically split ComprehensionQuestion when initialUiState is question", async () => {
    render(
      <ReadingScreen
        initialUiState="question"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    expect(
      await screen.findByText("Bé mèo nằm ở đâu?", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Mình cùng trả lời nhé" }),
    ).toBeInTheDocument();
  });

  it("renders dynamically split SessionComplete when initialUiState is complete", async () => {
    render(
      <ReadingScreen
        initialUiState="complete"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    expect(
      await screen.findByRole(
        "heading",
        { name: "Buổi đọc đã hoàn thành" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  });

  it("renders recoverable Retry and Back/Skip UI when ComprehensionQuestion chunk rejects offline", async () => {
    vi.resetModules();
    vi.doMock("@/components/reading/comprehension-question", () => {
      throw new Error("ChunkLoadError: Loading chunk failed");
    });

    try {
      const { ReadingScreen: IsolatedReadingScreen } =
        await import("@/components/reading/reading-screen");

      render(
        <IsolatedReadingScreen
          initialUiState="question"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );

      const errorSection = await screen.findByTestId(
        "reading-question-load-error",
        {},
        { timeout: 5000 },
      );
      expect(errorSection).toBeInTheDocument();
      expect(errorSection).not.toHaveAttribute("aria-busy", "true");
      expect(
        screen.queryByLabelText("Đang chuẩn bị buổi đọc"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Thử lại" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Bỏ qua và xem kết quả" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Về thư viện" })).toHaveAttribute(
        "href",
        "/books",
      );
    } finally {
      vi.doUnmock("@/components/reading/comprehension-question");
      vi.resetModules();
    }
  });
});
