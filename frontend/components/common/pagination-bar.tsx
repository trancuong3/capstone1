"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/common/button";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

export interface PaginationBarProps {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly onPageChange: (nextPage: number) => void;
  readonly ariaLabel?: string;
  readonly itemLabel?: string;
  readonly prevLabel?: string;
  readonly nextLabel?: string;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly showSummaryWhenSinglePage?: boolean;
  readonly className?: string;
}

export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  ariaLabel,
  itemLabel,
  prevLabel,
  nextLabel,
  compact = false,
  disabled = false,
  showSummaryWhenSinglePage = false,
  className,
}: PaginationBarProps) {
  const { t, formatNumber } = useI18n();
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const safeTotal = Math.max(0, Math.floor(total));
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page)), totalPages);

  if (safeTotal === 0) {
    return null;
  }

  const start = (safePage - 1) * safePageSize + 1;
  const end = Math.min(safePage * safePageSize, safeTotal);
  const isSinglePage = safeTotal <= safePageSize;

  if (isSinglePage && !showSummaryWhenSinglePage) {
    return null;
  }

  const resolvedPrevLabel = prevLabel ?? t("common.pagination.previousShort");
  const resolvedNextLabel = nextLabel ?? t("common.pagination.nextShort");
  const navAriaLabel =
    ariaLabel ??
    (itemLabel
      ? t("common.pagination.navAriaWithLabel", { itemLabel })
      : t("common.pagination.navAria"));

  const startFormatted = formatNumber(start);
  const endFormatted = formatNumber(end);
  const totalFormatted = formatNumber(safeTotal);
  const rangeSummary = itemLabel
    ? t("common.pagination.rangeSummaryWithLabel", {
        start: startFormatted,
        end: endFormatted,
        total: totalFormatted,
        itemLabel,
      })
    : t("common.pagination.rangeSummary", {
        start: startFormatted,
        end: endFormatted,
        total: totalFormatted,
      });

  const buttonSizeClass = compact
    ? "min-h-10 px-3 py-1.5 text-sm"
    : "min-h-11 px-3.5 py-2 text-sm";

  return (
    <nav
      aria-label={navAriaLabel}
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-white",
        compact ? "px-3.5 py-2.5" : "px-4 py-3 sm:px-5",
        className,
      )}
    >
      <p className="text-sm text-muted tabular-nums">{rangeSummary}</p>

      {!isSinglePage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className={buttonSizeClass}
            disabled={disabled || safePage <= 1}
            fullWidth={false}
            onClick={() => onPageChange(Math.max(1, safePage - 1))}
            type="button"
            variant="secondary"
          >
            <ChevronLeft
              aria-hidden="true"
              className="size-4 viread-rtl-flip"
            />
            {resolvedPrevLabel}
          </Button>
          <span
            aria-current="page"
            className="min-w-20 text-center text-sm font-bold text-ink tabular-nums"
          >
            {t("common.pagination.summary", {
              page: formatNumber(safePage),
              totalPages: formatNumber(totalPages),
            })}
          </span>
          <Button
            className={buttonSizeClass}
            disabled={disabled || safePage >= totalPages}
            fullWidth={false}
            onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
            type="button"
            variant="secondary"
          >
            {resolvedNextLabel}
            <ChevronRight
              aria-hidden="true"
              className="size-4 viread-rtl-flip"
            />
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
