"use client";

import {
  ArrowLeft,
  ArrowRight,
  BookX,
  ClipboardList,
  RefreshCw,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { formatGradeRange } from "@/components/books/book-card";
import { BookChildHeader } from "@/components/books/book-child-header";
import { BookCover } from "@/components/books/book-cover";
import { BookPageThumbnail } from "@/components/books/book-page-thumbnail";
import { BookContentReportDialog } from "@/components/books/book-content-report-dialog";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useBookService } from "@/hooks/use-book-service";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { isServiceError } from "@/lib/api/service-error";
import type { BookDetailDTO, BookPagePreviewDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";

type DetailState =
  | { status: "loading" }
  | {
      status: "ready";
      book: BookDetailDTO;
      child: ChildProfileDTO;
      pages: BookPagePreviewDTO[];
      previewUnavailable: boolean;
    }
  | { status: "not-found" }
  | { status: "unavailable" }
  | { status: "error" };

interface BookDetailScreenProps {
  bookId: string;
}

export function BookDetailScreen({ bookId }: BookDetailScreenProps) {
  const { formatPercent } = useI18n();
  const t = useTranslations("books");
  const tc = useTranslations("child");
  const authRuntime = useAuthRuntime();
  const currentUserId = authRuntime.session?.user?.id ?? "";
  const bookService = useBookService();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const router = useRouter();
  const searchParams = useSearchParams();
  const targetPageId = searchParams.get("pageId");
  const confidenceParam = searchParams.get("confidence");
  const targetConfidenceValue =
    confidenceParam === null ? Number.NaN : Number(confidenceParam);
  const targetConfidence = Number.isFinite(targetConfidenceValue)
    ? targetConfidenceValue
    : null;

  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [selectedPage, setSelectedPage] = useState<BookPagePreviewDTO | null>(
    null,
  );
  const [selectedEndPageId, setSelectedEndPageId] = useState<string | null>(
    null,
  );
  const [startState, setStartState] = useState<"idle" | "starting">("idle");
  const [reportTarget, setReportTarget] = useState<{
    pageId: string | null;
    pageNumber: number | null;
  } | null>(null);
  const [thumbnailPage, setThumbnailPage] = useState(1);
  const THUMBNAILS_PER_PAGE = 24;

  useEffect(() => {
    let isActive = true;

    async function loadDetail() {
      setState({ status: "loading" });
      setSelectedPage(null);
      setSelectedEndPageId(null);
      setStartState("idle");

      if (childState.status !== "ready") return;
      const selectedChild = childState.child;

      try {
        const bookPromise = bookService.get(bookId);
        const pagesPromise = bookService
          .listPages(bookId)
          .then((result) => ({ ok: true as const, pages: result }))
          .catch((error: unknown) => ({ ok: false as const, error }));

        const book = await bookPromise;

        let pages: BookPagePreviewDTO[] = [];
        let previewUnavailable = false;
        const pagesOutcome = await pagesPromise;
        if (pagesOutcome.ok) {
          pages = [...pagesOutcome.pages].sort(
            (left, right) => left.page_number - right.page_number,
          );
          previewUnavailable = pages.length === 0;
        } else if (
          isServiceError(pagesOutcome.error) &&
          pagesOutcome.error.status === 503
        ) {
          previewUnavailable = true;
        } else {
          throw pagesOutcome.error;
        }

        if (isActive) {
          setState({
            status: "ready",
            book,
            child: selectedChild,
            pages,
            previewUnavailable,
          });
          // Nếu có targetPageId truyền từ dashboard sang thì ưu tiên chọn trang đó
          const matchedPage = targetPageId
            ? pages.find((p) => p.page_id === targetPageId)
            : null;
          // Never silently substitute page 1 when OCR supplied an invalid pageId.
          const startPage = targetPageId
            ? (matchedPage ?? null)
            : (pages[0] ?? null);
          setSelectedPage(startPage);
          if (startPage) {
            const startIdx = pages.findIndex(
              (p) => p.page_id === startPage.page_id,
            );
            setThumbnailPage(
              startIdx >= 0
                ? Math.floor(startIdx / THUMBNAILS_PER_PAGE) + 1
                : 1,
            );
          } else {
            setThumbnailPage(1);
          }
          setSelectedEndPageId(
            pages[pages.length - 1]?.page_id ?? startPage?.page_id ?? null,
          );
        }
      } catch (error) {
        if (!isActive) {
          return;
        }

        if (isServiceError(error) && error.code === "RESOURCE_NOT_FOUND") {
          setState({ status: "not-found" });
          return;
        }

        if (isServiceError(error) && error.code === "CONTENT_INACTIVE") {
          setState({ status: "unavailable" });
          return;
        }

        setState({ status: "error" });
      }
    }

    void loadDetail();
    return () => {
      isActive = false;
    };
  }, [
    bookId,
    bookService,
    childState,
    currentUserId,
    requestKey,
    targetPageId,
  ]);

  useEffect(() => {
    if (
      state.status !== "ready" ||
      !targetPageId ||
      !state.pages.some((candidate) => candidate.page_id === targetPageId)
    ) {
      return;
    }
    const btn = document.getElementById("start-reading-button");
    if (btn) {
      const prefersReducedMotion =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      btn.scrollIntoView?.({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "center",
      });
      btn.focus();
    }
  }, [state, targetPageId]);

  function handleStartReading() {
    if (
      state.status !== "ready" ||
      !state.child ||
      !selectedPage ||
      !selectedEndPageId ||
      selectedRangeHasGap ||
      startState === "starting"
    ) {
      return;
    }

    setStartState("starting");
    const params = new URLSearchParams({
      bookId: state.book.id,
      pageId: selectedPage.page_id,
      endPageId: selectedEndPageId,
    });
    if (targetConfidence !== null) {
      params.set("confidence", String(targetConfidence));
    }
    router.push(`/reading-preparation?${params.toString()}`);
  }

  const booksHref = "/books";

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[900px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          {tc("verification.loading")}
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title={tc("verification.errorTitle")} tone="error">
          {tc("verification.errorBody")}
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />
          {tc("verification.retry")}
        </Button>
      </section>
    );
  }

  if (state.status === "loading") {
    return (
      <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-3.5 pt-0 pb-8 sm:gap-6 sm:px-8 sm:py-8">
        <BookChildHeader
          child={null}
          fullBleedDesktop
          mobileLabel={t("detail.loadingMobileLabel")}
        />
        <div
          aria-busy="true"
          aria-label={t("detail.loadingAria")}
          className="mx-auto flex w-full max-w-[1130px] flex-col gap-4 sm:flex-row sm:gap-12"
        >
          <span className="sr-only" role="status">
            {t("detail.loadingText")}
          </span>
          <Skeleton className="h-[132px] w-[96px] rounded-card sm:h-[518px] sm:w-[307px]" />
          <div className="flex flex-1 flex-col gap-3 sm:gap-4">
            <Skeleton className="h-10 w-3/5 sm:h-16" />
            <Skeleton className="h-6 w-2/5 sm:h-7" />
            <Skeleton className="h-16 w-4/5 sm:h-20" />
            <Skeleton className="h-12 w-full sm:h-16 sm:w-[360px]" />
          </div>
        </div>
      </section>
    );
  }

  if (state.status === "not-found" || state.status === "unavailable") {
    const unavailable = state.status === "unavailable";

    return (
      <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-3.5 pt-0 pb-8 sm:gap-6 sm:px-8 sm:py-8">
        <BookChildHeader
          child={null}
          fullBleedDesktop
          mobileLabel={t("detail.pageTitle")}
        />
        <div className="mx-auto w-full max-w-[720px]">
          <EmptyState
            headingLevel={1}
            action={
              <ButtonLink
                className="max-w-80"
                href={booksHref}
                variant="secondary"
              >
                <ArrowLeft
                  aria-hidden="true"
                  className="viread-rtl-flip size-5"
                />
                {t("detail.backToLibrary")}
              </ButtonLink>
            }
            description={
              unavailable
                ? t("detail.unavailableDescription")
                : t("detail.notFoundDescription")
            }
            icon={<BookX aria-hidden="true" className="size-10 text-primary" />}
            title={
              unavailable
                ? t("detail.unavailableTitle")
                : t("detail.notFoundTitle")
            }
          />
        </div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-3.5 pt-0 pb-8 sm:gap-6 sm:px-8 sm:py-8">
        <BookChildHeader
          child={null}
          fullBleedDesktop
          mobileLabel={t("detail.pageTitle")}
        />
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          <StatusMessage title={t("detail.loadErrorTitle")} tone="error">
            {t("catalog.loadErrorBody")}
          </StatusMessage>
          <Button
            className="sm:w-auto sm:self-start sm:px-8"
            onClick={() => setRequestKey((key) => key + 1)}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-5" />
            {t("catalog.retry")}
          </Button>
        </div>
      </section>
    );
  }

  const { book, child, pages, previewUnavailable } = state;
  const selectedEndPage =
    pages.find((candidate) => candidate.page_id === selectedEndPageId) ?? null;
  const selectedRangePages =
    selectedPage && selectedEndPage
      ? pages.filter(
          (candidate) =>
            candidate.page_number >= selectedPage.page_number &&
            candidate.page_number <= selectedEndPage.page_number,
        )
      : [];
  const selectedRangeHasGap =
    selectedRangePages.some(
      (candidate, index) =>
        candidate.page_number !==
        (index === 0
          ? selectedPage?.page_number
          : (selectedRangePages[index - 1]?.page_number ?? 0) + 1),
    ) ||
    Boolean(
      selectedPage &&
      selectedEndPage &&
      (selectedRangePages[0]?.page_number !== selectedPage.page_number ||
        selectedRangePages[selectedRangePages.length - 1]?.page_number !==
          selectedEndPage.page_number),
    );

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-3 px-3.5 pt-0 pb-24 sm:gap-6 sm:px-8 sm:py-8">
      {reportTarget ? (
        <BookContentReportDialog
          bookId={book.id}
          bookTitle={book.title}
          onClose={() => setReportTarget(null)}
          pageId={reportTarget.pageId}
          pageNumber={reportTarget.pageNumber}
        />
      ) : null}
      <BookChildHeader
        backHref={booksHref}
        child={child}
        fullBleedDesktop
        mobileLabel={book.title}
      />

      <div className="mx-auto grid w-full max-w-[1130px] grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-3 sm:grid-cols-[306px_minmax(0,1fr)] sm:items-start sm:gap-x-12 sm:gap-y-4">
        <article className="flex h-[132px] w-[96px] shrink-0 flex-col overflow-hidden rounded-card border border-border bg-white p-1.5 sm:row-span-6 sm:h-auto sm:w-[306px] sm:gap-3 sm:p-4">
          <BookCover
            book={book}
            className="detail-cover-jacket h-full w-full max-w-none sm:h-64 sm:p-4"
          />
        </article>

        <div className="flex min-w-0 flex-col justify-center gap-1.5 sm:justify-start sm:gap-3">
          {book.visibility_scope === "PARENT_PRIVATE" ? (
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 sm:px-3 sm:py-1 sm:text-xs">
                {t("card.privateFamilyBadge")}
              </span>
              <span className="hidden text-xs text-muted sm:inline">
                {t("detail.privateFamilyNote")}
              </span>
            </div>
          ) : null}
          <h1
            className="viread-learning-content line-clamp-3 break-words text-lg font-extrabold leading-snug text-ink sm:line-clamp-none sm:text-4xl sm:leading-tight"
            dir="ltr"
            lang="vi"
          >
            {book.title}
          </h1>
          <p className="text-xs text-muted sm:text-body">
            {book.author ? (
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {book.author}
              </span>
            ) : (
              t("card.authorPending")
            )}{" "}
            ·{" "}
            <span className="font-semibold text-primary">
              {formatGradeRange(book, t)}
            </span>
          </p>
          {targetPageId &&
          targetConfidence !== null &&
          targetConfidence >= 0 &&
          targetConfidence <= 1 ? (
            <p className="text-xs font-semibold text-primary sm:text-sm">
              {t("detail.confidenceLabel", {
                percent: Math.round(targetConfidence * 100),
              })}{" "}
              <span className="sr-only">
                ({formatPercent(targetConfidence)})
              </span>
            </p>
          ) : null}
        </div>

        <div className="col-span-2 flex min-w-0 flex-col gap-3 sm:col-span-1 sm:col-start-2 sm:gap-4">
          {book.visibility_scope === "PARENT_PRIVATE" ? (
            <div className="order-last flex flex-wrap gap-2 border-t border-border pt-3 sm:pt-4">
              <ButtonLink
                href={`/my-books/${encodeURIComponent(book.id)}`}
                variant="secondary"
                className="min-h-10 text-xs sm:min-h-12 sm:w-auto sm:text-button"
              >
                {t("detail.manageInMyBooks")}
              </ButtonLink>
            </div>
          ) : (
            <div
              aria-label={t("detail.reportMenuAria")}
              role="group"
              className="order-last flex flex-wrap gap-2 border-t border-border pt-3 sm:pt-4"
            >
              <ButtonLink
                href="/book-reports"
                variant="quiet"
                className="min-h-10 w-auto px-3 text-xs sm:min-h-12 sm:px-4 sm:text-button"
              >
                <ClipboardList aria-hidden="true" className="size-4" />{" "}
                {t("detail.myReportsButton")}
              </ButtonLink>
              <Button
                className="min-h-10 w-auto px-3 text-xs sm:min-h-12 sm:px-4 sm:text-button"
                onClick={() =>
                  setReportTarget({ pageId: null, pageNumber: null })
                }
                variant="secondary"
              >
                {t("detail.reportBookButton")}
              </Button>
              <Button
                className="min-h-10 w-auto px-3 text-xs sm:min-h-12 sm:px-4 sm:text-button"
                disabled={!selectedPage}
                onClick={() =>
                  selectedPage
                    ? setReportTarget({
                        pageId: selectedPage.page_id,
                        pageNumber: selectedPage.page_number,
                      })
                    : undefined
                }
                variant="secondary"
              >
                {t("detail.reportPageButton")}
              </Button>
            </div>
          )}

          <p className="text-sm leading-relaxed text-ink sm:text-xl sm:font-medium sm:leading-7">
            {book.title === "Chú Mèo Nhỏ"
              ? t("detail.summaryLittleCat")
              : t("detail.summaryDefault", {
                  title: book.title.toLocaleLowerCase("vi"),
                })}
          </p>

          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-white/95 px-3.5 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(35,62,64,0.08)] backdrop-blur-sm sm:static sm:z-auto sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none">
            <Button
              id="start-reading-button"
              className="min-h-12 sm:min-h-16 sm:w-[360px]"
              disabled={
                !selectedPage ||
                !selectedEndPageId ||
                !child ||
                selectedRangeHasGap ||
                pages.length === 0
              }
              isLoading={startState === "starting"}
              onClick={handleStartReading}
            >
              {startState === "starting"
                ? t("detail.preparingButton")
                : t("detail.prepareButton")}
              {startState === "idle" ? (
                <ArrowRight
                  aria-hidden="true"
                  className="viread-rtl-flip size-5"
                />
              ) : null}
            </Button>
          </div>

          {targetPageId && !selectedPage ? (
            <StatusMessage
              title={t("detail.matchedPageMissingTitle")}
              tone="warning"
            >
              {t("detail.matchedPageMissingDescription")}
            </StatusMessage>
          ) : null}

          {selectedPage && selectedEndPage ? (
            <section className="rounded-card bg-sky px-3.5 py-2.5 sm:p-4">
              <h2 className="text-sm font-extrabold text-ink sm:text-base">
                {t("detail.readingRangeHeading", {
                  start: selectedPage.page_number,
                  end: selectedEndPage.page_number,
                })}
              </h2>
              <p className="mt-0.5 text-xs text-muted sm:mt-2 sm:text-body">
                {t("detail.readingRangeValidPages", {
                  count: selectedRangePages.length,
                })}
              </p>
            </section>
          ) : null}

          <div className="grid grid-cols-2 gap-2.5 sm:gap-4">
            <div className="flex min-h-[76px] flex-col justify-between gap-1 rounded-control border border-border bg-white p-3 sm:min-h-[96px] sm:p-4">
              <span className="text-xs font-semibold text-ink sm:text-sm">
                {t("detail.startPageLabel")}
              </span>
              <span className="text-sm font-bold text-primary sm:text-body sm:font-normal">
                {selectedPage
                  ? t("detail.pageNumberOption", {
                      page: selectedPage.page_number,
                    })
                  : t("detail.noPageSelected")}
              </span>
            </div>
            <div className="flex min-h-[76px] flex-col justify-between gap-1 rounded-control border border-border bg-white p-3 sm:min-h-[96px] sm:p-4">
              <label
                className="text-xs font-semibold text-ink sm:text-sm"
                htmlFor="reading-end-page"
              >
                {t("detail.endPageLabel")}
              </label>
              <select
                className="min-h-9 rounded-control border border-border bg-white px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-11 sm:px-3 sm:text-body"
                disabled={
                  !selectedPage ||
                  pages.length === 0 ||
                  startState === "starting"
                }
                id="reading-end-page"
                onChange={(event) => {
                  setSelectedEndPageId(event.target.value || null);
                  setStartState("idle");
                }}
                value={selectedEndPageId ?? ""}
              >
                {pages
                  .filter((candidate) =>
                    selectedPage
                      ? candidate.page_number >= selectedPage.page_number
                      : false,
                  )
                  .map((candidate) => (
                    <option key={candidate.page_id} value={candidate.page_id}>
                      {t("detail.pageNumberOption", {
                        page: candidate.page_number,
                      })}
                    </option>
                  ))}
              </select>
            </div>
            {selectedRangeHasGap ? (
              <div className="col-span-2">
                <StatusMessage
                  title={t("detail.nonContiguousTitle")}
                  tone="error"
                >
                  {t("detail.nonContiguousDescription")}
                </StatusMessage>
              </div>
            ) : null}
          </div>

          <div className="order-3">
            {previewUnavailable ? (
              <div className="mb-3 flex flex-col gap-2.5 sm:mb-4 sm:gap-3">
                <StatusMessage
                  title={t("detail.previewPendingTitle")}
                  tone="info"
                >
                  {t("detail.previewPendingDescription")}
                </StatusMessage>
                <Button
                  className="sm:w-auto sm:self-start"
                  onClick={() => setRequestKey((key) => key + 1)}
                  variant="secondary"
                >
                  <RefreshCw aria-hidden="true" className="size-5" />
                  {t("detail.retryImages")}
                </Button>
              </div>
            ) : null}
            <div
              aria-label={t("detail.previewGridAria")}
              className="no-scrollbar flex gap-2.5 overflow-x-auto pb-1 sm:gap-4"
            >
              {pages
                .slice(
                  (thumbnailPage - 1) * THUMBNAILS_PER_PAGE,
                  thumbnailPage * THUMBNAILS_PER_PAGE,
                )
                .map((page) => (
                  <BookPageThumbnail
                    isSelected={selectedPage?.page_id === page.page_id}
                    key={page.page_id}
                    onSelect={(nextPage) => {
                      setSelectedPage(nextPage);
                      setSelectedEndPageId((currentEndId) => {
                        const currentEnd = pages.find(
                          (candidate) => candidate.page_id === currentEndId,
                        );
                        return !currentEnd ||
                          currentEnd.page_number < nextPage.page_number
                          ? nextPage.page_id
                          : currentEnd.page_id;
                      });
                      setStartState("idle");
                    }}
                    page={page}
                  />
                ))}
            </div>
            {pages.length > THUMBNAILS_PER_PAGE ? (
              <PaginationBar
                ariaLabel={t("detail.previewPaginationAria")}
                className="mt-3"
                compact
                itemLabel={t("detail.previewPaginationItemLabel")}
                onPageChange={setThumbnailPage}
                page={thumbnailPage}
                pageSize={THUMBNAILS_PER_PAGE}
                total={pages.length}
              />
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
