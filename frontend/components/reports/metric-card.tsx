import { cn } from "@/lib/utils/cn";
import type { MetricViewModelUI } from "@/types/reports";

export interface MetricCardDelta {
  readonly label: string;
  readonly tone: "positive" | "negative" | "neutral";
}

interface MetricCardProps {
  readonly metric: MetricViewModelUI;
  readonly delta?: MetricCardDelta | null;
}

const DELTA_TONE_CLASSES: Record<MetricCardDelta["tone"], string> = {
  positive: "bg-success-surface text-success-ink",
  negative: "bg-warning-surface text-warning",
  neutral: "bg-canvas text-muted border border-border",
};

export function MetricCard({ metric, delta }: MetricCardProps) {
  return (
    <article className="report-metric flex h-full min-w-0 flex-col justify-between gap-1">
      <div className="flex flex-wrap items-start justify-between gap-1.5">
        <h2 className="text-xs font-bold leading-snug text-muted">
          {metric.label}
        </h2>
        {delta ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center rounded-control px-1.5 py-0.5 text-[11px] font-bold tabular-nums",
              DELTA_TONE_CLASSES[delta.tone],
            )}
          >
            {delta.label}
          </span>
        ) : null}
      </div>
      <p
        className={cn(
          "break-words leading-tight",
          metric.unavailable
            ? "text-sm font-bold text-muted"
            : "text-xl font-extrabold tracking-tight tabular-nums text-primary sm:text-2xl",
        )}
        data-metric-value="true"
        data-unavailable={metric.unavailable || undefined}
      >
        {metric.value}
      </p>
      <p className="text-[11px] leading-4 text-muted">{metric.hint}</p>
    </article>
  );
}
