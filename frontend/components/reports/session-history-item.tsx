import { CalendarDays, Clock3 } from "lucide-react";
import Link from "next/link";

import type { SessionHistoryItemViewModelUI } from "@/types/reports";

interface SessionHistoryItemProps {
  readonly item: SessionHistoryItemViewModelUI;
  readonly page?: number;
}

export function SessionHistoryItem({
  item,
  page = 1,
}: SessionHistoryItemProps) {
  return (
    <article className="history-entry">
      <div className="history-entry-inner flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-words text-2xl font-semibold leading-tight text-ink">
              {item.book.title}
            </h2>
            <span className="rounded-full bg-success-surface px-3 py-1 text-label font-semibold text-success-ink">
              {item.state_label}
            </span>
          </div>
          <p className="mt-1 text-label text-muted">{item.child.alias}</p>
          <dl className="mt-3 flex flex-col gap-2 text-label text-muted sm:flex-row sm:gap-5">
            <div className="flex items-center gap-2">
              <CalendarDays aria-hidden="true" className="size-4" />
              <dt className="sr-only">Bắt đầu</dt>
              <dd>{item.started_label}</dd>
            </div>
            <div className="flex items-center gap-2">
              <Clock3 aria-hidden="true" className="size-4" />
              <dt className="sr-only">Thời lượng</dt>
              <dd>{item.duration_label}</dd>
            </div>
          </dl>
        </div>
        <Link
          className="inline-flex w-full sm:w-auto min-h-12 items-center justify-center rounded-control bg-sky px-5 text-label font-semibold text-primary-hover hover:bg-border focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
          href={`/sessions/${item.session.id}?childId=${encodeURIComponent(item.child.id)}&page=${page}`}
        >
          Xem chi tiết
        </Link>
      </div>
    </article>
  );
}
