import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReadingPage,
  type ComparisonResult,
} from "@/lib/api/comparison-service";
import { ReadingReport } from "@/components/reading/ReadingReport";

vi.mock("@/lib/api/comparison-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/comparison-service")>();
  return { ...actual, getReadingPage: vi.fn() };
});

const mockedGetReadingPage = vi.mocked(getReadingPage);

const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const WORD_ID = "66666666-6666-4666-8666-666666666666";

const page = {
  page_id: PAGE_ID,
  page_revision_id: REVISION_ID,
  page_number: 1,
  confidence: null,
  width: 800,
  height: 1000,
  image_url: null,
  text: "má",
  words: [
    {
      word_id: WORD_ID,
      word_index: 0,
      text: "má",
      bbox: [0.1, 0.1, 0.08, 0.03] as [
        number,
        number,
        number,
        number,
      ],
      line_index: 0,
    },
  ],
};

function comparisonResult(
  bookWord: string,
  spokenWord: string,
): ComparisonResult {
  return {
    session_id: SESSION_ID,
    page_id: PAGE_ID,
    page_revision_id: REVISION_ID,
    distance: 1,
    alignment: [
      {
        book_word: bookWord,
        spoken_word: spokenWord,
        book_index: 0,
        spoken_index: 0,
        status: "SUBSTITUTE",
      },
    ],
    summary: {
      missing_words: [],
      extra_words: [],
      substitutions: [
        { book_word: bookWord, spoken_word: spokenWord, book_index: 0 },
      ],
      repeated_count: 0,
      repeated_words: [],
      hesitations: [],
      hesitation_seconds: null,
    },
  };
}

describe("ReadingReport Vietnamese ambiguity", () => {
  beforeEach(() => {
    mockedGetReadingPage.mockReset();
    mockedGetReadingPage.mockResolvedValue(page);
  });

  it("does not count a tone-mark-only STT substitution as a confirmed wrong word", async () => {
    render(
      <ReadingReport
        result={comparisonResult("má", "ma")}
        sessionId={SESSION_ID}
      />,
    );

    expect(await screen.findByText("má")).toBeInTheDocument();
    await waitFor(() => {
      const ambiguousMetric = screen
        .getByText("Chưa đủ bằng chứng")
        .parentElement;
      const wrongMetric = screen.getByText("Từ đọc nhầm").parentElement;

      expect(ambiguousMetric).toHaveTextContent("1");
      expect(wrongMetric).toHaveTextContent("0");
    });

    const displayedWord = document.querySelector(
      `[data-word-id="${WORD_ID}"]`,
    );
    expect(displayedWord).toHaveClass("bg-slate-100");
    expect(displayedWord).not.toHaveClass("bg-orange-200");
  });

  it("keeps a non-orthographic substitution in the wrong-word count", async () => {
    render(
      <ReadingReport
        result={comparisonResult("má", "mèo")}
        sessionId={SESSION_ID}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Từ đọc nhầm").parentElement).toHaveTextContent(
        "1",
      );
      expect(
        screen.getByText("Chưa đủ bằng chứng").parentElement,
      ).toHaveTextContent("0");
    });
  });
});
