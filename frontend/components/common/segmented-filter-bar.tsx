"use client";

import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

export interface SegmentedFilterOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number;
}

export interface SegmentedFilterBarProps<T extends string = string> {
  readonly ariaLabel: string;
  readonly options: readonly SegmentedFilterOption<T>[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly className?: string;
}

export function SegmentedFilterBar<T extends string = string>({
  ariaLabel,
  options,
  value,
  onChange,
  className,
}: SegmentedFilterBarProps<T>) {
  const { formatNumber } = useI18n();

  return (
    <div
      aria-label={ariaLabel}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      role="group"
    >
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            aria-pressed={isActive}
            className={cn(
              "inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-8 sm:px-3",
              isActive
                ? "border-primary bg-primary text-white"
                : "border-border bg-white text-ink hover:bg-canvas",
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            <span>{option.label}</span>
            {typeof option.count === "number" ? (
              <span
                className={cn(
                  "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-extrabold leading-none tabular-nums",
                  isActive ? "bg-white/20 text-white" : "bg-canvas text-muted",
                )}
              >
                {formatNumber(option.count)}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
