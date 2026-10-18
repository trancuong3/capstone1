import type { ReportDateWindow } from "@/types/reports";

export function parseProgressPeriod(
  start?: string | string[],
  end?: string | string[],
): ReportDateWindow | null | "invalid" {
  if (start === undefined && end === undefined) return null;
  const validDate = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDate(start) || !validDate(end) || end < start) return "invalid";
  return {
    period_start: start,
    period_end: end,
    days: Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1,
    timezone: "Asia/Ho_Chi_Minh",
  };
}

export function progressHref(
  childId: string,
  period?: Pick<ReportDateWindow, "period_start" | "period_end">,
): string {
  const query = new URLSearchParams({ childId });
  if (period) {
    query.set("period_start", period.period_start);
    query.set("period_end", period.period_end);
  }
  return `/reports?${query.toString()}`;
}

export function formatProgressDuration(value: number | null): string {
  if (value === null) return "Chưa có dữ liệu";
  if (value < 60000) return `${Math.floor(value / 1000)} giây`;
  return `${Math.floor(value / 60000)} phút ${Math.floor((value % 60000) / 1000)} giây`;
}

export function formatProgressGeneratedAt(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(value));
}
