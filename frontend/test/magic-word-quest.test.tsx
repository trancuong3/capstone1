import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import {
  buildDeterministicQuestAttemptUuid,
  getMagicQuestSessionStorageKey,
  MagicWordQuestPanel,
} from "@/components/entertainment/sentence-shooter/magic-word-quest-panel";
import {
  MAGIC_QUEST_BOOK_ID,
  SentenceShooterScreen,
} from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import type { SpeechPlayer } from "@/hooks/use-speech-player";
import {
  completeMagicWordQuestResponseSchema,
  magicWordQuestSchema,
  type AdaptiveLearningService,
} from "@/lib/api/adaptive-learning-service";
import type { DifficultWordService } from "@/lib/api/difficult-word-service";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import type {
  EntertainmentRecommendationsDTO,
  MagicWordQuestDTO,
} from "@/types/adaptive-learning";
import type { DifficultWordPracticeAttemptDTO } from "@/types/reports";

const recorderMock = vi.hoisted(() => ({
  isRecording: false,
  isSpeaking: false,
  audioLevel: 0,
  prepare: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => new Blob(["spoken-audio"], { type: "audio/webm" })),
  cancel: vi.fn(),
  getStream: vi.fn(() => null),
  getIsSpeaking: vi.fn(() => false),
  getAudioLevel: vi.fn(() => 0),
  getQuality: vi.fn(() => ({
    status: "SPEECH_DETECTED" as const,
    rms: 0.08,
    peak: 0.3,
    noiseFloor: 0.005,
    speechDurationMs: 650,
    totalDurationMs: 900,
    clippingRatio: 0,
    isSpeaking: false,
  })),
  getSettings: vi.fn(() => ({})),
}));

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => recorderMock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "magic-quest-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const QUEST_ID = "99000000-0000-4000-8000-000000000001";
const CHOICE_IDS = {
  r1Target: "99000000-0000-5000-8000-000000000101",
  r1Wrong: "99000000-0000-5000-8000-000000000102",
  r2Target: "99000000-0000-5000-8000-000000000201",
  r2Wrong: "99000000-0000-5000-8000-000000000202",
  r3Target: "99000000-0000-5000-8000-000000000301",
  r3Wrong: "99000000-0000-5000-8000-000000000302",
} as const;

function buildSampleQuest(
  overrides: Partial<MagicWordQuestDTO> = {},
): MagicWordQuestDTO {
  const exp = Math.floor(Date.now() / 1000) + 900;
  return {
    quest_id: QUEST_ID,
    child_id: TEST_CHILD_ID,
    child_grade: 2,
    title_vi: "Cuộn Phép Thuật 60 Giây Của Cú Mèo",
    intro_vi:
      "Chạm chữ đúng nạp pháo và đọc vang cùng cô để thắp sáng sao nhé!",
    ephemeral_badge_vi: "✨ Cuộn Phép Thuật Tức Thì · Chơi xong tự tan biến",
    dissolve_message_template_vi:
      "Cuộn phép thuật đã bay về bầu trời sao — còn {count} chữ giỏi đã ở lại cùng {alias} rồi!",
    source_kind: "WEAK_WORDS",
    provider_tier: "DETERMINISTIC_FALLBACK",
    target_words: ["lung linh", "chăm chỉ"],
    rounds: [
      {
        round_number: 1,
        target_word: "lung linh",
        normalized_word: "lung linh",
        is_weak_target: true,
        phonics_category: "coda_ng_nh",
        phonics_label_vi: "Vần -ng / -nh",
        sentence_text: "Đèn ông sao tỏa sáng lung linh trên bầu trời đêm.",
        prompt_hint_vi: "Chạm chữ đúng nạp pháo rồi đọc vang nhé!",
        prompt_slots: [
          { position: 0, text: "Đèn", is_blank: false, is_target_word: false },
          { position: 1, text: "ông", is_blank: false, is_target_word: false },
          { position: 2, text: "sao", is_blank: false, is_target_word: false },
          { position: 3, text: "tỏa", is_blank: false, is_target_word: false },
          { position: 4, text: "sáng", is_blank: false, is_target_word: false },
          { position: 5, text: null, is_blank: true, is_target_word: true },
          { position: 6, text: "trên", is_blank: false, is_target_word: false },
          { position: 7, text: "bầu", is_blank: false, is_target_word: false },
          { position: 8, text: "trời", is_blank: false, is_target_word: false },
          { position: 9, text: "đêm.", is_blank: false, is_target_word: false },
        ],
        choices: [
          { id: CHOICE_IDS.r1Wrong, text: "bông hoa", is_target: false },
          { id: CHOICE_IDS.r1Target, text: "lung linh", is_target: true },
        ],
        expected_choice_id: CHOICE_IDS.r1Target,
      },
      {
        round_number: 2,
        target_word: "lung linh",
        normalized_word: "lung linh",
        is_weak_target: true,
        phonics_category: "coda_ng_nh",
        phonics_label_vi: "Vần -ng / -nh",
        sentence_text: "Ngôi sao phép thuật sáng bừng cùng tiếng lung linh!",
        prompt_hint_vi: "Gặp lại chữ quen trong câu mới nào!",
        prompt_slots: [
          { position: 0, text: "Ngôi", is_blank: false, is_target_word: false },
          { position: 1, text: "sao", is_blank: false, is_target_word: false },
          { position: 2, text: null, is_blank: true, is_target_word: true },
        ],
        choices: [
          { id: CHOICE_IDS.r2Target, text: "lung linh", is_target: true },
          { id: CHOICE_IDS.r2Wrong, text: "đám mây", is_target: false },
        ],
        expected_choice_id: CHOICE_IDS.r2Target,
      },
      {
        round_number: 3,
        target_word: "chăm chỉ",
        normalized_word: "chăm chỉ",
        is_weak_target: false,
        phonics_category: "general",
        phonics_label_vi: "Từ tự tin",
        sentence_text: "Chú ong nhỏ chăm chỉ tìm mật ngọt mỗi sáng.",
        prompt_hint_vi: "Câu kết tự tin của bé!",
        prompt_slots: [
          { position: 0, text: "Chú", is_blank: false, is_target_word: false },
          { position: 1, text: "ong", is_blank: false, is_target_word: false },
          { position: 2, text: null, is_blank: true, is_target_word: true },
        ],
        choices: [
          { id: CHOICE_IDS.r3Target, text: "chăm chỉ", is_target: true },
          { id: CHOICE_IDS.r3Wrong, text: "cánh diều", is_target: false },
        ],
        expected_choice_id: CHOICE_IDS.r3Target,
      },
    ],
    expires_at: new Date(exp * 1000).toISOString(),
    quest_exp: exp,
    quest_sig: "a".repeat(64),
    ...overrides,
  };
}

function buildPracticeAttempt(
  status: "CORRECT" | "INCORRECT" | "NO_CLEAR_AUDIO",
  word = "lung linh",
): DifficultWordPracticeAttemptDTO {
  return {
    attempt_id: "88000000-0000-4000-8000-000000000001",
    child_id: TEST_CHILD_ID,
    normalized_word: word,
    display_text: word,
    attempt_number: 1,
    state: "COMPLETED",
    assessment_status: status,
    recognition_source: "SERVER_STT",
    spoken_transcript: status === "CORRECT" ? word : "lưng linh",
    confidence: 0.94,
    audio_duration_ms: 650,
    assessment_version: 1,
    evidence_word_ids: [],
    started_at: "2026-11-28T08:00:00Z",
    completed_at: "2026-11-28T08:00:01Z",
    feedback_message: null,
    word_progress: {
      normalized_word: word,
      practice_status: status === "CORRECT" ? "COMPLETED" : "IN_PROGRESS",
      practice_attempts_count: 1,
      practice_correct_count: status === "CORRECT" ? 2 : 0,
      practice_incorrect_count: status === "INCORRECT" ? 1 : 0,
      practice_uncertain_count: 0,
      consecutive_correct_count: status === "CORRECT" ? 2 : 0,
      required_consecutive_correct: 2,
      last_practiced_at: "2026-11-28T08:00:01Z",
      last_practice_status: status,
    },
    next_recommended_word: null,
    evidence_count_unchanged: true,
  };
}

function makeMockSpeechPlayer(): SpeechPlayer & {
  readonly playMock: ReturnType<typeof vi.fn>;
  readonly playPhonicsMock: ReturnType<typeof vi.fn>;
  readonly setCacheContextMock: ReturnType<typeof vi.fn>;
} {
  const playMock = vi.fn(async () => {});
  const playPhonicsMock = vi.fn(async () => {});
  const setCacheContextMock = vi.fn();
  return {
    isPlaying: false,
    isPaused: false,
    state: "idle",
    fallbackNotice: null,
    setCacheContext: setCacheContextMock,
    play: playMock,
    prefetch: vi.fn(async () => {}),
    playPhonicsLesson: playPhonicsMock,
    playWithWordTimings: vi.fn(async () => {}),
    pause: vi.fn(),
    resume: vi.fn(async () => {}),
    stop: vi.fn(),
    playMock,
    playPhonicsMock,
    setCacheContextMock,
  };
}

describe("Magic Word Quest ('Nhiệm vụ Phép Thuật 60s của Cú Mèo')", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.setItem("viread:entertainment-onboarded:v1", "1");
    recorderMock.start.mockReset();
    recorderMock.start.mockResolvedValue(undefined);
    recorderMock.stop.mockReset();
    recorderMock.stop.mockResolvedValue(
      new Blob(["spoken-audio"], { type: "audio/webm" }),
    );
    recorderMock.cancel.mockReset();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("validates Backend 1:1 Zod contract and generates RFC-4122 deterministic attempt UUIDs", () => {
    const quest = buildSampleQuest();
    const parsedQuest = magicWordQuestSchema.parse(quest);
    expect(parsedQuest.provider_tier).toBe("DETERMINISTIC_FALLBACK");
    expect(parsedQuest.source_kind).toBe("WEAK_WORDS");
    expect(parsedQuest.rounds[0]?.is_weak_target).toBe(true);
    expect(parsedQuest.rounds[2]?.is_weak_target).toBe(false);

    const parsedComplete = completeMagicWordQuestResponseSchema.parse({
      quest_id: QUEST_ID,
      child_id: TEST_CHILD_ID,
      recorded_evidence_skills: ["sentence_cloze", "phonics_decoding"],
      already_recorded: false,
      stars_earned: 3,
      ephemeral_cleared: true,
    });
    expect(parsedComplete.stars_earned).toBe(3);

    const uuidA = buildDeterministicQuestAttemptUuid(QUEST_ID, 1, 1);
    const uuidB = buildDeterministicQuestAttemptUuid(QUEST_ID, 1, 1);
    const uuidNext = buildDeterministicQuestAttemptUuid(QUEST_ID, 1, 2);
    expect(uuidA).toBe(uuidB);
    expect(uuidA).not.toBe(uuidNext);
    expect(z.uuid().safeParse(uuidA).success).toBe(true);
  });

  it("renders Hub Magic Quest CTA, preserves ?focus= across all 4 Zone cards, and refreshes recommendations on visibility return", async () => {
    const initialRecs: EntertainmentRecommendationsDTO = {
      child_id: TEST_CHILD_ID,
      child_alias: "Bé Mây",
      child_grade: 2,
      mascot_greeting_vi: "Chào Bé Mây!",
      natural_break_reminder_vi: "Nghỉ mắt dịu nhẹ nhé.",
      today_activities_count: 1,
      focus_difficult_words: ["lung linh", "nắng sớm"],
      primary_recommendation: {
        game_key: "SENTENCE_SHOOTER",
        zone_title_vi: "Phiêu lưu cùng chữ",
        game_title_vi: "Xạ thủ ghép câu",
        reason_vi: "Ôn nhẹ các từ khó.",
        suggested_mode: "WORD_ORDER",
        suggested_difficulty: 1,
        target_words: ["lung linh"],
        href: "/entertainment/sentence-shooter?focus=lung%20linh",
        priority: 1,
      },
      recommendations: [],
    };

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/recommendations")) {
        return new Response(
          JSON.stringify({
            ...initialRecs,
            focus_difficult_words: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/vocabulary-notebook")) {
        return new Response(
          JSON.stringify({
            child_id: TEST_CHILD_ID,
            total: 0,
            items: [],
            storytelling_words: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/profiles/children")) {
        return Response.json(
          url.endsWith(`/profiles/children/${TEST_CHILD_ID}`)
            ? childFixture
            : [childFixture],
        );
      }
      if (url.includes("/daily-five-minute-train")) {
        return new Response("{}", { status: 404 });
      }
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <EntertainmentScreen initialRecommendations={initialRecs} />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const magicCta = screen.getByTestId("hub-magic-quest-cta");
    expect(magicCta).toHaveAttribute(
      "href",
      expect.stringContaining(
        "/entertainment/sentence-shooter?mode=magic-quest",
      ),
    );
    expect(magicCta).toHaveAttribute(
      "href",
      expect.stringContaining("focus=lung+linh%2Cn%E1%BA%AFng+s%E1%BB%9Bm"),
    );

    // All 4 Zone CTAs preserve ?focus=
    expect(screen.getByRole("link", { name: /Chọn tranh/i })).toHaveAttribute(
      "href",
      expect.stringContaining("focus="),
    );
    expect(screen.getByRole("link", { name: /Bắt đầu chơi/i })).toHaveAttribute(
      "href",
      expect.stringContaining("focus="),
    );
    expect(
      screen.getByRole("link", { name: /Mở thư viện bài hát/i }),
    ).toHaveAttribute("href", expect.stringContaining("focus="));
    expect(
      screen.getByRole("link", { name: /Khám phá trí nhớ/i }),
    ).toHaveAttribute("href", expect.stringContaining("focus="));

    // Returning to visible tab refreshes recommendations and clears graduated weak words
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("hub-magic-quest-cta"),
      ).not.toBeInTheDocument();
    });
  });

  it("unblocks SentenceShooterScreen when 0 suitable library books exist by auto-selecting MAGIC_QUEST_BOOK_ID", async () => {
    const user = userEvent.setup();
    const sampleQuest = buildSampleQuest();

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json({
          ...childFixture,
          id: TEST_CHILD_ID,
          alias: "Bé Sao",
          grade: 2,
        });
      }
      if (url.pathname === "/games/sentence-shooter/books") {
        // 0 suitable books in catalog!
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.pathname === `/learning/children/${TEST_CHILD_ID}/magic-word-quest`
      ) {
        return new Response(JSON.stringify(sampleQuest), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <SentenceShooterScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const deckCard = await screen.findByTestId("magic-quest-deck-card");
    await waitFor(() => {
      expect(deckCard).toHaveAttribute("aria-pressed", "true");
    });
    expect(MAGIC_QUEST_BOOK_ID).toBe("__magic_word_quest__");

    const startBtn = screen.getByRole("button", { name: /Bắt đầu chơi/i });
    expect(startBtn).toBeEnabled();

    await user.click(startBtn);
    expect(
      await screen.findByTestId("magic-word-quest-panel"),
    ).toBeInTheDocument();
  });

  it("completes 2-Act Story Cannon, enforces SRS hygiene (evaluatePracticeWord at most once per unique weak word), and dissolves ephemeral storage", async () => {
    const user = userEvent.setup();
    const quest = buildSampleQuest();
    const createQuestMock = vi.fn<
      AdaptiveLearningService["createMagicWordQuest"]
    >(async () => quest);
    const completeQuestMock = vi.fn<
      AdaptiveLearningService["completeMagicWordQuest"]
    >(async () => ({
      quest_id: quest.quest_id,
      child_id: TEST_CHILD_ID,
      recorded_evidence_skills: ["sentence_cloze"],
      already_recorded: false,
      stars_earned: 3,
      ephemeral_cleared: true,
    }));
    const evaluatePracticeWordMock = vi.fn<
      NonNullable<DifficultWordService["evaluatePracticeWord"]>
    >(async () => buildPracticeAttempt("CORRECT", "lung linh"));
    const transcribeMock = vi
      .fn()
      .mockResolvedValueOnce({
        text: "lung linh",
        language_code: "vi",
        language_probability: 0.98,
        words: null,
      })
      .mockResolvedValueOnce({
        text: "chăm chỉ",
        language_code: "vi",
        language_probability: 0.98,
        words: null,
      });
    const speechPlayer = makeMockSpeechPlayer();
    const onExit = vi.fn();

    render(
      <MagicWordQuestPanel
        adaptiveService={{
          createMagicWordQuest: createQuestMock,
          completeMagicWordQuest: completeQuestMock,
        }}
        autopilotEnabled={false}
        calmSound
        child={{
          ...childFixture,
          id: TEST_CHILD_ID,
          alias: "Bé Sao",
          grade: 2,
        }}
        difficultWordService={{
          evaluatePracticeWord: evaluatePracticeWordMock,
        }}
        focusWords={["lung linh"]}
        onExitToLobby={onExit}
        reducedMotion
        speechPlayer={speechPlayer}
        speechService={{ transcribe: transcribeMock }}
      />,
    );

    await screen.findByTestId("magic-word-quest-panel");
    expect(
      window.sessionStorage.getItem(
        getMagicQuestSessionStorageKey(TEST_CHILD_ID),
      ),
    ).not.toBeNull();

    // Round 1 ("lung linh", is_weak_target=true): tap wrong bubble first, then target, then speak
    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r1Wrong}`));
    expect(screen.getByTestId("magic-blank-slot")).toHaveTextContent("___");

    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r1Target}`));
    expect(screen.getByTestId("magic-blank-slot")).toHaveTextContent(
      "lung linh",
    );

    await user.click(screen.getByTestId("magic-speak-btn"));
    await user.click(await screen.findByTestId("magic-stop-speak-btn"));

    await screen.findByTestId("magic-round-cleared");
    expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(1);
    expect(evaluatePracticeWordMock.mock.calls[0]?.[1]).toMatchObject({
      normalized_word: "lung linh",
      display_text: "lung linh",
      context_phrase: quest.rounds[0]?.sentence_text,
      book_id: undefined,
    });
    await user.click(screen.getByTestId("magic-next-round-btn"));

    // Round 2 ("lung linh", 2nd contextual round of SAME weak word -> must use transcribe, NOT evaluatePracticeWord!)
    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r2Target}`));
    await user.click(screen.getByTestId("magic-speak-btn"));
    await user.click(await screen.findByTestId("magic-stop-speak-btn"));

    await screen.findByTestId("magic-round-cleared");
    expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(1);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("magic-next-round-btn"));

    // Round 3 ("chăm chỉ", is_weak_target=false confidence word -> must use transcribe, NOT evaluatePracticeWord!)
    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r3Target}`));
    await user.click(screen.getByTestId("magic-speak-btn"));
    await user.click(await screen.findByTestId("magic-stop-speak-btn"));

    await screen.findByTestId("magic-round-cleared");
    expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(1);
    expect(transcribeMock).toHaveBeenCalledTimes(2);
    await user.click(screen.getByTestId("magic-next-round-btn"));

    // Act 2: Glowing Scroll Finale + ephemeral purge + dissolve interpolation
    await screen.findByTestId("magic-finale-scroll");
    expect(
      window.sessionStorage.getItem(
        getMagicQuestSessionStorageKey(TEST_CHILD_ID),
      ),
    ).toBeNull();
    expect(completeQuestMock).toHaveBeenCalledTimes(1);
    expect(completeQuestMock.mock.calls[0]?.[1]).toMatchObject({
      quest_id: QUEST_ID,
      quest_exp: quest.quest_exp,
      quest_sig: quest.quest_sig,
      rounds_completed: 3,
      total_rounds: 3,
      tap_correct_count: 3,
      tap_mistake_count: 1,
      spoken_correct_count: 3,
      effort_rescued_count: 0,
      mic_mode: "VOICE",
      stars_earned: 3,
    });

    await user.click(screen.getByTestId("magic-dissolve-btn"));
    expect(screen.getByTestId("magic-dissolved-message")).toHaveTextContent(
      "Cuộn phép thuật đã bay về bầu trời sao — còn 2 chữ giỏi đã ở lại cùng Bé Sao rồi!",
    );
  });

  it("handles 0-strike NO_CLEAR_AUDIO, Strike-2 PhonicsLessonCard, Strike-3 Owl Effort Star, and 1-star floor", async () => {
    const user = userEvent.setup();
    const singleTargetQuest = buildSampleQuest({
      source_kind: "STARTER_FALLBACK",
      rounds: buildSampleQuest().rounds.map((r) => ({
        ...r,
        is_weak_target: false,
      })),
    });
    const completeQuestMock = vi.fn<
      AdaptiveLearningService["completeMagicWordQuest"]
    >(async (_childId, payload) => ({
      quest_id: singleTargetQuest.quest_id,
      child_id: TEST_CHILD_ID,
      recorded_evidence_skills: ["sentence_cloze", "phonics_decoding"],
      already_recorded: false,
      stars_earned: payload.stars_earned,
      ephemeral_cleared: true,
    }));
    const evaluatePracticeWordMock = vi.fn();
    const transcribeMock = vi
      .fn()
      // 1) Silence -> 0 strikes
      .mockResolvedValueOnce({
        text: "",
        language_code: "vi",
        language_probability: 0,
        words: null,
      })
      // 2) Strike 1 -> slow 0.88x model
      .mockResolvedValueOnce({
        text: "bông hoa",
        language_code: "vi",
        language_probability: 0.95,
        words: null,
      })
      // 3) Strike 2 -> PhonicsLessonCard
      .mockResolvedValueOnce({
        text: "bông hoa",
        language_code: "vi",
        language_probability: 0.95,
        words: null,
      })
      // 4) Strike 3 -> Owl Assist Effort Star unlocked
      .mockResolvedValueOnce({
        text: "bông hoa",
        language_code: "vi",
        language_probability: 0.95,
        words: null,
      });

    const speechPlayer = makeMockSpeechPlayer();

    render(
      <MagicWordQuestPanel
        adaptiveService={{
          createMagicWordQuest: vi.fn(async () => singleTargetQuest),
          completeMagicWordQuest: completeQuestMock,
        }}
        autopilotEnabled={false}
        calmSound
        child={{ ...childFixture, id: TEST_CHILD_ID, alias: "Bé An", grade: 1 }}
        difficultWordService={{
          evaluatePracticeWord: evaluatePracticeWordMock,
        }}
        onExitToLobby={vi.fn()}
        reducedMotion
        speechPlayer={speechPlayer}
        speechService={{ transcribe: transcribeMock }}
      />,
    );

    await screen.findByTestId("magic-word-quest-panel");
    expect(screen.getByTestId("magic-starter-badge")).toBeInTheDocument();

    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r1Target}`));

    // Attempt 0: Empty audio -> 0 strikes consumed
    await user.click(screen.getByTestId("magic-speak-btn"));
    await user.click(await screen.findByTestId("magic-stop-speak-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("magic-status-message")).toHaveTextContent(
        /Không mất lượt/i,
      ),
    );
    expect(screen.queryByTestId("phonics-lesson-card")).not.toBeInTheDocument();

    // Strike 1: Plays slow 0.88x model with ephemeral: true
    await user.click(screen.getByTestId("magic-speak-btn"));
    await user.click(await screen.findByTestId("magic-stop-speak-btn"));
    await waitFor(() => {
      expect(speechPlayer.playMock).toHaveBeenCalledWith(
        "lung linh",
        expect.objectContaining({
          ephemeral: true,
          wordSample: true,
          speedScale: 0.88,
        }),
      );
    });

    // Strike 2: Renders PhonicsLessonCard and plays phonics with ephemeral: true
    await user.click(screen.getByTestId("magic-speak-btn"));
    await user.click(await screen.findByTestId("magic-stop-speak-btn"));
    expect(
      await screen.findByTestId("phonics-lesson-card"),
    ).toBeInTheDocument();
    expect(speechPlayer.playPhonicsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ephemeral: true }),
    );

    // Strike 3: Unlocks Owl Rescue Effort Star
    await user.click(screen.getByTestId("magic-speak-btn"));
    await user.click(await screen.findByTestId("magic-stop-speak-btn"));
    const rescueBtn = await screen.findByTestId("magic-owl-rescue-btn");
    await user.click(rescueBtn);
    await screen.findByTestId("magic-round-cleared");
    await user.click(screen.getByTestId("magic-next-round-btn"));

    // Switch to No-Mic Fallback for Rounds 2 & 3, with deliberate tap mistakes to hit 1-star floor
    await user.click(screen.getByTestId("magic-nomic-toggle"));
    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r2Wrong}`));
    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r2Wrong}`));
    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r2Wrong}`));
    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r2Target}`));
    await user.click(await screen.findByTestId("magic-fire-nomic-btn"));
    await user.click(await screen.findByTestId("magic-next-round-btn"));

    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r3Target}`));
    await user.click(await screen.findByTestId("magic-fire-nomic-btn"));
    await user.click(await screen.findByTestId("magic-next-round-btn"));

    // STARTER_FALLBACK never touches DifficultWordPracticeAttempt
    expect(evaluatePracticeWordMock).not.toHaveBeenCalled();

    await screen.findByTestId("magic-finale-scroll");
    expect(screen.getByTestId("magic-effort-badge")).toBeInTheDocument();
    expect(completeQuestMock.mock.calls[0]?.[1]).toMatchObject({
      effort_rescued_count: 1,
      used_phonics_hint: true,
      mic_mode: "NO_MIC_FALLBACK",
      stars_earned: 1,
    });
  });

  it("purges expired quest_exp on mount, switches to NO_MIC_FALLBACK on mic permission denial, and purges sessionStorage on exit", async () => {
    const user = userEvent.setup();
    const expiredQuest = buildSampleQuest({
      quest_exp: Math.floor(Date.now() / 1000) - 30,
    });
    const storageKey = getMagicQuestSessionStorageKey(TEST_CHILD_ID);
    window.sessionStorage.setItem(storageKey, JSON.stringify(expiredQuest));

    const freshQuest = buildSampleQuest();
    const createQuestMock = vi.fn<
      AdaptiveLearningService["createMagicWordQuest"]
    >(async () => freshQuest);
    const onExit = vi.fn();

    const deniedErr = new Error("Permission denied");
    deniedErr.name = "NotAllowedError";
    recorderMock.start.mockRejectedValueOnce(deniedErr);

    render(
      <MagicWordQuestPanel
        adaptiveService={{
          createMagicWordQuest: createQuestMock,
          completeMagicWordQuest: vi.fn(),
        }}
        autopilotEnabled={false}
        calmSound={false}
        child={{
          ...childFixture,
          id: TEST_CHILD_ID,
          alias: "Bé Mây",
          grade: 2,
        }}
        onExitToLobby={onExit}
        reducedMotion
        speechPlayer={makeMockSpeechPlayer()}
      />,
    );

    expect(
      await screen.findByTestId("magic-expired-banner"),
    ).toBeInTheDocument();
    expect(createQuestMock).toHaveBeenCalledWith(
      TEST_CHILD_ID,
      expect.objectContaining({ refresh: true }),
      expect.anything(),
    );

    // Tap correct bubble, attempt mic -> denied -> auto-switches to NO_MIC_FALLBACK
    await user.click(screen.getByTestId(`magic-choice-${CHOICE_IDS.r1Target}`));
    await user.click(screen.getByTestId("magic-speak-btn"));
    expect(
      await screen.findByTestId("magic-mic-fallback-banner"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("magic-fire-nomic-btn")).toBeInTheDocument();

    // Exit purges sessionStorage immediately
    await user.click(screen.getByTestId("magic-exit-btn"));
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
