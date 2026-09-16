import type { ComprehensionService } from "@/lib/api/comprehension-service";
import { ServiceError } from "@/lib/api/service-error";
import {
  MOCK_READING_SESSION_ID,
  waitForReadingMock,
} from "@/lib/mock/mock-reading-data";

const QUESTION_ID = "80000000-0000-4000-8000-000000000001";
const EXPECTED_ANSWER = "Bên cửa sổ";

function assertSession(sessionId: string): void {
  if (sessionId !== MOCK_READING_SESSION_ID) {
    throw new ServiceError({
      code: "RESOURCE_NOT_FOUND",
      message: "Không tìm thấy dữ liệu.",
      status: 404,
      request_id: "mock-question-session-not-found",
      retryable: false,
    });
  }
}

export function createMockComprehensionService(): ComprehensionService {
  return {
    async getQuestion(sessionId) {
      assertSession(sessionId);
      await waitForReadingMock();
      return {
        question: {
          id: QUESTION_ID,
          type: "FACTUAL",
          prompt: "Chú mèo đang nằm ở đâu?",
          page_revision_id: "40000000-0000-4000-8000-000000000014",
          source_span: {
            start_word_index: 0,
            end_word_index_exclusive: 8,
            sentence_index: 0,
          },
          difficulty: 2,
          answered: false,
        },
        progress_label: "Câu 2 / 5",
        choices: [
          { id: "A", label: "Trên bàn", value: "Trên bàn" },
          { id: "B", label: "Bên cửa sổ", value: "Bên cửa sổ" },
          { id: "C", label: "Trong vườn", value: "Trong vườn" },
        ],
      };
    },

    async submitAnswer(sessionId, questionId, answer) {
      assertSession(sessionId);
      await waitForReadingMock();

      if (questionId !== QUESTION_ID) {
        throw new ServiceError({
          code: "RESOURCE_NOT_FOUND",
          message: "Không tìm thấy câu hỏi.",
          status: 404,
          request_id: "mock-question-not-found",
          retryable: false,
        });
      }

      const isCorrect =
        answer.normalize("NFC").trim().toLocaleLowerCase("vi") ===
        EXPECTED_ANSWER.normalize("NFC").toLocaleLowerCase("vi");

      return {
        answer_id: "81000000-0000-4000-8000-000000000001",
        question_id: questionId,
        submitted_answer: answer,
        is_correct: isCorrect,
        score: isCorrect ? 1 : 0,
        feedback_code: isCorrect ? "CORRECT" : "TRY_AGAIN",
      };
    },
  };
}
