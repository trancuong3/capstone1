"use client";

import { ArrowLeft, Mic, RefreshCw, Sparkles, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { SelectField } from "@/components/common/select-field";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ChildSelector } from "@/components/reports/child-selector";
import { DifficultWordBookCard } from "@/components/reports/difficult-word-book-card";
import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import { MinimalPairSandbox } from "@/components/reading/minimal-pair-sandbox";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useReportServices } from "@/hooks/use-report-services";
import { groupDifficultWordsByBook } from "@/lib/api/difficult-word-service";
import { isServiceError } from "@/lib/api/service-error";
import { preloadReadingVoiceEngines } from "@/lib/reading/voice-preloader";
import {
  DEFAULT_USER_CACHE_TTL_MS,
  PERSISTENT_USER_CACHE_MAX_STALE_MS,
  readUserCacheWithStale,
  sanitizeChildProfileForCache,
  writeUserCache,
} from "@/lib/cache/user-query-cache";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
import {
  createCalendarWindow,
  currentDateInReportTimezone,
  DIFFICULT_WORD_DEFAULT_DAYS,
} from "@/lib/utils/report-state";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DifficultWordDTO,
  DifficultWordPracticeAttemptDTO,
  DifficultWordPracticeStatus,
} from "@/types/reports";

type StatusFilterValue = "ALL" | DifficultWordPracticeStatus;

type WordsState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly children: readonly ChildProfileDTO[];
      readonly child: ChildProfileDTO;
      readonly words: readonly DifficultWordDTO[];
    }
  | { readonly status: "no-children" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" }
  | { readonly status: "error" };

interface CachedDifficultWordsPayload {
  readonly child: ChildProfileDTO;
  readonly words: readonly DifficultWordDTO[];
}

export function DifficultWordsScreen({
  requestedChildId,
  requestedPracticeWord,
}: {
  readonly requestedChildId?: string;
  readonly requestedPracticeWord?: string;
}) {
  const { formatNumber } = useI18n();
  const t = useTranslations("difficultWords");
  const authRuntime = useAuthRuntime();
  const userId =
    authRuntime.session?.user?.id ?? authRuntime.initialUserId ?? null;
  const { childService, difficultWordService } = useReportServices();
  const [requestKey, setRequestKey] = useState(0);
  const [periodDays, setPeriodDays] = useState<number>(
    DIFFICULT_WORD_DEFAULT_DAYS,
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("ALL");
  const [bookGroupPage, setBookGroupPage] = useState(1);
  const BOOK_GROUPS_PAGE_SIZE = 6;
  const loadRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const routeSelectionKey = `${requestedChildId ?? ""}|${requestedPracticeWord ?? ""}`;
  const [practiceSelection, setPracticeSelection] = useState<{
    readonly routeKey: string;
    readonly word: string | null;
    readonly bookKey: string | null;
    readonly autoStart: boolean;
    readonly visitedWords: readonly string[];
  }>({
    routeKey: routeSelectionKey,
    word: requestedPracticeWord ?? null,
    bookKey: null,
    autoStart: false,
    visitedWords: [],
  });

  const activePracticeWord =
    practiceSelection.routeKey === routeSelectionKey
      ? practiceSelection.word
      : (requestedPracticeWord ?? null);
  const activeBookKey =
    practiceSelection.routeKey === routeSelectionKey
      ? practiceSelection.bookKey
      : null;
  const activeAutoStart =
    practiceSelection.routeKey === routeSelectionKey
      ? practiceSelection.autoStart
      : false;

  const openPracticeSession = useCallback(
    (word: string | null, bookKey: string | null = null, autoStart = false) => {
      setPracticeSelection((previous) => ({
        routeKey: routeSelectionKey,
        word,
        bookKey,
        autoStart,
        visitedWords:
          autoStart &&
          previous.routeKey === routeSelectionKey &&
          previous.bookKey === bookKey &&
          previous.word
            ? previous.visitedWords.includes(previous.word)
              ? previous.visitedWords
              : [...previous.visitedWords, previous.word]
            : [],
      }));
    },
    [routeSelectionKey],
  );

  const [state, setState] = useState<WordsState>({ status: "loading" });
  const activeChild = state.status === "ready" ? state.child : null;

  useEffect(() => {
    if (activeChild) {
      hydrateTeacherVoiceFromChildProfile(activeChild);
    }
  }, [activeChild]);

  useEffect(() => {
    mountedRef.current = true;
    void preloadReadingVoiceEngines();
    return () => {
      mountedRef.current = false;
      loadRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const requestId = ++loadRequestIdRef.current;
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
          const cachedWords =
            readUserCacheWithStale<CachedDifficultWordsPayload>(
              userId,
              `difficult-words:${cachedChild.id}:d${periodDays}`,
              DEFAULT_USER_CACHE_TTL_MS,
              PERSISTENT_USER_CACHE_MAX_STALE_MS,
            )?.data;
          if (cachedWords && active && requestId === loadRequestIdRef.current) {
            hydratedFromCache = true;
            setState({
              status: "ready",
              children: cachedChildren,
              child: cachedWords.child,
              words: cachedWords.words,
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
          if (active && requestId === loadRequestIdRef.current)
            setState({ status: "no-children" });
          return;
        }
        const matchedChild = requestedChildId
          ? children.find((item) => item.id === requestedChildId)
          : children[0];
        const child = matchedChild
          ? matchedChild
          : await childService.get(requestedChildId!);
        const words = await difficultWordService.list(
          child.id,
          createCalendarWindow(currentDateInReportTimezone(), periodDays),
        );
        if (active && requestId === loadRequestIdRef.current) {
          setBookGroupPage(1);
          setState({ status: "ready", children, child, words });
          if (canUseSwrCache && userId) {
            writeUserCache(
              userId,
              "children",
              children.map((entry) => sanitizeChildProfileForCache(entry)),
              { persist: "session" },
            );
            writeUserCache<CachedDifficultWordsPayload>(
              userId,
              `difficult-words:${child.id}:d${periodDays}`,
              {
                child: sanitizeChildProfileForCache(child),
                words,
              },
              { persist: "session" },
            );
          }
        }
      } catch (error) {
        if (
          active &&
          requestId === loadRequestIdRef.current &&
          !hydratedFromCache
        )
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
    void load();
    return () => {
      active = false;
      loadRequestIdRef.current += 1;
    };
  }, [
    childService,
    difficultWordService,
    periodDays,
    requestKey,
    requestedChildId,
    userId,
  ]);

  const applyAttemptToLocalState = useCallback(
    (attempt: DifficultWordPracticeAttemptDTO) => {
      setState((current) => {
        if (current.status !== "ready") return current;
        return {
          ...current,
          words: current.words.map((item) =>
            item.normalized_word === attempt.normalized_word
              ? {
                  ...item,
                  practice_status: attempt.word_progress.practice_status,
                  practice_attempts_count:
                    attempt.word_progress.practice_attempts_count,
                  practice_correct_count:
                    attempt.word_progress.practice_correct_count,
                  practice_incorrect_count:
                    attempt.word_progress.practice_incorrect_count,
                  practice_uncertain_count:
                    attempt.word_progress.practice_uncertain_count,
                  consecutive_correct_count:
                    attempt.word_progress.consecutive_correct_count,
                  last_practiced_at: attempt.word_progress.last_practiced_at,
                  last_practice_status:
                    attempt.word_progress.last_practice_status,
                }
              : item,
          ),
        };
      });
    },
    [],
  );

  const refreshWordsSilently = useCallback(async () => {
    if (state.status !== "ready") return;
    const childId = state.child.id;
    const requestId = ++loadRequestIdRef.current;
    try {
      const words = await difficultWordService.list(
        childId,
        createCalendarWindow(currentDateInReportTimezone(), periodDays),
      );
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
      setState((current) =>
        current.status === "ready" && current.child.id === childId
          ? { ...current, words }
          : current,
      );
    } catch {
      // Giữ nguyên state hiện tại nếu background refresh tạm gián đoạn.
    }
  }, [difficultWordService, periodDays, state]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilterValue, number> = {
      ALL: 0,
      NOT_PRACTICED: 0,
      IN_PROGRESS: 0,
      NEEDS_MORE_PRACTICE: 0,
      COMPLETED: 0,
    };
    if (state.status !== "ready") return counts;
    counts.ALL = state.words.length;
    for (const word of state.words) {
      const status: DifficultWordPracticeStatus =
        word.practice_status ?? "NOT_PRACTICED";
      counts[status] += 1;
    }
    return counts;
  }, [state]);

  const filteredWords = useMemo(() => {
    if (state.status !== "ready") return [];
    if (statusFilter === "ALL") return state.words;
    return state.words.filter(
      (word) => (word.practice_status ?? "NOT_PRACTICED") === statusFilter,
    );
  }, [state, statusFilter]);

  const bookGroups = useMemo(
    () => groupDifficultWordsByBook(filteredWords),
    [filteredWords],
  );
  const totalBookGroupPages = Math.max(
    1,
    Math.ceil(bookGroups.length / BOOK_GROUPS_PAGE_SIZE),
  );
  const safeBookGroupPage = Math.min(
    Math.max(1, bookGroupPage),
    totalBookGroupPages,
  );

  const summaryStats = useMemo(() => {
    if (state.status !== "ready") {
      return { total: 0, completed: 0, remaining: 0, percent: 0 };
    }
    const total = state.words.length;
    const completed = state.words.filter(
      (word) => word.practice_status === "COMPLETED",
    ).length;
    const remaining = Math.max(0, total - completed);
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, remaining, percent };
  }, [state]);

  const practiceQueueWords = useMemo(() => {
    if (state.status !== "ready") return [];
    if (activeBookKey) {
      const matchingGroup = groupDifficultWordsByBook(state.words).find(
        (group) => group.key === activeBookKey,
      );
      if (matchingGroup && matchingGroup.words.length > 0) {
        return matchingGroup.words;
      }
    }
    return state.words;
  }, [activeBookKey, state]);

  const selectedPracticeWord = useMemo(() => {
    if (state.status !== "ready" || !activePracticeWord) return null;
    return (
      practiceQueueWords.find(
        (item) => item.normalized_word === activePracticeWord,
      ) ??
      state.words.find((item) => item.normalized_word === activePracticeWord) ??
      null
    );
  }, [activePracticeWord, practiceQueueWords, state]);

  const isImmersivePracticeActive = selectedPracticeWord !== null;
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("viread:immersive-mode", {
        detail: { active: isImmersivePracticeActive },
      }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent("viread:immersive-mode", {
          detail: { active: false },
        }),
      );
    };
  }, [isImmersivePracticeActive]);

  const firstPendingGlobalWord = useMemo(() => {
    if (state.status !== "ready") return null;
    return (
      state.words.find((item) => item.practice_status !== "COMPLETED") ??
      state.words[0] ??
      null
    );
  }, [state]);

  if (state.status === "loading")
    return (
      <section
        aria-busy="true"
        aria-label={t("screen.loadingAria")}
        className="mx-auto flex max-w-[1280px] flex-col gap-6"
      >
        <Skeleton className="h-32 rounded-card" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {[0, 1].map((item) => (
            <Skeleton className="h-64 rounded-card" key={item} />
          ))}
        </div>
      </section>
    );
  if (state.status === "no-children")
    return (
      <EmptyState
        headingLevel={1}
        action={
          <ButtonLink href="/children/new">
            {t("screen.createChildAction")}
          </ButtonLink>
        }
        description={t("screen.noChildDescription")}
        icon={<Volume2 aria-hidden="true" className="size-10 text-primary" />}
        title={t("screen.noChildTitle")}
      />
    );
  if (state.status === "unavailable")
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          {t("screen.unsupportedTitle")}
        </h1>
        <StatusMessage tone="info">
          {t("screen.unsupportedDescription")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />{" "}
          {t("screen.retry")}
        </Button>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/children"
          variant="secondary"
        >
          {t("screen.manageChildren")}
        </ButtonLink>
      </section>
    );
  if (state.status === "not-found")
    return (
      <StatusMessage title={t("screen.notFoundTitle")} tone="error">
        {t("screen.notFoundDescription")}
      </StatusMessage>
    );
  if (state.status === "error")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <StatusMessage title={t("screen.loadErrorTitle")} tone="error">
          {t("screen.loadErrorDescription")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          {t("screen.retry")}
        </Button>
      </div>
    );

  const filterPills = [
    { value: "ALL", key: "screen.quickAll" },
    { value: "NOT_PRACTICED", key: "screen.quickNotPracticed" },
    { value: "IN_PROGRESS", key: "screen.quickInProgress" },
    { value: "NEEDS_MORE_PRACTICE", key: "screen.quickNeedsMoreFull" },
    { value: "COMPLETED", key: "screen.quickMastered" },
  ] as const;

  return (
    <section className="mx-auto flex w-full max-w-[1160px] flex-col gap-4 sm:gap-5">
      <div className={selectedPracticeWord ? "hidden sm:block" : undefined}>
        <ReportPageHeader
          action={
            <ButtonLink
              className="sm:w-auto"
              href={`/reports?childId=${encodeURIComponent(state.child.id)}`}
              variant="secondary"
            >
              <ArrowLeft
                aria-hidden="true"
                className="viread-rtl-flip size-5"
              />
              {t("screen.backToReports")}
            </ButtonLink>
          }
          description={t("screen.headerDescription", { days: periodDays })}
          eyebrow={t("screen.eyebrow")}
          title={t("screen.headerTitle", { alias: state.child.alias })}
        />
      </div>

      {selectedPracticeWord ? (
        <DifficultWordPracticePanel
          autoStart={activeAutoStart}
          visitedWords={
            practiceSelection.routeKey === routeSelectionKey
              ? practiceSelection.visitedWords
              : undefined
          }
          child={state.child}
          key={selectedPracticeWord.normalized_word}
          onAttemptCompleted={applyAttemptToLocalState}
          onClose={() => {
            openPracticeSession(null, null, false);
            void refreshWordsSilently();
          }}
          onProgressSaved={refreshWordsSilently}
          onSelectWord={(normalizedWord, options) =>
            openPracticeSession(
              normalizedWord,
              activeBookKey,
              options?.autoStart ?? false,
            )
          }
          word={selectedPracticeWord}
          words={practiceQueueWords}
        />
      ) : (
        <>
          <MinimalPairSandbox
            childAlias={state.child.alias}
            childId={state.child.id}
            days={Math.min(90, Math.max(7, periodDays))}
            initialOpen={
              typeof window !== "undefined" &&
              new URLSearchParams(window.location.search).get("sandbox") === "1"
            }
          />

          <div className="flex flex-col gap-3.5 rounded-card border border-border bg-white p-4 shadow-2xs sm:p-5">
            <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
              <div className="min-w-0">
                <ChildSelector
                  childrenProfiles={state.children}
                  clearQueryKeys={["word"]}
                  selectedChildId={state.child.id}
                />
              </div>

              <SelectField
                aria-label={t("screen.periodAria")}
                label={t("screen.periodLabel")}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (Number.isSafeInteger(parsed) && parsed > 0) {
                    setPeriodDays(parsed);
                  }
                }}
                value={String(periodDays)}
              >
                <option value="30">
                  {t("screen.periodOption", { days: 30 })}
                </option>
                <option value="90">
                  {t("screen.periodOption", { days: 90 })}
                </option>
                <option value="180">
                  {t("screen.periodOption", { days: 180 })}
                </option>
              </SelectField>
            </div>

            {/* Unified status filter pills with live counts across desktop & mobile */}
            <div
              aria-label={t("screen.quickFilterAria")}
              className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3"
              role="group"
            >
              {filterPills.map((pill) => {
                const active = statusFilter === pill.value;
                const count = statusCounts[pill.value];
                return (
                  <button
                    aria-pressed={active}
                    className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                      active
                        ? "border-primary bg-primary text-white shadow-2xs"
                        : "border-border bg-surface-subtle text-ink hover:bg-sky/60"
                    }`}
                    key={pill.value}
                    onClick={() => {
                      setStatusFilter(pill.value);
                      setBookGroupPage(1);
                    }}
                    type="button"
                  >
                    <span>{t(pill.key)}</span>
                    <span
                      className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
                        active
                          ? "bg-white/20 text-white"
                          : "bg-white text-muted"
                      }`}
                    >
                      {formatNumber(count)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {state.words.length > 0 ? (
            <div className="flex flex-col justify-between gap-4 rounded-card border border-primary/20 bg-gradient-to-r from-cream via-white to-sky/65 p-5 shadow-2xs sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 space-y-2.5">
                <div className="inline-flex items-center gap-2 text-sm font-extrabold text-primary-hover">
                  <Sparkles aria-hidden="true" className="size-4" />
                  {t("screen.progressTitle", { alias: state.child.alias })}
                </div>
                <p className="text-lg font-extrabold text-ink">
                  {t("screen.progressCount", {
                    completed: formatNumber(summaryStats.completed),
                    total: formatNumber(summaryStats.total),
                    percent: summaryStats.percent,
                  })}
                </p>

                <div
                  aria-hidden="true"
                  className="h-2.5 w-full max-w-md overflow-hidden rounded-full bg-border/60"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${summaryStats.percent}%` }}
                  />
                </div>

                <dl className="flex flex-wrap items-center gap-2 pt-0.5 text-xs">
                  <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1">
                    <dt className="font-semibold text-muted">
                      {t("screen.statTotal")}
                    </dt>
                    <dd className="font-extrabold text-ink tabular-nums">
                      {formatNumber(summaryStats.total)}
                    </dd>
                  </div>
                  <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-success-surface px-3 py-1">
                    <dt className="font-semibold text-success-ink">
                      {t("screen.statCompleted")}
                    </dt>
                    <dd className="font-extrabold text-success-ink tabular-nums">
                      {formatNumber(summaryStats.completed)}
                    </dd>
                  </div>
                  <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-warning-surface px-3 py-1">
                    <dt className="font-semibold text-warning">
                      {t("screen.statRemaining")}
                    </dt>
                    <dd className="font-extrabold text-warning tabular-nums">
                      {formatNumber(summaryStats.remaining)}
                    </dd>
                  </div>
                </dl>

                <p className="text-xs text-muted">{t("screen.progressHint")}</p>
              </div>
              {firstPendingGlobalWord ? (
                <Button
                  className="min-h-12 shrink-0 rounded-card px-6 text-base font-extrabold shadow-sm sm:w-auto"
                  onClick={() =>
                    openPracticeSession(
                      firstPendingGlobalWord.normalized_word,
                      null,
                      true,
                    )
                  }
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

          {state.words.length === 0 ? (
            <EmptyState
              action={
                <ButtonLink
                  href={`/books?childId=${encodeURIComponent(state.child.id)}`}
                >
                  {t("screen.continueReadingAction")}
                </ButtonLink>
              }
              description={t("screen.emptyDescription")}
              icon={
                <Volume2 aria-hidden="true" className="size-10 text-primary" />
              }
              title={t("screen.emptyTitle")}
            />
          ) : filteredWords.length === 0 ? (
            <EmptyState
              action={
                <Button
                  className="sm:w-auto sm:px-6"
                  onClick={() => {
                    setStatusFilter("ALL");
                    setBookGroupPage(1);
                  }}
                  variant="secondary"
                >
                  {t("screen.viewAllWords", { count: state.words.length })}
                </Button>
              }
              description={t("screen.emptyFilterDescription")}
              icon={
                <Volume2 aria-hidden="true" className="size-10 text-primary" />
              }
              title={t("screen.emptyFilterTitle")}
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {bookGroups
                  .slice(
                    (safeBookGroupPage - 1) * BOOK_GROUPS_PAGE_SIZE,
                    safeBookGroupPage * BOOK_GROUPS_PAGE_SIZE,
                  )
                  .map((group) => (
                    <DifficultWordBookCard
                      group={group}
                      key={group.key}
                      onSelectWord={(target) =>
                        openPracticeSession(
                          target.normalized_word,
                          group.key,
                          true,
                        )
                      }
                      onStartBookPractice={(target) =>
                        openPracticeSession(
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
                onPageChange={setBookGroupPage}
                page={safeBookGroupPage}
                pageSize={BOOK_GROUPS_PAGE_SIZE}
                total={bookGroups.length}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
