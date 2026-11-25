import { ChevronRight, Clock3 } from "lucide-react";
import Link from "next/link";

import {
  formatHistoryTime,
  getHistoryStatePresentation,
} from "@/lib/utils/report-mappers";
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
  const stateStyle = getHistoryStatePresentation(item.session.state);
  const timeLabel = formatHistoryTime(item.session.started_at);
  const href = `/sessions/${item.session.id}?childId=${encodeURIComponent(item.child.id)}&page=${page}`;

  return (
    <article className="history-entry group relative transition-colors hover:bg-cream/80 focus-within:bg-cream/80">
      <div className="flex items-center justify-between gap-3 sm:gap-5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-base font-extrabold leading-snug text-ink sm:text-lg">
              {item.book.title}
            </h3>
            <span
              className={`inline-flex shrink-0 items-center rounded-control px-2.5 py-0.5 text-xs font-bold ${stateStyle.badgeClassName}`}
              data-session-state={item.session.state}
              data-state-tone={stateStyle.tone}
            >
              {stateStyle.label}
            </span>
          </div>

          <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold text-muted sm:text-sm">
            {showChildAlias ? (
              <div>
                <dt className="sr-only">Hồ sơ bé</dt>
                <dd>{item.child.alias}</dd>
              </div>
            ) : null}
            <div className="flex items-center gap-1.5">
              <dt className="sr-only">Bắt đầu</dt>
              <dd>
                <time
                  className="tabular-nums"
                  dateTime={item.session.started_at}
                  title={item.started_label}
                >
                  {timeLabel}
                </time>
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock3 aria-hidden="true" className="size-3.5 shrink-0" />
              <dt className="sr-only">Thời lượng</dt>
              <dd className="tabular-nums">{item.duration_label}</dd>
            </div>
          </dl>
        </div>

        <Link
          className="inline-flex min-h-12 shrink-0 items-center gap-1 rounded-control px-3 text-sm font-bold text-primary transition-colors group-hover:text-primary-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary after:absolute after:inset-0"
          href={href}
        >
          <span className="sr-only sm:not-sr-only">Xem chi tiết</span>
          <ChevronRight
            aria-hidden="true"
            className="size-5 shrink-0 transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      </div>
    </article>
  );
}
