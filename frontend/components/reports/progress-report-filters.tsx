"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";
import { Button } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
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
  readonly className?: string;
}

const SELECT_CLASSES =
  "h-10 min-h-10 w-full min-w-0 cursor-pointer rounded-control border border-border bg-white px-2.5 text-xs font-bold text-ink outline-none transition-colors hover:border-primary/50 focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-9 sm:min-h-9 sm:text-sm";

export function ProgressReportFilters({
  childrenProfiles,
  childId,
  periods,
  selectedPeriod,
  hasMore,
  loadingMore,
  onLoadMore,
  className,
}: ProgressReportFiltersProps) {
  const t = useTranslations("reports");
  const tc = useTranslations("child");
  const router = useRouter();
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
      className={cn(
        "flex w-full flex-wrap items-center gap-1.5 lg:w-auto lg:flex-nowrap",
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-[148px] lg:w-44 lg:flex-none lg:basis-auto">
        <label className="sr-only" htmlFor={childSelectId}>
          {tc("selector.label")}
        </label>
        <select
          aria-label={tc("selector.selectAria")}
          className={SELECT_CLASSES}
          id={childSelectId}
          onChange={(event) => router.push(progressHref(event.target.value))}
          value={childId}
        >
          {childrenProfiles.map((child) => (
            <option key={child.id} value={child.id}>
              {tc("selector.optionLabel", {
                alias: child.alias,
                grade: child.grade,
              })}
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-0 flex-1 basis-[168px] lg:w-52 lg:flex-none lg:basis-auto">
        <label className="sr-only" htmlFor={periodSelectId}>
          {t("overview.periodSelectLabel")}
        </label>
        <select
          className={cn(SELECT_CLASSES, "tabular-nums")}
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
          <option value="latest">{t("overview.periodLatestOption")}</option>
          {selectedMissing ? (
            <option value={key}>
              {t("overview.periodSelectedRange", {
                start: selectedPeriod.period_start,
                end: selectedPeriod.period_end,
              })}
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
          className="h-10 min-h-10! shrink-0 whitespace-nowrap px-2.5! py-0! text-xs! sm:h-9 sm:min-h-9! sm:w-auto"
          disabled={loadingMore}
          onClick={onLoadMore}
          size="admin"
          variant="secondary"
        >
          {loadingMore
            ? t("overview.loadingPeriods")
            : t("overview.loadMorePeriods")}
        </Button>
      ) : null}
    </div>
  );
}
