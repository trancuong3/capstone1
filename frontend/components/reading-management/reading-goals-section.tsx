"use client";

import { CheckCircle2, Target } from "lucide-react";

import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { GoalInsights } from "@/components/reading-management/reading-management-insights";
import { useTranslations } from "@/hooks/use-i18n";
import type {
  ReadingGoalDTO,
  ReadingGoalStatus,
} from "@/types/reading-management";
import { GOALS_PAGE_SIZE } from "./reading-management-utils";

export interface ReadingGoalsSectionProps {
  readonly goals: readonly ReadingGoalDTO[];
  readonly page: number;
  readonly onPageChange: (next: number) => void;
  readonly busyKey: string;
  readonly editingGoalId: string;
  readonly editingTarget: string;
  readonly onStartEditGoal: (goal: ReadingGoalDTO) => void;
  readonly onChangeEditingTarget: (value: string) => void;
  readonly onSaveEditedGoal: (goal: ReadingGoalDTO) => void;
  readonly onCancelEditGoal: () => void;
  readonly onAddGoal: () => void;
  readonly onTransitionGoal: (
    goal: ReadingGoalDTO,
    next: ReadingGoalStatus,
  ) => void;
}

export function ReadingGoalsSection({
  goals,
  page,
  onPageChange,
  busyKey,
  editingGoalId,
  editingTarget,
  onStartEditGoal,
  onChangeEditingTarget,
  onSaveEditedGoal,
  onCancelEditGoal,
  onAddGoal,
  onTransitionGoal,
}: ReadingGoalsSectionProps) {
  const t = useTranslations("reports");
  const totalPages = Math.max(1, Math.ceil(goals.length / GOALS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visibleGoals = goals.slice(
    (safePage - 1) * GOALS_PAGE_SIZE,
    safePage * GOALS_PAGE_SIZE,
  );

  return (
    <section
      aria-label={t("readingManagement.goalsSectionAria")}
      className="min-w-0 rounded-card border border-border bg-white p-3.5"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky/70 text-primary"
          >
            <Target className="size-4" />
          </span>
          <h2 className="min-w-0 break-words text-sm font-extrabold leading-snug text-ink sm:text-base">
            {t("readingManagement.goalsTitle")}
          </h2>
          <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-xs font-bold tabular-nums text-muted">
            {goals.length}
          </span>
        </div>
        <Button
          fullWidth={false}
          size="compact"
          variant="secondary"
          className="h-8! min-h-8! shrink-0 whitespace-nowrap px-2.5! py-1! text-xs!"
          onClick={onAddGoal}
        >
          {t("readingManagement.addGoal")}
        </Button>
      </div>

      {goals.length === 0 ? (
        <p className="mt-2 rounded-control border border-dashed border-border/80 bg-canvas/50 px-3 py-3 text-center text-sm text-muted">
          {t("readingManagement.goalsEmpty")}
        </p>
      ) : (
        <>
          <div className="divide-y divide-border/70">
            {visibleGoals.map((goal) => (
              <article
                key={goal.id}
                data-goal-id={goal.id}
                className="min-w-0 py-2.5 first:pt-1 last:pb-0.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-bold leading-snug text-ink">
                      {goal.target_value}{" "}
                      {goal.metric === "MINUTES"
                        ? t("readingManagement.unitMinute")
                        : t("readingManagement.unitSession")}{" "}
                      ·{" "}
                      {goal.period === "DAILY"
                        ? t("readingManagement.goalPeriodDaily")
                        : t("readingManagement.goalPeriodWeekly")}
                    </h3>
                    <p className="mt-0.5 text-xs tabular-nums text-muted">
                      {t("readingManagement.goalDateFrom", {
                        date: goal.starts_on,
                      })}
                      {goal.ends_on
                        ? t("readingManagement.goalDateTo", {
                            date: goal.ends_on,
                          })
                        : ""}{" "}
                      · {goal.timezone}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-sky/70 px-2 py-0.5 text-[11px] font-bold text-primary">
                    {t(`readingManagement.goalStatus.${goal.status}`)}
                  </span>
                </div>

                <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] font-semibold">
                  <span className="text-muted">
                    {t("readingManagement.goalCycleProgress")}
                  </span>
                  <span className="tabular-nums text-ink">
                    <strong>
                      {goal.current_value}/{goal.target_value}
                    </strong>{" "}
                    <span className="text-primary">
                      ({goal.progress_percent}%)
                    </span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-canvas">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200"
                    style={{
                      width: `${Math.min(100, goal.progress_percent)}%`,
                    }}
                  />
                </div>

                <GoalInsights goal={goal} />

                {editingGoalId === goal.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <input
                      aria-label={t("readingManagement.newTargetValueAria")}
                      className="h-8 min-h-8 w-24 rounded-control border border-border bg-white px-2.5 text-xs font-semibold tabular-nums text-ink focus-visible:outline-3 focus-visible:outline-primary"
                      type="number"
                      min={1}
                      value={editingTarget}
                      onChange={(e) => onChangeEditingTarget(e.target.value)}
                    />
                    <Button
                      fullWidth={false}
                      size="compact"
                      className="h-8! min-h-8! w-auto! px-2.5! py-1! text-xs!"
                      onClick={() => onSaveEditedGoal(goal)}
                      disabled={Boolean(busyKey)}
                    >
                      {t("readingManagement.save")}
                    </Button>
                    <Button
                      fullWidth={false}
                      size="compact"
                      className="h-8! min-h-8! w-auto! px-2.5! py-1! text-xs!"
                      variant="secondary"
                      onClick={onCancelEditGoal}
                    >
                      {t("readingManagement.cancel")}
                    </Button>
                  </div>
                ) : null}

                {goal.status === "ACTIVE" || goal.status === "PAUSED" ? (
                  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center">
                    <Button
                      variant="quiet"
                      size="compact"
                      className="h-8! min-h-8! w-full border border-border bg-white px-2! py-0.5! text-xs! sm:h-7! sm:min-h-7! sm:w-auto"
                      onClick={() => onStartEditGoal(goal)}
                    >
                      {t("readingManagement.editGoal")}
                    </Button>
                    {goal.status === "ACTIVE" ? (
                      <Button
                        variant="quiet"
                        size="compact"
                        className="h-8! min-h-8! w-full border border-border bg-cream px-2! py-0.5! text-xs! sm:h-7! sm:min-h-7! sm:w-auto"
                        disabled={Boolean(busyKey)}
                        onClick={() => onTransitionGoal(goal, "PAUSED")}
                      >
                        {t("readingManagement.pause")}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="compact"
                        className="h-8! min-h-8! w-full px-2! py-0.5! text-xs! sm:h-7! sm:min-h-7! sm:w-auto"
                        disabled={Boolean(busyKey)}
                        onClick={() => onTransitionGoal(goal, "ACTIVE")}
                      >
                        {t("readingManagement.resume")}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="compact"
                      className="h-8! min-h-8! w-full px-2! py-0.5! text-xs! sm:h-7! sm:min-h-7! sm:w-auto"
                      disabled={Boolean(busyKey)}
                      onClick={() => onTransitionGoal(goal, "COMPLETED")}
                    >
                      <CheckCircle2
                        aria-hidden="true"
                        className="size-3.5 shrink-0"
                      />{" "}
                      {t("readingManagement.complete")}
                    </Button>
                    <Button
                      variant="quiet"
                      size="compact"
                      className="h-8! min-h-8! w-full border border-border bg-white px-2! py-0.5! text-xs! text-muted sm:h-7! sm:min-h-7! sm:w-auto"
                      disabled={Boolean(busyKey)}
                      onClick={() => onTransitionGoal(goal, "ENDED")}
                    >
                      {t("readingManagement.end")}
                    </Button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          <PaginationBar
            ariaLabel={t("readingManagement.goalsPaginationAria")}
            className="mt-2.5"
            compact
            itemLabel={t("readingManagement.goalsPaginationItem")}
            onPageChange={onPageChange}
            page={safePage}
            pageSize={GOALS_PAGE_SIZE}
            total={goals.length}
          />
        </>
      )}

      <p className="mt-2.5 text-[11px] leading-snug text-muted">
        {t("readingManagement.goalsTimezoneRule")}
      </p>
    </section>
  );
}
