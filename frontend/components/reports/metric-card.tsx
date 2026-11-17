import type { MetricViewModelUI } from "@/types/reports";

interface MetricCardProps {
  readonly metric: MetricViewModelUI;
}

export function MetricCard({ metric }: MetricCardProps) {
  return (
    <article className="flex min-h-40 flex-col rounded-card border border-border bg-white p-5">
      <h2 className="text-body font-semibold text-muted">{metric.label}</h2>
      <p
        className="mt-3 text-[32px] font-semibold leading-tight text-ink"
        data-unavailable={metric.unavailable || undefined}
      >
        {metric.value}
      </p>
      <p className="mt-auto pt-3 text-sm font-medium text-primary">
        {metric.hint}
      </p>
    </article>
  );
}
