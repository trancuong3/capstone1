import type { ReportService } from "@/lib/api/report-service";
import { ServiceError } from "@/lib/api/service-error";
import type { MockAppStore } from "@/lib/mock/mock-app-store";
import {
  cloneProgressReport,
  MOCK_PROGRESS_REPORTS,
  waitForReportMock,
} from "@/lib/mock/mock-report-data";
import type { Group5DemoState, ProgressReportDTO } from "@/types/reports";

function waitForever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function notFound(): ServiceError {
  return new ServiceError({
    code: "RESOURCE_NOT_FOUND",
    message: "Không tìm thấy dữ liệu.",
    status: 404,
    request_id: "mock-report-not-found",
    retryable: false,
  });
}

function emptyReport(report: ProgressReportDTO): ProgressReportDTO {
  return {
    ...report,
    completed_sessions: 0,
    reading_duration_ms: 0,
    omission_count: 0,
    repetition_count: 0,
    long_pause_count: 0,
    omission_rate: null,
    repetition_rate: null,
    long_pause_rate: null,
    comprehension_accuracy: null,
    difficult_words: [],
    previous_period: null,
    trend_deltas: {
      completed_sessions: null,
      reading_duration_ms: null,
      omission_rate: null,
      repetition_rate: null,
      long_pause_rate: null,
      comprehension_accuracy: null,
    },
  };
}

export function createMockReportService(
  store: MockAppStore,
  scenario: Group5DemoState,
): ReportService {
  return {
    async get(childId, window): Promise<ProgressReportDTO> {
      if (scenario === "loading") return waitForever();
      await waitForReportMock();
      if (scenario === "error") throw new Error("Mock report unavailable");
      const child = store.children.get(childId);
      if (
        scenario === "not-found" ||
        !child ||
        child.parent_id !== store.currentParentId
      ) {
        throw notFound();
      }

      const source = MOCK_PROGRESS_REPORTS.find(
        (report) => report.child_id === childId,
      );
      if (!source) throw notFound();
      let report = cloneProgressReport(source);
      if (window) {
        report = {
          ...report,
          period_start: window.period_start,
          period_end: window.period_end,
        };
      }
      if (scenario === "empty") return emptyReport(report);
      if (scenario === "no-prior-period") {
        return {
          ...report,
          previous_period: null,
          trend_deltas: {
            completed_sessions: null,
            reading_duration_ms: null,
            omission_rate: null,
            repetition_rate: null,
            long_pause_rate: null,
            comprehension_accuracy: null,
          },
        };
      }
      return report;
    },
  };
}
