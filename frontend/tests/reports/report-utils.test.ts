import { describe, expect, it } from "vitest";

import { MOCK_PROGRESS_REPORTS } from "@/lib/mock/mock-report-data";
import { formatPercent, mapReportMetrics } from "@/lib/utils/report-mappers";
import {
  createCalendarWindow,
  currentDateInReportTimezone,
} from "@/lib/utils/report-state";

describe("Group 5 report utilities", () => {
  it("creates inclusive 30-day and 90-day calendar windows", () => {
    expect(createCalendarWindow("2026-09-12", 30)).toMatchObject({
      period_start: "2026-08-14",
      period_end: "2026-09-12",
      days: 30,
      timezone: "Asia/Ho_Chi_Minh",
    });
    expect(createCalendarWindow("2026-09-12", 90).period_start).toBe(
      "2026-06-15",
    );
    expect(
      currentDateInReportTimezone(new Date("2026-09-11T18:30:00.000Z")),
    ).toBe("2026-09-12");
  });

  it("keeps unavailable rates nullable in the presentation", () => {
    const metrics = mapReportMetrics(MOCK_PROGRESS_REPORTS[1]);
    expect(formatPercent(null)).toBe("Chưa đủ dữ liệu");
    expect(
      metrics.find((metric) => metric.id === "comprehension"),
    ).toMatchObject({ unavailable: true, value: "Chưa đủ dữ liệu" });
  });
});
