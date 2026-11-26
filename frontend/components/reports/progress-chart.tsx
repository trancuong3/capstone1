"use client";

import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { ProgressReportDTO } from "@/types/reports";

interface ProgressChartProps {
  readonly report: ProgressReportDTO;
}

export function ProgressChart({ report }: ProgressChartProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reports");
  const rows = [
    {
      label: t("overview.chart.omissions"),
      value: report.omission_count,
      rate: report.omission_rate,
      barClass: "bg-primary",
    },
    {
      label: t("overview.chart.repetitions"),
      value: report.repetition_count,
      rate: report.repetition_rate,
      barClass: "bg-primary/80",
    },
    {
      label: t("overview.chart.longPauses"),
      value: report.long_pause_count,
      rate: report.long_pause_rate,
      barClass: "bg-primary/60",
    },
  ] as const;

  const numericValues = rows
    .map((row) => row.value)
    .filter((value): value is number => typeof value === "number");
  const maxValue = Math.max(...numericValues, 1);
  const allMissing = numericValues.length === 0;

  return (
    <section
      aria-labelledby="reading-evidence-title"
      className="rounded-card border border-border bg-white p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          className="text-xl font-extrabold text-ink"
          id="reading-evidence-title"
        >
          {t("overview.chart.title")}
        </h2>
        <span className="text-xs font-semibold text-muted">
          {t("overview.chart.unitLabel")}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">{t("overview.chart.subtitle")}</p>

      {allMissing ? (
        <p className="mt-5 rounded-control border border-dashed border-border bg-canvas px-4 py-5 text-sm font-semibold text-muted">
          {t("overview.chart.empty")}
        </p>
      ) : (
        <ul aria-hidden="true" className="mt-5 space-y-4">
          {rows.map((row) => {
            const hasValue = row.value !== null;
            const widthPercent =
              hasValue && row.value > 0
                ? Math.max(6, Math.round((row.value / maxValue) * 100))
                : 0;
            return (
              <li className="space-y-1.5" key={row.label}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-bold text-ink">
                    {row.label}
                  </span>
                  <span
                    className={
                      hasValue
                        ? "text-sm font-extrabold tabular-nums text-ink"
                        : "text-xs font-semibold text-muted"
                    }
                  >
                    {hasValue
                      ? t("overview.chart.valueTimes", {
                          count: formatNumber(row.value),
                        })
                      : t("overview.chart.noData")}
                    {hasValue && row.rate !== null ? (
                      <span className="ms-1.5 font-semibold text-muted">
                        ({row.rate.toFixed(1)}%)
                      </span>
                    ) : null}
                  </span>
                </div>
                <div
                  className={
                    hasValue
                      ? "h-2.5 w-full overflow-hidden rounded-full bg-canvas ring-1 ring-inset ring-border/70"
                      : "h-2.5 w-full rounded-full border border-dashed border-border bg-canvas/60"
                  }
                >
                  {widthPercent > 0 ? (
                    <div
                      className={`h-full rounded-full ${row.barClass}`}
                      style={{ width: `${widthPercent}%` }}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sr-only">
        <table>
          <caption>{t("overview.chart.tableCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("overview.chart.colType")}</th>
              <th scope="col">{t("overview.chart.colCount")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>
                  {row.value !== null
                    ? formatNumber(row.value)
                    : t("overview.chart.noData")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
