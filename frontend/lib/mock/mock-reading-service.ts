import type { BookService } from "@/lib/api/book-service";
import type { ReadingService } from "@/lib/api/reading-service";
import { ServiceError } from "@/lib/api/service-error";
import type { MockAppStore } from "@/lib/mock/mock-app-store";
import {
  cloneReadingPage,
  MOCK_COMPLETION_SUMMARY,
  MOCK_READING_PAGES,
  MOCK_READING_SESSION,
  MOCK_READING_SESSION_ID,
  waitForReadingMock,
} from "@/lib/mock/mock-reading-data";
import type {
  ReadingSessionCreateDTO,
  ReadingSessionSummaryDTO,
} from "@/types/reading";

function assertSession(sessionId: string): void {
  if (sessionId !== MOCK_READING_SESSION_ID) {
    throw new ServiceError({
      code: "RESOURCE_NOT_FOUND",
      message: "Không tìm thấy buổi đọc.",
      status: 404,
      request_id: "mock-reading-session-not-found",
      retryable: false,
    });
  }
}

export function createMockReadingService(
  store: MockAppStore,
  bookService: BookService,
): ReadingService {
  let finishedSession: ReadingSessionSummaryDTO | null = null;
  let finishPromise: Promise<ReadingSessionSummaryDTO> | null = null;

  return {
    async create(input: ReadingSessionCreateDTO) {
      await waitForReadingMock();

      if (!input.child_id || !input.book_id || input.mode !== "realtime") {
        throw new ServiceError({
          code: "VALIDATION_ERROR",
          message: "Dữ liệu buổi đọc chưa hợp lệ.",
          status: 422,
          request_id: "mock-reading-create-invalid",
          retryable: false,
        });
      }

      const child = store.children.get(input.child_id);
      if (!child || child.parent_id !== store.currentParentId) {
        throw new ServiceError({
          code: "RESOURCE_NOT_FOUND",
          message: "Không tìm thấy dữ liệu.",
          status: 404,
          request_id: "mock-reading-child-not-found",
          retryable: false,
        });
      }

      // BookService is the single catalog eligibility boundary. Its `get`
      // contract distinguishes an unknown book from inactive/unverified content.
      await bookService.get(input.book_id);

      return {
        session_id: MOCK_READING_SESSION_ID,
        state: "CREATED",
        session_token: "mock-short-lived-reading-token",
        expires_at: "2026-08-13T08:30:00.000Z",
      };
    },

    async get(sessionId) {
      assertSession(sessionId);
      await waitForReadingMock();
      return { ...(finishedSession ?? MOCK_READING_SESSION) };
    },

    async getCurrentPage(sessionId) {
      assertSession(sessionId);
      await waitForReadingMock();
      return cloneReadingPage(MOCK_READING_PAGES[0]);
    },

    async getCompletionSummary(sessionId) {
      assertSession(sessionId);
      await waitForReadingMock();
      return { ...MOCK_COMPLETION_SUMMARY };
    },

    async finish(sessionId) {
      assertSession(sessionId);

      if (finishedSession) {
        return { ...finishedSession };
      }

      if (!finishPromise) {
        finishPromise = waitForReadingMock().then(() => {
          finishedSession = {
            ...MOCK_READING_SESSION,
            state: "FINISHED",
            ended_at: "2026-08-13T08:08:00.000Z",
            duration_ms: 480_000,
          };
          return { ...finishedSession };
        });
      }

      return finishPromise;
    },
  };
}
