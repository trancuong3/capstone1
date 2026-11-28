import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { SentenceShooterScreen } from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
import { EntertainmentLearningSummary } from "@/components/reports/entertainment-learning-summary";
import { setEntertainmentPreferences } from "@/hooks/use-entertainment-preferences";
import type { MemoryGameService } from "@/lib/api/memory-game-service";
import type { PictureDescriptionService } from "@/lib/api/picture-description-service";
import type { SentenceShooterService } from "@/lib/api/sentence-shooter-service";
import type {
  EntertainmentRecommendationsDTO,
  ParentEntertainmentAnalyticsDTO,
} from "@/types/adaptive-learning";
import type { ChildProfileDTO } from "@/types/child";
import type {
  MemoryEvaluationDTO,
  MemorySessionDTO,
  MemoryThemesCatalogDTO,
} from "@/types/memory-game";
import type {
  PictureCatalogDTO,
  PictureEvaluateResponseDTO,
  PictureSessionDTO,
} from "@/types/picture-description";
import type {
  SentenceShooterBookDTO,
  SentenceShooterNextRoundDTO,
  SentenceShooterSessionDTO,
  SentenceShooterShotDTO,
} from "@/types/sentence-shooter";

const CHILD_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222222";
const BOOK_ID = "33333333-3333-4333-8333-333333333333";

const MOCK_CHILD: ChildProfileDTO = {
  id: CHILD_ID,
  parent_id: PARENT_ID,
  alias: "Bé An",
  grade: 3,
  settings: {},
  created_at: "2026-01-01T00:00:00Z",
};

const speechPlayMock = vi.fn<(...args: unknown[]) => Promise<void>>(
  async () => undefined,
);
const speechStopMock = vi.fn();

const recorderStartMock = vi.fn<() => Promise<void>>(async () => undefined);
const recorderStopMock = vi.fn<() => Promise<Blob | null>>(
  async () => new Blob(["audio"], { type: "audio/webm" }),
);
const recorderCancelMock = vi.fn();

const speechTranscribeMock = vi.fn<
  (...args: unknown[]) => Promise<{ text: string; provider: string }>
>(async () => ({
  text: "",
  provider: "browser",
}));

const adaptiveGetRecommendationsMock =
  vi.fn<(childId: string) => Promise<EntertainmentRecommendationsDTO>>();

const shooterServiceMock: SentenceShooterService = {
  listBooks: vi.fn(),
  createSession: vi.fn(),
  shoot: vi.fn(),
  hint: vi.fn(),
  nextRound: vi.fn(),
  result: vi.fn(),
  abandon: vi.fn(),
};

const pictureServiceMock: PictureDescriptionService = {
  getCatalog: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  evaluate: vi.fn(),
};

vi.mock("@/hooks/use-validated-selected-child", () => ({
  useValidatedSelectedChild: () => ({
    state: { status: "ready" as const, childId: CHILD_ID, child: MOCK_CHILD },
    retry: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => ({
    isPlaying: false,
    error: null,
    play: speechPlayMock,
    stop: speechStopMock,
    clearError: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => ({
    isRecording: false,
    isSpeaking: false,
    audioLevel: 0,
    prepare: vi.fn(async () => undefined),
    start: recorderStartMock,
    stop: recorderStopMock,
    cancel: recorderCancelMock,
    getStream: () => null,
    getIsSpeaking: () => false,
  }),
}));

vi.mock("@/lib/api/speech-service", () => ({
  createSpeechService: () => ({
    transcribe: speechTranscribeMock,
  }),
}));

vi.mock("@/lib/api/adaptive-learning-service", () => ({
  createAdaptiveLearningService: () => ({
    getRecommendations: adaptiveGetRecommendationsMock,
    getParentAnalytics: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-sentence-shooter-service", () => ({
  useSentenceShooterService: () => shooterServiceMock,
}));

vi.mock("@/hooks/use-picture-description-service", () => ({
  usePictureDescriptionService: () => pictureServiceMock,
}));

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  lang = "vi-VN";
  continuous = true;
  interimResults = true;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  emitFinal(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [
        Object.assign([{ transcript: text }], {
          isFinal: true,
        }),
      ],
    });
  }
}

function makeRecommendations(): EntertainmentRecommendationsDTO {
  return {
    child_id: CHILD_ID,
    child_alias: "Bé An",
    child_grade: 3,
    mascot_greeting_vi: "Hôm nay mình cùng ôn từ khó thật vui nhé!",
    natural_break_reminder_vi: "Bé chơi 10 phút nhớ nghỉ mắt nhé.",
    today_activities_count: 1,
    focus_difficult_words: ["con mèo", "khủng long"],
    primary_recommendation: {
      game_key: "SENTENCE_SHOOTER",
      zone_title_vi: "Khu xếp câu",
      game_title_vi: "Bắn súng xếp câu",
      reason_vi: "Luyện ghép câu có từ con mèo",
      suggested_mode: "FILL_BLANK",
      suggested_difficulty: 2,
      target_words: ["con mèo"],
      href: "/entertainment/sentence-shooter",
      quick_play_href: "/entertainment/sentence-shooter?autoplay=1",
      priority: 1,
    },
    recommendations: [
      {
        game_key: "SENTENCE_SHOOTER",
        zone_title_vi: "Khu xếp câu",
        game_title_vi: "Bắn súng xếp câu",
        reason_vi: "Luyện ghép câu có từ con mèo",
        suggested_mode: "FILL_BLANK",
        suggested_difficulty: 2,
        target_words: ["con mèo"],
        href: "/entertainment/sentence-shooter",
        quick_play_href: "/entertainment/sentence-shooter?autoplay=1",
        priority: 1,
      },
      {
        game_key: "PICTURE_DESCRIPTION",
        zone_title_vi: "Góc kể chuyện",
        game_title_vi: "Cô giáo AI kể chuyện",
        reason_vi: "Tập tả tranh với từ khủng long",
        suggested_mode: "VOCABULARY",
        suggested_difficulty: 2,
        target_words: ["khủng long"],
        href: "/entertainment/picture-description",
        quick_play_href: null,
        priority: 2,
      },
    ],
  };
}

function makeShooterSession(roundNumber = 1): SentenceShooterSessionDTO {
  const book: SentenceShooterBookDTO = {
    id: BOOK_ID,
    name: "Chú mèo con",
    title: "Chú mèo con",
    author: "ViRead",
    min_grade: 1,
    max_grade: 3,
    available_rounds: 3,
    matched_difficult_words: ["con mèo"],
  };
  return {
    session_id: "44444444-4444-4444-8444-444444444444",
    book,
    difficulty: "medium",
    learning_mode: "FILL_BLANK",
    total_rounds: 2,
    completed_rounds: roundNumber - 1,
    total_stars: roundNumber - 1,
    practiced_difficult_words: ["con mèo"],
    round: {
      round_id: `round-${roundNumber}`,
      round_number: roundNumber,
      token_count: 1,
      tokens: [
        {
          id: "tok-1",
          text: "con mèo",
          is_difficult_word: true,
        },
      ],
      learning_mode: "FILL_BLANK",
      prompt_slots: [
        {
          position: 0,
          text: null,
          is_blank: true,
          is_difficult_word: true,
        },
      ],
      practiced_difficult_words: ["con mèo"],
      prompt_hint: "Bé hãy chọn từ đúng nhé",
    },
  };
}

function makePictureCatalog(): PictureCatalogDTO {
  return {
    focus_difficult_words: ["con mèo", "vườn hoa"],
    recommended_sample_key: "sunny-garden",
    recommended_book_page_id: null,
    samples: [
      {
        sample_key: "sunny-garden",
        title: "Khu vườn nắng",
        theme: "Thiên nhiên",
        description: "Chú mèo nằm ngủ bên vườn hoa.",
        image_url: "/images/garden.png",
        matched_difficult_words: ["con mèo", "vườn hoa"],
      },
    ],
    book_pages: [],
  };
}

function makePictureSession(): PictureSessionDTO {
  return {
    session_id: "55555555-5555-4555-8555-555555555555",
    child_id: CHILD_ID,
    child_grade: 3,
    source_type: "SAMPLE",
    sample_key: "sunny-garden",
    book_id: null,
    book_page_id: null,
    image_url: "/images/garden.png",
    scene_title: "Khu vườn nắng",
    status: "ACTIVE",
    best_stars: 0,
    best_score: 0,
    attempts_count: 0,
    teaching_mode: "OBSERVE",
    target_vocabulary: ["con mèo", "vườn hoa"],
    target_words: ["con mèo", "vườn hoa"],
    guide: {
      is_child_safe: true,
      scene_title: "Khu vườn nắng",
      scene_summary: "Chú mèo nằm ngủ bên vườn hoa.",
      guiding_questions: ["Bé thấy con vật nào đang nằm ngủ trong vườn?"],
      suggested_vocabulary: [{ word: "con mèo", hint: "Con vật kêu meo meo" }],
      model_sample_sentences: ["Con mèo đang ngủ bên vườn hoa."],
      target_words: ["con mèo", "vườn hoa"],
    },
    attempts: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function makePictureEvalResponse(
  baseSession: PictureSessionDTO,
): PictureEvaluateResponseDTO {
  const attempt = {
    attempt_id: "66666666-6666-4666-8666-666666666666",
    attempt_number: 1,
    input_mode: "VOICE" as const,
    transcript_text: "con mèo đang ngủ",
    score_out_of_10: 9,
    stars: 3,
    evaluation_source: "AI" as const,
    practiced_difficult_words: ["con mèo"],
    feedback: {
      is_relevant: true,
      score_out_of_10: 9,
      stars: 3,
      matched_details: ["Có nhắc tới con mèo"],
      missed_details: [],
      praise_message: "Bé tả câu rất rõ ràng và tự nhiên!",
      improvement_tip: "Bé có thể thêm màu lông của chú mèo nhé.",
      upgraded_sentences: ["Con mèo mướp đang ngủ trưa dưới nắng."],
      vocabulary_highlights: ["con mèo"],
      practiced_difficult_words: ["con mèo"],
      next_prompt_question: "Chú mèo có màu gì thế bé?",
    },
    created_at: "2026-01-01T00:01:00Z",
  };
  return {
    session: {
      ...baseSession,
      best_stars: 3,
      best_score: 9,
      attempts_count: 1,
      practiced_difficult_words: ["con mèo"],
      attempts: [attempt],
    },
    latest_attempt: attempt,
    practiced_difficult_words: ["con mèo"],
  };
}

function makeMemoryCatalog(): MemoryThemesCatalogDTO {
  return {
    themes: [
      {
        theme_key: "sunny_garden",
        name_vi: "Khu vườn nắng",
        description_vi: "Quan sát hoa lá và thú nhỏ",
        badge_vi: "Thiên nhiên",
        accent_hex: "#087467",
        sprite_count: 4,
        sample_items_vi: ["con mèo", "bông hoa"],
      },
    ],
    timer_options: [
      {
        mode: "20S",
        seconds: 20,
        label_vi: "20 giây",
        recommended_for_vi: "Lớp 3",
      },
      {
        mode: "30S",
        seconds: 30,
        label_vi: "30 giây",
        recommended_for_vi: "Lớp 1-2",
      },
    ],
    grade_recommendations: [
      {
        grade: 3,
        min_objects: 3,
        max_objects: 5,
        recommended_timer: "20S",
        recommended_recall_mode: "FREE_RECALL",
        recommended_difficulty: 3,
        note_vi: "Lớp 3 gợi ý 20 giây quan sát.",
      },
    ],
    total_sprites: 10,
    focus_difficult_words: ["con mèo", "hoa vàng"],
    recommended_theme_key: "sunny_garden",
  };
}

function makeMemorySession(timerSeconds = 2): MemorySessionDTO {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    child_id: CHILD_ID,
    child_grade: 3,
    theme_key: "sunny_garden",
    theme_name_vi: "Khu vườn nắng",
    difficulty_level: 3,
    scene_seed: 20261127,
    timer_mode: "20S",
    timer_seconds: timerSeconds,
    recall_mode: "FREE_RECALL",
    status: "OBSERVING",
    hints_used: 0,
    peek_count: 0,
    best_factual_score: 0,
    best_creative_score: 0,
    stars: 0,
    attempts_count: 0,
    focus_words: ["con mèo"],
    scene_spec: {
      schema_version: "4.1",
      theme_key: "sunny_garden",
      theme_name_vi: "Khu vườn nắng",
      child_grade: 3,
      difficulty_level: 3,
      scene_seed: 20261127,
      canvas_width: 640,
      canvas_height: 400,
      backdrop: {
        theme_key: "sunny_garden",
        sky_top_hex: "#E6F4FE",
        sky_bottom_hex: "#FFFFFF",
        horizon_hex: "#C5E8D5",
        ground_hex: "#8FD19E",
        accent_hex: "#087467",
        mood_vi: "Ấm áp",
      },
      objects: [
        {
          id: "obj-cat",
          sprite_key: "cat",
          name_vi: "con mèo",
          category_vi: "Động vật",
          aliases_vi: ["mèo con"],
          color_vi: "vàng",
          color_hex: "#F59E0B",
          color_stroke_hex: "#B45309",
          color_light_hex: "#FEF3C7",
          shape_cue: "circle",
          count: 1,
          position_zone: "giữa",
          bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
          action_vi: "đang ngủ",
          hint_tiers: {
            tier_1: "Có một bạn nhỏ ở giữa vườn",
            tier_2: "Bạn ấy màu vàng",
            tier_3: "Đó là một con mèo đang ngủ",
          },
          is_focus_word: true,
        },
      ],
      observation_tips_vi: ["Nhớ vị trí và màu sắc nhé"],
      guided_questions_vi: ["Con vật nào ở giữa vườn?"],
      creative_prompt_vi: "Kể thêm một câu chuyện vui nhé!",
      matched_focus_words: ["con mèo"],
      focus_words: ["con mèo"],
    },
    attempts: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function makeMemoryEvaluation(): MemoryEvaluationDTO {
  return {
    stage: "RECALL",
    factual_score: 90,
    creative_score: 0,
    stars: 3,
    matched_facts: [
      {
        object_id: "obj-cat",
        sprite_key: "cat",
        name_vi: "con mèo",
        color_vi: "vàng",
        count: 1,
        position_zone: "giữa",
        matched_attributes: ["name"],
        detail_vi: "Con mèo màu vàng đang ngủ",
        bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      },
    ],
    missed_facts: [],
    creative_highlights: [],
    story_anchors: [],
    praise_message_vi: "Bé quan sát rất tinh mắt!",
    story_praise_vi: "",
    next_tip_vi: "Kể thêm một câu chuyện tưởng tượng nhé.",
    creative_followup_vi: "Nếu chú mèo thức dậy thì sẽ làm gì?",
    support_summary_vi: null,
    used_focus_words: ["con mèo"],
    practiced_difficult_words: ["con mèo"],
    focus_word_feedback_vi: "Bé đã dùng trúng từ khó con mèo!",
    ai_provider: "gemini",
  };
}

function createMemoryServiceMock(
  session: MemorySessionDTO,
): MemoryGameService & {
  getThemesMock: ReturnType<typeof vi.fn>;
  createSessionMock: ReturnType<typeof vi.fn>;
  submitAttemptMock: ReturnType<typeof vi.fn>;
} {
  const getThemesMock = vi.fn(async () => makeMemoryCatalog());
  const createSessionMock = vi.fn(async () => session);
  const evaluation = makeMemoryEvaluation();
  const submitAttemptMock = vi.fn(async () => ({
    attempt: {
      id: "att-1",
      session_id: session.id,
      attempt_number: 1,
      stage: "RECALL" as const,
      input_mode: "VOICE" as const,
      response_text: "con mèo vàng đang ngủ",
      factual_score: 90,
      creative_score: 0,
      stars: 3,
      evaluation,
      ai_provider: "gemini",
      created_at: "2026-01-01T00:01:00Z",
    },
    session: {
      ...session,
      best_factual_score: 90,
      stars: 3,
      attempts_count: 1,
    },
  }));

  return {
    getThemes: getThemesMock,
    listSessions: vi.fn(async () => []),
    getSession: vi.fn(async () => session),
    createSession: createSessionMock,
    requestHint: vi.fn(),
    recordPeek: vi.fn(),
    submitAttempt: submitAttemptMock,
    getThemesMock,
    createSessionMock,
    submitAttemptMock,
  };
}

describe("Child Autopilot UX V4.1", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setEntertainmentPreferences({
      reducedMotion: false,
      calmSound: true,
      autoPlayFlow: true,
    });
    vi.clearAllMocks();
    FakeSpeechRecognition.instances = [];
    adaptiveGetRecommendationsMock.mockResolvedValue(makeRecommendations());
    speechPlayMock.mockResolvedValue(undefined);
    recorderStartMock.mockResolvedValue(undefined);
    recorderStopMock.mockResolvedValue(
      new Blob(["audio"], { type: "audio/webm" }),
    );
    speechTranscribeMock.mockResolvedValue({ text: "", provider: "browser" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("Hub renders autoPlayFlow toggle, 1-tap Cú Mèo quick_play_href, misread-word chips, 4 quick links, and non-blocking onboarding", async () => {
    render(
      <EntertainmentScreen initialRecommendations={makeRecommendations()} />,
    );

    const owlQuickPlay = await screen.findByTestId("hub-owl-quick-play");
    expect(owlQuickPlay).toHaveAttribute(
      "href",
      "/entertainment/sentence-shooter?autoplay=1",
    );
    expect(owlQuickPlay).toHaveTextContent("Chơi ngay cùng Cú Mèo");

    const misreadChips = screen.getByTestId("hub-misread-word-chips");
    expect(misreadChips).toHaveTextContent("con mèo");
    expect(misreadChips).toHaveTextContent("khủng long");

    const quickPlayLinks = screen.getAllByText("Vào nhanh");
    expect(quickPlayLinks).toHaveLength(4);
    expect(
      screen.getByTestId("quick-play-picture-description"),
    ).toHaveAttribute("href", "/entertainment/picture-description?autoplay=1");
    expect(screen.getByTestId("quick-play-sentence-shooter")).toHaveAttribute(
      "href",
      "/entertainment/sentence-shooter?autoplay=1",
    );
    expect(screen.getByTestId("quick-play-karaoke")).toHaveAttribute(
      "href",
      "/karaoke?autoplay=1",
    );
    expect(screen.getByTestId("quick-play-memory-game")).toHaveAttribute(
      "href",
      "/entertainment/memory-game?autoplay=1",
    );

    const autoPlayToggle = screen.getByTestId("hub-autoplay-toggle");
    expect(autoPlayToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(autoPlayToggle);
    expect(autoPlayToggle).toHaveAttribute("aria-pressed", "false");

    const onboardingStrip = screen.getByRole("complementary", {
      name: "Hướng dẫn làm quen khu vực Giải trí",
    });
    expect(onboardingStrip).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
    expect(
      screen.queryByRole("complementary", {
        name: "Hướng dẫn làm quen khu vực Giải trí",
      }),
    ).not.toBeInTheDocument();
  });

  it("Reports summary displays reading_misread_words_reinforced card when present", () => {
    const analytics: ParentEntertainmentAnalyticsDTO = {
      child_id: CHILD_ID,
      child_alias: "Bé An",
      child_grade: 3,
      window_days: 7,
      is_diagnostic: false,
      disclaimer_vi: "Theo dõi nhẹ nhàng tại nhà.",
      observed_skills_count: 2,
      estimated_skills_count: 1,
      unknown_skills_count: 0,
      skills: [],
      practiced_difficult_words: [],
      module_activities: [],
      karaoke_weak_segments: [],
      home_support_tips_vi: [],
      reading_misread_words_reinforced: 6,
      generated_at: "2026-01-01T00:00:00Z",
    };

    render(
      <EntertainmentLearningSummary
        childId={CHILD_ID}
        childName="Bé An"
        initialData={analytics}
      />,
    );

    const metricCard = screen.getByTestId("reports-misread-words-reinforced");
    expect(metricCard).toHaveTextContent("6");
  });

  it("Sentence Shooter auto-starts on ?autoplay=1 with auto_select_book=true, speaks completed sentence, and auto-advances after 2.5s (cancelable)", async () => {
    const book: SentenceShooterBookDTO = {
      id: BOOK_ID,
      name: "Chú mèo con",
      title: "Chú mèo con",
      author: "ViRead",
      min_grade: 1,
      max_grade: 3,
      available_rounds: 3,
      matched_difficult_words: ["con mèo"],
    };
    const round1Session = makeShooterSession(1);
    const round2Next: SentenceShooterNextRoundDTO = {
      session_id: round1Session.session_id,
      completed_rounds: 1,
      total_rounds: 2,
      total_stars: 1,
      round: makeShooterSession(2).round,
    };
    const shotDone: SentenceShooterShotDTO = {
      is_correct: true,
      correct_count: 1,
      token_count: 1,
      mistakes_total: 0,
      completed_rounds: 1,
      total_stars: 1,
      round_completed: true,
      session_completed: false,
      next_expected_position: 1,
      stars_awarded: 1,
      score: 10,
      completed_sentence: "Con mèo nhỏ.",
      next_round: null,
      message: "Tuyệt vời!",
    };

    vi.mocked(shooterServiceMock.listBooks).mockResolvedValue([book]);
    vi.mocked(shooterServiceMock.createSession).mockResolvedValue(
      round1Session,
    );
    vi.mocked(shooterServiceMock.shoot).mockResolvedValue(shotDone);
    vi.mocked(shooterServiceMock.nextRound).mockResolvedValue(round2Next);

    render(<SentenceShooterScreen autoPlay={true} />);

    await waitFor(() => {
      expect(shooterServiceMock.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          child_id: CHILD_ID,
          auto_select_book: true,
        }),
        expect.any(AbortSignal),
      );
    });

    const tokenBtn = await screen.findByRole("button", { name: "con mèo" });
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(tokenBtn);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
    });

    const advanceBar = screen.getByTestId("shooter-auto-advance-bar");
    expect(advanceBar).toHaveTextContent("Tự sang câu tiếp theo sau");
    expect(speechPlayMock).toHaveBeenCalledWith("Con mèo nhỏ.");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });

    expect(shooterServiceMock.nextRound).toHaveBeenCalledWith(
      round1Session.session_id,
      round1Session.round.round_id,
      expect.any(AbortSignal),
    );
  });

  it("Sentence Shooter setup renders quick-start CTA and difficult-word badge and stop button cancels auto-advance", async () => {
    const book: SentenceShooterBookDTO = {
      id: BOOK_ID,
      name: "Chú mèo con",
      title: "Chú mèo con",
      author: "ViRead",
      min_grade: 1,
      max_grade: 3,
      available_rounds: 3,
      matched_difficult_words: ["con mèo"],
    };
    const round1Session = makeShooterSession(1);
    const shotDone: SentenceShooterShotDTO = {
      is_correct: true,
      correct_count: 1,
      token_count: 1,
      mistakes_total: 0,
      completed_rounds: 1,
      total_stars: 1,
      round_completed: true,
      session_completed: false,
      next_expected_position: 1,
      stars_awarded: 1,
      score: 10,
      completed_sentence: "Con mèo nhỏ.",
      message: "Tuyệt vời!",
    };

    vi.mocked(shooterServiceMock.listBooks).mockResolvedValue([book]);
    vi.mocked(shooterServiceMock.createSession).mockResolvedValue(
      round1Session,
    );
    vi.mocked(shooterServiceMock.shoot).mockResolvedValue(shotDone);

    render(<SentenceShooterScreen />);

    const quickStartBtn = await screen.findByTestId("shooter-quick-start-btn");
    expect(quickStartBtn).toHaveTextContent("Bắt đầu ngay");
    expect(
      screen.getByTestId("shooter-lobby-difficult-badge"),
    ).toHaveTextContent("Ôn từ khó: con mèo");

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(quickStartBtn);
      await Promise.resolve();
    });

    const tokenBtn = screen.getByRole("button", { name: "con mèo" });
    await act(async () => {
      fireEvent.click(tokenBtn);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
    });

    fireEvent.click(screen.getByTestId("shooter-stop-auto-btn"));
    expect(
      screen.queryByTestId("shooter-auto-advance-bar"),
    ).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(shooterServiceMock.nextRound).not.toHaveBeenCalled();
  });

  it("Picture Description ?autoplay=1 speaks prompt, waits 280ms, auto-arms mic, highlights target word live, and auto-submits after 2.2s silence", async () => {
    vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
    const picCatalog = makePictureCatalog();
    const picSession = makePictureSession();
    const evalResp = makePictureEvalResponse(picSession);

    vi.mocked(pictureServiceMock.getCatalog).mockResolvedValue(picCatalog);
    vi.mocked(pictureServiceMock.listSessions).mockResolvedValue([]);
    vi.mocked(pictureServiceMock.createSession).mockResolvedValue(picSession);
    vi.mocked(pictureServiceMock.evaluate).mockResolvedValue(evalResp);

    vi.useFakeTimers();
    render(<PictureDescriptionScreen autoPlay={true} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pictureServiceMock.createSession).toHaveBeenCalledWith(
      { child_id: CHILD_ID, auto_select: true },
      expect.any(AbortSignal),
    );
    expect(speechPlayMock).toHaveBeenCalledWith(
      "Bé thấy con vật nào đang nằm ngủ trong vườn?",
    );
    expect(recorderStartMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(280);
    });

    expect(recorderStartMock).toHaveBeenCalledTimes(1);
    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition).toBeDefined();

    await act(async () => {
      recognition.emitFinal("con mèo đang ngủ");
    });

    const targetPanel = screen.getByTestId("target-words-panel");
    const matchedChip = targetPanel.querySelector('[data-word-matched="true"]');
    expect(matchedChip).toHaveTextContent("con mèo");
    expect(screen.getByTestId("picture-auto-submit-bar")).toHaveTextContent(
      "Tự gửi sau",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2300);
    });

    expect(pictureServiceMock.evaluate).toHaveBeenCalledWith(
      picSession.session_id,
      expect.objectContaining({
        transcript_text: "con mèo đang ngủ",
        input_mode: "VOICE",
      }),
      expect.any(AbortSignal),
    );
    expect(
      screen.getByTestId("picture-practiced-difficult-words"),
    ).toHaveTextContent("con mèo");
    expect(speechPlayMock).toHaveBeenCalledWith(
      expect.stringContaining("Bé tả câu rất rõ ràng và tự nhiên!"),
    );
  });

  it("Picture Description gracefully falls back when browser blocks auto-mic and cancels silence timer on pause/background", async () => {
    vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
    const picCatalog = makePictureCatalog();
    const picSession = makePictureSession();

    vi.mocked(pictureServiceMock.getCatalog).mockResolvedValue(picCatalog);
    vi.mocked(pictureServiceMock.listSessions).mockResolvedValue([]);
    vi.mocked(pictureServiceMock.createSession).mockResolvedValue(picSession);
    recorderStartMock.mockRejectedValueOnce(new Error("NotAllowedError"));

    vi.useFakeTimers();
    render(<PictureDescriptionScreen autoPlay={true} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pictureServiceMock.createSession).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Bé chạm nút Nói bằng Micro để kể chuyện nhé!"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Tapping mic manually starts recording, then Tạm dừng tự động cancels silence countdown
    recorderStartMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Nói bằng Micro/i }));
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(350);
      await Promise.resolve();
    });
    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition).toBeDefined();

    await act(async () => {
      recognition.emitFinal("con mèo đang ngủ");
    });
    expect(screen.getByTestId("picture-auto-submit-bar")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("picture-pause-auto-btn"));
    expect(
      screen.queryByTestId("picture-auto-submit-bar"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("picture-auto-paused-note")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(pictureServiceMock.evaluate).not.toHaveBeenCalled();

    // Backgrounding aborts active mic cleanly
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(recorderCancelMock).toHaveBeenCalled();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
  });

  it("Memory Game shows quick-play CTA + focus words, ?autoplay=1 picks theme_key=undefined, auto-speaks cue/recall, waits 280ms, and auto-submits after 2.5s silence", async () => {
    vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
    const memSession = makeMemorySession(2);
    const memoryMock = createMemoryServiceMock(memSession);

    vi.useFakeTimers();
    render(<MemoryGameScreen autoPlay={true} service={memoryMock} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(memoryMock.getThemesMock).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      CHILD_ID,
    );
    expect(memoryMock.createSessionMock).toHaveBeenCalledWith({
      child_id: CHILD_ID,
      theme_key: undefined,
      timer_mode: "20S",
      recall_mode: "FREE_RECALL",
    });

    // Advance past requestAnimationFrame for sceneReady -> speaks observation cue
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();
    });
    expect(speechPlayMock).toHaveBeenCalledWith(
      "Bé nhìn kỹ màu sắc và vị trí các đồ vật trong tranh nhé!",
    );

    // Timer hits 0 -> enters RECALL -> speaks prompt -> 280ms cooldown -> arms SpeechRecognition
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
      await Promise.resolve();
    });

    expect(screen.getByTestId("recall-textarea")).toBeInTheDocument();
    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition).toBeDefined();

    await act(async () => {
      recognition.emitFinal("con mèo vàng đang ngủ");
    });

    expect(
      screen.getByTestId("memory-recall-auto-submit-bar"),
    ).toHaveTextContent("Tự gửi sau");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
      await Promise.resolve();
    });

    expect(memoryMock.submitAttemptMock).toHaveBeenCalledWith(
      memSession.id,
      expect.objectContaining({
        stage: "RECALL",
        input_mode: "VOICE",
        response_text: "con mèo vàng đang ngủ",
      }),
    );

    expect(screen.getByTestId("reveal-stage")).toBeInTheDocument();
    expect(screen.getByTestId("reveal-practiced-words")).toHaveTextContent(
      "Bé đã dùng trúng từ khó con mèo!",
    );
    expect(speechPlayMock).toHaveBeenCalledWith(
      expect.stringContaining("Bé quan sát rất tinh mắt!"),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-play-new-btn"));
      await Promise.resolve();
    });
    expect(memoryMock.createSessionMock).toHaveBeenCalledTimes(2);
  });

  it("Memory Game SETUP card displays Chơi ngay (Ôn từ khó) CTA and handles blocked/missing SpeechRecognition calmly", async () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const memSession = makeMemorySession(2);
    const memoryMock = createMemoryServiceMock(memSession);

    render(<MemoryGameScreen service={memoryMock} />);

    const quickPlayBtn = await screen.findByTestId("memory-quick-play-btn");
    expect(quickPlayBtn).toHaveTextContent("Chơi ngay (Ôn từ khó)");
    await waitFor(() => {
      expect(screen.getByTestId("memory-quick-play-card")).toHaveTextContent(
        "con mèo",
      );
    });
    expect(screen.getByTestId("memory-quick-play-card")).toHaveTextContent(
      "lớp 3",
    );

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(quickPlayBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
      await Promise.resolve();
    });

    expect(screen.getByTestId("memory-voice-notice")).toHaveTextContent(
      "Bé chạm Kể bằng giọng nói hoặc gõ chữ những chi tiết bé nhớ được nhé.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("React StrictMode double-mount starts ?autoplay=1 cleanly in both Sentence Shooter and Memory Game without freezing", async () => {
    const book: SentenceShooterBookDTO = {
      id: BOOK_ID,
      name: "Chú mèo con",
      title: "Chú mèo con",
      author: "ViRead",
      min_grade: 1,
      max_grade: 3,
      available_rounds: 3,
      matched_difficult_words: ["con mèo"],
    };
    const shooterSession = makeShooterSession(1);
    vi.mocked(shooterServiceMock.listBooks).mockResolvedValue([book]);
    vi.mocked(shooterServiceMock.createSession).mockResolvedValue(
      shooterSession,
    );

    const shooterView = render(
      <StrictMode>
        <SentenceShooterScreen autoPlay={true} />
      </StrictMode>,
    );

    expect(
      await screen.findByRole("button", { name: "con mèo" }),
    ).toBeInTheDocument();
    expect(shooterServiceMock.createSession).toHaveBeenCalledTimes(1);
    expect(shooterServiceMock.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        child_id: CHILD_ID,
        auto_select_book: true,
      }),
      expect.any(AbortSignal),
    );
    shooterView.unmount();

    const memSession = makeMemorySession(2);
    const memoryMock = createMemoryServiceMock(memSession);

    render(
      <StrictMode>
        <MemoryGameScreen autoPlay={true} service={memoryMock} />
      </StrictMode>,
    );

    expect(await screen.findByTestId("observe-stage")).toBeInTheDocument();
    expect(memoryMock.createSessionMock).toHaveBeenCalledTimes(1);
    expect(memoryMock.createSessionMock).toHaveBeenCalledWith({
      child_id: CHILD_ID,
      theme_key: undefined,
      timer_mode: "20S",
      recall_mode: "FREE_RECALL",
    });
  });
});
