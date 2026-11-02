import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EndOfReadingReview } from "@/components/reading/end-of-reading-review";
import type { SessionReviewItem } from "@/lib/utils/session-review-queue";

const item: SessionReviewItem = {
  pageId: "page-1",
  pageRevisionId: "revision-1",
  wordId: "word-2",
  wordIndex: 2,
  expectedWord: "khỏe",
  recognizedWord: "khỏ",
  logprob: -0.3,
  confidence: 0.74,
  occurredAtMs: 1_000,
  reason: "CONFIDENTLY_INCORRECT",
  reviewId: "page-1:revision-1:word-2",
  pageOrder: 0,
  attempts: 0,
  resolution: "PENDING",
};

describe("EndOfReadingReview", () => {
  it("shows only one exact occurrence, review progress and a gentle start action", () => {
    render(
      <EndOfReadingReview
        activity="ready"
        currentPosition={1}
        feedback="Con cùng đọc lại nhé!"
        item={item}
        onStartAttempt={vi.fn()}
        secondsRemaining={null}
        totalItems={3}
      />,
    );

    expect(screen.getByTestId("review-target-word")).toHaveTextContent("khỏe");
    expect(screen.getByText("Từ thứ 1 / 3")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Tiến trình luyện từ" })).toHaveAttribute(
      "aria-valuemax",
      "3",
    );
    expect(screen.getByRole("button", { name: "Bắt đầu đọc" })).toBeInTheDocument();
  });

  it("shows a listening countdown and keeps the child-facing language encouraging", () => {
    render(
      <EndOfReadingReview
        activity="listening"
        currentPosition={2}
        feedback="Mình đang nghe con đọc…"
        item={{ ...item, attempts: 1 }}
        onStartAttempt={vi.fn()}
        secondsRemaining={2}
        totalItems={3}
      />,
    );

    expect(screen.getByText("Còn 2 giây")).toBeInTheDocument();
    expect(screen.getByText("Mình đang nghe con đọc…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
