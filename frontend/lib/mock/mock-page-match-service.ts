import type { PageMatchService } from "@/lib/api/page-match-service";
import { ServiceError } from "@/lib/api/service-error";
import {
  cloneReadingPage,
  getMockReadingPage,
  MOCK_READING_PAGES,
  MOCK_READING_SESSION_ID,
  waitForReadingMock,
} from "@/lib/mock/mock-reading-data";

function assertSession(sessionId: string): void {
  if (sessionId !== MOCK_READING_SESSION_ID) {
    throw new ServiceError({
      code: "RESOURCE_NOT_FOUND",
      message: "Không tìm thấy buổi đọc.",
      status: 404,
      request_id: "mock-page-match-session-not-found",
      retryable: false,
    });
  }
}

export function createMockPageMatchService(): PageMatchService {
  return {
    async retryCurrentPage(sessionId) {
      assertSession(sessionId);
      await waitForReadingMock();
      return cloneReadingPage(MOCK_READING_PAGES[0]);
    },

    async selectPage(sessionId, selectedPageId) {
      assertSession(sessionId);
      await waitForReadingMock();
      const page = getMockReadingPage(selectedPageId);

      if (!page) {
        throw new ServiceError({
          code: "PAGE_NOT_IN_SESSION_BOOK",
          message: "Trang không thuộc cuốn sách của buổi đọc.",
          status: 409,
          request_id: "mock-page-not-in-book",
          retryable: false,
        });
      }

      return cloneReadingPage(page);
    },
  };
}
