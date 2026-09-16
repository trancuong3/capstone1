import type { DifficultWordService } from "@/lib/api/difficult-word-service";
import { ServiceError } from "@/lib/api/service-error";
import {
  MOCK_CURRENT_CHILD_ID,
  type MockAppStore,
} from "@/lib/mock/mock-app-store";
import {
  cloneDifficultWord,
  MOCK_DIFFICULT_WORDS,
  waitForReportMock,
} from "@/lib/mock/mock-report-data";
import type {
  DifficultWordDTO,
  DifficultWordPracticeResultUI,
  Group5DemoState,
} from "@/types/reports";

function waitForever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function notFound(): ServiceError {
  return new ServiceError({
    code: "RESOURCE_NOT_FOUND",
    message: "Không tìm thấy dữ liệu.",
    status: 404,
    request_id: "mock-difficult-word-not-found",
    retryable: false,
  });
}

function assertOwned(store: MockAppStore, childId: string): void {
  const child = store.children.get(childId);
  if (!child || child.parent_id !== store.currentParentId) throw notFound();
}

export function createMockDifficultWordService(
  store: MockAppStore,
  scenario: Group5DemoState,
): DifficultWordService {
  return {
    async list(childId): Promise<DifficultWordDTO[]> {
      if (scenario === "loading") return waitForever();
      await waitForReportMock();
      if (scenario === "error") throw new Error("Mock words unavailable");
      if (scenario === "not-found") throw notFound();
      assertOwned(store, childId);
      if (scenario === "empty" || scenario === "insufficient-evidence") {
        return [];
      }
      if (childId !== MOCK_CURRENT_CHILD_ID) return [];
      return MOCK_DIFFICULT_WORDS.map(cloneDifficultWord);
    },

    async practice(
      childId,
      normalizedWord,
    ): Promise<DifficultWordPracticeResultUI> {
      await waitForReportMock(180);
      assertOwned(store, childId);
      if (childId !== MOCK_CURRENT_CHILD_ID) throw notFound();
      const word = MOCK_DIFFICULT_WORDS.find(
        (item) => item.normalized_word === normalizedWord,
      );
      if (!word) throw notFound();
      return {
        normalized_word: normalizedWord,
        action_id: "77000000-0000-4000-8000-000000000001",
        message: `Mình cùng nhìn và đọc chậm từ “${word.display_text}” nhé.`,
        evidence_count_unchanged: true,
      };
    },
  };
}
