"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  Lightbulb,
  Minus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import type { ChildProgressAssessment } from "@/lib/api/child-progress-service";
import { ServiceError } from "@/lib/api/service-error";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import { cn } from "@/lib/utils/cn";

const PERIODS = [7, 30, 90] as const;
const GRADE_STYLES: Record<string, string> = {
  EXCELLENT: "bg-success-surface text-success-ink",
  GOOD: "bg-sky text-primary-hover",
  FAIR: "bg-warning-surface text-warning",
  NEEDS_SUPPORT: "bg-danger-surface text-danger",
};

type View =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      data: ChildProgressAssessment;
      ai: "idle" | "writing" | "failed";
      readonly aiReason?: string | null;
    };

function classifyClientAiFailure(error: unknown): string {
  if (error instanceof ServiceError) {
    if (error.status === 429) return "PROVIDER_QUOTA";
    if (error.status === 401 || error.status === 403) {
      return "PROVIDER_AUTHENTICATION";
    }
    if (error.status === 504 || error.status === 0) return "PROVIDER_TIMEOUT";
    if (error.status >= 500) return "PROVIDER_UNAVAILABLE";
  }
  return "UNKNOWN";
}

function resolveAiFallbackMessage(
  reason: string | null | undefined,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (reason) {
    case "PROVIDER_QUOTA":
      return t("overview.assessmentCard.aiFallbackQuota");
    case "PROVIDER_TIMEOUT":
      return t("overview.assessmentCard.aiFallbackTimeout");
    case "AI_NOT_CONFIGURED":
    case "AI_DISABLED":
    case "PROVIDER_AUTHENTICATION":
      return t("overview.assessmentCard.aiFallbackConfig");
    default:
      return t("overview.assessmentCard.aiFallbackHint");
  }
}

function useShortDate(): (iso: string) => string {
  const { formatDate, locale } = useI18n();
  return (iso: string) => {
    if (locale === "vi") {
      const [, month, day] = iso.split("-");
      return `${day}/${month}`;
    }
    return formatDate(`${iso}T12:00:00Z`, {
      day: "2-digit",
      month: "2-digit",
      timeZone: "UTC",
    });
  };
}

function TrendBadge({ delta }: { readonly delta: number | null }) {
  const t = useTranslations("reports");
  if (delta === null) return null;
  const up = delta >= 3;
  const down = delta <= -3;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
        up
          ? "bg-success-surface text-success-ink"
          : down
            ? "bg-warning-surface text-warning"
            : "bg-white text-muted",
      )}
    >
      <Icon aria-hidden="true" className="viread-rtl-flip size-3.5" />
      {up || down
        ? t("overview.assessmentCard.deltaLabel", {
            delta: `${delta > 0 ? "+" : ""}${delta}`,
          })
        : t("overview.assessmentCard.deltaStable")}
    </span>
  );
}

function ComponentBar({
  component,
}: {
  readonly component: ChildProgressAssessment["score"]["components"][number];
}) {
  const t = useTranslations("reports");
  const { score } = component;
  const scoreText =
    score === null
      ? t("overview.assessmentCard.scoreAriaMissing")
      : t("overview.assessmentCard.scoreAriaValue", { score });
  return (
    <li className="min-w-0 space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-bold text-ink">
          {component.label}
        </span>
        <span
          className={cn(
            "shrink-0 text-xs font-extrabold tabular-nums",
            score === null ? "text-muted" : "text-primary",
          )}
        >
          {score === null
            ? t("overview.notEnoughData")
            : t("overview.assessmentCard.scoreOf100", { score })}
        </span>
      </div>
      <div
        aria-label={t("overview.assessmentCard.scoreAria", {
          label: component.label,
          scoreText,
        })}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={score ?? undefined}
        className="h-1.5 overflow-hidden rounded-full bg-canvas ring-1 ring-inset ring-border/70"
        role="progressbar"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            score !== null && score < 55 ? "bg-warning/70" : "bg-primary",
          )}
          style={{ width: `${score ?? 0}%` }}
        />
      </div>
      <p
        className="truncate text-[11px] leading-4 text-muted"
        title={component.detail}
      >
        {component.detail}
      </p>
    </li>
  );
}

function WeeklyChart({
  weekly,
}: {
  readonly weekly: ChildProgressAssessment["weekly"];
}) {
  const t = useTranslations("reports");
  const shortDate = useShortDate();
  const maxMinutes = Math.max(...weekly.map((week) => week.minutes), 1);
  return (
    <section
      aria-labelledby="progress-weekly-title"
      className="flex min-w-0 flex-col justify-between space-y-1.5 rounded-control bg-canvas/65 px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-1.5">
        <h3
          className="text-xs font-extrabold text-ink"
          id="progress-weekly-title"
        >
          {t("overview.assessmentCard.weeklyChartTitle")}
        </h3>
        <span className="text-[11px] font-semibold text-muted">
          {t("overview.assessmentCard.weeklyChartHint")}
        </span>
      </div>
      <div aria-hidden="true" className="overflow-x-auto pb-0.5">
        <div className="flex h-16 min-w-full items-end gap-1.5 border-b border-border/80 pt-1 sm:gap-2">
          {weekly.map((week) => {
            const barHeight =
              week.minutes > 0
                ? Math.max(6, Math.round((week.minutes / maxMinutes) * 28))
                : 3;
            return (
              <div
                className="flex h-full min-w-8 flex-1 flex-col justify-end text-center"
                key={week.week_start}
              >
                <span className="whitespace-nowrap text-[10px] font-bold leading-none tabular-nums text-primary">
                  {week.accuracy_pct === null
                    ? "–"
                    : `${Math.round(week.accuracy_pct)}%`}
                </span>
                <div
                  className={cn(
                    "mx-auto mt-0.5 w-full max-w-8 rounded-t-[4px]",
                    week.minutes > 0 ? "bg-primary/85" : "bg-border",
                  )}
                  style={{ height: `${barHeight}px` }}
                  title={t("overview.assessmentCard.weekBarTitle", {
                    minutes: week.minutes,
                    sessions: week.sessions,
                  })}
                />
                <span className="mt-0.5 whitespace-nowrap text-[10px] font-bold leading-none tabular-nums text-ink">
                  {t("overview.assessmentCard.weekBarShort", {
                    minutes: week.minutes,
                  })}
                </span>
                <span className="whitespace-nowrap pb-0.5 text-[10px] font-semibold leading-tight tabular-nums text-muted">
                  {shortDate(week.week_start)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <ul className="sr-only">
        {weekly.map((week) => (
          <li key={week.week_start}>
            {t("overview.assessmentCard.weekTooltip", {
              date: shortDate(week.week_start),
              sessions: week.sessions,
              minutes: week.minutes,
              accuracySuffix:
                week.accuracy_pct === null
                  ? ""
                  : t("overview.assessmentCard.weekTooltipAccuracy", {
                      accuracy: Math.round(week.accuracy_pct),
                    }),
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}

function InsightColumn({
  title,
  tone,
  children,
}: {
  readonly title: string;
  readonly tone: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("space-y-1.5 rounded-control p-3", tone)}>
      <h4 className="text-xs font-extrabold text-ink sm:text-sm">{title}</h4>
      {children}
    </section>
  );
}

export function ChildProgressAssessmentCard({
  childId,
  childName,
  showReadingAssessment = true,
  compact = false,
}: {
  readonly childId: string;
  readonly childName: string;
  readonly showReadingAssessment?: boolean;
  readonly compact?: boolean;
}) {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const service = useContext(AppServicesContext)?.childProgressService;
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [view, setView] = useState<View>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const initialLoadProgress = useAiProgress({
    active: Boolean(service) && view.status === "loading",
    expectedDurationMs: 8_000,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.analyzing") },
      { atPct: 45, label: tCommon("aiProgress.writingAssessment") },
      { atPct: 85, label: tCommon("aiProgress.finalizing") },
    ],
  });

  useEffect(() => {
    if (!service) return;
    const request = ++requestRef.current;
    const controller = new AbortController();
    const isCurrent = () => requestRef.current === request;

    service
      .get(childId, days, controller.signal)
      .then((data) => {
        if (!isCurrent()) return;
        const needsAi =
          data.data_status === "OK" && data.assessment.source !== "AI";
        setView({
          status: "ready",
          data,
          ai: needsAi ? "writing" : "idle",
          aiReason: null,
        });
        if (!needsAi) return;
        service
          .generate(childId, days, { signal: controller.signal })
          .then((next) => {
            if (!isCurrent()) return;
            const aiSucceeded = next.assessment.source === "AI";
            setView({
              status: "ready",
              data: next,
              ai: aiSucceeded ? "idle" : "failed",
              aiReason: aiSucceeded ? null : (next.ai_fallback_reason ?? null),
            });
          })
          .catch((error: unknown) => {
            if (!isCurrent() || controller.signal.aborted) return;
            setView((current) =>
              current.status === "ready"
                ? {
                    ...current,
                    ai: "failed",
                    aiReason: classifyClientAiFailure(error),
                  }
                : current,
            );
          });
      })
      .catch(() => {
        if (isCurrent()) setView({ status: "error" });
      });

    return () => {
      requestRef.current += 1;
      controller.abort();
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
    };
  }, [service, childId, days, reloadKey]);

  const refreshAi = useCallback(() => {
    if (!service || view.status !== "ready") return;
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    const request = ++requestRef.current;
    setView({ ...view, ai: "writing", aiReason: null });
    service
      .generate(childId, days, { refresh: true, signal: controller.signal })
      .then((next) => {
        if (requestRef.current !== request || controller.signal.aborted) return;
        const aiSucceeded = next.assessment.source === "AI";
        setView({
          status: "ready",
          data: next,
          ai: aiSucceeded ? "idle" : "failed",
          aiReason: aiSucceeded ? null : (next.ai_fallback_reason ?? null),
        });
      })
      .catch((error: unknown) => {
        if (requestRef.current !== request || controller.signal.aborted) return;
        setView((current) =>
          current.status === "ready"
            ? {
                ...current,
                ai: "failed",
                aiReason: classifyClientAiFailure(error),
              }
            : current,
        );
      });
  }, [service, view, childId, days]);

  // Without the service (tests, demos) the saved-report screen stays unchanged.
  if (!service) return null;

  return (
    <section
      aria-labelledby="ai-progress-title"
      className="min-w-0 rounded-card border border-border bg-white p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <h2
          className="min-w-0 text-sm font-extrabold text-ink sm:text-base"
          id="ai-progress-title"
        >
          {t("overview.assessmentCard.sectionTitle", { childName })}
        </h2>

        <div
          aria-label={t("overview.assessmentCard.windowGroupAria")}
          className="inline-flex shrink-0 rounded-control border border-border bg-canvas p-0.5"
          role="radiogroup"
        >
          {PERIODS.map((option) => (
            <button
              aria-checked={days === option}
              className={cn(
                "min-h-8 rounded-[6px] px-2.5 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                days === option
                  ? "bg-primary text-white"
                  : "text-ink hover:bg-white",
              )}
              key={option}
              onClick={() => {
                if (option === days) return;
                setView({ status: "loading" });
                setDays(option);
              }}
              role="radio"
              type="button"
            >
              {t("overview.assessmentCard.windowOption", { days: option })}
            </button>
          ))}
        </div>
      </div>

      {view.status === "loading" ? (
        <div
          aria-busy="true"
          aria-label={t("overview.assessmentCard.loadingAria")}
          className="mt-3 space-y-3"
        >
          <AiProgressBar
            active
            elapsedSeconds={initialLoadProgress.elapsedSeconds}
            label={
              initialLoadProgress.stageLabel ??
              tCommon("aiProgress.writingAssessment")
            }
            percent={initialLoadProgress.percent}
            size="sm"
            testId="child-progress-initial-loading-progress"
          />
          <Skeleton className="h-24 rounded-control" />
          <Skeleton className="h-20 rounded-control" />
        </div>
      ) : view.status === "error" ? (
        <div className="mt-3 space-y-3">
          <StatusMessage
            title={t("overview.assessmentCard.loadErrorTitle")}
            tone="error"
          >
            {t("overview.assessmentCard.loadErrorDesc")}
          </StatusMessage>
          <Button
            className="sm:w-auto"
            onClick={() => {
              setView({ status: "loading" });
              setReloadKey((key) => key + 1);
            }}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("overview.retry")}
          </Button>
        </div>
      ) : (
        <AssessmentBody
          compact={compact}
          onRefresh={refreshAi}
          showReadingAssessment={showReadingAssessment}
          view={view}
        />
      )}
    </section>
  );
}

const PRACTICE_WORDS_PAGE_SIZE = 12;

function AssessmentBody({
  view,
  onRefresh,
  showReadingAssessment,
  compact,
}: {
  readonly view: Extract<View, { status: "ready" }>;
  readonly onRefresh: () => void;
  readonly showReadingAssessment: boolean;
  readonly compact: boolean;
}) {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const shortDate = useShortDate();
  const teacherPersona = useTeacherPersona();
  const [practiceWordsPage, setPracticeWordsPage] = useState(1);
  const { data } = view;
  const { score, metrics, assessment } = data;
  const totalPracticeWordPages = Math.max(
    1,
    Math.ceil(assessment.practice_words.length / PRACTICE_WORDS_PAGE_SIZE),
  );
  const safePracticeWordsPage = Math.min(
    Math.max(1, practiceWordsPage),
    totalPracticeWordPages,
  );
  const visiblePracticeWords = assessment.practice_words.slice(
    (safePracticeWordsPage - 1) * PRACTICE_WORDS_PAGE_SIZE,
    safePracticeWordsPage * PRACTICE_WORDS_PAGE_SIZE,
  );
  const aiWritingProgress = useAiProgress({
    active: view.ai === "writing",
    expectedDurationMs: 12_000,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.writingAssessment") },
      { atPct: 45, label: tCommon("aiProgress.analyzing") },
      { atPct: 82, label: tCommon("aiProgress.finalizing") },
    ],
  });
  const actionsFor = (audience: "PARENT" | "CHILD") =>
    assessment.actions.filter((action) => action.audience === audience);

  const hasWeekly = data.weekly.some((week) => week.minutes > 0);
  const hasDetails =
    assessment.strengths.length > 0 ||
    assessment.weaknesses.length > 0 ||
    assessment.actions.length > 0 ||
    assessment.practice_words.length > 0;
  const detailSummaryParts: string[] = [];
  if (assessment.strengths.length > 0) {
    detailSummaryParts.push(t("overview.assessmentCard.strengthsTitle"));
  }
  if (assessment.weaknesses.length > 0) {
    detailSummaryParts.push(t("overview.assessmentCard.improvementsTitle"));
  }
  if (assessment.actions.length > 0) {
    detailSummaryParts.push(t("overview.assessmentCard.actionsTitle"));
  }
  if (assessment.practice_words.length > 0) {
    detailSummaryParts.push(
      t("overview.assessmentCard.recommendedWordsTitle", { days: data.days }),
    );
  }

  return (
    <div className="mt-2 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] font-semibold text-muted tabular-nums">
        <p>
          {t("overview.assessmentCard.rangeSummary", {
            start: shortDate(data.period_start),
            end: shortDate(data.period_end),
            days: data.days,
          })}
        </p>
        <p>
          {t("overview.assessmentCard.basisSummary", {
            sessions: metrics.sessions,
            minutes: metrics.reading_minutes,
            words: metrics.words_read,
            accuracySuffix:
              metrics.accuracy_pct !== null
                ? t("overview.assessmentCard.basisAccuracySuffix", {
                    accuracy: Math.round(metrics.accuracy_pct),
                  })
                : "",
          })}
        </p>
      </div>

      <div
        className={cn(
          "grid gap-2.5 lg:items-stretch",
          compact
            ? "sm:grid-cols-[minmax(164px,0.44fr)_minmax(0,1fr)]"
            : hasWeekly
              ? "lg:grid-cols-[minmax(176px,0.5fr)_minmax(0,1.25fr)_minmax(220px,0.85fr)]"
              : "lg:grid-cols-[minmax(184px,0.52fr)_minmax(0,1.48fr)]",
        )}
      >
        <div className="flex flex-col justify-between gap-1.5 rounded-control bg-canvas/75 p-2.5">
          <p className="text-[11px] font-bold text-muted">
            {t("overview.assessmentCard.overallScore")}
          </p>
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-2xl font-extrabold tracking-tight tabular-nums text-ink sm:text-3xl">
              {score.overall ?? "–"}
            </span>
            <span className="text-xs font-bold text-muted">/ 100</span>
            {score.grade_label ? (
              <span
                className={cn(
                  "ms-0.5 rounded-full px-2 py-0.5 text-[11px] font-bold",
                  GRADE_STYLES[score.grade ?? ""] ??
                    "bg-sky text-primary-hover",
                )}
              >
                {score.grade_label}
              </span>
            ) : (
              <span className="ms-0.5 rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-muted">
                {t("overview.notEnoughData")}
              </span>
            )}
          </div>
          <div>
            <TrendBadge delta={score.delta} />
          </div>
        </div>

        {score.components.length > 0 ? (
          <ul className="grid content-center gap-x-3 gap-y-1.5 sm:grid-cols-2">
            {score.components.map((component) => (
              <ComponentBar component={component} key={component.key} />
            ))}
          </ul>
        ) : (
          <p className="rounded-control bg-canvas/70 p-2.5 text-xs text-muted">
            {t("overview.assessmentCard.insufficientDetailDesc", {
              days: data.days,
            })}
          </p>
        )}

        {hasWeekly && !compact ? <WeeklyChart weekly={data.weekly} /> : null}
      </div>

      {hasWeekly && compact ? <WeeklyChart weekly={data.weekly} /> : null}

      {showReadingAssessment ? (
        <ReadingAssessmentSummary
          assessment={metrics.reading_assessment}
          compact={compact}
          embedded
          scopeLabel={t("overview.assessmentCard.scopeRecentDays", {
            days: data.days,
          })}
        />
      ) : null}

      <div
        aria-live="polite"
        className="space-y-2 border-t border-border pt-2.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-bold",
                assessment.source === "AI"
                  ? "bg-sky text-primary-hover"
                  : "bg-canvas text-muted",
              )}
            >
              {assessment.source === "AI"
                ? t("overview.assessmentCard.aiCommentBadge")
                : t("overview.assessmentCard.autoCommentBadge")}
            </span>
            <h3 className="text-sm font-extrabold text-ink">
              {assessment.headline}
            </h3>
          </div>
          {data.data_status === "OK" ? (
            <Button
              className="h-8 min-h-8! w-auto shrink-0 px-2.5! py-0! text-xs!"
              disabled={view.ai === "writing"}
              isLoading={view.ai === "writing"}
              onClick={onRefresh}
              size="admin"
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
              {view.ai === "writing"
                ? t("overview.assessmentCard.aiWriting")
                : t("overview.assessmentCard.aiRefresh")}
            </Button>
          ) : null}
        </div>

        {view.ai === "writing" ? (
          <AiProgressBar
            active
            elapsedSeconds={aiWritingProgress.elapsedSeconds}
            label={
              aiWritingProgress.stageLabel ??
              tCommon("aiProgress.writingAssessment")
            }
            percent={aiWritingProgress.percent}
            size="sm"
            testId="child-progress-ai-writing-progress"
          />
        ) : null}

        {view.ai === "failed" ? (
          <StatusMessage tone="warning">
            {resolveAiFallbackMessage(view.aiReason, t)}
          </StatusMessage>
        ) : null}

        <div className="space-y-1.5">
          <p className="text-xs leading-relaxed text-ink sm:text-sm">
            {adaptTextToTeacherPersona(
              assessment.summary,
              teacherPersona.gender,
            )}
          </p>
          {assessment.encouragement ? (
            <p className="rounded-control bg-sky/40 px-2.5 py-1.5 text-xs font-semibold leading-snug text-primary-hover">
              {adaptTextToTeacherPersona(
                assessment.encouragement,
                teacherPersona.gender,
              )}
            </p>
          ) : null}
        </div>

        {hasDetails ? (
          <details className="group rounded-control bg-canvas/65 px-3 py-1.5">
            <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 py-0.5 text-xs font-extrabold leading-snug text-primary [&::-webkit-details-marker]:hidden">
              <span className="min-w-0">{detailSummaryParts.join(" · ")}</span>
              <ChevronDown
                aria-hidden="true"
                className="size-4 shrink-0 transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="mt-2.5 space-y-2.5 border-t border-border/70 pt-2.5">
              {assessment.strengths.length > 0 ||
              assessment.weaknesses.length > 0 ? (
                <div className="grid gap-2 lg:grid-cols-2">
                  {assessment.strengths.length > 0 ? (
                    <InsightColumn
                      title={t("overview.assessmentCard.strengthsTitle")}
                      tone="bg-success-surface/45"
                    >
                      <ul className="list-disc space-y-1 ps-5 text-xs leading-relaxed text-ink sm:text-sm">
                        {assessment.strengths.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </InsightColumn>
                  ) : null}
                  {assessment.weaknesses.length > 0 ? (
                    <InsightColumn
                      title={t("overview.assessmentCard.improvementsTitle")}
                      tone="bg-warning-surface/45"
                    >
                      <ul className="space-y-1.5 text-xs sm:text-sm">
                        {assessment.weaknesses.map((item) => (
                          <li className="flex gap-2" key={item.area}>
                            <TriangleAlert
                              aria-hidden="true"
                              className="mt-0.5 size-4 shrink-0 text-warning"
                            />
                            <span>
                              <strong className="block font-bold text-ink">
                                {item.area}
                              </strong>
                              <span className="text-muted">{item.detail}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </InsightColumn>
                  ) : null}
                </div>
              ) : null}

              {assessment.actions.length > 0 ? (
                <section className="space-y-1.5">
                  <h3 className="inline-flex items-center gap-1.5 text-xs font-extrabold text-ink sm:text-sm">
                    <Lightbulb
                      aria-hidden="true"
                      className="size-3.5 text-primary"
                    />
                    {t("overview.assessmentCard.actionsTitle")}
                  </h3>
                  <div className="grid gap-2 lg:grid-cols-2">
                    {(
                      [
                        ["PARENT", t("overview.assessmentCard.parentRole")],
                        ["CHILD", t("overview.assessmentCard.childRole")],
                      ] as const
                    ).map(([audience, title]) =>
                      actionsFor(audience).length > 0 ? (
                        <div
                          className="space-y-1 rounded-control bg-white/85 p-2.5"
                          key={audience}
                        >
                          <h4 className="text-xs font-extrabold text-primary sm:text-sm">
                            {title}
                          </h4>
                          <ul className="space-y-1 text-xs sm:text-sm">
                            {actionsFor(audience).map((action) => (
                              <li key={action.title}>
                                <strong className="block font-bold text-ink">
                                  {action.title}
                                </strong>
                                <span className="text-muted">
                                  {audience === "CHILD"
                                    ? adaptTextToTeacherPersona(
                                        action.detail,
                                        teacherPersona.gender,
                                      )
                                    : action.detail}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null,
                    )}
                  </div>
                </section>
              ) : null}

              {assessment.practice_words.length > 0 ? (
                <section className="space-y-1.5">
                  <h3 className="text-xs font-extrabold text-ink sm:text-sm">
                    {t("overview.assessmentCard.recommendedWordsTitle", {
                      days: data.days,
                    })}
                  </h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {visiblePracticeWords.map((word) => {
                      const detail = data.difficult_words.find(
                        (item) => item.word === word,
                      );
                      return (
                        <li
                          className="rounded-control bg-white px-2.5 py-1 text-xs font-bold text-ink sm:text-sm"
                          key={word}
                          title={
                            detail?.heard_as
                              ? t("overview.assessmentCard.heardAsCount", {
                                  heardAs: detail.heard_as,
                                  times: detail.times,
                                })
                              : detail
                                ? t("overview.assessmentCard.recordedCount", {
                                    times: detail.times,
                                  })
                                : undefined
                          }
                        >
                          <span
                            className="viread-learning-content"
                            dir="ltr"
                            lang="vi"
                          >
                            {word}
                          </span>
                          {detail?.heard_as ? (
                            <span className="ms-1.5 text-xs font-medium text-muted">
                              {t("overview.assessmentCard.heardAsInline", {
                                heardAs: detail.heard_as,
                              })}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  <PaginationBar
                    ariaLabel={t(
                      "overview.assessmentCard.recommendedWordsTitle",
                      {
                        days: data.days,
                      },
                    )}
                    className="mt-1.5"
                    compact
                    onPageChange={setPracticeWordsPage}
                    page={safePracticeWordsPage}
                    pageSize={PRACTICE_WORDS_PAGE_SIZE}
                    total={assessment.practice_words.length}
                  />
                </section>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
