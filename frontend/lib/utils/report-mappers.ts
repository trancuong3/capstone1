import type { BookListItemDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  MetricViewModelUI,
  ProgressReportDTO,
  SessionHistoryItemViewModelUI,
} from "@/types/reports";
import type { HistorySessionSummaryDTO } from "@/types/reading";
import { formatProgressDuration } from "@/lib/utils/progress-report-state";
import { REPORT_TIMEZONE } from "@/lib/utils/report-state";

const dateTimeFormatter = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: REPORT_TIMEZONE,
});

const timeFormatter = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: REPORT_TIMEZONE,
});

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: REPORT_TIMEZONE,
});

export type HistoryStateTone = "success" | "info" | "warning" | "neutral";

export interface HistoryStatePresentation {
  readonly label: string;
  readonly tone: HistoryStateTone;
  readonly badgeClassName: string;
}

const HISTORY_STATE_BADGE_CLASSES: Record<HistoryStateTone, string> = {
  success: "border border-success-ink/20 bg-success-surface text-success-ink",
  info: "border border-primary/20 bg-sky text-primary-hover",
  warning: "border border-warning/25 bg-warning-surface text-warning",
  neutral: "border border-border bg-canvas text-muted",
};

const HISTORY_STATE_TONES: Record<
  HistorySessionSummaryDTO["state"],
  HistoryStateTone
> = {
  FINISHED: "success",
  IN_PROGRESS: "info",
  CREATED: "info",
  PAGE_READY: "info",
  LISTENING: "info",
  QUESTIONING: "info",
  PAUSED: "warning",
  RECONNECTING: "warning",
  ABORTED: "neutral",
};

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
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} giây`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} phút` : `${minutes} phút ${seconds} giây`;
}

export function formatHistoryDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

export function formatHistoryTime(value: string): string {
  return timeFormatter.format(new Date(value));
}

export function historyDayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = dayKeyFormatter.formatToParts(date);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return `${map.get("year")}-${map.get("month")}-${map.get("day")}`;
}

export function formatHistoryDayHeading(
  dayKey: string,
  now: Date = new Date(),
): string {
  const todayKey = historyDayKey(now);
  if (dayKey === todayKey) return "Hôm nay";

  const todayUtcNoon = new Date(`${todayKey}T12:00:00.000Z`);
  todayUtcNoon.setUTCDate(todayUtcNoon.getUTCDate() - 1);
  const yesterdayKey = todayUtcNoon.toISOString().slice(0, 10);
  if (dayKey === yesterdayKey) return "Hôm qua";

  const [yearStr, monthStr, dayStr] = dayKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const currentYear = Number(todayKey.slice(0, 4));
  if (!year || !month || !day) return dayKey;
  return year === currentYear
    ? `${day} tháng ${month}`
    : `${day} tháng ${month}, ${year}`;
}

export interface SessionHistoryDayGroup {
  readonly dayKey: string;
  readonly heading: string;
  readonly items: readonly SessionHistoryItemViewModelUI[];
}

export function groupSessionHistoryByDay(
  items: readonly SessionHistoryItemViewModelUI[],
  now: Date = new Date(),
): readonly SessionHistoryDayGroup[] {
  const groups: {
    dayKey: string;
    heading: string;
    items: SessionHistoryItemViewModelUI[];
  }[] = [];

  for (const item of items) {
    const key = historyDayKey(item.session.started_at);
    const previous = groups.at(-1);
    if (previous && previous.dayKey === key) {
      previous.items.push(item);
    } else {
      groups.push({
        dayKey: key,
        heading: formatHistoryDayHeading(key, now),
        items: [item],
      });
    }
  }

  return groups;
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

export function getHistoryStatePresentation(
  state: HistorySessionSummaryDTO["state"],
): HistoryStatePresentation {
  const tone = HISTORY_STATE_TONES[state];
  return {
    label: historyStateLabel(state),
    tone,
    badgeClassName: HISTORY_STATE_BADGE_CLASSES[tone],
  };
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
      value:
        report.completed_sessions === null
          ? "Chưa có dữ liệu"
          : `${report.completed_sessions} buổi`,
      hint: "Trong kỳ đang chọn",
      unavailable: report.completed_sessions === null,
    },
    {
      id: "duration",
      label: "Thời gian đọc",
      value: formatProgressDuration(report.reading_duration_ms),
      hint: "Tổng thời lượng trong kỳ",
      unavailable: report.reading_duration_ms === null,
    },
    {
      id: "comprehension",
      label: "Câu hỏi đọc hiểu",
      value: formatPercent(report.comprehension_accuracy),
      hint: "Tỷ lệ trả lời đúng",
      unavailable: report.comprehension_accuracy === null,
    },
    {
      id: "omission",
      label: "Tỷ lệ bỏ sót",
      value: formatPercent(report.omission_rate),
      hint:
        report.omission_count === null
          ? "Chưa có số lần bỏ sót"
          : `${report.omission_count} lần bỏ sót trong kỳ`,
      unavailable: report.omission_rate === null,
    },
  ];

  return metrics;
}
