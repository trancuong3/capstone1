export const PLANS_PAGE_SIZE = 4;
export const GOALS_PAGE_SIZE = 4;
export const COLLECTIONS_PAGE_SIZE = 5;
export const REMINDERS_PAGE_SIZE = 5;
export const DUE_PAGE_SIZE = 5;

export type ReadingManagementFocus =
  "ALL" | "PLANS" | "GOALS" | "REMINDERS" | "COLLECTIONS";

export type ActiveReadingForm = "plan" | "goal" | "reminder" | null;

export const weekdayOptions = [
  { key: "mon", value: 0 },
  { key: "tue", value: 1 },
  { key: "wed", value: 2 },
  { key: "thu", value: 3 },
  { key: "fri", value: 4 },
  { key: "sat", value: 5 },
  { key: "sun", value: 6 },
] as const;

export function localToday(timeZone = "Asia/Ho_Chi_Minh"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function clock(value: string): string {
  return value.slice(0, 5);
}

export function formatWeekdaysFull(
  weekdays: readonly number[],
  t: (key: string) => string,
): string {
  return weekdays
    .map((day) => {
      const option = weekdayOptions.find((item) => item.value === day);
      return option ? t(`readingManagement.weekdaysShort.${option.key}`) : "";
    })
    .filter(Boolean)
    .join(", ");
}

export function formatReminderSchedule(
  weekdays: readonly number[],
  t: (key: string) => string,
): string {
  const uniqueDays = new Set(weekdays);
  const hasZeroToSix = [0, 1, 2, 3, 4, 5, 6].every((day) =>
    uniqueDays.has(day),
  );
  const hasOneToSeven = [1, 2, 3, 4, 5, 6, 7].every((day) =>
    uniqueDays.has(day),
  );
  if (hasZeroToSix || hasOneToSeven) {
    return t("readingManagement.dailyFrequency");
  }
  const hasWeekdaysOnly =
    uniqueDays.size === 5 &&
    [0, 1, 2, 3, 4].every((day) => uniqueDays.has(day));
  if (hasWeekdaysOnly) {
    return t("readingManagement.weekdaysRangeMonFri");
  }
  return formatWeekdaysFull(weekdays, t);
}
