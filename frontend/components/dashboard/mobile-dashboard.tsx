"use client";

import {
  ArrowUpRight,
  BarChart3,
  Camera,
  History,
  Music2,
  Plus,
  UsersRound,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import type { RefObject } from "react";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Skeleton } from "@/components/common/skeleton";
import { FamilyReadingDesk } from "@/components/dashboard/family-reading-desk";
import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type { DashboardLatestSessionDTO } from "@/types/profile";

interface MobileDashboardProps {
  profiles: ChildProfileDTO[];
  selectedChild?: ChildProfileDTO;
  latestSessionForSelected: DashboardLatestSessionDTO | null;
  summarySource?: "dashboard-summary" | "fallback";
  isLoading: boolean;
  selectionRequired: boolean;
  invalidSelection: boolean;
  selectionSectionRef: RefObject<HTMLElement | null>;
  onSelectChild: (child: ChildProfileDTO) => void;
  onReadingAction: (
    destination: "/books" | "/book-scanner" | "/entertainment",
  ) => void;
}

export function MobileDashboard({
  profiles,
  selectedChild,
  latestSessionForSelected,
  summarySource,
  isLoading,
  selectionRequired,
  invalidSelection,
  selectionSectionRef,
  onSelectChild,
  onReadingAction,
}: MobileDashboardProps) {
  const t = useTranslations();

  return (
    <section className="flex w-full flex-col gap-5 pb-2">
      <header className="flex items-center justify-between gap-3">
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {t("parent.dashboard.familyTitle")}
        </h1>
        <Link
          href="/children"
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-white px-3.5 text-sm font-bold text-primary transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <UsersRound aria-hidden="true" size={16} />
          <span>{t("parent.dashboard.manageProfiles")}</span>
        </Link>
      </header>

      <section
        id="child-selection"
        ref={selectionSectionRef}
        tabIndex={-1}
        aria-labelledby="child-selection-title"
        aria-busy={isLoading ? "true" : undefined}
        className={cn(
          "scroll-mt-6 rounded-3xl border bg-white p-4 shadow-2xs focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
          selectionRequired
            ? "family-profiles-prompt border-warning"
            : "border-border",
        )}
      >
        <h2
          id="child-selection-title"
          className="text-lg font-extrabold text-ink"
        >
          {t("parent.dashboard.selectChildHeading")}
        </h2>
        {selectionRequired && profiles.length > 0 ? (
          <p
            role="status"
            className="mt-2 rounded-control bg-warning-surface px-3 py-2 text-sm font-semibold leading-snug text-warning"
          >
            {invalidSelection
              ? t("parent.dashboard.invalidSelectionNotice")
              : t("parent.dashboard.missingSelectionNotice")}
          </p>
        ) : null}
        {isLoading ? (
          <div
            className="mt-3 flex flex-col gap-2.5"
            aria-label={t("parent.dashboard.loadingChildrenAria")}
          >
            <span className="sr-only" role="status">
              {t("common.states.loading")}
            </span>
            <Skeleton className="h-20 w-full rounded-control" />
            <Skeleton className="h-20 w-full rounded-control" />
          </div>
        ) : profiles.length ? (
          <>
            <div className="mt-3 flex flex-col gap-2.5">
              {profiles.map((child) => (
                <ChildProfileCard
                  key={child.id}
                  child={child}
                  selected={selectedChild?.id === child.id}
                  onSelect={() => onSelectChild(child)}
                />
              ))}
            </div>
            <Link
              href="/children/new"
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-control border border-dashed border-border bg-canvas/70 px-4 text-sm font-bold text-primary transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Plus aria-hidden="true" size={16} />
              <span>{t("parent.dashboard.createChildLink")}</span>
            </Link>
          </>
        ) : (
          <p className="mt-2 text-body leading-relaxed text-muted">
            {t("parent.dashboard.emptyChildrenDescription")}
          </p>
        )}
      </section>

      <FamilyReadingDesk
        key={selectedChild?.id ?? "family"}
        child={selectedChild}
        hasProfiles={profiles.length > 0}
        isLoadingProfiles={isLoading}
        latestSession={latestSessionForSelected}
        summarySource={summarySource}
        onChooseBook={() => onReadingAction("/books")}
      />

      {!isLoading && profiles.length > 0 ? (
        <section
          aria-labelledby="reading-actions-title"
          className="flex flex-col gap-3"
        >
          <div className="flex items-center justify-between gap-3">
            <h2
              id="reading-actions-title"
              className="text-lg font-extrabold text-ink"
            >
              {t("parent.dashboard.readingActionsTitle")}
            </h2>
            <Link
              href={
                selectedChild
                  ? `/sessions?childId=${encodeURIComponent(selectedChild.id)}`
                  : "/sessions"
              }
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-2 text-sm font-bold text-primary transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <History aria-hidden="true" size={16} />
              <span>{t("parent.dashboard.readingHistoryLink")}</span>
            </Link>
          </div>
          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              aria-label={t("parent.dashboard.scanBookTitle")}
              className="flex min-h-[68px] w-full items-center gap-3.5 rounded-2xl border border-border bg-white px-4 py-3 text-start shadow-2xs transition-colors hover:border-primary/60 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onClick={() => onReadingAction("/book-scanner")}
            >
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-book-orange text-[#964623]">
                <Camera aria-hidden="true" className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-extrabold leading-snug text-ink">
                  {t("parent.dashboard.scanBookTitle")}
                </span>
                <span className="mt-0.5 block text-sm leading-snug text-muted">
                  {t("parent.dashboard.scanBookDesc")}
                </span>
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted viread-rtl-flip"
              />
            </button>
            <Link
              className="flex min-h-[68px] w-full items-center gap-3.5 rounded-2xl border border-border bg-white px-4 py-3 text-start shadow-2xs transition-colors hover:border-primary/60 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              href={
                selectedChild
                  ? `/reports?childId=${encodeURIComponent(selectedChild.id)}`
                  : "/reports"
              }
            >
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#dceffd] text-[#225c84]">
                <BarChart3 aria-hidden="true" className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-extrabold leading-snug text-ink">
                  {t("parent.dashboard.progressTitle")}
                </span>
                <span className="mt-0.5 block text-sm leading-snug text-muted">
                  {t("parent.dashboard.progressDesc")}
                </span>
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted viread-rtl-flip"
              />
            </Link>
            <Link
              className="flex min-h-[68px] w-full items-center gap-3.5 rounded-2xl border border-border bg-white px-4 py-3 text-start shadow-2xs transition-colors hover:border-primary/60 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              href={
                selectedChild
                  ? `/reports/difficult-words?childId=${encodeURIComponent(selectedChild.id)}`
                  : "/reports/difficult-words"
              }
            >
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-warning-surface text-warning">
                <Volume2 aria-hidden="true" className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-extrabold leading-snug text-ink">
                  {t("parent.dashboard.difficultWordsLink")}
                </span>
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted viread-rtl-flip"
              />
            </Link>
            <button
              type="button"
              aria-label={t("parent.dashboard.entertainmentTitle")}
              className="flex min-h-[68px] w-full items-center gap-3.5 rounded-2xl border border-border bg-white px-4 py-3 text-start shadow-2xs transition-colors hover:border-primary/60 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onClick={() => onReadingAction("/entertainment")}
            >
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#ffedab] text-[#835815]">
                <Music2 aria-hidden="true" className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-extrabold leading-snug text-ink">
                  {t("parent.dashboard.entertainmentTitle")}
                </span>
                <span className="mt-0.5 block text-sm leading-snug text-muted">
                  {t("parent.dashboard.entertainmentDesc")}
                </span>
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted viread-rtl-flip"
              />
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
