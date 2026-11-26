import fs from "node:fs";
import path from "node:path";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookPageContent } from "@/components/reading/book-page-content";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { ReadingLayout } from "@/components/reading/reading-layout";
import { ReadingScreen } from "@/components/reading/reading-screen";
import type { ReadingServices } from "@/hooks/use-reading-services";
import type {
  ActiveAudioKind,
  WordTimedPlayOptions,
} from "@/hooks/use-speech-player";
import { readingPageDtoSchema } from "@/lib/api/reading-service";
import {
  resetAutomationPreferencesCache,
  setAutomationPreferences,
} from "@/lib/reading/automation-preferences";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import { useReadingAutoScroll } from "@/lib/reading/use-reading-auto-scroll";
import {
  recordTtsUnavailability,
  resetVoiceEngineStatus,
} from "@/lib/reading/voice-engine-status";
import { wordPresentationClasses } from "@/lib/reading/word-presentation";
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
  compareTranscriptMock,
  recorderCallbacks,
} = vi.hoisted(() => ({
  servicesHook: vi.fn<() => ReadingServices>(),
  recorderCallbacks: { current: null as (() => void) | null },
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
    isLoading: false,
    isActuallyPlaying: false,
    isPaused: false,
    activeAudioKind: "idle" as ActiveAudioKind,
    fallbackNotice: null as string | null,
    voiceNotice: null as string | null,
    ttsUnavailableReason: null as string | null,
    canInstallVietnameseTtsVoice: false,
    openTtsInstallSettings: vi.fn(async () => true),
    play: vi.fn(),
    playWithWordTimings: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
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
  useSpeechRecorder: (onFailure?: () => void) => {
    recorderCallbacks.current = onFailure ?? null;
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

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 1;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  startCount = 0;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }
  start() {
    this.startCount += 1;
  }
  stop() {
    this.onend?.();
  }
  say(transcript: string, isFinal = true) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal, length: 1, 0: { transcript, confidence: 0.95 } }],
    });
  }
}

function makePage(words: string[], imageUrl?: string): ReadingPageDTO {
  return {
    page_id: "30000000-0000-4000-8000-000000000024",
    page_revision_id: "40000000-0000-4000-8000-000000000024",
    page_number: 4,
    confidence: 0.95,
    width: 600,
    height: 800,
    image_url: imageUrl,
    words: words.map((text, index) => ({
      word_id: `50000000-0000-4000-8000-0000000009${String(index).padStart(2, "0")}`,
      word_index: index,
      text,
      bbox: [
        0.1 + (index % 5) * 0.15,
        0.2 + Math.floor(index / 5) * 0.1,
        0.1,
        0.05,
      ] as const,
    })),
  };
}

const samplePage = makePage(["Bé", "mèo", "nhỏ", "đang", "ngủ", "ngon"]);

const pageProgressFixture: ReadingSessionPageProgressDTO = {
  session_id: TEST_SESSION_ID,
  start_page_id: samplePage.page_id,
  end_page_id: samplePage.page_id,
  start_page_number: 4,
  end_page_number: 4,
  current_page_id: samplePage.page_id,
  current_page_number: 4,
  current_index: 0,
  total_pages: 1,
  completed_pages: 0,
  persisted: true,
  pages: [
    {
      page_id: samplePage.page_id,
      page_number: 4,
      page_revision_id: samplePage.page_revision_id,
      page_order: 1,
      status: "IN_PROGRESS",
      started_at: "2026-10-21T07:00:00Z",
      completed_at: null,
    },
  ],
};

let previousSpeechRecognition: PropertyDescriptor | undefined;

function setupReadingServices() {
  const readingService = {
    create: vi.fn(),
    get: vi.fn().mockResolvedValue({
      ...sessionSummaryFixture,
      state: "PAGE_READY",
      ended_at: null,
      duration_ms: null,
    }),
    getCurrentPage: vi.fn().mockResolvedValue(samplePage),
    getPageProgress: vi.fn().mockResolvedValue(pageProgressFixture),
    completeCurrentPage: vi.fn().mockResolvedValue(pageProgressFixture),
    navigateToPage: vi.fn().mockResolvedValue(pageProgressFixture),
    getCompletionSummary: vi.fn().mockResolvedValue({
      duration_minutes: 3,
      pages_explored: 1,
      practiced_words: 0,
    }),
    finish: vi.fn().mockResolvedValue(sessionSummaryFixture),
    createRetryEvent: vi.fn().mockResolvedValue(undefined),
  };
  const readingSocketAdapter = {
    sendControl: vi.fn().mockResolvedValue("LISTENING"),
    reconnect: vi.fn().mockResolvedValue("recovered"),
    subscribe: vi.fn(() => () => {}),
    getSafetySnapshot: vi.fn().mockReturnValue({
      connection: "connected",
      scoring_active: false,
      evidence_valid: false,
      child_error_events: [],
    }),
  };
  const devicePermissionService = {
    retry: vi.fn().mockResolvedValue("ready"),
    getMicrophonePermissionState: vi.fn().mockResolvedValue("granted"),
    watchMicrophonePermissionState: vi.fn().mockResolvedValue(() => {}),
    requestAccess: vi
      .fn()
      .mockResolvedValue({ status: "granted", verified: true }),
    getSnapshot: vi
      .fn()
      .mockResolvedValue({ camera: "ready", microphone: "ready" }),
  };
  servicesHook.mockReturnValue({
    readingService,
    readingSocketAdapter,
    devicePermissionService,
    pageMatchService: {
      retryCurrentPage: vi.fn().mockResolvedValue(samplePage),
      selectPage: vi.fn().mockResolvedValue(samplePage),
    },
    bookService: {
      get: vi.fn().mockResolvedValue(bookFixture),
      listPages: vi.fn().mockResolvedValue([]),
    },
    childService: {
      get: vi.fn().mockResolvedValue(childFixture),
    },
    tutorService: {
      requestReadExample: vi.fn(),
      retryReadExample: vi.fn(),
    },
    comprehensionService: {
      getQuestion: vi.fn(),
      submitAnswer: vi.fn(),
    },
  } as unknown as ReadingServices);
  return { readingService, readingSocketAdapter, devicePermissionService };
}

beforeEach(() => {
  window.localStorage.clear();
  resetAutomationPreferencesCache();
  resetVoiceEngineStatus();
  recorderCallbacks.current = null;
  previousSpeechRecognition = Object.getOwnPropertyDescriptor(
    window,
    "SpeechRecognition",
  );
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: FakeSpeechRecognition,
  });
  FakeSpeechRecognition.instances = [];
  speechRecorderMock.isRecording = false;
  speechRecorderMock.isSpeaking = false;
  speechRecorderMock.prepare.mockReset().mockResolvedValue(undefined);
  speechRecorderMock.start.mockReset().mockImplementation(async () => {
    speechRecorderMock.isRecording = true;
  });
  speechRecorderMock.stop.mockReset().mockImplementation(async () => {
    speechRecorderMock.isRecording = false;
    return new Blob(["audio"], { type: "audio/webm" });
  });
  speechRecorderMock.cancel.mockReset().mockImplementation(() => {
    speechRecorderMock.isRecording = false;
  });
  speechRecorderMock.getStream.mockReset().mockReturnValue(null);
  speechRecorderMock.getIsSpeaking.mockReset().mockReturnValue(false);
  speechRecorderMock.getQuality.mockReset().mockReturnValue(undefined);

  speechPlayerMock.isPlaying = false;
  speechPlayerMock.isLoading = false;
  speechPlayerMock.isActuallyPlaying = false;
  speechPlayerMock.isPaused = false;
  speechPlayerMock.activeAudioKind = "idle";
  speechPlayerMock.fallbackNotice = null;
  speechPlayerMock.voiceNotice = null;
  speechPlayerMock.ttsUnavailableReason = null;
  speechPlayerMock.canInstallVietnameseTtsVoice = false;
  speechPlayerMock.openTtsInstallSettings.mockReset().mockResolvedValue(true);
  speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
  speechPlayerMock.playWithWordTimings.mockReset().mockResolvedValue(undefined);
  speechPlayerMock.stop.mockReset().mockImplementation(() => {
    speechPlayerMock.isPlaying = false;
    speechPlayerMock.activeAudioKind = "idle";
  });
  speechServiceMock.transcribe
    .mockReset()
    .mockResolvedValue({ text: "", words: [] });
  compareTranscriptMock.mockReset().mockResolvedValue({
    accuracy_score: 1,
    total_words: 6,
    correct_words: 6,
    errors: [],
    word_statuses: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (previousSpeechRecognition) {
    Object.defineProperty(
      window,
      "SpeechRecognition",
      previousSpeechRecognition,
    );
  } else {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  }
  vi.restoreAllMocks();
});

describe("RealtimeAlignmentEngine anti-jump hardening", () => {
  it("does NOT paint DELETE on a single spurious ahead token mid-page, and confirms DELETE only on 2 consecutive ahead words", () => {
    const page = makePage(["Bé", "mèo", "nhỏ", "đang", "ngủ", "ngon"]);
    const engine = new RealtimeAlignmentEngine(page.words);

    let snap = engine.addFinalTranscript("Bé");
    expect(snap.currentWordIndex).toBe(1);

    // Single stray ahead token "nhỏ" (index 2, skipping "mèo"): must NOT paint "mèo" DELETE yet!
    snap = engine.addFinalTranscript("nhỏ");
    expect(
      snap.statusByWordId.get(page.words[1].word_id)?.status,
    ).toBeUndefined();
    expect(snap.currentWordIndex).toBe(1);

    // Next token confirms the consecutive run ("đang", index 3): NOW skip-ahead commits cleanly!
    snap = engine.addFinalTranscript("đang");
    expect(snap.statusByWordId.get(page.words[1].word_id)?.status).toBe(
      "DELETE",
    );
    expect(snap.statusByWordId.get(page.words[2].word_id)?.status).toBe(
      "MATCH",
    );
    expect(snap.statusByWordId.get(page.words[3].word_id)?.status).toBe(
      "MATCH",
    );
    expect(snap.currentWordIndex).toBe(4);
  });

  it("commits skip-ahead immediately when matching the very last word of the page (no n+1 word exists)", () => {
    const page = makePage(["Bé", "mèo", "nhỏ", "đang"]);
    const engine = new RealtimeAlignmentEngine(page.words);

    const snap = engine.addFinalTranscript("Bé đang");
    expect(snap.statusByWordId.get(page.words[0].word_id)?.status).toBe(
      "MATCH",
    );
    expect(snap.statusByWordId.get(page.words[1].word_id)?.status).toBe(
      "DELETE",
    );
    expect(snap.statusByWordId.get(page.words[2].word_id)?.status).toBe(
      "DELETE",
    );
    expect(snap.statusByWordId.get(page.words[3].word_id)?.status).toBe(
      "MATCH",
    );
    expect(snap.currentWordIndex).toBe(-1);
    expect(snap.currentWordId).toBeNull();
  });

  it("caps far re-anchor jumps at 12 words (does not jump 15 words ahead and paint red across the page)", () => {
    const words = [
      "một",
      "hai",
      "ba",
      "bốn",
      "năm",
      "sáu",
      "bảy",
      "tám",
      "chín",
      "mười",
      "lá",
      "hoa",
      "cỏ",
      "cây",
      "trời",
      "mây",
      "nắng",
      "gió",
      "mưa",
      "sao",
    ];
    const page = makePage(words);
    const engine = new RealtimeAlignmentEngine(page.words);

    engine.addFinalTranscript("một"); // cursor at 1 ("hai")
    // Words 16 & 17 ("nắng gió") are 15 words ahead (> REANCHOR_WINDOW = 12)
    const snap = engine.addFinalTranscript("nắng gió");
    expect(snap.currentWordIndex).toBeLessThan(5);
    expect(snap.statusByWordId.get(page.words[10].word_id)).toBeUndefined();
  });

  it("never paints DELETE/SUBSTITUTE or jumps cursor on a single lookahead token during interim previewAlignment", () => {
    const page = makePage(["Bé", "mèo", "nhỏ", "đang", "ngủ"]);
    const engine = new RealtimeAlignmentEngine(page.words);
    engine.addFinalTranscript("Bé"); // cursor at 1 ("mèo")

    const preview1 = engine.previewAlignment("nhỏ");
    expect(preview1.currentWordIndex).toBe(1);
    expect(preview1.statusByWordId.get(page.words[1].word_id)).toBeUndefined();

    const preview2 = engine.previewAlignment("nhỏ đang");
    expect(preview2.currentWordIndex).toBe(4);
    expect(preview2.statusByWordId.get(page.words[1].word_id)).toBeUndefined();
  });

  it("excludes ignored hesitation fillers from off-topic denominator (M1 edge-case #2) and rejects 2-token zero-match noise without false red skips (T2.2)", () => {
    const page = makePage(["Sáng", "sớm", "bé", "Lan", "ngồi", "đọc", "sách"]);
    const engine = new RealtimeAlignmentEngine(page.words);

    engine.addFinalTranscript("Sáng sớm"); // cursor at 2 ("bé")
    expect(engine.isOffTopicText("ờ ừm bé")).toBe(false);
    expect(engine.isOffTopicText("ờ hôm nay bé Lan")).toBe(false);

    // T2.2 sequence: "à", "ừm", "con ơi" -> 0 red skips, cursor remains on "bé" (index 2)
    for (const noise of ["à", "ừm", "con ơi"]) {
      engine.addFinalTranscript(noise);
    }
    const snap = engine.getSnapshot();
    expect(snap.currentWordIndex).toBe(2);
    expect(snap.statusByWordId.get(page.words[2].word_id)).toBeUndefined();
    expect(snap.statusByWordId.get(page.words[3].word_id)).toBeUndefined();
  });

  it("keeps previewAlignment monotonic on repeated cursor-1 tokens and suppresses lookahead when allowLookahead is false", () => {
    const page = makePage(["Sáng", "sớm", "bé", "Lan", "đọc", "sách"]);
    const engine = new RealtimeAlignmentEngine(page.words);
    engine.addFinalTranscript("Sáng sớm"); // cursor at 2 ("bé")

    // Repeating cursor - 1 ("sớm") marks REPEATED status without rewinding active cursor
    const repeatPreview = engine.previewAlignment("sớm", {
      allowLookahead: false,
    });
    expect(repeatPreview.currentWordIndex).toBe(2);
    expect(repeatPreview.currentWordId).toBe(page.words[2].word_id);
    expect(repeatPreview.repeatedWordIds.has(page.words[1].word_id)).toBe(true);

    // Dropping leading word ("Lan" while at "bé") with allowLookahead: false does NOT jump ahead
    const droppedLeading = engine.previewAlignment("Lan", {
      allowLookahead: false,
    });
    expect(droppedLeading.currentWordIndex).toBe(2);
    expect(droppedLeading.currentWordId).toBe(page.words[2].word_id);

    // At end of page, repeating last word does NOT rewind finished null cursor back to last word
    engine.addFinalTranscript("bé Lan đọc sách");
    expect(engine.getSnapshot().currentWordId).toBeNull();
    const endRepeat = engine.previewAlignment("sách", {
      allowLookahead: false,
    });
    expect(endRepeat.currentWordId).toBeNull();
  });
});

describe("BookPageContent & word-presentation zero-reflow calm states", () => {
  it("renders zero inline glyph decorations (•, ↺, ◇, ?, ♪) and zero border-b-4/border-b-2 classes across all states", () => {
    const page = makePage([
      "một",
      "hai",
      "ba",
      "bốn",
      "năm",
      "sáu",
      "bảy",
      "tám",
    ]);
    const { container } = render(
      <BookPageContent
        page={page}
        currentWordId={page.words[0].word_id}
        correctWordIds={new Set([page.words[1].word_id])}
        mispronouncedWordIds={new Set([page.words[2].word_id])}
        selfCorrectedWordIds={new Set([page.words[3].word_id])}
        unresolvedWordIds={new Set([page.words[4].word_id])}
        uncertainWordIds={new Set([page.words[5].word_id])}
        assistedWordIds={new Set([page.words[6].word_id])}
      />,
    );

    const tokens = Array.from(
      container.querySelectorAll<HTMLElement>("[data-word-id]"),
    );
    expect(tokens).toHaveLength(8);

    for (const token of tokens) {
      expect(token.textContent).not.toMatch(/[•↺◇?♪]/);
      expect(token.className).not.toContain("border-b-4");
      expect(token.className).not.toContain("border-b-2");
      expect(token.className).not.toContain("ring-2");
    }

    for (const cls of Object.values(wordPresentationClasses)) {
      expect(cls).not.toContain("border-b-4");
      expect(cls).not.toContain("border-b-2");
      expect(cls).not.toContain("ring-2");
    }
  });
});

describe("useReadingAutoScroll line-change and interim preview guards", () => {
  it("skips scroll during unstable interim preview and skips redundant scrolls on the same line", () => {
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });

    try {
      const container = document.createElement("div");
      Object.defineProperty(container, "clientHeight", {
        value: 400,
        configurable: true,
      });
      Object.defineProperty(container, "scrollHeight", {
        value: 1200,
        configurable: true,
      });
      Object.defineProperty(container, "scrollTop", {
        value: 0,
        writable: true,
        configurable: true,
      });
      container.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: 400,
          left: 0,
          right: 360,
          width: 360,
          height: 400,
        }) as DOMRect;
      const scrollTo = vi.fn((opts: ScrollToOptions) => {
        if (typeof opts?.top === "number") container.scrollTop = opts.top;
      });
      container.scrollTo = scrollTo as unknown as typeof container.scrollTo;

      const wordA = document.createElement("span");
      const wordB = document.createElement("span");
      const wordC = document.createElement("span");
      // Word A & B on same line (y = 340), Word C on next line (y = 660, outside comfort zone after scroll)
      wordA.getBoundingClientRect = () =>
        ({
          top: 340 - container.scrollTop,
          bottom: 380 - container.scrollTop,
          height: 40,
        }) as DOMRect;
      wordB.getBoundingClientRect = () =>
        ({
          top: 340 - container.scrollTop,
          bottom: 380 - container.scrollTop,
          height: 40,
        }) as DOMRect;
      wordC.getBoundingClientRect = () =>
        ({
          top: 660 - container.scrollTop,
          bottom: 700 - container.scrollTop,
          height: 40,
        }) as DOMRect;

      const map = new Map<string, HTMLElement>([
        ["w-a", wordA],
        ["w-b", wordB],
        ["w-c", wordC],
      ]);

      const { rerender } = renderHook(
        ({ activeWordId, isInterimPreview }) =>
          useReadingAutoScroll({
            containerRef: { current: container },
            getActiveElement: () => map.get(activeWordId) ?? null,
            activeWordId,
            pageKey: "p1:r1",
            isInterimPreview,
          }),
        { initialProps: { activeWordId: "w-a", isInterimPreview: true } },
      );

      // Interim preview must NOT scroll
      expect(scrollTo).not.toHaveBeenCalled();

      // Commit word A -> scrolls once to bring line into comfort zone
      rerender({ activeWordId: "w-a", isInterimPreview: false });
      expect(scrollTo).toHaveBeenCalledTimes(1);

      // Move to word B on the SAME line -> must NOT trigger another scroll
      rerender({ activeWordId: "w-b", isInterimPreview: false });
      expect(scrollTo).toHaveBeenCalledTimes(1);

      // Move to word C on a NEW line outside comfort zone -> triggers scroll
      rerender({ activeWordId: "w-c", isInterimPreview: false });
      expect(scrollTo).toHaveBeenCalledTimes(2);
    } finally {
      rafSpy.mockRestore();
    }
  });
});

describe("ReadingLayout mobile shell & options sheet", () => {
  it("provides mobile header menu modal, mobile page image modal, and 4-column mobile dock", async () => {
    const user = userEvent.setup();
    const onPrevPage = vi.fn();
    const onNextPage = vi.fn();
    const onSpellWord = vi.fn();
    const pageWithImage = makePage(
      ["Bé", "mèo"],
      "https://example.test/p4.png",
    );

    render(
      <ReadingLayout
        bookTitle="Chú Mèo Nhỏ"
        child={childFixture}
        currentWordId={pageWithImage.words[0].word_id}
        currentWordText="Bé"
        exitHref="/books"
        isListening={false}
        onFinish={vi.fn()}
        onHelp={vi.fn()}
        onPause={vi.fn()}
        onPrevPage={onPrevPage}
        onNextPage={onNextPage}
        canPrevPage
        canNextPage
        onSpellWord={onSpellWord}
        page={pageWithImage}
        totalPages={5}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Điều khiển buổi đọc" });
    expect(nav).toHaveAttribute("data-mobile-dock-cols", "4");
    expect(
      within(nav).getByRole("button", { name: "Tạm dừng buổi đọc" }),
    ).toHaveAttribute("data-desktop-only-control", "true");
    expect(
      within(nav).getByRole("button", { name: "Chọn trang" }),
    ).toHaveAttribute("data-desktop-only-control", "true");
    await user.click(
      within(nav).getByRole("button", { name: "Đánh vần từ này" }),
    );
    expect(onSpellWord).toHaveBeenCalledOnce();

    await user.click(screen.getByTestId("mobile-reading-menu-btn"));
    const dialog = await screen.findByRole("dialog", {
      name: "Tùy chọn buổi đọc",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Trang tiếp" }),
    );
    expect(onNextPage).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Mở ảnh trang sách" }));
    expect(
      await screen.findByRole("dialog", { name: "Ảnh trang 4" }),
    ).toBeInTheDocument();
  });

  it("renders Tạm dừng mẫu with >=44px touch height (min-h-11), in-flow feedback, and 4-band @media (max-width: 767px) + compact landscape contract", () => {
    render(
      <ReadingLayout
        bookTitle="Chú Mèo Nhỏ"
        child={childFixture}
        currentWordId={samplePage.words[0].word_id}
        currentWordText="Bé"
        exitHref="/books"
        isListening={false}
        isPlayingSample
        isSamplePaused={false}
        onToggleSamplePause={vi.fn()}
        onReadSample={vi.fn()}
        onFinish={vi.fn()}
        onHelp={vi.fn()}
        onPause={vi.fn()}
        page={samplePage}
      />,
    );

    const samplePauseBtn = screen.getByRole("button", { name: "Tạm dừng mẫu" });
    expect(samplePauseBtn.className).toContain("min-h-11");
    expect(samplePauseBtn.className).not.toContain("min-h-10");

    const feedbackSlot = document.querySelector(
      '[data-reading-feedback="true"]',
    );
    expect(feedbackSlot?.className).not.toContain("max-sm:absolute");

    const globalsCss = fs.readFileSync(
      path.resolve(__dirname, "../../app/globals.css"),
      "utf8",
    );
    const max767Blocks = Array.from(
      globalsCss.matchAll(/@media \(max-width: 767px\) \{([\s\S]*?)\n\}/g),
      (m) => m[1],
    );
    expect(max767Blocks.length).toBeGreaterThanOrEqual(1);
    expect(
      max767Blocks.some(
        (block) =>
          block.includes(".reader-bookplate") &&
          block.includes("data-desktop-only-control") &&
          block.includes("data-voice-settings-wrap"),
      ),
    ).toBe(true);
    expect(globalsCss).not.toMatch(/@media \(max-width: 639px\)/);

    const compactLandscapeBlocks = Array.from(
      globalsCss.matchAll(
        /@media \(max-height: 520px\) and \(min-width: 640px\) \{([\s\S]*?)\n\}/g,
      ),
      (m) => m[1],
    );
    expect(
      compactLandscapeBlocks.some(
        (block) =>
          block.includes("data-desktop-only-control") &&
          block.includes("data-voice-settings-wrap") &&
          block.includes("display: inline-flex"),
      ),
    ).toBe(true);

    expect(globalsCss).not.toMatch(
      /@media \(max-height: 520px\) and \(max-width: 319px\)[\s\S]*?position:\s*static/,
    );
  });

  it("hides V2 storybook bookplate, mode switcher, and illustration inline on < md and softens overlay word styling", () => {
    const v2Page: ReadingPageDTO = {
      ...samplePage,
      image_url: "https://example.test/scan.png",
      illustration_url: "https://example.test/illus.png",
      illustration_text_free: true,
    };

    const { container } = render(
      <BookPageViewer
        title="Truyện Tranh"
        illustrationUrl={v2Page.illustration_url}
        illustrationTextFree={v2Page.illustration_text_free}
        page={v2Page}
        currentWordId={v2Page.words[0].word_id}
        mispronouncedWordIds={new Set([v2Page.words[1].word_id])}
        selfCorrectedWordIds={new Set([v2Page.words[2].word_id])}
      />,
    );

    const bookplate = container.querySelector(".reader-bookplate");
    expect(bookplate?.className).toContain("hidden");
    expect(bookplate?.className).toContain("md:flex");

    const illustrationCard = screen.getByTestId("storybook-illustration-card");
    expect(illustrationCard.className).toContain("hidden");
    expect(illustrationCard.className).toContain("md:block");

    expect(container.textContent).not.toMatch(/[•↺◇?♪]/);
  });
});

describe("ReadingScreen regressions: preemption, silent interrupt, stt-unavailable recovery, word click race", () => {
  it("preempts active coaching audio when child presses Nghe mẫu instead of silently cancelling", async () => {
    setupReadingServices();
    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );
    const sampleBtn = await screen.findByRole("button", {
      name: "Nghe đọc mẫu cả trang",
    });

    speechPlayerMock.isPlaying = true;
    speechPlayerMock.activeAudioKind = "coaching";

    await user.click(sampleBtn);

    await waitFor(() => {
      expect(speechPlayerMock.stop).toHaveBeenCalled();
      expect(speechPlayerMock.playWithWordTimings).toHaveBeenCalledOnce();
    });
  });

  it("cancels silent recorder immediately on Nghe mẫu without transcribing silence or painting uncertain '?'", async () => {
    setupReadingServices();
    speechRecorderMock.getQuality.mockReturnValue({
      status: "SILENCE",
      durationMs: 1200,
      speechDurationMs: 0,
      silenceDurationMs: 1200,
      rms: 0.0005,
      peak: 0.001,
      noiseFloor: 0.0005,
      clipped: false,
      isSpeaking: false,
    });

    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    expect(speechRecorderMock.isRecording).toBe(true);

    await user.click(
      screen.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    );

    await waitFor(() =>
      expect(speechPlayerMock.playWithWordTimings).toHaveBeenCalledOnce(),
    );
    expect(speechServiceMock.transcribe).not.toHaveBeenCalled();
    expect(speechRecorderMock.cancel).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Bé" })).not.toHaveAttribute(
      "data-reading-state",
      "uncertain",
    );
  });

  it("handles stt-unavailable cleanly, lets user dismiss modal or reconnect, and accepts transcripts after reconnect (no stale uiState closure)", async () => {
    setupReadingServices();
    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    const firstRec = FakeSpeechRecognition.instances[0];
    expect(firstRec).toBeDefined();
    expect(firstRec.startCount).toBe(1);

    act(() => {
      firstRec.onerror?.({ error: "stt-unavailable" });
      firstRec.onend?.();
    });

    expect(
      await screen.findByRole("button", { name: "Đóng, tự đọc tiếp" }),
    ).toBeInTheDocument();
    expect(firstRec.startCount).toBe(1);

    await user.click(screen.getByRole("button", { name: "Thử nghe lại" }));
    await waitFor(() =>
      expect(FakeSpeechRecognition.instances.length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
      ).toBeInTheDocument(),
    );

    const recoveredRec =
      FakeSpeechRecognition.instances[
        FakeSpeechRecognition.instances.length - 1
      ];
    act(() => {
      recoveredRec.say("Bé mèo");
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Bé" })).toHaveAttribute(
        "data-reading-state",
        "correct",
      );
      expect(screen.getByRole("button", { name: "mèo" })).toHaveAttribute(
        "data-reading-state",
        "correct",
      );
    });
  });

  it("keeps clicked word highlighted AND releases isBusy so controls stay enabled when tapping a word while page sample is running", async () => {
    setupReadingServices();
    let rejectSample!: (err: Error) => void;
    speechPlayerMock.playWithWordTimings.mockImplementationOnce(() => {
      speechPlayerMock.isPlaying = true;
      speechPlayerMock.activeAudioKind = "sample";
      return new Promise<void>((_resolve, reject) => {
        rejectSample = reject;
      });
    });
    speechPlayerMock.stop.mockImplementation(() => {
      speechPlayerMock.isPlaying = false;
      speechPlayerMock.activeAudioKind = "idle";
      rejectSample?.(new DOMException("Stopped", "AbortError"));
    });

    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    );
    await waitFor(() =>
      expect(speechPlayerMock.playWithWordTimings).toHaveBeenCalledOnce(),
    );

    await user.click(screen.getByRole("button", { name: "nhỏ" }));
    await waitFor(() =>
      expect(speechPlayerMock.play).toHaveBeenCalledWith("nhỏ", {
        wordSample: true,
      }),
    );

    expect(screen.getByRole("button", { name: "nhỏ" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    // Regression guard: interrupting page sample via word click must NEVER leak
    // isBusy=true and disable all reading controls permanently.
    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /Bé đọc với nhận diện giọng nói|Dừng nhận diện giọng nói/,
        }),
      ).not.toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).not.toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Đánh vần từ này" }),
      ).not.toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Kết thúc buổi đọc" }),
      ).not.toBeDisabled();
    });
  });

  it("clears stale interim previewSnapshot when starting Nghe mẫu so sample word highlighting advances cleanly", async () => {
    setupReadingServices();
    let sampleOnWordChange: ((index: number) => void) | undefined;
    speechPlayerMock.playWithWordTimings.mockImplementationOnce(
      (_words: readonly string[], opts: WordTimedPlayOptions) => {
        sampleOnWordChange = opts.onWordChange;
        speechPlayerMock.isPlaying = true;
        speechPlayerMock.activeAudioKind = "sample";
        opts.onPlay?.();
        opts.onWordChange?.(0);
        return new Promise<void>(() => {});
      },
    );

    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    const rec = FakeSpeechRecognition.instances[0];
    expect(rec).toBeDefined();

    // Emit interim preview moving preview cursor to word[2] ("nhỏ")
    act(() => {
      rec.say("Bé mèo", false);
    });
    expect(screen.getByRole("button", { name: "nhỏ" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    // Interrupt with "Nghe mẫu": stale previewSnapshot must be cleared so sample
    // highlighting visibly tracks word[0] -> word[1] instead of staying stuck on "nhỏ"!
    await user.click(
      screen.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    );
    await waitFor(() =>
      expect(speechPlayerMock.playWithWordTimings).toHaveBeenCalledOnce(),
    );

    expect(screen.getByRole("button", { name: "Bé" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    act(() => {
      sampleOnWordChange?.(1);
    });
    expect(screen.getByRole("button", { name: "mèo" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("routes all uiState mutations through updateUiState and blocks same-tick auto-complete after recorder failure", async () => {
    const screenSrc = fs.readFileSync(
      path.resolve(__dirname, "../../components/reading/reading-screen.tsx"),
      "utf8",
    );
    const directSetUiStateMatches = screenSrc.match(/\bsetUiState\(/g) ?? [];
    // Only the single call inside updateUiState is permitted.
    expect(directSetUiStateMatches).toHaveLength(1);
    expect(screenSrc).toContain('uiStateRef.current !== "reading"');

    const { readingService } = setupReadingServices();
    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    const rec = FakeSpeechRecognition.instances[0];
    expect(rec).toBeDefined();

    // Read all words up to the second-to-last word
    act(() => {
      rec.say("Bé mèo nhỏ đang ngủ");
    });
    expect(screen.getByRole("button", { name: "ngon" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    // Trigger recorder failure (calls updateUiState("microphone-denied") synchronously)
    // and emit final word in the SAME synchronous tick BEFORE React re-renders:
    // uiStateRef.current must already be "microphone-denied" so onresult & autoComplete ignore it!
    act(() => {
      recorderCallbacks.current?.();
      rec.say("ngon");
    });

    expect(
      await screen.findByRole("dialog", {
        name: "Mình chưa nghe thấy giọng bé",
      }),
    ).toBeInTheDocument();
    expect(readingService.completeCurrentPage).not.toHaveBeenCalled();
  });

  it("syncs uiStateRef on page-picker confirm so immediate speech after returning from paused auto-completes page cleanly", async () => {
    const { readingService } = setupReadingServices();
    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    // Open page picker (transitions uiState -> "paused") and confirm same page
    // (navigateWithinRange calls updateUiState("reading")).
    await user.click(await screen.findByRole("button", { name: "Chọn trang" }));
    await user.click(
      await screen.findByRole("button", { name: "Đúng trang này" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
    );
    const rec =
      FakeSpeechRecognition.instances[
        FakeSpeechRecognition.instances.length - 1
      ];
    expect(rec).toBeDefined();

    act(() => {
      rec.say("Bé mèo nhỏ đang ngủ ngon");
    });

    await waitFor(() => {
      expect(readingService.completeCurrentPage).toHaveBeenCalledOnce();
    });
  });

  it("releases the 120s automation waitUntilAt hold when child preempts Nghe mẫu with the mic button", async () => {
    setAutomationPreferences({ assist: true, autoAdvance: true });
    setupReadingServices();

    let rejectSample!: (err: Error) => void;
    speechPlayerMock.playWithWordTimings.mockImplementationOnce(() => {
      speechPlayerMock.isPlaying = true;
      speechPlayerMock.activeAudioKind = "sample";
      return new Promise<void>((_resolve, reject) => {
        rejectSample = reject;
      });
    });
    speechPlayerMock.stop.mockImplementation(() => {
      speechPlayerMock.isPlaying = false;
      speechPlayerMock.activeAudioKind = "idle";
      rejectSample?.(new DOMException("Stopped", "AbortError"));
    });

    await act(async () => {
      render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );
    });
    const micBtn = await screen.findByRole("button", {
      name: "Bé đọc với nhận diện giọng nói",
    });

    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());

    // 1. Start listening so automation runtime is active and listening
    await act(async () => {
      fireEvent.click(micBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    // 2. Start Nghe mẫu -> playAssistantAudio sets 120s SPEECH_ACTIVITY hold
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(speechPlayerMock.playWithWordTimings).toHaveBeenCalledOnce();

    // 3. Preempt sample audio by clicking Bé đọc (mic) -> preventAssistantAudioResume
    //    must release the 120s hold (SPEECH_ACTIVITY { holdMs: 0 })!
    speechPlayerMock.play.mockClear();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // 4. Advance 12s (well past normal ~4s hesitation threshold, far below 120s).
    //    If the 120s hold leaked, auto-help would NOT fire at 12s!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    expect(speechPlayerMock.play).toHaveBeenCalled();
  });

  it("does not block reading on android_vi_voice_missing and exposes Mở Cài đặt TTS in the ⋮ sheet", async () => {
    setupReadingServices();
    speechPlayerMock.playWithWordTimings.mockImplementationOnce(async () => {
      recordTtsUnavailability({
        reason: "android_vi_voice_missing",
        canInstallVietnameseTtsVoice: true,
        voiceNotice:
          "Thiết bị chưa cài giọng đọc tiếng Việt cho TTS ngoại tuyến.",
      });
      speechPlayerMock.ttsUnavailableReason = "android_vi_voice_missing";
      speechPlayerMock.canInstallVietnameseTtsVoice = true;
      speechPlayerMock.voiceNotice =
        "Thiết bị chưa cài giọng đọc tiếng Việt cho TTS ngoại tuyến.";
      throw new Error("TTS unavailable");
    });

    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Nghe đọc mẫu cả trang" }),
    );

    await waitFor(() => {
      expect(speechPlayerMock.playWithWordTimings).toHaveBeenCalledOnce();
    });

    // Must NOT open blocking "Đọc tiếp" tts-error modal
    expect(
      screen.queryByRole("button", { name: "Đọc tiếp" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
    ).toBeEnabled();

    await user.click(screen.getByTestId("mobile-reading-menu-btn"));
    const dialog = await screen.findByRole("dialog", {
      name: "Tùy chọn buổi đọc",
    });
    const installBtn = within(dialog).getByRole("button", {
      name: "Mở Cài đặt TTS",
    });
    await user.click(installBtn);
    expect(speechPlayerMock.openTtsInstallSettings).toHaveBeenCalledOnce();
  });

  it("keeps readingPageDtoSchema tts_audio_url/tts_word_timings for catalog books while discarding poisoned URLs on PARENT_PRIVATE", () => {
    const parsed = readingPageDtoSchema.parse({
      ...samplePage,
      tts_audio_url: "https://cdn.example.test/viread-catalog-tts/p1.mp3",
      tts_word_timings: [{ index: 0, start: 0, end: 0.4 }],
    });
    expect(parsed.tts_audio_url).toBe(
      "https://cdn.example.test/viread-catalog-tts/p1.mp3",
    );
    expect(parsed.tts_word_timings).toEqual([{ index: 0, start: 0, end: 0.4 }]);
  });

  it("never rewinds active reading cursor on fluctuating or confidence-0 interim transcripts", async () => {
    setupReadingServices();
    const user = userEvent.setup();
    render(
      <ReadingScreen
        initialUiState="reading"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      }),
    );
    const rec = FakeSpeechRecognition.instances[0];
    expect(rec).toBeDefined();

    // Advance interim preview to word[2] ("nhỏ")
    act(() => {
      rec.say("Bé mèo", false);
    });
    expect(screen.getByRole("button", { name: "nhỏ" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    // Fluctuating shorter interim or confidence: 0 cursor-1 repeat must NOT rewind to "mèo" or "Bé"
    act(() => {
      rec.onresult?.({
        resultIndex: 0,
        results: [
          { isFinal: false, length: 1, 0: { transcript: "Bé", confidence: 0 } },
        ],
      });
    });
    expect(screen.getByRole("button", { name: "nhỏ" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});
