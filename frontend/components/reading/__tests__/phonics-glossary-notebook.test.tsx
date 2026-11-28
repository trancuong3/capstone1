import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import {
  AppServicesContext,
  type AppServices,
} from "@/components/providers/app-services-provider";
import { PhonicsLessonCard } from "@/components/reading/phonics-lesson-card";
import { VocabularyNotebookDrawer } from "@/components/reading/vocabulary-notebook-drawer";
import type { ChildService } from "@/lib/api/child-service";
import type { MemoryGameService } from "@/lib/api/memory-game-service";
import type { PictureDescriptionService } from "@/lib/api/picture-description-service";
import type {
  FavoriteWordDTO,
  VocabularyNotebookListDTO,
  VocabularyNotebookService,
  WordExplainDTO,
} from "@/lib/api/vocabulary-notebook-service";
import { buildPhonicsLesson } from "@/lib/reading/phonics-lesson";
import {
  childFixture,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import type { EntertainmentRecommendationsDTO } from "@/types/adaptive-learning";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
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

const CHILD_ID = TEST_CHILD_ID;

function makeExplainDto(overrides: Partial<WordExplainDTO> = {}): WordExplainDTO {
  return {
    word: "lung linh",
    normalized_word: "lung linh",
    grade_band: "GRADE_3_5",
    part_of_speech_vi: "từ láy gợi tả",
    definition_vi:
      "Tỏa ánh sáng dịu nhẹ, đẹp mắt và như đang rung rinh trước mắt.",
    example_sentence_vi:
      "Đêm hội Trung thu, những chiếc đèn lồng sáng lung linh khắp sân trường.",
    nuance_note_vi:
      "Từ láy âm đầu «l» gợi vẻ đẹp dịu dàng, huyền ảo của ánh sáng.",
    spoken_tts_text:
      "Từ lung linh. Tỏa ánh sáng dịu nhẹ, đẹp mắt và như đang rung rinh trước mắt. Ví dụ: Đêm hội Trung thu, những chiếc đèn lồng sáng lung linh khắp sân trường.",
    source_provider: "gemini_primary",
    cached: false,
    fallback_used: false,
    safety_checked: true,
    is_saved_in_notebook: false,
    notebook_item_id: null,
    ...overrides,
  };
}

function makeFavoriteItem(word: string, idSuffix: string): FavoriteWordDTO {
  const norm = word.toLowerCase();
  return {
    id: `90000000-0000-4000-8000-0000000000${idSuffix}`,
    child_profile_id: CHILD_ID,
    word,
    normalized_word: norm,
    grade_band: "GRADE_3_5",
    definition_vi: `Giải nghĩa thân thiện của từ «${word}».`,
    example_sentence_vi: `Bé đặt câu kể chuyện ấm áp với từ «${word}».`,
    nuance_note_vi: "Từ giàu hình ảnh giúp câu chuyện sinh động.",
    spoken_tts_text: `Từ ${word}. Giải nghĩa thân thiện của từ ${word}.`,
    source_book_id: null,
    source_page_id: null,
    visibility: "PARENT_PRIVATE",
    times_used_in_games: 0,
    already_saved: false,
    created_at: "2026-11-28T07:00:00Z",
    updated_at: "2026-11-28T07:00:00Z",
  };
}

function buildTestAppServices(
  pictureDescriptionService: PictureDescriptionService,
): AppServices {
  const childService: ChildService = {
    list: vi.fn(async () => [childFixture]),
    create: vi.fn(async () => childFixture),
    get: vi.fn(async () => childFixture),
    update: vi.fn(async () => childFixture),
    updateVoicePreferences: vi.fn(async () => childFixture),
    uploadAvatar: vi.fn(async () => childFixture),
    removeAvatar: vi.fn(async () => childFixture),
    delete: vi.fn(async () => undefined),
  };
  const unavailable = new Proxy(
    {},
    {
      get() {
        return vi.fn();
      },
    },
  );
  return {
    bookService: unavailable as AppServices["bookService"],
    bookContentReportService:
      unavailable as AppServices["bookContentReportService"],
    childService,
    comprehensionService: unavailable as AppServices["comprehensionService"],
    devicePermissionService:
      unavailable as AppServices["devicePermissionService"],
    difficultWordService: unavailable as AppServices["difficultWordService"],
    pageMatchService: unavailable as AppServices["pageMatchService"],
    profileService: unavailable as AppServices["profileService"],
    reportService: unavailable as AppServices["reportService"],
    readingService: unavailable as AppServices["readingService"],
    readingManagementService:
      unavailable as AppServices["readingManagementService"],
    readingSocketAdapter: unavailable as AppServices["readingSocketAdapter"],
    sessionService: unavailable as AppServices["sessionService"],
    pictureDescriptionService,
    tutorService: unavailable as AppServices["tutorService"],
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ detail: "Not mocked" }, { status: 404 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("Feature #6: PhonicsLessonCard Glossary Tab + Sổ Từ Hay + Game Bridge", () => {
  it("keeps 'Đánh vần' active by default, switches to 'Nghĩa & Ví dụ', plays TTS, and saves to Sổ Từ Hay", async () => {
    const user = userEvent.setup();
    const lesson = buildPhonicsLesson("lung linh");
    expect(lesson.supported).toBe(true);

    const savedItem = makeFavoriteItem("lung linh", "01");
    const mockService: VocabularyNotebookService = {
      explainWord: vi.fn(async () => makeExplainDto()),
      listNotebook: vi.fn(
        async (): Promise<VocabularyNotebookListDTO> => ({
          child_id: CHILD_ID,
          total: 1,
          storytelling_words: ["lung linh"],
          items: [savedItem],
        }),
      ),
      saveWord: vi.fn(async () => savedItem),
      deleteWord: vi.fn(async () => ({ deleted: true, item_id: savedItem.id })),
    };

    const playFn = vi.fn<(text: string, options?: unknown) => Promise<void>>(
      async () => undefined,
    );
    const mockSpeechPlayer = {
      isPlaying: false,
      play: playFn,
      stop: vi.fn(),
    };

    render(
      <PhonicsLessonCard
        activeStepIndex={0}
        childGrade={4}
        childId={CHILD_ID}
        contextSentence="Đèn lồng sáng lung linh."
        glossaryService={mockService}
        glossarySpeechPlayer={mockSpeechPlayer}
        lesson={lesson}
      />,
    );

    // 1. Default tab is strictly "Đánh vần" with existing testids intact
    expect(screen.getByTestId("phonics-lesson-card")).toBeInTheDocument();
    expect(screen.getByTestId("phonics-focus-display")).toBeInTheDocument();
    expect(screen.getByTestId("phonics-focus-syllable")).toBeInTheDocument();
    expect(
      screen.getByTestId("phonics-tab-spelling").getAttribute("aria-selected"),
    ).toBe("true");
    expect(mockService.explainWord).not.toHaveBeenCalled();

    // 2. Switch to "Nghĩa & Ví dụ" tab -> fetches explanation
    await user.click(screen.getByTestId("phonics-tab-meaning"));

    await waitFor(() => {
      expect(screen.getByTestId("glossary-definition-text")).toHaveTextContent(
        "Tỏa ánh sáng dịu nhẹ",
      );
    });
    expect(screen.getByTestId("glossary-grade-badge")).toHaveTextContent(
      "Lớp 3–5",
    );
    expect(screen.getByTestId("glossary-nuance-text")).toHaveTextContent(
      "Từ láy âm đầu",
    );
    expect(screen.getByTestId("glossary-example-text")).toHaveTextContent(
      "Đêm hội Trung thu",
    );
    expect(mockService.explainWord).toHaveBeenCalledWith(
      CHILD_ID,
      {
        word: "lung linh",
        context_sentence: "Đèn lồng sáng lung linh.",
        grade_override: 4,
      },
      expect.any(AbortSignal),
    );

    // 3. Listen to TTS reading meaning + example
    await user.click(screen.getByTestId("glossary-listen-tts-btn"));
    expect(playFn).toHaveBeenCalledTimes(1);
    expect(playFn.mock.calls[0]?.[0]).toContain("Từ lung linh");

    // 4. Save to Sổ Từ Hay -> transitions clearly to saved state
    const saveBtn = screen.getByTestId("glossary-save-notebook-btn");
    expect(saveBtn).toHaveAttribute("aria-pressed", "false");
    await user.click(saveBtn);

    await waitFor(() => {
      expect(
        screen.getByTestId("glossary-save-notebook-btn"),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(mockService.saveWord).toHaveBeenCalledWith(
      CHILD_ID,
      expect.objectContaining({
        word: "lung linh",
        grade_band: "GRADE_3_5",
      }),
    );

    // 5. Open Sổ Từ Hay drawer directly from card
    await user.click(screen.getByTestId("glossary-open-notebook-btn"));
    expect(
      await screen.findByTestId("vocabulary-notebook-drawer"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("notebook-word-list")).toHaveTextContent(
      "lung linh",
    );
  });

  it("allows browsing, listening via TTS, and deleting saved words inside VocabularyNotebookDrawer", async () => {
    const user = userEvent.setup();
    const itemA = makeFavoriteItem("lung linh", "11");
    const itemB = makeFavoriteItem("rực rỡ", "12");

    const mockService: VocabularyNotebookService = {
      explainWord: vi.fn(),
      listNotebook: vi.fn(
        async (): Promise<VocabularyNotebookListDTO> => ({
          child_id: CHILD_ID,
          total: 2,
          storytelling_words: ["lung linh", "rực rỡ"],
          items: [itemA, itemB],
        }),
      ),
      saveWord: vi.fn(),
      deleteWord: vi.fn(async (_cid, itemId) => ({
        deleted: true,
        item_id: itemId,
      })),
    };
    const playFn = vi.fn<(text: string, options?: unknown) => Promise<void>>(
      async () => undefined,
    );
    const mockSpeechPlayer = {
      isPlaying: false,
      play: playFn,
      stop: vi.fn(),
    };

    render(
      <VocabularyNotebookDrawer
        childAlias="Bé Na"
        childId={CHILD_ID}
        onClose={vi.fn()}
        open
        service={mockService}
        speechPlayer={mockSpeechPlayer}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("notebook-word-item")).toHaveLength(2);
    });
    expect(screen.getByTestId("notebook-storytelling-bridge")).toHaveTextContent(
      "lung linh, rực rỡ",
    );

    // Listen to "rực rỡ"
    await user.click(screen.getByTestId("notebook-listen-rực rỡ"));
    expect(playFn).toHaveBeenCalledWith(
      expect.stringContaining("Từ rực rỡ"),
      expect.any(Object),
    );

    // Delete "lung linh" -> removed from DOM
    await user.click(screen.getByTestId("notebook-delete-lung linh"));
    await waitFor(() => {
      expect(screen.getAllByTestId("notebook-word-item")).toHaveLength(1);
    });
    expect(mockService.deleteWord).toHaveBeenCalledWith(CHILD_ID, itemA.id);
  });

  it("connects saved Sổ Từ Hay bonus storytelling words to Entertainment Hub, PictureDescription, and MemoryGame", async () => {
    const user = userEvent.setup();
    const item1 = makeFavoriteItem("lung linh", "21");
    const item2 = makeFavoriteItem("thơm ngát", "22");

    const mockVocabService: VocabularyNotebookService = {
      explainWord: vi.fn(),
      listNotebook: vi.fn(
        async (): Promise<VocabularyNotebookListDTO> => ({
          child_id: CHILD_ID,
          total: 2,
          storytelling_words: ["lung linh", "thơm ngát"],
          items: [item1, item2],
        }),
      ),
      saveWord: vi.fn(),
      deleteWord: vi.fn(),
    };

    const primaryRec = {
      game_key: "MEMORY_GAME" as const,
      zone_title_vi: "Khám phá trí nhớ",
      game_title_vi: "Bé nhớ được gì?",
      reason_vi: "Quan sát tranh và kể chuyện sáng tạo.",
      suggested_mode: "FREE_RECALL",
      suggested_difficulty: 2,
      target_words: ["cây tre"],
      href: "/entertainment/memory-game",
      priority: 1,
    };

    const hubRecs: EntertainmentRecommendationsDTO = {
      child_id: CHILD_ID,
      child_alias: "Bé Na",
      child_grade: 2,
      mascot_greeting_vi: "Chào Bé Na!",
      natural_break_reminder_vi: "Nhớ nghỉ mắt nhé!",
      today_activities_count: 1,
      focus_difficult_words: ["cây tre"],
      primary_recommendation: primaryRec,
      recommendations: [primaryRec],
    };

    // 1. Entertainment Hub shows bonus words + Sổ Từ Hay badge
    const hubRender = render(
      <EntertainmentScreen
        initialRecommendations={hubRecs}
        vocabularyService={mockVocabService}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("hub-notebook-bonus-words"),
      ).toHaveTextContent("lung linh");
    });
    expect(screen.getByTestId("hub-notebook-bonus-words")).toHaveTextContent(
      "thơm ngát",
    );
    expect(
      screen.getByTestId("hub-open-vocabulary-notebook-btn"),
    ).toHaveTextContent("2");
    hubRender.unmount();

    // 2. PictureDescription pulls saved words into target_words when starting a picture session
    const createPictureSessionSpy = vi.fn<
      PictureDescriptionService["createSession"]
    >(async (input) => {
      const mergedTargets = [...(input.target_words ?? [])];
      return {
        session_id: TEST_SESSION_ID,
        child_id: CHILD_ID,
        child_grade: 2,
        source_type: "SAMPLE",
        sample_key: "sunny-garden",
        book_id: null,
        book_page_id: null,
        image_url: "/images/picture-description/sunny-garden.jpg",
        scene_title: "Khu vườn đầy nắng",
        status: "ACTIVE",
        best_stars: 0,
        best_score: 0,
        attempts_count: 0,
        target_words: mergedTargets,
        guide: {
          is_child_safe: true,
          scene_title: "Khu vườn đầy nắng",
          scene_summary: "Chú mèo cam nằm trên ghế gỗ.",
          guiding_questions: ["Bé thấy gì trong vườn?"],
          suggested_vocabulary: [
            { word: "nắng mai", hint: "Ánh nắng buổi sớm" },
          ],
          model_sample_sentences: ["Chú mèo nằm dưới nắng mai."],
          target_words: mergedTargets,
        },
        attempts: [],
        created_at: "2026-11-28T07:00:00Z",
        updated_at: "2026-11-28T07:00:00Z",
      };
    });

    const mockPictureService: PictureDescriptionService = {
      getCatalog: vi.fn(async () => ({
        samples: [
          {
            sample_key: "sunny-garden",
            title: "Khu vườn đầy nắng",
            theme: "Thiên nhiên",
            description: "Chú mèo cam ngủ trưa.",
            image_url: "/images/picture-description/sunny-garden.jpg",
          },
        ],
        book_pages: [],
      })),
      listSessions: vi.fn(async () => []),
      getSession: vi.fn(),
      createSession: createPictureSessionSpy,
      evaluate: vi.fn(),
    };

    const testAppServices = buildTestAppServices(mockPictureService);

    const pictureRender = render(
      <AppServicesContext.Provider value={testAppServices}>
        <WithSelectedChild childId={CHILD_ID}>
          <PictureDescriptionScreen vocabularyService={mockVocabService} />
        </WithSelectedChild>
      </AppServicesContext.Provider>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("picture-notebook-word-lung linh"),
      ).toBeInTheDocument();
    });
    const exploreBtn = await screen.findByRole("button", {
      name: /Khám phá tranh này/i,
    });
    await user.click(exploreBtn);
    await waitFor(() => {
      expect(createPictureSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          child_id: CHILD_ID,
          target_words: ["lung linh", "thơm ngát"],
        }),
        expect.any(AbortSignal),
      );
      expect(screen.getByTestId("target-words-panel")).toHaveTextContent(
        "lung linh",
      );
      expect(screen.getByTestId("target-words-panel")).toHaveTextContent(
        "thơm ngát",
      );
    });
    pictureRender.unmount();

    // 3. MemoryGame pulls saved words from Sổ Từ Hay into createSession(focus_words)
    const createSessionSpy = vi.fn(async () => ({
      id: "81000000-0000-4000-8000-000000000001",
      child_id: CHILD_ID,
      child_grade: 2,
      theme_key: "sunny_garden" as const,
      theme_name_vi: "Khu vườn nắng mai",
      difficulty_level: 2,
      scene_seed: 123,
      timer_mode: "30S" as const,
      timer_seconds: 30,
      recall_mode: "FREE_RECALL" as const,
      status: "OBSERVING" as const,
      hints_used: 0,
      peek_count: 0,
      best_factual_score: 0,
      best_creative_score: 0,
      stars: 0,
      attempts_count: 0,
      scene_spec: {
        schema_version: "v4.0",
        theme_key: "sunny_garden" as const,
        theme_name_vi: "Khu vườn nắng mai",
        child_grade: 2,
        difficulty_level: 2,
        scene_seed: 123,
        canvas_width: 800,
        canvas_height: 500,
        backdrop: {
          theme_key: "sunny_garden" as const,
          sky_top_hex: "#BCE8FF",
          sky_bottom_hex: "#FFF8D9",
          horizon_hex: "#A4E48E",
          ground_hex: "#73C66A",
          accent_hex: "#F7B731",
          mood_vi: "Nắng sớm",
        },
        objects: [],
        observation_tips_vi: [],
        guided_questions_vi: [],
        creative_prompt_vi: "Hãy kể câu chuyện tiếp theo!",
        matched_focus_words: ["lung linh"],
        creative_focus_words: ["thơm ngát"],
      },
      attempts: [],
      created_at: "2026-11-28T07:00:00Z",
      updated_at: "2026-11-28T07:00:00Z",
    }));

    const mockMemoryService: MemoryGameService = {
      getThemes: vi.fn(async () => ({
        themes: [
          {
            theme_key: "sunny_garden" as const,
            name_vi: "Khu vườn nắng mai",
            description_vi: "Vườn hoa tươi đẹp",
            badge_vi: "Thiên nhiên",
            accent_hex: "#16A34A",
            sprite_count: 6,
            sample_items_vi: ["hoa"],
          },
        ],
        timer_options: [
          {
            mode: "30S" as const,
            seconds: 30,
            label_vi: "30 giây",
            recommended_for_vi: "Lớp 2",
          },
        ],
        grade_recommendations: [],
        total_sprites: 12,
      })),
      createSession: createSessionSpy,
      listSessions: vi.fn(async () => []),
      getSession: vi.fn(),
      requestHint: vi.fn(),
      recordPeek: vi.fn(),
      submitAttempt: vi.fn(),
    };

    render(
      <AppServicesContext.Provider value={testAppServices}>
        <WithSelectedChild childId={CHILD_ID}>
          <MemoryGameScreen
            service={mockMemoryService}
            vocabularyService={mockVocabService}
          />
        </WithSelectedChild>
      </AppServicesContext.Provider>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("memory-notebook-bonus-words"),
      ).toHaveTextContent("lung linh");
    });

    await user.click(screen.getByTestId("start-memory-game-btn"));
    await waitFor(() => {
      expect(createSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          child_id: CHILD_ID,
          focus_words: ["lung linh", "thơm ngát"],
        }),
      );
    });
  });
});
