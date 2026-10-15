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
  it("shows stored page text and does not render scanned or fallback imagery", () => {
    render(
      <BookPageViewer
        currentWordId={null}
        page={page}
      />,
    );

    expect(screen.getByText("Mẹ đưa bé đến trường.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Nội dung OCR đã xác minh")).toBeInTheDocument();
  });
});
