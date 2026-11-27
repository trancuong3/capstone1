"use client";

import {
  BarChart3,
  CheckCircle2,
  Clock3,
  History,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ChildSelector } from "@/components/reports/child-selector";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { SessionHistoryItem } from "@/components/reports/session-history-item";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  DEFAULT_USER_CACHE_TTL_MS,
  PERSISTENT_USER_CACHE_MAX_STALE_MS,
  readUserCacheWithStale,
  sanitizeChildProfileForCache,
  writeUserCache,
} from "@/lib/cache/user-query-cache";
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

type HistoryStatusFilter = "ALL" | "COMPLETED" | "INCOMPLETE";

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

interface CachedSessionHistoryPayload {
  readonly child: ChildProfileDTO;
  readonly items: readonly SessionHistoryItemViewModelUI[];
  readonly nextCursor: string | null;
}

interface SessionHistoryScreenProps {
  readonly page: number;
  readonly requestedChildId?: string;
}

export function SessionHistoryScreen({
  page,
  requestedChildId,
}: SessionHistoryScreenProps) {
  const { formatDate, formatNumber, locale } = useI18n();
  const t = useTranslations("reports");
  const authRuntime = useAuthRuntime();
  const userId =
    authRuntime.session?.user?.id ?? authRuntime.initialUserId ?? null;
  const { childService, sessionService } = useReportServices();
  const currentPage =
    Number.isSafeInteger(page) && page >= 1 && page <= 100000 ? page : 1;
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    let active = true;
    const canUseSwrCache = Boolean(userId) && process.env.NODE_ENV !== "test";

    async function load(): Promise<void> {
      let hydratedFromCache = false;
      if (canUseSwrCache && userId) {
        const cachedChildren = readUserCacheWithStale<ChildProfileDTO[]>(
          userId,
          "children",
          DEFAULT_USER_CACHE_TTL_MS,
          PERSISTENT_USER_CACHE_MAX_STALE_MS,
        )?.data;
        const cachedChild = cachedChildren?.length
          ? requestedChildId
            ? cachedChildren.find((item) => item.id === requestedChildId)
            : cachedChildren[0]
          : undefined;

        if (cachedChildren && cachedChild) {
          const cachedHistory =
            readUserCacheWithStale<CachedSessionHistoryPayload>(
              userId,
              `session-history:${cachedChild.id}:p${currentPage}`,
              DEFAULT_USER_CACHE_TTL_MS,
              PERSISTENT_USER_CACHE_MAX_STALE_MS,
            )?.data;
          if (cachedHistory && active) {
            hydratedFromCache = true;
            setState({
              status: "ready",
              children: cachedChildren,
              child: cachedHistory.child,
              items: cachedHistory.items,
              nextCursor: cachedHistory.nextCursor,
            });
          }
        }
      }

      if (!hydratedFromCache) {
        setState({ status: "loading" });
      }

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

        // Use inline book metadata returned by the backend batch loader whenever
        // present, falling back to deduplicated per-book fetches for legacy mocks.
        const bookPromises = new Map<string, Promise<BookDetailDTO>>();
        const items = await Promise.all(
          history.sessions.map(async (session) => {
            if (session.book && session.book.id === session.book_id) {
              return mapSessionHistoryItem(session, child, session.book);
            }
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
          if (canUseSwrCache && userId) {
            writeUserCache(
              userId,
              "children",
              children.map((entry) => sanitizeChildProfileForCache(entry)),
              { persist: "session" },
            );
            writeUserCache<CachedSessionHistoryPayload>(
              userId,
              `session-history:${child.id}:p${currentPage}`,
              {
                child: sanitizeChildProfileForCache(child),
                items: items.map((entry) => ({
                  ...entry,
                  child: sanitizeChildProfileForCache(entry.child),
                  book: { ...entry.book, cover_url: null },
                })),
                nextCursor: history.next_cursor,
              },
              { persist: "session" },
            );
          }
        }
      } catch (error) {
        if (active && !hydratedFromCache) {
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
  }, [
    childService,
    currentPage,
    requestKey,
    requestedChildId,
    sessionService,
    userId,
  ]);

  const summary = useMemo(() => {
    if (state.status !== "ready") {
      return { totalCount: 0, completedCount: 0, totalDurationMs: 0 };
    }
    let completedCount = 0;
    let totalDurationMs = 0;
    for (const item of state.items) {
      if (item.session.state === "FINISHED") {
        completedCount += 1;
      }
      if (
        typeof item.session.duration_ms === "number" &&
        item.session.duration_ms > 0
      ) {
        totalDurationMs += item.session.duration_ms;
      }
    }
    return {
      totalCount: state.items.length,
      completedCount,
      totalDurationMs,
    };
  }, [state]);

  const filteredItems = useMemo(() => {
    if (state.status !== "ready") return [];
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase("vi");
    return state.items.filter((item) => {
      const isFinished = item.session.state === "FINISHED";
      if (statusFilter === "COMPLETED" && !isFinished) return false;
      if (statusFilter === "INCOMPLETE" && isFinished) return false;
      if (
        normalizedQuery &&
        !item.book.title.toLocaleLowerCase("vi").includes(normalizedQuery)
      ) {
        return false;
      }
      return true;
    });
  }, [searchQuery, state, statusFilter]);

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
  const dayGroups = groupSessionHistoryByDay(filteredItems);
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

  const formattedTotalDuration = (() => {
    if (summary.totalDurationMs <= 0) return t("sessions.summaryDurationZero");
    const totalSeconds = Math.floor(summary.totalDurationMs / 1000);
    if (totalSeconds < 60) {
      return t("sessions.durationSeconds", { seconds: totalSeconds });
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0
      ? t("sessions.durationMinutes", { minutes })
      : t("sessions.durationMinutesSeconds", { minutes, seconds });
  })();

  const hasActiveFilter = statusFilter !== "ALL" || searchQuery.trim() !== "";

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

      <div className="flex flex-col gap-3.5 rounded-card border border-border bg-white p-3.5 shadow-2xs sm:p-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
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

        {state.items.length > 0 ? (
          <>
            {/* Compact real-data summary strip */}
            <dl className="grid grid-cols-3 gap-2 border-t border-border/70 pt-3 sm:gap-3">
              <div className="flex items-center gap-2.5 rounded-control bg-canvas/80 px-3 py-2">
                <Sparkles
                  aria-hidden="true"
                  className="hidden size-4 shrink-0 text-primary sm:block"
                />
                <div className="min-w-0">
                  <dt className="truncate text-[11px] font-semibold text-muted">
                    {t("sessions.summarySessions")}
                  </dt>
                  <dd className="text-sm font-extrabold text-ink tabular-nums sm:text-base">
                    {formatNumber(summary.totalCount)}
                  </dd>
                </div>
              </div>
              <div className="flex items-center gap-2.5 rounded-control bg-canvas/80 px-3 py-2">
                <Clock3
                  aria-hidden="true"
                  className="hidden size-4 shrink-0 text-primary sm:block"
                />
                <div className="min-w-0">
                  <dt className="truncate text-[11px] font-semibold text-muted">
                    {t("sessions.summaryDuration")}
                  </dt>
                  <dd className="truncate text-sm font-extrabold text-ink tabular-nums sm:text-base">
                    {formattedTotalDuration}
                  </dd>
                </div>
              </div>
              <div className="flex items-center gap-2.5 rounded-control bg-canvas/80 px-3 py-2">
                <CheckCircle2
                  aria-hidden="true"
                  className="hidden size-4 shrink-0 text-success-ink sm:block"
                />
                <div className="min-w-0">
                  <dt className="truncate text-[11px] font-semibold text-muted">
                    {t("sessions.summaryCompleted")}
                  </dt>
                  <dd className="text-sm font-extrabold text-success-ink tabular-nums sm:text-base">
                    {formatNumber(summary.completedCount)}
                  </dd>
                </div>
              </div>
            </dl>

            {/* Quick status filter pills & book title filter */}
            <div className="flex flex-col gap-2.5 border-t border-border/70 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <div
                aria-label={t("sessions.filterAria")}
                className="flex flex-wrap items-center gap-1.5"
                role="group"
              >
                {(
                  [
                    { value: "ALL", labelKey: "sessions.filterAll" },
                    {
                      value: "COMPLETED",
                      labelKey: "sessions.filterCompleted",
                    },
                    {
                      value: "INCOMPLETE",
                      labelKey: "sessions.filterIncomplete",
                    },
                  ] as const
                ).map((pill) => {
                  const active = statusFilter === pill.value;
                  return (
                    <button
                      aria-pressed={active}
                      className={`min-h-10 rounded-full border px-3.5 py-1.5 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                        active
                          ? "border-primary bg-primary text-white"
                          : "border-border bg-white text-ink hover:bg-canvas"
                      }`}
                      key={pill.value}
                      onClick={() => setStatusFilter(pill.value)}
                      type="button"
                    >
                      {t(pill.labelKey)}
                    </button>
                  );
                })}
              </div>

              <div className="relative w-full sm:w-64">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted"
                />
                <input
                  aria-label={t("sessions.searchAria")}
                  className="min-h-10 w-full rounded-control border border-border bg-canvas/50 pe-9 ps-9 text-sm text-ink placeholder:text-muted focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("sessions.searchPlaceholder")}
                  type="search"
                  value={searchQuery}
                />
                {searchQuery ? (
                  <button
                    aria-label={t("sessions.clearFilterAction")}
                    className="absolute end-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-canvas hover:text-ink"
                    onClick={() => setSearchQuery("")}
                    type="button"
                  >
                    <X aria-hidden="true" className="size-4" />
                  </button>
                ) : null}
              </div>
            </div>
          </>
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
      ) : filteredItems.length === 0 && hasActiveFilter ? (
        <EmptyState
          action={
            <Button
              className="sm:w-auto sm:px-6"
              onClick={() => {
                setStatusFilter("ALL");
                setSearchQuery("");
              }}
              variant="secondary"
            >
              {t("sessions.clearFilterAction")}
            </Button>
          }
          description={t("sessions.filterEmptyDesc")}
          icon={<History aria-hidden="true" className="size-10 text-primary" />}
          title={t("sessions.filterEmptyTitle")}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {dayGroups.map((group) => (
            <section
              aria-labelledby={`history-day-${group.dayKey}`}
              className="space-y-2.5"
              key={group.dayKey}
            >
              <div className="flex items-center gap-3 px-1">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full bg-primary"
                />
                <h2
                  className="text-sm font-extrabold text-ink"
                  id={`history-day-${group.dayKey}`}
                >
                  {formatGroupHeading(group.dayKey, group.heading)}
                </h2>
                <span
                  aria-hidden="true"
                  className="h-px flex-1 bg-border/80"
                />
                <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-white px-2.5 py-0.5 text-xs font-bold text-muted tabular-nums">
                  {t("sessions.groupCount", { count: group.items.length })}
                </span>
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-white shadow-2xs">
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
