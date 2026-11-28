"use client";

import { History, RefreshCw, Search, X } from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";

import { AppStoreContext } from "@/components/providers/app-store-provider";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { SegmentedFilterBar } from "@/components/common/segmented-filter-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ChildSelector } from "@/components/reports/child-selector";
import { ReadingHubSubNav } from "@/components/reports/reading-hub-subnav";
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
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
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
  const appStore = useContext(AppStoreContext);
  const userId =
    authRuntime.session?.user?.id ?? authRuntime.initialUserId ?? null;
  const preferredChildId =
    requestedChildId ?? appStore?.selectedChildId ?? undefined;
  const { childService, sessionService } = useReportServices();
  const currentPage =
    Number.isSafeInteger(page) && page >= 1 && page <= 100000 ? page : 1;
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  const activeChild = state.status === "ready" ? state.child : null;
  useEffect(() => {
    if (activeChild) {
      hydrateTeacherVoiceFromChildProfile(activeChild);
    }
  }, [activeChild]);
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
          ? preferredChildId
            ? (cachedChildren.find((item) => item.id === preferredChildId) ??
              (!requestedChildId ? cachedChildren[0] : undefined))
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
        const matchedChild = preferredChildId
          ? children.find((item) => item.id === preferredChildId)
          : children[0];
        const child = matchedChild
          ? matchedChild
          : requestedChildId
            ? await childService.get(requestedChildId)
            : children[0];
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
    preferredChildId,
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
        className="mx-auto flex w-full max-w-[1120px] flex-col gap-3.5"
      >
        <Skeleton className="h-14 rounded-card" />
        <Skeleton className="h-12 rounded-card" />
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
  const statusFilterOptions: readonly {
    readonly value: HistoryStatusFilter;
    readonly label: string;
  }[] = [
    { value: "ALL", label: t("sessions.filterAll") },
    { value: "COMPLETED", label: t("sessions.filterCompleted") },
    { value: "INCOMPLETE", label: t("sessions.filterIncomplete") },
  ];

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-3.5 pb-4">
      <header className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="book-title text-xl tracking-[-0.02em] text-ink sm:text-2xl">
            {t("sessions.title")}
          </h1>
          <ReadingHubSubNav active="sessions" childId={state.child.id} />
        </div>
        <ChildSelector
          childrenProfiles={state.children}
          className="w-full sm:w-auto sm:min-w-48 sm:max-w-60"
          compact
          selectedChildId={state.child.id}
        />
      </header>

      {state.items.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-white px-3 py-2">
          <SegmentedFilterBar
            ariaLabel={t("sessions.filterAria")}
            onChange={setStatusFilter}
            options={statusFilterOptions}
            value={statusFilter}
          />

          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
            <dl className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs tabular-nums text-muted">
              <div className="flex items-baseline gap-1">
                <dt className="font-semibold">
                  {t("sessions.summarySessions")}
                </dt>
                <dd className="font-extrabold text-ink">
                  {formatNumber(summary.totalCount)}
                </dd>
              </div>
              <div className="flex items-baseline gap-1">
                <dt className="font-semibold">
                  {t("sessions.summaryDuration")}
                </dt>
                <dd className="font-extrabold text-ink">
                  {formattedTotalDuration}
                </dd>
              </div>
              <div className="flex items-baseline gap-1">
                <dt className="font-semibold">
                  {t("sessions.summaryCompleted")}
                </dt>
                <dd className="font-extrabold text-success-ink">
                  {formatNumber(summary.completedCount)}
                </dd>
              </div>
            </dl>
            <span
              className="hidden shrink-0 items-center rounded-full bg-canvas px-2 py-0.5 text-[11px] font-bold text-muted tabular-nums sm:inline-flex"
              title={t("sessions.showingPageSummary", {
                count: state.items.length,
                page: currentPage,
              })}
            >
              {t("sessions.readingReports.pageLabel", { page: currentPage })}
            </span>
          </div>

          <div className="relative w-full sm:w-72">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted"
            />
            <input
              aria-label={t("sessions.searchAria")}
              className={`h-10 w-full rounded-control border border-border bg-canvas/50 ps-8 text-xs text-ink placeholder:text-muted focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-8 ${
                searchQuery ? "pe-8" : "pe-3"
              }`}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("sessions.searchPlaceholder")}
              type="search"
              value={searchQuery}
            />
            {searchQuery ? (
              <button
                aria-label={t("sessions.clearFilterAction")}
                className="absolute end-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-canvas hover:text-ink sm:size-6"
                onClick={() => setSearchQuery("")}
                type="button"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

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
        <div className="flex flex-col gap-3.5">
          {dayGroups.map((group) => (
            <section
              aria-labelledby={`history-day-${group.dayKey}`}
              className="space-y-1.5"
              key={group.dayKey}
            >
              <div className="flex items-center gap-2.5 px-1">
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full bg-primary"
                />
                <h2
                  className="text-xs font-extrabold text-ink"
                  id={`history-day-${group.dayKey}`}
                >
                  {formatGroupHeading(group.dayKey, group.heading)}
                </h2>
                <span aria-hidden="true" className="h-px flex-1 bg-border/80" />
                <span className="shrink-0 text-[11px] font-bold text-muted tabular-nums">
                  {t("sessions.groupCount", { count: group.items.length })}
                </span>
              </div>
              <div className="divide-y divide-border/80 overflow-hidden rounded-card border border-border bg-white">
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
          className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2.5"
        >
          {currentPage > 1 ? (
            <ButtonLink
              className="min-h-10 sm:h-9 sm:min-h-9 sm:min-w-28"
              fullWidth={false}
              href={`/sessions?${childQuery}&page=${currentPage - 1}`}
              size="admin"
              variant="outline"
            >
              {t("sessions.previousPage")}
            </ButtonLink>
          ) : (
            <span className="hidden sm:block sm:min-w-28" />
          )}
          <span
            aria-current="page"
            className="text-xs font-bold text-muted tabular-nums"
          >
            {t("sessions.readingReports.pageLabel", { page: currentPage })}
          </span>
          {nextPage !== null ? (
            <ButtonLink
              className="min-h-10 sm:h-9 sm:min-h-9 sm:min-w-28"
              fullWidth={false}
              href={`/sessions?${childQuery}&page=${nextPage}`}
              size="admin"
            >
              {t("sessions.nextPage")}
            </ButtonLink>
          ) : (
            <span className="hidden sm:block sm:min-w-28" />
          )}
        </nav>
      ) : null}
    </section>
  );
}
