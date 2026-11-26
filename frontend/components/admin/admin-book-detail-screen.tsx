"use client";

import {
  Check,
  Copy,
  Info,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  UploadCloud,
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
import { StatusMessage } from "@/components/common/status-message";
import { useSkippedAiPageIds } from "@/hooks/use-admin-ai-batch-skipped-pages";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { clearApiReadCache } from "@/lib/api/read-cache";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookDTO, AdminPageListItemUI } from "@/types/admin";
import type { AssetSourceType } from "@/types/book-assets";

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
  const [uploaderOpenOverride, setUploaderOpenOverride] = useState<
    boolean | null
  >(null);
  const [aiBatchOpen, setAiBatchOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [pageActionNotice, setPageActionNotice] = useState<{
    tone: "error" | "info";
    title: string;
    message: string;
  } | null>(null);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const copyTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(
    null,
  );

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
    const requestId = ++requestIdRef.current;
    try {
      const nextPages = (await pages.list(bookId)).filter(
        (item) => item.processing.lifecycle_status === "ACTIVE",
      );
      if (requestId !== requestIdRef.current) return;
      const maxPage = Math.max(1, Math.ceil(nextPages.length / pageSize));
      setPageNumber((current) => Math.min(current, maxPage));
      setItems(nextPages);
    } catch {
      if (requestId !== requestIdRef.current) return;
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

  function handleCopyBookId(id: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(id).catch(() => undefined);
    }
    setCopiedId(true);
    if (copyTimerRef.current) globalThis.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = globalThis.setTimeout(() => {
      if (mountedRef.current) setCopiedId(false);
    }, 1800);
  }

  useEffect(() => {
    mountedRef.current = true;
    const timeout = globalThis.setTimeout(() => void load(), 0);
    return () => {
      mountedRef.current = false;
      globalThis.clearTimeout(timeout);
      if (copyTimerRef.current) globalThis.clearTimeout(copyTimerRef.current);
      requestIdRef.current += 1;
    };
  }, [load]);

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
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink
              href={`/admin/books/${encodeURIComponent(book.id)}/edit`}
              size="admin"
              variant="outline"
            >
              <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
              {t("books.detail.editMetadata")}
            </ButtonLink>
            <ButtonLink href="/admin/tasks" size="admin" variant="outline">
              Trung tâm tác vụ AI
            </ButtonLink>
          </div>
        }
        badge={<AdminStatusBadge status={book.lifecycle_status} />}
        breadcrumbs={[
          { label: t("books.detail.backToBooks"), href: "/admin/books" },
          { label: resolvedTitle },
        ]}
        eyebrow={t("books.detail.eyebrow")}
        title={resolvedTitle}
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
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <button
                  aria-label={t(
                    "books.detail.copyIdAria",
                    undefined,
                    "Sao chép ID sách",
                  )}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-subtle px-2 py-0.5 font-mono text-[11px] font-semibold text-muted transition-colors hover:border-primary/40 hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"
                  onClick={() => handleCopyBookId(book.id)}
                  title={book.id}
                  type="button"
                >
                  <span>ID: {book.id.slice(0, 8)}…</span>
                  {copiedId ? (
                    <>
                      <Check
                        aria-hidden="true"
                        className="size-3 text-success-ink"
                      />
                      <span className="font-sans text-success-ink">
                        {t("books.detail.copiedId", undefined, "Đã sao chép")}
                      </span>
                    </>
                  ) : (
                    <Copy aria-hidden="true" className="size-3" />
                  )}
                </button>
              </div>
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
                {t("books.detail.statProcessing", undefined, "Đang xử lý")}
              </span>
              <span className="text-sm font-extrabold text-primary-hover">
                {items ? formatNumber(pageStats.processing) : "—"}
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

        {/* Always mounted so tests/sessions preserve state; collapsed visually when pages already exist */}
        <AdminPageUploader
          bookId={book.id}
          collapsed={!isUploaderExpanded}
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
        ) : items.length === 0 ? (
          <EmptyState
            description={t("books.detail.emptyPagesDesc")}
            title={t("books.detail.emptyPagesTitle")}
          />
        ) : (
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
                        <span className="rounded-md bg-surface-subtle px-1.5 py-0.5 font-mono text-[11px] font-bold text-muted">
                          R{item.processing.revision_no}
                        </span>
                      </div>
                      <AdminStatusBadge
                        status={
                          active
                            ? item.processing.verification_status
                            : "RETIRED"
                        }
                      />
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
                      onReplaced={() => {
                        setPageActionNotice({
                          tone: "info",
                          title: t("books.detail.pendingImageTitle"),
                          message: t("books.detail.pendingImageDesc"),
                        });
                        void load();
                      }}
                      pageId={item.processing.page_id}
                      pageNumber={item.page_number}
                      revisionId={item.processing.page_revision_id}
                    />

                    <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-3">
                      <ButtonLink
                        className="flex-1 whitespace-nowrap"
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
