"use client";

import { ArrowLeft, Mic, RefreshCw, Sparkles, Volume2 } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { SelectField } from "@/components/common/select-field";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { ChildSelector } from "@/components/reports/child-selector";
import { DifficultWordBookCard } from "@/components/reports/difficult-word-book-card";
import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { useReportServices } from "@/hooks/use-report-services";
import { groupDifficultWordsByBook } from "@/lib/api/difficult-word-service";
import { isServiceError } from "@/lib/api/service-error";
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

export function DifficultWordsScreen({
  requestedChildId,
  requestedPracticeWord,
}: {
  readonly requestedChildId?: string;
  readonly requestedPracticeWord?: string;
}) {
  const { childService, difficultWordService } = useReportServices();
  const appStore = useContext(AppStoreContext);
  const initialStoreChildIdRef = useRef(appStore?.selectedChildId ?? null);
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
            ? [...previous.visitedWords, previous.word]
            : [],
      }));
    },
    [routeSelectionKey],
  );

  const [state, setState] = useState<WordsState>({ status: "loading" });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const requestId = ++loadRequestIdRef.current;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const children = await childService.list();
        if (children.length === 0) {
          if (active && requestId === loadRequestIdRef.current)
            setState({ status: "no-children" });
          return;
        }
        const preferredChildId =
          requestedChildId ?? initialStoreChildIdRef.current ?? undefined;
        const matchedChild = preferredChildId
          ? children.find((item) => item.id === preferredChildId)
          : children[0];
        const child = matchedChild
          ? matchedChild
          : requestedChildId
            ? await childService.get(requestedChildId)
            : children[0];
        const words = await difficultWordService.list(
          child.id,
          createCalendarWindow(currentDateInReportTimezone(), periodDays),
        );
        if (active && requestId === loadRequestIdRef.current) {
          setBookGroupPage(1);
          setState({ status: "ready", children, child, words });
        }
      } catch (error) {
        if (active && requestId === loadRequestIdRef.current)
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
  ]);

  const selectStoreChild = appStore?.selectChild;
  const setStoreValidatedChild = appStore?.setValidatedSelectedChild;
  const syncStoreChildren = appStore?.syncAvailableChildren;
  const syncedChildIdRef = useRef<string | null>(null);
  const readyChild = state.status === "ready" ? state.child : null;
  const readyChildren = state.status === "ready" ? state.children : null;

  useEffect(() => {
    if (!readyChild || !readyChildren) return;
    if (syncedChildIdRef.current === readyChild.id) return;
    syncedChildIdRef.current = readyChild.id;
    syncStoreChildren?.(readyChildren);
    selectStoreChild?.(readyChild.id);
    setStoreValidatedChild?.(readyChild);
  }, [
    readyChild,
    readyChildren,
    selectStoreChild,
    setStoreValidatedChild,
    syncStoreChildren,
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
        aria-label="Đang tải từ cần luyện"
        className="mx-auto flex max-w-[1280px] flex-col gap-6"
      >
        <Skeleton className="h-32 rounded-[24px]" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {[0, 1].map((item) => (
            <Skeleton className="h-64 rounded-[24px]" key={item} />
          ))}
        </div>
      </section>
    );
  if (state.status === "no-children")
    return (
      <EmptyState
        headingLevel={1}
        action={<ButtonLink href="/children/new">Tạo hồ sơ bé</ButtonLink>}
        description="Tạo hồ sơ và bắt đầu đọc để hệ thống có bằng chứng."
        icon={<Volume2 aria-hidden="true" className="size-10 text-primary" />}
        title="Chưa có hồ sơ bé"
      />
    );
  if (state.status === "unavailable")
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          Dữ liệu đang chờ bổ sung
        </h1>
        <StatusMessage tone="info">
          Dữ liệu của mục này chưa sẵn sàng theo định dạng hiện tại. Không có dữ
          liệu mẫu thay thế.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" /> Thử lại
        </Button>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/children"
          variant="secondary"
        >
          Quản lý hồ sơ bé
        </ButtonLink>
      </section>
    );
  if (state.status === "not-found")
    return (
      <StatusMessage title="Không tìm thấy dữ liệu" tone="error">
        Dữ liệu không tồn tại hoặc không thuộc tài khoản hiện tại.
      </StatusMessage>
    );
  if (state.status === "error")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <StatusMessage title="Chưa tải được từ cần luyện" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </div>
    );

  return (
    <section className="mx-auto flex w-full max-w-[1160px] flex-col gap-3 md:gap-5">
      <div className={selectedPracticeWord ? "hidden sm:block" : undefined}>
        <ReportPageHeader
          action={
            <ButtonLink
              className="w-auto"
              href={`/reports?childId=${encodeURIComponent(state.child.id)}`}
              variant="secondary"
            >
              <ArrowLeft aria-hidden="true" className="size-4 md:size-5" />
              Báo cáo
            </ButtonLink>
          }
          description={`Tổng hợp theo từng cuốn sách trong ${periodDays} ngày gần nhất; bé chỉ cần đọc đúng một lần rõ tiếng để hoàn thành từ.`}
          eyebrow="Cùng luyện mỗi ngày"
          title={`Từ cần luyện của ${state.child.alias}`}
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
          <div className="grid w-full grid-cols-1 gap-2.5 rounded-[20px] border border-[#DCE8E4] bg-white p-3 md:grid-cols-3 md:gap-4 md:rounded-[24px] md:p-5">
            <div className="hidden min-w-0 md:col-span-1 md:block">
              <ChildSelector
                childrenProfiles={state.children}
                clearQueryKeys={["word"]}
                selectedChildId={state.child.id}
              />
            </div>

            <div className="flex flex-col gap-2 md:hidden">
              <div
                aria-label="Lọc nhanh theo trạng thái luyện"
                className="flex flex-wrap items-center gap-1.5"
                role="group"
              >
                {(
                  [
                    { value: "ALL", label: "Tất cả" },
                    { value: "NOT_PRACTICED", label: "Chưa luyện" },
                    { value: "IN_PROGRESS", label: "Đang luyện" },
                    { value: "NEEDS_MORE_PRACTICE", label: "Cần thêm" },
                    { value: "COMPLETED", label: "Đã xong" },
                  ] as const
                ).map((pill) => {
                  const active = statusFilter === pill.value;
                  return (
                    <button
                      aria-pressed={active}
                      className={`inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-3 py-2 text-xs font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                        active
                          ? "border-primary bg-primary text-white"
                          : "border-[#DCE8E4] bg-[#F6FAF8] text-[#213C42]"
                      }`}
                      key={pill.value}
                      onClick={() => {
                        setStatusFilter(pill.value);
                        setBookGroupPage(1);
                      }}
                      type="button"
                    >
                      {pill.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <SelectField
              aria-label="Chọn khoảng thời gian"
              label="Khoảng thời gian"
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                if (Number.isSafeInteger(parsed) && parsed > 0) {
                  setPeriodDays(parsed);
                }
              }}
              value={String(periodDays)}
            >
              <option value="30">30 ngày gần nhất</option>
              <option value="90">90 ngày gần nhất</option>
              <option value="180">180 ngày gần nhất</option>
            </SelectField>

            <div className="hidden md:contents">
              <SelectField
                aria-label="Lọc theo trạng thái luyện"
                label="Trạng thái luyện"
                onChange={(event) => {
                  setStatusFilter(event.target.value as StatusFilterValue);
                  setBookGroupPage(1);
                }}
                value={statusFilter}
              >
                <option value="ALL">Tất cả trạng thái</option>
                <option value="NOT_PRACTICED">Chưa luyện</option>
                <option value="IN_PROGRESS">Đang luyện</option>
                <option value="NEEDS_MORE_PRACTICE">Cần luyện thêm</option>
                <option value="COMPLETED">Đã hoàn thành</option>
              </SelectField>
            </div>
          </div>

          {state.words.length > 0 ? (
            <div className="flex flex-col justify-between gap-2.5 rounded-[20px] border border-[#DDF3F5] bg-gradient-to-r from-[#F6FAF8] to-[#ECF8F9] p-3.5 sm:flex-row sm:items-center md:gap-4 md:rounded-[24px] md:p-5">
              <div className="flex flex-col gap-0.5 md:gap-1">
                <div className="inline-flex items-center gap-1.5 text-xs font-extrabold text-[#0E6D76] md:gap-2 md:text-sm">
                  <Sparkles aria-hidden="true" className="size-4" />
                  Tiến độ luyện từ của {state.child.alias}
                </div>
                <p className="text-base font-extrabold text-[#213C42] md:text-lg">
                  {summaryStats.completed}/{summaryStats.total} từ đã đọc đúng (
                  {summaryStats.percent}%)
                </p>
                <p className="hidden text-xs text-[#526970] md:block">
                  Chọn một từ trên thẻ sách hoặc bấm nút bên cạnh để bé bắt đầu
                  luyện nhanh bằng giọng nói.
                </p>
              </div>
              {firstPendingGlobalWord ? (
                <Button
                  className="min-h-11 shrink-0 rounded-2xl px-4 text-sm font-extrabold sm:w-auto md:min-h-12 md:px-6 md:text-base"
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
                    ? `Luyện ${summaryStats.remaining} từ cần ôn`
                    : "Ôn lại từ đã đọc"}
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
                  Tiếp tục đọc sách
                </ButtonLink>
              }
              description="Các buổi đọc đã lưu chưa ghi nhận từ cần luyện trong khoảng thời gian đang chọn."
              icon={
                <Volume2 aria-hidden="true" className="size-10 text-primary" />
              }
              title="Chưa có từ cần luyện"
            />
          ) : filteredWords.length === 0 ? (
            <EmptyState
              action={
                <Button
                  className="sm:w-auto sm:px-6"
                  onClick={() => setStatusFilter("ALL")}
                  variant="secondary"
                >
                  Xem tất cả từ ({state.words.length})
                </Button>
              }
              description="Chưa có từ nào khớp trạng thái luyện đang chọn."
              icon={
                <Volume2 aria-hidden="true" className="size-10 text-primary" />
              }
              title="Không có từ phù hợp bộ lọc"
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {bookGroups
                  .slice(
                    (bookGroupPage - 1) * BOOK_GROUPS_PAGE_SIZE,
                    bookGroupPage * BOOK_GROUPS_PAGE_SIZE,
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
                ariaLabel="Phân trang nhóm sách từ cần luyện"
                itemLabel="cuốn sách"
                onPageChange={setBookGroupPage}
                page={bookGroupPage}
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
