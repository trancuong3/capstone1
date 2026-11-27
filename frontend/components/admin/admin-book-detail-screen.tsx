"use client";

import {
  AlertTriangle,
  Clock3,
  Info,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminBookAiBatchReview } from "@/components/admin/admin-book-ai-batch-review";
import { AdminPageImagePreview } from "@/components/admin/admin-page-image-preview";
import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import {
  AdminBadge,
  AdminLoading,
  AdminPageHeader,
  AdminResultsPagination,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { BookCover } from "@/components/books/book-cover";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { OcrServiceStatusBanner } from "@/components/common/ocr-service-status-banner";
import { StatusMessage } from "@/components/common/status-message";
import { useSkippedAiPageIds } from "@/hooks/use-admin-ai-batch-skipped-pages";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useOcrWorkerStatus } from "@/hooks/use-ocr-worker-status";
import {
  cancelAdminOcrJob,
  isActiveAdminOcrJobStatus,
  retryAdminOcrJob,
  type AdminOcrJobDTO,
} from "@/lib/api/admin-page-service";
import { clearApiReadCache } from "@/lib/api/read-cache";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookDTO, AdminPageListItemUI } from "@/types/admin";
import type { AssetSourceType } from "@/types/book-assets";

export function AdminBookDetailScreen({ bookId }: { bookId: string }) {
  const { books, pages } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDateTime, formatNumber } = useI18n();
  const skippedAiPageIds = useSkippedAiPageIds(bookId);
  const pageSize = 24;
  const [pageNumber, setPageNumber] = useState(1);
  const [book, setBook] = useState<AdminBookDTO | null>(null);
  const [items, setItems] = useState<readonly AdminPageListItemUI[] | null>(
    null,
  );
  const [ocrJobs, setOcrJobs] = useState<readonly AdminOcrJobDTO[]>([]);
  const [error, setError] = useState<"not-found" | "safe" | null>(null);
  const [pagesUnavailable, setPagesUnavailable] = useState(false);
  const [pendingRetire, setPendingRetire] =
    useState<AdminPageListItemUI | null>(null);
  const [retiringPageId, setRetiringPageId] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [uploaderOpenOverride, setUploaderOpenOverride] = useState<
    boolean | null
  >(null);
  const [aiBatchOpen, setAiBatchOpen] = useState(false);
  const [pageActionNotice, setPageActionNotice] = useState<{
    tone: "error" | "info";
    title: string;
    message: string;
  } | null>(null);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const fetchBookOcrJobs = useCallback(async () => {
    if (typeof pages.listOcrJobs !== "function") return [];
    try {
      return await pages.listOcrJobs(bookId);
    } catch {
      return [];
    }
  }, [bookId, pages]);
  const load = useCallback(
    async (options?: { resetPage?: boolean }) => {
      const requestId = ++requestIdRef.current;
      if (options?.resetPage) setPageNumber(1);
      setError(null);
      setBook(null);
      setItems(null);
      setPagesUnavailable(false);
      try {
        const bookPromise = books.get(bookId);
        const pagesPromise = pages
          .list(bookId)
          .then((list) => ({ ok: true as const, list }))
          .catch((cause: unknown) => ({ ok: false as const, cause }));
        const jobsPromise = fetchBookOcrJobs();

        const nextBook = await bookPromise;
        if (requestId !== requestIdRef.current) return;
        setBook(nextBook);

        const [pagesOutcome, nextJobs] = await Promise.all([
          pagesPromise,
          jobsPromise,
        ]);
        if (requestId !== requestIdRef.current) return;
        setOcrJobs(nextJobs);
        if (!pagesOutcome.ok) {
          if (
            isServiceError(pagesOutcome.cause) &&
            [501, 503].includes(pagesOutcome.cause.status)
          ) {
            setPagesUnavailable(true);
            setItems([]);
            return;
          }
          throw pagesOutcome.cause;
        }

        const nextPages = pagesOutcome.list.filter(
          (item) => item.processing.lifecycle_status === "ACTIVE",
        );
        const maxPage = Math.max(1, Math.ceil(nextPages.length / pageSize));
        setPageNumber((current) => Math.min(current, maxPage));
        setItems(nextPages);
      } catch (cause) {
        if (requestId !== requestIdRef.current) return;
        setError(
          isServiceError(cause) && cause.code === "RESOURCE_NOT_FOUND"
            ? "not-found"
            : "safe",
        );
        setItems([]);
      }
    },
    [bookId, books, fetchBookOcrJobs, pageSize, pages],
  );

  const refreshPages = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const [rawPages, nextJobs] = await Promise.all([
        pages.list(bookId),
        fetchBookOcrJobs(),
      ]);
      const nextPages = rawPages.filter(
        (item) => item.processing.lifecycle_status === "ACTIVE",
      );
      if (requestId !== requestIdRef.current) return;
      const maxPage = Math.max(1, Math.ceil(nextPages.length / pageSize));
      setPageNumber((current) => Math.min(current, maxPage));
      setItems(nextPages);
      setOcrJobs(nextJobs);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setPageActionNotice({
        tone: "error",
        title: t("books.detail.refreshErrorTitle"),
        message: t("books.detail.refreshErrorDesc"),
      });
    }
  }, [bookId, fetchBookOcrJobs, pages, t]);

  const ocrWorkerStatus = useOcrWorkerStatus({
    onRecovered: () => {
      clearApiReadCache();
      void refreshPages();
    },
  });

  async function handleCancelOcrJob(jobId: string) {
    if (busyJobId !== null) return;
    setBusyJobId(jobId);
    setPageActionNotice(null);
    try {
      if (typeof pages.cancelOcrJob === "function") {
        await pages.cancelOcrJob(jobId);
      } else {
        await cancelAdminOcrJob(jobId);
      }
      clearApiReadCache();
      await refreshPages();
      if (!mountedRef.current) return;
      setPageActionNotice({
        tone: "info",
        title: t(
          "books.detail.cancelQueuedJobSuccess",
          undefined,
          "Đã hủy tác vụ OCR đang chờ.",
        ),
        message: t(
          "books.detail.cancelQueuedJobSuccess",
          undefined,
          "Đã hủy tác vụ OCR đang chờ.",
        ),
      });
    } catch {
      if (!mountedRef.current) return;
      setPageActionNotice({
        tone: "error",
        title: t(
          "books.detail.cancelQueuedJobError",
          undefined,
          "Không thể hủy tác vụ OCR lúc này. Vui lòng thử lại.",
        ),
        message: t(
          "books.detail.cancelQueuedJobError",
          undefined,
          "Không thể hủy tác vụ OCR lúc này. Vui lòng thử lại.",
        ),
      });
    } finally {
      if (mountedRef.current) setBusyJobId(null);
    }
  }

  async function handleRetryOcrJob(jobId: string) {
    if (busyJobId !== null) return;
    setBusyJobId(jobId);
    setPageActionNotice(null);
    try {
      if (typeof pages.retryOcrJob === "function") {
        await pages.retryOcrJob(jobId);
      } else {
        await retryAdminOcrJob(jobId);
      }
      clearApiReadCache();
      await refreshPages();
      if (!mountedRef.current) return;
      setPageActionNotice({
        tone: "info",
        title: t(
          "books.detail.retryOcrJobSuccess",
          undefined,
          "Đã đưa tác vụ OCR vào hàng chờ thử lại.",
        ),
        message: t(
          "books.detail.retryOcrJobSuccess",
          undefined,
          "Đã đưa tác vụ OCR vào hàng chờ thử lại.",
        ),
      });
    } catch {
      if (!mountedRef.current) return;
      setPageActionNotice({
        tone: "error",
        title: t(
          "books.detail.retryOcrJobError",
          undefined,
          "Không thể thử lại tác vụ OCR lúc này. Vui lòng thử lại.",
        ),
        message: t(
          "books.detail.retryOcrJobError",
          undefined,
          "Không thể thử lại tác vụ OCR lúc này. Vui lòng thử lại.",
        ),
      });
    } finally {
      if (mountedRef.current) setBusyJobId(null);
    }
  }
  async function retirePendingPage() {
    const item = pendingRetire;
    const pageId = item?.processing.page_id;
    if (!item || !pageId || retiringPageId !== null) return;
    const requestId = requestIdRef.current;
    setRetiringPageId(pageId);
    setPageActionNotice(null);
    try {
      const result = await pages.retire(pageId);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (
        result.lifecycle_status !== "RETIRED" ||
        result.page_id !== pageId ||
        result.book_id !== bookId
      ) {
        throw new Error("Unexpected page lifecycle response");
      }
      // Remove the row immediately after Backend confirmation, then reload from
      // PostgreSQL so the UI never relies on an optimistic-only deletion.
      setItems(
        (current) =>
          current?.filter((entry) => entry.processing.page_id !== pageId) ?? [],
      );
      setPendingRetire(null);
      setRetiringPageId(null);
      setPageActionNotice({
        tone: "info",
        title: t("books.detail.pageRetiredTitle"),
        message: t("books.detail.pageRetiredMsg", {
          pageNumber: item.page_number,
        }),
      });
      await load();
    } catch {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setPageActionNotice({
        tone: "error",
        title: t("books.detail.deletePageErrorTitle"),
        message: t("books.detail.deletePageErrorMsg"),
      });
    } finally {
      if (mountedRef.current) setRetiringPageId(null);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const timeout = globalThis.setTimeout(() => void load(), 0);
    return () => {
      mountedRef.current = false;
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);

  const activeOcrJobs = ocrJobs.filter((job) =>
    isActiveAdminOcrJobStatus(job.status),
  );
  const deadLetterOcrJobs = ocrJobs.filter(
    (job) => job.status === "DEAD_LETTER",
  );
  const activeOcrJobsCount = activeOcrJobs.length;
  const ocrWorkerOffline =
    ocrWorkerStatus.isUnavailable ||
    activeOcrJobs.some((job) => job.worker_online === false);

  // Gently auto-poll active OCR jobs (12s when laptop worker is offline, 4s when online)
  // and refresh pages automatically as soon as any queued job finishes.
  useEffect(() => {
    if (activeOcrJobsCount === 0 || typeof pages.listOcrJobs !== "function") {
      return;
    }
    let active = true;
    let timerId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const delayMs = ocrWorkerOffline ? 12_000 : 4_000;

    const clearTimer = () => {
      if (timerId !== null) {
        globalThis.clearTimeout(timerId);
        timerId = null;
      }
    };

    const schedule = (ms: number) => {
      clearTimer();
      if (!active) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      timerId = globalThis.setTimeout(() => {
        void tick();
      }, ms);
    };

    const tick = async () => {
      if (!active) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      const nextJobs = await fetchBookOcrJobs();
      if (!active) return;
      const nextActiveCount = nextJobs.filter((job) =>
        isActiveAdminOcrJobStatus(job.status),
      ).length;
      setOcrJobs(nextJobs);
      if (nextActiveCount < activeOcrJobsCount) {
        clearApiReadCache();
        await refreshPages();
        return;
      }
      if (nextActiveCount > 0) {
        const nextOffline = nextJobs.some(
          (job) =>
            isActiveAdminOcrJobStatus(job.status) &&
            job.worker_online === false,
        );
        schedule(nextOffline ? 12_000 : 4_000);
      }
    };

    const onVisibilityChange = () => {
      if (!active) return;
      if (document.visibilityState === "hidden") {
        clearTimer();
      } else {
        schedule(400);
      }
    };

    schedule(delayMs);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      active = false;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [
    activeOcrJobsCount,
    fetchBookOcrJobs,
    ocrWorkerOffline,
    pages,
    refreshPages,
  ]);

  const pageStats = useMemo(() => {
    const list = items ?? [];
    let verified = 0;
    let needsReview = 0;
    let processing = 0;
    for (const item of list) {
      if (item.processing.verification_status === "VERIFIED") verified += 1;
      else if (item.processing.verification_status === "NEEDS_REVIEW")
        needsReview += 1;
      else if (item.processing.verification_status === "PROCESSING")
        processing += 1;
    }
    return {
      total: list.length,
      verified,
      needsReview,
      processing,
    };
  }, [items]);

  if (!book && !error) return <AdminLoading variant="skeleton" />;
  if (error) {
    return (
      <EmptyState
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void load()}
              size="admin"
              variant="secondary"
            >
              {t("common.retry")}
            </Button>
            <Link
              className="inline-flex min-h-10 items-center rounded-md px-1 font-extrabold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/books"
            >
              {t("books.detail.backToBooks")}
            </Link>
          </div>
        }
        description={
          error === "not-found"
            ? t("books.detail.notFoundDesc")
            : t("books.detail.genericErrorDesc")
        }
        headingLevel={1}
        title={
          error === "not-found"
            ? t("books.detail.notFoundTitle")
            : t("books.detail.loadErrorTitle")
        }
      />
    );
  }
  if (!book) return null;
  const activePageIds = new Set(
    (items ?? []).map((item) => item.processing.page_id),
  );
  const activeJobByPageId = new Map<string, AdminOcrJobDTO>();
  for (const job of activeOcrJobs) {
    if (job.page_id && !activeJobByPageId.has(job.page_id)) {
      activeJobByPageId.set(job.page_id, job);
    }
  }
  const pendingNewPageJobs = activeOcrJobs.filter(
    (job) =>
      job.job_kind === "ADMIN_PAGE_UPLOAD" &&
      (!job.page_id || !activePageIds.has(job.page_id)),
  );

  const resolvedTitle = book.title.trim()
    ? book.title
    : t("books.detail.missingTitle");
  const isUploaderExpanded =
    uploaderOpenOverride ?? (items !== null && items.length === 0);
  const visibleItems = items?.slice(
    (pageNumber - 1) * pageSize,
    pageNumber * pageSize,
  );
  const showPagination = items !== null && items.length > pageSize;

  return (
    <div className="space-y-4">
      <AdminPageHeader
        actions={
          <ButtonLink
            href={`/admin/books/${encodeURIComponent(book.id)}/edit`}
            size="admin"
            variant="outline"
          >
            <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
            {t("books.detail.editMetadata")}
          </ButtonLink>
        }
        badge={<AdminStatusBadge status={book.lifecycle_status} />}
        breadcrumbs={[
          { label: t("books.detail.backToBooks"), href: "/admin/books" },
          { label: resolvedTitle },
        ]}
        eyebrow={t("books.detail.eyebrow")}
        title={resolvedTitle}
      />

      <OcrServiceStatusBanner
        body={
          ocrWorkerStatus.status === "unreachable"
            ? t(
                "books.uploader.workerUnreachableBody",
                undefined,
                "Hệ thống đang khởi động hoặc mạng chậm. Bạn vẫn có thể bấm Kiểm tra lại hoặc tải lên để xếp hàng xử lý.",
              )
            : t(
                "books.uploader.workerOfflineBody",
                undefined,
                "Bạn vẫn có thể tải ảnh hoặc PDF/DOCX ngay bây giờ: hệ thống sẽ xếp hàng an toàn và tự động chạy OCR khi dịch vụ xử lý OCR hoạt động.",
              )
        }
        isChecking={ocrWorkerStatus.isChecking}
        justRecovered={ocrWorkerStatus.justRecovered}
        onDismissRecovered={ocrWorkerStatus.dismissRecoveredNotice}
        onRecheck={() => void ocrWorkerStatus.recheckNow()}
        queuedCount={activeOcrJobsCount}
        recheckLabel={t(
          "books.uploader.recheckWorkerBtn",
          undefined,
          "Kiểm tra lại kết nối OCR",
        )}
        recoveredMessage={t(
          "books.detail.ocrRecoveredNotice",
          undefined,
          "Dịch vụ xử lý OCR đã hoạt động trở lại — đang tự động cập nhật tiến trình trang sách.",
        )}
        status={ocrWorkerStatus.status}
        title={
          ocrWorkerStatus.status === "unreachable"
            ? t(
                "books.uploader.workerUnreachableTitle",
                undefined,
                "Chưa kiểm tra được trạng thái dịch vụ OCR",
              )
            : t(
                "books.uploader.workerOfflineTitle",
                undefined,
                "Dịch vụ xử lý OCR hiện đang ngoại tuyến",
              )
        }
        variant="admin"
      />

      {/* Compact Book Summary Strip */}
      <section
        aria-label={t(
          "books.detail.summaryStripAria",
          undefined,
          "Tóm tắt sách",
        )}
        className="rounded-xl border border-border bg-white p-4 shadow-2xs"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3.5">
            <BookCover
              author={book.author}
              book={book}
              className="h-16! w-12! shrink-0 rounded-md!"
              coverSourceType={
                (book.cover_source_type as AssetSourceType | null) ?? null
              }
              coverUrl={book.cover_url ?? null}
              showTitle={false}
              size="small"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold text-ink">
                {t("books.detail.description", {
                  name: book.name?.trim() ? book.name : t("books.missingName"),
                  author: book.author ?? t("books.missingAuthor"),
                  minGrade: book.min_grade,
                  maxGrade: book.max_grade,
                })}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <div className="rounded-lg border border-border bg-surface-subtle/60 px-3 py-1.5 text-center tabular-nums">
              <span className="block text-[11px] font-semibold text-muted">
                {t("books.detail.statTotalPages", undefined, "Tổng trang")}
              </span>
              <span className="text-sm font-extrabold text-ink">
                {items ? formatNumber(pageStats.total) : "—"}
              </span>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-success-surface/60 px-3 py-1.5 text-center tabular-nums">
              <span className="block text-[11px] font-semibold text-success-ink">
                {t("books.detail.statVerified", undefined, "Đã duyệt")}
              </span>
              <span className="text-sm font-extrabold text-success-ink">
                {items ? formatNumber(pageStats.verified) : "—"}
              </span>
            </div>
            <div className="rounded-lg border border-amber-200 bg-warning-surface/60 px-3 py-1.5 text-center tabular-nums">
              <span className="block text-[11px] font-semibold text-warning">
                {t("books.detail.statNeedsReview", undefined, "Cần duyệt")}
              </span>
              <span className="text-sm font-extrabold text-warning">
                {items ? formatNumber(pageStats.needsReview) : "—"}
              </span>
            </div>
            <div className="rounded-lg border border-primary/20 bg-sky/40 px-3 py-1.5 text-center tabular-nums">
              <span className="block text-[11px] font-semibold text-primary-hover">
                {t(
                  "books.detail.statProcessing",
                  undefined,
                  "Đang xử lý / Hàng chờ OCR",
                )}
              </span>
              <span
                className="text-sm font-extrabold text-primary-hover"
                data-testid="admin-book-kpi-processing-count"
              >
                {items
                  ? formatNumber(
                      pageStats.processing + pendingNewPageJobs.length,
                    )
                  : "—"}
              </span>
            </div>
          </div>
        </div>

        <details className="mt-3 border-t border-border pt-2.5 text-xs text-muted">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary">
            <Info aria-hidden="true" className="size-3.5 shrink-0" />
            <span>
              {t(
                "books.detail.publishRuleToggle",
                undefined,
                "Quy tắc mở cho thư viện trẻ em",
              )}
            </span>
          </summary>
          <p className="mt-2 leading-relaxed text-muted">
            <strong className="text-ink">
              {t("books.detail.notPublishedTitle")}:
            </strong>{" "}
            {t("books.detail.notPublishedDesc")}
          </p>
        </details>
      </section>

      {/* Pages Section with Compact Top Action Strip + Sleek Collapsible Panels */}
      <section aria-labelledby="pages-title" className="space-y-4">
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-white px-4 py-3 shadow-2xs sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2
              className="text-lg font-extrabold tracking-tight text-ink"
              id="pages-title"
            >
              {t("books.detail.pagesHeading")}
            </h2>
            {items ? (
              <AdminBadge tone="neutral">
                {t("books.pagesCount", { count: items.length })}
              </AdminBadge>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              aria-expanded={isUploaderExpanded}
              onClick={() => setUploaderOpenOverride(!isUploaderExpanded)}
              size="admin"
              type="button"
              variant={isUploaderExpanded ? "primary" : "secondary"}
            >
              <UploadCloud aria-hidden="true" className="size-4 shrink-0" />
              {t("books.detail.toggleUploadBtn", undefined, "Tải trang lên")}
            </Button>

            {items && items.length > 0 ? (
              <Button
                aria-expanded={aiBatchOpen}
                onClick={() => setAiBatchOpen((open) => !open)}
                size="admin"
                type="button"
                variant={aiBatchOpen ? "primary" : "outline"}
              >
                <Sparkles aria-hidden="true" className="size-4 shrink-0" />
                {t(
                  "books.detail.toggleAiBatchBtn",
                  undefined,
                  "Chạy AI duyệt hàng loạt",
                )}
                {pageStats.needsReview > 0 ? (
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-extrabold text-warning tabular-nums">
                    {formatNumber(pageStats.needsReview)}
                  </span>
                ) : null}
              </Button>
            ) : null}

            <Button
              disabled={items === null || retiringPageId !== null}
              onClick={() => {
                clearApiReadCache();
                void load();
              }}
              size="admin"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className="size-4 shrink-0" />
              {t("common.reload")}
            </Button>
          </div>
        </div>
        {activeOcrJobs.length > 0 ? (
          <div
            className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50/85 p-4 text-amber-950"
            data-testid="admin-book-ocr-queue-banner"
            role="status"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-start gap-2.5">
                <Clock3
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-amber-700"
                />
                <div>
                  <p className="text-sm font-extrabold">
                    {ocrWorkerOffline
                      ? t("books.detail.ocrQueueOfflineBanner", {
                          count: formatNumber(activeOcrJobs.length),
                        })
                      : t("books.detail.ocrQueueOnlineBanner", {
                          count: formatNumber(activeOcrJobs.length),
                        })}
                  </p>
                  <p className="mt-1 text-xs text-amber-900">
                    {ocrWorkerOffline
                      ? t("books.detail.ocrQueueOfflineHint")
                      : t("books.detail.ocrQueueOnlineHint")}
                  </p>
                </div>
              </div>
              <Button
                onClick={() => {
                  clearApiReadCache();
                  void refreshPages();
                }}
                size="admin"
                type="button"
                variant="secondary"
              >
                <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
                {t("books.detail.ocrQueueCheckNow")}
              </Button>
            </div>
            {pendingNewPageJobs.length > 0 ? (
              <div className="space-y-2">
                {pendingNewPageJobs.map((job, idx) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs text-amber-950"
                    data-testid={`admin-queued-new-page-row-${job.id}`}
                    key={job.id}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 font-bold text-amber-950"
                        data-testid="admin-queued-new-page-badge"
                      >
                        <Clock3
                          aria-hidden="true"
                          className="size-3.5 text-amber-700"
                        />
                        {t("books.detail.queuedNewPageBadge", {
                          index: formatNumber(idx + 1),
                        })}
                      </span>
                      {job.file_name ? (
                        <span className="truncate font-semibold text-ink">
                          {t(
                            "books.detail.queuedNewPageFile",
                            { fileName: job.file_name },
                            `Tệp: ${job.file_name}`,
                          )}
                        </span>
                      ) : null}
                      {job.queue_position != null ? (
                        <span className="rounded-md bg-amber-100 px-2 py-0.5 font-bold text-amber-950 tabular-nums">
                          #{formatNumber(job.queue_position)}
                        </span>
                      ) : null}
                      {job.created_at ? (
                        <span className="text-muted">
                          {t(
                            "books.detail.queuedAtLabel",
                            { time: formatDateTime(job.created_at) },
                            `Đã xếp hàng lúc ${formatDateTime(job.created_at)}`,
                          )}
                        </span>
                      ) : null}
                    </div>
                    <Button
                      data-testid={`cancel-queued-ocr-job-${job.id}`}
                      disabled={busyJobId !== null}
                      isLoading={busyJobId === job.id}
                      onClick={() => void handleCancelOcrJob(job.id)}
                      size="admin"
                      type="button"
                      variant="outline"
                    >
                      <X aria-hidden="true" className="size-3.5 shrink-0" />
                      {t(
                        "books.detail.cancelQueuedJobBtn",
                        undefined,
                        "Hủy chờ",
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {deadLetterOcrJobs.length > 0 ? (
          <div
            className="flex flex-col gap-3 rounded-xl border border-danger/30 bg-danger-surface/65 p-4 text-ink"
            data-testid="admin-book-ocr-dead-letter-panel"
            role="region"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-danger"
              />
              <div>
                <p className="text-sm font-extrabold text-danger">
                  {t(
                    "books.detail.deadLetterHeading",
                    { count: formatNumber(deadLetterOcrJobs.length) },
                    `Tác vụ OCR gặp lỗi (${formatNumber(deadLetterOcrJobs.length)})`,
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {t(
                    "books.detail.deadLetterDesc",
                    undefined,
                    "Các tác vụ dưới đây chưa thể tự động hoàn tất OCR. Bạn có thể thử chạy lại hoặc hủy bỏ.",
                  )}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              {deadLetterOcrJobs.map((job) => {
                const matchedPage = job.page_id
                  ? items?.find((p) => p.processing.page_id === job.page_id)
                  : undefined;
                const label = job.file_name
                  ? job.file_name
                  : matchedPage
                    ? t("books.detail.pageNumber", {
                        pageNumber: formatNumber(matchedPage.page_number),
                      })
                    : t(
                        "books.detail.deadLetterPageFallback",
                        undefined,
                        "Tác vụ OCR trang mới",
                      );
                const ts = job.completed_at ?? job.updated_at ?? job.created_at;
                return (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/25 bg-white px-3 py-2.5 text-xs"
                    data-testid={`admin-dead-letter-job-${job.id}`}
                    key={job.id}
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-extrabold text-ink">{label}</span>
                        {ts ? (
                          <span className="text-muted">
                            {formatDateTime(ts)}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-danger">
                        {job.error_message ||
                          t(
                            "books.detail.deadLetterFallbackError",
                            undefined,
                            "Xử lý OCR không thành công. Hãy thử lại hoặc kiểm tra tệp trang sách.",
                          )}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        data-testid={`retry-dead-letter-job-${job.id}`}
                        disabled={busyJobId !== null}
                        isLoading={busyJobId === job.id}
                        onClick={() => void handleRetryOcrJob(job.id)}
                        size="admin"
                        type="button"
                        variant="secondary"
                      >
                        <RotateCcw
                          aria-hidden="true"
                          className="size-3.5 shrink-0"
                        />
                        {t(
                          "books.detail.retryOcrJobBtn",
                          undefined,
                          "Thử lại OCR",
                        )}
                      </Button>
                      <Button
                        data-testid={`cancel-dead-letter-job-${job.id}`}
                        disabled={busyJobId !== null}
                        onClick={() => void handleCancelOcrJob(job.id)}
                        size="admin"
                        type="button"
                        variant="outline"
                      >
                        <X aria-hidden="true" className="size-3.5 shrink-0" />
                        {t(
                          "books.detail.dismissDeadLetterBtn",
                          undefined,
                          "Hủy",
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Always mounted so tests/sessions preserve state; collapsed visually when pages already exist */}
        <AdminPageUploader
          bookId={book.id}
          collapsed={!isUploaderExpanded}
          ocrWorkerStatus={ocrWorkerStatus}
          onUploaded={refreshPages}
        />

        {items && items.length > 0 ? (
          <section aria-label={t("books.detail.batchReviewAria")}>
            <AdminBookAiBatchReview
              bookId={book.id}
              collapsed={!aiBatchOpen}
              items={items}
              onCompleted={() => void refreshPages()}
            />
          </section>
        ) : null}
        {pageActionNotice ? (
          <StatusMessage
            title={pageActionNotice.title}
            tone={pageActionNotice.tone}
          >
            {pageActionNotice.message}
          </StatusMessage>
        ) : null}

        {!items ? (
          <AdminLoading variant="skeleton" />
        ) : pagesUnavailable ? (
          <StatusMessage
            title={t("books.detail.pageDataPendingTitle")}
            tone="info"
          >
            {t("books.detail.pageDataPendingDesc")}
          </StatusMessage>
        ) : items.length === 0 &&
          activeOcrJobs.length === 0 &&
          deadLetterOcrJobs.length === 0 ? (
          <EmptyState
            description={t("books.detail.emptyPagesDesc")}
            title={t("books.detail.emptyPagesTitle")}
          />
        ) : items.length === 0 ? null : (
          <div className="space-y-4">
            {showPagination ? (
              <AdminResultsPagination
                itemLabel={t("books.detail.pageItemLabel")}
                onPageChange={setPageNumber}
                page={pageNumber}
                pageSize={pageSize}
                total={items.length}
              />
            ) : null}

            <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
              {visibleItems?.map((item) => {
                const active = item.processing.lifecycle_status === "ACTIVE";
                const queuedPageJob = activeJobByPageId.get(
                  item.processing.page_id,
                );
                return (
                  <article
                    className="flex h-full flex-col gap-3 rounded-xl border border-border bg-white p-4 shadow-2xs transition-colors hover:border-primary/35"
                    key={item.processing.page_id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-extrabold text-ink">
                          {t("books.detail.pageNumber", {
                            pageNumber: formatNumber(item.page_number),
                          })}
                        </h3>
                        <span className="rounded-md bg-surface-subtle px-1.5 py-0.5 text-[11px] font-bold text-muted">
                          Bản {item.processing.revision_no}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <AdminStatusBadge
                          status={
                            active
                              ? item.processing.verification_status
                              : "RETIRED"
                          }
                        />
                        {queuedPageJob ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-extrabold text-amber-950"
                            data-testid="admin-page-queued-ocr-badge"
                          >
                            <Clock3 aria-hidden="true" className="size-3.5" />
                            {queuedPageJob.worker_online === false
                              ? t("books.detail.pageQueuedOfflineBadge")
                              : t("books.detail.pageQueuedOnlineBadge")}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {item.processing.verification_status === "VERIFIED" &&
                    item.processing.ocr_preview_metadata.ai_review_required ===
                      true ? (
                      <AdminBadge tone="danger">
                        {t("books.detail.aiAutoVerifiedWarning")}
                      </AdminBadge>
                    ) : null}

                    {item.processing.verification_status === "NEEDS_REVIEW" &&
                    (skippedAiPageIds.has(item.processing.page_id) ||
                      skippedAiPageIds.has(
                        item.processing.page_revision_id,
                      )) ? (
                      <AdminBadge tone="danger">
                        {t("books.detail.adminVerifyForTrainingWarning")}
                      </AdminBadge>
                    ) : null}

                    <p className="line-clamp-2 break-words rounded-lg bg-surface-subtle/70 px-3 py-2 text-xs leading-5 text-ink">
                      {item.text_preview?.trim() ? (
                        <span
                          className="viread-learning-content"
                          dir="ltr"
                          lang="vi"
                        >
                          {item.text_preview}
                        </span>
                      ) : (
                        <span className="text-muted">
                          {t("books.detail.noOcrPreview")}
                        </span>
                      )}
                    </p>

                    <AdminPageImagePreview
                      key={`${item.processing.page_id}:${item.processing.page_revision_id}`}
                      onReplaced={({ queued, message }) => {
                        if (queued) {
                          setPageActionNotice({
                            tone: "info",
                            title: t(
                              "books.detail.queuedReuploadTitle",
                              undefined,
                              "Ảnh mới đã vào hàng chờ OCR",
                            ),
                            message:
                              message ||
                              t("books.detail.pageQueuedOfflineBadge"),
                          });
                        } else {
                          setPageActionNotice({
                            tone: "info",
                            title: t("books.detail.pendingImageTitle"),
                            message: t("books.detail.pendingImageDesc"),
                          });
                        }
                        clearApiReadCache();
                        void refreshPages();
                      }}
                      pageId={item.processing.page_id}
                      pageNumber={item.page_number}
                      revisionId={item.processing.page_revision_id}
                    />

                    <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-border pt-3">
                      <ButtonLink
                        className="w-full whitespace-nowrap"
                        href={`/admin/books/${book.id}/pages/${item.processing.page_id}`}
                        size="admin"
                        variant="secondary"
                      >
                        {active
                          ? t(
                              "books.detail.openOcrShort",
                              undefined,
                              "Mở duyệt OCR",
                            )
                          : t("books.detail.openHistoryAction")}
                      </ButtonLink>
                      {active ? (
                        <Button
                          disabled={retiringPageId !== null}
                          onClick={() => {
                            setPageActionNotice(null);
                            setPendingRetire(item);
                          }}
                          size="admin"
                          variant="destructive-outline"
                        >
                          <Trash2
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                          />
                          {t("books.detail.deletePage")}
                        </Button>
                      ) : (
                        <AdminBadge tone="neutral">
                          {t("books.detail.retiredBadge")}
                        </AdminBadge>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            {showPagination ? (
              <AdminResultsPagination
                itemLabel={t("books.detail.pageItemLabel")}
                onPageChange={setPageNumber}
                page={pageNumber}
                pageSize={pageSize}
                total={items.length}
              />
            ) : null}
          </div>
        )}
      </section>

      <Modal
        closeOnBackdropClick={retiringPageId === null}
        closeOnEscape={retiringPageId === null}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={retiringPageId !== null}
              fullWidth={false}
              onClick={() => setPendingRetire(null)}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={retiringPageId !== null}
              fullWidth={false}
              isLoading={
                pendingRetire !== null &&
                retiringPageId === pendingRetire.processing.page_id
              }
              onClick={() => void retirePendingPage()}
              size="admin"
              type="button"
              variant="destructive"
            >
              {t("books.detail.deletePage")}
            </Button>
          </div>
        }
        isOpen={pendingRetire !== null}
        onClose={() => {
          if (retiringPageId === null) setPendingRetire(null);
        }}
        role="alertdialog"
        showCloseButton={retiringPageId === null}
        title={
          pendingRetire
            ? t("books.detail.confirmDeletePageTitle", {
                pageNumber: formatNumber(pendingRetire.page_number),
              })
            : t("books.detail.confirmDeletePageTitleFallback")
        }
        tone="paper"
      >
        <p className="text-sm leading-6 text-muted">
          {t("books.detail.confirmDeletePageDesc")}
        </p>
      </Modal>
    </div>
  );
}
