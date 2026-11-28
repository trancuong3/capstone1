"use client";

import { BarChart3, History } from "lucide-react";

import { ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { ChildSelector } from "@/components/reports/child-selector";
import { SessionHistoryItem } from "@/components/reports/session-history-item";
import { useTranslations } from "@/hooks/use-i18n";
import type { ChildProfileDTO } from "@/types/child";
import type { SessionHistoryItemViewModelUI } from "@/types/reports";

interface DayGroup {
  readonly dayKey: string;
  readonly heading: string;
  readonly items: readonly SessionHistoryItemViewModelUI[];
}

interface MobileSessionHistoryProps {
  readonly child: ChildProfileDTO;
  readonly childrenProfiles: readonly ChildProfileDTO[];
  readonly items: readonly SessionHistoryItemViewModelUI[];
  readonly dayGroups: readonly DayGroup[];
  readonly formatGroupHeading: (
    dayKey: string,
    defaultHeading: string,
  ) => string;
  readonly currentPage: number;
  readonly nextPage: number | null;
}

export function MobileSessionHistory({
  child,
  childrenProfiles,
  items,
  dayGroups,
  formatGroupHeading,
  currentPage,
  nextPage,
}: MobileSessionHistoryProps) {
  const t = useTranslations("reports");
  const childQuery = `childId=${encodeURIComponent(child.id)}`;

  return (
    <section className="flex w-full flex-col gap-4 pb-2">
      <header className="flex flex-col gap-2.5">
        <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
          {t("sessions.historyEyebrow", {
            alias: child.alias,
            grade: child.grade,
          })}
        </span>
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {t("sessions.title")}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("sessions.historyDescription")}
        </p>
        <ButtonLink
          href={`/reports?${childQuery}`}
          size="touch"
          variant="secondary"
        >
          <BarChart3 aria-hidden="true" className="size-4" />
          {t("sessions.viewProgressAction")}
        </ButtonLink>
      </header>

      <div className="flex flex-col gap-2.5 rounded-3xl border border-border bg-white p-4 shadow-2xs">
        <ChildSelector
          childrenProfiles={childrenProfiles}
          selectedChildId={child.id}
        />
        {items.length > 0 ? (
          <p className="text-xs font-semibold text-muted tabular-nums">
            {t("sessions.showingPageSummary", {
              count: items.length,
              page: currentPage,
            })}
          </p>
        ) : null}
      </div>

      {items.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink href={`/books?${childQuery}`} size="touch">
              {t("sessions.chooseBookAction")}
            </ButtonLink>
          }
          description={t("sessions.emptyHistoryDesc")}
          icon={<History aria-hidden="true" className="size-10 text-primary" />}
          title={
            currentPage > 1
              ? t("sessions.emptyPageTitle")
              : t("sessions.emptyHistoryTitle")
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {dayGroups.map((group) => (
            <section
              aria-labelledby={`history-day-${group.dayKey}`}
              className="flex flex-col gap-2.5"
              key={group.dayKey}
            >
              <div className="flex items-baseline justify-between gap-2 px-1">
                <h2
                  className="text-sm font-extrabold text-ink"
                  id={`history-day-${group.dayKey}`}
                >
                  {formatGroupHeading(group.dayKey, group.heading)}
                </h2>
                <span className="text-xs font-semibold text-muted tabular-nums">
                  {t("sessions.groupCount", { count: group.items.length })}
                </span>
              </div>
              <div className="flex flex-col gap-2.5">
                {group.items.map((item) => (
                  <SessionHistoryItem
                    item={item}
                    key={item.session.id}
                    page={currentPage}
                    variant="mobile-card"
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {currentPage > 1 || nextPage !== null ? (
        <nav
          aria-label={t("sessions.paginationAria")}
          className="flex flex-col gap-2.5 rounded-3xl border border-border bg-white p-4 shadow-2xs"
        >
          <span
            aria-current="page"
            className="text-center text-sm font-bold text-muted tabular-nums"
          >
            {t("sessions.readingReports.pageLabel", { page: currentPage })}
          </span>
          <div className="flex flex-col-reverse gap-2.5">
            {currentPage > 1 ? (
              <ButtonLink
                href={`/sessions?${childQuery}&page=${currentPage - 1}`}
                size="touch"
                variant="secondary"
              >
                {t("sessions.previousPage")}
              </ButtonLink>
            ) : null}
            {nextPage !== null ? (
              <ButtonLink
                href={`/sessions?${childQuery}&page=${nextPage}`}
                size="touch"
              >
                {t("sessions.nextPage")}
              </ButtonLink>
            ) : null}
          </div>
        </nav>
      ) : null}
    </section>
  );
}
