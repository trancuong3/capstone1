import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingPreparationScreen } from "@/components/reading/reading-preparation-screen";
import { ReadingScreen } from "@/components/reading/reading-screen";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { TutorMessage } from "@/components/reading/tutor-message";
import type { ReadingServices } from "@/hooks/use-reading-services";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  bookFixture,
  childFixture,
  pagePreviewFixture,
  sessionSummaryFixture,
  TEST_BOOK_ID,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import type {
  ReadingPageDTO,
  ReadingSessionPageProgressDTO,
} from "@/types/reading";

const {
  servicesHook,
  speechRecorderMock,
  speechPlayerMock,
  speechServiceMock,
  compareTranscriptMock,
  pushMock,
  replaceMock,
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
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
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
    synthesizeTimed: vi.fn(),
  }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const samplePage: ReadingPageDTO = {
  page_id: "30000000-0000-4000-8000-000000000014",
  page_revision_id: "40000000-0000-4000-8000-000000000014",
  page_number: 4,
  confidence: 0.95,
  width: 600,
  height: 800,
  image_url: "https://example.com/page-4.png",
  words: ["Bé", "mèo", "nhỏ", "đang"].map((text, index) => ({
    word_id: `50000000-0000-4000-8000-00000000040${index}`,
    word_index: index,
    text,
    bbox: [0.1 + index * 0.15, 0.2, 0.1, 0.05] as const,
  })),
};

const pageFive: ReadingPageDTO = {
  ...samplePage,
  page_id: "30000000-0000-4000-8000-000000000015",
  page_revision_id: "40000000-0000-4000-8000-000000000015",
  page_number: 5,
};

const pageProgressFixture: ReadingSessionPageProgressDTO = {
  session_id: TEST_SESSION_ID,
  persisted: true,
  start_page_id: samplePage.page_id,
  end_page_id: pageFive.page_id,
  current_page_id: samplePage.page_id,
  start_page_number: samplePage.page_number,
  end_page_number: pageFive.page_number,
  current_page_number: samplePage.page_number,
  current_index: 0,
  total_pages: 2,
  completed_pages: 0,
  pages: [
    {
      page_id: samplePage.page_id,
      page_revision_id: samplePage.page_revision_id,
      page_number: samplePage.page_number,
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

function installMatchMedia(isMobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("767px") ? isMobile : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function createReadingServices(
  overrides: Partial<ReadingServices> = {},
): ReadingServices {
  const previews = [samplePage, pageFive].map((p) => ({
    page_id: p.page_id,
    page_number: p.page_number,
    lifecycle_status: "ACTIVE" as const,
    current_verified_revision_id: p.page_revision_id,
    preview_url: "https://example.com/test-page.png",
  }));

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
          page_revision_id: samplePage.page_revision_id,
          source_span: {
            start_word_index: 0,
            end_word_index_exclusive: 4,
            sentence_index: 0,
          },
          difficulty: 1,
          answered: false,
        },
        progress_label: "Câu 1/2",
        choices: [
          { id: "A", label: "Trên bàn", value: "Trên bàn" },
          { id: "B", label: "Bên cửa sổ", value: "Bên cửa sổ" },
        ],
        position: 1,
        total: 2,
      }),
      submitAnswer: vi.fn().mockResolvedValue({
        answer_id: "90000000-0000-4000-8000-000000000001",
        question_id: "80000000-0000-4000-8000-000000000001",
        submitted_answer: "Bên cửa sổ",
        is_correct: false,
        score: 0,
        feedback_code: "TRY_AGAIN",
      }),
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
        message: "Verified",
        mediaRecorderSupported: true,
      }),
      retry: vi.fn().mockResolvedValue("ready"),
    },
    pageMatchService: {
      retryCurrentPage: vi.fn().mockResolvedValue(samplePage),
      selectPage: vi.fn().mockResolvedValue(pageFive),
    },
    readingService: {
      create: vi.fn().mockResolvedValue({ session_id: TEST_SESSION_ID }),
      get: vi.fn().mockResolvedValue({
        ...sessionSummaryFixture,
        state: "PAGE_READY",
        ended_at: null,
        duration_ms: null,
      }),
      getCurrentPage: vi.fn().mockResolvedValue(samplePage),
      getPageProgress: vi.fn().mockResolvedValue(pageProgressFixture),
      navigateToPage: vi.fn().mockResolvedValue(pageProgressFixture),
      completeCurrentPage: vi.fn().mockResolvedValue(pageProgressFixture),
      getCompletionSummary: vi.fn().mockResolvedValue({
        duration_minutes: 5,
        pages_explored: 2,
        practiced_words: 4,
      }),
      finish: vi.fn().mockResolvedValue(undefined),
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
      requestReadExample: vi.fn().mockResolvedValue({
        action: "READ_EXAMPLE",
        action_id: "70000000-0000-4000-8000-000000000001",
        page_revision_word_id: samplePage.words[0].word_id,
        tts_text: "Bé",
      }),
      retryReadExample: vi.fn(),
    },
    ...overrides,
  } as unknown as ReadingServices;
}

describe("M2 Mobile Reading UI & E2E Regressions (F6-F9)", () => {
  beforeEach(() => {
    installMatchMedia(false);
    servicesHook.mockReset().mockReturnValue(createReadingServices());
    speechRecorderMock.prepare.mockResolvedValue(undefined);
    speechRecorderMock.start.mockResolvedValue(undefined);
    speechRecorderMock.stop.mockResolvedValue(new Blob());
    speechPlayerMock.play.mockResolvedValue(undefined);
    speechPlayerMock.playWithWordTimings.mockResolvedValue(undefined);
    speechPlayerMock.resume.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ReadingControls uses @container + @xs/@4xl without truncate or sm:whitespace-normal collisions", () => {
    const { container } = render(
      <ReadingControls
        onChoosePage={vi.fn()}
        onFinish={vi.fn()}
        onHelp={vi.fn()}
        onPause={vi.fn()}
        voiceSettings={
          <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />
        }
      />,
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("@container");

    const nav = screen.getByRole("navigation", { name: "Điều khiển buổi đọc" });
    expect(nav.className).toContain("@xs:grid-cols-5");
    expect(nav.className).toContain("@xl:grid-cols-6");
    expect(nav.className).not.toContain("sm:grid-cols-6");

    for (const button of within(nav).getAllByRole("button")) {
      expect(button.className).toContain("min-h-12");
      expect(button.className).toContain("@4xl:min-h-14");
      expect(button.className).not.toContain("min-h-12!");
      const label = button.querySelector("span:last-child");
      expect(label).not.toBeNull();
      expect(label!.className).not.toContain("truncate");
      expect(label!.className).not.toContain("sm:whitespace-normal");
      expect(label!.className).toContain("whitespace-normal");
      expect(label!.className).toContain("break-words");
    }
  });

  it("BookPageViewer keeps <summary>Xem ảnh trang sách</summary> visible across mobile/zoom and upgrades word targets to min-h-11", () => {
    const { container } = render(
      <BookPageViewer currentWordId={null} page={samplePage} />,
    );

    const summary = screen.getByText("Xem ảnh trang sách");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details!.className).not.toContain("hidden");
    expect(details!.className).not.toContain("sm:block");
    expect(details!.className).toContain("block");
    expect(summary.className).toContain("min-h-11");

    const firstWord = container.querySelector<HTMLElement>("[data-word-id]");
    expect(firstWord).not.toBeNull();
    expect(firstWord!.className).toContain("min-h-11");
    expect(firstWord!.className).not.toContain("min-h-9");
  });

  it("non-blocking TutorMessage renders in static flow without fixed bottom-32 overlay", () => {
    render(
      <TutorMessage
        action={null}
        isRetrying={false}
        nonBlocking
        onClose={vi.fn()}
        onRetry={vi.fn()}
        ttsFailed
        word="mèo"
      />,
    );

    const banner = screen.getByTestId("tts-error-banner");
    expect(banner.className).not.toContain("fixed");
    expect(banner.className).not.toContain("bottom-32");
    for (const btn of within(banner).getAllByRole("button")) {
      expect(btn.className).toContain("min-h-11");
      expect(btn.className).not.toContain("w-auto!");
    }
  });

  it("ComprehensionQuestion eliminates cn() border collisions and uses w-full sm:w-auto on error actions", async () => {
    const user = userEvent.setup();
    render(
      <ComprehensionQuestion
        child={childFixture}
        onComplete={vi.fn()}
        sessionId={TEST_SESSION_ID}
      />,
    );

    const wrongChoice = await screen.findByRole("button", {
      name: /Bên cửa sổ/,
    });
    await user.click(wrongChoice);

    await waitFor(() => {
      expect(wrongChoice.className.split(" ")).toContain("border-warning");
      expect(wrongChoice.className.split(" ")).not.toContain("border-primary");
    });

    servicesHook.mockReturnValue(
      createReadingServices({
        comprehensionService: {
          getQuestion: vi.fn().mockRejectedValue(new Error("offline")),
          submitAnswer: vi.fn(),
        },
      } as Partial<ReadingServices>),
    );
    render(
      <ComprehensionQuestion
        child={childFixture}
        onComplete={vi.fn()}
        sessionId={TEST_SESSION_ID}
      />,
    );
    const retryBtn = await screen.findByRole("button", { name: "Thử lại" });
    expect(retryBtn.className).toContain("w-full");
    expect(retryBtn.className).toContain("sm:w-auto");
  });

  it("ReadingPreparationScreen avoids doubled AppShell padding and preserves mobile CTA widths", async () => {
    installApiFetchFixture();
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`)
        return Response.json(childFixture);
      if (path === `/books/catalog/${TEST_BOOK_ID}`)
        return Response.json(bookFixture);
      if (path === `/books/catalog/${TEST_BOOK_ID}/preview`)
        return Response.json([pagePreviewFixture]);
      throw new Error(`Unexpected path: ${path}`);
    });

    const { container } = render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <ReadingPreparationScreen
            bookId={TEST_BOOK_ID}
            pageId={pagePreviewFixture.page_id}
          />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    const micBtn = await screen.findByRole("button", {
      name: "Kiểm tra và cấp quyền microphone",
    });
    expect(micBtn.className).toContain("w-full");
    expect(micBtn.className).toContain("sm:w-auto");

    const section = container.querySelector("section");
    expect(section).not.toBeNull();
    expect(section!.className).not.toContain("pb-24");
    expect(section!.className).not.toContain("px-3.5");
  });

  it("ReadingScreen collapses into 1 mobile topbar (< 768px), opens bottom sheet with mode switcher, and docks tts-error inside feedback slot", async () => {
    installMatchMedia(true);
    const user = userEvent.setup();

    render(
      <ReadingScreen
        initialUiState="tts-error"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    const topbars = await waitFor(() => {
      const list = document.querySelectorAll('[data-reading-topbar="true"]');
      expect(list.length).toBe(1);
      return list;
    });
    expect(topbars[0].tagName).toBe("HEADER");
    expect(document.querySelector(".reader-bookplate")).toBeNull();

    // Touch-safe >= 44px controls on mobile header
    const prevBtn = screen.getByRole("button", { name: "Trang trước" });
    const nextBtn = screen.getByRole("button", { name: "Trang tiếp theo" });
    const pagePill = document.querySelector('[data-reading-page-pill="true"]');
    const phonicsBtn = screen.getByRole("button", { name: "Nghe đánh vần" });
    const tutorBtn = screen.getByRole("button", {
      name: "Nhờ gia sư giúp đọc",
    });
    const optionsBtn = screen.getByRole("button", { name: "Tùy chọn trang" });
    expect(prevBtn.className).toContain("size-11");
    expect(nextBtn.className).toContain("size-11");
    expect(pagePill?.className).toContain("min-h-11");
    expect(phonicsBtn.className).toContain("size-11");
    expect(tutorBtn.className).toContain("size-11");
    expect(optionsBtn.className).toContain("size-11");

    // Voice engine badge stays mounted in DOM even before sheet opens
    expect(screen.getByTestId("voice-engine-status-badge")).toBeInTheDocument();

    // Non-blocking TTS error banner is docked inside [data-reading-feedback="true"], NOT fixed
    const feedbackSlot = document.querySelector(
      '[data-reading-feedback="true"]',
    );
    expect(feedbackSlot).not.toBeNull();
    const ttsBanner = screen.getByTestId("tts-error-banner");
    expect(feedbackSlot).toContainElement(ttsBanner);
    expect(ttsBanner.className).not.toContain("fixed");

    // Open mobile bottom sheet
    await user.click(optionsBtn);
    const dialog = await screen.findByRole("dialog", {
      name: "Tùy chọn trang",
    });
    expect(within(dialog).getByTestId("reading-mode-switcher")).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Chọn trang" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", {
        name: "Đánh dấu trang đã đọc xong",
      }),
    ).toBeVisible();
  });
});
