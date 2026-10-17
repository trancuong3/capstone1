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
  it("preserves OCR line breaks and paragraph indentation while rendering words", () => {
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

    expect(screen.getByText("Ngày")).toBeInTheDocument();
    expect(screen.getByText("một")).toBeInTheDocument();
    expect(container.querySelectorAll("br")).toHaveLength(4);
    expect(
      container.querySelector(
        '[data-word-id="44444444-4444-4444-8444-444444444444"]',
      ),
    ).toHaveAttribute("data-line-index", "2");
    expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(1);
  });

  it("shows stored page text and does not render scanned or fallback imagery", () => {
    render(<BookPageViewer currentWordId={null} page={page} />);

    expect(screen.getByText("Mẹ đưa bé đến trường.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Nội dung OCR đã xác minh")).toBeInTheDocument();
  });
});
