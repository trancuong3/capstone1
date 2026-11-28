"use client";

import { CalendarDays, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { PlanInsights } from "@/components/reading-management/reading-management-insights";
import { useTranslations } from "@/hooks/use-i18n";
import type {
  ReadingPlanDTO,
  ReadingPlanStatus,
} from "@/types/reading-management";
import {
  PLANS_PAGE_SIZE,
  formatWeekdaysFull,
} from "./reading-management-utils";

export interface ReadingPlansSectionProps {
  readonly plans: readonly ReadingPlanDTO[];
  readonly page: number;
  readonly onPageChange: (next: number) => void;
  readonly busyKey: string;
  readonly onAddPlan: () => void;
  readonly onEditPlan: (plan: ReadingPlanDTO) => void;
  readonly onTransitionPlan: (
    plan: ReadingPlanDTO,
    next: ReadingPlanStatus,
  ) => void;
}

export function ReadingPlansSection({
  plans,
  page,
  onPageChange,
  busyKey,
  onAddPlan,
  onEditPlan,
  onTransitionPlan,
}: ReadingPlansSectionProps) {
  const t = useTranslations("reports");
  const totalPages = Math.max(1, Math.ceil(plans.length / PLANS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visiblePlans = plans.slice(
    (safePage - 1) * PLANS_PAGE_SIZE,
    safePage * PLANS_PAGE_SIZE,
  );

  return (
    <section
      aria-label={t("readingManagement.plansSectionAria")}
      className="min-w-0 rounded-card border border-border bg-white p-3.5"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky/70 text-primary"
          >
            <CalendarDays className="size-4" />
          </span>
          <h2 className="min-w-0 break-words text-sm font-extrabold leading-snug text-ink sm:text-base">
            {t("readingManagement.plansTitle")}
          </h2>
          <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-xs font-bold tabular-nums text-muted">
            {plans.length}
          </span>
        </div>
        <Button
          fullWidth={false}
          size="compact"
          variant="secondary"
          className="h-8! min-h-8! shrink-0 whitespace-nowrap px-2.5! py-1! text-xs!"
          onClick={onAddPlan}
        >
          {t("readingManagement.addPlan")}
        </Button>
      </div>

      {plans.length === 0 ? (
        <div className="mt-2 rounded-control border border-dashed border-border/80 bg-canvas/50 px-3 py-3 text-center">
          <p className="text-sm font-semibold text-ink">
            {t("readingManagement.plansEmptyTitle")}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {t("readingManagement.plansEmptyDesc")}
          </p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-border/70">
            {visiblePlans.map((plan) => (
              <article
                key={plan.id}
                data-plan-id={plan.id}
                className="min-w-0 py-2.5 first:pt-1 last:pb-0.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-sm font-bold leading-snug text-ink">
                      {plan.title}
                    </h3>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
                      <span>
                        {formatWeekdaysFull(plan.weekdays, t)} ·{" "}
                        {t("readingManagement.planMinutesPerSession", {
                          minutes: plan.target_minutes,
                        })}
                      </span>
                      {plan.book_title ? (
                        <span className="min-w-0 break-words">
                          ·{" "}
                          {t("readingManagement.bookPrefix", {
                            title: "",
                          }).trimEnd()}{" "}
                          <span
                            className="viread-learning-content font-medium text-ink"
                            dir="ltr"
                            lang="vi"
                          >
                            {plan.book_title}
                          </span>
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-sky/70 px-2 py-0.5 text-[11px] font-bold text-primary">
                    {t(`readingManagement.planStatus.${plan.status}`)}
                  </span>
                </div>

                <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] font-semibold">
                  <span className="text-muted">
                    {t("readingManagement.planCompletedDaysLabel")}
                  </span>
                  <span className="tabular-nums text-ink">
                    <strong>
                      {plan.completed_days_this_week}/
                      {plan.scheduled_days_this_week}
                    </strong>{" "}
                    <span className="text-primary">
                      ({plan.progress_percent}%)
                    </span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-canvas">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200"
                    style={{
                      width: `${Math.min(100, plan.progress_percent)}%`,
                    }}
                  />
                </div>

                <PlanInsights plan={plan} />

                {plan.status === "ACTIVE" || plan.status === "PAUSED" ? (
                  <div className="mt-2 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center">
                    <Button
                      variant="quiet"
                      size="compact"
                      className="h-8! min-h-8! w-full border border-border bg-white px-2! py-0.5! text-xs! sm:h-7! sm:min-h-7! sm:w-auto"
                      onClick={() => onEditPlan(plan)}
                    >
                      {t("readingManagement.edit")}
                    </Button>
                    {plan.status === "ACTIVE" ? (
                      <Button
                        variant="quiet"
                        size="compact"
                        className="h-8! min-h-8! w-full border border-border bg-cream px-2! py-0.5! text-xs! sm:h-7! sm:min-h-7! sm:w-auto"
                        disabled={Boolean(busyKey)}
                        onClick={() => onTransitionPlan(plan, "PAUSED")}
                      >
                        {t("readingManagement.pause")}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="compact"
                        className="h-8! min-h-8! w-full px-2! py-0.5! text-xs! sm:h-7! sm:min-h-7! sm:w-auto"
                        disabled={Boolean(busyKey)}
                        onClick={() => onTransitionPlan(plan, "ACTIVE")}
                      >
                        {t("readingManagement.resume")}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="compact"
                      className="h-8! min-h-8! w-full px-2! py-0.5! text-xs! sm:h-7! sm:min-h-7! sm:w-auto"
                      disabled={Boolean(busyKey)}
                      onClick={() => onTransitionPlan(plan, "COMPLETED")}
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
                      onClick={() => onTransitionPlan(plan, "ENDED")}
                    >
                      {t("readingManagement.end")}
                    </Button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          <PaginationBar
            ariaLabel={t("readingManagement.plansPaginationAria")}
            className="mt-2.5"
            compact
            itemLabel={t("readingManagement.plansPaginationItem")}
            onPageChange={onPageChange}
            page={safePage}
            pageSize={PLANS_PAGE_SIZE}
            total={plans.length}
          />
        </>
      )}
    </section>
  );
}
