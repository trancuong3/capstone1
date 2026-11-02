import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BookPageViewer } from "@/components/reading/book-page-viewer";
import type { ReadingPageDTO } from "@/types/reading";

const page: ReadingPageDTO = {
  page_id: "33333333-3333-4333-8333-333333333333",
  page_revision_id: "44444444-4444-4444-8444-444444444444",
  page_number: 2,
  confidence: 0.99,
  width: 800,
  height: 1000,
  image_url: "https://example.test/scanned-page.png",
  text: "Mẹ đưa bé đến trường.",
  words: [],
};

describe("BookPageViewer", () => {
  it("preserves OCR line breaks and indentation", () => {
    const formattedPage: ReadingPageDTO = {
      ...page,
      text: "Ngày xưa\ncó\n\n    một cậu\nbé",
      paragraph_start_line_indices: [2],
      indented_line_indices: [2],
      words: [
        {
          word_id: "11111111-1111-4111-8111-111111111111",
          word_index: 0,
          line_index: 0,
          text: "Ngày",
          bbox: [0.1, 0.1, 0.05, 0.02],
        },
        {
          word_id: "22222222-2222-4222-8222-222222222222",
          word_index: 1,
          line_index: 0,
          text: "xưa",
          bbox: [0.16, 0.1, 0.05, 0.02],
        },
        {
          word_id: "33333333-3333-4333-8333-333333333333",
          word_index: 2,
          line_index: 1,
          text: "có",
          bbox: [0.1, 0.15, 0.03, 0.02],
        },
        {
          word_id: "44444444-4444-4444-8444-444444444444",
          word_index: 3,
          line_index: 2,
          text: "một",
          bbox: [0.13, 0.23, 0.04, 0.02],
        },
        {
          word_id: "55555555-5555-4555-8555-555555555555",
          word_index: 4,
          line_index: 2,
          text: "cậu",
          bbox: [0.18, 0.23, 0.04, 0.02],
        },
        {
          word_id: "66666666-6666-4666-8666-666666666666",
          word_index: 5,
          line_index: 3,
          text: "bé",
          bbox: [0.1, 0.28, 0.03, 0.02],
        },
      ],
    };

    const { container } = render(
      <BookPageViewer currentWordId={null} page={formattedPage} />,
    );

    expect(
      screen.getByRole("button", { name: "Ngày, chưa đọc đến" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "một, chưa đọc đến" }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll("br")).toHaveLength(4);
    expect(
      container.querySelector(
        '[data-word-id="44444444-4444-4444-8444-444444444444"]',
      ),
    ).toHaveAttribute("data-line-index", "2");
    expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(
      1,
    );
  });

  it("renders verified text without scan images", () => {
    render(<BookPageViewer currentWordId={null} page={page} />);

    expect(screen.getByText("Mẹ đưa bé đến trường.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Nội dung OCR đã xác minh")).toBeInTheDocument();
  });

  it("keeps repeated tokens independent by position", () => {
    const repeatedPage: ReadingPageDTO = {
      ...page,
      words: [
        {
          word_id: "line-a-0",
          word_index: 0,
          line_index: 0,
          text: "Hôm",
          bbox: [0.1, 0.1, 0.05, 0.02],
        },
        {
          word_id: "line-a-1",
          word_index: 1,
          line_index: 0,
          text: "nay",
          bbox: [0.16, 0.1, 0.05, 0.02],
        },
        {
          word_id: "line-a-2",
          word_index: 2,
          line_index: 0,
          text: "khỏe",
          bbox: [0.22, 0.1, 0.05, 0.02],
        },
        {
          word_id: "line-a-3",
          word_index: 3,
          line_index: 0,
          text: "không?",
          bbox: [0.28, 0.1, 0.06, 0.02],
        },
        {
          word_id: "line-b-0",
          word_index: 4,
          line_index: 1,
          text: "Tôi",
          bbox: [0.1, 0.2, 0.04, 0.02],
        },
        {
          word_id: "line-b-1",
          word_index: 5,
          line_index: 1,
          text: "khỏe",
          bbox: [0.15, 0.2, 0.05, 0.02],
        },
        {
          word_id: "line-c-0",
          word_index: 6,
          line_index: 2,
          text: "đi",
          bbox: [0.1, 0.3, 0.03, 0.02],
        },
        {
          word_id: "line-c-1",
          word_index: 7,
          line_index: 2,
          text: "chơi",
          bbox: [0.14, 0.3, 0.04, 0.02],
        },
        {
          word_id: "line-c-2",
          word_index: 8,
          line_index: 2,
          text: "không?",
          bbox: [0.19, 0.3, 0.06, 0.02],
        },
      ],
    };

    const { container } = render(
      <BookPageViewer
        correctWordIds={
          new Set(["line-a-0", "line-a-1", "line-a-2", "line-a-3"])
        }
        currentWordId="line-b-0"
        mispronouncedWordIds={new Set(["line-b-1"])}
        page={repeatedPage}
      />,
    );

    expect(
      container.querySelector('[data-word-id="line-a-2"]'),
    ).toHaveAttribute("data-word-status", "CORRECT");
    expect(
      container.querySelector('[data-word-id="line-b-1"]'),
    ).toHaveAttribute("data-word-status", "NEEDS_REVIEW");
    expect(
      container.querySelector('[data-word-id="line-c-2"]'),
    ).toHaveAttribute("data-word-status", "NOT_REACHED");
    expect(
      screen.getByRole("button", { name: "khỏe, cần đọc lại" }),
    ).toBeInTheDocument();
  });
});
