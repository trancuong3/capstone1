"use client";

import { useRouter } from "next/navigation";
import { useContext, useId } from "react";
import { Button } from "@/components/common/button";
import { AppStoreContext } from "@/components/providers/app-store-provider";
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
  const appStore = useContext(AppStoreContext);
  const childSelectId = useId();
  const periodSelectId = useId();

  const key = selectedPeriod
    ? `${selectedPeriod.period_start}/${selectedPeriod.period_end}`
    : "latest";
  const selectedMissing =
    selectedPeriod &&
    !periods.some((item) => `${item.period_start}/${item.period_end}` === key);

  return (
    <div
      className={`grid grid-cols-1 items-end gap-2.5 rounded-card border border-border bg-white p-2.5 md:gap-3 md:p-4 ${hasMore ? "min-[640px]:grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" : "md:grid-cols-2"}`}
    >
      <div className="hidden min-w-0 md:block">
        <label
          className="mb-1.5 block text-xs font-bold text-muted"
          htmlFor={childSelectId}
        >
          Hồ sơ của bé
        </label>
        <select
          aria-label="Chọn hồ sơ bé để xem dữ liệu"
          className="min-h-12 w-full cursor-pointer rounded-control border border-border bg-cream px-3.5 text-sm font-bold text-ink outline-none focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
          id={childSelectId}
          onChange={(event) => {
            const nextChildId = event.target.value;
            const matched = childrenProfiles.find((c) => c.id === nextChildId);
            appStore?.selectChild(nextChildId);
            if (matched) appStore?.setValidatedSelectedChild(matched);
            router.push(progressHref(nextChildId));
          }}
          value={childId}
        >
          {childrenProfiles.map((child) => (
            <option key={child.id} value={child.id}>
              {child.alias} · Lớp {child.grade}
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-0">
        <label
          className="mb-1 block text-xs font-bold text-muted md:mb-1.5"
          htmlFor={periodSelectId}
        >
          Kỳ báo cáo đã lưu
        </label>
        <select
          className="min-h-11 w-full cursor-pointer rounded-control border border-border bg-cream px-3 text-sm font-bold text-ink outline-none focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary md:min-h-12 md:px-3.5"
          id={periodSelectId}
          onChange={(event) => {
            const value = event.target.value;
            const item = periods.find(
              (period) =>
                `${period.period_start}/${period.period_end}` === value,
            );
            if (value === "latest") router.push(progressHref(childId));
            else if (item) router.push(progressHref(childId, item));
          }}
          value={key}
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
          className="min-h-11 whitespace-nowrap min-[640px]:w-auto md:min-h-12"
          disabled={loadingMore}
          onClick={onLoadMore}
          variant="secondary"
        >
          {loadingMore ? "Đang tải kỳ…" : "Tải thêm kỳ"}
        </Button>
      ) : null}
    </div>
  );
}
