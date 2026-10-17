import type { BookListItemDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  MetricViewModelUI,
  ProgressReportDTO,
  SessionHistoryItemViewModelUI,
} from "@/types/reports";
import type { HistorySessionSummaryDTO } from "@/types/reading";

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
  session: HistorySessionSummaryDTO,
  child: ChildProfileDTO,
  book: BookListItemDTO,
): SessionHistoryItemViewModelUI {
  return {
    session,
    book,
    child,
    started_label: formatHistoryDateTime(session.started_at),
    duration_label: formatHistoryDuration(session.duration_ms),
    state_label: historyStateLabel(session.state),
  };
}

export function formatHistoryDuration(durationMs: number | null): string {
  if (durationMs === null) return "Chưa có dữ liệu thời lượng";
  if (durationMs < 60_000) return `${Math.floor(durationMs / 1000)} giây`;
  return `${Math.floor(durationMs / 60_000)} phút ${Math.floor((durationMs % 60_000) / 1000)} giây`;
}

export function formatHistoryDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

export function historyStateLabel(
  state: HistorySessionSummaryDTO["state"],
): string {
  const labels: Record<HistorySessionSummaryDTO["state"], string> = {
    IN_PROGRESS: "Đang thực hiện",
    CREATED: "Đang chuẩn bị",
    PAGE_READY: "Đã nhận trang",
    LISTENING: "Đang đọc",
    PAUSED: "Đang tạm dừng",
    RECONNECTING: "Đang kết nối lại",
    QUESTIONING: "Đang trả lời",
    FINISHED: "Đã hoàn thành",
    ABORTED: "Đã dừng",
  };

  return labels[state];
}

export function historyPageFromCursor(cursor: string): number | null {
  if (!/^page-[1-9][0-9]{0,5}$/.test(cursor)) return null;
  const page = Number(cursor.slice(5));
  return page <= 100000 ? page : null;
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
