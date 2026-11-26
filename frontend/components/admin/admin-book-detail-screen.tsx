"use client";

import { ArrowLeft, Clock3, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminLoading,
  AdminPageHeader,
  AdminResultsPagination,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useSkippedAiPageIds } from "@/hooks/use-admin-ai-batch-skipped-pages";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import { AdminPageImagePreview } from "@/components/admin/admin-page-image-preview";
import { AdminBookAiBatchReview } from "@/components/admin/admin-book-ai-batch-review";
import {
  isActiveAdminOcrJobStatus,
  type AdminOcrJobDTO,
} from "@/lib/api/admin-page-service";
import { clearApiReadCache } from "@/lib/api/read-cache";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookDTO, AdminPageListItemUI } from "@/types/admin";

export function AdminBookDetailScreen({ bookId }: { bookId: string }) {
  const { books, pages } = useAdminServices();
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
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
  const activeOcrJobsCount = activeOcrJobs.length;
  const ocrWorkerOffline = activeOcrJobs.some(
    (job) => job.worker_online === false,
  );

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

  if (!book && !error) return <AdminLoading />;
  if (error)
    return (
      <EmptyState
        headingLevel={1}
        title={
          error === "not-found"
            ? t("books.detail.notFoundTitle")
            : t("books.detail.loadErrorTitle")
        }
        description={
          error === "not-found"
            ? t("books.detail.notFoundDesc")
            : t("books.detail.genericErrorDesc")
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void load()} variant="secondary">
              {t("common.retry")}
            </Button>
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/books"
            >
              {t("books.detail.backToBooks")}
            </Link>
          </div>
        }
      />
    );
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
  const visibleItems = items?.slice(
    (pageNumber - 1) * pageSize,
    pageNumber * pageSize,
  );
  return (
    <>
      <AdminPageHeader
        eyebrow={t("books.detail.eyebrow")}
        title={book.title.trim() ? book.title : t("books.detail.missingTitle")}
        description={t("books.detail.description", {
          name: book.name?.trim() ? book.name : t("books.missingName"),
          author: book.author ?? t("books.missingAuthor"),
          minGrade: book.min_grade,
          maxGrade: book.max_grade,
        })}
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Link
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-control bg-white px-4 font-bold text-ink focus-visible:outline-3 focus-visible:outline-primary"
          href="/admin/books"
        >
          <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />{" "}
          {t("books.detail.backToBooks")}
        </Link>
        <Link
          className="inline-flex min-h-12 items-center justify-center rounded-control bg-sky px-4 font-bold text-primary focus-visible:outline-3 focus-visible:outline-primary"
          href={`/admin/books/${encodeURIComponent(book.id)}/edit`}
        >
          {t("books.detail.editMetadata")}
        </Link>
        <Link
          className="inline-flex min-h-12 items-center justify-center rounded-control border border-border bg-white px-4 font-bold text-ink hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary"
          href="/admin/tasks"
        >
          Trung tâm tác vụ AI
        </Link>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <AdminStatusBadge status={book.lifecycle_status} />
        <span className="break-all text-sm text-muted">ID: {book.id}</span>
      </div>
      <StatusMessage
        className="mb-6"
        tone="info"
        title={t("books.detail.notPublishedTitle")}
      >
        {t("books.detail.notPublishedDesc")}
      </StatusMessage>
      <AdminPageUploader bookId={book.id} onUploaded={refreshPages} />
      {items && items.length > 0 ? (
        <section
          className="mt-6"
          aria-label={t("books.detail.batchReviewAria")}
        >
          <AdminBookAiBatchReview
            bookId={book.id}
            items={items}
            onCompleted={() => void refreshPages()}
          />
        </section>
      ) : null}
      <section className="mt-8" aria-labelledby="pages-title">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black" id="pages-title">
              {t("books.detail.pagesHeading")}
            </h2>
            {items ? (
              <p className="mt-1 text-sm text-muted">
                {t("books.pagesCount", { count: items.length })}
              </p>
            ) : null}
          </div>
          <Button
            className="sm:w-auto"
            disabled={items === null || retiringPageId !== null}
            onClick={() => {
              clearApiReadCache();
              void load();
            }}
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-5" /> {t("common.reload")}
          </Button>
        </div>
        {activeOcrJobs.length > 0 ? (
          <div
            className="mb-4 flex flex-col gap-3 rounded-card border border-amber-300 bg-amber-50/85 p-4 text-amber-950"
            data-testid="admin-book-ocr-queue-banner"
            role="status"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-start gap-2.5">
                <Clock3
                  aria-hidden
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
                className="sm:w-auto"
                onClick={() => {
                  clearApiReadCache();
                  void refreshPages();
                }}
                size="compact"
                type="button"
                variant="secondary"
              >
                <RefreshCw aria-hidden className="size-4" />
                {t("books.detail.ocrQueueCheckNow")}
              </Button>
            </div>
            {pendingNewPageJobs.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {pendingNewPageJobs.map((job, idx) => (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-bold text-amber-950"
                    data-testid="admin-queued-new-page-badge"
                    key={job.id}
                  >
                    <Clock3 aria-hidden className="size-3.5 text-amber-700" />
                    {t("books.detail.queuedNewPageBadge", {
                      index: formatNumber(idx + 1),
                    })}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {pageActionNotice ? (
          <StatusMessage
            className="mb-4"
            tone={pageActionNotice.tone}
            title={pageActionNotice.title}
          >
            {pageActionNotice.message}
          </StatusMessage>
        ) : null}
        {!items ? (
          <AdminLoading />
        ) : pagesUnavailable ? (
          <StatusMessage
            tone="info"
            title={t("books.detail.pageDataPendingTitle")}
          >
            {t("books.detail.pageDataPendingDesc")}
          </StatusMessage>
        ) : items.length === 0 && activeOcrJobs.length === 0 ? (
          <EmptyState
            title={t("books.detail.emptyPagesTitle")}
            description={t("books.detail.emptyPagesDesc")}
          />
        ) : items.length === 0 ? null : (
          <div className="grid gap-4">
            <AdminResultsPagination
              itemLabel={t("books.detail.pageItemLabel")}
              onPageChange={setPageNumber}
              page={pageNumber}
              pageSize={pageSize}
              total={items.length}
            />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleItems?.map((item) => {
                const active = item.processing.lifecycle_status === "ACTIVE";
                const queuedPageJob = activeJobByPageId.get(
                  item.processing.page_id,
                );
                return (
                  <Card
                    className="h-full bg-white"
                    key={item.processing.page_id}
                  >
                    <div className="flex h-full flex-col gap-4">
                      <AdminPageImagePreview
                        key={`${item.processing.page_id}:${item.processing.page_revision_id}`}
                        pageId={item.processing.page_id}
                        revisionId={item.processing.page_revision_id}
                        pageNumber={item.page_number}
                        onReplaced={() => {
                          setPageActionNotice({
                            tone: "info",
                            title: t("books.detail.pendingImageTitle"),
                            message: t("books.detail.pendingImageDesc"),
                          });
                          void load();
                        }}
                      />
                      <h3 className="text-2xl font-extrabold">
                        {t("books.detail.pageNumber", {
                          pageNumber: formatNumber(item.page_number),
                        })}
                      </h3>
                      <div className="flex flex-wrap items-start gap-2">
                        <AdminStatusBadge
                          status={
                            active
                              ? item.processing.verification_status
                              : "RETIRED"
                          }
                        />
                        {queuedPageJob ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-extrabold text-amber-950"
                            data-testid="admin-page-queued-ocr-badge"
                          >
                            <Clock3 aria-hidden className="size-3.5" />
                            {queuedPageJob.worker_online === false
                              ? t("books.detail.pageQueuedOfflineBadge")
                              : t("books.detail.pageQueuedOnlineBadge")}
                          </span>
                        ) : null}
                      </div>
                      {item.processing.verification_status === "VERIFIED" &&
                      item.processing.ocr_preview_metadata
                        .ai_review_required === true ? (
                        <span className="inline-flex w-fit rounded-full bg-red-100 px-3 py-1 text-sm font-extrabold text-red-700">
                          {t("books.detail.aiAutoVerifiedWarning")}
                        </span>
                      ) : null}
                      {item.processing.verification_status === "NEEDS_REVIEW" &&
                      (skippedAiPageIds.has(item.processing.page_id) ||
                        skippedAiPageIds.has(
                          item.processing.page_revision_id,
                        )) ? (
                        <span className="inline-flex w-fit rounded-full bg-red-100 px-3 py-1 text-sm font-extrabold text-red-700">
                          {t("books.detail.adminVerifyForTrainingWarning")}
                        </span>
                      ) : null}
                      <div>
                        <p className="mt-1 text-sm text-muted">
                          Revision R{item.processing.revision_no}
                        </p>
                        <p className="mt-3 line-clamp-2 break-words text-sm leading-6 text-ink">
                          {item.text_preview?.trim() ? (
                            <span
                              className="viread-learning-content"
                              dir="ltr"
                              lang="vi"
                            >
                              {item.text_preview}
                            </span>
                          ) : (
                            t("books.detail.noOcrPreview")
                          )}
                        </p>
                      </div>
                      <div className="mt-auto flex flex-col items-stretch gap-3">
                        <Link
                          className="inline-flex min-h-12 items-center justify-center rounded-control bg-sky px-4 font-bold text-primary focus-visible:outline-3 focus-visible:outline-primary"
                          href={`/admin/books/${book.id}/pages/${item.processing.page_id}`}
                        >
                          {active
                            ? t("books.detail.openReviewAction")
                            : t("books.detail.openHistoryAction")}
                        </Link>
                        {active ? (
                          <Button
                            disabled={retiringPageId !== null}
                            onClick={() => {
                              setPageActionNotice(null);
                              setPendingRetire(item);
                            }}
                            variant="quiet"
                          >
                            <Trash2 aria-hidden className="size-4" />{" "}
                            {t("books.detail.deletePage")}
                          </Button>
                        ) : (
                          <span className="text-xs font-semibold text-muted">
                            {t("books.detail.retiredBadge")}
                          </span>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
            <AdminResultsPagination
              itemLabel={t("books.detail.pageItemLabel")}
              onPageChange={setPageNumber}
              page={pageNumber}
              pageSize={pageSize}
              total={items.length}
            />
          </div>
        )}
      </section>
      <Modal
        closeOnBackdropClick={retiringPageId === null}
        closeOnEscape={retiringPageId === null}
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              disabled={retiringPageId !== null}
              fullWidth={false}
              onClick={() => setPendingRetire(null)}
              type="button"
              variant="secondary"
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
    </>
  );
}
