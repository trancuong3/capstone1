"use client";

import { useRouter } from "next/navigation";
import { SelectField } from "@/components/common/select-field";
import { Button } from "@/components/common/button";
import { progressHref } from "@/lib/utils/progress-report-state";
import type { ChildProfileDTO } from "@/types/child";
import type { ProgressPeriodOptionDTO } from "@/types/reports";

interface ProgressReportFiltersProps {
  readonly childrenProfiles: readonly ChildProfileDTO[];
  readonly childId: string;
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
  childrenProfiles,
  childId,
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
    <div
      className={`grid grid-cols-1 items-end gap-4 ${hasMore ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" : "sm:grid-cols-2"}`}
    >
      <SelectField
        className="flex-1"
        label="Hồ sơ của bé"
        aria-label="Chọn hồ sơ bé để xem dữ liệu"
        value={childId}
        onChange={(event) => router.push(progressHref(event.target.value))}
      >
        {childrenProfiles.map((child) => (
          <option key={child.id} value={child.id}>
            {child.alias} · Lớp {child.grade}
          </option>
        ))}
      </SelectField>
      <SelectField
        className="flex-1"
        label="Kỳ báo cáo đã lưu"
        value={key}
        onChange={(event) => {
          const value = event.target.value;
          const item = periods.find(
            (period) => `${period.period_start}/${period.period_end}` === value,
          );
          if (value === "latest") router.push(progressHref(childId));
          else if (item) router.push(progressHref(childId, item));
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
      </SelectField>
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
