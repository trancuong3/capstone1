import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { MemorySceneCanvas } from "@/components/entertainment/memory-game/memory-scene-canvas";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { SentenceShooterScreen } from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
import { playShooterSound } from "@/components/entertainment/sentence-shooter/sound-engine";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  ENTERTAINMENT_PREFERENCES_STORAGE_KEY,
  getEntertainmentPreferences,
  setEntertainmentPreferences,
  useEntertainmentPreferences,
} from "@/hooks/use-entertainment-preferences";
import type { EntertainmentRecommendationsDTO } from "@/types/adaptive-learning";
import type { ChildProfileDTO } from "@/types/child";
import type { MemoryThemesCatalogDTO, SceneSpecDTO } from "@/types/memory-game";
import {
  TEST_BOOK_ID,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
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
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => ({
    isRecording: false,
    isSpeaking: false,
    audioLevel: 0,
    prepare: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => new Blob(["fake-audio"], { type: "audio/webm" })),
    cancel: vi.fn(),
    getStream: vi.fn(() => null),
    getIsSpeaking: vi.fn(() => false),
    getQuality: vi.fn(() => null),
    getSettings: vi.fn(() => ({})),
  }),
}));

const CHILD_ONE: ChildProfileDTO = {
  id: TEST_CHILD_ID,
  parent_id: "10000000-0000-4000-8000-000000000001",
  alias: "Bé An",
  grade: 1,
  settings: {},
  created_at: "2026-10-01T00:00:00Z",
};

const CHILD_TWO_ID = "11000000-0000-4000-8000-000000000099";
const CHILD_TWO: ChildProfileDTO = {
  id: CHILD_TWO_ID,
  parent_id: "10000000-0000-4000-8000-000000000001",
  alias: "Bé Bình",
  grade: 4,
  settings: {},
  created_at: "2026-10-02T00:00:00Z",
};

const sampleSceneSpec: SceneSpecDTO = {
  schema_version: "v4.0",
  theme_key: "sunny_garden",
  theme_name_vi: "Khu vườn nắng mai",
  child_grade: 4,
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
      category_vi: "đồ chơi bay trên trời",
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
        tier_1: "Gợi ý 1",
        tier_2: "Gợi ý 2",
        tier_3: "Gợi ý 3",
      },
      is_focus_word: true,
    },
  ],
  observation_tips_vi: ["Quan sát từ trên xuống dưới."],
  guided_questions_vi: ["Bé thấy gì trong tranh?"],
  creative_prompt_vi: "Điều gì xảy ra tiếp theo?",
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
      mode: "10S",
      seconds: 10,
      label_vi: "10 giây",
      recommended_for_vi: "Lớp 1–2",
    },
  ],
  grade_recommendations: [
    {
      grade: 4,
      min_objects: 6,
      max_objects: 7,
      recommended_timer: "10S",
      recommended_recall_mode: "GUIDED_RECALL",
      recommended_difficulty: 2,
      note_vi: "Lớp 4: Tự tin quan sát nhé!",
    },
  ],
  total_sprites: 10,
};

function makeRecommendationPayload(
  child: ChildProfileDTO,
): EntertainmentRecommendationsDTO {
  const focusWord = child.id === CHILD_TWO_ID ? "bình minh" : "nắng mai";
  return {
    child_id: child.id,
    child_alias: child.alias,
    child_grade: child.grade,
    mascot_greeting_vi: `Chào ${child.alias}! Hôm nay mình học vui nhé!`,
    natural_break_reminder_vi: "Nghỉ mắt nhẹ sau 15 phút nhé!",
    today_activities_count: 1,
    focus_difficult_words: [focusWord],
    primary_recommendation: {
      game_key: "PICTURE_DESCRIPTION",
      zone_title_vi: "Góc kể chuyện",
      game_title_vi: "Kể chuyện qua tranh",
      reason_vi: `Gợi ý dành riêng cho ${child.alias}`,
      suggested_mode: "GUIDED_STORY",
      suggested_difficulty: 1,
      target_words: [focusWord],
      href: "/entertainment/picture-description",
      priority: 1,
    },
    recommendations: [],
  };
}

function PreferenceProbe() {
  const { reducedMotion, calmSound } = useEntertainmentPreferences();
  return (
    <div
      data-calm-sound={String(calmSound)}
      data-reduced-motion={String(reducedMotion)}
      data-testid="pref-probe"
    />
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  navigation.replace.mockReset();
  navigation.push.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/profiles/children") {
      return Response.json([CHILD_ONE, CHILD_TWO]);
    }
    if (path === `/profiles/children/${CHILD_ONE.id}`) {
      return Response.json(CHILD_ONE);
    }
    if (path === `/profiles/children/${CHILD_TWO_ID}`) {
      return Response.json(CHILD_TWO);
    }
    if (path === `/learning/children/${CHILD_ONE.id}/recommendations`) {
      return Response.json(makeRecommendationPayload(CHILD_ONE));
    }
    if (path === `/learning/children/${CHILD_TWO_ID}/recommendations`) {
      return Response.json(makeRecommendationPayload(CHILD_TWO));
    }
    if (path === "/games/sentence-shooter/books") {
      return Response.json([
        {
          id: TEST_BOOK_ID,
          name: "Sách xạ thủ",
          title: "Sách xạ thủ",
          author: "Tác giả kiểm thử",
          min_grade: 1,
          max_grade: 5,
          available_rounds: 3,
        },
      ]);
    }
    if (path === "/games/picture-description/catalog") {
      return Response.json({ samples: [], book_pages: [] });
    }
    if (path === "/games/picture-description/sessions") {
      return Response.json([]);
    }
    if (path === "/games/memory/themes") {
      return Response.json(memoryCatalog);
    }
    if (path === "/games/memory/sessions") {
      return Response.json([]);
    }
    throw new Error(`Unexpected URL in test: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("P2-4: Entertainment preferences, multi-child selection & propagation", () => {
  it("defaults reducedMotion from OS prefers-reduced-motion and syncs storage + custom events", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    expect(getEntertainmentPreferences()).toEqual({
      reducedMotion: true,
      calmSound: true,
      autopilotEnabled: true,
    });

    render(<PreferenceProbe />);
    expect(screen.getByTestId("pref-probe")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    );
    expect(screen.getByTestId("pref-probe")).toHaveAttribute(
      "data-calm-sound",
      "true",
    );

    act(() => {
      setEntertainmentPreferences({ reducedMotion: false, calmSound: false });
    });

    await waitFor(() => {
      expect(screen.getByTestId("pref-probe")).toHaveAttribute(
        "data-reduced-motion",
        "false",
      );
      expect(screen.getByTestId("pref-probe")).toHaveAttribute(
        "data-calm-sound",
        "false",
      );
    });

    expect(
      JSON.parse(
        window.localStorage.getItem(ENTERTAINMENT_PREFERENCES_STORAGE_KEY) ||
          "{}",
      ),
    ).toEqual({
      reducedMotion: false,
      calmSound: false,
      autopilotEnabled: true,
    });

    act(() => {
      window.localStorage.setItem(
        ENTERTAINMENT_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ reducedMotion: true, calmSound: true }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: ENTERTAINMENT_PREFERENCES_STORAGE_KEY,
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("pref-probe")).toHaveAttribute(
        "data-reduced-motion",
        "true",
      );
      expect(screen.getByTestId("pref-probe")).toHaveAttribute(
        "data-calm-sound",
        "true",
      );
    });
  });

  it("uses validated selected child instead of children[0] and updates recommendations when switching child", async () => {
    const user = userEvent.setup();

    render(
      <AppServicesProvider>
        <WithSelectedChild childId={CHILD_TWO_ID}>
          <EntertainmentScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const selector = (await screen.findByTestId(
      "hub-child-selector",
    )) as HTMLSelectElement;
    expect(selector.className).toContain("min-h-12");
    expect(selector.value).toBe(CHILD_TWO_ID);

    await screen.findByText(/Chào Bé Bình/i);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          `/learning/children/${CHILD_TWO_ID}/recommendations`,
        ),
      ),
    ).toBe(true);

    await user.selectOptions(selector, CHILD_ONE.id);

    await screen.findByText(/Chào Bé An/i);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes(
            `/learning/children/${CHILD_ONE.id}/recommendations`,
          ),
        ),
      ).toBe(true);
    });
  });

  it("propagates Hub reducedMotion and calmSound preferences across Picture Description, Sentence Shooter, and Memory Game", async () => {
    const user = userEvent.setup();

    const { container } = render(
      <AppServicesProvider>
        <WithSelectedChild childId={CHILD_TWO_ID}>
          <EntertainmentScreen />
          <PictureDescriptionScreen />
          <SentenceShooterScreen />
          <MemoryGameScreen />
          <MemorySceneCanvas
            mode="observe"
            reducedMotion={false}
            sceneSpec={sampleSceneSpec}
          />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    await screen.findByTestId("hub-child-selector");
    await screen.findByTestId("memory-game-screen");

    const reduceMotionBtn = screen.getByRole("button", {
      name: /Giảm chuyển động/i,
    });
    const calmSoundBtns = screen.getAllByRole("button", {
      name: /Âm thanh dịu/i,
    });

    await user.click(reduceMotionBtn);
    await user.click(calmSoundBtns[0]);

    await waitFor(() => {
      const reducedSections = container.querySelectorAll(
        'section[data-reduced-motion="true"][data-calm-sound="false"]',
      );
      expect(reducedSections.length).toBeGreaterThanOrEqual(4);
    });

    const oscillatorSpy = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        createOscillator() {
          oscillatorSpy();
          return {
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
            frequency: {
              setValueAtTime: vi.fn(),
              linearRampToValueAtTime: vi.fn(),
            },
            type: "sine",
          };
        }
        createGain() {
          return {
            connect: vi.fn(),
            gain: {
              setValueAtTime: vi.fn(),
              exponentialRampToValueAtTime: vi.fn(),
            },
          };
        }
        get currentTime() {
          return 0;
        }
      },
    );
    playShooterSound("correct", true, {
      calmSound: false,
      reducedMotion: true,
    });
    expect(oscillatorSpy).not.toHaveBeenCalled();

    const { container: reducedCanvasContainer } = render(
      <MemorySceneCanvas
        mode="observe"
        reducedMotion
        sceneSpec={sampleSceneSpec}
      />,
    );
    expect(
      reducedCanvasContainer.querySelector('[data-reduced-motion="true"]'),
    ).not.toBeNull();
  });
});
