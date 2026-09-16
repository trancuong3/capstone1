import type { BookPagePreviewDTO } from "@/types/book";
import type {
  ReadingCompletionSummaryUI,
  ReadingPageDTO,
  ReadingPageWordDTO,
  ReadingSessionSummaryDTO,
  WordBoundingBox,
} from "@/types/reading";

export const MOCK_READING_SESSION_ID = "mock-session-001";
export const MOCK_READING_CHILD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const MOCK_READING_BOOK_ID = "20000000-0000-4000-8000-000000000001";

function word(
  pageNumber: number,
  wordIndex: number,
  text: string,
  bbox: WordBoundingBox,
): ReadingPageWordDTO {
  return {
    word_id: `50000000-0000-4000-8000-${String(pageNumber * 100 + wordIndex).padStart(12, "0")}`,
    word_index: wordIndex,
    text,
    bbox,
  };
}

const pageFourWords = [
  word(4, 0, "Chú", [0.04, 0.63, 0.09, 0.07]),
  word(4, 1, "mèo", [0.14, 0.63, 0.1, 0.07]),
  word(4, 2, "nhỏ", [0.25, 0.63, 0.09, 0.07]),
  word(4, 3, "đang", [0.35, 0.61, 0.13, 0.09]),
  word(4, 4, "nằm", [0.49, 0.63, 0.1, 0.07]),
  word(4, 5, "bên", [0.6, 0.63, 0.09, 0.07]),
  word(4, 6, "cửa", [0.7, 0.63, 0.09, 0.07]),
  word(4, 7, "sổ.", [0.8, 0.63, 0.07, 0.07]),
] as const;

const pageFiveWords = [
  word(5, 0, "Chú", [0.04, 0.63, 0.09, 0.07]),
  word(5, 1, "mèo", [0.14, 0.63, 0.1, 0.07]),
  word(5, 2, "nhỏ", [0.25, 0.63, 0.09, 0.07]),
  word(5, 3, "thức", [0.35, 0.61, 0.13, 0.09]),
  word(5, 4, "dậy", [0.49, 0.63, 0.09, 0.07]),
  word(5, 5, "thật", [0.59, 0.63, 0.09, 0.07]),
  word(5, 6, "vui.", [0.69, 0.63, 0.08, 0.07]),
] as const;

const pageSixWords = [
  word(6, 0, "Chú", [0.04, 0.63, 0.09, 0.07]),
  word(6, 1, "mèo", [0.14, 0.63, 0.1, 0.07]),
  word(6, 2, "nhỏ", [0.25, 0.63, 0.09, 0.07]),
  word(6, 3, "chào", [0.35, 0.61, 0.13, 0.09]),
  word(6, 4, "ngày", [0.49, 0.63, 0.1, 0.07]),
  word(6, 5, "mới.", [0.6, 0.63, 0.1, 0.07]),
] as const;

export const MOCK_READING_PAGES: readonly ReadingPageDTO[] = [
  {
    page_id: "30000000-0000-4000-8000-000000000014",
    page_revision_id: "40000000-0000-4000-8000-000000000014",
    page_number: 4,
    confidence: 0.94,
    width: 1200,
    height: 800,
    words: pageFourWords,
  },
  {
    page_id: "30000000-0000-4000-8000-000000000015",
    page_revision_id: "40000000-0000-4000-8000-000000000015",
    page_number: 5,
    confidence: 0.96,
    width: 1200,
    height: 800,
    words: pageFiveWords,
  },
  {
    page_id: "30000000-0000-4000-8000-000000000016",
    page_revision_id: "40000000-0000-4000-8000-000000000016",
    page_number: 6,
    confidence: 0.93,
    width: 1200,
    height: 800,
    words: pageSixWords,
  },
];

export const MOCK_READING_PAGE_PREVIEWS: readonly BookPagePreviewDTO[] =
  MOCK_READING_PAGES.map((page) => ({
    page_id: page.page_id,
    page_number: page.page_number,
    lifecycle_status: "ACTIVE",
    current_verified_revision_id: page.page_revision_id,
    preview_url: "/images/figma/book-cat.svg",
  }));

export const MOCK_READING_SESSION: ReadingSessionSummaryDTO = {
  id: MOCK_READING_SESSION_ID,
  child_id: MOCK_READING_CHILD_ID,
  book_id: MOCK_READING_BOOK_ID,
  state: "CREATED",
  started_at: "2026-08-13T08:00:00.000Z",
  ended_at: null,
  duration_ms: null,
};

export const MOCK_COMPLETION_SUMMARY: ReadingCompletionSummaryUI = {
  duration_minutes: 8,
  pages_explored: 2,
  practiced_words: 3,
};

export function cloneReadingPage(page: ReadingPageDTO): ReadingPageDTO {
  return {
    ...page,
    words: page.words.map((item) => ({ ...item, bbox: [...item.bbox] })),
  };
}

export function getMockReadingPage(pageId: string): ReadingPageDTO | undefined {
  return MOCK_READING_PAGES.find((page) => page.page_id === pageId);
}

export function waitForReadingMock(delay = 280): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return Promise.resolve();
  }

  return new Promise((resolve) => globalThis.setTimeout(resolve, delay));
}
