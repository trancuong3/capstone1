"use client";

import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Clock3,
  PauseCircle,
} from "lucide-react";
import Link from "next/link";

import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { getHistoryStatePresentation } from "@/lib/utils/report-mappers";
import { REPORT_TIMEZONE } from "@/lib/utils/report-state";
import type { SessionHistoryItemViewModelUI } from "@/types/reports";

interface SessionHistoryItemProps {
  readonly item: SessionHistoryItemViewModelUI;
  readonly page?: number;
  readonly showChildAlias?: boolean;
}

export function SessionHistoryItem({
  item,
  page = 1,
  showChildAlias = false,
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

  const isCompleted = item.session.state === "FINISHED";
  const isPausedOrStopped =
    item.session.state === "PAUSED" || item.session.state === "ABORTED";

  const statusAccentClass = isCompleted
    ? "bg-success-surface text-success-ink"
    : isPausedOrStopped
      ? "bg-surface-subtle text-muted"
      : "bg-warning-surface text-warning";

  const StatusIcon = isCompleted
    ? CheckCircle2
    : isPausedOrStopped
      ? PauseCircle
      : BookOpen;

  return (
    <article className="history-entry group relative px-3.5! py-2.5! transition-colors hover:bg-cream/80 focus-within:bg-cream/80 sm:py-2!">
      <div className="flex items-center justify-between gap-2.5 sm:gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5 sm:items-center">
          <span
            aria-hidden="true"
            className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full sm:mt-0 ${statusAccentClass}`}
          >
            <StatusIcon className="size-3.5" strokeWidth={2.2} />
          </span>

          <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap">
              <h3
                className="viread-learning-content min-w-0 break-words text-sm font-bold leading-snug text-ink sm:truncate"
                dir="ltr"
                lang="vi"
                title={item.book.title}
              >
                {item.book.title}
              </h3>
              <span
                className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-bold leading-tight ${stateStyle.badgeClassName}`}
                data-session-state={item.session.state}
                data-state-tone={stateStyle.tone}
              >
                {stateLabel}
              </span>
            </div>

            <dl className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-semibold text-muted">
              {showChildAlias ? (
                <div>
                  <dt className="sr-only">{t("sessions.item.childSr")}</dt>
                  <dd>{item.child.alias}</dd>
                </div>
              ) : null}
              <div className="flex items-center gap-1">
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
              <div className="flex items-center gap-1">
                <Clock3 aria-hidden="true" className="size-3 shrink-0" />
                <dt className="sr-only">{t("sessions.item.durationSr")}</dt>
                <dd className="tabular-nums">{durationLabel}</dd>
              </div>
            </dl>
          </div>
        </div>

        <Link
          className="inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-control px-2 text-xs font-bold text-primary transition-colors group-hover:text-primary-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary after:absolute after:inset-0 sm:min-h-9 sm:px-2.5"
          href={href}
        >
          <span className="sr-only sm:not-sr-only">
            {t("sessions.item.viewDetail")}
          </span>
          <ChevronRight
            aria-hidden="true"
            className="viread-rtl-flip size-4 shrink-0 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5"
          />
        </Link>
      </div>
    </article>
  );
}
