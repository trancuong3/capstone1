import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import { EntertainmentLearningSummary } from "@/components/reports/entertainment-learning-summary";
import type {
  EntertainmentRecommendationsDTO,
  ParentEntertainmentAnalyticsDTO,
} from "@/types/adaptive-learning";

const MOCK_RECS: EntertainmentRecommendationsDTO = {
  child_id: "00000000-0000-0000-0000-000000000001",
  child_alias: "Bé An",
  child_grade: 2,
  mascot_greeting_vi:
    'Chào Bé An! Hôm nay mình cùng khám phá "Bé nhớ được gì?" nhé!',
  natural_break_reminder_vi:
    "Hôm nay Bé An đã chơi 4 hoạt động rồi! Bé nhớ nghỉ mắt 5 phút nhé.",
  today_activities_count: 4,
  focus_difficult_words: ["khủng long", "bông hoa"],
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
  recommendations: [
    {
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
  ],
};

const MOCK_ANALYTICS: ParentEntertainmentAnalyticsDTO = {
  child_id: "00000000-0000-0000-0000-000000000001",
  child_alias: "Bé An",
  child_grade: 2,
  window_days: 30,
  is_diagnostic: false,
  disclaimer_vi:
    "Tổng hợp này phản ánh các lượt luyện tập thực tế; không phải bài kiểm tra IQ hay chẩn đoán y khoa.",
  observed_skills_count: 2,
  estimated_skills_count: 1,
  unknown_skills_count: 13,
  skills: [
    {
      skill_key: "visual_memory_recall",
      label_vi: "Ghi nhớ hình ảnh có chủ đích",
      domain: "OBSERVATION_MEMORY_CREATIVITY",
      status: "OBSERVED",
      mastery_pct: 86,
      confidence: 0.9,
      evidence_count: 3,
      high_confidence_count: 3,
      last_observed_at: "2026-11-25T10:00:00Z",
      source_modules: ["MEMORY_GAME"],
    },
    {
      skill_key: "pitch_melody",
      label_vi: "Cảm thụ giai điệu & cao độ",
      domain: "MUSIC_RHYTHM",
      status: "UNKNOWN",
      mastery_pct: null,
      confidence: 0,
      evidence_count: 0,
      high_confidence_count: 0,
      last_observed_at: null,
      source_modules: [],
    },
  ],
  practiced_difficult_words: [
    {
      normalized_word: "khung long",
      display_text: "khủng long",
      priority_score: 2.1,
      practice_count: 3,
      last_practiced_at: "2026-11-24T10:00:00Z",
      days_since_practice: 1,
      recommended_game: "SENTENCE_SHOOTER",
      reason_vi: "Ôn nhẹ trong câu ngắn.",
    },
  ],
  module_activities: [
    {
      game_key: "MEMORY_GAME",
      title_vi: "Bé nhớ được gì?",
      sessions_count: 3,
      recent_average_pct: 86,
      highlight_vi: "3 lượt luyện ghi nhớ chi tiết.",
    },
  ],
  karaoke_weak_segments: [
    {
      song_id: "00000000-0000-0000-0000-000000000099",
      line_text: "Con cò bay lả bay la",
      start_ms: 10000,
      end_ms: 14500,
      tip_vi: "Hát chậm 0.85x câu này nhé.",
    },
  ],
  home_support_tips_vi: [
    "Ba mẹ cùng bé đặt câu với từ khủng long mỗi tối nhé.",
  ],
  generated_at: "2026-11-25T12:00:00Z",
};

describe("Entertainment Hub V4.0 & Parent Learning Analytics", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders all 4 child-first zones, mascot recommendation, onboarding, and sensory controls", () => {
    render(<EntertainmentScreen initialRecommendations={MOCK_RECS} />);

    expect(
      screen.getByRole("heading", { name: "Kể chuyện qua tranh" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Xạ thủ ghép câu" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Hát vui cùng bé" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Bé nhớ được gì?" }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("link", { name: "Khám phá trí nhớ" }),
    ).toHaveAttribute(
      "href",
      "/entertainment/memory-game?focus=kh%E1%BB%A7ng%20long%2Cb%C3%B4ng%20hoa",
    );
    expect(
      screen.getByRole("link", { name: "Mở thư viện bài hát" }),
    ).toHaveAttribute(
      "href",
      "/karaoke?focus=kh%E1%BB%A7ng%20long%2Cb%C3%B4ng%20hoa",
    );

    // Focus difficult words & mascot greeting
    expect(screen.getByText("khủng long")).toBeInTheDocument();
    expect(screen.getByText(/Bé nhớ nghỉ mắt 5 phút/)).toBeInTheDocument();

    // First-visit onboarding advances and closes cleanly
    expect(screen.getByText("1. Chọn góc chơi bé thích")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tiếp theo" }));
    expect(
      screen.getByText("2. Chơi bằng giọng nói hoặc chạm"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
    expect(
      screen.queryByText("2. Chơi bằng giọng nói hoặc chạm"),
    ).not.toBeInTheDocument();

    // Sensory toggles work
    fireEvent.click(screen.getByRole("button", { name: "Giảm chuyển động" }));
    expect(
      screen.getByRole("button", { name: "Đã giảm chuyển động" }),
    ).toBeInTheDocument();
  });

  it("renders non-diagnostic Parent Learning Analytics with honest observed vs unknown skills", () => {
    render(
      <EntertainmentLearningSummary
        childId={MOCK_ANALYTICS.child_id}
        childName="Bé An"
        initialData={MOCK_ANALYTICS}
      />,
    );

    expect(screen.getByText(/không phải bài kiểm tra IQ/)).toBeInTheDocument();
    expect(screen.getByText("Đã quan sát rõ")).toBeInTheDocument();
    expect(
      screen.getAllByText("Chưa đủ dữ liệu").length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("86%")).toBeInTheDocument();
    expect(screen.getByText(/Con cò bay lả bay la/)).toBeInTheDocument();
    expect(
      screen.getByText(/Ba mẹ cùng bé đặt câu với từ khủng long/),
    ).toBeInTheDocument();
  });
});
