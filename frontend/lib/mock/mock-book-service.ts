import type { BookService } from "@/lib/api/book-service";
import { ServiceError } from "@/lib/api/service-error";
import type {
  BookCatalogQuery,
  BookDetailDTO,
  BookLifecycleStatus,
  BookListItemDTO,
  BookPagePreviewDTO,
} from "@/types/book";
import type { AppMockScenario } from "@/types/ui-state";

const MOCK_DELAY_MS = 350;

export const MOCK_RETIRED_READING_BOOK_ID =
  "20000000-0000-4000-8000-000000000005";
export const MOCK_UNVERIFIED_READING_BOOK_ID =
  "20000000-0000-4000-8000-000000000006";

interface MockPageRecord {
  readonly page_id: string;
  readonly page_number: number;
  readonly lifecycle_status: BookLifecycleStatus;
  readonly current_verified_revision_id: string | null;
  readonly verification_status: "PROCESSING" | "NEEDS_REVIEW" | "VERIFIED";
  readonly preview_url: string;
}

interface MockBookRecord {
  readonly book: BookListItemDTO;
  readonly pages: readonly MockPageRecord[];
}

function createPage(
  bookSequence: number,
  pageNumber: number,
  previewUrl: string,
): MockPageRecord {
  const sequence = String(bookSequence * 10 + pageNumber).padStart(12, "0");

  return {
    page_id: `30000000-0000-4000-8000-${sequence}`,
    page_number: pageNumber,
    lifecycle_status: "ACTIVE",
    current_verified_revision_id: `40000000-0000-4000-8000-${sequence}`,
    verification_status: "VERIFIED",
    preview_url: previewUrl,
  };
}

const MOCK_BOOK_RECORDS: readonly MockBookRecord[] = [
  {
    book: {
      id: "20000000-0000-4000-8000-000000000001",
      title: "Chú Mèo Nhỏ",
      author: "Nhóm ReadAlong",
      min_grade: 2,
      max_grade: 2,
      lifecycle_status: "ACTIVE",
    },
    pages: [4, 5, 6].map((page) =>
      createPage(1, page, "/images/figma/book-cat.svg"),
    ),
  },
  {
    book: {
      id: "20000000-0000-4000-8000-000000000002",
      title: "Khu Vườn Của Em",
      author: "Nhóm ReadAlong",
      min_grade: 2,
      max_grade: 2,
      lifecycle_status: "ACTIVE",
    },
    pages: [2, 3, 4].map((page) =>
      createPage(2, page, "/images/figma/book-garden.svg"),
    ),
  },
  {
    book: {
      id: "20000000-0000-4000-8000-000000000003",
      title: "Chuyến Đi Đầu Tiên",
      author: "Nhóm ReadAlong",
      min_grade: 2,
      max_grade: 2,
      lifecycle_status: "ACTIVE",
    },
    pages: [1, 2, 3].map((page) =>
      createPage(3, page, "/images/figma/book-travel.svg"),
    ),
  },
  {
    book: {
      id: "20000000-0000-4000-8000-000000000004",
      title: "Cây Khế",
      author: "Truyện dân gian Việt Nam",
      min_grade: 2,
      max_grade: 2,
      lifecycle_status: "ACTIVE",
    },
    pages: [6, 7, 8].map((page) =>
      createPage(4, page, "/images/figma/book-starfruit.svg"),
    ),
  },
  {
    book: {
      id: MOCK_RETIRED_READING_BOOK_ID,
      title: "Sách đã ngừng phát hành",
      author: "Nhóm ReadAlong",
      min_grade: 2,
      max_grade: 3,
      lifecycle_status: "RETIRED",
    },
    pages: [createPage(5, 1, "/images/figma/book-garden.svg")],
  },
  {
    book: {
      id: MOCK_UNVERIFIED_READING_BOOK_ID,
      title: "Bản thảo đang duyệt",
      author: "Nhóm ReadAlong",
      min_grade: 1,
      max_grade: 2,
      lifecycle_status: "ACTIVE",
    },
    pages: [
      {
        page_id: "30000000-0000-4000-8000-000000000061",
        page_number: 1,
        lifecycle_status: "ACTIVE",
        current_verified_revision_id: null,
        verification_status: "NEEDS_REVIEW",
        preview_url: "/images/figma/book-cat.svg",
      },
    ],
  },
];

function waitForMock(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return Promise.resolve();
  }

  return new Promise((resolve) =>
    globalThis.setTimeout(resolve, MOCK_DELAY_MS),
  );
}

function waitForever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function normalize(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("vi");
}

function isEligiblePage(page: MockPageRecord): boolean {
  return (
    page.lifecycle_status === "ACTIVE" &&
    page.verification_status === "VERIFIED" &&
    page.current_verified_revision_id !== null
  );
}

function isEligibleBook(record: MockBookRecord): boolean {
  return (
    record.book.lifecycle_status === "ACTIVE" &&
    record.pages.some(isEligiblePage)
  );
}

function cloneBook(book: BookListItemDTO): BookListItemDTO {
  return { ...book };
}

function toPageDTO(page: MockPageRecord): BookPagePreviewDTO | null {
  if (!isEligiblePage(page) || !page.current_verified_revision_id) {
    return null;
  }

  return {
    page_id: page.page_id,
    page_number: page.page_number,
    lifecycle_status: page.lifecycle_status,
    current_verified_revision_id: page.current_verified_revision_id,
    preview_url: page.preview_url,
  };
}

function notFoundError(): ServiceError {
  return new ServiceError({
    code: "RESOURCE_NOT_FOUND",
    message: "Không tìm thấy sách.",
    status: 404,
    request_id: "mock-book-not-found",
    retryable: false,
  });
}

function inactiveError(): ServiceError {
  return new ServiceError({
    code: "CONTENT_INACTIVE",
    message: "Nội dung hiện không hoạt động.",
    status: 409,
    request_id: "mock-book-inactive",
    retryable: false,
  });
}

function getRecord(bookId: string): MockBookRecord {
  const record = MOCK_BOOK_RECORDS.find((item) => item.book.id === bookId);

  if (!record) {
    throw notFoundError();
  }

  if (!isEligibleBook(record)) {
    throw inactiveError();
  }

  return record;
}

function matchesQuery(book: BookListItemDTO, query: BookCatalogQuery): boolean {
  const search = normalize(query.search ?? "");
  const author = normalize(query.author ?? "");
  const bookAuthor = normalize(book.author ?? "");

  if (
    search &&
    !normalize(book.title).includes(search) &&
    !bookAuthor.includes(search)
  ) {
    return false;
  }

  if (author && !bookAuthor.includes(author)) {
    return false;
  }

  if (
    query.grade !== undefined &&
    (query.grade < book.min_grade || query.grade > book.max_grade)
  ) {
    return false;
  }

  return true;
}

export function createMockBookService(scenario: AppMockScenario): BookService {
  return {
    async list(query = {}): Promise<BookListItemDTO[]> {
      if (scenario === "loading") {
        return waitForever<BookListItemDTO[]>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock catalog service is unavailable.");
      }

      if (scenario === "empty") {
        return [];
      }

      return MOCK_BOOK_RECORDS.filter(isEligibleBook)
        .map((record) => record.book)
        .filter((book) => matchesQuery(book, query))
        .map(cloneBook);
    },

    async get(bookId): Promise<BookDetailDTO> {
      if (scenario === "loading") {
        return waitForever<BookDetailDTO>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock catalog service is unavailable.");
      }

      if (scenario === "not-found") {
        throw notFoundError();
      }

      if (scenario === "unavailable") {
        throw inactiveError();
      }

      return cloneBook(getRecord(bookId).book);
    },

    async listPages(bookId): Promise<BookPagePreviewDTO[]> {
      if (scenario === "loading") {
        return waitForever<BookPagePreviewDTO[]>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock catalog service is unavailable.");
      }

      if (scenario === "not-found") {
        throw notFoundError();
      }

      if (scenario === "unavailable") {
        throw inactiveError();
      }

      return getRecord(bookId)
        .pages.map(toPageDTO)
        .filter((page): page is BookPagePreviewDTO => page !== null)
        .sort((left, right) => left.page_number - right.page_number);
    },
  };
}
