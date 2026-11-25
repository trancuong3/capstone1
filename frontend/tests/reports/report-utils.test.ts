import { describe, expect, it } from "vitest";
import {
  bookFixture,
  childFixture,
  progressReportFixture,
  sessionSummaryFixture,
} from "@/test/fixtures/report-data-fixture";
import {
  formatHistoryDayHeading,
  formatHistoryDuration,
  formatPercent,
  getHistoryStatePresentation,
  groupSessionHistoryByDay,
  historyDayKey,
  mapReportMetrics,
  mapSessionHistoryItem,
} from "@/lib/utils/report-mappers";
import {
  createCalendarWindow,
  currentDateInReportTimezone,
} from "@/lib/utils/report-state";

describe("Report utilities with typed test data", () => {
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
    const metrics = mapReportMetrics(progressReportFixture);
    expect(formatPercent(null)).toBe("Chưa đủ dữ liệu");
    expect(
      metrics.find((metric) => metric.id === "comprehension"),
    ).toMatchObject({ unavailable: true, value: "Chưa đủ dữ liệu" });
  });

  it("distinguishes an actual zero from an unavailable rate", () => {
    const metrics = mapReportMetrics({
      ...progressReportFixture,
      omission_rate: 0,
      comprehension_accuracy: 0,
    });
    expect(
      metrics.find((metric) => metric.id === "comprehension"),
    ).toMatchObject({ unavailable: false, value: "0.0%" });
    expect(metrics.find((metric) => metric.id === "omission")).toMatchObject({
      unavailable: false,
      value: "0.0%",
    });
  });

  it("groups reading history by Vietnam timezone day headings across UTC midnight", () => {
    const now = new Date("2026-11-25T12:00:00+07:00");
    // 2026-11-24T17:30:00Z is 2026-11-25 00:30 in Asia/Ho_Chi_Minh -> Hôm nay
    expect(historyDayKey("2026-11-24T17:30:00Z")).toBe("2026-11-25");
    expect(formatHistoryDayHeading("2026-11-25", now)).toBe("Hôm nay");
    expect(formatHistoryDayHeading("2026-11-24", now)).toBe("Hôm qua");
    expect(formatHistoryDayHeading("2026-11-20", now)).toBe("20 tháng 11");
    expect(formatHistoryDayHeading("2025-12-31", now)).toBe(
      "31 tháng 12, 2025",
    );

    const items = [
      mapSessionHistoryItem(
        {
          ...sessionSummaryFixture,
          id: "s-1",
          started_at: "2026-11-25T02:00:00Z",
        },
        childFixture,
        bookFixture,
      ),
      mapSessionHistoryItem(
        {
          ...sessionSummaryFixture,
          id: "s-2",
          started_at: "2026-11-24T17:30:00Z",
        },
        childFixture,
        bookFixture,
      ),
      mapSessionHistoryItem(
        {
          ...sessionSummaryFixture,
          id: "s-3",
          started_at: "2026-11-24T10:00:00Z",
        },
        childFixture,
        bookFixture,
      ),
    ];

    const grouped = groupSessionHistoryByDay(items, now);
    expect(grouped.map((group) => [group.heading, group.items.length])).toEqual(
      [
        ["Hôm nay", 2],
        ["Hôm qua", 1],
      ],
    );
  });

  it("assigns distinct semantic tones to reading session states and formats durations cleanly", () => {
    expect(getHistoryStatePresentation("FINISHED").tone).toBe("success");
    expect(getHistoryStatePresentation("ABORTED").tone).toBe("neutral");
    expect(getHistoryStatePresentation("PAUSED").tone).toBe("warning");
    expect(getHistoryStatePresentation("IN_PROGRESS").tone).toBe("info");

    expect(formatHistoryDuration(null)).toBe("Chưa có dữ liệu thời lượng");
    expect(formatHistoryDuration(120_000)).toBe("2 phút");
    expect(formatHistoryDuration(95_000)).toBe("1 phút 35 giây");
    expect(formatHistoryDuration(45_000)).toBe("45 giây");
  });
});
