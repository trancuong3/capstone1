import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SessionComplete } from "@/components/reading/session-complete";
import * as comparisonService from "@/lib/api/comparison-service";
import {
  childFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";

describe("SessionComplete component", () => {
  const baseSummary = {
    duration_minutes: 5,
    pages_explored: 2,
    practiced_words: 3,
    spoken_words: ["mèo", "nhỏ", "đang"],
    transcripts: ["mèo nhỏ đang chạy"],
  };

  it("renders summary cards and toggles the spoken-words list", async () => {
    const user = userEvent.setup();
    render(
      <SessionComplete
        booksHref="/books"
        bookId={TEST_SESSION_ID}
        child={childFixture}
        sessionId={TEST_SESSION_ID}
        summary={baseSummary}
      />,
    );

    expect(screen.getByText("5 phút")).toBeInTheDocument();
    expect(screen.getByText("2 trang")).toBeInTheDocument();
    expect(screen.getByText("3 từ")).toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/đọc thành công/)).not.toBeInTheDocument();

    // Spoken words list is collapsed initially
    expect(
      screen.queryByTestId("spoken-words-container"),
    ).not.toBeInTheDocument();

    // Click on the result box ("ô kết quả")
    const resultBox = screen.getByRole("button", { name: /3 từ/i });
    await user.click(resultBox);

    // Now words container is visible
    expect(screen.getByTestId("spoken-words-container")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Kết quả nhận diện giọng đọc của bé",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("3 từ nhận diện")).toBeInTheDocument();
    expect(screen.getByText("mèo")).toBeInTheDocument();
    expect(screen.getByText("nhỏ")).toBeInTheDocument();
    expect(screen.getByText("đang")).toBeInTheDocument();
    expect(screen.getByText(/mèo nhỏ đang chạy/)).toBeInTheDocument();

    // Click again to collapse
    await user.click(resultBox);
    expect(
      screen.queryByTestId("spoken-words-container"),
    ).not.toBeInTheDocument();
  });

  it("renders helpful message when no words were captured by STT", async () => {
    const user = userEvent.setup();
    render(
      <SessionComplete
        booksHref="/books"
        bookId={TEST_SESSION_ID}
        child={childFixture}
        sessionId={TEST_SESSION_ID}
        summary={{
          duration_minutes: 1,
          pages_explored: 1,
          practiced_words: 0,
          spoken_words: [],
          transcripts: [],
        }}
      />,
    );

    const resultBox = screen.getByRole("button", { name: /0 từ/i });
    await user.click(resultBox);

    expect(screen.getByTestId("spoken-words-container")).toBeInTheDocument();
    expect(
      screen.getByText(/Chưa ghi nhận từ nào trong lượt đọc này/i),
    ).toBeInTheDocument();
  });

  it("does not display missing completion metrics as invented zeroes", () => {
    render(
      <SessionComplete
        booksHref="/books"
        bookId={TEST_SESSION_ID}
        child={childFixture}
        sessionId={TEST_SESSION_ID}
        summary={{
          duration_minutes: null,
          pages_explored: null,
          practiced_words: null,
          spoken_words: null,
          transcripts: null,
        }}
      />,
    );

    expect(screen.getAllByText("Chưa ghi nhận")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: /Chưa ghi nhận/i }),
    ).toBeInTheDocument();
  });

  it("presents self-correction separately from the immutable first-pass score", () => {
    render(
      <SessionComplete
        booksHref="/books"
        bookId={TEST_SESSION_ID}
        child={childFixture}
        sessionId={TEST_SESSION_ID}
        summary={{
          ...baseSummary,
          correct_words: ["đỏ"],
          mispronounced_words: ["đỏ"],
          skipped_words: [],
          score: 50,
          assessment: {
            first_pass_correct: 1,
            first_pass_incorrect: 1,
            self_corrected_words: 1,
            unresolved_words: 0,
            retry_attempts: 3,
            skipped_after_retry_limit: 0,
            recognition_uncertain: 0,
          },
        }}
      />,
    );
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("Bé đã tự sửa đúng")).toBeInTheDocument();
    expect(
      screen.getByText(/không thay đổi kết quả lượt đầu/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Đúng 1\/2 từ/)).toBeInTheDocument();
  });

  it("links a completed reading session to Sentence Shooter with its book", () => {
    render(
      <SessionComplete
        booksHref="/books"
        bookId="book-id-with-special-chars"
        startPageId="first"
        endPageId="last"
        child={childFixture}
        sessionId={TEST_SESSION_ID}
        summary={baseSummary}
      />,
    );

    const gameLink = screen.getByRole("link", { name: /Chơi game/i });
    expect(
      screen.getByRole("link", { name: "Đọc lại phần này" }),
    ).toHaveAttribute(
      "href",
      "/reading-preparation?bookId=book-id-with-special-chars&pageId=first&endPageId=last",
    );
    const href = new URL(
      gameLink.getAttribute("href") ?? "",
      "https://viread.test",
    );
    expect(href.pathname).toBe("/entertainment/sentence-shooter");
    expect(href.searchParams.get("book_id")).toBe("book-id-with-special-chars");
    expect(href.searchParams.get("source")).toBe("reading-completion");
    expect(href.searchParams.get("reading_session_id")).toBe(TEST_SESSION_ID);
  });

  it("does not offer the game for an incomplete selected reading range", () => {
    render(
      <SessionComplete
        booksHref="/books"
        bookId={TEST_SESSION_ID}
        child={childFixture}
        sessionId={TEST_SESSION_ID}
        summary={{
          ...baseSummary,
          selected_range_pages: 3,
          pages_explored: 2,
        }}
      />,
    );

    expect(
      screen.queryByRole("link", { name: /Chơi game/i }),
    ).not.toBeInTheDocument();
  });

  it("renders at most one ReadingAssessmentSummary when both completion summary and saved session reports include assessment", async () => {
    const assessment = {
      first_pass_correct: 12,
      first_pass_incorrect: 2,
      self_corrected_words: 1,
      unresolved_words: 1,
      retry_attempts: 2,
      skipped_after_retry_limit: 0,
      recognition_uncertain: 0,
    };
    const spy = vi
      .spyOn(comparisonService, "getSessionReports")
      .mockResolvedValueOnce({
        session_id: TEST_SESSION_ID,
        total: 0,
        assessment,
        reports: [],
      });

    try {
      render(
        <SessionComplete
          booksHref="/books"
          bookId={TEST_SESSION_ID}
          child={childFixture}
          sessionId={TEST_SESSION_ID}
          summary={{
            ...baseSummary,
            correct_words: ["mèo", "nhỏ"],
            mispronounced_words: ["đang"],
            skipped_words: [],
            score: 67,
            assessment,
          }}
        />,
      );

      expect(
        await screen.findByText(
          "Buổi đọc này chưa có báo cáo đối chiếu được lưu.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getAllByRole("region", {
          name: "Kết quả lượt đầu và luyện lại",
        }),
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
