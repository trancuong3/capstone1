"use client";

import { Flame, Hourglass, CheckCircle2, CalendarDays } from "lucide-react";
import { useState } from "react";

import { PaginationBar } from "@/components/common/pagination-bar";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { translateMessage } from "@/lib/i18n/formatter";
import { normalizeLocale, type SupportedLocale } from "@/lib/i18n/locales";
import { readLocaleCookie } from "@/lib/i18n/persistence";
import { getCachedLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";
import type {
  ReadingGoalDTO,
  ReadingPlanDTO,
} from "@/types/reading-management";

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function resolveReadingManagementLocale(): SupportedLocale {
  if (typeof document !== "undefined") {
    const cookieLocale = readLocaleCookie();
    if (cookieLocale) return cookieLocale;
    const htmlLang = normalizeLocale(document.documentElement.lang);
    if (htmlLang) return htmlLang;
  }
  return "vi";
}

function translateRm(
  key: string,
  params?: Record<string, string | number>,
  locale: SupportedLocale = resolveReadingManagementLocale(),
): string {
  const activeMessages = getCachedLocaleMessages(locale) ?? viMessages;
  return translateMessage(
    activeMessages,
    viMessages,
    locale,
    `reports.readingManagement.${key}`,
    params,
  );
}

/** "2026-11-09" -> "09/11". Dates are calendar days, never shifted by time zone. */
export function shortDate(value: string): string {
  const [, month, day] = value.split("-");
  return `${day}/${month}`;
}

/** "2026-11-09" -> "Thứ hai, 09/11". */
export function dayLabel(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const weekdayName = translateRm(`weekdays.${WEEKDAY_KEYS[weekday] ?? "sun"}`);
  return `${weekdayName}, ${shortDate(value)}`;
}

export function goalCycleLabel(goal: ReadingGoalDTO): string | null {
  if (!goal.cycle_starts_on || !goal.cycle_ends_on) return null;
  if (goal.cycle_starts_on === goal.cycle_ends_on) {
    return translateRm("cycleDate", { date: shortDate(goal.cycle_starts_on) });
  }
  return `${shortDate(goal.cycle_starts_on)} – ${shortDate(goal.cycle_ends_on)}`;
}

/** Goals that are live right now: not paused, finished, expired or upcoming. */
export function isRunningGoal(goal: ReadingGoalDTO): boolean {
  return goal.status === "ACTIVE" && (goal.phase ?? "RUNNING") === "RUNNING";
}

export function isRunningPlan(plan: ReadingPlanDTO): boolean {
  return plan.status === "ACTIVE" && (plan.phase ?? "RUNNING") === "RUNNING";
}

const noteClass =
  "mt-1.5 flex items-start gap-1.5 rounded-control px-2 py-1 text-xs leading-snug";

/** Extra lines for a goal card: cycle, phase hint and streak. */
export function GoalInsights({ goal }: { goal: ReadingGoalDTO }) {
  const { locale } = useI18n();
  const t = useTranslations("reports");
  const phase = goal.phase ?? "RUNNING";
  const streak = goal.streak_cycles ?? 0;
  const cycle =
    goal.cycle_starts_on && goal.cycle_ends_on
      ? goal.cycle_starts_on === goal.cycle_ends_on
        ? t("readingManagement.cycleDate", {
            date: shortDate(goal.cycle_starts_on),
          })
        : `${shortDate(goal.cycle_starts_on)} – ${shortDate(goal.cycle_ends_on)}`
      : null;
  const unit =
    goal.period === "DAILY"
      ? t("readingManagement.unitDay")
      : t("readingManagement.unitWeek");
  const finished = goal.status === "COMPLETED" || goal.status === "ENDED";
  const expiredSuffix = goal.ends_on
    ? t("readingManagement.expiredDateFrom", { date: shortDate(goal.ends_on) })
    : "";
  void locale;
  return (
    <>
      {cycle && !finished ? (
        <p className="mt-1 text-xs tabular-nums text-muted">
          {phase === "EXPIRED"
            ? t("readingManagement.cycleLastLabel")
            : t("readingManagement.cycleCurrentLabel")}
          : {cycle}
        </p>
      ) : null}
      {phase === "UPCOMING" ? (
        <p className={`${noteClass} bg-sky/75 text-primary`} role="note">
          <Hourglass aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t("readingManagement.goalNotStarted", {
            date: shortDate(goal.starts_on),
          })}
        </p>
      ) : null}
      {phase === "EXPIRED" && !finished ? (
        <p className={`${noteClass} bg-cream text-ink`} role="note">
          <Hourglass aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t("readingManagement.goalExpired", { dateSuffix: expiredSuffix })}
        </p>
      ) : null}
      {streak > 0 && !finished ? (
        <p className={`${noteClass} bg-sky/75 text-primary`}>
          <Flame aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t("readingManagement.goalStreakSummary", { streak, unit })}
          </span>
        </p>
      ) : null}
    </>
  );
}

/** Extra lines for a plan card: today's progress or the next reading day. */
export function PlanInsights({ plan }: { plan: ReadingPlanDTO }) {
  const { locale } = useI18n();
  const t = useTranslations("reports");
  const formatDay = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return `${t(`readingManagement.weekdays.${WEEKDAY_KEYS[weekday] ?? "sun"}`)}, ${shortDate(value)}`;
  };
  void locale;
  const phase = plan.phase ?? "RUNNING";
  const finished = plan.status === "COMPLETED" || plan.status === "ENDED";
  if (finished) return null;
  if (phase === "UPCOMING") {
    return (
      <p className={`${noteClass} bg-sky/75 text-primary`} role="note">
        <Hourglass aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {t("readingManagement.planStartsOn", {
          date: shortDate(plan.starts_on),
        })}
        {plan.next_scheduled_date
          ? t("readingManagement.planFirstSession", {
              day: formatDay(plan.next_scheduled_date),
            })
          : ""}
      </p>
    );
  }
  if (phase === "EXPIRED") {
    const dateSuffix = plan.ends_on
      ? t("readingManagement.expiredDateFrom", {
          date: shortDate(plan.ends_on),
        })
      : "";
    return (
      <p className={`${noteClass} bg-cream text-ink`} role="note">
        <Hourglass aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {t("readingManagement.planExpired", { dateSuffix })}
      </p>
    );
  }
  if (plan.status === "PAUSED") return null;
  const minutes = plan.minutes_today ?? 0;
  if (plan.is_scheduled_today) {
    const reached = minutes >= plan.target_minutes;
    return (
      <p
        className={`${noteClass} ${reached ? "bg-sky/75 text-primary" : "bg-canvas/70 text-ink"}`}
      >
        {reached ? (
          <CheckCircle2
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
        ) : (
          <CalendarDays
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-primary"
          />
        )}
        <span>
          {reached
            ? t("readingManagement.todayPlanReadStatusDone")
            : t("readingManagement.todayPlanReadStatusNeed")}
          <strong className="tabular-nums">
            {t("readingManagement.todayPlanReadMinutes", {
              minutes,
              target: plan.target_minutes,
            })}
          </strong>
        </span>
      </p>
    );
  }
  if (plan.next_scheduled_date) {
    return (
      <p className={`${noteClass} bg-canvas/70 text-ink`}>
        <CalendarDays
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-primary"
        />
        <span>
          {t("readingManagement.todayPlanNextSession")}
          <strong>{formatDay(plan.next_scheduled_date)}</strong>
        </span>
      </p>
    );
  }
  return null;
}

const TODAY_ITEMS_PAGE_SIZE = 4;

type TodayItem =
  | { readonly kind: "plan"; readonly plan: ReadingPlanDTO }
  | { readonly kind: "goal"; readonly goal: ReadingGoalDTO };

interface TodaySummaryProps {
  readonly childName: string;
  readonly plans: readonly ReadingPlanDTO[];
  readonly goals: readonly ReadingGoalDTO[];
  readonly embedded?: boolean;
}

/** One glance at what the child should do today. */
export function TodaySummary({
  childName,
  plans,
  goals,
  embedded = false,
}: TodaySummaryProps) {
  const t = useTranslations("reports");
  const [page, setPage] = useState(1);
  const formatDay = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return `${t(`readingManagement.weekdays.${WEEKDAY_KEYS[weekday] ?? "sun"}`)}, ${shortDate(value)}`;
  };
  const todayPlans = plans.filter(
    (plan) => isRunningPlan(plan) && plan.is_scheduled_today,
  );
  const dailyGoals = goals.filter(
    (goal) => isRunningGoal(goal) && goal.period === "DAILY",
  );
  const todayItems: TodayItem[] = [
    ...todayPlans.map((plan): TodayItem => ({ kind: "plan", plan })),
    ...dailyGoals.map((goal): TodayItem => ({ kind: "goal", goal })),
  ];
  const totalPages = Math.max(
    1,
    Math.ceil(todayItems.length / TODAY_ITEMS_PAGE_SIZE),
  );
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visibleItems = todayItems.slice(
    (safePage - 1) * TODAY_ITEMS_PAGE_SIZE,
    safePage * TODAY_ITEMS_PAGE_SIZE,
  );
  const nextPlan = plans
    .filter((plan) => plan.status === "ACTIVE" && plan.next_scheduled_date)
    .sort((a, b) =>
      (a.next_scheduled_date ?? "").localeCompare(b.next_scheduled_date ?? ""),
    )[0];

  return (
    <section
      aria-label={t("readingManagement.todayAria")}
      className={
        embedded
          ? "mt-2.5 border-t border-border/70 pt-2.5"
          : "rounded-card border border-border bg-white px-3.5 py-2.5"
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-extrabold text-ink sm:text-base">
          {t("readingManagement.todayTitle", { childName })}
        </h2>
        {todayItems.length === 0 ? (
          <p className="text-xs text-muted">
            {nextPlan?.next_scheduled_date
              ? t("readingManagement.todayEmptyNextPlan", {
                  day: formatDay(nextPlan.next_scheduled_date),
                  title: nextPlan.title,
                })
              : t("readingManagement.todayNoActiveItems")}
          </p>
        ) : null}
      </div>
      {todayItems.length > 0 ? (
        <>
          <ul className="mt-2 grid gap-2 md:grid-cols-2">
            {visibleItems.map((item) => {
              if (item.kind === "plan") {
                const { plan } = item;
                const minutes = plan.minutes_today ?? 0;
                const percent = Math.min(
                  100,
                  Math.round((minutes * 100) / plan.target_minutes),
                );
                return (
                  <li
                    key={plan.id}
                    className="flex min-w-0 flex-col justify-between rounded-control bg-canvas/70 px-3 py-2"
                  >
                    <div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                        <p className="min-w-0 truncate text-xs font-bold text-ink sm:text-sm">
                          {plan.title}
                        </p>
                        <p className="shrink-0 text-xs font-semibold tabular-nums text-primary">
                          {t("readingManagement.todayPlanMinutes", {
                            minutes,
                            target: plan.target_minutes,
                          })}
                          {minutes >= plan.target_minutes
                            ? t("readingManagement.todayPlanMetSuffix")
                            : ""}
                        </p>
                      </div>
                      {plan.book_title ? (
                        <p className="mt-0.5 truncate text-xs text-muted">
                          {t("readingManagement.bookPrefix", {
                            title: "",
                          }).trimEnd()}{" "}
                          <span
                            className="viread-learning-content"
                            dir="ltr"
                            lang="vi"
                          >
                            {plan.book_title}
                          </span>
                        </p>
                      ) : null}
                    </div>
                    <div className="mt-auto pt-1.5">
                      <div
                        role="progressbar"
                        aria-label={t(
                          "readingManagement.todayPlanProgressAria",
                          {
                            title: plan.title,
                          },
                        )}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent}
                        className="h-1.5 overflow-hidden rounded-full bg-white"
                      >
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </div>
                  </li>
                );
              }
              const { goal } = item;
              return (
                <li
                  key={goal.id}
                  className="flex min-w-0 flex-col justify-between rounded-control bg-canvas/70 px-3 py-2"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                    <p className="min-w-0 truncate text-xs font-bold text-ink sm:text-sm">
                      {t("readingManagement.todayGoalPrefix", {
                        value: goal.target_value,
                        unit:
                          goal.metric === "MINUTES"
                            ? t("readingManagement.unitMinute")
                            : t("readingManagement.unitSession"),
                      })}
                    </p>
                    <p className="shrink-0 text-xs font-semibold tabular-nums text-primary">
                      {goal.current_value}/{goal.target_value}
                      {goal.progress_percent >= 100
                        ? t("readingManagement.todayGoalMetSuffix")
                        : ""}
                      {(goal.streak_cycles ?? 0) > 0
                        ? t("readingManagement.todayGoalStreakSuffix", {
                            streak: goal.streak_cycles ?? 0,
                          })
                        : ""}
                    </p>
                  </div>
                  <div className="mt-auto pt-1.5">
                    <div
                      role="progressbar"
                      aria-label={t("readingManagement.todayGoalProgressAria", {
                        value: goal.target_value,
                      })}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(goal.progress_percent)}
                      className="h-1.5 overflow-hidden rounded-full bg-white"
                    >
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{
                          width: `${Math.min(100, goal.progress_percent)}%`,
                        }}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <PaginationBar
            className="mt-2"
            compact
            onPageChange={setPage}
            page={safePage}
            pageSize={TODAY_ITEMS_PAGE_SIZE}
            total={todayItems.length}
          />
        </>
      ) : null}
    </section>
  );
}
