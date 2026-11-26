"use client";

import { ArrowLeft, RefreshCw, Trash2 } from "lucide-react";
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
  const requestIdRef = useRef(0);
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

        const nextBook = await bookPromise;
        if (requestId !== requestIdRef.current) return;
        setBook(nextBook);

        const pagesOutcome = await pagesPromise;
        if (requestId !== requestIdRef.current) return;
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
    [bookId, books, pageSize, pages],
  );
  const refreshPages = useCallback(async () => {
    try {
      const nextPages = (await pages.list(bookId)).filter(
        (item) => item.processing.lifecycle_status === "ACTIVE",
      );
      const maxPage = Math.max(1, Math.ceil(nextPages.length / pageSize));
      setPageNumber((current) => Math.min(current, maxPage));
      setItems(nextPages);
    } catch {
      setPageActionNotice({
        tone: "error",
        title: t("books.detail.refreshErrorTitle"),
        message: t("books.detail.refreshErrorDesc"),
      });
    }
  }, [bookId, pages, t]);
  async function retirePendingPage() {
    const item = pendingRetire;
    const pageId = item?.processing.page_id;
    if (!item || !pageId || retiringPageId !== null) return;
    const requestId = requestIdRef.current;
    setRetiringPageId(pageId);
    setPageActionNotice(null);
    try {
      const result = await pages.retire(pageId);
      if (requestId !== requestIdRef.current) return;
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
      if (requestId !== requestIdRef.current) return;
      setPageActionNotice({
        tone: "error",
        title: t("books.detail.deletePageErrorTitle"),
        message: t("books.detail.deletePageErrorMsg"),
      });
    } finally {
      if (requestId === requestIdRef.current) setRetiringPageId(null);
    }
  }

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);
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
        ) : items.length === 0 ? (
          <EmptyState
            title={t("books.detail.emptyPagesTitle")}
            description={t("books.detail.emptyPagesDesc")}
          />
        ) : (
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
                      <div className="flex items-start gap-3">
                        <AdminStatusBadge
                          status={
                            active
                              ? item.processing.verification_status
                              : "RETIRED"
                          }
                        />
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
