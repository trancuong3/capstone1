import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/api/service-error";
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
  ReadingUiState,
} from "@/types/reading";
import {
  resetAutomationPreferencesCache,
  setCoachingStyle,
} from "@/lib/reading/automation-preferences";
import {
  INTERACTIVE_PROMPT_BANKS,
  InteractivePromptSelector,
} from "@/lib/reading/interactive-prompts";
import { classifyReadingMistake } from "@/lib/reading/reading-mistake-classifier";

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
    play: vi.fn(),
    playWithWordTimings: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
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

function makePage(words: readonly string[], pageNum = 4): ReadingPageDTO {
  return {
    page_id: `30000000-0000-4000-8000-0000000000${pageNum}`,
    page_revision_id: `40000000-0000-4000-8000-0000000000${pageNum}`,
    page_number: pageNum,
    text: words.join(" "),
    confidence: 0.95,
    width: 600,
    height: 800,
    words: words.map((text, index) => ({
      word_id: `50000000-0000-4000-8000-00000000${pageNum}0${index}`,
      word_index: index,
      text,
      bbox: [0.08 + index * 0.16, 0.2, 0.12, 0.05] as const,
    })),
  };
}

const defaultPage = makePage(["Bé", "mèo", "nhỏ", "đang"], 14);
const nextPage = makePage(["Con", "cá", "vàng", "bơi"], 15);

function makeProgress(
  first: ReadingPageDTO,
  second: ReadingPageDTO,
): ReadingSessionPageProgressDTO {
  return {
    session_id: TEST_SESSION_ID,
    persisted: true,
    start_page_id: first.page_id,
    end_page_id: second.page_id,
    current_page_id: first.page_id,
    start_page_number: first.page_number,
    end_page_number: second.page_number,
    current_page_number: first.page_number,
    current_index: 0,
    total_pages: 2,
    completed_pages: 0,
    pages: [first, second].map((page, order) => ({
      page_id: page.page_id,
      page_revision_id: page.page_revision_id,
      page_number: page.page_number,
      page_order: order,
      status: order === 0 ? ("IN_PROGRESS" as const) : ("PENDING" as const),
      started_at: null,
      completed_at: null,
    })),
  };
}

function createServices(activePage = defaultPage) {
  const progress = makeProgress(activePage, nextPage);
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
      selectPage: vi.fn().mockResolvedValue(nextPage),
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

let services: ReadingServices;

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
  services = createServices(defaultPage);
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
    page_id: defaultPage.page_id,
    page_revision_id: defaultPage.page_revision_id,
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

async function startWithFakeClock(initialState: ReadingUiState = "reading") {
  await act(async () => {
    render(
      <ReadingScreen
        initialUiState={initialState}
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );
  });
  const start = await screen.findByRole("button", {
    name: "Bé đọc với nhận diện giọng nói",
  });
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  await act(async () => fireEvent.click(start));
  return lastRecognition();
}

const wordEl = (name: string) => screen.getByRole("button", { name });
const SUCCESS = "bg-success-surface";

describe("Empathetic Grade-1 teacher comfort, mistake classification & phonics modeling (G27, G28)", () => {
  it("classifies Vietnamese Grade-1 reading mistakes into TONE, NEAR_SOUND, and GENERAL", () => {
    // Group A: Tone mistakes
    expect(classifyReadingMistake("má", "ma")).toBe("TONE");
    expect(classifyReadingMistake("mèo", "méo")).toBe("TONE");
    expect(classifyReadingMistake("ở", "ờ")).toBe("TONE");

    // Group B: Near-sound onset/rhyme confusions
    expect(classifyReadingMistake("đi", "di")).toBe("NEAR_SOUND");
    expect(classifyReadingMistake("sách", "xách")).toBe("NEAR_SOUND");
    expect(classifyReadingMistake("trường", "chường")).toBe("NEAR_SOUND");
    expect(classifyReadingMistake("lúa", "núa")).toBe("NEAR_SOUND");
    expect(classifyReadingMistake("quả", "cả")).toBe("NEAR_SOUND");
    expect(classifyReadingMistake("tiếng", "tướng")).toBe("NEAR_SOUND");
    expect(classifyReadingMistake("đang", "đan")).toBe("NEAR_SOUND");
    expect(classifyReadingMistake("bắt", "bắc")).toBe("NEAR_SOUND");

    // Group C: General unrelated mismatch
    expect(classifyReadingMistake("mèo", "ghế")).toBe("GENERAL");
  });

  it("provides rich multi-sentence comfort banks (>=8 TONE, >=8 NEAR_SOUND, >=10 GENERAL) with zero consecutive repeats", () => {
    expect(
      INTERACTIVE_PROMPT_BANKS.comfortToneMistake.length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      INTERACTIVE_PROMPT_BANKS.comfortNearSoundMistake.length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      INTERACTIVE_PROMPT_BANKS.comfortGeneralMistake.length,
    ).toBeGreaterThanOrEqual(10);
    expect(
      INTERACTIVE_PROMPT_BANKS.comfortGiveUpEffort.length,
    ).toBeGreaterThanOrEqual(6);

    const selector = new InteractivePromptSelector();
    let prev = "";
    for (let i = 0; i < 20; i += 1) {
      const next = selector.next("comfortGeneralMistake", { word: "mèo" });
      expect(next).not.toBe(prev);
      expect(next).toContain("mèo");
      prev = next;
    }
  });

  it("comforts the child warmly after ~1.5s on a wrong word (eliminating 9s silence) and never repeats consecutive comfort prompts", async () => {
    const rec = await startWithFakeClock();
    act(() => rec.say("Bé ghế"));

    // Within 1.0s self-correction window: teacher stays quiet so child can self-fix
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(speechPlayerMock.play).not.toHaveBeenCalled();

    // At ~1.5s (well before 9s!): teacher immediately speaks multi-sentence warm comfort
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(speechPlayerMock.play).toHaveBeenCalledTimes(1);
    const firstComfort = speechPlayerMock.play.mock.calls[0]?.[0] as string;
    expect(firstComfort).toContain("mèo");
    expect(
      firstComfort.split(/[.!?]+/u).filter((s) => s.trim()).length,
    ).toBeGreaterThanOrEqual(2);

    const bubble = screen.getByTestId("reading-companion-bubble");
    expect(bubble).toHaveAttribute("data-companion-mood", "comforting");
    expect(bubble).toHaveTextContent(firstComfort);
  });

  it("does NOT interrupt when the child quickly self-corrects within the 1.4s breath window", async () => {
    const rec = await startWithFakeClock();
    act(() => rec.say("Bé ghế"));

    // Child notices slip at 700ms and self-corrects "mèo nhỏ"
    await act(async () => vi.advanceTimersByTimeAsync(700));
    act(() => rec.say("mèo nhỏ"));

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    // Teacher did NOT interrupt with wrong-word comfort!
    expect(speechPlayerMock.play).not.toHaveBeenCalled();
    expect(wordEl("Bé")).toHaveClass(SUCCESS);
    expect(wordEl("mèo")).toHaveClass(SUCCESS);
    expect(wordEl("nhỏ")).toHaveClass(SUCCESS);
    expect(screen.getByTestId("reading-companion-bubble")).toHaveAttribute(
      "data-companion-mood",
      "celebrating",
    );
  });

  it("speaks distinct mistake-specific comfort for TONE ('má'<-'ma') vs NEAR_SOUND ('đi'<-'di') mistakes", async () => {
    const tonePage = makePage(["Má", "đi", "chợ"], 16);
    services = createServices(tonePage);
    servicesHook.mockReturnValue(services);

    const rec = await startWithFakeClock();
    // 1. Tone mistake on "Má": child says "ma"
    act(() => rec.say("ma"));
    await act(async () => vi.advanceTimersByTimeAsync(1_600));
    const toneComfort = speechPlayerMock.play.mock.calls.at(-1)?.[0] as string;
    expect(toneComfort).toMatch(/dấu/iu);
    expect(screen.getByTestId("reading-companion-bubble")).toHaveTextContent(
      /dấu thanh/iu,
    );

    // Wait past echo guard -> child fixes "Má" -> now on "đi", child says near-sound "di"
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    speechPlayerMock.play.mockClear();
    act(() => lastRecognition().say("Má"));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    act(() => lastRecognition().say("di"));
    await act(async () => vi.advanceTimersByTimeAsync(1_600));

    const nearSoundComfort = speechPlayerMock.play.mock.calls.at(
      -1,
    )?.[0] as string;
    expect(nearSoundComfort).toMatch(/âm|vần|nét|chữ/iu);
    expect(screen.getByTestId("reading-companion-bubble")).toHaveTextContent(
      /hai âm gần giống/iu,
    );
  });

  it("walks the 2-round empathetic ladder including Round-2 SGK phonics spelling guide & phrase, blocks 100% of teacher echo, and marks exhausted words assisted", async () => {
    const phonicsPage = makePage(["Tê", "ăn", "cỏ."], 17);
    services = createServices(phonicsPage);
    servicesHook.mockReturnValue(services);

    const rec = await startWithFakeClock();

    // Attempt 1 wrong: "bàn" -> Round 1 multi-sentence comfort
    act(() => rec.say("bàn"));
    await act(async () => vi.advanceTimersByTimeAsync(1_600));
    const step1Text = speechPlayerMock.play.mock.calls[0]?.[0] as string;
    expect(step1Text).toContain("Tê");

    // Immediate echo of teacher's comfort sentence (containing "Tê") MUST be 100% blocked by EchoGuard!
    act(() => lastRecognition().say(step1Text));
    expect(wordEl("Tê")).not.toHaveClass(SUCCESS);
    expect(wordEl("Tê")).not.toHaveClass("underline");

    // Attempt 2 wrong after echo guard expires -> Round 2 speaks `generateSpokenPhonicsGuide("Tê")` + 0.75x slow sample + meaningful phrase!
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    speechPlayerMock.play.mockClear();
    act(() => lastRecognition().say("ghế"));
    await act(async () => vi.advanceTimersByTimeAsync(1_600));

    const step2Calls = speechPlayerMock.play.mock.calls;
    expect(
      step2Calls.some(
        ([text]) => typeof text === "string" && text.includes("tờ... ê... tê!"),
      ),
    ).toBe(true);
    expect(step2Calls).toContainEqual(["Tê", { wordSample: true }]);
    expect(step2Calls.map(([t]) => String(t))).toContain("Tê ăn cỏ.");
    expect(screen.getByTestId("reading-companion-bubble")).toHaveAttribute(
      "data-companion-mood",
      "teaching",
    );

    // Immediate echo of teacher's phonics guide ("tờ ê tê") right after playback MUST be blocked!
    act(() => lastRecognition().say("tờ ê tê"));
    expect(wordEl("Tê")).not.toHaveClass("underline");

    // After the phonics model, an incorrect attempt leads to phrase practice. A further real attempt exhausts the retry budget.
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    speechPlayerMock.play.mockClear();
    act(() => lastRecognition().say("bàn"));
    await act(async () => vi.advanceTimersByTimeAsync(1_600));

    expect(speechPlayerMock.play.mock.calls.map(([text]) => text)).toContain(
      "Tê ăn cỏ.",
    );
    expect(wordEl("Tê")).not.toHaveClass(SUCCESS);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    speechPlayerMock.play.mockClear();
    act(() => lastRecognition().say("ghế"));
    await act(async () => vi.advanceTimersByTimeAsync(1_600));

    const moveOnCalls = speechPlayerMock.play.mock.calls.map(([t]) =>
      String(t),
    );
    expect(moveOnCalls.join(" | ")).toMatch(
      /dũng cảm|tự hào|chăm chỉ|ngôi sao|nỗ lực|giỏi lắm|kiên trì/iu,
    );
    expect(wordEl("Tê")).not.toHaveClass(SUCCESS);
    expect(wordEl("Tê")).toHaveClass("underline"); // assisted, never plain green
    // Do not force full-sentence re-read after giving up a hard word
    expect(
      screen.queryByText(/Đọc lại cả câu: “Tê ăn cỏ\.”/),
    ).not.toBeInTheDocument();
  });

  it("accepts 4 low-confidence (0.34) split phonics events 'ê' -> 'tờ' -> 'ê' -> 'tê' on live ReadingScreen without false uncertainty or interruption (G25, G26)", async () => {
    const tePage = makePage(["Tê", "ăn", "cỏ"], 18);
    services = createServices(tePage);
    servicesHook.mockReturnValue(services);

    const rec = await startWithFakeClock();
    // Web Speech API returns confidence 0.34 on isolated vowel/consonant sounds
    act(() => rec.say("ê", 0.34));
    await act(async () => vi.advanceTimersByTimeAsync(1_800));
    expect(speechPlayerMock.play).not.toHaveBeenCalled();

    act(() => rec.say("tờ", 0.36));
    await act(async () => vi.advanceTimersByTimeAsync(1_800));
    expect(speechPlayerMock.play).not.toHaveBeenCalled();

    act(() => rec.say("ê", 0.33));
    await act(async () => vi.advanceTimersByTimeAsync(1_800));
    expect(speechPlayerMock.play).not.toHaveBeenCalled();

    act(() => rec.say("tê", 0.88));
    expect(wordEl("Tê")).toHaveClass(SUCCESS);
    expect(screen.getByTestId("reading-companion-bubble")).toHaveAttribute(
      "data-companion-mood",
      "celebrating",
    );
  });

  it("supports concise coaching mode for fluent readers when selected by parents", async () => {
    setCoachingStyle("concise");
    const rec = await startWithFakeClock();
    act(() => rec.say("Bé ghế"));
    await act(async () => vi.advanceTimersByTimeAsync(1_600));

    expect(speechPlayerMock.play).toHaveBeenCalledTimes(1);
    const concisePrompt = speechPlayerMock.play.mock.calls[0]?.[0] as string;
    expect(
      INTERACTIVE_PROMPT_BANKS.comfortConciseMistake.some(
        (tpl) => concisePrompt === tpl.replaceAll("{word}", "mèo"),
      ),
    ).toBe(true);
  });
});
