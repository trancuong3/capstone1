import type { MetricViewModelUI } from "@/types/reports";

interface MetricCardProps {
  readonly metric: MetricViewModelUI;
}

export function MetricCard({ metric }: MetricCardProps) {
  return (
    <article className="flex min-h-44 flex-col rounded-card bg-white p-6 shadow-[0_12px_32px_rgba(33,65,86,0.06)]">
      <h2 className="text-body font-bold text-muted">{metric.label}</h2>
      <p
        className="mt-3 text-[32px] font-extrabold leading-tight text-ink"
        data-unavailable={metric.unavailable || undefined}
      >
        {metric.value}
      </p>
      <p className="mt-auto pt-3 text-label font-bold text-primary">
        {metric.hint}
      </p>
    </article>
  );
}
