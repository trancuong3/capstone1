"use client";

import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import type { ReadingAssessmentMetricsDTO } from "@/types/reading";

export function ReadingAssessmentSummary({
  assessment,
  scopeLabel,
  embedded = false,
  compact = false,
}: {
  readonly assessment?: ReadingAssessmentMetricsDTO | null;
  readonly scopeLabel?: string;
  readonly embedded?: boolean;
  readonly compact?: boolean;
}) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reports");
  if (!assessment) return null;

  const firstPassTotal =
    assessment.first_pass_correct + assessment.first_pass_incorrect;
  const firstPassCorrectPct =
    firstPassTotal > 0
      ? Math.round((assessment.first_pass_correct / firstPassTotal) * 100)
      : null;

  const retryMetrics = [
    {
      label: t("overview.firstPassSummary.selfCorrected"),
      value: assessment.self_corrected_words,
      valueClass: "text-success-ink",
    },
    {
      label: t("overview.firstPassSummary.stillNeedsPractice"),
      value: assessment.unresolved_words,
      valueClass: assessment.unresolved_words > 0 ? "text-danger" : "text-ink",
    },
    {
      label: t("overview.firstPassSummary.recognizedRetries"),
      value: assessment.retry_attempts,
      valueClass: "text-ink",
    },
    {
      label: t("overview.firstPassSummary.maxRetriesReached"),
      value: assessment.skipped_after_retry_limit,
      valueClass: "text-ink",
    },
  ] as const;

  return (
    <section
      aria-label={t("overview.firstPassSummary.regionAria")}
      className={cn(
        "border border-border",
        embedded ? "rounded-control bg-canvas/55" : "rounded-card bg-white",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 border-b border-border px-3",
          compact ? "py-1.5" : "py-2",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="text-sm font-extrabold text-ink">
            {t("overview.firstPassSummary.heading")}
          </h3>
          {!compact ? (
            <p className="text-xs text-muted">
              {t("overview.firstPassSummary.subtitle")}
            </p>
          ) : null}
        </div>
        {scopeLabel ? (
          <span className="shrink-0 rounded-control bg-canvas px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted">
            {scopeLabel}
          </span>
        ) : null}
      </div>

      <div
        className={cn(
          "grid",
          !compact && "lg:grid-cols-[minmax(0,4.5fr)_minmax(0,7.5fr)]",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 flex-col justify-between p-2.5",
            compact ? "gap-1.5" : "gap-2",
          )}
        >
          <div>
            <h4 className="text-[11px] font-extrabold tracking-wide text-primary">
              {t("overview.firstPassSummary.firstPassTitle")}
            </h4>
            <dl className="mt-1.5 grid grid-cols-2 gap-1.5">
              <div className="flex flex-col justify-between rounded-control bg-canvas/70 px-2.5 py-1.5">
                <dt className="text-[11px] font-semibold leading-snug text-muted">
                  {t("overview.firstPassSummary.firstPassCorrect")}
                </dt>
                <dd className="mt-0.5 text-base font-extrabold tabular-nums text-success-ink sm:text-lg">
                  {formatNumber(assessment.first_pass_correct)}
                </dd>
              </div>
              <div className="flex flex-col justify-between rounded-control bg-canvas/70 px-2.5 py-1.5">
                <dt className="text-[11px] font-semibold leading-snug text-muted">
                  {t("overview.firstPassSummary.firstPassNeedsPractice")}
                </dt>
                <dd className="mt-0.5 text-base font-extrabold tabular-nums text-ink sm:text-lg">
                  {formatNumber(assessment.first_pass_incorrect)}
                </dd>
              </div>
            </dl>
          </div>
          {firstPassCorrectPct !== null ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-muted">
                <span>{t("overview.firstPassSummary.firstPassAccuracy")}</span>
                <span className="tabular-nums text-ink">
                  {firstPassCorrectPct}%{" "}
                  {t("overview.firstPassSummary.firstPassWordsCount", {
                    correct: formatNumber(assessment.first_pass_correct),
                    total: formatNumber(firstPassTotal),
                  })}
                </span>
              </div>
              <div
                aria-hidden="true"
                className="flex h-1.5 w-full overflow-hidden rounded-full bg-danger-surface"
              >
                <div
                  className="h-full bg-primary"
                  style={{ width: `${firstPassCorrectPct}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            "flex min-w-0 flex-col justify-between border-t border-border p-2.5",
            compact ? "gap-1.5" : "gap-2",
            !compact && "lg:border-s lg:border-t-0",
          )}
        >
          <div>
            <h4 className="text-[11px] font-extrabold tracking-wide text-primary">
              {t("overview.firstPassSummary.retrySectionTitle")}
            </h4>
            <dl className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {retryMetrics.map(({ label, value, valueClass }) => (
                <div
                  className="flex flex-col justify-between rounded-control bg-canvas/70 px-2.5 py-1.5"
                  key={label}
                >
                  <dt className="text-[11px] font-semibold leading-snug text-muted">
                    {label}
                  </dt>
                  <dd
                    className={`mt-0.5 text-base font-extrabold tabular-nums ${valueClass}`}
                  >
                    {formatNumber(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded-control bg-canvas/70 px-2.5 py-1 text-xs">
            <div className="flex items-baseline gap-1.5">
              <span className="font-semibold text-muted">
                {t("overview.firstPassSummary.uncertainLabel")}
              </span>
              <span className="font-extrabold tabular-nums text-ink">
                {formatNumber(assessment.recognition_uncertain)}
              </span>
            </div>
            <span className="text-[11px] text-muted">
              {t("overview.firstPassSummary.uncertainNote")}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
