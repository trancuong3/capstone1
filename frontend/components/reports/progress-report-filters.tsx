"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/common/button";
import { progressHref } from "@/lib/utils/progress-report-state";
import type { ProgressPeriodOptionDTO } from "@/types/reports";

interface ProgressReportFiltersProps {
  readonly periods: readonly ProgressPeriodOptionDTO[];
  readonly selectedPeriod: {
    readonly period_start: string;
    readonly period_end: string;
  } | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
}

export function ProgressReportFilters({
  periods,
  selectedPeriod,
  hasMore,
  loadingMore,
  onLoadMore,
}: ProgressReportFiltersProps) {
  const router = useRouter();
  const key = selectedPeriod
    ? `${selectedPeriod.period_start}/${selectedPeriod.period_end}`
    : "latest";
  const selectedMissing =
    selectedPeriod &&
    !periods.some((item) => `${item.period_start}/${item.period_end}` === key);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <label
          className="mb-2 block text-sm font-bold text-ink"
          htmlFor="saved-report-period"
        >
          Kỳ báo cáo đã lưu
        </label>
        <select
          id="saved-report-period"
          className="min-h-12 w-full rounded-control border border-border bg-white px-3 text-label text-ink focus-visible:outline-3 focus-visible:outline-primary"
          value={key}
          onChange={(event) => {
            const value = event.target.value;
            const item = periods.find(
              (period) =>
                `${period.period_start}/${period.period_end}` === value,
            );
            if (value === "latest") router.push(progressHref());
            else if (item) router.push(progressHref(item));
          }}
        >
          <option value="latest">Mới nhất</option>
          {selectedMissing ? (
            <option value={key}>
              {selectedPeriod.period_start} → {selectedPeriod.period_end} (đang
              chọn)
            </option>
          ) : null}
          {periods.map((item) => (
            <option
              key={`${item.period_start}/${item.period_end}`}
              value={`${item.period_start}/${item.period_end}`}
            >
              {item.period_start} → {item.period_end}
            </option>
          ))}
        </select>
      </div>
      {hasMore ? (
        <Button
          className="whitespace-nowrap sm:w-auto"
          disabled={loadingMore}
          variant="secondary"
          onClick={onLoadMore}
        >
          {loadingMore ? "Đang tải kỳ…" : "Tải thêm kỳ"}
        </Button>
      ) : null}
    </div>
  );
}
