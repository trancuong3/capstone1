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
  it("preserves OCR line and paragraph boundaries while keeping word controls", () => {
    const pageWithLayout: ReadingPageDTO = {
      ...page,
      words: [
        { word_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", word_index: 0, line_index: 0, text: "Mèo", bbox: [0.1, 0.1, 0.1, 0.05] },
        { word_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", word_index: 1, line_index: 0, text: "nhỏ.", bbox: [0.22, 0.1, 0.1, 0.05] },
        { word_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", word_index: 2, line_index: 1, text: "Đang", bbox: [0.1, 0.2, 0.1, 0.05] },
        { word_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", word_index: 3, line_index: 3, text: "ngủ.", bbox: [0.1, 0.3, 0.1, 0.05] },
      ],
    };
    const { container } = render(
      <BookPageViewer currentWordId={null} page={pageWithLayout} />,
    );

    expect(container.querySelector('[data-line-index="0"]')).toBeInTheDocument();
    expect(container.querySelector('[data-line-index="1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-line-index="3"]')).toHaveClass("pl-5");
    expect(screen.getByText("Mèo")).toBeInTheDocument();
    expect(screen.getByText("ngủ.")).toBeInTheDocument();
  });

  it("shows stored page text and does not render scanned or fallback imagery", () => {
    render(<BookPageViewer currentWordId={null} page={page} />);

    expect(screen.getByText("Mẹ đưa bé đến trường.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Nội dung OCR đã xác minh")).toBeInTheDocument();
  });
});
