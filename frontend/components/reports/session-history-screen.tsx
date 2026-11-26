"use client";

import { BarChart3, History, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { ChildSelector } from "@/components/reports/child-selector";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { SessionHistoryItem } from "@/components/reports/session-history-item";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import { getLocaleMetadata } from "@/lib/i18n/locales";
import {
  groupSessionHistoryByDay,
  historyDayKey,
  historyPageFromCursor,
  mapSessionHistoryItem,
} from "@/lib/utils/report-mappers";
import { REPORT_TIMEZONE } from "@/lib/utils/report-state";
import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type { SessionHistoryItemViewModelUI } from "@/types/reports";

type ScreenState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly children: readonly ChildProfileDTO[];
      readonly child: ChildProfileDTO;
      readonly items: readonly SessionHistoryItemViewModelUI[];
      readonly nextCursor: string | null;
    }
  | { readonly status: "no-children" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" }
  | { readonly status: "error" };

interface SessionHistoryScreenProps {
  readonly page: number;
  readonly requestedChildId?: string;
}

export function SessionHistoryScreen({
  page,
  requestedChildId,
}: SessionHistoryScreenProps) {
  const { formatDate, locale } = useI18n();
  const t = useTranslations("reports");
  const { childService, sessionService } = useReportServices();
  const currentPage =
    Number.isSafeInteger(page) && page >= 1 && page <= 100000 ? page : 1;
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ScreenState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const children = await childService.list();
        if (children.length === 0) {
          if (active) setState({ status: "no-children" });
          return;
        }
        const matchedChild = requestedChildId
          ? children.find((item) => item.id === requestedChildId)
          : children[0];
        const child = matchedChild
          ? matchedChild
          : await childService.get(requestedChildId!);
        const history = await sessionService.list(child.id, {
          cursor: currentPage > 1 ? `page-${currentPage}` : undefined,
          limit: 10,
        });

        // Deduplicate historical book metadata requests per unique book_id on
        // the current page so repeated reads of the same book issue one request.
        const bookPromises = new Map<string, Promise<BookDetailDTO>>();
        const items = await Promise.all(
          history.sessions.map(async (session) => {
            let bookPromise = bookPromises.get(session.book_id);
            if (!bookPromise) {
              bookPromise = sessionService.getBook(session.id);
              bookPromises.set(session.book_id, bookPromise);
            }
            const book = await bookPromise;
            if (book.id !== session.book_id)
              throw new Error("Invalid historical book response");
            return mapSessionHistoryItem(session, child, book);
          }),
        );
        if (active) {
          setState({
            status: "ready",
            children,
            child,
            items,
            nextCursor: history.next_cursor,
          });
        }
      } catch (error) {
        if (active) {
          setState({
            status:
              isServiceError(error) && error.status === 404
                ? "not-found"
                : isServiceError(error) &&
                    (error.status === 501 || error.status === 503)
                  ? "unavailable"
                  : "error",
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [childService, currentPage, requestKey, requestedChildId, sessionService]);

  if (state.status === "loading") {
    return (
      <section
        aria-busy="true"
        aria-label={t("sessions.loadingHistoryAria")}
        className="mx-auto flex w-full max-w-[1120px] flex-col gap-5"
      >
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-16 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </section>
    );
  }

  if (state.status === "no-children") {
    return (
      <EmptyState
        headingLevel={1}
        action={
          <ButtonLink href="/children/new">
            {t("sessions.createChildAction")}
          </ButtonLink>
        }
        description={t("sessions.noChildDesc")}
        icon={<History aria-hidden="true" className="size-10 text-primary" />}
        title={t("sessions.noChildTitle")}
      />
    );
  }

  if (state.status === "unavailable")
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          {t("sessions.pendingDataTitle")}
        </h1>
        <StatusMessage tone="info">
          {t("sessions.pendingHistoryDesc")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />{" "}
          {t("sessions.retry")}
        </Button>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/children"
          variant="secondary"
        >
          {t("sessions.manageChildren")}
        </ButtonLink>
      </section>
    );

  if (state.status === "not-found") {
    return (
      <StatusMessage title={t("sessions.notFoundTitle")} tone="error">
        {t("sessions.notFoundDesc")}
      </StatusMessage>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <StatusMessage title={t("sessions.loadErrorTitle")} tone="error">
          {t("sessions.loadErrorDesc")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {t("sessions.retry")}
        </Button>
      </div>
    );
  }

  const childQuery = `childId=${encodeURIComponent(state.child.id)}`;
  const nextPage =
    state.nextCursor === null ? null : historyPageFromCursor(state.nextCursor);
  const dayGroups = groupSessionHistoryByDay(state.items);
  const todayKey = historyDayKey(new Date());
  const todayUtcNoon = new Date(`${todayKey}T12:00:00.000Z`);
  todayUtcNoon.setUTCDate(todayUtcNoon.getUTCDate() - 1);
  const yesterdayKey = todayUtcNoon.toISOString().slice(0, 10);
  const currentYear = Number(todayKey.slice(0, 4));
  const formatGroupHeading = (dayKey: string, defaultHeading: string) => {
    if (locale === "vi") return defaultHeading;
    try {
      const rtf = new Intl.RelativeTimeFormat(getLocaleMetadata(locale).bcp47, {
        numeric: "auto",
      });
      if (dayKey === todayKey) return rtf.format(0, "day");
      if (dayKey === yesterdayKey) return rtf.format(-1, "day");
    } catch {
      // Fallback to formatted date below.
    }
    const [yearStr] = dayKey.split("-");
    const year = Number(yearStr);
    if (!year) return defaultHeading;
    return formatDate(`${dayKey}T12:00:00.000Z`, {
      day: "numeric",
      month: "long",
      ...(year !== currentYear ? { year: "numeric" } : {}),
      timeZone: REPORT_TIMEZONE,
    });
  };

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 pb-4">
      <ReportPageHeader
        action={
          <ButtonLink
            className="sm:w-auto"
            href={`/reports?${childQuery}`}
            variant="secondary"
          >
            <BarChart3 aria-hidden="true" className="size-4" />
            {t("sessions.viewProgressAction")}
          </ButtonLink>
        }
        description={t("sessions.historyDescription")}
        eyebrow={t("sessions.historyEyebrow", {
          alias: state.child.alias,
          grade: state.child.grade,
        })}
        title={t("sessions.title")}
      />

      <div className="flex flex-col justify-between gap-3 rounded-card border border-border bg-white p-3.5 sm:flex-row sm:items-end sm:p-4">
        <div className="w-full sm:max-w-sm">
          <ChildSelector
            childrenProfiles={state.children}
            selectedChildId={state.child.id}
          />
        </div>
        {state.items.length > 0 ? (
          <p className="text-xs font-semibold text-muted tabular-nums">
            {t("sessions.showingPageSummary", {
              count: state.items.length,
              page: currentPage,
            })}
          </p>
        ) : null}
      </div>

      {state.items.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink href={`/books?${childQuery}`}>
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
        <div className="flex flex-col gap-5">
          {dayGroups.map((group) => (
            <section
              aria-labelledby={`history-day-${group.dayKey}`}
              className="space-y-2"
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
              <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-white">
                {group.items.map((item) => (
                  <SessionHistoryItem
                    item={item}
                    key={item.session.id}
                    page={currentPage}
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
          className="flex flex-col-reverse items-center gap-3 pt-1 sm:flex-row sm:justify-between"
        >
          {currentPage > 1 ? (
            <ButtonLink
              className="sm:w-auto sm:min-w-36"
              href={`/sessions?${childQuery}&page=${currentPage - 1}`}
              variant="secondary"
            >
              {t("sessions.previousPage")}
            </ButtonLink>
          ) : (
            <span className="hidden sm:block sm:min-w-36" />
          )}
          <span
            aria-current="page"
            className="text-sm font-bold text-muted tabular-nums"
          >
            {t("sessions.readingReports.pageLabel", { page: currentPage })}
          </span>
          {nextPage !== null ? (
            <ButtonLink
              className="sm:w-auto sm:min-w-36"
              href={`/sessions?${childQuery}&page=${nextPage}`}
            >
              {t("sessions.nextPage")}
            </ButtonLink>
          ) : (
            <span className="hidden sm:block sm:min-w-36" />
          )}
        </nav>
      ) : null}
    </section>
  );
}
