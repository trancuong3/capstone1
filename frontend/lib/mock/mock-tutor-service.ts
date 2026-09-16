import type { TutorService } from "@/lib/api/tutor-service";
import { ServiceError } from "@/lib/api/service-error";
import {
  MOCK_READING_SESSION_ID,
  waitForReadingMock,
} from "@/lib/mock/mock-reading-data";

const MOCK_TUTOR_ACTION_ID = "70000000-0000-4000-8000-000000000001";

function unavailableError(): ServiceError {
  return new ServiceError({
    code: "TTS_UNAVAILABLE",
    message: "Chưa thể phát mẫu đọc.",
    status: 503,
    request_id: "mock-tts-unavailable",
    retryable: true,
  });
}

function assertSession(sessionId: string): void {
  if (sessionId !== MOCK_READING_SESSION_ID) {
    throw new ServiceError({
      code: "RESOURCE_NOT_FOUND",
      message: "Không tìm thấy dữ liệu.",
      status: 404,
      request_id: "mock-tutor-session-not-found",
      retryable: false,
    });
  }
}

export function createMockTutorService(): TutorService {
  return {
    async requestReadExample(sessionId, wordId) {
      assertSession(sessionId);
      await waitForReadingMock();
      return {
        action: "READ_EXAMPLE",
        page_revision_word_id: wordId,
        message_code: "READ_EXAMPLE_READY",
        tts_text: "đang",
        action_id: MOCK_TUTOR_ACTION_ID,
      };
    },

    async retryReadExample(action) {
      await waitForReadingMock();

      if (
        action.action !== "READ_EXAMPLE" ||
        action.action_id !== MOCK_TUTOR_ACTION_ID
      ) {
        throw unavailableError();
      }

      return { ...action, message_code: "READ_EXAMPLE_REPLAYED" };
    },
  };
}
