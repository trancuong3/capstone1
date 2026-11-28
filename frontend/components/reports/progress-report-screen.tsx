"use client";

import {
  ArrowRight,
  Award,
  ChevronDown,
  Printer,
  RefreshCw,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useContext, useEffect, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { PaginationBar } from "@/components/common/pagination-bar";
import { SegmentedFilterBar } from "@/components/common/segmented-filter-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { EntertainmentLearningSummary } from "@/components/reports/entertainment-learning-summary";
import {
  MetricCard,
  type MetricCardDelta,
} from "@/components/reports/metric-card";
import { ProgressReportFilters } from "@/components/reports/progress-report-filters";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import { ReadingHubSubNav } from "@/components/reports/reading-hub-subnav";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
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
    loading: () => <Skeleton className="h-44 w-full rounded-card" />,
  },
);

type TranslateFn = ReturnType<typeof useTranslations>;

type ReportFocus = "ALL" | "ASSESSMENT" | "SIGNALS" | "WORDS" | "ENTERTAINMENT";

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
    className: "bg-white text-muted",
  },
  IN_PROGRESS: {
    key: "difficultWords:item.inProgress",
    className: "bg-sky text-primary-hover",
  },
  NEEDS_MORE_PRACTICE: {
    key: "difficultWords:item.needsMorePractice",
    className: "bg-warning-surface text-warning",
  },
  COMPLETED: {
    key: "difficultWords:item.completed",
    className: "bg-success-surface text-success-ink",
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
  const tCommon = useTranslations("common");
  const tNav = useTranslations("navigation");
  const appStore = useContext(AppStoreContext);
  const preferredChildId =
    requestedChildId ?? appStore?.selectedChildId ?? undefined;
  const { childService, reportService } = useReportServices();
  const [state, setState] = useState<State>({ status: "loading" });
  const loadedChild = state.status === "loaded" ? state.child : null;
  useEffect(() => {
    if (loadedChild) {
      hydrateTeacherVoiceFromChildProfile(loadedChild);
    }
  }, [loadedChild]);
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [difficultWordsPage, setDifficultWordsPage] = useState(1);
  const [focus, setFocus] = useState<ReportFocus>("ALL");
  const DIFFICULT_WORDS_PAGE_SIZE = 6;
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
        const window = parseProgressPeriod(
          requestedPeriodStart,
          requestedPeriodEnd,
        );
        if (window === "invalid") return;

        type ReportFetchOutcome =
          | { ok: true; value: ProgressReportDTO }
          | { ok: false; failure: unknown };

        const toReportOutcome = (
          promise: Promise<ProgressReportDTO>,
        ): Promise<ReportFetchOutcome> =>
          promise.then(
            (value) => ({ ok: true as const, value }),
            (failure: unknown) => ({ ok: false as const, failure }),
          );

        const resolveReportStatus = (
          outcome: ReportFetchOutcome,
        ): {
          report: ProgressReportDTO | null;
          reportStatus: "ready" | "empty" | "unavailable" | "error";
        } => {
          if (outcome.ok) {
            return { report: outcome.value, reportStatus: "ready" };
          }
          const failure = outcome.failure;
          return {
            report: null,
            reportStatus:
              isServiceError(failure) && failure.status === 404
                ? "empty"
                : isServiceError(failure) &&
                    (failure.status === 501 || failure.status === 503)
                  ? "unavailable"
                  : "error",
          };
        };

        if (requestedChildId) {
          const childrenPromise = childService.list();
          const periodsPromise = reportService
            .listPeriods(requestedChildId)
            .catch(() => null);
          const reportPromise =
            window !== null
              ? toReportOutcome(reportService.get(requestedChildId, window))
              : null;

          const children = await childrenPromise;
          if (!children.length) {
            if (active) setState({ status: "no-children" });
            return;
          }
          const matchedChild = children.find(
            (item) => item.id === requestedChildId,
          );
          const child = matchedChild
            ? matchedChild
            : await childService.get(requestedChildId);
          if (!children.some((item) => item.id === child.id)) {
            if (active) setState({ status: "not-found" });
            return;
          }

          const [periods, prefetchedReportOutcome] = await Promise.all([
            periodsPromise,
            reportPromise ?? Promise.resolve(null),
          ]);
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

          const finalOutcome =
            prefetchedReportOutcome ??
            (await toReportOutcome(
              reportService.get(child.id, window ?? undefined),
            ));
          if (!active) return;
          const { report, reportStatus } = resolveReportStatus(finalOutcome);
          setState({
            status: "loaded",
            children,
            child,
            report,
            reportStatus,
            periods: periodsValue,
            periodsError,
          });
          return;
        }

        const children = await childService.list();
        if (!children.length) {
          if (active) setState({ status: "no-children" });
          return;
        }
        const child =
          (preferredChildId
            ? children.find((item) => item.id === preferredChildId)
            : undefined) ?? children[0];
        const periodsPromise = reportService
          .listPeriods(child.id)
          .catch(() => null);
        const reportPromise =
          window !== null
            ? toReportOutcome(reportService.get(child.id, window))
            : null;
        const [periods, prefetchedReportOutcome] = await Promise.all([
          periodsPromise,
          reportPromise ?? Promise.resolve(null),
        ]);
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
        const finalOutcome =
          prefetchedReportOutcome ??
          (await toReportOutcome(
            reportService.get(child.id, window ?? undefined),
          ));
        if (!active) return;
        const { report, reportStatus } = resolveReportStatus(finalOutcome);
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
    preferredChildId,
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
        className="mx-auto flex w-full max-w-[1120px] flex-col gap-3"
      >
        <Skeleton className="h-14 rounded-card" />
        <Skeleton className="h-10 rounded-card" />
        <Skeleton className="h-28 rounded-card" />
        <Skeleton className="h-56 rounded-card" />
        <div className="grid gap-2.5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <Skeleton className="h-44 rounded-card" />
          <Skeleton className="h-44 rounded-card" />
        </div>
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
  const allDifficultWords = report?.difficult_words ?? [];
  const totalDifficultWordPages = Math.max(
    1,
    Math.ceil(allDifficultWords.length / DIFFICULT_WORDS_PAGE_SIZE),
  );
  const safeDifficultWordsPage = Math.min(
    Math.max(1, difficultWordsPage),
    totalDifficultWordPages,
  );
  const difficultWordsStart =
    (safeDifficultWordsPage - 1) * DIFFICULT_WORDS_PAGE_SIZE;
  const visibleDifficultWords = allDifficultWords.slice(
    difficultWordsStart,
    difficultWordsStart + DIFFICULT_WORDS_PAGE_SIZE,
  );
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

  const focusOptions = [
    {
      value: "ALL" as const,
      label: tCommon("taskCenter.filters.all"),
    },
    {
      value: "ASSESSMENT" as const,
      label: t("overview.focusAssessment"),
    },
    {
      value: "SIGNALS" as const,
      label: t("overview.focusSignals"),
    },
    {
      value: "WORDS" as const,
      label: tNav("parent.difficultWords"),
      count: report?.difficult_words ? allDifficultWords.length : undefined,
    },
    {
      value: "ENTERTAINMENT" as const,
      label: t("overview.focusEntertainment"),
    },
  ] as const;

  const showSignals = Boolean(
    report && (focus === "ALL" || focus === "SIGNALS"),
  );
  const showAssessment = focus === "ALL" || focus === "ASSESSMENT";
  const showWords = Boolean(report && (focus === "ALL" || focus === "WORDS"));
  const showEntertainment = focus === "ALL" || focus === "ENTERTAINMENT";

  const legacySection = report?.legacy ? (
    <section className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-cream/70 px-3 py-2">
      <h2 className="text-xs font-extrabold text-ink sm:text-sm">
        {t("overview.legacyMetricsTitle")}
      </h2>
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {report.legacy.total_books !== null ? (
          <div className="flex items-baseline gap-1.5">
            <dt className="font-semibold text-muted">
              {t("overview.legacyTotalBooks")}
            </dt>
            <dd className="font-extrabold tabular-nums text-ink">
              {report.legacy.total_books}
            </dd>
          </div>
        ) : null}
        {report.legacy.avg_fluency !== null ? (
          <div className="flex items-baseline gap-1.5">
            <dt className="font-semibold text-muted">
              {t("overview.legacyAvgFluency")}
            </dt>
            <dd className="font-extrabold tabular-nums text-ink">
              {report.legacy.avg_fluency}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  ) : null;

  const signalsSection = report ? (
    report.assessment ? (
      <div className="grid gap-2.5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-stretch">
        <div className="flex min-w-0 flex-col gap-2.5">
          <ProgressChart className="flex-1" report={report} showSubtitle />
          {legacySection}
        </div>
        <ReadingAssessmentSummary
          assessment={report.assessment}
          compact
          scopeLabel={`${report.period_start} → ${report.period_end}`}
        />
      </div>
    ) : (
      <div className="flex w-full min-w-0 flex-col gap-2.5 self-start">
        <ProgressChart horizontal report={report} />
        {legacySection}
      </div>
    )
  ) : null;

  return (
    <section className="viread-print-sheet mx-auto flex w-full max-w-[1120px] flex-col gap-2.5 pb-2">
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

      <header className="flex flex-col gap-2 border-b border-border pb-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-extrabold tracking-[-0.02em] text-ink sm:text-2xl">
            {t("overview.childTitle", { alias: child.alias })}
          </h1>
          <ReadingHubSubNav active="reports" childId={child.id} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
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
          </div>

          <ProgressReportFilters
            childrenProfiles={children}
            childId={child.id}
            hasMore={periods.next_cursor !== null}
            loadingMore={loadingMore}
            onLoadMore={() => void loadMore()}
            periods={periods.items}
            selectedPeriod={selected}
          />
        </div>
      </header>

      {state.periodsError ? (
        <StatusMessage title={t("overview.periodListErrorTitle")} tone="error">
          {t("overview.periodListErrorDesc")}
        </StatusMessage>
      ) : null}

      {state.reportStatus === "empty" ? (
        <EmptyState
          description={t("overview.noReportDescription")}
          title={
            selected
              ? t("overview.noPeriodReportTitle")
              : t("overview.noSavedReportTitle")
          }
        />
      ) : null}

      {state.reportStatus === "unavailable" ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-extrabold text-ink sm:text-lg">
            {t("overview.pendingReportTitle")}
          </h2>
          <StatusMessage>{t("overview.pendingReportDesc")}</StatusMessage>
        </section>
      ) : null}

      {state.reportStatus === "error" ? (
        <StatusMessage title={t("overview.loadErrorTitle")} tone="error">
          {t("overview.loadErrorDescription")}
        </StatusMessage>
      ) : null}

      {state.periodsError ||
      state.reportStatus === "error" ||
      state.reportStatus === "unavailable"
        ? retryButton
        : null}

      {report ? (
        <div className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:justify-between">
          <SegmentedFilterBar
            ariaLabel={t("overview.focusAria")}
            onChange={setFocus}
            options={focusOptions}
            value={focus}
          />
          <p className="text-[11px] leading-snug text-muted tabular-nums lg:text-end">
            <span className="font-bold text-ink">
              {t("overview.periodBannerRange", {
                start: report.period_start,
                end: report.period_end,
              })}
            </span>
            {" · "}
            <span>
              {t("overview.periodGeneratedAt", {
                dateTime: formatDateTime(report.generated_at, {
                  dateStyle: "short",
                  timeStyle: "short",
                  timeZone: REPORT_TIMEZONE,
                }),
              })}
            </span>
          </p>
        </div>
      ) : null}

      {report && report.data_status !== "complete" ? (
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

      {report?.assessment_coverage &&
      report.assessment_coverage.assessed_sessions <
        report.assessment_coverage.total_sessions ? (
        <StatusMessage tone="info">
          {t("overview.assessmentCoverageNote", {
            covered: report.assessment_coverage.assessed_sessions,
            total: report.assessment_coverage.total_sessions,
          })}
        </StatusMessage>
      ) : null}

      {report && showSignals ? (
        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="report-metrics grid grid-cols-2 lg:grid-cols-4">
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

          <section
            aria-labelledby="comparison-title"
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border bg-canvas/55 px-3 py-1.5 text-xs"
          >
            <h2
              className="shrink-0 text-xs font-extrabold text-ink"
              id="comparison-title"
            >
              {t("overview.comparisonTitle")}
            </h2>
            {report.availability.comparison === "available" &&
            report.previous_period &&
            report.trend_deltas ? (
              <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
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
                  <div className="flex items-baseline gap-1.5" key={row.label}>
                    <dt className="font-semibold text-muted">{row.label}:</dt>
                    <dd className="font-extrabold tabular-nums text-ink">
                      {typeof row.value !== "number"
                        ? t("overview.notEnoughData")
                        : t(row.key, {
                            value: `${row.value > 0 ? "+" : ""}${Number(row.value.toFixed(2))}`,
                          })}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-muted">
                <span className="font-bold text-ink">
                  {t("overview.comparisonUnavailableTitle")}
                </span>
                {" · "}
                <span>{t("overview.comparisonUnavailableDesc")}</span>
              </p>
            )}
          </section>
        </div>
      ) : null}

      {showAssessment ? (
        <ChildProgressAssessmentCard
          childId={child.id}
          childName={child.alias}
          showReadingAssessment={!report?.assessment}
        />
      ) : null}
      {showSignals ? signalsSection : null}

      {report && showWords ? (
        <section className="rounded-card border border-border bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 className="text-sm font-extrabold text-ink sm:text-base">
                {t("overview.difficultWordsTitle")}
              </h2>
              {report.difficult_words?.length ? (
                <span className="text-xs font-semibold tabular-nums text-muted">
                  {t("overview.difficultWordsTotalSummary", {
                    count: report.difficult_words.length,
                  })}
                </span>
              ) : null}
            </div>
            <ButtonLink
              className="h-8 min-h-8! shrink-0 px-2.5! py-0! text-xs! sm:w-auto"
              href={`/reports/difficult-words?childId=${encodeURIComponent(child.id)}`}
              size="admin"
              variant="secondary"
            >
              {t("overview.openDifficultWordsAction")}
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip size-3.5"
              />
            </ButtonLink>
          </div>

          {report.availability.difficult_words !== "available" ? (
            <StatusMessage className="mt-2">
              {t("overview.difficultWordsPartialNotice")}
            </StatusMessage>
          ) : null}

          {report.difficult_words?.length ? (
            <>
              <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
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
                      className="flex min-w-0 flex-wrap items-center justify-between gap-1.5 rounded-control bg-canvas/65 px-2.5 py-1.5"
                      key={`${word.normalized_word}-${difficultWordsStart + index}`}
                    >
                      <div className="min-w-0">
                        <span
                          className="viread-learning-content text-sm font-extrabold text-ink"
                          dir="ltr"
                          lang="vi"
                        >
                          {word.display_text}
                        </span>
                        {noteParts.length > 0 ? (
                          <span className="ms-1.5 text-[11px] text-muted">
                            {noteParts.join(" · ")}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className="text-[11px] font-bold tabular-nums text-muted">
                          {t("overview.difficultWordScore", {
                            score: word.difficulty_score,
                          })}
                        </span>
                        {statusStyle ? (
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${statusStyle.className}`}
                          >
                            {t(statusStyle.key)}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <PaginationBar
                ariaLabel={t("overview.difficultWordsTitle")}
                className="mt-2"
                compact
                onPageChange={setDifficultWordsPage}
                page={safeDifficultWordsPage}
                pageSize={DIFFICULT_WORDS_PAGE_SIZE}
                total={allDifficultWords.length}
              />
            </>
          ) : report.availability.difficult_words === "available" ? (
            <p className="mt-2 text-xs text-muted sm:text-sm">
              {t("overview.noDifficultWordsInPeriod")}
            </p>
          ) : null}

          <p className="mt-1.5 text-[11px] leading-snug text-muted">
            {t("overview.difficultWordsWindowNote")}
          </p>
        </section>
      ) : null}

      {showEntertainment ? (
        <details
          className="group rounded-card border border-border bg-white px-3 py-2.5"
          key={focus === "ENTERTAINMENT" ? "ent-open" : "ent-default"}
          open={focus === "ENTERTAINMENT" ? true : undefined}
        >
          <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-sm font-extrabold text-primary [&::-webkit-details-marker]:hidden">
            <span>{t("overview.entertainmentSummaryHeading")}</span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="mt-3 border-t border-border pt-3">
            <EntertainmentLearningSummary
              childId={child.id}
              childName={child.alias}
            />
          </div>
        </details>
      ) : null}
    </section>
  );
}
