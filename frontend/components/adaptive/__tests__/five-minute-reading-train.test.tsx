import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

expect.extend(jestDomMatchers);

import { FiveMinuteTrainCtaCard } from "@/components/adaptive/five-minute-train-cta-card";
import { FiveMinuteReadingTrain } from "@/components/adaptive/five-minute-reading-train";
import type { AdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import type {
  DailyFiveMinuteTrainCompleteResponseDTO,
  DailyFiveMinuteTrainDTO,
} from "@/types/adaptive-learning";
import type { ChildProfileDTO } from "@/types/child";

const MOCK_CHILD: ChildProfileDTO = {
  id: "00000000-0000-0000-0000-000000000011",
  parent_id: "00000000-0000-0000-0000-000000000001",
  alias: "Bé An",
  grade: 2,
  settings: {},
  created_at: "2026-11-28T07:00:00Z",
};

const MOCK_TRAIN_PLAN: DailyFiveMinuteTrainDTO = {
  train_id: "train-00000000-0000-0000-0000-000000000011-2026-11-28",
  visibility: "PARENT_PRIVATE",
  child_id: MOCK_CHILD.id,
  child_alias: "Bé An",
  child_grade: 2,
  total_estimated_seconds: 300,
  is_cold_start: false,
  completed_today: false,
  today_completed_count: 0,
  greeting_vi:
    "Chào Bé An! Lên chuyến tàu 5 phút cùng cô để khởi động 3 toa thật nhẹ nhàng nhé!",
  no_mic_support_note_vi:
    "Nếu tạm không tiện bật mic, ba mẹ và bé có thể dùng chế độ Nghe & Chạm.",
  natural_break_cue_vi:
    "Hoàn thành ~5 phút hôm nay là vừa đẹp rồi! Bé An nhớ nhìn xa thư giãn mắt nhé.",
  disclaimer_vi:
    "Tổng hợp này phản ánh các lượt luyện tập thực tế; không phải bài kiểm tra IQ.",
  car_1_warmup: {
    car_number: 1,
    car_key: "WARMUP_WORDS",
    title_vi: "Toa 1: Khởi động từ khó",
    subtitle_vi: 'Ôn nhẹ 2 từ thuộc nhóm "Âm đầu tr / ch" cùng Cô giáo AI.',
    estimated_seconds: 90,
    dominant_phonics_category: "tr_ch",
    dominant_phonics_label_vi: "Âm đầu tr / ch",
    target_words: [
      {
        normalized_word: "chim se",
        display_text: "chim sẻ",
        phonics_category: "tr_ch",
        phonics_label_vi: "Âm đầu tr / ch",
        syllable_hint_vi:
          "Tách tiếng: chim · sẻ — Cong đầu lưỡi khi đọc tr, bật nhẹ mặt lưỡi khi đọc ch.",
        sample_sentence_vi: "Chú chim sẻ nhỏ nhảy nhót trên cành cây.",
        source: "SPACED_DIFFICULT_WORD",
      },
      {
        normalized_word: "trong treo",
        display_text: "trong trẻo",
        phonics_category: "tr_ch",
        phonics_label_vi: "Âm đầu tr / ch",
        syllable_hint_vi:
          "Tách tiếng: trong · trẻo — Cong đầu lưỡi khi đọc tr, bật nhẹ mặt lưỡi khi đọc ch.",
        sample_sentence_vi: "Tiếng suối chảy nghe thật trong trẻo.",
        source: "SPACED_DIFFICULT_WORD",
      },
    ],
  },
  car_2_game: {
    car_number: 2,
    car_key: "CONTEXT_GAME",
    title_vi: "Toa 2: Vận dụng qua trò chơi",
    subtitle_vi: "1 vòng Xạ thủ ghép câu gắn kết đúng các từ vừa khởi động.",
    estimated_seconds: 120,
    game_key: "SENTENCE_SHOOTER",
    suggested_mode: "WORD_ORDER",
    recommended_difficulty: 2,
    seeded_words: ["chim sẻ", "trong trẻo"],
    prompt_vi:
      'Chạm chọn đúng thứ tự các từ để hoàn thành câu có "chim sẻ" và "trong trẻo".',
    sentence_tokens: ["chim sẻ", "hót", "trong trẻo"],
    distractor_tokens: ["lấp lánh"],
    deep_link_href: "/entertainment/sentence-shooter",
  },
  car_3_fluency: {
    car_number: 3,
    car_key: "FLUENCY_FINISH",
    title_vi: "Toa 3: Về đích trôi chảy",
    subtitle_vi: "Nghe và hát chậm 0.85x thật êm để khép lại chuyến tàu.",
    estimated_seconds: 90,
    finish_mode: "SLOW_KARAOKE_085X",
    playback_speed: 0.85,
    phonics_category: "tr_ch",
    phonics_label_vi: "Âm đầu tr / ch",
    passage_title_vi: "Câu hát chậm 0.85x",
    text_vi: "Con cò bay lả bay la. Cùng ôn nhẹ chim sẻ, trong trẻo.",
    featured_words: ["chim sẻ", "trong trẻo"],
    coaching_tip_vi: "Nghe chậm 0.85x câu hát này rồi ngân nhẹ theo nhịp nhé.",
  },
  generated_at: "2026-11-28T07:30:00Z",
};

function createMockAdaptiveService(
  modeExpected: "VOICE" | "NO_MIC_TOUCH" | "MIXED" = "VOICE",
) {
  const getDailyFiveMinuteTrain = vi.fn().mockResolvedValue(MOCK_TRAIN_PLAN);
  const completeDailyFiveMinuteTrain = vi
    .fn()
    .mockImplementation(async (_childId, payload) => {
      const response: DailyFiveMinuteTrainCompleteResponseDTO = {
        visibility: "PARENT_PRIVATE",
        train_id: MOCK_TRAIN_PLAN.train_id,
        child_id: MOCK_CHILD.id,
        child_alias: MOCK_CHILD.alias,
        interaction_mode: payload.interaction_mode ?? modeExpected,
        recorded_evidence_count: 3,
        evidence_items: [],
        today_completed_trains_count: 1,
        celebration_title_vi: "Chuyến tàu 5 phút của Bé An đã cập bến êm ái!",
        natural_break_cue_vi:
          "Tuyệt lắm Bé An! Giờ bé hãy đóng màn hình, nhìn cây xanh hoặc khoảng xa 20 giây và nghỉ ngơi thoải mái nhé.",
        completed_at: "2026-11-28T07:35:00Z",
      };
      return response;
    });

  const service: AdaptiveLearningService = {
    getRecommendations: vi.fn(),
    getParentAnalytics: vi.fn(),
    getDailyFiveMinuteTrain,
    completeDailyFiveMinuteTrain,
  };
  return { service, getDailyFiveMinuteTrain, completeDailyFiveMinuteTrain };
}

describe("Feature #9 — 5-Minute Personalized Daily Reading Train", () => {
  it("renders 1-tap CTA card with child personalization, focus words, and launch href", () => {
    render(
      <FiveMinuteTrainCtaCard
        childAlias="Bé An"
        childId={MOCK_CHILD.id}
        focusWords={["chim sẻ", "trong trẻo"]}
        sourceSurface="reports"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Chuyến Tàu Luyện Đọc 5 Phút" }),
    ).toBeInTheDocument();
    expect(screen.getByText("chim sẻ · trong trẻo")).toBeInTheDocument();

    const launchLink = screen.getByTestId("five-minute-train-launch-btn");
    expect(launchLink).toHaveAttribute(
      "href",
      `/learning-train?childId=${MOCK_CHILD.id}&from=reports`,
    );
  });

  it("progresses seamlessly across all 3 cars in Voice mode and displays the Natural Break Cue", async () => {
    const { service, completeDailyFiveMinuteTrain } =
      createMockAdaptiveService("VOICE");
    const playSpy = vi.fn().mockResolvedValue(undefined);

    render(
      <FiveMinuteReadingTrain
        adaptiveServiceOverride={service}
        childServiceOverride={{ list: vi.fn().mockResolvedValue([MOCK_CHILD]) }}
        initialChildId={MOCK_CHILD.id}
        requestMicrophoneTurn={async () => true}
        sourceSurface="reports"
        speechPlayerOverride={{ play: playSpy, stop: vi.fn() }}
      />,
    );

    // Car 1 loads with target words & syllable hints
    expect(await screen.findByTestId("train-car-1")).toBeInTheDocument();
    expect(screen.getByText("Toa 1: Khởi động từ khó")).toBeInTheDocument();
    expect(screen.getByText(/Tách tiếng: chim · sẻ/)).toBeInTheDocument();

    const advanceCar2Btn = screen.getByTestId("advance-to-car-2");
    expect(advanceCar2Btn).toBeDisabled();

    fireEvent.click(screen.getByTestId("car1-voice-practice-chim se"));
    fireEvent.click(screen.getByTestId("car1-voice-practice-trong treo"));

    await waitFor(() => {
      expect(advanceCar2Btn).not.toBeDisabled();
    });
    fireEvent.click(advanceCar2Btn);

    // Car 2 seeded with Car 1's exact words
    expect(await screen.findByTestId("train-car-2")).toBeInTheDocument();
    expect(
      screen.getByText("Toa 2: Vận dụng qua trò chơi"),
    ).toBeInTheDocument();

    // Gentle non-punitive hint if out-of-order token tapped first
    fireEvent.click(screen.getByTestId("car2-token-dist-0"));
    expect(screen.getByRole("status")).toHaveTextContent(/chưa đúng vị trí/);

    // Tap correct ordered tokens: "chim sẻ" -> "hót" -> "trong trẻo"
    fireEvent.click(screen.getByTestId("car2-token-tok-0"));
    fireEvent.click(screen.getByTestId("car2-token-tok-1"));
    fireEvent.click(screen.getByTestId("car2-token-tok-2"));

    const advanceCar3Btn = screen.getByTestId("advance-to-car-3");
    expect(advanceCar3Btn).not.toBeDisabled();
    fireEvent.click(advanceCar3Btn);

    // Car 3 fluency finish at 0.85x slow Karaoke
    expect(await screen.findByTestId("train-car-3")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("car3-listen-085x"));
    expect(playSpy).toHaveBeenCalledWith(
      MOCK_TRAIN_PLAN.car_3_fluency.text_vi,
      { speedScale: 0.85 },
    );

    fireEvent.click(screen.getByTestId("car3-voice-practice"));
    const finishBtn = screen.getByTestId("complete-five-minute-train-btn");
    await waitFor(() => {
      expect(finishBtn).not.toBeDisabled();
    });
    fireEvent.click(finishBtn);

    // Natural Break Cue screen
    expect(
      await screen.findByTestId("train-completed-cue"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Chuyến tàu 5 phút của Bé An đã cập bến êm ái!"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nhìn cây xanh hoặc khoảng xa 20 giây/),
    ).toBeInTheDocument();

    expect(completeDailyFiveMinuteTrain).toHaveBeenCalledWith(
      MOCK_CHILD.id,
      expect.objectContaining({
        interaction_mode: "VOICE",
        practiced_words: ["chim sẻ", "trong trẻo"],
        car_2_game_key: "SENTENCE_SHOOTER",
        car_3_finish_mode: "SLOW_KARAOKE_085X",
      }),
    );
  });

  it("supports manual 'Tạm không tiện bật mic' toggle and automatic fallback when mic is denied", async () => {
    const { service, completeDailyFiveMinuteTrain } =
      createMockAdaptiveService("NO_MIC_TOUCH");

    render(
      <FiveMinuteReadingTrain
        adaptiveServiceOverride={service}
        childServiceOverride={{ list: vi.fn().mockResolvedValue([MOCK_CHILD]) }}
        initialChildId={MOCK_CHILD.id}
        requestMicrophoneTurn={async () => false}
        speechPlayerOverride={{
          play: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        }}
      />,
    );

    expect(await screen.findByTestId("train-car-1")).toBeInTheDocument();
    const noMicToggle = screen.getByTestId("train-no-mic-toggle");
    expect(noMicToggle).toHaveAttribute("aria-pressed", "false");

    // Attempting voice when mic is unavailable/denied triggers automatic graceful fallback!
    fireEvent.click(screen.getByTestId("car1-voice-practice-chim se"));
    await waitFor(() => {
      expect(noMicToggle).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByTestId("train-no-mic-banner")).toHaveTextContent(
      /chưa sẵn sàng micro/,
    );

    // Toggle manual off and back on to verify manual toggle control as well
    fireEvent.click(noMicToggle);
    expect(noMicToggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(noMicToggle);
    expect(noMicToggle).toHaveAttribute("aria-pressed", "true");

    // Complete Car 1 via Listen & Tap touch confirm buttons
    fireEvent.click(screen.getByTestId("car1-touch-confirm-chim se"));
    fireEvent.click(screen.getByTestId("car1-touch-confirm-trong treo"));
    fireEvent.click(screen.getByTestId("advance-to-car-2"));

    // Complete Car 2 via touch chips
    expect(await screen.findByTestId("train-car-2")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("car2-token-tok-0"));
    fireEvent.click(screen.getByTestId("car2-token-tok-1"));
    fireEvent.click(screen.getByTestId("car2-token-tok-2"));
    fireEvent.click(screen.getByTestId("advance-to-car-3"));

    // Complete Car 3 via rhythm phrase tap-along (no mic required)
    expect(await screen.findByTestId("train-car-3")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("car3-rhythm-phrase-0"));
    fireEvent.click(screen.getByTestId("car3-rhythm-phrase-1"));
    fireEvent.click(screen.getByTestId("car3-rhythm-phrase-2"));

    const finishBtn = screen.getByTestId("complete-five-minute-train-btn");
    expect(finishBtn).not.toBeDisabled();
    fireEvent.click(finishBtn);

    expect(
      await screen.findByTestId("train-completed-cue"),
    ).toBeInTheDocument();
    expect(completeDailyFiveMinuteTrain).toHaveBeenCalledWith(
      MOCK_CHILD.id,
      expect.objectContaining({
        interaction_mode: "NO_MIC_TOUCH",
      }),
    );
  });

  it("renders cold-start starter badge when child has zero prior attempts and supports dashboard/entertainment CTAs", async () => {
    const coldStartPlan: DailyFiveMinuteTrainDTO = {
      ...MOCK_TRAIN_PLAN,
      is_cold_start: true,
      completed_today: true,
      today_completed_count: 1,
    };
    const { service } = createMockAdaptiveService("NO_MIC_TOUCH");
    vi.mocked(service.getDailyFiveMinuteTrain).mockResolvedValueOnce(
      coldStartPlan,
    );

    const { unmount } = render(
      <FiveMinuteTrainCtaCard
        childAlias="Bé Bo"
        childId={MOCK_CHILD.id}
        compact
        sourceSurface="dashboard"
      />,
    );
    expect(screen.getByTestId("five-minute-train-launch-btn")).toHaveAttribute(
      "href",
      `/learning-train?childId=${MOCK_CHILD.id}&from=dashboard`,
    );
    unmount();

    render(
      <FiveMinuteReadingTrain
        adaptiveServiceOverride={service}
        childServiceOverride={{ list: vi.fn().mockResolvedValue([MOCK_CHILD]) }}
        initialChildId={MOCK_CHILD.id}
        sourceSurface="entertainment"
        speechPlayerOverride={{
          play: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        }}
      />,
    );

    expect(
      await screen.findByTestId("train-cold-start-badge"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("train-no-mic-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
