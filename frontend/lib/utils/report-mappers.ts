import type { BookListItemDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  MetricViewModelUI,
  ProgressReportDTO,
  SessionHistoryItemViewModelUI,
} from "@/types/reports";
import type { ReadingSessionSummaryDTO } from "@/types/reading";

const dateTimeFormatter = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Ho_Chi_Minh",
});

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "Chưa hoàn tất";
  const minutes = Math.max(0, Math.round(durationMs / 60_000));
  return `${minutes} phút`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "Chưa đủ dữ liệu" : `${value.toFixed(1)}%`;
}

export function mapSessionHistoryItem(
  session: ReadingSessionSummaryDTO,
  child: ChildProfileDTO,
  book: BookListItemDTO,
): SessionHistoryItemViewModelUI {
  const labels: Record<ReadingSessionSummaryDTO["state"], string> = {
    CREATED: "Đang chuẩn bị",
    PAGE_READY: "Đã nhận trang",
    LISTENING: "Đang đọc",
    PAUSED: "Đang tạm dừng",
    RECONNECTING: "Đang kết nối lại",
    QUESTIONING: "Đang trả lời",
    FINISHED: "Đã hoàn thành",
    ABORTED: "Đã dừng",
  };

  return {
    session,
    book,
    child,
    started_label: dateTimeFormatter.format(new Date(session.started_at)),
    duration_label: formatDuration(session.duration_ms),
    state_label: labels[session.state],
  };
}

export function mapReportMetrics(
  report: ProgressReportDTO,
): MetricViewModelUI[] {
  const metrics: MetricViewModelUI[] = [
    {
      id: "sessions",
      label: "Buổi đọc hoàn thành",
      value: `${report.completed_sessions} buổi`,
      hint: "Chỉ tính session FINISHED",
      unavailable: false,
    },
    {
      id: "duration",
      label: "Thời gian đọc",
      value: formatDuration(report.reading_duration_ms),
      hint: "Trong 30 ngày",
      unavailable: false,
    },
    {
      id: "comprehension",
      label: "Câu hỏi đọc hiểu",
      value: formatPercent(report.comprehension_accuracy),
      hint: "Đáp án có kết quả xác định",
      unavailable: report.comprehension_accuracy === null,
    },
    {
      id: "omission",
      label: "Tỷ lệ bỏ sót",
      value: formatPercent(report.omission_rate),
      hint: `${report.omission_count} bằng chứng đã xác nhận`,
      unavailable: report.omission_rate === null,
    },
  ];

  return metrics;
}
