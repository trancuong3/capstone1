"use client";

import { ArrowLeft } from "lucide-react";

import { ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";

interface MobileSummaryItem {
  readonly label: string;
  readonly value: string;
  readonly isMissing: boolean;
}

interface MobileSessionDetailProps {
  readonly returnHref: string;
  readonly stateBadgeClassName: string;
  readonly stateLabel: string;
  readonly rangeIsPartial: boolean;
  readonly pageTitle: string;
  readonly bookTitle: string;
  readonly childAlias: string;
  readonly startedAtLabel: string;
  readonly endedAtLabel: string;
  readonly sessionState: string;
  readonly endedAtIsNull: boolean;
  readonly selectedRangePages: number | null | undefined;
  readonly pagesCompleted: number | null | undefined;
  readonly fluencyPartialOrUnsupported: boolean;
  readonly summaryItems: readonly MobileSummaryItem[];
}

export function MobileSessionDetail({
  returnHref,
  stateBadgeClassName,
  stateLabel,
  rangeIsPartial,
  pageTitle,
  bookTitle,
  childAlias,
  startedAtLabel,
  endedAtLabel,
  sessionState,
  endedAtIsNull,
  selectedRangePages,
  pagesCompleted,
  fluencyPartialOrUnsupported,
  summaryItems,
}: MobileSessionDetailProps) {
  const t = useTranslations("reports");

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <ButtonLink
          className="rounded-full border border-border"
          fullWidth={false}
          href={returnHref}
          size="touch"
          variant="secondary"
        >
          <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
          {t("sessions.detail.historyLink")}
        </ButtonLink>
      </div>

      <header className="flex flex-col gap-2.5 rounded-3xl border border-border bg-gradient-to-b from-sky/55 via-cream to-white p-4 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-control px-2.5 py-0.5 text-xs font-bold ${stateBadgeClassName}`}
          >
            {stateLabel}
          </span>
          {rangeIsPartial ? (
            <span className="inline-flex items-center rounded-control border border-warning/25 bg-warning-surface px-2.5 py-0.5 text-xs font-bold text-warning">
              {t("sessions.detail.partialCompleteBadge")}
            </span>
          ) : null}
        </div>
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {pageTitle}
        </h1>
        <p className="text-sm font-bold text-ink">
          <span className="viread-learning-content" dir="ltr" lang="vi">
            {bookTitle}
          </span>
          <span className="font-semibold text-muted"> · {childAlias}</span>
        </p>
        <dl className="grid grid-cols-2 gap-2 pt-1 text-xs">
          <div className="rounded-2xl border border-border bg-white/90 px-3 py-2">
            <dt className="font-bold text-muted">
              {t("sessions.detail.startedLabel")}
            </dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-ink">
              {startedAtLabel}
            </dd>
          </div>
          <div className="rounded-2xl border border-border bg-white/90 px-3 py-2">
            <dt className="font-bold text-muted">
              {t("sessions.detail.endedLabel")}
            </dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-ink">
              {endedAtLabel}
            </dd>
          </div>
        </dl>
      </header>

      {rangeIsPartial ? (
        <StatusMessage
          compact
          title={t("sessions.detail.partialRangeTitle")}
          tone="info"
        >
          {t("sessions.detail.partialRangeDesc", {
            total: selectedRangePages ?? 0,
            completed: pagesCompleted ?? 0,
          })}
        </StatusMessage>
      ) : null}

      {sessionState !== "FINISHED" && sessionState !== "ABORTED" ? (
        <StatusMessage
          compact
          title={t("sessions.detail.incompleteDataTitle")}
          tone="warning"
        >
          {t("sessions.detail.inProgressDesc")}
        </StatusMessage>
      ) : null}

      {sessionState === "FINISHED" && endedAtIsNull ? (
        <StatusMessage compact tone="info">
          {t("sessions.detail.missingEndTimeDesc")}
        </StatusMessage>
      ) : null}

      <section
        aria-labelledby="session-overview-heading"
        className="flex flex-col gap-3 rounded-3xl border border-border bg-white p-4 shadow-2xs"
      >
        <h2
          className="text-lg font-extrabold text-ink"
          id="session-overview-heading"
        >
          {t("sessions.detail.summaryTitle")}
        </h2>

        {fluencyPartialOrUnsupported ? (
          <StatusMessage compact tone="info">
            {t("sessions.detail.summaryPartialDesc")}
          </StatusMessage>
        ) : null}

        <dl className="grid grid-cols-2 gap-2.5">
          {summaryItems.map(({ label, value, isMissing }) => (
            <div
              className="min-w-0 rounded-2xl border border-border bg-canvas/60 p-3.5"
              key={label}
            >
              <dt className="break-words text-xs font-bold text-muted">
                {label}
              </dt>
              <dd
                className={
                  isMissing
                    ? "mt-1 break-words text-sm font-semibold text-muted"
                    : "mt-1 break-words text-xl font-extrabold leading-snug tabular-nums text-primary"
                }
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
