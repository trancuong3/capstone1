import type { Group5DemoState, ReportDateWindow } from "@/types/reports";

export const REPORT_TIMEZONE = "Asia/Ho_Chi_Minh" as const;
export const REPORT_DEFAULT_DAYS = 30;
export const DIFFICULT_WORD_DEFAULT_DAYS = 90;

export function currentDateInReportTimezone(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

const states = new Set<Group5DemoState>([
  "default",
  "loading",
  "empty",
  "error",
  "not-found",
  "no-prior-period",
  "incomplete",
  "no-events",
  "no-questions",
  "insufficient-evidence",
]);

export function firstQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseGroup5DemoState(
  value: string | string[] | undefined,
): Group5DemoState {
  const candidate = firstQueryValue(value);
  return candidate && states.has(candidate as Group5DemoState)
    ? (candidate as Group5DemoState)
    : "default";
}

export function parseHistoryPage(value: string | string[] | undefined): number {
  const candidate = Number.parseInt(firstQueryValue(value) ?? "1", 10);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 1;
}

export function createCalendarWindow(
  periodEnd: string,
  days: number,
): ReportDateWindow {
  const end = new Date(`${periodEnd}T12:00:00.000Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: periodEnd,
    days,
    timezone: REPORT_TIMEZONE,
  };
}
