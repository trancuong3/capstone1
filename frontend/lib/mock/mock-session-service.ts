import type { SessionService } from "@/lib/api/session-service";
import { ServiceError } from "@/lib/api/service-error";
import type { MockAppStore } from "@/lib/mock/mock-app-store";
import {
  cloneSessionDetail,
  MOCK_SESSION_DETAILS,
  MOCK_SESSION_SUMMARIES,
  waitForReportMock,
} from "@/lib/mock/mock-report-data";
import type { Group5DemoState } from "@/types/reports";
import type {
  ReadingSessionDetailDTO,
  SessionHistoryResponseDTO,
} from "@/types/reading";

function waitForever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function notFound(): ServiceError {
  return new ServiceError({
    code: "RESOURCE_NOT_FOUND",
    message: "Không tìm thấy dữ liệu.",
    status: 404,
    request_id: "mock-session-not-found",
    retryable: false,
  });
}

function assertOwnedChild(store: MockAppStore, childId: string): void {
  const child = store.children.get(childId);
  if (!child || child.parent_id !== store.currentParentId) throw notFound();
}

export function createMockSessionService(
  store: MockAppStore,
  scenario: Group5DemoState,
): SessionService {
  return {
    async list(childId, query = {}): Promise<SessionHistoryResponseDTO> {
      if (scenario === "loading") return waitForever();
      await waitForReportMock();
      if (scenario === "error") throw new Error("Mock session unavailable");
      if (scenario === "not-found") throw notFound();
      assertOwnedChild(store, childId);
      if (scenario === "empty") return { sessions: [], next_cursor: null };

      const limit = Math.min(Math.max(query.limit ?? 20, 1), 20);
      const pageMatch = query.cursor?.match(/^page-(\d+)$/);
      const page = pageMatch ? Number.parseInt(pageMatch[1], 10) : 1;
      const sessions = MOCK_SESSION_SUMMARIES.filter(
        (session) => session.child_id === childId,
      ).sort(
        (left, right) =>
          right.started_at.localeCompare(left.started_at) ||
          right.id.localeCompare(left.id),
      );
      const start = (page - 1) * limit;
      const slice = sessions.slice(start, start + limit).map((item) => ({
        ...item,
      }));
      return {
        sessions: slice,
        next_cursor:
          start + limit < sessions.length ? `page-${page + 1}` : null,
      };
    },

    async get(sessionId): Promise<ReadingSessionDetailDTO> {
      if (scenario === "loading") return waitForever();
      await waitForReportMock();
      if (scenario === "error") throw new Error("Mock session unavailable");
      if (scenario === "not-found") throw notFound();

      const detail = MOCK_SESSION_DETAILS.find((item) => item.id === sessionId);
      if (!detail) throw notFound();
      assertOwnedChild(store, detail.child_id);

      const clone = cloneSessionDetail(detail);
      if (scenario === "incomplete") {
        return {
          ...clone,
          state: "PAUSED",
          ended_at: null,
          duration_ms: null,
          fluency_assessment: null,
          report_id: null,
        };
      }
      if (scenario === "no-events") return { ...clone, events: [] };
      if (scenario === "no-questions") {
        return { ...clone, comprehension: [] };
      }
      return clone;
    },
  };
}
