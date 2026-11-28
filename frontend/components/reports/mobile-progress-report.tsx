"use client";

import { ArrowRight, History } from "lucide-react";
import type { ReactNode } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import type { MetricCardDelta } from "@/components/reports/metric-card";
import { ProgressChart } from "@/components/reports/progress-chart";
import { ProgressReportFilters } from "@/components/reports/progress-report-filters";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import { REPORT_TIMEZONE } from "@/lib/utils/report-state";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DifficultWordDTO,
  DifficultWordPracticeStatus,
  MetricViewModelUI,
  ProgressPeriodsDTO,
  ProgressReportDTO,
} from "@/types/reports";

type TranslateFn = ReturnType<typeof useTranslations>;

const DELTA_TONE_CLASSES: Record<MetricCardDelta["tone"], string> = {
  positive: "bg-success-surface text-success-ink",
  negative: "bg-warning-surface text-warning",
  neutral: "bg-canvas text-muted border border-border",
};

interface MobileMetricItem {
  readonly metric: MetricViewModelUI;
  readonly delta: MetricCardDelta | null;
}

interface MobileProgressReportProps {
  readonly child: ChildProfileDTO;
  readonly childrenProfiles: readonly ChildProfileDTO[];
  readonly periods: ProgressPeriodsDTO;
  readonly selectedPeriod: {
    readonly period_start: string;
    readonly period_end: string;
  } | null;
  readonly periodsError: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly report: ProgressReportDTO | null;
  readonly reportStatus: "ready" | "empty" | "unavailable" | "error";
  readonly retryButton: ReactNode;
  readonly metricItems: readonly MobileMetricItem[];
  readonly visibleDifficultWords: readonly DifficultWordDTO[];
  readonly showAllDifficultWords: boolean;
  readonly onToggleAllDifficultWords: () => void;
  readonly practiceStatusStyles: Record<
    DifficultWordPracticeStatus,
    { readonly key: string; readonly className: string }
  >;
}

export function MobileProgressReport({
  child,
  childrenProfiles,
  periods,
  selectedPeriod,
  periodsError,
  loadingMore,
  onLoadMore,
  report,
  reportStatus,
  retryButton,
  metricItems,
  visibleDifficultWords,
  showAllDifficultWords,
  onToggleAllDifficultWords,
  practiceStatusStyles,
}: MobileProgressReportProps) {
  const { formatDateTime } = useI18n();
  const t: TranslateFn = useTranslations("reports");

  return (
    <div className="flex w-full flex-col gap-4">
      <header className="flex flex-col gap-2.5">
        <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
          {t("overview.eyebrow", {
            alias: child.alias,
            grade: child.grade,
          })}
        </span>
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {t("overview.childTitle", { alias: child.alias })}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("overview.childSubtitle")}
        </p>
        <ButtonLink
          href={`/sessions?childId=${encodeURIComponent(child.id)}`}
          size="touch"
          variant="secondary"
        >
          <History aria-hidden="true" className="size-4" />
          {t("overview.readingHistoryAction")}
        </ButtonLink>
      </header>

      <ProgressReportFilters
        childId={child.id}
        childrenProfiles={childrenProfiles}
        hasMore={periods.next_cursor !== null}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        periods={periods.items}
        selectedPeriod={selectedPeriod}
        variant="mobile"
      />

      {periodsError ? (
        <StatusMessage tone="error" title={t("overview.periodListErrorTitle")}>
          {t("overview.periodListErrorDesc")}
        </StatusMessage>
      ) : null}

      {reportStatus === "empty" ? (
        <EmptyState
          description={t("overview.noReportDescription")}
          title={
            selectedPeriod
              ? t("overview.noPeriodReportTitle")
              : t("overview.noSavedReportTitle")
          }
        />
      ) : null}

      {reportStatus === "unavailable" ? (
        <section className="flex flex-col gap-3 rounded-3xl border border-border bg-white p-4">
          <h2 className="text-lg font-extrabold text-ink">
            {t("overview.pendingReportTitle")}
          </h2>
          <StatusMessage compact>
            {t("overview.pendingReportDesc")}
          </StatusMessage>
        </section>
      ) : null}

      {reportStatus === "error" ? (
        <StatusMessage tone="error" title={t("overview.loadErrorTitle")}>
          {t("overview.loadErrorDescription")}
        </StatusMessage>
      ) : null}

      {periodsError ||
      reportStatus === "error" ||
      reportStatus === "unavailable"
        ? retryButton
        : null}

      {report ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1 rounded-2xl border border-border bg-cream/80 px-4 py-3 text-xs text-muted">
            <p className="text-sm font-extrabold text-ink">
              {t("overview.periodBannerRange", {
                start: report.period_start,
                end: report.period_end,
              })}
            </p>
            <p>
              {t("overview.periodGeneratedAt", {
                dateTime: formatDateTime(report.generated_at, {
                  dateStyle: "short",
                  timeStyle: "short",
                  timeZone: REPORT_TIMEZONE,
                }),
              })}
            </p>
          </div>

          {report.data_status !== "complete" ? (
            <StatusMessage
              compact
              title={
                report.data_status === "unsupported"
                  ? t("overview.unsupportedFormatTitle")
                  : t("overview.partialDataTitle")
              }
            >
              {t("overview.partialDataDesc")}
            </StatusMessage>
          ) : null}

          {report.assessment_coverage &&
          report.assessment_coverage.assessed_sessions <
            report.assessment_coverage.total_sessions ? (
            <StatusMessage compact tone="info">
              {t("overview.assessmentCoverageNote", {
                covered: report.assessment_coverage.assessed_sessions,
                total: report.assessment_coverage.total_sessions,
              })}
            </StatusMessage>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            {metricItems.map(({ metric, delta }) => (
              <article
                className="flex min-w-0 flex-col justify-between gap-2 rounded-2xl border border-border bg-white p-3.5 shadow-2xs"
                key={metric.id}
              >
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
                      : "text-[22px] font-extrabold tracking-tight tabular-nums text-primary",
                  )}
                  data-metric-value="true"
                  data-unavailable={metric.unavailable || undefined}
                >
                  {metric.value}
                </p>
                <p className="text-xs leading-snug text-muted">{metric.hint}</p>
              </article>
            ))}
          </div>

          <ProgressChart report={report} />

          <section
            aria-labelledby="comparison-title"
            className="rounded-3xl border border-border bg-gradient-to-b from-sky/55 via-cream to-white p-4 shadow-2xs"
          >
            <h2
              className="text-lg font-extrabold text-ink"
              id="comparison-title"
            >
              {t("overview.comparisonTitle")}
            </h2>
            {report.availability.comparison === "available" &&
            report.previous_period &&
            report.trend_deltas ? (
              <>
                <p className="mt-1 text-sm text-muted">
                  {t("overview.comparisonSubtitle")}
                </p>
                <dl className="mt-3.5 flex flex-col gap-2">
                  {[
                    {
                      label: t("overview.deltaCompletedSessionsLabel"),
                      value: report.trend_deltas.completed_sessions,
                      key: "overview.deltaSessions",
                    },
                    {
                      label: t("overview.deltaReadingTimeLabel"),
                      value:
                        report.trend_deltas.reading_duration_ms === null
                          ? null
                          : report.trend_deltas.reading_duration_ms / 60000,
                      key: "overview.deltaMinutes",
                    },
                    {
                      label: t("overview.deltaComprehensionLabel"),
                      value: report.trend_deltas.comprehension_accuracy,
                      key: "overview.deltaPoints",
                    },
                  ].map((row) => (
                    <div
                      className="flex items-baseline justify-between gap-3 rounded-2xl border border-border bg-white/90 px-3.5 py-2.5"
                      key={row.label}
                    >
                      <dt className="text-sm font-semibold text-muted">
                        {row.label}
                      </dt>
                      <dd className="text-base font-extrabold tabular-nums text-ink">
                        {typeof row.value !== "number"
                          ? t("overview.notEnoughData")
                          : t(row.key, {
                              value: `${row.value > 0 ? "+" : ""}${Number(row.value.toFixed(2))}`,
                            })}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <StatusMessage
                className="mt-3"
                compact
                title={t("overview.comparisonUnavailableTitle")}
              >
                {t("overview.comparisonUnavailableDesc")}
              </StatusMessage>
            )}
          </section>

          <ReadingAssessmentSummary
            assessment={report.assessment}
            scopeLabel={`${report.period_start} → ${report.period_end}`}
          />

          <section className="flex flex-col gap-3 rounded-3xl border border-border bg-white p-4 shadow-2xs">
            <div className="flex flex-col gap-2.5">
              <div>
                <h2 className="text-lg font-extrabold text-ink">
                  {t("overview.difficultWordsTitle")}
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  {t("overview.difficultWordsSubtitle")}
                </p>
              </div>
              <ButtonLink
                href={`/reports/difficult-words?childId=${encodeURIComponent(child.id)}`}
                size="touch"
                variant="secondary"
              >
                {t("overview.openDifficultWordsAction")}
                <ArrowRight
                  aria-hidden="true"
                  className="viread-rtl-flip size-4"
                />
              </ButtonLink>
            </div>

            {report.availability.difficult_words !== "available" ? (
              <StatusMessage compact>
                {t("overview.difficultWordsPartialNotice")}
              </StatusMessage>
            ) : null}

            {report.difficult_words?.length ? (
              <>
                <p className="text-xs font-bold text-muted">
                  {t("overview.difficultWordsTotalSummary", {
                    count: report.difficult_words.length,
                  })}
                </p>
                <ul className="flex flex-col gap-2">
                  {visibleDifficultWords.map((word, index) => {
                    const statusStyle = word.practice_status
                      ? practiceStatusStyles[word.practice_status]
                      : null;
                    const noteParts: string[] = [];
                    if (word.session_count > 0) {
                      noteParts.push(
                        t("overview.difficultWordSessions", {
                          count: word.session_count,
                        }),
                      );
                    }
                    if ((word.mispronunciation_count ?? 0) > 0) {
                      noteParts.push(
                        t("overview.difficultWordMispronounced", {
                          count: word.mispronunciation_count ?? 0,
                        }),
                      );
                    }
                    if (word.omission_count > 0) {
                      noteParts.push(
                        t("overview.difficultWordOmitted", {
                          count: word.omission_count,
                        }),
                      );
                    }
                    if (word.repetition_count > 0) {
                      noteParts.push(
                        t("overview.difficultWordRepeated", {
                          count: word.repetition_count,
                        }),
                      );
                    }

                    return (
                      <li
                        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-canvas/60 px-3.5 py-2.5"
                        key={`${word.normalized_word}-${index}`}
                      >
                        <div className="min-w-0">
                          <span
                            className="viread-learning-content break-words text-base font-extrabold text-ink"
                            dir="ltr"
                            lang="vi"
                          >
                            {word.display_text}
                          </span>
                          {noteParts.length > 0 ? (
                            <span className="ms-2 text-xs text-muted">
                              {noteParts.join(" · ")}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold tabular-nums text-muted">
                            {t("overview.difficultWordScore", {
                              score: word.difficulty_score,
                            })}
                          </span>
                          {statusStyle ? (
                            <span
                              className={`rounded-control px-2 py-0.5 text-xs font-bold ${statusStyle.className}`}
                            >
                              {t(statusStyle.key)}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {report.difficult_words.length > 8 ? (
                  <Button
                    fullWidth={false}
                    onClick={onToggleAllDifficultWords}
                    size="touch"
                    type="button"
                    variant="quiet"
                  >
                    {showAllDifficultWords
                      ? t("overview.collapseList")
                      : t("overview.viewAllWords", {
                          count: report.difficult_words.length,
                        })}
                  </Button>
                ) : null}
              </>
            ) : report.availability.difficult_words === "available" ? (
              <p className="text-sm text-muted">
                {t("overview.noDifficultWordsInPeriod")}
              </p>
            ) : null}

            <p className="text-xs text-muted">
              {t("overview.difficultWordsWindowNote")}
            </p>
          </section>

          {report.legacy ? (
            <section className="rounded-3xl border border-border bg-cream/60 p-4">
              <h2 className="text-lg font-extrabold text-ink">
                {t("overview.legacyMetricsTitle")}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {t("overview.legacyMetricsSubtitle")}
              </p>
              <dl className="mt-3 grid grid-cols-1 gap-2.5">
                {report.legacy.total_books !== null ? (
                  <div className="rounded-2xl border border-border bg-white px-3.5 py-2.5">
                    <dt className="text-xs font-semibold text-muted">
                      {t("overview.legacyTotalBooks")}
                    </dt>
                    <dd className="mt-0.5 text-lg font-extrabold tabular-nums text-ink">
                      {report.legacy.total_books}
                    </dd>
                  </div>
                ) : null}
                {report.legacy.avg_fluency !== null ? (
                  <div className="rounded-2xl border border-border bg-white px-3.5 py-2.5">
                    <dt className="text-xs font-semibold text-muted">
                      {t("overview.legacyAvgFluency")}
                    </dt>
                    <dd className="mt-0.5 text-lg font-extrabold tabular-nums text-ink">
                      {report.legacy.avg_fluency}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
