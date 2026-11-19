import type { MetricViewModelUI } from "@/types/reports";

interface MetricCardProps {
  readonly metric: MetricViewModelUI;
}

export function MetricCard({ metric }: MetricCardProps) {
  return (
    <article className="report-metric flex min-w-0 flex-col gap-2">
      <h2 className="text-label font-bold text-muted">{metric.label}</h2>
      <p
        className="break-words text-3xl font-extrabold leading-[1.4] text-primary"
        data-unavailable={metric.unavailable || undefined}
      >
        {metric.value}
      </p>
      <p className="text-sm text-muted">{metric.hint}</p>
    </article>
  );
}
