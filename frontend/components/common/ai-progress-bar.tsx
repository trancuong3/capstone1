"use client";

import { useTranslations } from "@/hooks/use-i18n";
import { clampAiProgressPct } from "@/hooks/use-ai-progress";
import { cn } from "@/lib/utils/cn";

export interface AiProgressBarProps {
  readonly percent: number;
  readonly label?: string;
  readonly detail?: string;
  readonly elapsedSeconds?: number;
  readonly active?: boolean;
  readonly size?: "compact" | "sm" | "md";
  readonly tone?: "primary" | "success" | "warning" | "danger";
  readonly className?: string;
  readonly testId?: string;
}

const fillToneClasses: Record<
  NonNullable<AiProgressBarProps["tone"]>,
  string
> = {
  primary: "bg-primary",
  success: "bg-emerald-600",
  warning: "bg-amber-500",
  danger: "bg-danger",
};

const pctToneClasses: Record<
  NonNullable<AiProgressBarProps["tone"]>,
  string
> = {
  primary: "text-primary-hover",
  success: "text-emerald-800",
  warning: "text-amber-900",
  danger: "text-danger",
};

const trackHeightClasses: Record<
  NonNullable<AiProgressBarProps["size"]>,
  string
> = {
  compact: "h-1.5",
  sm: "h-2",
  md: "h-2.5",
};

export function AiProgressBar({
  percent,
  label,
  detail,
  elapsedSeconds,
  active = false,
  size = "sm",
  tone = "primary",
  className,
  testId,
}: AiProgressBarProps) {
  const t = useTranslations("common");
  const clampedPct = clampAiProgressPct(percent);
  const displayPct = Math.round(clampedPct);
  const resolvedAriaLabel =
    label ?? t("aiProgress.defaultLabel", undefined, "Đang xử lý bằng AI…");
  const showElapsed =
    typeof elapsedSeconds === "number" &&
    Number.isFinite(elapsedSeconds) &&
    elapsedSeconds > 0;

  return (
    <div
      aria-live="polite"
      className={cn(
        "w-full",
        size === "compact" ? "space-y-1" : "space-y-1.5",
        className,
      )}
      data-testid={testId}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 font-semibold",
          size === "compact" ? "text-[11px]" : "text-xs",
        )}
      >
        <span className="min-w-0 truncate text-ink">
          {label ??
            t("aiProgress.defaultLabel", undefined, "Đang xử lý bằng AI…")}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
          {detail ? (
            <span className="font-medium text-muted">{detail}</span>
          ) : null}
          {showElapsed ? (
            <span className="font-medium text-muted">
              {t(
                "aiProgress.elapsedSeconds",
                { seconds: Math.floor(elapsedSeconds) },
                "{seconds} giây",
              )}
            </span>
          ) : null}
          <span
            className={cn("font-bold tabular-nums", pctToneClasses[tone])}
            data-testid={testId ? `${testId}-pct` : undefined}
          >
            {displayPct}%
          </span>
        </span>
      </div>

      <div
        aria-label={resolvedAriaLabel}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={displayPct}
        className={cn(
          "w-full overflow-hidden rounded-full bg-canvas ring-1 ring-inset ring-border/70",
          trackHeightClasses[size],
        )}
        role="progressbar"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out",
            fillToneClasses[tone],
            active && clampedPct < 100 && "motion-safe:animate-pulse",
          )}
          style={{
            width: `${Math.max(active && clampedPct === 0 ? 2 : clampedPct, 0)}%`,
          }}
        />
      </div>
    </div>
  );
}
