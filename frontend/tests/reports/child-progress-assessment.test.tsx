import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AppServicesContext,
  type AppServices,
} from "@/components/providers/app-services-provider";
import { ChildProgressAssessmentCard } from "@/components/reports/child-progress-assessment";
import type {
  ChildProgressAssessment,
  ChildProgressService,
} from "@/lib/api/child-progress-service";

const CHILD_ID = "33333333-3333-4333-8333-333333333333";

function assessment(
  overrides: Partial<ChildProgressAssessment> = {},
): ChildProgressAssessment {
  return {
    child_id: CHILD_ID,
    period_start: "2026-10-11",
    period_end: "2026-11-09",
    days: 30,
    generated_at: "2026-11-09T12:00:00+07:00",
    data_status: "OK",
    score: {
      overall: 63,
      previous_overall: 58,
      delta: 5,
      grade: "FAIR",
      grade_label: "Khá",
      components: [
        {
          key: "ACCURACY",
          label: "Đọc đúng",
          score: 76,
          previous_score: 70,
          detail: "Đọc đúng 596/780 từ.",
        },
        {
          key: "COMPREHENSION",
          label: "Hiểu bài",
          score: null,
          previous_score: null,
          detail: "Chưa đủ câu hỏi.",
        },
      ],
    },
    metrics: {
      sessions: 29,
      active_days: 8,
      reading_minutes: 148,
      books: 4,
      pages_compared: 28,
      words_read: 780,
      coverage_pct: 37.9,
      accuracy_pct: 76.4,
      skipped_rate_pct: 12.8,
      substitution_rate_pct: 10.8,
      hesitations: 62,
      repeated_words: 7,
      hesitations_per_100_words: 8.8,
      words_per_minute: null,
      comprehension_answered: 0,
      comprehension_first_try_pct: null,
      comprehension_by_type: [],
      retry_confirmed: 0,
      retry_failed: 0,
    },
    weekly: [
      {
        week_start: "2026-10-11",
        sessions: 1,
        minutes: 20,
        accuracy_pct: null,
      },
      {
        week_start: "2026-10-18",
        sessions: 5,
        minutes: 90,
        accuracy_pct: 76.4,
      },
    ],
    difficult_words: [{ word: "dây", times: 20, heard_as: "dậy" }],
    assessment: {
      source: "RULE_BASED",
      model: null,
      headline: "Nhận xét tự động",
      summary: "Tóm tắt từ số liệu.",
      strengths: ["Bé đã hoàn thành 29 buổi đọc."],
      weaknesses: [{ area: "Hay bỏ sót từ", detail: "Bỏ sót 12,8% số từ." }],
      actions: [
        {
          title: "Chỉ từng từ",
          detail: "Dùng ngón tay chỉ.",
          audience: "PARENT",
        },
        { title: "Đọc lại 3 lần", detail: "Đọc từ khó.", audience: "CHILD" },
      ],
      practice_words: ["dây"],
      encouragement: "Bé cố gắng lên nhé!",
    },
    ai_cached: false,
    ...overrides,
  };
}

function aiVersion(days = 30): ChildProgressAssessment {
  const base = assessment({ days });
  return {
    ...base,
    assessment: {
      ...base.assessment,
      source: "AI",
      model: "gemini-test",
      headline: "AI: bé đang tiến bộ",
      summary: "AI viết: bé đọc đều đặn.",
    },
  };
}

function setup(service: Partial<ChildProgressService> | null) {
  const services =
    service === null
      ? ({} as AppServices)
      : ({ childProgressService: service } as unknown as AppServices);
  return render(
    <AppServicesContext.Provider value={services}>
      <ChildProgressAssessmentCard childId={CHILD_ID} childName="Bé Na" />
    </AppServicesContext.Provider>,
  );
}

describe("AI progress assessment card", () => {
  it("renders nothing when the service is not provided", () => {
    const { container } = setup(null);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows scores immediately, then replaces the offline comments with the AI's", async () => {
    let resolveAi!: (value: ChildProgressAssessment) => void;
    const service = {
      get: vi.fn().mockResolvedValue(assessment()),
      generate: vi.fn().mockReturnValue(
        new Promise<ChildProgressAssessment>((resolve) => {
          resolveAi = resolve;
        }),
      ),
    };
    setup(service);

    expect(await screen.findByText("Nhận xét tự động")).toBeInTheDocument();
    expect(screen.getByText("63")).toBeInTheDocument();
    expect(screen.getByText("Khá")).toBeInTheDocument();
    expect(screen.getByText("+5 điểm so với kỳ trước")).toBeInTheDocument();
    expect(screen.getByText("76/100")).toBeInTheDocument();
    expect(screen.getByText("Chưa đủ dữ liệu")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /AI đang viết nhận xét/ }),
    ).toBeDisabled();
    expect(service.generate).toHaveBeenCalledWith(CHILD_ID, 30, {
      signal: expect.any(AbortSignal),
    });

    resolveAi(aiVersion());
    expect(await screen.findByText("AI: bé đang tiến bộ")).toBeInTheDocument();
    expect(screen.getByText("Nhận xét do AI viết")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Nhờ AI nhận xét lại" }),
    ).toBeEnabled();
  });

  it("shows weaknesses, what to do for parents and child, and practice words", async () => {
    setup({
      get: vi.fn().mockResolvedValue(aiVersion()),
      generate: vi.fn(),
    });
    expect(await screen.findByText("Bé cần cải thiện")).toBeInTheDocument();
    expect(screen.getByText("Hay bỏ sót từ")).toBeInTheDocument();
    expect(screen.getByText("Ba mẹ có thể làm")).toBeInTheDocument();
    expect(screen.getByText("Bé có thể làm")).toBeInTheDocument();
    expect(screen.getByText("Chỉ từng từ")).toBeInTheDocument();
    expect(screen.getByText(/đọc thành “dậy”/)).toBeInTheDocument();
    expect(screen.getByText("Bé cố gắng lên nhé!")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Đọc đúng: 76 trên 100" }),
    ).toBeInTheDocument();
  });

  it("does not call the AI again when the comment is already cached", async () => {
    const service = {
      get: vi.fn().mockResolvedValue({ ...aiVersion(), ai_cached: true }),
      generate: vi.fn(),
    };
    setup(service);
    expect(await screen.findByText("AI: bé đang tiến bộ")).toBeInTheDocument();
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("keeps the offline comments and explains when the AI fails", async () => {
    setup({
      get: vi.fn().mockResolvedValue(assessment()),
      generate: vi.fn().mockRejectedValue(new Error("offline")),
    });
    expect(await screen.findByText(/Chưa kết nối được AI/)).toBeInTheDocument();
    expect(screen.getByText("Nhận xét tự động")).toBeInTheDocument();
    expect(screen.getByText("63")).toBeInTheDocument();
  });

  it("does not ask the AI when there is not enough data", async () => {
    const service = {
      get: vi.fn().mockResolvedValue(
        assessment({
          data_status: "INSUFFICIENT",
          score: {
            overall: null,
            previous_overall: null,
            delta: null,
            grade: null,
            grade_label: null,
            components: [],
          },
        }),
      ),
      generate: vi.fn(),
    };
    setup(service);
    expect(await screen.findAllByText("Chưa đủ dữ liệu")).not.toHaveLength(0);
    expect(service.generate).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /Nhờ AI nhận xét lại/ }),
    ).not.toBeInTheDocument();
  });

  it("reloads for another period", async () => {
    const user = userEvent.setup();
    const service = {
      get: vi.fn().mockResolvedValue(aiVersion()),
      generate: vi.fn(),
    };
    setup(service);
    await screen.findByText("AI: bé đang tiến bộ");

    await user.click(screen.getByRole("radio", { name: "90 ngày" }));

    await waitFor(() =>
      expect(service.get).toHaveBeenLastCalledWith(
        CHILD_ID,
        90,
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("AI: bé đang tiến bộ")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "90 ngày" })).toBeChecked();
  });

  it("asks for a fresh AI comment on demand", async () => {
    const user = userEvent.setup();
    const service = {
      get: vi.fn().mockResolvedValue(aiVersion()),
      generate: vi.fn().mockResolvedValue({
        ...aiVersion(),
        assessment: { ...aiVersion().assessment, headline: "AI: nhận xét mới" },
      }),
    };
    setup(service);
    await screen.findByText("AI: bé đang tiến bộ");

    await user.click(
      screen.getByRole("button", { name: "Nhờ AI nhận xét lại" }),
    );

    expect(await screen.findByText("AI: nhận xét mới")).toBeInTheDocument();
    expect(service.generate).toHaveBeenCalledWith(CHILD_ID, 30, {
      refresh: true,
    });
  });

  it("offers a retry when the scores cannot be loaded", async () => {
    const user = userEvent.setup();
    const service = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(aiVersion()),
      generate: vi.fn(),
    };
    setup(service);
    expect(
      await screen.findByText("Chưa tải được đánh giá"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    expect(await screen.findByText("AI: bé đang tiến bộ")).toBeInTheDocument();
  });
});
