import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
import { ReadingCompanionBubble } from "@/components/reading/reading-companion-bubble";
import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import type { ReadingServices } from "@/hooks/use-reading-services";
import type { AudioQualitySnapshot } from "@/lib/reading/audio-quality";
import { InteractivePromptSelector } from "@/lib/reading/interactive-prompts";
import { generateSpokenPhonicsGuide } from "@/lib/reading/phonics-spelling";
import {
  getActiveSessionVoiceLock,
  getEffectiveTeacherPersona,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
} from "@/lib/reading/session-voice-lock";
import {
  getSpeechPreferences,
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import { resetVoicePreloaderForTests } from "@/lib/reading/voice-preloader";
import {
  childFixture,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import type { ComprehensionQuestionViewModelUI } from "@/types/reading";
import type {
  DifficultWordDTO,
  DifficultWordPracticeAttemptDTO,
} from "@/types/reports";

const NAM_MIEN_TRUNG_VOICE_ID = "local_central_quang_son";
const NAM_MIEN_TRUNG_SPEED = 0.85;

interface RecordedPlayCall {
  readonly text: string;
  readonly options?: Record<string, unknown>;
  readonly lockedVoiceId: string | null;
  readonly lockedSpeed: number | null;
  readonly prefVoiceId: string | null;
  readonly prefSpeed: number;
}

const {
  playCalls,
  speechPlayerMock,
  readingServicesHook,
  recorderMock,
  evaluatePracticeWordMock,
  navigationMock,
} = vi.hoisted(() => {
  const calls: RecordedPlayCall[] = [];
  return {
    playCalls: calls,
    speechPlayerMock: {
      isPlaying: false,
      isPaused: false,
      state: "idle" as const,
      fallbackNotice: null,
      play: vi.fn<
        (text: string, options?: Record<string, unknown>) => Promise<void>
      >(),
      prefetch: vi.fn(async () => undefined),
      playPhonicsLesson: vi.fn(async () => undefined),
      playWithWordTimings: vi.fn(async () => undefined),
      setCacheContext: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(async () => undefined),
      stop: vi.fn(),
    },
    readingServicesHook: vi.fn<() => ReadingServices>(),
    recorderMock: {
      isRecording: false,
      isSpeaking: false,
      audioLevel: 0,
      prepare: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => new Blob(["wav-bytes"], { type: "audio/webm" })),
      cancel: vi.fn(),
      getStream: vi.fn(() => null),
      getIsSpeaking: vi.fn(() => false),
      getQuality: vi.fn<() => AudioQualitySnapshot>(),
      getSettings: vi.fn(() => ({})),
    },
    evaluatePracticeWordMock: vi.fn(),
    navigationMock: { replace: vi.fn(), push: vi.fn() },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => navigationMock,
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));
vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => speechPlayerMock,
}));
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => recorderMock,
}));
vi.mock("@/hooks/use-reading-services", () => ({
  useReadingServices: readingServicesHook,
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

class FakeQuizRecognition {
  static instances: FakeQuizRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  private results: Array<{
    isFinal: boolean;
    length: number;
    0: { transcript: string; confidence: number };
  }> = [];

  constructor() {
    FakeQuizRecognition.instances.push(this);
  }
  start() {}
  stop() {
    this.onend?.();
  }
  abort() {}
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

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetSpeechPreferencesCache();
  resetVoiceLockAndPolicyForTests();
  resetVoicePreloaderForTests();
  playCalls.length = 0;
  FakeQuizRecognition.instances.length = 0;

  setSpeechPreferences({
    voiceId: NAM_MIEN_TRUNG_VOICE_ID,
    speed: NAM_MIEN_TRUNG_SPEED,
  });

  speechPlayerMock.play
    .mockReset()
    .mockImplementation(async (text, options) => {
      const lock = getActiveSessionVoiceLock();
      const prefs = getSpeechPreferences();
      playCalls.push({
        text,
        options,
        lockedVoiceId: lock?.voiceId ?? null,
        lockedSpeed: lock?.speed ?? null,
        prefVoiceId: prefs.voiceId,
        prefSpeed: prefs.speed,
      });
    });
  speechPlayerMock.playPhonicsLesson.mockReset().mockResolvedValue(undefined);
  speechPlayerMock.prefetch.mockReset().mockResolvedValue(undefined);
  speechPlayerMock.stop.mockReset();
  recorderMock.prepare.mockReset().mockResolvedValue(undefined);
  recorderMock.start.mockReset().mockResolvedValue(undefined);
  recorderMock.stop
    .mockReset()
    .mockResolvedValue(new Blob(["wav-bytes"], { type: "audio/webm" }));
  recorderMock.cancel.mockReset();
  recorderMock.getQuality.mockReset().mockReturnValue({
    status: "SPEECH_DETECTED",
    durationMs: 700,
    speechDurationMs: 200,
    silenceDurationMs: 400,
    rms: 0.025,
    peak: 0.08,
    noiseFloor: 0.001,
    clipped: false,
    isSpeaking: false,
  });
  evaluatePracticeWordMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetVoiceLockAndPolicyForTests();
  resetSpeechPreferencesCache();
  resetVoicePreloaderForTests();
});

describe("Nam Miền Trung (Thầy Quang Sơn, 0.85x) full-flow voice, speed & persona sync", () => {
  it("keeps Thầy persona + 0.85x + exact voiceId across prompts, phonics, and companion bubble WITHOUT corrupting book word 'cô'", () => {
    const lock = lockSessionVoice("session-nam-trung-1");
    expect(lock.voiceId).toBe(NAM_MIEN_TRUNG_VOICE_ID);
    expect(lock.speed).toBe(NAM_MIEN_TRUNG_SPEED);
    expect(lock.gender).toBe("male");
    expect(lock.region).toBe("central");
    expect(getEffectiveTeacherPersona().title).toBe("Thầy giáo AI");

    // 1. InteractivePromptSelector adapts framing ("cô" -> "thầy") BEFORE interpolating {word} = "cô"
    const selector = new InteractivePromptSelector();
    const collectedPrompts = Array.from({ length: 10 }, () =>
      selector.next("comfortGeneralMistake", { word: "cô" }),
    );
    for (const prompt of collectedPrompts) {
      expect(prompt).toContain("“cô”");
      expect(prompt).not.toContain("“thầy”");
    }
    expect(collectedPrompts.some((p) => /Thầy|thầy/u.test(p))).toBe(true);

    // 2. Spoken phonics guide for the book word "cô" under male voice must NEVER spell "thầy"!
    const phonicsCo = generateSpokenPhonicsGuide("cô", "male");
    expect(phonicsCo).toContain("cùng thầy");
    expect(phonicsCo).toContain("cờ... ô... cô!");
    expect(phonicsCo).toContain("Đọc trơn là: cô.");
    expect(phonicsCo).not.toContain("Đọc trơn là: thầy");
    expect(phonicsCo).not.toContain("cờ... ô... thầy");

    // 3. ReadingCompanionBubble adapts framing while preserving quoted book word “cô”
    render(
      <ReadingCompanionBubble
        state={{
          mood: "comforting",
          title: "Cô giáo dịu dàng",
          message: "Có cô ở đây, con nhìn lại chữ “cô” nhé!",
        }}
      />,
    );
    const bubble = screen.getByTestId("reading-companion-bubble");
    expect(bubble.getAttribute("data-teacher-persona")).toBe("male");
    expect(bubble.textContent).toContain("Thầy giáo AI");
    expect(bubble.textContent).toContain("Có thầy ở đây");
    expect(bubble.textContent).toContain("“cô”");
    expect(bubble.textContent).not.toContain("“thầy”");

    // 4. Locking same session without forceUpdate never drifts; explicit preference change + forceUpdate switches cleanly
    setSpeechPreferences({ voiceId: "local_north_truc_ly", speed: 1.15 });
    const unchanged = lockSessionVoice("session-nam-trung-1");
    expect(unchanged.voiceId).toBe(NAM_MIEN_TRUNG_VOICE_ID);
    expect(unchanged.speed).toBe(NAM_MIEN_TRUNG_SPEED);

    const switched = lockSessionVoice("session-nam-trung-1", {
      forceUpdate: true,
    });
    expect(switched.voiceId).toBe("local_north_truc_ly");
    expect(switched.speed).toBe(1.15);
    expect(switched.gender).toBe("female");
    expect(getEffectiveTeacherPersona().title).toBe("Cô giáo AI");
  });

  it("syncs Nam Miền Trung @ 0.85x in ComprehensionQuestion and NEVER rewrites 'Cô Tấm' in choice label or story_hint", async () => {
    vi.stubGlobal("SpeechRecognition", FakeQuizRecognition);
    let now = 2_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const question: ComprehensionQuestionViewModelUI = {
      question: {
        id: "80000000-0000-4000-8000-000000000099",
        type: "FACTUAL",
        prompt: "Ai đánh rơi chiếc hài bên bờ suối?",
        page_revision_id: "70000000-0000-4000-8000-000000000001",
        source_span: {
          start_word_index: 0,
          end_word_index_exclusive: 3,
          sentence_index: null,
        },
        difficulty: 1,
        answered: false,
      },
      progress_label: "Câu 1/1",
      choices: [
        { id: "A", label: "Cô Tấm", value: "Cô Tấm" },
        { id: "B", label: "Cô Cám", value: "Cô Cám" },
      ],
      position: 1,
      total: 1,
    };

    const submitAnswer = vi.fn().mockResolvedValue({
      answer_id: "ans-1",
      question_id: question.question.id,
      submitted_answer: "Cô Cám",
      is_correct: false,
      score: 0,
      feedback_code: "TRY_AGAIN",
      story_hint: "Trong truyện, Cô Tấm mới là người đánh rơi chiếc hài nhé!",
    });

    readingServicesHook.mockReturnValue({
      comprehensionService: {
        getQuestion: vi.fn().mockResolvedValue(question),
        submitAnswer,
      },
    } as unknown as ReadingServices);

    render(
      <ComprehensionQuestion
        child={childFixture}
        onComplete={vi.fn()}
        sessionId={TEST_SESSION_ID}
      />,
    );

    await waitFor(() => expect(FakeQuizRecognition.instances).toHaveLength(1));
    expect(playCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of playCalls) {
      expect(call.lockedVoiceId).toBe(NAM_MIEN_TRUNG_VOICE_ID);
      expect(call.lockedSpeed).toBe(NAM_MIEN_TRUNG_SPEED);
    }
    expect(playCalls.map((c) => c.text)).toContain("Đáp án A: Cô Tấm");
    expect(playCalls.map((c) => c.text)).toContain("Đáp án B: Cô Cám");

    // Voice wrong answer "Cô Cám" -> story_hint and label MUST preserve "Cô Cám" & "Cô Tấm" verbatim
    playCalls.length = 0;
    now += 2_000;
    act(() => FakeQuizRecognition.instances[0]!.say("Cô Cám"));

    await waitFor(() => expect(submitAnswer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(playCalls.length).toBeGreaterThanOrEqual(1));
    const spokenHint = playCalls[0]!.text;
    expect(spokenHint).toContain("Cô Cám");
    expect(spokenHint).toContain("Cô Tấm");
    expect(spokenHint).not.toContain("Thầy Tấm");
    expect(spokenHint).not.toContain("Thầy Cám");
    expect(screen.getByText(/Cô Tấm mới là người/)).toBeInTheDocument();
    expect(screen.queryByText(/Thầy Tấm/)).not.toBeInTheDocument();

    // Click wrong answer -> StatusMessage must ALSO keep "Cô Tấm" verbatim
    fireEvent.click(screen.getByRole("button", { name: /Cô Cám/ }));
    await waitFor(() => expect(submitAnswer).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Cô Tấm mới là người/)).toBeInTheDocument();
    expect(screen.queryByText(/Thầy Tấm/)).not.toBeInTheDocument();
  });

  it("syncs Nam Miền Trung @ 0.85x in DifficultWordPracticePanel, adapts feedback to Thầy, and keeps target word 'cô' verbatim", async () => {
    const wordCo: DifficultWordDTO = {
      normalized_word: "cô",
      display_text: "cô",
      difficulty_score: 4,
      omission_count: 0,
      repetition_count: 0,
      long_pause_count: 0,
      read_example_count: 0,
      session_count: 1,
      mispronunciation_count: 1,
      last_seen_at: "2026-11-27T00:00:00Z",
      practice_status: "NOT_PRACTICED",
      evidence_word_ids: ["33333333-3333-4333-8333-333333333333"],
      sources: [
        {
          book_id: "11111111-1111-4111-8111-111111111111",
          visibility_scope: "PUBLIC_CATALOG",
          context_phrase: "cô bé ngoan",
          last_seen_at: "2026-11-27T00:00:00Z",
        },
      ],
    };

    const correctAttempt: DifficultWordPracticeAttemptDTO = {
      attempt_id: "44444444-4444-4444-8444-444444444444",
      child_id: TEST_CHILD_ID,
      normalized_word: "cô",
      display_text: "cô",
      attempt_number: 1,
      state: "COMPLETED",
      assessment_status: "CORRECT",
      recognition_source: "SERVER_STT",
      spoken_transcript: "cô",
      confidence: 0.96,
      audio_duration_ms: 600,
      assessment_version: 1,
      evidence_word_ids: ["33333333-3333-4333-8333-333333333333"],
      evidence_count_unchanged: true,
      started_at: "2026-11-27T00:00:00Z",
      completed_at: "2026-11-27T00:00:01Z",
      feedback_message: "Cô khen bé đọc rất chuẩn!",
      next_recommended_word: null,
      word_progress: {
        normalized_word: "cô",
        practice_status: "COMPLETED",
        practice_attempts_count: 1,
        practice_correct_count: 1,
        practice_incorrect_count: 0,
        practice_uncertain_count: 0,
        consecutive_correct_count: 1,
        required_consecutive_correct: 1,
        last_practiced_at: "2026-11-27T00:00:01Z",
        last_practice_status: "CORRECT",
      },
    };
    evaluatePracticeWordMock.mockResolvedValueOnce(correctAttempt);

    const user = userEvent.setup();
    render(
      <DifficultWordPracticePanel
        child={childFixture}
        onClose={vi.fn()}
        onProgressSaved={vi.fn()}
        onSelectWord={vi.fn()}
        word={wordCo}
        words={[wordCo]}
      />,
    );

    const lock = getActiveSessionVoiceLock();
    expect(lock?.voiceId).toBe(NAM_MIEN_TRUNG_VOICE_ID);
    expect(lock?.speed).toBe(NAM_MIEN_TRUNG_SPEED);

    // Click "Nghe đánh vần": coach cue must say "Thầy đánh vần từng bước tiếng “cô” nhé."
    let resolvePhonics!: () => void;
    speechPlayerMock.playPhonicsLesson.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolvePhonics = () => resolve(undefined);
        }),
    );
    await user.click(screen.getByRole("button", { name: /Nghe đánh vần/i }));
    expect(
      screen.getByText("Thầy đánh vần từng bước tiếng “cô” nhé."),
    ).toBeInTheDocument();
    act(() => resolvePhonics());

    // Practice turn: backend feedback "Cô khen bé..." adapts to "Thầy khen bé..."
    const startPracticeBtn = await screen.findByRole("button", {
      name: /Bắt đầu luyện/i,
    });
    await user.click(startPracticeBtn);
    await waitFor(() => expect(recorderMock.start).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/i }));

    expect(
      await screen.findByText("Thầy khen bé đọc rất chuẩn!"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Cô khen bé/)).not.toBeInTheDocument();
  });

  it("routes MemoryGameScreen TTS through useSpeechPlayer (never raw 0.95x speechSynthesis) with Nam Miền Trung @ 0.85x and adapts Thầy persona", async () => {
    const rawSpeakSpy = vi.fn();
    vi.stubGlobal("speechSynthesis", {
      cancel: vi.fn(),
      speak: rawSpeakSpy,
    });

    const sceneSpec = {
      schema_version: "v4.0",
      theme_key: "sunny_garden",
      theme_name_vi: "Khu vườn nắng mai",
      child_grade: 2,
      difficulty_level: 2,
      scene_seed: 20261127,
      canvas_width: 800,
      canvas_height: 500,
      backdrop: {
        theme_key: "sunny_garden",
        sky_top_hex: "#BCE8FF",
        sky_bottom_hex: "#FFF8D9",
        horizon_hex: "#A4E48E",
        ground_hex: "#73C66A",
        accent_hex: "#F7B731",
        mood_vi: "Nắng sớm dịu nhẹ",
      },
      objects: [],
      observation_tips_vi: [],
      guided_questions_vi: [],
      creative_prompt_vi: "Kể tiếp cùng cô nhé!",
      matched_focus_words: [],
    };
    const memorySession = {
      id: TEST_SESSION_ID,
      child_id: TEST_CHILD_ID,
      child_grade: 2,
      theme_key: "sunny_garden",
      theme_name_vi: "Khu vườn nắng mai",
      difficulty_level: 2,
      scene_seed: 20261127,
      timer_mode: "UNLIMITED",
      timer_seconds: null,
      recall_mode: "FREE_RECALL",
      status: "OBSERVING",
      hints_used: 0,
      peek_count: 0,
      best_factual_score: 0,
      best_creative_score: 0,
      stars: 0,
      attempts_count: 0,
      scene_spec: sceneSpec,
      attempts: [],
      created_at: "2026-11-27T00:00:00Z",
      updated_at: "2026-11-27T00:00:00Z",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === `/profiles/children/${TEST_CHILD_ID}`) {
          return Response.json(childFixture);
        }
        if (path === "/voice/status") {
          return Response.json({
            local: { available: true, tts_ready: true, stt_ready: true },
            google: { tts_configured: false, stt_configured: false },
          });
        }
        if (path === "/games/memory/themes") {
          return Response.json({
            themes: [
              {
                theme_key: "sunny_garden",
                name_vi: "Khu vườn nắng mai",
                description_vi: "Khu vườn nắng sớm",
                badge_vi: "Thiên nhiên",
                accent_hex: "#F7B731",
                sprite_count: 3,
                sample_items_vi: [],
              },
            ],
            timer_options: [],
            grade_recommendations: [],
            total_sprites: 3,
          });
        }
        if (
          path === "/games/memory/sessions" &&
          (!init?.method || init.method === "GET")
        ) {
          return Response.json([]);
        }
        if (path === "/games/memory/sessions" && init?.method === "POST") {
          return Response.json(memorySession, { status: 201 });
        }
        if (path === `/games/memory/sessions/${TEST_SESSION_ID}/attempts`) {
          return Response.json({
            attempt: {
              id: "55555555-5555-4555-8555-555555555555",
              session_id: TEST_SESSION_ID,
              attempt_number: 1,
              stage: "RECALL",
              input_mode: "TEXT",
              response_text: "Mèo cam",
              factual_score: 85,
              creative_score: 0,
              stars: 3,
              evaluation: {
                stage: "RECALL",
                factual_score: 85,
                creative_score: 0,
                stars: 3,
                matched_facts: [],
                missed_facts: [],
                creative_highlights: [],
                story_anchors: [],
                praise_message_vi: "Cô khen bé có trí nhớ rất tốt!",
                story_praise_vi: "Tuyệt vời!",
                next_tip_vi: "",
                creative_followup_vi: "Kể tiếp cùng cô nhé!",
                support_summary_vi: "",
                used_focus_words: [],
                ai_provider: "deterministic-v4",
              },
              ai_provider: "deterministic-v4",
              created_at: "2026-11-27T00:01:00Z",
            },
            session: { ...memorySession, best_factual_score: 85, stars: 3 },
          });
        }
        return Response.json({});
      }),
    );

    const user = userEvent.setup();
    render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <MemoryGameScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("start-memory-game-btn")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Giọng đọc/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("start-memory-game-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("finish-observe-btn")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("finish-observe-btn"));
    await user.click(screen.getByRole("button", { name: /Nghe hướng dẫn/i }));

    await waitFor(() => expect(playCalls.length).toBeGreaterThanOrEqual(1));
    expect(rawSpeakSpy).not.toHaveBeenCalled();
    expect(playCalls[0]!.lockedVoiceId).toBe(NAM_MIEN_TRUNG_VOICE_ID);
    expect(playCalls[0]!.lockedSpeed).toBe(NAM_MIEN_TRUNG_SPEED);

    // Submit recall -> backend "Cô khen bé..." MUST render as "Thầy khen bé..."
    await user.type(screen.getByTestId("recall-textarea"), "Mèo cam");
    await user.click(screen.getByTestId("submit-recall-btn"));
    expect(
      await screen.findByText("Thầy khen bé có trí nhớ rất tốt!"),
    ).toBeInTheDocument();
  });

  it("syncs Nam Miền Trung @ 0.85x in PictureDescriptionScreen, adapts teacher UI + spoken feedback to Thầy, and keeps picture vocab 'cô giáo' verbatim", async () => {
    const pictureSession = {
      session_id: TEST_SESSION_ID,
      child_id: TEST_CHILD_ID,
      child_grade: 2,
      source_type: "SAMPLE",
      sample_key: "classroom",
      book_id: null,
      book_page_id: null,
      image_url: "/images/picture-description/sunny-garden.jpg",
      scene_title: "Lớp học vui vẻ",
      status: "ACTIVE",
      best_stars: 0,
      best_score: 0,
      attempts_count: 0,
      guide: {
        is_child_safe: true,
        scene_title: "Lớp học vui vẻ",
        scene_summary: "Cô giáo giảng bài trong lớp học.",
        guiding_questions: ["Trong tranh có ai?"],
        suggested_vocabulary: [
          { word: "cô giáo", hint: "Người đứng giảng bài trong lớp" },
        ],
        model_sample_sentences: ["Cô giáo đang giảng bài rất hay."],
      },
      attempts: [],
      created_at: "2026-11-27T00:00:00Z",
      updated_at: "2026-11-27T00:00:00Z",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === `/profiles/children/${TEST_CHILD_ID}`) {
          return Response.json(childFixture);
        }
        if (path === "/voice/status") {
          return Response.json({
            local: { available: true, tts_ready: true, stt_ready: true },
            google: { tts_configured: false, stt_configured: false },
          });
        }
        if (path === "/games/picture-description/catalog") {
          return Response.json({
            samples: [
              {
                sample_key: "classroom",
                title: "Lớp học vui vẻ",
                theme: "Trường học",
                description: "Lớp học đầy nắng",
                image_url: "/images/picture-description/sunny-garden.jpg",
              },
            ],
            book_pages: [],
          });
        }
        if (
          path === "/games/picture-description/sessions" &&
          (!init?.method || init.method === "GET")
        ) {
          return Response.json([]);
        }
        if (
          path === "/games/picture-description/sessions" &&
          init?.method === "POST"
        ) {
          return Response.json(pictureSession, { status: 201 });
        }
        if (
          path ===
          `/games/picture-description/sessions/${TEST_SESSION_ID}/evaluate`
        ) {
          const attempt = {
            attempt_id: "66666666-6666-4666-8666-666666666666",
            attempt_number: 1,
            input_mode: "TEXT",
            transcript_text: "Cô giáo đang dạy học.",
            score_out_of_10: 9,
            stars: 3,
            feedback: {
              is_relevant: true,
              score_out_of_10: 9,
              stars: 3,
              matched_details: ["Cô giáo giảng bài"],
              missed_details: [],
              praise_message: "Cô khen bé quan sát rất tinh mắt!",
              improvement_tip: "Lần sau bé kể thêm với cô nhé.",
              upgraded_sentences: [],
              vocabulary_highlights: ["cô giáo"],
              next_prompt_question: "Bé kể cho cô nghe thêm nhé?",
            },
            created_at: "2026-11-27T00:05:00Z",
          };
          return Response.json({
            session: {
              ...pictureSession,
              status: "COMPLETED",
              best_stars: 3,
              best_score: 9,
              attempts_count: 1,
              attempts: [attempt],
            },
            latest_attempt: attempt,
          });
        }
        return Response.json({});
      }),
    );

    const user = userEvent.setup();
    render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <PictureDescriptionScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    await screen.findByText("Lớp học vui vẻ");
    await user.click(
      screen.getByRole("button", { name: "Khám phá tranh này" }),
    );
    await screen.findByText("Chế độ học cùng thầy giáo AI");

    // Clicking picture vocab chip "cô giáo" MUST speak "cô giáo" verbatim (never "thầy giáo")!
    await user.click(screen.getByRole("button", { name: /Mở gợi ý câu hỏi/i }));
    await user.click(screen.getByRole("button", { name: /cô giáo/i }));
    await waitFor(() => expect(playCalls.length).toBeGreaterThanOrEqual(1));
    expect(playCalls[0]!.text).toBe("cô giáo");
    expect(playCalls[0]!.lockedVoiceId).toBe(NAM_MIEN_TRUNG_VOICE_ID);
    expect(playCalls[0]!.lockedSpeed).toBe(NAM_MIEN_TRUNG_SPEED);

    // Submit -> button uses "Gửi thầy giáo AI chấm bài"
    await user.type(
      screen.getByLabelText("Nội dung bé mô tả bức tranh"),
      "Cô giáo đang dạy học rất vui vẻ trong lớp.",
    );
    await user.click(
      screen.getByRole("button", { name: /Gửi thầy giáo AI chấm bài/i }),
    );

    // Result displays adapted Thầy praise & follow-up
    expect(
      await screen.findByText("Thầy khen bé quan sát rất tinh mắt!"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Bé kể cho thầy nghe thêm nhé?"),
    ).toBeInTheDocument();

    // Speaking feedback via "Nghe nhận xét" MUST speak "Thầy khen bé..." using locked Nam Miền Trung @ 0.85x
    playCalls.length = 0;
    await user.click(screen.getByRole("button", { name: /Nghe nhận xét/i }));
    await waitFor(() => expect(playCalls.length).toBe(1));
    expect(playCalls[0]!.text).toBe(
      "Thầy khen bé quan sát rất tinh mắt! Lần sau bé kể thêm với thầy nhé.",
    );
    expect(playCalls[0]!.lockedVoiceId).toBe(NAM_MIEN_TRUNG_VOICE_ID);
    expect(playCalls[0]!.lockedSpeed).toBe(NAM_MIEN_TRUNG_SPEED);
  });
});
