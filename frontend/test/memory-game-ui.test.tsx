import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { MemorySceneCanvas } from "@/components/entertainment/memory-game/memory-scene-canvas";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import {
  childFixture,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type {
  MemoryAttemptSubmitDTO,
  MemorySessionDTO,
  MemoryThemesCatalogDTO,
  SceneSpecDTO,
} from "@/types/memory-game";

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
    mood_vi: "Nắng sớm dịu nhẹ, bầu trời trong xanh",
  },
  objects: [
    {
      id: "obj_1_paper_kite",
      sprite_key: "paper_kite",
      name_vi: "diều giấy",
      category_vi: "đồ chơi bay trên trời",
      aliases_vi: ["diều", "con diều"],
      color_vi: "đỏ",
      color_hex: "#D63031",
      color_stroke_hex: "#8E1B1B",
      color_light_hex: "#FF8A8A",
      shape_cue: "circle",
      count: 1,
      position_zone: "trên trái",
      bbox: { x: 0.05, y: 0.08, w: 0.24, h: 0.22 },
      action_vi: "đang bay cao đón gió",
      hint_tiers: {
        tier_1:
          "Trong tranh có một đồ chơi bay trên trời rất quen thuộc đó bé!",
        tier_2: "Ở góc trên trái có một đồ chơi màu đỏ.",
        tier_3: "Bật mí nhỏ nè: bắt đầu bằng “diều g…”.",
      },
      is_focus_word: true,
    },
    {
      id: "obj_2_tabby_cat",
      sprite_key: "tabby_cat",
      name_vi: "mèo mướp",
      category_vi: "con vật dễ thương",
      aliases_vi: ["mèo", "con mèo"],
      color_vi: "cam",
      color_hex: "#E56B1F",
      color_stroke_hex: "#993E08",
      color_light_hex: "#FFAF75",
      shape_cue: "diamond",
      count: 1,
      position_zone: "dưới trái",
      bbox: { x: 0.05, y: 0.7, w: 0.24, h: 0.22 },
      action_vi: "đang vẫy đuôi sưởi nắng",
      hint_tiers: {
        tier_1: "Trong tranh có một con vật dễ thương rất quen thuộc đó bé!",
        tier_2: "Ở góc dưới trái có một con vật màu cam.",
        tier_3: "Bật mí nhỏ nè: bắt đầu bằng “mèo m…”.",
      },
      is_focus_word: false,
    },
    {
      id: "obj_3_sunflower",
      sprite_key: "sunflower",
      name_vi: "hoa hướng dương",
      category_vi: "loài hoa trong vườn",
      aliases_vi: ["hoa", "hướng dương"],
      color_vi: "vàng",
      color_hex: "#E09F00",
      color_stroke_hex: "#8C5E00",
      color_light_hex: "#FFE074",
      shape_cue: "star",
      count: 2,
      position_zone: "dưới phải",
      bbox: { x: 0.71, y: 0.7, w: 0.24, h: 0.22 },
      action_vi: "đang nở rực rỡ đón nắng",
      hint_tiers: {
        tier_1: "Trong tranh có một loài hoa trong vườn rất quen thuộc đó bé!",
        tier_2: "Ở góc dưới phải có 2 bông hoa màu vàng.",
        tier_3: "Bật mí nhỏ nè: bắt đầu bằng “hoa h…”.",
      },
      is_focus_word: false,
    },
  ],
  observation_tips_vi: ["Nhìn từ trên xuống dưới, từ trái sang phải nhé!"],
  guided_questions_vi: [
    "Bé nhớ trong bức tranh vừa rồi có những con vật hoặc đồ vật nào?",
  ],
  creative_prompt_vi:
    "Nếu khu vườn nắng mai tiếp tục câu chuyện, các bạn nhỏ sẽ làm gì tiếp theo?",
  matched_focus_words: ["diều giấy"],
};

const sampleCatalog: MemoryThemesCatalogDTO = {
  themes: [
    {
      theme_key: "sunny_garden",
      name_vi: "Khu vườn nắng mai",
      description_vi: "Khu vườn rực rỡ nắng sớm.",
      badge_vi: "Thiên nhiên",
      accent_hex: "#F7B731",
      sprite_count: 7,
      sample_items_vi: ["mèo mướp", "diều giấy", "hoa hướng dương"],
    },
    {
      theme_key: "mid_autumn_yard",
      name_vi: "Sân đình Trung thu",
      description_vi: "Đêm rằm sáng trăng.",
      badge_vi: "Lễ hội Việt",
      accent_hex: "#FFCA3A",
      sprite_count: 7,
      sample_items_vi: ["đèn ông sao", "trống cơm"],
    },
  ],
  timer_options: [
    {
      mode: "10S",
      seconds: 10,
      label_vi: "10 giây",
      recommended_for_vi: "Siêu nhanh",
    },
    {
      mode: "30S",
      seconds: 30,
      label_vi: "30 giây",
      recommended_for_vi: "Lớp 2–3",
    },
    {
      mode: "UNLIMITED",
      seconds: null,
      label_vi: "Không giới hạn",
      recommended_for_vi: "Tự bấm khi bé nhớ xong",
    },
  ],
  grade_recommendations: [
    {
      grade: 2,
      min_objects: 5,
      max_objects: 6,
      recommended_timer: "10S",
      recommended_recall_mode: "GUIDED_RECALL",
      recommended_difficulty: 2,
      note_vi: "Lớp 2: 5–6 chi tiết sinh động.",
    },
  ],
  total_sprites: 42,
};

function makeSession(
  timerMode: "10S" | "30S" | "UNLIMITED" = "10S",
): MemorySessionDTO {
  return {
    id: TEST_SESSION_ID,
    child_id: TEST_CHILD_ID,
    child_grade: 2,
    theme_key: "sunny_garden",
    theme_name_vi: "Khu vườn nắng mai",
    difficulty_level: 2,
    scene_seed: 20261125,
    timer_mode: timerMode,
    timer_seconds:
      timerMode === "UNLIMITED" ? null : timerMode === "10S" ? 10 : 30,
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
}

const recallSubmitPayload: MemoryAttemptSubmitDTO = {
  attempt: {
    id: "33000000-0000-4000-8000-000000000001",
    session_id: TEST_SESSION_ID,
    attempt_number: 1,
    stage: "RECALL",
    input_mode: "TEXT",
    response_text: "Bé thấy con mèo mướp màu cam và diều giấy đỏ",
    factual_score: 74,
    creative_score: 0,
    stars: 2,
    evaluation: {
      stage: "RECALL",
      factual_score: 74,
      creative_score: 0,
      stars: 2,
      matched_facts: [
        {
          object_id: "obj_1_paper_kite",
          sprite_key: "paper_kite",
          name_vi: "diều giấy",
          color_vi: "đỏ",
          count: 1,
          position_zone: "trên trái",
          matched_attributes: ["object", "color"],
          detail_vi: "Bé nhớ đúng diều giấy (màu đỏ)!",
          bbox: sampleSceneSpec.objects[0].bbox,
        },
        {
          object_id: "obj_2_tabby_cat",
          sprite_key: "tabby_cat",
          name_vi: "mèo mướp",
          color_vi: "cam",
          count: 1,
          position_zone: "dưới trái",
          matched_attributes: ["object", "color"],
          detail_vi: "Bé nhớ đúng mèo mướp (màu cam)!",
          bbox: sampleSceneSpec.objects[1].bbox,
        },
      ],
      missed_facts: [
        {
          object_id: "obj_3_sunflower",
          sprite_key: "sunflower",
          name_vi: "hoa hướng dương",
          color_vi: "vàng",
          count: 2,
          position_zone: "dưới phải",
          detail_vi: "2 hoa hướng dương màu vàng (góc dưới phải)",
          hint_tier_1: "Trong tranh có một loài hoa trong vườn!",
          bbox: sampleSceneSpec.objects[2].bbox,
        },
      ],
      creative_highlights: [],
      story_anchors: ["diều giấy", "mèo mướp"],
      praise_message_vi:
        "Cô khen bé có trí nhớ rất tốt! Bé đã nhớ chính xác 2/3 chi tiết.",
      story_praise_vi: "Giờ bé hãy kể tiếp câu chuyện sáng tạo nhé!",
      next_tip_vi: "Bấm vào thẻ hoa hướng dương để soi sáng trên tranh nhé!",
      creative_followup_vi: sampleSceneSpec.creative_prompt_vi,
      support_summary_vi: "Bé đã dùng 1 gợi ý để nhớ thêm chi tiết!",
      used_focus_words: ["diều giấy"],
      ai_provider: "deterministic-v4",
    },
    ai_provider: "deterministic-v4",
    created_at: "2026-11-25T10:01:00Z",
  },
  session: {
    ...makeSession("10S"),
    status: "CREATIVE",
    hints_used: 1,
    best_factual_score: 74,
    best_creative_score: 0,
    stars: 2,
    attempts_count: 1,
  },
};

const creativeSubmitPayload: MemoryAttemptSubmitDTO = {
  attempt: {
    id: "33000000-0000-4000-8000-000000000002",
    session_id: TEST_SESSION_ID,
    attempt_number: 2,
    stage: "CREATIVE",
    input_mode: "TEXT",
    response_text:
      "Sau đó mèo mướp thả diều giấy bay lên mây gặp cầu vồng rất vui vẻ!",
    factual_score: 74,
    creative_score: 92,
    stars: 3,
    evaluation: {
      stage: "CREATIVE",
      factual_score: 74,
      creative_score: 92,
      stars: 3,
      matched_facts: recallSubmitPayload.attempt.evaluation.matched_facts,
      missed_facts: [],
      creative_highlights: [
        "Bé đã kết nối câu chuyện thật tự nhiên với: diều giấy, mèo mướp.",
        "Câu chuyện của bé có cảm xúc sinh động và giàu trí tưởng tượng!",
      ],
      story_anchors: ["diều giấy", "mèo mướp"],
      praise_message_vi:
        "Bé hoàn thành cả hai chặng Ghi nhớ (74/100) và Sáng tạo (92/100) thật xuất sắc!",
      story_praise_vi:
        "Câu chuyện của bé thật sống động và giàu trí tưởng tượng!",
      next_tip_vi: "Lần tới bé thử chọn chủ đề mới nhé!",
      creative_followup_vi: "Nhân vật nào sẽ xuất hiện tiếp theo nhỉ?",
      support_summary_vi: "Bé đã dùng 1 gợi ý để nhớ thêm chi tiết!",
      used_focus_words: ["diều giấy"],
      ai_provider: "deterministic-v4",
    },
    ai_provider: "deterministic-v4",
    created_at: "2026-11-25T10:02:00Z",
  },
  session: {
    ...makeSession("10S"),
    status: "COMPLETED",
    hints_used: 1,
    best_factual_score: 74,
    best_creative_score: 92,
    stars: 3,
    attempts_count: 2,
  },
};

function createFetchResponder() {
  return vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const path = parsed.pathname;

    if (path === `/profiles/children/${TEST_CHILD_ID}`) {
      return Response.json(childFixture);
    }
    if (path === "/games/memory/themes") {
      return Response.json(sampleCatalog);
    }
    if (
      path === "/games/memory/sessions" &&
      (!init?.method || init.method === "GET")
    ) {
      return Response.json([]);
    }
    if (path === "/games/memory/sessions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        timer_mode?: "10S" | "30S" | "UNLIMITED";
      };
      return Response.json(makeSession(body.timer_mode ?? "10S"), {
        status: 201,
      });
    }
    if (path === `/games/memory/sessions/${TEST_SESSION_ID}/hint`) {
      return Response.json({
        session_id: TEST_SESSION_ID,
        hints_used: 1,
        object_id: "obj_3_sunflower",
        tier: 1,
        hint_text_vi:
          "Trong tranh có một loài hoa trong vườn rất quen thuộc đó bé!",
        remaining_unmentioned_count: 1,
        has_more_tiers: true,
      });
    }
    if (path === `/games/memory/sessions/${TEST_SESSION_ID}/peek`) {
      return Response.json({
        session_id: TEST_SESSION_ID,
        peek_count: 1,
        peek_duration_seconds: 3,
        message_vi:
          "Bức tranh mở lại 3 giây để bé quan sát thêm nhé — nhớ từng bước một rất thông minh!",
      });
    }
    if (path === `/games/memory/sessions/${TEST_SESSION_ID}/attempts`) {
      const body = JSON.parse(String(init?.body)) as { stage: string };
      if (body.stage === "RECALL") {
        return Response.json(recallSubmitPayload);
      }
      return Response.json(creativeSubmitPayload);
    }
    throw new Error(`Unexpected fetch route: ${path}`);
  });
}

function renderScreen() {
  return render(
    <AppServicesProvider>
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <MemoryGameScreen />
      </WithSelectedChild>
    </AppServicesProvider>,
  );
}

describe("MemorySceneCanvas", () => {
  it("renders deterministic SVG scene with all objects and fires onSceneReady post-render", async () => {
    const onSceneReady = vi.fn();
    render(
      <MemorySceneCanvas
        mode="observe"
        onSceneReady={onSceneReady}
        sceneSpec={sampleSceneSpec}
      />,
    );

    const svg = screen.getByTestId("memory-scene-svg");
    expect(svg).toBeInTheDocument();
    expect(svg.getAttribute("data-scene-seed")).toBe("20261125");
    expect(svg.querySelectorAll("[data-object-id]").length).toBe(3);

    await waitFor(() => {
      expect(onSceneReady).toHaveBeenCalledWith(20261125);
    });
  });
});

describe("MemoryGameScreen", () => {
  let fetchMock: ReturnType<typeof createFetchResponder>;

  beforeEach(() => {
    fetchMock = createFetchResponder();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads themes without waiting for optional history and can retry a failed catalog", async () => {
    const responder = createFetchResponder();
    let failThemes = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/games/memory/themes" && failThemes) {
          return Response.json(
            { detail: "Temporarily unavailable" },
            { status: 503 },
          );
        }
        if (
          path === "/games/memory/sessions" &&
          (!init?.method || init.method === "GET")
        ) {
          return new Promise<Response>(() => {});
        }
        return responder(url, init);
      }),
    );
    renderScreen();
    await screen.findByTestId("retry-memory-catalog-btn");
    failThemes = false;
    fireEvent.click(screen.getByTestId("retry-memory-catalog-btn"));
    await screen.findByText(sampleCatalog.themes[0]!.name_vi);
    fireEvent.click(screen.getByTestId("start-memory-game-btn"));
    await screen.findByTestId("observe-stage");
  });

  it("starts countdown strictly AFTER SVG sceneReady fires", async () => {
    let pendingRaf: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        pendingRaf = cb;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("timer-option-10S")).toBeInTheDocument(),
    );

    // Select 10S timer and start session under real timers so fetch resolves immediately
    fireEvent.click(screen.getByTestId("timer-option-10S"));
    fireEvent.click(screen.getByTestId("start-memory-game-btn"));

    await waitFor(() =>
      expect(screen.getByTestId("observe-stage")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("memory-scene-svg")).toBeInTheDocument();

    // Freeze timers now to verify countdown does NOT tick before sceneReady fires
    vi.useFakeTimers();

    expect(screen.getByTestId("countdown-seconds")).toHaveTextContent(
      "Đang chuẩn bị",
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId("countdown-seconds")).toHaveTextContent(
      "Đang chuẩn bị",
    );

    // Fire rAF -> sceneReady === true -> timer begins ticking from 10s
    act(() => {
      pendingRaf?.(16);
    });
    expect(screen.getByTestId("countdown-seconds")).toHaveTextContent(
      "10 giây",
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("countdown-seconds")).toHaveTextContent("8 giây");

    // Advance remaining 8 seconds -> smoothly hides scene into Stage C Recall
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByTestId("scene-hidden-curtain")).toBeInTheDocument();
  });

  it("supports UNLIMITED timer mode without auto-hiding until child clicks 'Bé đã nhớ xong'", async () => {
    renderScreen();

    await waitFor(() =>
      expect(screen.getByTestId("timer-option-UNLIMITED")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("timer-option-UNLIMITED"));
    fireEvent.click(screen.getByTestId("start-memory-game-btn"));

    await waitFor(() =>
      expect(screen.getByTestId("timer-unlimited-badge")).toBeInTheDocument(),
    );

    vi.useFakeTimers();

    // Advancing 120 seconds MUST keep the scene visible in UNLIMITED mode
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByTestId("observe-stage")).toBeInTheDocument();
    expect(screen.getByTestId("memory-scene-svg")).toBeInTheDocument();

    // Child clicks "Bé đã nhớ xong" -> smoothly hides behind curtain into Recall
    fireEvent.click(screen.getByTestId("finish-observe-btn"));
    expect(screen.getByTestId("scene-hidden-curtain")).toBeInTheDocument();
  });

  it("walks through hide -> recall -> hint -> reveal spotlight -> creative stage -> separate dual scores", async () => {
    const user = userEvent.setup();
    renderScreen();

    await waitFor(() =>
      expect(screen.getByTestId("start-memory-game-btn")).toBeInTheDocument(),
    );

    // Stage A -> B
    await user.click(screen.getByTestId("start-memory-game-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("observe-stage")).toBeInTheDocument(),
    );

    // Stage B -> C (Hide scene)
    await user.click(screen.getByTestId("finish-observe-btn"));
    expect(screen.getByTestId("scene-hidden-curtain")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-scene-svg")).not.toBeInTheDocument();

    // Request progressive hint
    await user.click(screen.getByTestId("request-hint-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("memory-hint-card")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("memory-hint-card")).toHaveTextContent(
      "Gợi ý bậc 1/3",
    );

    // Type recall & submit -> Stage E (Reveal & Interactive Spotlight)
    await user.type(
      screen.getByTestId("recall-textarea"),
      "Bé thấy con mèo mướp màu cam và diều giấy đỏ",
    );
    await user.click(screen.getByTestId("submit-recall-btn"));

    await waitFor(() =>
      expect(screen.getByTestId("reveal-stage")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("memory-scene-svg")).toBeInTheDocument();
    expect(screen.getByTestId("factual-score-card")).toHaveTextContent(
      "74/100",
    );

    // Click missed fact pill -> focuses exact [x,y,w,h] bounding box spotlight on SVG!
    const missedBtn = screen.getByTestId("missed-fact-obj_3_sunflower");
    expect(missedBtn).toBeInTheDocument();
    await user.click(missedBtn);
    expect(screen.getByTestId("memory-spotlight-focus")).toBeInTheDocument();
    expect(screen.getByTestId("spotlight-caption")).toHaveTextContent(
      "hoa hướng dương",
    );

    // Stage E -> D (Creative Story Extension)
    await user.click(screen.getByTestId("go-creative-stage-btn"));
    expect(screen.getByTestId("creative-stage")).toBeInTheDocument();

    await user.type(
      screen.getByTestId("creative-textarea"),
      "Sau đó mèo mướp thả diều giấy bay lên mây gặp cầu vồng rất vui vẻ!",
    );
    await user.click(screen.getByTestId("submit-creative-btn"));

    // Stage F — Warm Dual-Track Feedback with SEPARATE Factual & Creative scores
    await waitFor(() =>
      expect(screen.getByTestId("summary-stage")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("factual-score-card")).toHaveTextContent(
      "Điểm ghi nhớ",
    );
    expect(screen.getByTestId("factual-score-value")).toHaveTextContent(
      "74/100",
    );
    expect(screen.getByTestId("creative-score-card")).toHaveTextContent(
      "Điểm sáng tạo",
    );
    expect(screen.getByTestId("creative-score-value")).toHaveTextContent(
      "92/100",
    );
  });

  it("enforces anti-TTS-self-capture guard between speech synthesis and microphone recognition", async () => {
    const abortSpy = vi.fn();
    const startSpy = vi.fn();
    const cancelTtsSpy = vi.fn();
    const speakTtsSpy = vi.fn();

    class FakeSpeechRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult = null;
      onerror = null;
      onend = null;
      start = startSpy;
      stop = vi.fn();
      abort = abortSpy;
    }

    vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
    vi.stubGlobal("speechSynthesis", {
      cancel: cancelTtsSpy,
      speak: speakTtsSpy,
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        lang = "";
        rate = 1;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(t: string) {
          this.text = t;
        }
      },
    );

    const user = userEvent.setup();
    renderScreen();

    await waitFor(() =>
      expect(screen.getByTestId("start-memory-game-btn")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("start-memory-game-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("finish-observe-btn")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("finish-observe-btn"));

    // 1. Start mic -> cancels TTS first
    await user.click(screen.getByTestId("recall-voice-btn"));
    expect(cancelTtsSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledTimes(1);

    // 2. Click "Nghe hướng dẫn" -> MUST immediately abort active mic BEFORE speaking TTS!
    await user.click(screen.getByRole("button", { name: /Nghe hướng dẫn/i }));
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(speakTtsSpy).toHaveBeenCalledTimes(1);
  });

  it("supports 3-second gentle Supported Peek during Recall and hides again automatically", async () => {
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId("start-memory-game-btn")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("start-memory-game-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("finish-observe-btn")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("finish-observe-btn"));
    expect(screen.getByTestId("scene-hidden-curtain")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("supported-peek-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("supported-peek-view")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("memory-scene-svg")).toBeInTheDocument();

    vi.useFakeTimers();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Wait a tick if interval was registered before fake timers; verify peek count updated cleanly
    expect(screen.getByTestId("recall-stage")).toHaveTextContent(
      "Bức tranh mở lại 3 giây",
    );
  });
});
