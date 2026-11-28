import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { SentenceShooterScreen } from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import type { MemoryGameService } from "@/lib/api/memory-game-service";
import {
  childFixture,
  TEST_BOOK_ID,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import type { EntertainmentRecommendationsDTO } from "@/types/adaptive-learning";
import type {
  MemorySessionDTO,
  MemoryThemesCatalogDTO,
  SceneSpecDTO,
} from "@/types/memory-game";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "mobile-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => ({
    isRecording: false,
    isSpeaking: false,
    audioLevel: 0,
    prepare: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => new Blob(["audio"], { type: "audio/webm" })),
    cancel: vi.fn(),
    getStream: vi.fn(() => null),
    getIsSpeaking: vi.fn(() => false),
    getQuality: vi.fn(() => null),
    getSettings: vi.fn(() => ({})),
  }),
}));

function installMatchMediaController(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.add(listener);
      },
      removeEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => true,
    })),
  );

  return {
    setMobile(nextMatches: boolean) {
      matches = nextMatches;
      for (const listener of listeners) {
        listener({
          matches: nextMatches,
          media: "(max-width: 767px)",
        } as MediaQueryListEvent);
      }
    },
  };
}

function captureImmersiveEvents() {
  const events: boolean[] = [];
  const listener = (event: Event) => {
    const custom = event as CustomEvent<{ active?: boolean }>;
    events.push(Boolean(custom.detail?.active));
  };
  window.addEventListener("viread:immersive-mode", listener);
  return {
    events,
    cleanup: () =>
      window.removeEventListener("viread:immersive-mode", listener),
  };
}

const SECOND_CHILD = {
  ...childFixture,
  id: "22222222-2222-4222-8222-222222222229",
  alias: "Bé Bông",
  grade: 4,
};

const HUB_RECS: EntertainmentRecommendationsDTO = {
  child_id: TEST_CHILD_ID,
  child_alias: childFixture.alias,
  child_grade: childFixture.grade,
  mascot_greeting_vi: "Chào bé yêu!",
  natural_break_reminder_vi: "Nghỉ mắt 5 phút nhé!",
  today_activities_count: 2,
  focus_difficult_words: ["khủng long"],
  primary_recommendation: {
    game_key: "MEMORY_GAME",
    zone_title_vi: "Khám phá trí nhớ",
    game_title_vi: "Bé nhớ được gì?",
    reason_vi: "Quan sát tranh và kể chuyện sáng tạo.",
    suggested_mode: "GUIDED_RECALL",
    suggested_difficulty: 2,
    target_words: ["khủng long"],
    href: "/entertainment/memory-game",
    priority: 1,
  },
  recommendations: [],
};

const sampleSceneSpec: SceneSpecDTO = {
  schema_version: "v4.0",
  theme_key: "sunny_garden",
  theme_name_vi: "Khu vườn nắng mai",
  child_grade: 2,
  difficulty_level: 2,
  scene_seed: 20261125,
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
  objects: [
    {
      id: "obj_1_paper_kite",
      sprite_key: "paper_kite",
      name_vi: "diều giấy",
      category_vi: "đồ chơi",
      aliases_vi: ["diều"],
      color_vi: "đỏ",
      color_hex: "#D63031",
      color_stroke_hex: "#8E1B1B",
      color_light_hex: "#FF8A8A",
      shape_cue: "circle",
      count: 1,
      position_zone: "trên trái",
      bbox: { x: 0.05, y: 0.08, w: 0.24, h: 0.22 },
      action_vi: "đang bay cao",
      hint_tiers: {
        tier_1: "Đồ chơi bay trên trời",
        tier_2: "Góc trên trái màu đỏ",
        tier_3: "Bắt đầu bằng diều g…",
      },
      is_focus_word: true,
    },
  ],
  observation_tips_vi: ["Nhìn từ trên xuống dưới nhé!"],
  guided_questions_vi: ["Bé thấy gì trong tranh?"],
  creative_prompt_vi: "Chuyện gì xảy ra tiếp theo?",
  matched_focus_words: ["diều giấy"],
};

const memoryCatalog: MemoryThemesCatalogDTO = {
  themes: [
    {
      theme_key: "sunny_garden",
      name_vi: "Khu vườn nắng mai",
      description_vi: "Khu vườn rực rỡ nắng sớm.",
      badge_vi: "Thiên nhiên",
      accent_hex: "#F7B731",
      sprite_count: 7,
      sample_items_vi: ["diều giấy"],
    },
  ],
  timer_options: [
    {
      mode: "20S",
      seconds: 20,
      label_vi: "20 giây",
      recommended_for_vi: "Nhịp vừa phải",
    },
  ],
  grade_recommendations: [
    {
      grade: 2,
      min_objects: 5,
      max_objects: 6,
      recommended_timer: "20S",
      recommended_recall_mode: "GUIDED_RECALL",
      recommended_difficulty: 2,
      note_vi: "Lớp 2: 5–6 chi tiết sinh động.",
    },
  ],
  total_sprites: 42,
};

const memorySession: MemorySessionDTO = {
  id: TEST_SESSION_ID,
  child_id: TEST_CHILD_ID,
  child_grade: 2,
  theme_key: "sunny_garden",
  theme_name_vi: "Khu vườn nắng mai",
  difficulty_level: 2,
  scene_seed: 20261125,
  timer_mode: "20S",
  timer_seconds: 20,
  recall_mode: "GUIDED_RECALL",
  status: "OBSERVING",
  hints_used: 0,
  peek_count: 0,
  best_factual_score: 0,
  best_creative_score: 0,
  stars: 0,
  attempts_count: 0,
  scene_spec: sampleSceneSpec,
  attempts: [],
  created_at: "2026-11-25T10:00:00Z",
  updated_at: "2026-11-25T10:00:00Z",
};

describe("Entertainment Hub & Subgames Mobile UI (< 768px)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders mobile-native Entertainment Hub (44px+ controls, min-h-12 selector, <ul> zones without .activity-library > div > article or max-sm:! hacks) and preserves desktop", async () => {
    const media = installMatchMediaController(true);
    const immersive = captureImmersiveEvents();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/profiles/children") {
        return Response.json([childFixture, SECOND_CHILD]);
      }
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path.includes("/recommendations")) {
        return Response.json(HUB_RECS);
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <EntertainmentScreen initialRecommendations={HUB_RECS} />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const selector = await screen.findByTestId("hub-child-selector");
    expect(selector.className).toContain("min-h-12");
    expect(selector.className).not.toContain("min-h-10");

    const section = container.querySelector("section.activity-library");
    expect(section).not.toBeNull();
    expect(section?.className).toContain("pb-4");
    expect(section?.className).not.toContain("pb-24");

    // Header sensory + guide buttons use >= 44px size="touch" with fullWidth={false}, no min-h-10
    for (const label of [
      "Âm thanh dịu",
      "Giảm chuyển động",
      "Hướng dẫn chơi",
    ]) {
      const btn = screen.getByRole("button", { name: label });
      expect(btn.className).toContain("min-h-11");
      expect(btn.className).toContain("w-auto");
      expect(btn.className).not.toContain("min-h-10");
    }

    // Mobile renders 4 zones inside <ul>/<li> bypassing unlayered .activity-library > div > article CSS
    const zoneList = section?.querySelector("ul");
    expect(zoneList).not.toBeNull();
    expect(zoneList?.querySelectorAll("li")).toHaveLength(4);
    expect(section?.querySelectorAll(":scope > div > article")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("max-sm:");

    // Hub stays inside AppShell (never triggers active immersive mode)
    expect(immersive.events.some((active) => active === true)).toBe(false);

    // Switching to desktop restores .activity-library > div > article layout
    act(() => {
      media.setMobile(false);
    });
    expect(section?.querySelector("ul")).toBeNull();
    expect(section?.querySelectorAll(":scope > div > article")).toHaveLength(4);
    expect(container.innerHTML).not.toContain("max-sm:");

    immersive.cleanup();
  });

  it("gates MemoryGameScreen viread:immersive-mode to mobile active stages, hides duplicate back link, and ensures 44px+ targets", async () => {
    installMatchMediaController(true);
    const immersive = captureImmersiveEvents();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === `/profiles/children/${TEST_CHILD_ID}`) {
          return Response.json(childFixture);
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );

    const mockMemoryService: MemoryGameService = {
      getThemes: vi.fn(async () => memoryCatalog),
      listSessions: vi.fn(async () => []),
      getSession: vi.fn(async () => memorySession),
      createSession: vi.fn(async () => memorySession),
      requestHint: vi.fn(),
      recordPeek: vi.fn(),
      submitAttempt: vi.fn(async () => ({
        attempt: {
          id: "attempt-1",
          session_id: TEST_SESSION_ID,
          attempt_number: 1,
          stage: "RECALL" as const,
          input_mode: "TEXT" as const,
          response_text: "diều giấy đỏ",
          factual_score: 80,
          creative_score: 0,
          stars: 3,
          evaluation: {
            stage: "RECALL" as const,
            factual_score: 80,
            creative_score: 0,
            stars: 3,
            matched_facts: [
              {
                object_id: "obj_1_paper_kite",
                sprite_key: "paper_kite",
                name_vi: "diều giấy",
                color_vi: "đỏ",
                count: 1,
                position_zone: "trên trái" as const,
                matched_attributes: ["object" as const],
                detail_vi: "Bé nhớ đúng diều giấy",
                bbox: sampleSceneSpec.objects[0].bbox,
              },
            ],
            missed_facts: [
              {
                object_id: "obj_2_missing",
                sprite_key: "tabby_cat",
                name_vi: "mèo mướp",
                color_vi: "cam",
                count: 1,
                position_zone: "dưới trái" as const,
                detail_vi: "mèo mướp màu cam",
                hint_tier_1: "con vật",
                bbox: sampleSceneSpec.objects[0].bbox,
              },
            ],
            creative_highlights: [],
            story_anchors: [],
            praise_message_vi: "Giỏi lắm!",
            story_praise_vi: "Kể tiếp nhé!",
            next_tip_vi: "Tiếp tục nào!",
            creative_followup_vi: "Chuyện gì tiếp theo?",
            support_summary_vi: null,
            used_focus_words: ["diều giấy"],
            ai_provider: "deterministic-v4",
          },
          ai_provider: "deterministic-v4",
          created_at: "2026-11-25T10:01:00Z",
        },
        session: {
          ...memorySession,
          status: "CREATIVE" as const,
          best_factual_score: 80,
          stars: 3,
        },
      })),
    };

    const { unmount } = render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <MemoryGameScreen service={mockMemoryService} />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const startBtn = await screen.findByTestId("start-memory-game-btn");
    // SETUP stage keeps AppShell visible
    expect(immersive.events.at(-1)).toBe(false);
    // Duplicate inline back link is hidden on mobile (BookChildHeader handles back)
    expect(screen.queryByText("Quay lại góc Giải trí")).toBeNull();
    // Compact single-line step indicator
    expect(screen.getByText("1/6")).toBeInTheDocument();
    // Timer & recall mode touch targets >= 44px
    expect(screen.getByTestId("timer-option-20S").className).toContain(
      "min-h-11",
    );
    expect(
      screen.getByRole("button", { name: /Kể tự do/ }).className,
    ).toContain("min-h-11");

    // Transition to OBSERVE enables mobile immersive mode
    fireEvent.click(startBtn);
    await screen.findByTestId("observe-stage");
    await waitFor(() => {
      expect(immersive.events.at(-1)).toBe(true);
    });
    expect(screen.getByText("2/6")).toBeInTheDocument();

    // Advance to RECALL and verify single-mounted recall-textarea
    fireEvent.click(screen.getByTestId("finish-observe-btn"));
    await screen.findByTestId("recall-stage");
    expect(screen.getAllByTestId("recall-textarea")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("recall-textarea"), {
      target: { value: "diều giấy đỏ" },
    });
    fireEvent.click(screen.getByTestId("submit-recall-btn"));

    // Advance to REVEAL and verify >= 44px fact & viewWholeScene targets
    await screen.findByTestId("reveal-stage");
    const matchedFactBtn = screen.getByTestId("matched-fact-obj_1_paper_kite");
    expect(matchedFactBtn.className).toContain("min-h-11");
    expect(screen.getByTestId("missed-fact-obj_2_missing").className).toContain(
      "min-h-11",
    );
    fireEvent.click(matchedFactBtn);
    expect(
      screen.getByRole("button", { name: "Xem toàn bức tranh" }).className,
    ).toContain("min-h-11");

    // Advance to CREATIVE and verify single-mounted creative-textarea
    fireEvent.click(screen.getByTestId("go-creative-stage-btn"));
    await screen.findByTestId("creative-stage");
    expect(screen.getAllByTestId("creative-textarea")).toHaveLength(1);

    unmount();
    expect(immersive.events.at(-1)).toBe(false);
    immersive.cleanup();
  });

  it("gates PictureDescriptionScreen viread:immersive-mode to mobile active session and keeps controls >= 44px", async () => {
    installMatchMediaController(true);
    const immersive = captureImmersiveEvents();
    const gradeFourChild = { ...childFixture, grade: 4 };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === `/profiles/children/${TEST_CHILD_ID}`) {
          return Response.json(gradeFourChild);
        }
        if (path === "/games/picture-description/catalog") {
          return Response.json({
            samples: [
              {
                sample_key: "sunny-garden",
                title: "Khu vườn đầy nắng",
                theme: "Thiên nhiên",
                description: "Mô tả ngắn",
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
          return Response.json({
            session_id: TEST_SESSION_ID,
            child_id: TEST_CHILD_ID,
            child_grade: 4,
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
            teaching_mode: "OBSERVE",
            target_words: ["mèo mướp"],
            guide: {
              is_child_safe: true,
              scene_title: "Khu vườn đầy nắng",
              scene_summary: "Khu vườn rực rỡ nắng",
              guiding_questions: ["Có con vật nào?"],
              suggested_vocabulary: [
                { word: "mèo mướp", hint: "Chú mèo lông cam" },
              ],
              model_sample_sentences: ["Chú mèo đang ngủ."],
              target_words: ["mèo mướp"],
            },
            attempts: [],
            created_at: "2026-11-25T08:00:00Z",
            updated_at: "2026-11-25T08:00:00Z",
          });
        }
        throw new Error(`Unexpected path: ${path}`);
      }),
    );

    const { unmount } = render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <PictureDescriptionScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const exploreBtn = await screen.findByRole("button", {
      name: "Khám phá tranh này",
    });
    expect(immersive.events.at(-1)).toBe(false);
    expect(screen.queryByText("Quay lại góc Giải trí")).toBeNull();

    fireEvent.click(exploreBtn);
    await screen.findByText("Khu vườn đầy nắng");

    await waitFor(() => {
      expect(immersive.events.at(-1)).toBe(true);
    });

    // Single-mounted textarea
    expect(
      document.querySelectorAll("#picture-description-input"),
    ).toHaveLength(1);

    // Compact mobile image height
    const img = screen.getByAltText("Khu vườn đầy nắng");
    expect(img.className).toContain("max-h-52");

    // 44px+ controls
    expect(screen.getByTestId("toggle-grade-hint-chips").className).toContain(
      "min-h-11",
    );
    expect(
      document.getElementById("tab-picture-practice")?.className,
    ).toContain("min-h-11");
    expect(document.getElementById("tab-picture-result")?.className).toContain(
      "min-h-11",
    );
    const modeButtons = screen
      .getByTestId("teaching-mode-pills")
      .querySelectorAll("button");
    expect(modeButtons).toHaveLength(6);
    modeButtons.forEach((btn) => {
      expect(btn.className).toContain("min-h-11");
    });
    const targetWordBtn = screen
      .getByTestId("target-words-panel")
      .querySelector("button");
    expect(targetWordBtn?.className).toContain("min-h-11");

    unmount();
    expect(immersive.events.at(-1)).toBe(false);
    immersive.cleanup();
  });

  it("gates SentenceShooterScreen viread:immersive-mode to mobile playing mode and upgrades roundComplete listen button to >= 44px", async () => {
    installMatchMediaController(true);
    const immersive = captureImmersiveEvents();

    const tokenId = "21000000-0000-4000-8000-000000000001";
    const roundId = "22000000-0000-4000-8000-000000000001";
    const book = {
      id: TEST_BOOK_ID,
      name: "Sách xạ thủ",
      title: "Sách xạ thủ",
      author: "Tác giả",
      min_grade: 1,
      max_grade: 3,
      available_rounds: 3,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === `/profiles/children/${TEST_CHILD_ID}`) {
          return Response.json(childFixture);
        }
        if (path === "/games/sentence-shooter/books") {
          return Response.json([book]);
        }
        if (path === "/games/sentence-shooter/sessions") {
          return Response.json(
            {
              session_id: TEST_SESSION_ID,
              book,
              difficulty: "easy",
              total_rounds: 3,
              completed_rounds: 0,
              total_stars: 0,
              round: {
                round_id: roundId,
                round_number: 1,
                token_count: 1,
                tokens: [{ id: tokenId, text: "Bé." }],
              },
            },
            { status: 201 },
          );
        }
        if (path.endsWith("/shots")) {
          return Response.json({
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
            completed_sentence: "Bé.",
            message: "Hay lắm!",
          });
        }
        throw new Error(`Unexpected path: ${path}`);
      }),
    );

    const { unmount } = render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <SentenceShooterScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const bookBtn = await screen.findByRole("button", { name: /Sách xạ thủ/ });
    expect(immersive.events.at(-1)).toBe(false);

    fireEvent.click(bookBtn);
    fireEvent.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));

    const wordBtn = await screen.findByRole("button", { name: "Bé." });
    await waitFor(() => {
      expect(immersive.events.at(-1)).toBe(true);
    });

    fireEvent.click(wordBtn);
    const readFullBtn = await screen.findByRole("button", {
      name: "Nghe lại câu hoàn chỉnh",
    });
    expect(readFullBtn.className).toContain("min-h-11");
    expect(readFullBtn.className).not.toContain("min-h-10");

    unmount();
    expect(immersive.events.at(-1)).toBe(false);
    immersive.cleanup();
  });
});
