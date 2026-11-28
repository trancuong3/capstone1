"use client";

import { ArrowLeft, Mic, Sparkles, Volume2 } from "lucide-react";
import { useId } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { ChildSelector } from "@/components/reports/child-selector";
import { DifficultWordBookCard } from "@/components/reports/difficult-word-book-card";
import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DifficultWordBookGroup,
  DifficultWordDTO,
  DifficultWordPracticeStatus,
} from "@/types/reports";

type StatusFilterValue = "ALL" | DifficultWordPracticeStatus;

interface MobileDifficultWordsListProps {
  readonly child: ChildProfileDTO;
  readonly childrenProfiles: readonly ChildProfileDTO[];
  readonly periodDays: number;
  readonly onPeriodDaysChange: (days: number) => void;
  readonly statusFilter: StatusFilterValue;
  readonly onStatusFilterChange: (next: StatusFilterValue) => void;
  readonly words: readonly DifficultWordDTO[];
  readonly filteredWords: readonly DifficultWordDTO[];
  readonly bookGroups: readonly DifficultWordBookGroup[];
  readonly bookGroupPage: number;
  readonly bookGroupsPageSize: number;
  readonly onBookGroupPageChange: (page: number) => void;
  readonly summaryStats: {
    readonly total: number;
    readonly completed: number;
    readonly remaining: number;
    readonly percent: number;
  };
  readonly firstPendingGlobalWord: DifficultWordDTO | null;
  readonly onOpenPracticeSession: (
    word: string,
    bookKey: string | null,
    autoStart: boolean,
  ) => void;
}

const QUICK_FILTERS = [
  { value: "ALL", key: "screen.quickAll" },
  { value: "NOT_PRACTICED", key: "screen.quickNotPracticed" },
  { value: "IN_PROGRESS", key: "screen.quickInProgress" },
  { value: "NEEDS_MORE_PRACTICE", key: "screen.quickNeedsMore" },
  { value: "COMPLETED", key: "screen.quickCompleted" },
] as const;

export function MobileDifficultWordsList({
  child,
  childrenProfiles,
  periodDays,
  onPeriodDaysChange,
  statusFilter,
  onStatusFilterChange,
  words,
  filteredWords,
  bookGroups,
  bookGroupPage,
  bookGroupsPageSize,
  onBookGroupPageChange,
  summaryStats,
  firstPendingGlobalWord,
  onOpenPracticeSession,
}: MobileDifficultWordsListProps) {
  const t = useTranslations("difficultWords");
  const periodSelectId = useId();

  return (
    <section className="flex w-full flex-col gap-4 pb-2">
      <header className="flex flex-col gap-2.5">
        <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
          {t("screen.eyebrow")}
        </span>
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {t("screen.headerTitle", { alias: child.alias })}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("screen.headerDescription", { days: periodDays })}
        </p>
        <ButtonLink
          fullWidth={false}
          href={`/reports?childId=${encodeURIComponent(child.id)}`}
          size="touch"
          variant="secondary"
        >
          <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
          {t("screen.backToReports")}
        </ButtonLink>
      </header>

      <div className="flex flex-col gap-3 rounded-3xl border border-border bg-white p-4 shadow-2xs">
        <ChildSelector
          childrenProfiles={childrenProfiles}
          clearQueryKeys={["word"]}
          selectedChildId={child.id}
        />

        <div className="min-w-0">
          <label
            className="mb-1.5 block text-xs font-bold text-muted"
            htmlFor={periodSelectId}
          >
            {t("screen.periodLabel")}
          </label>
          <select
            aria-label={t("screen.periodAria")}
            className="min-h-12 w-full cursor-pointer rounded-control border border-border bg-white px-3.5 text-sm font-bold text-ink outline-none focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            id={periodSelectId}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              if (Number.isSafeInteger(parsed) && parsed > 0) {
                onPeriodDaysChange(parsed);
              }
            }}
            value={String(periodDays)}
          >
            <option value="30">{t("screen.periodOption", { days: 30 })}</option>
            <option value="90">{t("screen.periodOption", { days: 90 })}</option>
            <option value="180">
              {t("screen.periodOption", { days: 180 })}
            </option>
          </select>
        </div>

        <div
          aria-label={t("screen.quickFilterAria")}
          className="flex items-center gap-2 overflow-x-auto pb-0.5 no-scrollbar [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="group"
        >
          {QUICK_FILTERS.map((pill) => {
            const active = statusFilter === pill.value;
            return (
              <button
                aria-pressed={active}
                className={cn(
                  "min-h-11 shrink-0 whitespace-nowrap rounded-full border px-3.5 py-2 text-xs font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  active
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-canvas text-ink hover:bg-sky/50",
                )}
                key={pill.value}
                onClick={() => onStatusFilterChange(pill.value)}
                type="button"
              >
                {t(pill.key)}
              </button>
            );
          })}
        </div>
      </div>

      {words.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-3xl border border-border bg-gradient-to-b from-sky/55 via-cream to-white p-4 shadow-2xs">
          <div className="flex flex-col gap-1">
            <div className="inline-flex items-center gap-2 text-xs font-extrabold text-primary">
              <Sparkles aria-hidden="true" className="size-4" />
              {t("screen.progressTitle", { alias: child.alias })}
            </div>
            <p className="text-base font-extrabold text-ink">
              {t("screen.progressCount", {
                completed: summaryStats.completed,
                total: summaryStats.total,
                percent: summaryStats.percent,
              })}
            </p>
            <p className="text-xs leading-relaxed text-muted">
              {t("screen.progressHint")}
            </p>
          </div>
          {firstPendingGlobalWord ? (
            <Button
              onClick={() =>
                onOpenPracticeSession(
                  firstPendingGlobalWord.normalized_word,
                  null,
                  true,
                )
              }
              size="compact"
            >
              <Mic aria-hidden="true" className="size-5" />
              {summaryStats.remaining > 0
                ? t("screen.practiceRemainingAction", {
                    count: summaryStats.remaining,
                  })
                : t("screen.reviewCompletedAction")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {words.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink
              href={`/books?childId=${encodeURIComponent(child.id)}`}
              size="touch"
            >
              {t("screen.continueReadingAction")}
            </ButtonLink>
          }
          description={t("screen.emptyDescription")}
          icon={<Volume2 aria-hidden="true" className="size-10 text-primary" />}
          title={t("screen.emptyTitle")}
        />
      ) : filteredWords.length === 0 ? (
        <EmptyState
          action={
            <Button
              fullWidth={false}
              onClick={() => onStatusFilterChange("ALL")}
              size="touch"
              variant="secondary"
            >
              {t("screen.viewAllWords", { count: words.length })}
            </Button>
          }
          description={t("screen.emptyFilterDescription")}
          icon={<Volume2 aria-hidden="true" className="size-10 text-primary" />}
          title={t("screen.emptyFilterTitle")}
        />
      ) : (
        <>
          <div className="flex flex-col gap-3.5">
            {bookGroups
              .slice(
                (bookGroupPage - 1) * bookGroupsPageSize,
                bookGroupPage * bookGroupsPageSize,
              )
              .map((group) => (
                <DifficultWordBookCard
                  group={group}
                  key={group.key}
                  onSelectWord={(target) =>
                    onOpenPracticeSession(
                      target.normalized_word,
                      group.key,
                      true,
                    )
                  }
                  onStartBookPractice={(target) =>
                    onOpenPracticeSession(
                      target.normalized_word,
                      group.key,
                      true,
                    )
                  }
                />
              ))}
          </div>
          <PaginationBar
            ariaLabel={t("screen.paginationAria")}
            itemLabel={t("screen.paginationItemLabel")}
            onPageChange={onBookGroupPageChange}
            page={bookGroupPage}
            pageSize={bookGroupsPageSize}
            total={bookGroups.length}
          />
        </>
      )}
    </section>
  );
}
