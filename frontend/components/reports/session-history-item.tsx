"use client";

import { ChevronRight, Clock3 } from "lucide-react";
import Link from "next/link";

import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { getHistoryStatePresentation } from "@/lib/utils/report-mappers";
import { REPORT_TIMEZONE } from "@/lib/utils/report-state";
import type { SessionHistoryItemViewModelUI } from "@/types/reports";

interface SessionHistoryItemProps {
  readonly item: SessionHistoryItemViewModelUI;
  readonly page?: number;
  readonly showChildAlias?: boolean;
  readonly variant?: "desktop-row" | "mobile-card";
}

export function SessionHistoryItem({
  item,
  page = 1,
  showChildAlias = false,
  variant = "desktop-row",
}: SessionHistoryItemProps) {
  const { formatDateTime, formatTime } = useI18n();
  const t = useTranslations("reports");
  const stateStyle = getHistoryStatePresentation(item.session.state);
  const stateLabel = t(`sessions.states.${item.session.state}`);
  const timeLabel = formatTime(item.session.started_at, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: REPORT_TIMEZONE,
  });
  const startedLabel = formatDateTime(item.session.started_at, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: REPORT_TIMEZONE,
  });
  const durationLabel = (() => {
    const durationMs = item.session.duration_ms;
    if (durationMs === null) return t("sessions.durationNoData");
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    if (totalSeconds < 60) {
      return t("sessions.durationSeconds", { seconds: totalSeconds });
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0
      ? t("sessions.durationMinutes", { minutes })
      : t("sessions.durationMinutesSeconds", { minutes, seconds });
  })();
  const href = `/sessions/${item.session.id}?childId=${encodeURIComponent(item.child.id)}&page=${page}`;
  const isMobileCard = variant === "mobile-card";

  return (
    <article
      className={
        isMobileCard
          ? "group relative rounded-2xl border border-border bg-white p-4 shadow-2xs transition-colors hover:bg-cream/80 focus-within:bg-cream/80"
          : "history-entry group relative transition-colors hover:bg-cream/80 focus-within:bg-cream/80"
      }
    >
      <div className="flex items-center justify-between gap-3 sm:gap-5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className="viread-learning-content break-words text-base font-extrabold leading-snug text-ink sm:text-lg"
              dir="ltr"
              lang="vi"
            >
              {item.book.title}
            </h3>
            <span
              className={`inline-flex shrink-0 items-center rounded-control px-2.5 py-0.5 text-xs font-bold ${stateStyle.badgeClassName}`}
              data-session-state={item.session.state}
              data-state-tone={stateStyle.tone}
            >
              {stateLabel}
            </span>
          </div>

          <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold text-muted sm:text-sm">
            {showChildAlias ? (
              <div>
                <dt className="sr-only">{t("sessions.item.childSr")}</dt>
                <dd>{item.child.alias}</dd>
              </div>
            ) : null}
            <div className="flex items-center gap-1.5">
              <dt className="sr-only">{t("sessions.item.startedSr")}</dt>
              <dd>
                <time
                  className="tabular-nums"
                  dateTime={item.session.started_at}
                  title={startedLabel}
                >
                  {timeLabel}
                </time>
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock3 aria-hidden="true" className="size-3.5 shrink-0" />
              <dt className="sr-only">{t("sessions.item.durationSr")}</dt>
              <dd className="tabular-nums">{durationLabel}</dd>
            </div>
          </dl>
        </div>

        <Link
          className={
            isMobileCard
              ? "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control px-2.5 text-sm font-bold text-primary transition-colors group-hover:text-primary-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary after:absolute after:inset-0"
              : "inline-flex min-h-12 min-w-11 shrink-0 items-center gap-1 rounded-control px-3 text-sm font-bold text-primary transition-colors group-hover:text-primary-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary after:absolute after:inset-0"
          }
          href={href}
        >
          <span className={isMobileCard ? "sr-only" : "sr-only sm:not-sr-only"}>
            {t("sessions.item.viewDetail")}
          </span>
          <ChevronRight
            aria-hidden="true"
            className="viread-rtl-flip size-5 shrink-0 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5"
          />
        </Link>
      </div>
    </article>
  );
}
