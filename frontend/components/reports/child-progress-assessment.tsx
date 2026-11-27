"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
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
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { ChildProgressAssessment } from "@/lib/api/child-progress-service";
import { cn } from "@/lib/utils/cn";

const PERIODS = [7, 30, 90] as const;
const GRADE_STYLES: Record<string, string> = {
  EXCELLENT: "border border-success-ink/20 bg-success-surface text-success-ink",
  GOOD: "border border-primary/20 bg-sky text-primary-hover",
  FAIR: "border border-warning/25 bg-warning-surface text-warning",
  NEEDS_SUPPORT: "border border-danger/20 bg-danger-surface text-danger",
};

type View =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      data: ChildProgressAssessment;
      ai: "idle" | "writing" | "failed";
    };

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
        "inline-flex items-center gap-1 rounded-control px-2.5 py-1 text-xs font-bold tabular-nums",
        up
          ? "bg-success-surface text-success-ink"
          : down
            ? "bg-warning-surface text-warning"
            : "bg-canvas text-muted ring-1 ring-inset ring-border",
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
    <li className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-bold text-ink">{component.label}</span>
        <span
          className={cn(
            "text-sm font-extrabold tabular-nums",
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
        className="h-2.5 overflow-hidden rounded-full bg-canvas ring-1 ring-inset ring-border/70"
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
      <p className="text-xs leading-5 text-muted">{component.detail}</p>
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
      className="space-y-3 rounded-card border border-border bg-cream/60 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3
          className="text-base font-extrabold text-ink"
          id="progress-weekly-title"
        >
          {t("overview.assessmentCard.weeklyChartTitle")}
        </h3>
        <span className="text-xs font-semibold text-muted">
          {t("overview.assessmentCard.weeklyChartHint")}
        </span>
      </div>
      <div
        aria-hidden="true"
        className="flex h-40 items-end gap-2 border-b border-border pt-2 sm:gap-4"
      >
        {weekly.map((week) => {
          const barHeight =
            week.minutes > 0
              ? Math.max(10, Math.round((week.minutes / maxMinutes) * 92))
              : 3;
          return (
            <div
              className="flex h-full min-w-0 flex-1 flex-col justify-end text-center"
              key={week.week_start}
            >
              <span className="mb-1 text-xs font-bold tabular-nums text-primary">
                {week.accuracy_pct === null
                  ? "–"
                  : `${Math.round(week.accuracy_pct)}%`}
              </span>
              <div
                className={cn(
                  "mx-auto w-full max-w-12 rounded-t-control",
                  week.minutes > 0 ? "bg-primary/85" : "bg-border",
                )}
                style={{ height: `${barHeight}px` }}
                title={t("overview.assessmentCard.weekBarTitle", {
                  minutes: week.minutes,
                  sessions: week.sessions,
                })}
              />
              <span className="mt-1.5 text-[11px] font-bold tabular-nums text-ink">
                {t("overview.assessmentCard.weekBarShort", {
                  minutes: week.minutes,
                })}
              </span>
              <span className="pb-1.5 text-[11px] font-semibold tabular-nums text-muted">
                {shortDate(week.week_start)}
              </span>
            </div>
          );
        })}
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
    <section className={cn("space-y-2.5 rounded-control border p-4", tone)}>
      <h4 className="text-sm font-extrabold text-ink">{title}</h4>
      {children}
    </section>
  );
}

export function ChildProgressAssessmentCard({
  childId,
  childName,
  showReadingAssessment = true,
}: {
  readonly childId: string;
  readonly childName: string;
  readonly showReadingAssessment?: boolean;
}) {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const service = useContext(AppServicesContext)?.childProgressService;
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [view, setView] = useState<View>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);
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
        setView({ status: "ready", data, ai: needsAi ? "writing" : "idle" });
        if (!needsAi) return;
        service
          .generate(childId, days, { signal: controller.signal })
          .then((next) => {
            if (!isCurrent()) return;
            setView({
              status: "ready",
              data: next,
              ai: next.assessment.source === "AI" ? "idle" : "failed",
            });
          })
          .catch(() => {
            if (!isCurrent()) return;
            setView((current) =>
              current.status === "ready"
                ? { ...current, ai: "failed" }
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
    };
  }, [service, childId, days, reloadKey]);

  const refreshAi = useCallback(() => {
    if (!service || view.status !== "ready") return;
    const request = ++requestRef.current;
    setView({ ...view, ai: "writing" });
    service
      .generate(childId, days, { refresh: true })
      .then((next) => {
        if (requestRef.current !== request) return;
        setView({
          status: "ready",
          data: next,
          ai: next.assessment.source === "AI" ? "idle" : "failed",
        });
      })
      .catch(() => {
        if (requestRef.current !== request) return;
        setView((current) =>
          current.status === "ready" ? { ...current, ai: "failed" } : current,
        );
      });
  }, [service, view, childId, days]);

  // Without the service (tests, demos) the saved-report screen stays unchanged.
  if (!service) return null;

  return (
    <section
      aria-labelledby="ai-progress-title"
      className="rounded-card border border-border bg-white p-5 sm:p-6"
    >
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="text-xs font-bold text-primary">
            {t("overview.assessmentCard.sectionEyebrow")}
          </p>
          <h2
            className="text-xl font-extrabold text-ink sm:text-2xl"
            id="ai-progress-title"
          >
            {t("overview.assessmentCard.sectionTitle", { childName })}
          </h2>
          <p className="text-sm text-muted">
            {t("overview.assessmentCard.sectionSubtitle")}
          </p>
        </div>

        <div
          aria-label={t("overview.assessmentCard.windowGroupAria")}
          className="inline-flex shrink-0 self-start rounded-control border border-border bg-canvas p-1 sm:self-auto"
          role="radiogroup"
        >
          {PERIODS.map((option) => (
            <button
              aria-checked={days === option}
              className={cn(
                "min-h-10 rounded-control px-3.5 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-primary",
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
          className="mt-5 space-y-4"
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
          <Skeleton className="h-32 rounded-card" />
          <Skeleton className="h-24 rounded-card" />
        </div>
      ) : view.status === "error" ? (
        <div className="mt-5 space-y-4">
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
          onRefresh={refreshAi}
          showReadingAssessment={showReadingAssessment}
          view={view}
        />
      )}
    </section>
  );
}

function AssessmentBody({
  view,
  onRefresh,
  showReadingAssessment,
}: {
  readonly view: Extract<View, { status: "ready" }>;
  readonly onRefresh: () => void;
  readonly showReadingAssessment: boolean;
}) {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const shortDate = useShortDate();
  const { data } = view;
  const { score, metrics, assessment } = data;
  const aiWritingProgress = useAiProgress({
    active: view.ai === "writing",
    expectedDurationMs: 10_000,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.writingAssessment") },
      { atPct: 45, label: tCommon("aiProgress.analyzing") },
      { atPct: 82, label: tCommon("aiProgress.finalizing") },
    ],
  });
  const actionsFor = (audience: "PARENT" | "CHILD") =>
    assessment.actions.filter((action) => action.audience === audience);

  return (
    <div className="mt-5 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-muted">
        <p>
          {t("overview.assessmentCard.rangeSummary", {
            start: shortDate(data.period_start),
            end: shortDate(data.period_end),
            days: data.days,
          })}
        </p>
        <p className="tabular-nums">
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

      <div className="grid gap-5 lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.25fr)] lg:items-start">
        <div className="flex flex-col gap-3 rounded-control border border-border bg-cream/70 p-4 sm:p-5">
          <p className="text-xs font-bold text-muted">
            {t("overview.assessmentCard.overallScore")}
          </p>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-4xl font-extrabold tracking-tight tabular-nums text-ink">
              {score.overall ?? "–"}
            </span>
            <span className="text-sm font-bold text-muted">/ 100</span>
            {score.grade_label ? (
              <span
                className={cn(
                  "ms-1 rounded-control px-2.5 py-0.5 text-sm font-bold",
                  GRADE_STYLES[score.grade ?? ""] ??
                    "bg-sky text-primary-hover",
                )}
              >
                {score.grade_label}
              </span>
            ) : (
              <span className="ms-1 rounded-control bg-canvas px-2.5 py-0.5 text-sm font-bold text-muted ring-1 ring-inset ring-border">
                {t("overview.notEnoughData")}
              </span>
            )}
          </div>
          <div>
            <TrendBadge delta={score.delta} />
          </div>
        </div>

        {score.components.length > 0 ? (
          <ul className="space-y-3.5">
            {score.components.map((component) => (
              <ComponentBar component={component} key={component.key} />
            ))}
          </ul>
        ) : (
          <p className="rounded-control border border-dashed border-border bg-canvas p-4 text-sm text-muted">
            {t("overview.assessmentCard.insufficientDetailDesc", {
              days: data.days,
            })}
          </p>
        )}
      </div>

      {showReadingAssessment ? (
        <ReadingAssessmentSummary
          assessment={metrics.reading_assessment}
          scopeLabel={t("overview.assessmentCard.scopeRecentDays", {
            days: data.days,
          })}
        />
      ) : null}

      {data.weekly.some((week) => week.minutes > 0) ? (
        <WeeklyChart weekly={data.weekly} />
      ) : null}

      <div className="space-y-4 border-t border-border pt-5" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className={cn(
              "inline-flex items-center rounded-control px-2.5 py-1 text-xs font-bold",
              assessment.source === "AI"
                ? "border border-primary/20 bg-sky text-primary-hover"
                : "border border-border bg-canvas text-muted",
            )}
          >
            {assessment.source === "AI"
              ? t("overview.assessmentCard.aiCommentBadge")
              : t("overview.assessmentCard.autoCommentBadge")}
          </span>
          {data.data_status === "OK" ? (
            <Button
              className="min-h-11 w-auto px-3.5 text-sm"
              disabled={view.ai === "writing"}
              isLoading={view.ai === "writing"}
              onClick={onRefresh}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
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
            {t("overview.assessmentCard.aiFallbackHint")}
          </StatusMessage>
        ) : null}

        <div className="max-w-3xl space-y-1.5">
          <h3 className="text-lg font-extrabold text-ink">
            {assessment.headline}
          </h3>
          <p className="text-body leading-relaxed text-ink">
            {assessment.summary}
          </p>
        </div>

        {assessment.strengths.length > 0 || assessment.weaknesses.length > 0 ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {assessment.strengths.length > 0 ? (
              <InsightColumn
                title={t("overview.assessmentCard.strengthsTitle")}
                tone="border-success-ink/20 bg-success-surface/35"
              >
                <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-ink">
                  {assessment.strengths.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </InsightColumn>
            ) : null}
            {assessment.weaknesses.length > 0 ? (
              <InsightColumn
                title={t("overview.assessmentCard.improvementsTitle")}
                tone="border-warning/25 bg-warning-surface/40"
              >
                <ul className="space-y-2.5 text-sm">
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
          <section className="space-y-3">
            <h3 className="inline-flex items-center gap-2 text-base font-extrabold text-ink">
              <Lightbulb aria-hidden="true" className="size-4 text-primary" />
              {t("overview.assessmentCard.actionsTitle")}
            </h3>
            <div className="grid gap-3 lg:grid-cols-2">
              {(
                [
                  ["PARENT", t("overview.assessmentCard.parentRole")],
                  ["CHILD", t("overview.assessmentCard.childRole")],
                ] as const
              ).map(([audience, title]) =>
                actionsFor(audience).length > 0 ? (
                  <div
                    className="space-y-2 rounded-control border border-border bg-cream/70 p-4"
                    key={audience}
                  >
                    <h4 className="text-sm font-extrabold text-primary">
                      {title}
                    </h4>
                    <ul className="space-y-2.5 text-sm">
                      {actionsFor(audience).map((action) => (
                        <li key={action.title}>
                          <strong className="block font-bold text-ink">
                            {action.title}
                          </strong>
                          <span className="text-muted">{action.detail}</span>
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
          <section className="space-y-2">
            <h3 className="text-sm font-extrabold text-ink">
              {t("overview.assessmentCard.recommendedWordsTitle", {
                days: data.days,
              })}
            </h3>
            <ul className="flex flex-wrap gap-2">
              {assessment.practice_words.map((word) => {
                const detail = data.difficult_words.find(
                  (item) => item.word === word,
                );
                return (
                  <li
                    className="rounded-control border border-border bg-canvas px-3 py-1.5 text-sm font-bold text-ink"
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
          </section>
        ) : null}

        {assessment.encouragement ? (
          <p className="border-s-2 border-primary ps-3.5 text-sm font-semibold text-muted">
            {assessment.encouragement}
          </p>
        ) : null}
      </div>
    </div>
  );
}
