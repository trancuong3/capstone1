import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadingScreen } from "@/components/reading/reading-screen";
import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import type { ReadingServices } from "@/hooks/use-reading-services";
import type { AudioQualitySnapshot } from "@/lib/reading/audio-quality";
import type { SupportedPhonicsLessonPlan } from "@/lib/reading/phonics-lesson";
import { resetAutomationPreferencesCache } from "@/lib/reading/automation-preferences";
import {
  countUnintendedVoiceSwitches,
  getSessionVoiceAudit,
  lockSessionVoice,
  recordSessionUtteranceVoice,
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import {
  bookFixture,
  childFixture,
  sessionSummaryFixture,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type {
  ReadingPageDTO,
  ReadingSessionPageProgressDTO,
} from "@/types/reading";
import type {
  DifficultWordDTO,
  DifficultWordPracticeAttemptDTO,
} from "@/types/reports";

const {
  servicesHook,
  speechRecorderMock,
  speechPlayerMock,
  speechServiceMock,
  compareTranscriptMock,
  evaluatePracticeWordMock,
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
  compareTranscriptMock: vi.fn(),
  evaluatePracticeWordMock: vi.fn(),
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
      voices: [],
      default_voice_id: "local_north_truc_ly",
    }),
  }),
}));
vi.mock("@/hooks/use-report-services", () => ({
  useReportServices: () => ({
    difficultWordService: {
      getPracticeHistory: vi.fn(async () => ({
        storage_ready: true,
        items: [],
      })),
      evaluatePracticeWord: evaluatePracticeWordMock,
    },
  }),
}));

class MockRecognition {
  static instances: MockRecognition[] = [];
  lang = "vi-VN";
  continuous = true;
  interimResults = true;
  maxAlternatives = 1;
  onend: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  private results: {
    isFinal: boolean;
    length: number;
    0: { transcript: string; confidence: number };
  }[] = [];

  constructor() {
    MockRecognition.instances.push(this);
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
  MockRecognition.instances[MockRecognition.instances.length - 1];

function makePage(words: readonly string[], pageNum = 21): ReadingPageDTO {
  return {
    page_id: `30000000-0000-4000-8000-0000000000${pageNum}`,
    page_revision_id: `40000000-0000-4000-8000-0000000000${pageNum}`,
    page_number: pageNum,
    text: words.join(" "),
    confidence: 0.96,
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

function createReadingServices(activePage: ReadingPageDTO): ReadingServices {
  const secondPage = makePage(["Con", "ong", "chăm"], 22);
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
    pages: [activePage, secondPage].map((page, order) => ({
      page_id: page.page_id,
      page_revision_id: page.page_revision_id,
      page_number: page.page_number,
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

function makeWordDto(text: string): DifficultWordDTO {
  return {
    normalized_word: text.toLowerCase(),
    display_text: text,
    difficulty_score: 4,
    omission_count: 0,
    repetition_count: 0,
    long_pause_count: 1,
    read_example_count: 0,
    session_count: 1,
    mispronunciation_count: 1,
    last_seen_at: "2026-11-22T00:00:00Z",
    practice_status: "NOT_PRACTICED",
    evidence_word_ids: ["33333333-3333-4333-8333-333333333333"],
  };
}

function makeAttemptDto(
  wordText: string,
  status: DifficultWordPracticeAttemptDTO["assessment_status"],
  transcript: string | null,
): DifficultWordPracticeAttemptDTO {
  return {
    attempt_id: "44444444-4444-4444-8444-444444444444",
    child_id: TEST_CHILD_ID,
    normalized_word: wordText.toLowerCase(),
    display_text: wordText,
    attempt_number: 1,
    state: "COMPLETED",
    assessment_status: status,
    recognition_source: "SERVER_STT",
    spoken_transcript: transcript,
    confidence: null,
    audio_duration_ms: 680,
    assessment_version: 1,
    evidence_word_ids: ["33333333-3333-4333-8333-333333333333"],
    evidence_count_unchanged: true,
    started_at: "2026-11-22T00:00:00Z",
    completed_at: "2026-11-22T00:00:01Z",
    feedback_message:
      status === "CORRECT"
        ? "Con đọc đúng rồi!"
        : "Con nghe lại rồi đọc theo nhé!",
    next_recommended_word: null,
    word_progress: {
      normalized_word: wordText.toLowerCase(),
      practice_status:
        status === "CORRECT" ? "IN_PROGRESS" : "NEEDS_MORE_PRACTICE",
      practice_attempts_count: 1,
      practice_correct_count: status === "CORRECT" ? 1 : 0,
      practice_incorrect_count: status === "INCORRECT" ? 1 : 0,
      practice_uncertain_count: 0,
      consecutive_correct_count: status === "CORRECT" ? 1 : 0,
      required_consecutive_correct: 2,
      last_practiced_at: "2026-11-22T00:00:01Z",
      last_practice_status: status,
    },
  };
}

let previousSpeechRecognition: PropertyDescriptor | undefined;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetAutomationPreferencesCache();
  resetSpeechPreferencesCache();
  resetVoiceLockAndPolicyForTests();

  previousSpeechRecognition = Object.getOwnPropertyDescriptor(
    window,
    "SpeechRecognition",
  );
  MockRecognition.instances.length = 0;
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: MockRecognition,
  });

  speechPlayerMock.isPlaying = false;
  speechPlayerMock.play.mockReset().mockResolvedValue(undefined);
  speechPlayerMock.playWithWordTimings.mockReset().mockResolvedValue(undefined);
  speechPlayerMock.playPhonicsLesson
    .mockReset()
    .mockImplementation(async (lesson, opts) => {
      for (const step of lesson.steps) {
        opts?.onStepChange?.(step.index);
      }
    });
  speechPlayerMock.stop.mockReset();

  speechRecorderMock.prepare.mockReset().mockResolvedValue(undefined);
  speechRecorderMock.start.mockReset().mockResolvedValue(undefined);
  speechRecorderMock.stop
    .mockReset()
    .mockResolvedValue(new Blob(["wav-bytes"], { type: "audio/webm" }));
  speechRecorderMock.cancel.mockReset();
  speechRecorderMock.getStream.mockReset().mockReturnValue(null);
  speechRecorderMock.getIsSpeaking.mockReset().mockReturnValue(false);
  speechRecorderMock.getQuality.mockReset().mockReturnValue({
    status: "SPEECH_DETECTED",
    durationMs: 700,
    speechDurationMs: 210,
    silenceDurationMs: 420,
    rms: 0.025,
    peak: 0.08,
    noiseFloor: 0.001,
    clipped: false,
    isSpeaking: false,
  });

  evaluatePracticeWordMock.mockReset();
  compareTranscriptMock.mockReset().mockResolvedValue({
    session_id: TEST_SESSION_ID,
    page_id: "30000000-0000-4000-8000-000000000021",
    page_revision_id: "40000000-0000-4000-8000-000000000021",
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

describe("SessionVoiceLock ('Một buổi, một giọng') & provider policy enforcement", () => {
  it("locks one consistent regional voice across all 9 session utterance kinds with 0 unintended switches", () => {
    setVoicePolicyPreferences({
      region: "central",
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });
    setSpeechPreferences({
      voiceId: "local_central_ngoc_tran",
      speed: 0.85,
    });

    const lock = lockSessionVoice(TEST_SESSION_ID);
    expect(lock).toMatchObject({
      sessionId: TEST_SESSION_ID,
      provider: "local",
      voiceId: "local_central_ngoc_tran",
      region: "central",
      modelVersion: "vieneu-v3-turbo-onnx-fp32-3.8.5",
      speed: 0.85,
    });

    // Even if global preferences change mid-session while child is reading, lock stays immutable unless forceUpdate is set
    setSpeechPreferences({ voiceId: "local_south_thuc_doan", speed: 1.15 });
    const relocked = lockSessionVoice(TEST_SESSION_ID);
    expect(relocked.voiceId).toBe("local_central_ngoc_tran");
    expect(relocked.region).toBe("central");
    expect(relocked.speed).toBe(0.85);

    const utteranceKinds = [
      "greeting",
      "instruction",
      "retry_prompt",
      "word_sample",
      "phonics",
      "phrase_sample",
      "praise",
      "pause_reminder",
      "completion",
    ] as const;

    for (const kind of utteranceKinds) {
      recordSessionUtteranceVoice(
        {
          kind,
          provider: relocked.provider,
          voiceId: relocked.voiceId,
          region: relocked.region,
          modelVersion: relocked.modelVersion,
          speed: relocked.speed,
          textPreview: `Mẫu câu ${kind}`,
        },
        TEST_SESSION_ID,
      );
    }

    expect(getSessionVoiceAudit(TEST_SESSION_ID)).toHaveLength(9);
    expect(countUnintendedVoiceSwitches(TEST_SESSION_ID)).toBe(0);
  });

  it("refuses to lock a Google voice when Google TTS fallback is disabled", () => {
    setVoicePolicyPreferences({
      region: "south",
      providerMode: "local_only",
      allowGoogleTtsFallback: false,
    });
    setSpeechPreferences({ voiceId: "google_vi_vn_wavenet_c" });

    const lock = lockSessionVoice("sess-local-enforced");
    expect(lock.provider).toBe("local");
    expect(lock.voiceId).toBe("local_south_thuc_doan");
    expect(lock.region).toBe("south");
  });
});

describe("ReadingScreen in-place step-by-step phonics ('mốt' & unsupported words)", () => {
  it("guides 'mốt' step-by-step in-place on voice command 'Đánh vần giúp con', rejects intermediate 'ô tờ ốt', and preserves first-pass assessment", async () => {
    const motPage = makePage(["Hai", "mươi", "mốt", "bông"], 21);
    servicesHook.mockReturnValue(createReadingServices(motPage));

    await act(async () => {
      render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );
    });

    const startBtn = await screen.findByRole("button", {
      name: "Bé đọc với nhận diện giọng nói",
    });
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    await act(async () => fireEvent.click(startBtn));

    const rec = lastRecognition();
    // Child reads "Hai mươi" fluently -> active word is now "mốt"
    act(() => rec.say("Hai mươi"));
    expect(screen.getByRole("button", { name: "Hai" })).toHaveClass(
      "bg-success-surface",
    );
    expect(screen.getByRole("button", { name: "mươi" })).toHaveClass(
      "bg-success-surface",
    );

    // Child asks "Đánh vần giúp con" on "mốt"
    await act(async () => {
      lastRecognition().say("Đánh vần giúp con");
      await vi.advanceTimersByTimeAsync(200);
    });

    // Renders PhonicsLessonCard right in-place without leaving the reading page!
    expect(screen.getByTestId("phonics-lesson-card")).toBeInTheDocument();
    expect(speechPlayerMock.playPhonicsLesson).toHaveBeenCalledTimes(1);
    const playedPlan = speechPlayerMock.playPhonicsLesson.mock.calls[0]![0];
    expect(playedPlan.focusSyllable).toBe("mốt");
    expect(playedPlan.steps.map((s) => s.spokenText)).toEqual([
      "ô, tờ, ốt.",
      "mờ, ốt.",
      "sắc, mốt.",
      "mốt.",
    ]);

    // Advance past EchoGuard cooldown
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    // Repeating only intermediate rhyme "ô tờ ốt" MUST NOT complete "mốt"!
    act(() => lastRecognition().say("ô tờ ốt"));
    const motEl = screen.getByRole("button", { name: "mốt" });
    expect(motEl).not.toHaveClass("bg-success-surface");
    expect(motEl).not.toHaveClass("underline");

    // Now child pronounces the full toned syllable "mốt" -> advances as practiced/assisted (underlined, never plain first-pass green!)
    act(() => lastRecognition().say("mốt"));
    expect(motEl).not.toHaveClass("bg-success-surface");
    expect(motEl).toHaveClass("underline");
  });

  it("shows 'Chưa có mẫu đánh vần' for unsupported token 'pizza' without guessing phonics", async () => {
    const pizzaPage = makePage(["pizza", "ngon"], 23);
    servicesHook.mockReturnValue(createReadingServices(pizzaPage));

    await act(async () => {
      render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );
    });

    const spellBtn = await screen.findByRole("button", {
      name: /Nghe đánh vần/i,
    });
    await act(async () => fireEvent.click(spellBtn));

    expect(
      await screen.findByTestId("phonics-lesson-unsupported"),
    ).toHaveTextContent("Chưa có mẫu đánh vần");
    expect(speechPlayerMock.playPhonicsLesson).not.toHaveBeenCalled();
  });
});

describe("DifficultWordPracticePanel phonics, voice commands & 4 mastery outcomes", () => {
  it("supports Nghe đánh vần & voice commands ('Đánh vần giúp con', 'Đọc lại'), rejects intermediate 'ô tờ ốt', and labels 'Đọc đúng sau đánh vần'", async () => {
    const motWord = makeWordDto("mốt");
    evaluatePracticeWordMock.mockResolvedValueOnce(
      makeAttemptDto("mốt", "CORRECT", "mốt"),
    );

    const user = userEvent.setup();
    render(
      <DifficultWordPracticePanel
        child={childFixture}
        contextPhrase="hai mươi mốt"
        onClose={vi.fn()}
        onProgressSaved={vi.fn(async () => {})}
        onSelectWord={vi.fn()}
        word={motWord}
        words={[motWord]}
      />,
    );

    // PhonicsLessonCard is rendered with Nghe từ, Nghe đánh vần, Đọc lại
    expect(screen.getByTestId("phonics-lesson-card")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Nghe từ/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Nghe đánh vần/ }),
    ).toBeInTheDocument();

    // Start practice -> mic opens
    await user.click(screen.getByRole("button", { name: /Bắt đầu luyện/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(1),
    );

    // 1. Child says "Đọc lại" -> replays word sample and re-opens mic WITHOUT consuming an evaluation attempt
    act(() => lastRecognition().say("Đọc lại"));
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(2),
    );
    expect(evaluatePracticeWordMock).not.toHaveBeenCalled();
    expect(speechPlayerMock.play).toHaveBeenCalledWith(
      "mốt",
      expect.objectContaining({
        wordSample: true,
        cacheScope: expect.stringMatching(/^(CATALOG|PRIVATE)$/),
      }),
    );

    // 2. Child says "Đánh vần giúp con" -> runs step-by-step phonics including context "hai mươi mốt." and re-opens mic
    act(() => lastRecognition().say("Đánh vần giúp con"));
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
    );
    expect(speechPlayerMock.playPhonicsLesson).toHaveBeenCalledTimes(1);
    const contextPlan = speechPlayerMock.playPhonicsLesson.mock.calls[0]![0];
    expect(contextPlan.steps.map((s) => s.spokenText)).toEqual([
      "ô, tờ, ốt.",
      "mờ, ốt.",
      "sắc, mốt.",
      "mốt.",
      "hai mươi mốt.",
    ]);

    // 3. Child repeats intermediate cues "ô tờ ốt" -> SPELLING_STEP_ONLY coaching, NOT submitted as "mốt"!
    act(() => lastRecognition().say("ô tờ ốt"));
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(4),
    );
    expect(evaluatePracticeWordMock).not.toHaveBeenCalled();

    // 4. Child now says "mốt" -> evaluated as CORRECT and tagged "Đọc đúng sau đánh vần" (NOT "Đọc đúng ngay lần đầu"!)
    act(() => lastRecognition().say("mốt"));
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    expect(await screen.findByTestId("word-mastery-outcome")).toHaveTextContent(
      "Đọc đúng sau đánh vần",
    );
  }, 15_000);

  it("distinguishes 'Đọc đúng ngay lần đầu', 'Đọc đúng sau gợi ý', 'Cần luyện lại', and 'Chưa có mẫu đánh vần' ('pizza')", async () => {
    const motWord = makeWordDto("mốt");
    const user = userEvent.setup();

    // Case A: First-pass correct ("Đọc đúng ngay lần đầu")
    evaluatePracticeWordMock.mockResolvedValueOnce(
      makeAttemptDto("mốt", "CORRECT", "mốt"),
    );
    const { unmount: unmountA } = render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={vi.fn()}
        onProgressSaved={vi.fn(async () => {})}
        onSelectWord={vi.fn()}
        word={motWord}
        words={[motWord]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu luyện/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(1),
    );
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    expect(await screen.findByTestId("word-mastery-outcome")).toHaveTextContent(
      "Đọc đúng ngay lần đầu",
    );
    unmountA();

    // Case B: Incorrect once -> Correct ("Đọc đúng sau gợi ý")
    speechRecorderMock.start.mockClear();
    evaluatePracticeWordMock
      .mockResolvedValueOnce(makeAttemptDto("mốt", "INCORRECT", "một"))
      .mockResolvedValueOnce(makeAttemptDto("mốt", "CORRECT", "mốt"));
    const { unmount: unmountB } = render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={vi.fn()}
        onProgressSaved={vi.fn(async () => {})}
        onSelectWord={vi.fn()}
        word={motWord}
        words={[motWord]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu luyện/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(1),
    );
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(2),
    );
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    expect(await screen.findByTestId("word-mastery-outcome")).toHaveTextContent(
      "Đọc đúng sau gợi ý",
    );
    unmountB();

    // Case C: 3 wrong attempts -> "Cần luyện lại"
    speechRecorderMock.start.mockClear();
    evaluatePracticeWordMock
      .mockResolvedValueOnce(makeAttemptDto("mốt", "INCORRECT", "một"))
      .mockResolvedValueOnce(makeAttemptDto("mốt", "INCORRECT", "mót"))
      .mockResolvedValueOnce(makeAttemptDto("mốt", "INCORRECT", "một"));
    const { unmount: unmountC } = render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={vi.fn()}
        onProgressSaved={vi.fn(async () => {})}
        onSelectWord={vi.fn()}
        word={motWord}
        words={[motWord]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu luyện/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(1),
    );
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(2),
    );
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    await waitFor(() =>
      expect(speechRecorderMock.start).toHaveBeenCalledTimes(3),
    );
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/ }));
    expect(await screen.findByTestId("word-mastery-outcome")).toHaveTextContent(
      "Cần luyện lại",
    );
    unmountC();

    // Case D: Unsupported loanword "pizza" -> shows "Chưa có mẫu đánh vần" while preserving "Nghe từ"
    const pizzaWord = makeWordDto("pizza");
    render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={vi.fn()}
        onProgressSaved={vi.fn(async () => {})}
        onSelectWord={vi.fn()}
        word={pizzaWord}
        words={[pizzaWord]}
      />,
    );
    expect(screen.getByTestId("phonics-lesson-unsupported")).toHaveTextContent(
      "Chưa có mẫu đánh vần",
    );
    expect(screen.getByRole("button", { name: /Nghe từ/ })).toBeInTheDocument();
  }, 20_000);
});
