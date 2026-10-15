import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SessionComplete } from "@/components/reading/session-complete";
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

  it("renders summary cards and toggles spoken words list when clicking the result box", async () => {
    const user = userEvent.setup();
    render(
      <SessionComplete
        booksHref="/books"
        child={childFixture}
        sessionId={TEST_SESSION_ID}
        summary={baseSummary}
      />,
    );

    expect(screen.getByText("5 phút")).toBeInTheDocument();
    expect(screen.getByText("2 trang")).toBeInTheDocument();
    expect(screen.getByText("3 từ")).toBeInTheDocument();

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
        name: "Kết quả nhận diện giọng nói của bé (STT)",
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

});
