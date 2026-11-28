"use client";

import { ArrowRight, Award, History, Printer, RefreshCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { EntertainmentLearningSummary } from "@/components/reports/entertainment-learning-summary";
import {
  MetricCard,
  type MetricCardDelta,
} from "@/components/reports/metric-card";
import { ProgressReportFilters } from "@/components/reports/progress-report-filters";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { useI18n, useTranslations } from "@/hooks/use-i18n";

const ChildProgressAssessmentCard = dynamic(
  () =>
    import("@/components/reports/child-progress-assessment").then(
      (mod) => mod.ChildProgressAssessmentCard,
    ),
  {
    loading: () => <Skeleton className="h-44 w-full rounded-card" />,
  },
);

const ProgressChart = dynamic(
  () =>
    import("@/components/reports/progress-chart").then(
      (mod) => mod.ProgressChart,
    ),
  {
    loading: () => <Skeleton className="h-64 w-full rounded-card" />,
  },
);
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  downloadMilestoneCertificatePng,
  triggerPrintA4Report,
} from "@/lib/reports/milestone-certificate-canvas";
import { formatPercent, mapReportMetrics } from "@/lib/utils/report-mappers";
import {
  parseProgressPeriod,
  progressHref,
} from "@/lib/utils/progress-report-state";
import { REPORT_TIMEZONE } from "@/lib/utils/report-state";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DifficultWordPracticeStatus,
  ProgressPeriodsDTO,
  ProgressReportDTO,
} from "@/types/reports";

type TranslateFn = ReturnType<typeof useTranslations>;

interface Props {
  readonly requestedChildId?: string;
  readonly requestedPeriodStart?: string | string[];
  readonly requestedPeriodEnd?: string | string[];
}
type Loaded = {
  children: readonly ChildProfileDTO[];
  child: ChildProfileDTO;
  report: ProgressReportDTO | null;
  reportStatus: "ready" | "empty" | "unavailable" | "error";
  periods: ProgressPeriodsDTO;
  periodsError: boolean;
};
type State =
  | { status: "loading" | "no-children" | "not-found" | "error" }
  | ({ status: "loaded" } & Loaded);

const PRACTICE_STATUS_KEYS: Record<
  DifficultWordPracticeStatus,
  { readonly key: string; readonly className: string }
> = {
  NOT_PRACTICED: {
    key: "difficultWords:item.notPracticed",
    className: "border border-border bg-canvas text-muted",
  },
  IN_PROGRESS: {
    key: "difficultWords:item.inProgress",
    className: "border border-primary/20 bg-sky text-primary-hover",
  },
  NEEDS_MORE_PRACTICE: {
    key: "difficultWords:item.needsMorePractice",
    className: "border border-warning/25 bg-warning-surface text-warning",
  },
  COMPLETED: {
    key: "difficultWords:item.completed",
    className:
      "border border-success-ink/20 bg-success-surface text-success-ink",
  },
};

function formatDeltaNumber(value: number): string {
  const rounded = Number(value.toFixed(1));
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function metricDeltaFor(
  report: ProgressReportDTO,
  metricId: string,
  t: TranslateFn,
): MetricCardDelta | null {
  if (
    report.availability.comparison !== "available" ||
    !report.previous_period ||
    !report.trend_deltas
  ) {
    return null;
  }

  const deltas = report.trend_deltas;
  if (
    metricId === "sessions" &&
    typeof deltas.completed_sessions === "number"
  ) {
    const val = deltas.completed_sessions;
    return {
      label: t("overview.deltaSessions", { value: formatDeltaNumber(val) }),
      tone: val > 0 ? "positive" : val < 0 ? "negative" : "neutral",
    };
  }
  if (
    metricId === "duration" &&
    typeof deltas.reading_duration_ms === "number"
  ) {
    const minutes = deltas.reading_duration_ms / 60_000;
    return {
      label: t("overview.deltaMinutes", { value: formatDeltaNumber(minutes) }),
      tone: minutes > 0 ? "positive" : minutes < 0 ? "negative" : "neutral",
    };
  }
  if (
    metricId === "comprehension" &&
    typeof deltas.comprehension_accuracy === "number"
  ) {
    const val = deltas.comprehension_accuracy;
    return {
      label: t("overview.deltaPoints", { value: formatDeltaNumber(val) }),
      tone: val > 0 ? "positive" : val < 0 ? "negative" : "neutral",
    };
  }
  if (metricId === "omission" && typeof deltas.omission_rate === "number") {
    const val = deltas.omission_rate;
    // Lower omission rate is positive.
    return {
      label: t("overview.deltaPoints", { value: formatDeltaNumber(val) }),
      tone: val < 0 ? "positive" : val > 0 ? "negative" : "neutral",
    };
  }
  return null;
}

// Reset immediately on URL changes; an old child's report must not flash under new filters.
export function ProgressReportScreen(props: Props) {
  return <ProgressReportContent key={JSON.stringify(props)} {...props} />;
}

function ProgressReportContent({
  requestedChildId,
  requestedPeriodStart,
  requestedPeriodEnd,
}: Props) {
  const { formatDateTime } = useI18n();
  const t = useTranslations("reports");
  const { childService, reportService } = useReportServices();
  const [state, setState] = useState<State>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showAllDifficultWords, setShowAllDifficultWords] = useState(false);
  const alive = useRef(true);
  const paging = useRef(false);
  const selected = parseProgressPeriod(
    requestedPeriodStart,
    requestedPeriodEnd,
  );

  useEffect(() => {
    alive.current = true;
    let active = true;
    if (
      parseProgressPeriod(requestedPeriodStart, requestedPeriodEnd) ===
      "invalid"
    )
      return;
    async function load() {
      setState({ status: "loading" });
      try {
        const children = await childService.list();
        if (!children.length) {
          if (active) setState({ status: "no-children" });
          return;
        }
        const matchedChild = requestedChildId
          ? children.find((item) => item.id === requestedChildId)
          : children[0];
        const child = matchedChild
          ? matchedChild
          : await childService.get(requestedChildId!);
        if (!children.some((item) => item.id === child.id)) {
          if (active) setState({ status: "not-found" });
          return;
        }
        const window = parseProgressPeriod(
          requestedPeriodStart,
          requestedPeriodEnd,
        );
        if (window === "invalid") return;
        const periods = await reportService
          .listPeriods(child.id)
          .catch(() => null);
        if (!active) return;
        const periodsValue = periods ?? { items: [], next_cursor: null };
        const periodsError = periods === null;
        if (!window && periods !== null && periods.items.length === 0) {
          setState({
            status: "loaded",
            children,
            child,
            report: null,
            reportStatus: "empty",
            periods: periodsValue,
            periodsError: false,
          });
          return;
        }
        let report: ProgressReportDTO | null = null;
        let reportStatus: "ready" | "empty" | "unavailable" | "error" = "error";
        try {
          report = await reportService.get(child.id, window ?? undefined);
          reportStatus = "ready";
        } catch (failure) {
          reportStatus =
            isServiceError(failure) && failure.status === 404
              ? "empty"
              : isServiceError(failure) &&
                  (failure.status === 501 || failure.status === 503)
                ? "unavailable"
                : "error";
        }
        if (!active) return;
        setState({
          status: "loaded",
          children,
          child,
          report,
          reportStatus,
          periods: periodsValue,
          periodsError,
        });
      } catch (error) {
        if (active)
          setState({
            status:
              isServiceError(error) && error.status === 404
                ? "not-found"
                : "error",
          });
      }
    }
    void load();
    return () => {
      active = false;
      alive.current = false;
    };
  }, [
    childService,
    reportService,
    requestedChildId,
    requestedPeriodStart,
    requestedPeriodEnd,
    retry,
  ]);

  async function loadMore() {
    if (
      state.status !== "loaded" ||
      !state.periods.next_cursor ||
      paging.current
    )
      return;
    const { child, periods } = state;
    paging.current = true;
    setLoadingMore(true);
    try {
      const page = await reportService.listPeriods(child.id, {
        cursor: periods.next_cursor ?? undefined,
      });
      if (alive.current)
        setState((current) => {
          if (current.status !== "loaded") return current;
          const keys = new Set(
            current.periods.items.map(
              (item) => `${item.period_start}/${item.period_end}`,
            ),
          );
          return {
            ...current,
            periodsError: false,
            periods: {
              items: [
                ...current.periods.items,
                ...page.items.filter(
                  (item) =>
                    !keys.has(`${item.period_start}/${item.period_end}`),
                ),
              ],
              next_cursor: page.next_cursor,
            },
          };
        });
    } catch {
      if (alive.current)
        setState((current) =>
          current.status === "loaded"
            ? { ...current, periodsError: true }
            : current,
        );
    } finally {
      paging.current = false;
      if (alive.current) setLoadingMore(false);
    }
  }

  const retryButton = (
    <Button
      className="sm:w-auto sm:self-start"
      variant="secondary"
      onClick={() => setRetry((value) => value + 1)}
    >
      <RefreshCw aria-hidden="true" className="size-4" />
      {t("overview.retry")}
    </Button>
  );

  if (selected === "invalid")
    return (
      <section className="mx-auto flex max-w-[1120px] flex-col gap-4">
        <StatusMessage title={t("overview.invalidPeriodTitle")} tone="error">
          {t("overview.invalidPeriodDesc")}
        </StatusMessage>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href={requestedChildId ? progressHref(requestedChildId) : "/reports"}
        >
          {t("overview.viewLatestReport")}
        </ButtonLink>
      </section>
    );

  if (state.status === "loading")
    return (
      <section
        aria-busy="true"
        aria-label={t("overview.loadingAria")}
        className="mx-auto flex w-full max-w-[1120px] flex-col gap-5"
      >
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-20 rounded-card" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-28 rounded-card" />
          <Skeleton className="h-28 rounded-card" />
          <Skeleton className="h-28 rounded-card" />
          <Skeleton className="h-28 rounded-card" />
        </div>
        <Skeleton className="h-64 rounded-card" />
      </section>
    );

  if (state.status === "no-children")
    return (
      <EmptyState
        headingLevel={1}
        title={t("overview.noChildTitle")}
        description={t("overview.noChildDescription")}
        action={
          <ButtonLink href="/children/new">
            {t("overview.createChildAction")}
          </ButtonLink>
        }
      />
    );

  if (state.status !== "loaded")
    return (
      <section className="mx-auto flex max-w-[1120px] flex-col gap-4">
        <StatusMessage
          title={
            state.status === "not-found"
              ? t("overview.notFoundTitle")
              : t("overview.loadErrorTitle")
          }
          tone="error"
        >
          {state.status === "not-found"
            ? t("overview.notFoundDescription")
            : t("overview.loadErrorDescription")}
        </StatusMessage>
        {retryButton}
      </section>
    );

  const { child, children, report, periods } = state;
  const visibleDifficultWords = report?.difficult_words
    ? showAllDifficultWords
      ? report.difficult_words
      : report.difficult_words.slice(0, 8)
    : [];
  const localizedMetrics = report
    ? mapReportMetrics(report).map((metric) => {
        if (metric.id === "sessions") {
          return {
            ...metric,
            label: t("overview.metrics.sessions"),
            value:
              report.completed_sessions === null
                ? t("overview.chart.noData")
                : t("overview.metricCards.sessionsValue", {
                    count: report.completed_sessions,
                  }),
            hint: t("overview.metricCards.sessionsHint"),
          };
        }
        if (metric.id === "duration") {
          const durationValue = (() => {
            const ms = report.reading_duration_ms;
            if (ms === null) return t("overview.chart.noData");
            const totalSeconds = Math.max(0, Math.floor(ms / 1000));
            if (totalSeconds < 60) {
              return t("sessions.durationSeconds", { seconds: totalSeconds });
            }
            const mins = Math.floor(totalSeconds / 60);
            const secs = totalSeconds % 60;
            return secs === 0
              ? t("sessions.durationMinutes", { minutes: mins })
              : t("sessions.durationMinutesSeconds", {
                  minutes: mins,
                  seconds: secs,
                });
          })();
          return {
            ...metric,
            label: t("overview.metrics.reading_minutes"),
            value: durationValue,
            hint: t("overview.metricCards.durationHint"),
          };
        }
        if (metric.id === "comprehension") {
          return {
            ...metric,
            label: t("overview.metricCards.comprehensionLabel"),
            value:
              report.comprehension_accuracy === null
                ? t("overview.notEnoughData")
                : formatPercent(report.comprehension_accuracy),
            hint: t("overview.metricCards.comprehensionHint"),
          };
        }
        if (metric.id === "omission") {
          return {
            ...metric,
            label: t("overview.metricCards.omissionLabel"),
            value:
              report.omission_rate === null
                ? t("overview.notEnoughData")
                : formatPercent(report.omission_rate),
            hint:
              report.omission_count === null
                ? t("overview.metricCards.omissionNoDataHint")
                : t("overview.metricCards.omissionCountHint", {
                    count: report.omission_count,
                  }),
          };
        }
        return metric;
      })
    : [];

  return (
    <section className="viread-print-sheet mx-auto flex w-full max-w-[1120px] flex-col gap-5 pb-4">
      <div className="hidden border-b-2 border-primary pb-3 print:flex print:items-center print:justify-between">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-wider text-primary">
            ViRead · {t("printCertificate.brandTagline")}
          </p>
          <h1 className="text-2xl font-extrabold text-ink">
            {t("overview.childTitle", { alias: child.alias })} (Lớp{" "}
            {child.grade})
          </h1>
        </div>
        <p className="text-xs font-semibold text-muted">
          {new Intl.DateTimeFormat("vi-VN").format(new Date())}
        </p>
      </div>

      <ReportPageHeader
        eyebrow={t("overview.eyebrow", {
          alias: child.alias,
          grade: child.grade,
        })}
        title={t("overview.childTitle", { alias: child.alias })}
        description={t("overview.childSubtitle")}
        action={
          <div className="viread-no-print flex flex-wrap items-center gap-2">
            <Button
              className="w-auto"
              data-testid="print-progress-report-btn"
              fullWidth={false}
              onClick={() => triggerPrintA4Report()}
              size="compact"
              type="button"
              variant="secondary"
            >
              <Printer aria-hidden="true" className="size-4" />
              {t("printCertificate.printA4Action")}
            </Button>
            <Button
              className="w-auto"
              data-testid="download-progress-certificate-btn"
              fullWidth={false}
              onClick={() => {
                const reportData = state.report;
                const sessionsCount = reportData?.completed_sessions ?? 0;
                const firstPassCorrect =
                  reportData?.assessment?.first_pass_correct ?? 0;
                const firstPassIncorrect =
                  reportData?.assessment?.first_pass_incorrect ?? 0;
                const wordsRead = firstPassCorrect + firstPassIncorrect;
                const accuracyText =
                  wordsRead > 0
                    ? `${Math.round((firstPassCorrect / wordsRead) * 100)}%`
                    : reportData?.comprehension_accuracy != null
                      ? `${Math.round(reportData.comprehension_accuracy * 100)}%`
                      : "—";
                void downloadMilestoneCertificatePng({
                  brandLabel: "VIREAD · HỘ CHIẾU ĐỌC SÁCH",
                  heading: t("printCertificate.certificateHeading"),
                  subtitle: t("printCertificate.certificateSubtitle"),
                  awardedToLabel: t("printCertificate.awardedTo"),
                  childName: child.alias,
                  gradeLabel: `Lớp ${child.grade}`,
                  achievementLine: t("printCertificate.progressAchievement", {
                    alias: child.alias,
                  }),
                  statsLine: t("printCertificate.progressStatsLine", {
                    sessions: sessionsCount,
                    words: wordsRead,
                    accuracy: accuracyText,
                  }),
                  issuedDateLabel: t("printCertificate.issuedOn", {
                    date: new Intl.DateTimeFormat("vi-VN").format(new Date()),
                  }),
                  encouragementFooter: t(
                    "printCertificate.encouragementFooter",
                  ),
                  fileNameSlug: child.alias,
                });
              }}
              size="compact"
              type="button"
              variant="secondary"
            >
              <Award aria-hidden="true" className="size-4" />
              {t("printCertificate.downloadCertificateAction")}
            </Button>
            <ButtonLink
              className="sm:w-auto"
              href={`/sessions?childId=${encodeURIComponent(child.id)}`}
              variant="secondary"
            >
              <History aria-hidden="true" className="size-4" />
              {t("overview.readingHistoryAction")}
            </ButtonLink>
          </div>
        }
      />

      <ProgressReportFilters
        childrenProfiles={children}
        childId={child.id}
        periods={periods.items}
        selectedPeriod={selected}
        hasMore={periods.next_cursor !== null}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
      />

      {state.periodsError ? (
        <StatusMessage tone="error" title={t("overview.periodListErrorTitle")}>
          {t("overview.periodListErrorDesc")}
        </StatusMessage>
      ) : null}

      {state.reportStatus === "empty" ? (
        <EmptyState
          title={
            selected
              ? t("overview.noPeriodReportTitle")
              : t("overview.noSavedReportTitle")
          }
          description={t("overview.noReportDescription")}
        />
      ) : null}

      {state.reportStatus === "unavailable" ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-2xl font-extrabold text-ink">
            {t("overview.pendingReportTitle")}
          </h2>
          <StatusMessage>{t("overview.pendingReportDesc")}</StatusMessage>
        </section>
      ) : null}

      {state.reportStatus === "error" ? (
        <StatusMessage tone="error" title={t("overview.loadErrorTitle")}>
          {t("overview.loadErrorDescription")}
        </StatusMessage>
      ) : null}

      {state.periodsError ||
      state.reportStatus === "error" ||
      state.reportStatus === "unavailable"
        ? retryButton
        : null}

      {report ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted">
            <p className="font-semibold text-ink">
              {t("overview.periodBannerRange", {
                start: report.period_start,
                end: report.period_end,
              })}
            </p>
            <p className="text-xs">
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
            <StatusMessage tone="info">
              {t("overview.assessmentCoverageNote", {
                covered: report.assessment_coverage.assessed_sessions,
                total: report.assessment_coverage.total_sessions,
              })}
            </StatusMessage>
          ) : null}

          <div className="report-metrics grid grid-cols-2 overflow-hidden rounded-card border border-border bg-white lg:grid-cols-4">
            {localizedMetrics.map((metric, index) => (
              <div
                className={[
                  "min-w-0 border-border",
                  index % 2 === 0 ? "border-e" : "",
                  index >= 2 ? "border-t lg:border-t-0" : "",
                  index < 3 ? "lg:border-e" : "lg:border-e-0",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={metric.id}
              >
                <MetricCard
                  delta={metricDeltaFor(report, metric.id, t)}
                  metric={metric}
                />
              </div>
            ))}
          </div>

          <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <ProgressChart report={report} />

            <section
              aria-labelledby="comparison-title"
              className="rounded-card border border-border bg-white p-5 sm:p-6"
            >
              <h2
                className="text-xl font-extrabold text-ink"
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
                  <dl className="mt-4 divide-y divide-border">
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
                        className="flex items-baseline justify-between gap-4 py-3 first:pt-0 last:pb-0"
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
                  className="mt-4"
                  title={t("overview.comparisonUnavailableTitle")}
                >
                  {t("overview.comparisonUnavailableDesc")}
                </StatusMessage>
              )}
            </section>
          </div>

          <ReadingAssessmentSummary
            assessment={report.assessment}
            scopeLabel={`${report.period_start} → ${report.period_end}`}
          />

          <section className="rounded-card border border-border bg-white p-5 sm:p-6">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <h2 className="text-xl font-extrabold text-ink">
                  {t("overview.difficultWordsTitle")}
                </h2>
                <p className="mt-0.5 text-sm text-muted">
                  {t("overview.difficultWordsSubtitle")}
                </p>
              </div>
              <ButtonLink
                className="sm:w-auto"
                href={`/reports/difficult-words?childId=${encodeURIComponent(child.id)}`}
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
              <StatusMessage className="mt-4">
                {t("overview.difficultWordsPartialNotice")}
              </StatusMessage>
            ) : null}

            {report.difficult_words?.length ? (
              <>
                <p className="mt-3 text-xs font-bold text-muted">
                  {t("overview.difficultWordsTotalSummary", {
                    count: report.difficult_words.length,
                  })}
                </p>
                <ul className="mt-3 divide-y divide-border rounded-control border border-border">
                  {visibleDifficultWords.map((word, index) => {
                    const statusStyle = word.practice_status
                      ? PRACTICE_STATUS_KEYS[word.practice_status]
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
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                        key={`${word.normalized_word}-${index}`}
                      >
                        <div className="min-w-0">
                          <span
                            className="viread-learning-content text-base font-extrabold text-ink"
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
                    className="mt-3"
                    fullWidth={false}
                    onClick={() =>
                      setShowAllDifficultWords((current) => !current)
                    }
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
              <p className="mt-4 text-sm text-muted">
                {t("overview.noDifficultWordsInPeriod")}
              </p>
            ) : null}

            <p className="mt-3 text-xs text-muted">
              {t("overview.difficultWordsWindowNote")}
            </p>
          </section>

          {report.legacy ? (
            <section className="rounded-card border border-border bg-cream/60 p-5 sm:p-6">
              <h2 className="text-lg font-extrabold text-ink">
                {t("overview.legacyMetricsTitle")}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {t("overview.legacyMetricsSubtitle")}
              </p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                {report.legacy.total_books !== null ? (
                  <div>
                    <dt className="text-xs font-semibold text-muted">
                      {t("overview.legacyTotalBooks")}
                    </dt>
                    <dd className="mt-0.5 text-lg font-extrabold tabular-nums text-ink">
                      {report.legacy.total_books}
                    </dd>
                  </div>
                ) : null}
                {report.legacy.avg_fluency !== null ? (
                  <div>
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

      <ChildProgressAssessmentCard
        childId={child.id}
        childName={child.alias}
        showReadingAssessment={!report?.assessment}
      />

      <details className="rounded-card border border-border bg-white p-4 sm:p-6">
        <summary className="cursor-pointer font-bold text-primary">
          {t("overview.entertainmentSummaryHeading")}
        </summary>
        <div className="mt-4">
          <EntertainmentLearningSummary
            childId={child.id}
            childName={child.alias}
          />
        </div>
      </details>
    </section>
  );
}
