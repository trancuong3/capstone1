"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/common/button";
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
  prevLabel = "Trước",
  nextLabel = "Tiếp",
  compact = false,
  disabled = false,
  showSummaryWhenSinglePage = false,
  className,
}: PaginationBarProps) {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const safeTotal = Math.max(0, Math.floor(total));
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page)), totalPages);

  if (safeTotal === 0) {
    return null;
  }

  const start = (safePage - 1) * safePageSize + 1;
  const end = Math.min(safePage * safePageSize, safeTotal);
  const labelSuffix = itemLabel ? ` ${itemLabel}` : "";
  const isSinglePage = safeTotal <= safePageSize;

  if (isSinglePage && !showSummaryWhenSinglePage) {
    return null;
  }

  const navAriaLabel =
    ariaLabel ??
    (itemLabel ? `Điều hướng danh sách ${itemLabel}` : "Phân trang");

  const buttonSizeClass = compact
    ? "min-h-11 px-3 py-1.5 text-sm"
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
      <p className="text-sm text-muted tabular-nums">
        Đang xem {start}–{end} / {safeTotal}
        {labelSuffix}
      </p>

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
            <ChevronLeft aria-hidden="true" className="size-4" />
            {prevLabel}
          </Button>
          <span
            aria-current="page"
            className="min-w-20 text-center text-sm font-bold text-ink tabular-nums"
          >
            Trang {safePage} / {totalPages}
          </span>
          <Button
            className={buttonSizeClass}
            disabled={disabled || safePage >= totalPages}
            fullWidth={false}
            onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
            type="button"
            variant="secondary"
          >
            {nextLabel}
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
