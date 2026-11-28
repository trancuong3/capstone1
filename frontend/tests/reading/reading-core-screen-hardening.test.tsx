import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingScreen } from "@/components/reading/reading-screen";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import type { ReadingServices } from "@/hooks/use-reading-services";
import { resetAutomationPreferencesCache } from "@/lib/reading/automation-preferences";
import { EchoGuard } from "@/lib/reading/echo-guard";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  setActiveVoiceSession,
} from "@/lib/reading/session-voice-lock";
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
    listVoices: async () => ({
      voices: [
        {
          voice_id: "local_north_thien_minh",
          label: "Thầy Thiên Minh",
          gender: "male",
        },
        {
          voice_id: "local_north_truc_ly",
          label: "Cô Trúc Ly",
          gender: "female",
        },
      ],
      default_voice_id: "local_north_truc_ly",
    }),
  }),
}));

class MetaRecognition {
  static instances: MetaRecognition[] = [];
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  starts = 0;
  aborts = 0;
  stops = 0;
  autoEndOnStop = true;
  private results: unknown[] = [];
  constructor() {
    MetaRecognition.instances.push(this);
  }
  start() {
    this.starts += 1;
  }
  abort() {
    this.aborts += 1;
  }
  stop() {
    this.stops += 1;
    if (this.autoEndOnStop) {
      this.onend?.();
    }
  }
  emitError(error: string) {
    this.onerror?.({ error });
  }
  sayWithMeta(
    transcript: string,
    meta: Record<string, unknown> = {},
    confidence = 0.95,
  ) {
    this.results.push({
      isFinal: true,
      length: 1,
      0: { transcript, confidence },
      ...meta,
    });
    this.onresult?.({
      resultIndex: this.results.length - 1,
      results: [...this.results],
    });
  }
}

const lastRec = () =>
  MetaRecognition.instances[MetaRecognition.instances.length - 1];

function makePage(words: readonly string[], num = 4): ReadingPageDTO {
  return {
    page_id: `30000000-0000-4000-8000-0000000000${num}`,
    page_revision_id: `40000000-0000-4000-8000-0000000000${num}`,
    page_number: num,
    text: words.join(" "),
    confidence: 0.95,
    width: 600,
    height: 800,
    words: words.map((text, index) => ({
      word_id: `50000000-0000-4000-8000-00000000${num}0${index}`,
      word_index: index,
      text,
      bbox: [0.08 + index * 0.14, 0.2, 0.11, 0.05] as const,
    })),
  };
}

function makeServices(page: ReadingPageDTO): ReadingServices {
  const nextPage = makePage(["Trang", "mới", "rồi."], 15);
  const progress: ReadingSessionPageProgressDTO = {
    session_id: TEST_SESSION_ID,
    persisted: true,
    start_page_id: page.page_id,
    end_page_id: nextPage.page_id,
    current_page_id: page.page_id,
    start_page_number: page.page_number,
    end_page_number: nextPage.page_number,
    current_page_number: page.page_number,
    current_index: 0,
    total_pages: 2,
    completed_pages: 0,
    pages: [page, nextPage].map((p, i) => ({
      page_id: p.page_id,
      page_revision_id: p.page_revision_id,
      page_number: p.page_number,
      page_order: i,
      status: i === 0 ? ("IN_PROGRESS" as const) : ("PENDING" as const),
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
      retryCurrentPage: vi.fn().mockResolvedValue(page),
      selectPage: vi.fn().mockResolvedValue(nextPage),
    },
    readingService: {
      get: vi.fn().mockResolvedValue({
        ...sessionSummaryFixture,
        state: "PAGE_READY",
        ended_at: null,
        duration_ms: null,
      }),
      getCurrentPage: vi.fn().mockResolvedValue(page),
      getPageProgress: vi.fn().mockResolvedValue(progress),
      navigateToPage: vi.fn().mockResolvedValue(progress),
      completeCurrentPage: vi.fn().mockResolvedValue({
        ...progress,
        completed_pages: 1,
      }),
      getCompletionSummary: vi.fn().mockResolvedValue({
        duration_minutes: 2,
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

describe("ReadingScreen fencing, EchoGuard onsetAt, audioQuality, self-correction non-interruption, disambiguation & male persona", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAutomationPreferencesCache();
    resetVoiceLockAndPolicyForTests();
    MetaRecognition.instances.length = 0;
    previousSpeechRecognition = Object.getOwnPropertyDescriptor(
      window,
      "SpeechRecognition",
    );
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: MetaRecognition,
    });
    speechRecorderMock.start.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.prepare.mockReset().mockResolvedValue(undefined);
    speechRecorderMock.stop.mockReset().mockResolvedValue(null);
    speechRecorderMock.cancel.mockReset();
    speechRecorderMock.getStream.mockReset().mockReturnValue(null);
    speechRecorderMock.getIsSpeaking.mockReset().mockReturnValue(false);
    speechRecorderMock.getQuality.mockReset().mockReturnValue(undefined);
    speechPlayerMock.isPlaying = false;
    speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
    speechPlayerMock.playWithWordTimings
      .mockReset()
      .mockResolvedValue(undefined);
    speechPlayerMock.stop.mockReset();
    speechServiceMock.transcribe
      .mockReset()
      .mockResolvedValue({ text: "", words: [] });
    compareTranscriptMock.mockReset().mockResolvedValue({
      session_id: TEST_SESSION_ID,
      page_id: "p",
      page_revision_id: "r",
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

  async function renderAndStart(page: ReadingPageDTO) {
    servicesHook.mockReturnValue(makeServices(page));
    await act(async () => {
      render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );
    });
    const btn = await screen.findByRole("button", {
      name: "Bé đọc với nhận diện giọng nói",
    });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(btn);
    });
    return lastRec();
  }

  it("EchoGuard blocks onset during playback and accepts immediate child repeat after endedAt + onsetGraceMs", () => {
    const guard = new EchoGuard();
    guard.playbackStarted("tts-1", "Bé mèo", 1_000);
    guard.playbackEnded("tts-1", 1_800);

    // Onset inside playback window is rejected even if transcript arrives later
    expect(
      guard.evaluate({ text: "Bé mèo", receivedAt: 2_300, onsetAt: 1_750 }),
    ).toMatchObject({ accept: false, reason: "onset-during-playback" });

    // Onset past endedAt + onsetGraceMs (1800 + 250 = 2050) is accepted immediately
    expect(
      guard.evaluate({ text: "Bé mèo", receivedAt: 2_300, onsetAt: 2_120 }),
    ).toMatchObject({ accept: true, reason: "ok" });

    // Quiz choice verbalization ("Đáp án C: Quả táo" -> worker speaks "Đáp án xê là: Quả táo.")
    // is cleanly blocked by EchoGuard in both onsetAt and fallback tail-overlap (onsetAt=null) modes.
    guard.playbackStarted("quiz-c", "Đáp án C: Quả táo", 3_000);
    guard.playbackEnded("quiz-c", 5_000);
    expect(
      guard.evaluate({
        text: "đáp án c là quả táo",
        receivedAt: 5_600,
        onsetAt: null,
      }),
    ).toMatchObject({ accept: false, reason: "tail-overlap" });
    expect(
      guard.evaluate({
        text: "đáp án c là quả táo",
        receivedAt: 5_600,
        onsetAt: 4_900,
      }),
    ).toMatchObject({ accept: false, reason: "onset-during-playback" });
  });

  it("fences stale sessionId/pageId/epoch results and handles LOW_VOLUME/CLIPPING audioQuality with male Thầy persona (no Cô giáo leak)", async () => {
    lockSessionVoice(TEST_SESSION_ID, {
      voiceId: "local_north_thien_minh",
      forceUpdate: true,
    });
    setActiveVoiceSession(TEST_SESSION_ID);

    const page = makePage(["Bạn", "nhỏ", "vui."], 14);
    const rec = await renderAndStart(page);

    // 1. Stale sessionId/pageId/epoch MUST be ignored without highlighting any word
    act(() => {
      rec.sayWithMeta("Bạn nhỏ", {
        sessionId: "other-session",
        pageId: page.page_id,
      });
      rec.sayWithMeta("Bạn nhỏ", {
        sessionId: TEST_SESSION_ID,
        pageId: "other-page",
      });
      rec.sayWithMeta("Bạn nhỏ", {
        sessionId: TEST_SESSION_ID,
        pageId: page.page_id,
        epoch: 9999,
      });
    });
    expect(screen.getByRole("button", { name: "Bạn" })).not.toHaveClass(
      "bg-success-surface",
    );

    // 2. LOW_VOLUME / CLIPPING from LocalSegmentSpeechRecognition marks UNCERTAIN and shows male Thầy message
    act(() => {
      rec.sayWithMeta("bàn", {
        sessionId: TEST_SESSION_ID,
        pageId: page.page_id,
        segmentId: "q-low",
        audioQuality: {
          status: "LOW_VOLUME",
          rms: 0.001,
          peak: 0.01,
          speechDurationMs: 250,
        },
      });
    });
    expect(
      screen.getByText(/Thầy chưa nghe rõ tiếng vừa rồi/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Cô giáo/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bạn" })).not.toHaveClass(
      "bg-red-200",
    );

    // 3. Valid clear speech advances cleanly
    act(() => {
      rec.sayWithMeta("Bạn", {
        sessionId: TEST_SESSION_ID,
        pageId: page.page_id,
        segmentId: "ok-1",
      });
    });
    expect(screen.getByRole("button", { name: "Bạn" })).toHaveClass(
      "bg-success-surface",
    );
  });

  it("never stops mic or interrupts on quick self-correction ('bàn… bạn') and adapts praise to Thầy", async () => {
    lockSessionVoice(TEST_SESSION_ID, {
      voiceId: "local_north_thien_minh",
      forceUpdate: true,
    });
    setActiveVoiceSession(TEST_SESSION_ID);

    const page = makePage(["Người", "bạn", "tốt."], 16);
    const rec = await renderAndStart(page);

    act(() => rec.sayWithMeta("Người bàn bạn", { segmentId: "sc-1" }));
    await act(async () => vi.advanceTimersByTimeAsync(1_800));

    // Must NOT stop recorder or play full sentence reinforcement prompt
    expect(speechRecorderMock.stop).not.toHaveBeenCalled();
    expect(screen.getByTestId("reading-companion-bubble")).toHaveTextContent(
      /tự sửa/i,
    );
    expect(screen.queryByText(/Cô giáo/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "bạn" })).toHaveClass(
      "bg-success-surface",
    );
  });

  it("asks 1 short clarifying question when 'chữ này con chưa biết' has 2 plausible nearby targets, and stops mic cleanly on 'nghỉ một chút'", async () => {
    const page = makePage(["Mèo", "con", "ngủ."], 19);
    const rec = await renderAndStart(page);

    // Slip "chó" on "Mèo" (SUBSTITUTE), then look-ahead/pending advances or leaves Mèo SUBSTITUTE while cursor reaches "con"
    act(() => rec.sayWithMeta("chó", { segmentId: "m-1" }));
    act(() => rec.sayWithMeta("đá", { segmentId: "m-2" }));
    // At this point "Mèo" is SUBSTITUTE and cursor is on "con"
    act(() =>
      lastRec().sayWithMeta("chữ này con chưa biết", { segmentId: "amb-1" }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(100));

    expect(
      speechPlayerMock.play.mock.calls.some(
        ([txt]) =>
          typeof txt === "string" &&
          /Con hỏi chữ “Mèo” hay chữ “con”\?/i.test(txt),
      ),
    ).toBe(true);
    expect(screen.getByTestId("reading-companion-bubble")).toHaveTextContent(
      /Con hỏi chữ “Mèo” hay chữ “con”\?/i,
    );

    // "nghỉ một chút" cleanly pauses & stops mic with explicit resume CTA
    act(() => lastRec().sayWithMeta("nghỉ một chút", { segmentId: "stop-1" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: "Đọc tiếp" }),
    ).toBeInTheDocument();
    expect(speechRecorderMock.cancel).toHaveBeenCalled();
  });

  it("renders BookPageViewer 3-tier non-color visual markers (interim/confirmed/upcoming)", () => {
    const page = makePage(["Nghiêng", "đầu", "nhìn"], 21);
    const previewEngine = new RealtimeAlignmentEngine(page.words);
    previewEngine.addFinalTranscript("Nghiêng", "p-1");
    const preview = previewEngine.previewAlignment("đầu");
    const { container } = render(
      <BookPageViewer
        page={page}
        currentWordId={page.words[2].word_id}
        correctWordIds={new Set([page.words[0].word_id])}
        previewSnapshot={preview}
      />,
    );

    const tierConfirmed = container.querySelector(
      `[data-word-id="${page.words[0].word_id}"]`,
    );
    const tierInterim = container.querySelector(
      `[data-word-id="${page.words[1].word_id}"]`,
    );
    const tierUpcoming = container.querySelector(
      `[data-word-id="${page.words[2].word_id}"]`,
    );
    expect(tierConfirmed).toHaveAttribute("data-reading-tier", "confirmed");
    expect(tierInterim).toHaveAttribute("data-reading-tier", "interim");
    expect(tierUpcoming).toBeInTheDocument();
  });

  it("P1-3: local-stt-unavailable triggers sttFatalForRec, cleanly aborts mic without restart leak, and resolves stopBrowserRecognition immediately on onend", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      // Case A: Only SpeechRecognition is active (recorderStarted = false).
      speechRecorderMock.start.mockRejectedValueOnce(
        new Error("MediaRecorder is not supported"),
      );
      const page = makePage(["Mèo", "con", "ngủ."], 22);
      const firstRender = render(
        (() => {
          servicesHook.mockReturnValue(makeServices(page));
          return (
            <ReadingScreen
              initialUiState="reading"
              reconnectMode="recover"
              sessionId={TEST_SESSION_ID}
            />
          );
        })(),
      );
      const startBtnA = await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      });
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(startBtnA);
      });
      const recA = lastRec();
      expect(recA.starts).toBe(1);

      act(() => {
        recA.emitError("local-stt-unavailable");
      });
      expect(recA.aborts).toBe(1);

      // onend must NOT schedule any restart timer after sttFatalForRec = true.
      act(() => {
        recA.onend?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(recA.starts).toBe(1);
      expect(screen.getByText("Mình chưa nghe rõ")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Thử nghe lại" }),
      ).toBeInTheDocument();

      firstRender.unmount();
      vi.useRealTimers();

      // Case B: local-stt-unavailable fires while stopBrowserRecognition() is awaiting onend.
      MetaRecognition.instances.length = 0;
      const recB = await renderAndStart(makePage(["Bé", "học", "bài."], 23));
      recB.autoEndOnStop = false;
      speechRecorderMock.stop.mockResolvedValueOnce(null);

      const stopBtn = screen.getByRole("button", {
        name: "Dừng nhận diện giọng nói",
      });
      await act(async () => {
        fireEvent.click(stopBtn);
      });
      // stopBrowserRecognition() called recB.stop() and is now waiting for onend.
      expect(recB.stops).toBe(1);
      expect(speechRecorderMock.stop).not.toHaveBeenCalled();

      // Fatal error arrives while stop is pending: must NOT abort again, and must keep
      // recognitionRef intact so onend resolves stopBrowserRecognition() immediately.
      act(() => {
        recB.emitError("local-stt-unavailable");
      });
      expect(recB.aborts).toBe(0);

      await act(async () => {
        recB.onend?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      // Resolved immediately on onend without advancing fake timers to the 1500ms fallback!
      expect(speechRecorderMock.stop).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(recB.starts).toBe(1);

      // Case C: recorderStarted = true and abort() does NOT emit onend -> recognitionRef must
      // be cleared immediately so clicking Stop never hangs waiting for a dead recognizer's timeout.
      cleanup();
      vi.useRealTimers();
      MetaRecognition.instances.length = 0;
      const pageC = makePage(["Cây", "xanh", "tốt."], 26);
      servicesHook.mockReturnValue(makeServices(pageC));
      const thirdRender = render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );
      const startBtnC = await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      });
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(startBtnC);
      });
      const recC = lastRec();
      recC.autoEndOnStop = false;
      speechRecorderMock.stop.mockReset().mockResolvedValueOnce(null);

      // local-stt-unavailable aborts recC without firing onend; MediaRecorder stays active.
      act(() => {
        recC.emitError("local-stt-unavailable");
      });
      expect(recC.aborts).toBe(1);

      // Clicking Stop now must NOT call stop() on the dead recognizer and must reach
      // speechRecorder.stop() immediately (zero 1500ms timeout hang).
      const stopBtnC = screen.getByRole("button", {
        name: "Dừng nhận diện giọng nói",
      });
      await act(async () => {
        fireEvent.click(stopBtnC);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(recC.stops).toBe(0);
      expect(speechRecorderMock.stop).toHaveBeenCalledTimes(1);
      thirdRender.unmount();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("P1-11: 3 consecutive network errors trip sttFatalForRec with backoff on 1-2, clean abort on 3, and immediate onend resolution", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      // Case A: recorderStarted = false -> 1st (500ms), 2nd (1000ms), 3rd -> fatal abort & no restart.
      speechRecorderMock.start.mockRejectedValueOnce(
        new Error("MediaRecorder is not supported"),
      );
      const page = makePage(["Nắng", "sớm", "đẹp."], 24);
      servicesHook.mockReturnValue(makeServices(page));
      const firstRender = render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );
      const startBtn = await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      });
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(startBtn);
      });
      const recA = lastRec();
      expect(recA.starts).toBe(1);

      // 1st network error -> 500ms backoff before restart
      act(() => {
        recA.emitError("network");
        recA.onend?.();
      });
      expect(recA.aborts).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(450);
      });
      expect(recA.starts).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(recA.starts).toBe(2);

      // 2nd network error -> 1000ms backoff before restart
      act(() => {
        recA.emitError("network");
        recA.onend?.();
      });
      expect(recA.aborts).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(950);
      });
      expect(recA.starts).toBe(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(recA.starts).toBe(3);

      // 3rd network error -> trips sttFatalForRec, aborts cleanly, never restarts
      act(() => {
        recA.emitError("network");
      });
      expect(recA.aborts).toBe(1);
      act(() => {
        recA.onend?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(recA.starts).toBe(3);
      expect(screen.getByText("Mình chưa nghe rõ")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Thử nghe lại" }),
      ).toBeInTheDocument();

      firstRender.unmount();
      vi.useRealTimers();

      // Case B: 3rd network error arrives while stopBrowserRecognition() is awaiting onend.
      MetaRecognition.instances.length = 0;
      const recB = await renderAndStart(makePage(["Gió", "mát", "quá."], 25));
      recB.autoEndOnStop = false;
      speechRecorderMock.stop.mockResolvedValueOnce(null);

      // Push network streak to 2 first.
      act(() => {
        recB.emitError("network");
        recB.onend?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(550);
      });
      act(() => {
        recB.emitError("network");
        recB.onend?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_050);
      });
      expect(recB.starts).toBe(3);

      const stopBtn = screen.getByRole("button", {
        name: "Dừng nhận diện giọng nói",
      });
      await act(async () => {
        fireEvent.click(stopBtn);
      });
      expect(recB.stops).toBe(1);
      expect(speechRecorderMock.stop).not.toHaveBeenCalled();

      act(() => {
        recB.emitError("network");
      });
      expect(recB.aborts).toBe(0);

      await act(async () => {
        recB.onend?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(speechRecorderMock.stop).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(recB.starts).toBe(3);

      // Case C: recorderStarted = true and 3rd network error fires without abort() emitting onend ->
      // clicking Stop immediately proceeds to speechRecorder.stop() without hanging on dead recC.
      cleanup();
      vi.useRealTimers();
      MetaRecognition.instances.length = 0;
      const pageC = makePage(["Hoa", "nở", "đẹp."], 27);
      servicesHook.mockReturnValue(makeServices(pageC));
      const thirdRender = render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );
      const startBtnC = await screen.findByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      });
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(startBtnC);
      });
      const recC = lastRec();
      recC.autoEndOnStop = false;
      speechRecorderMock.stop.mockReset().mockResolvedValueOnce(null);

      act(() => {
        recC.emitError("network");
        recC.onend?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(550);
      });
      act(() => {
        recC.emitError("network");
        recC.onend?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_050);
      });
      act(() => {
        recC.emitError("network");
      });
      expect(recC.aborts).toBe(1);

      const stopBtnC = screen.getByRole("button", {
        name: "Dừng nhận diện giọng nói",
      });
      await act(async () => {
        fireEvent.click(stopBtnC);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(recC.stops).toBe(0);
      expect(speechRecorderMock.stop).toHaveBeenCalledTimes(1);
      thirdRender.unmount();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("P2-5: transcribeRecording reads latest pageRef.current keyterms even inside a stale Page-1 automationRuntime closure after navigating to Page 2", async () => {
    const page1 = makePage(["Mèo", "con", "ngủ."], 11);
    const page2 = makePage(["Cáo", "nhỏ", "chạy."], 12);
    const services = makeServices(page1);
    const progressOnPage2: ReadingSessionPageProgressDTO = {
      session_id: TEST_SESSION_ID,
      persisted: true,
      start_page_id: page1.page_id,
      end_page_id: page2.page_id,
      current_page_id: page2.page_id,
      start_page_number: page1.page_number,
      end_page_number: page2.page_number,
      current_page_number: page2.page_number,
      current_index: 1,
      total_pages: 2,
      completed_pages: 1,
      pages: [page1, page2].map((p, i) => ({
        page_id: p.page_id,
        page_revision_id: p.page_revision_id,
        page_number: p.page_number,
        page_order: i,
        status: i === 0 ? ("COMPLETED" as const) : ("IN_PROGRESS" as const),
        started_at: null,
        completed_at: null,
      })),
    };
    const initialProgress: ReadingSessionPageProgressDTO = {
      ...progressOnPage2,
      current_page_id: page1.page_id,
      current_page_number: page1.page_number,
      current_index: 0,
      completed_pages: 0,
      pages: [page1, page2].map((p, i) => ({
        page_id: p.page_id,
        page_revision_id: p.page_revision_id,
        page_number: p.page_number,
        page_order: i,
        status: i === 0 ? ("IN_PROGRESS" as const) : ("PENDING" as const),
        started_at: null,
        completed_at: null,
      })),
    };
    (
      services.readingService.getPageProgress as ReturnType<typeof vi.fn>
    ).mockResolvedValue(initialProgress);
    (
      services.readingService.navigateToPage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(progressOnPage2);
    (services.readingService.getCurrentPage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    (
      services.pageMatchService.selectPage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(page2);

    servicesHook.mockReturnValue(services);
    await act(async () => {
      render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );
    });
    expect(
      await screen.findByRole("button", { name: "Mèo" }),
    ).toBeInTheDocument();

    // Use fake timers BEFORE starting Page 1 so ReadingAutomationRuntime's clock uses
    // fake timers and captures Render #1's closure (`page === page1`).
    vi.useFakeTimers();

    // 1. Start and stop on Page 1 -> creates automationRuntimeRef.current with Page 1 in closure.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
      );
    });
    speechRecorderMock.stop.mockResolvedValueOnce(
      new Blob(["fake-webm-p1"], { type: "audio/webm" }),
    );
    speechServiceMock.transcribe.mockResolvedValueOnce({
      text: "Mèo con",
      words: [],
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
      );
    });
    expect(speechServiceMock.transcribe).toHaveBeenCalledTimes(1);
    expect(
      (
        speechServiceMock.transcribe.mock.calls[0] as [
          Blob,
          { languageCode?: string; keyterms?: string[] },
        ]
      )[1].keyterms,
    ).toEqual(["Mèo", "con", "ngủ."]);

    // 2. Navigate to Page 2 -> updates pageRef.current to Page 2, while automationRuntimeRef.current
    // STILL holds Render #1's stale closure where `page` is Page 1!
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Trang tiếp theo" }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Cáo" })).toBeInTheDocument();

    // 3. Start listening on Page 2, stay silent past hesitation threshold so the STALE Page-1
    // automationRuntime playModel callback triggers playAssistantAudio -> stopListeningAndTranscribe ->
    // finishListening -> transcribeRecording(). Only reading `pageRef.current` yields Page 2 keyterms!
    speechRecorderMock.stop.mockResolvedValueOnce(
      new Blob(["fake-webm-p2-stale-closure"], { type: "audio/webm" }),
    );
    speechServiceMock.transcribe.mockResolvedValueOnce({
      text: "Cáo nhỏ",
      words: [],
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(speechServiceMock.transcribe).toHaveBeenCalledTimes(2);
    const [, transcribeOpts] = speechServiceMock.transcribe.mock.calls[1] as [
      Blob,
      { languageCode?: string; keyterms?: string[] },
    ];
    expect(transcribeOpts.languageCode).toBe("vi");
    expect(transcribeOpts.keyterms).toEqual(["Cáo", "nhỏ", "chạy."]);
  });
});
