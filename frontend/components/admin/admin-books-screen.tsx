"use client";

import {
  BookCheck,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AdminBadge,
  AdminKpiCard,
  AdminKpiGrid,
  AdminLoading,
  AdminPageHeader,
  AdminResultsPagination,
  AdminSearchInput,
  AdminSelect,
  AdminStatusBadge,
  AdminToolbar,
} from "@/components/admin/admin-ui";
import { BookCover } from "@/components/books/book-cover";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookDTO, AdminBookListItemUI } from "@/types/admin";
import type { BookLifecycleStatus } from "@/types/book";
import type { AssetSourceType } from "@/types/book-assets";
import type { PageRevisionVerificationStatus } from "@/types/reading";

interface ActionNotice {
  tone: "error" | "info";
  title: string;
  message: string;
}

interface CatalogOverviewSnapshot {
  readonly total: number;
  readonly active: number;
  readonly needsReviewBooks: number;
  readonly needsReviewPages: number;
  readonly eligible: number;
}

function summarizeCatalog(
  list: readonly AdminBookListItemUI[],
): CatalogOverviewSnapshot {
  let active = 0;
  let needsReviewBooks = 0;
  let needsReviewPages = 0;
  let eligible = 0;

  for (const item of list) {
    if (item.book.lifecycle_status === "ACTIVE") active += 1;
    if (item.needs_review_count > 0) {
      needsReviewBooks += 1;
      needsReviewPages += item.needs_review_count;
    }
    if (item.parent_catalog_eligible) eligible += 1;
  }

  return {
    total: list.length,
    active,
    needsReviewBooks,
    needsReviewPages,
    eligible,
  };
}

export function AdminBooksScreen() {
  const { books } = useAdminServices();
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const pageSize = 10;
  const [pageNumber, setPageNumber] = useState(1);
  const [items, setItems] = useState<readonly AdminBookListItemUI[] | null>(
    null,
  );
  const [overviewSnapshot, setOverviewSnapshot] =
    useState<CatalogOverviewSnapshot | null>(null);
  const [error, setError] = useState<"auth" | "forbidden" | "safe" | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState<BookLifecycleStatus | "">("");
  const [verification, setVerification] = useState<
    PageRevisionVerificationStatus | ""
  >("");
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [lifecycleBusyBookId, setLifecycleBusyBookId] = useState<string | null>(
    null,
  );
  const [pendingLifecycleBook, setPendingLifecycleBook] =
    useState<AdminBookDTO | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminBookDTO | null>(null);
  const [deleteBusyBookId, setDeleteBusyBookId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const deleteInFlightRef = useRef(false);
  const requestIdRef = useRef(0);
  const loadRef = useRef<
    (options?: { resetPage?: boolean }) => Promise<boolean>
  >(async () => false);

  const load = useCallback(
    async (options?: { resetPage?: boolean }): Promise<boolean> => {
      const requestId = ++requestIdRef.current;
      if (options?.resetPage) setPageNumber(1);
      setError(null);
      setItems(null);
      const isUnfilteredServerQuery =
        !search.trim() && !lifecycle && !verification;
      try {
        const nextItems = await books.list({
          search,
          lifecycle_status: lifecycle || undefined,
          verification_status: verification || undefined,
        });
        if (requestId !== requestIdRef.current) return false;
        const maxPage = Math.max(1, Math.ceil(nextItems.length / pageSize));
        setPageNumber((current) => Math.min(current, maxPage));
        setItems(nextItems);
        if (isUnfilteredServerQuery) {
          setOverviewSnapshot(summarizeCatalog(nextItems));
        }
        return true;
      } catch (cause) {
        if (requestId !== requestIdRef.current) return false;
        setError(
          isServiceError(cause) && cause.code === "AUTH_REQUIRED"
            ? "auth"
            : isServiceError(cause) && cause.code === "FORBIDDEN"
              ? "forbidden"
              : "safe",
        );
        setItems([]);
        return false;
      }
    },
    [books, lifecycle, pageSize, search, verification],
  );

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(
      () => void load({ resetPage: true }),
      200,
    );
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);

  async function confirmLifecycleChange() {
    const book = pendingLifecycleBook;
    if (!book || lifecycleBusyBookId !== null) return;

    const nextStatus =
      book.lifecycle_status === "ACTIVE" ? "RETIRED" : "ACTIVE";

    setLifecycleBusyBookId(book.id);
    setActionNotice(null);
    try {
      const updated = await books.updateStatus(book.id, { status: nextStatus });
      if (updated.id !== book.id || updated.lifecycle_status !== nextStatus) {
        throw new Error("Unexpected lifecycle response");
      }

      setPendingLifecycleBook(null);
      setOverviewSnapshot(null);
      const reloaded = await loadRef.current({ resetPage: false });
      setActionNotice(
        reloaded
          ? {
              tone: "info",
              title:
                nextStatus === "RETIRED"
                  ? t("books.notices.retiredTitle")
                  : t("books.notices.reactivatedTitle"),
              message:
                nextStatus === "RETIRED"
                  ? t("books.notices.retiredDesc")
                  : t("books.notices.reactivatedDesc"),
            }
          : {
              tone: "error",
              title: t("books.notices.reloadWarningTitle"),
              message: t("books.notices.reloadWarningDesc"),
            },
      );
    } catch (cause) {
      setPendingLifecycleBook(null);
      setActionNotice({
        tone: "error",
        title:
          nextStatus === "ACTIVE"
            ? t("books.notices.reactivateFailedTitle")
            : t("books.notices.retireFailedTitle"),
        message:
          nextStatus === "ACTIVE" &&
          isServiceError(cause) &&
          cause.status === 409
            ? t("books.notices.safetyBlocked")
            : nextStatus === "ACTIVE" &&
                isServiceError(cause) &&
                cause.status === 422
              ? t("books.notices.invalidMetadata")
              : t("books.notices.genericToggleError"),
      });
    } finally {
      setLifecycleBusyBookId(null);
    }
  }

  function closeDeleteDialog() {
    if (deleteInFlightRef.current) return;
    setPendingDelete(null);
    setDeleteError(null);
  }

  async function confirmDeleteBook() {
    const book = pendingDelete;
    if (!book || deleteInFlightRef.current) return;

    deleteInFlightRef.current = true;
    setDeleteBusyBookId(book.id);
    setDeleteError(null);
    setActionNotice(null);
    try {
      const result = await books.delete(book.id);
      if (result.book_id !== book.id || result.is_deleted !== true) {
        throw new Error("Unexpected delete response");
      }

      requestIdRef.current += 1;
      const remainingItems = (items ?? []).filter(
        (item) => item.book.id !== book.id,
      );
      setItems(remainingItems);
      if (!search.trim() && !lifecycle && !verification) {
        setOverviewSnapshot(summarizeCatalog(remainingItems));
      } else {
        setOverviewSnapshot(null);
      }
      setPageNumber((currentPage) =>
        Math.min(
          currentPage,
          Math.max(1, Math.ceil(remainingItems.length / pageSize)),
        ),
      );
      setPendingDelete(null);
      setActionNotice({
        tone: "info",
        title: t("books.notices.deletedTitle"),
        message: t("books.notices.deletedDesc"),
      });
    } catch (cause) {
      setDeleteError(
        isServiceError(cause) && cause.status === 401
          ? t("books.notices.deleteUnauthorized")
          : isServiceError(cause) && cause.status === 403
            ? t("books.notices.deleteForbidden")
            : isServiceError(cause) && cause.status === 404
              ? t("books.notices.deleteNotFound")
              : isServiceError(cause) && cause.status === 409
                ? t("books.notices.deleteConflict")
                : isServiceError(cause)
                  ? cause.message
                  : t("books.notices.deleteGenericError"),
      );
    } finally {
      deleteInFlightRef.current = false;
      setDeleteBusyBookId(null);
    }
  }

  const filteredItems = useMemo(() => {
    if (!items) return null;
    if (!eligibleOnly) return items;
    return items.filter((item) => item.parent_catalog_eligible);
  }, [eligibleOnly, items]);

  const metrics = useMemo(() => {
    if (overviewSnapshot) return overviewSnapshot;
    if (items) return summarizeCatalog(items);
    return null;
  }, [items, overviewSnapshot]);

  const hasActiveFilters = Boolean(
    search.trim() || lifecycle || verification || eligibleOnly,
  );

  function resetAllFilters() {
    setSearch("");
    setLifecycle("");
    setVerification("");
    setEligibleOnly(false);
    setPageNumber(1);
  }

  const isTotalKpiActive = !hasActiveFilters;
  const isActiveKpiActive =
    lifecycle === "ACTIVE" && !verification && !eligibleOnly;
  const isNeedsReviewKpiActive =
    verification === "NEEDS_REVIEW" && !eligibleOnly;
  const isEligibleKpiActive = eligibleOnly;

  const totalPages = Math.max(
    1,
    Math.ceil((filteredItems?.length ?? 0) / pageSize),
  );
  const safePage = Math.min(Math.max(1, pageNumber), totalPages);
  const visibleItems = filteredItems?.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const showMultiPagePagination =
    filteredItems !== null && filteredItems.length > pageSize;

  return (
    <div className="space-y-4">
      <AdminPageHeader
        actions={
          <ButtonLink href="/admin/books/new" size="admin" variant="primary">
            <Plus aria-hidden="true" className="size-4 shrink-0" />
            {t("books.newBook")}
          </ButtonLink>
        }
        description={t("books.subtitle")}
        eyebrow={t("books.eyebrow")}
        title={t("books.title")}
      />

      <AdminKpiGrid ariaLabel={t("books.overviewAria")} columns={4}>
        <AdminKpiCard
          active={isTotalKpiActive}
          icon={<BookOpen className="size-4" />}
          label={t("books.kpi.total", undefined, "Tổng sách")}
          onClick={resetAllFilters}
          testId="books-kpi-total"
          tone="neutral"
          value={
            metrics
              ? formatNumber(metrics.total)
              : t("common.emptyDash", undefined, "—")
          }
        />
        <AdminKpiCard
          active={isActiveKpiActive}
          icon={<CheckCircle2 className="size-4" />}
          label={t("books.kpi.activeBooks", undefined, "Sách đang hoạt động")}
          onClick={() => {
            if (isActiveKpiActive) {
              setLifecycle("");
            } else {
              setLifecycle("ACTIVE");
              setVerification("");
              setEligibleOnly(false);
            }
            setPageNumber(1);
          }}
          testId="books-kpi-active"
          tone="success"
          value={
            metrics
              ? formatNumber(metrics.active)
              : t("common.emptyDash", undefined, "—")
          }
        />
        <AdminKpiCard
          active={isNeedsReviewKpiActive}
          detail={
            metrics
              ? t(
                  "books.kpi.needsReviewDetail",
                  { count: formatNumber(metrics.needsReviewPages) },
                  "{count} trang chờ duyệt",
                )
              : undefined
          }
          icon={<ClipboardCheck className="size-4" />}
          label={t("books.kpi.needsReview", undefined, "Cần duyệt OCR")}
          onClick={() => {
            if (isNeedsReviewKpiActive) {
              setVerification("");
            } else {
              setVerification("NEEDS_REVIEW");
              setLifecycle("");
              setEligibleOnly(false);
            }
            setPageNumber(1);
          }}
          testId="books-kpi-needs-review"
          tone="warning"
          value={
            metrics
              ? formatNumber(metrics.needsReviewBooks)
              : t("common.emptyDash", undefined, "—")
          }
        />
        <AdminKpiCard
          active={isEligibleKpiActive}
          icon={<BookCheck className="size-4" />}
          label={t(
            "books.kpi.childLibraryEligible",
            undefined,
            "Đủ điều kiện thư viện trẻ em",
          )}
          onClick={() => {
            if (isEligibleKpiActive) {
              setEligibleOnly(false);
            } else {
              setEligibleOnly(true);
              setLifecycle("");
              setVerification("");
            }
            setPageNumber(1);
          }}
          testId="books-kpi-eligible"
          tone="info"
          value={
            metrics
              ? formatNumber(metrics.eligible)
              : t("common.emptyDash", undefined, "—")
          }
        />
      </AdminKpiGrid>

      <AdminToolbar
        actions={
          hasActiveFilters ? (
            <Button
              onClick={resetAllFilters}
              size="admin"
              type="button"
              variant="outline"
            >
              <RotateCcw aria-hidden="true" className="size-3.5 shrink-0" />
              {t("books.resetFilters", undefined, "Đặt lại")}
            </Button>
          ) : undefined
        }
        ariaLabel={t("books.filterToolbarAria", undefined, "Bộ lọc kho sách")}
      >
        <AdminSearchInput
          label={t("books.searchLabel")}
          onChange={setSearch}
          placeholder={t(
            "books.searchPlaceholder",
            undefined,
            "Nhập tên sách, tiêu đề hoặc tác giả…",
          )}
          value={search}
        />
        <AdminSelect
          containerClassName="w-full sm:w-44"
          label={t("books.lifecycleLabel")}
          onChange={(value) => {
            setEligibleOnly(false);
            setLifecycle(value as BookLifecycleStatus | "");
            setPageNumber(1);
          }}
          options={[
            { value: "", label: t("common.all") },
            { value: "ACTIVE", label: t("books.lifecycleOptions.ACTIVE") },
            { value: "RETIRED", label: t("books.lifecycleOptions.RETIRED") },
          ]}
          value={lifecycle}
        />
        <AdminSelect
          containerClassName="w-full sm:w-48"
          label={t("books.ocrStatusLabel")}
          onChange={(value) => {
            setEligibleOnly(false);
            setVerification(value as PageRevisionVerificationStatus | "");
            setPageNumber(1);
          }}
          options={[
            { value: "", label: t("common.all") },
            { value: "PROCESSING", label: t("statusBadges.PROCESSING") },
            { value: "NEEDS_REVIEW", label: t("statusBadges.NEEDS_REVIEW") },
            { value: "VERIFIED", label: t("statusBadges.VERIFIED") },
          ]}
          value={verification}
        />
      </AdminToolbar>

      {actionNotice ? (
        <StatusMessage title={actionNotice.title} tone={actionNotice.tone}>
          {actionNotice.message}
        </StatusMessage>
      ) : null}

      {filteredItems === null ? (
        <AdminLoading variant="skeleton" />
      ) : error ? (
        <StatusMessage
          title={
            error === "auth"
              ? t("books.loadErrorAuth")
              : error === "forbidden"
                ? t("books.loadErrorForbidden")
                : t("books.loadErrorGeneric")
          }
          tone="error"
        >
          {error === "safe" ? (
            <Button
              className="mt-2"
              onClick={() => void load()}
              size="admin"
              type="button"
              variant="secondary"
            >
              {t("common.retry")}
            </Button>
          ) : (
            <Link
              className="inline-flex min-h-10 items-center rounded-md px-1 font-extrabold underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/login"
            >
              {t("common.goToLogin")}
            </Link>
          )}
        </StatusMessage>
      ) : filteredItems.length === 0 ? (
        <EmptyState
          action={
            hasActiveFilters ? (
              <Button
                onClick={resetAllFilters}
                size="admin"
                type="button"
                variant="outline"
              >
                {t("books.resetFilters", undefined, "Đặt lại")}
              </Button>
            ) : undefined
          }
          description={
            hasActiveFilters
              ? t(
                  "books.emptyFilteredDesc",
                  undefined,
                  "Thử thay đổi từ khóa hoặc đặt lại bộ lọc để xem toàn bộ kho sách.",
                )
              : t("books.emptyDesc")
          }
          title={t("books.emptyTitle")}
        />
      ) : (
        <div className="space-y-3">
          {showMultiPagePagination ? (
            <AdminResultsPagination
              itemLabel={t("books.itemLabel")}
              onPageChange={setPageNumber}
              page={safePage}
              pageSize={pageSize}
              total={filteredItems.length}
            />
          ) : null}

          <div
            aria-label={t(
              "books.listAria",
              undefined,
              "Danh sách sách quản trị",
            )}
            className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-white shadow-2xs"
            role="list"
          >
            {visibleItems?.map((item) => {
              const book = item.book;
              const missingTitle = !book.title.trim();
              const isBusy =
                lifecycleBusyBookId !== null || deleteBusyBookId !== null;
              const editHref = missingTitle
                ? `/admin/books/${encodeURIComponent(book.id)}/edit?issue=MISSING_TITLE`
                : `/admin/books/${encodeURIComponent(book.id)}/edit`;
              const totalPages = Math.max(0, item.page_count);
              const verifiedPct =
                totalPages > 0
                  ? Math.min(100, (item.verified_count / totalPages) * 100)
                  : 0;
              const reviewPct =
                totalPages > 0
                  ? Math.min(
                      100 - verifiedPct,
                      (item.needs_review_count / totalPages) * 100,
                    )
                  : 0;
              const processingPct =
                totalPages > 0
                  ? Math.min(
                      100 - verifiedPct - reviewPct,
                      (item.processing_count / totalPages) * 100,
                    )
                  : 0;

              return (
                <article
                  className="px-4 py-3 transition-colors hover:bg-surface-subtle/50"
                  key={book.id}
                  role="listitem"
                >
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between xl:gap-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
                      <BookCover
                        author={book.author}
                        book={book}
                        className="h-16! w-12! shrink-0 rounded-md!"
                        coverSourceType={
                          (book.cover_source_type as AssetSourceType | null) ??
                          null
                        }
                        coverUrl={book.cover_url ?? null}
                        showTitle={false}
                        size="small"
                      />

                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <Link
                            className="min-w-0 max-w-full rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            href={`/admin/books/${encodeURIComponent(book.id)}`}
                          >
                            <h2 className="truncate text-base font-extrabold leading-snug text-ink transition-colors hover:text-primary">
                              {missingTitle ? (
                                t("books.missingTitle")
                              ) : (
                                <span dir="auto">{book.title}</span>
                              )}
                            </h2>
                          </Link>
                          <AdminStatusBadge status={book.lifecycle_status} />
                          {item.parent_catalog_eligible ? (
                            <AdminBadge tone="info">
                              {t("books.inParentLibrary")}
                            </AdminBadge>
                          ) : book.lifecycle_status === "ACTIVE" ? (
                            <AdminBadge tone="warning">
                              {t("books.notReadyChildren")}
                            </AdminBadge>
                          ) : null}
                        </div>

                        <p className="truncate text-xs text-muted">
                          {t("books.metaLine", {
                            name: book.name?.trim()
                              ? book.name
                              : t("books.missingName"),
                            author: book.author?.trim()
                              ? book.author
                              : t("books.missingAuthor"),
                            minGrade: book.min_grade,
                            maxGrade: book.max_grade,
                          })}
                        </p>

                        <div className="flex flex-wrap items-center gap-2.5">
                          <div
                            aria-hidden="true"
                            className="flex h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-subtle ring-1 ring-border/70"
                          >
                            {verifiedPct > 0 ? (
                              <span
                                className="h-full bg-emerald-500"
                                style={{ width: `${verifiedPct}%` }}
                              />
                            ) : null}
                            {reviewPct > 0 ? (
                              <span
                                className="h-full bg-amber-500"
                                style={{ width: `${reviewPct}%` }}
                              />
                            ) : null}
                            {processingPct > 0 ? (
                              <span
                                className="h-full bg-primary"
                                style={{ width: `${processingPct}%` }}
                              />
                            ) : null}
                          </div>
                          <p
                            aria-label={t("books.pageStatusAria")}
                            className="text-xs font-medium text-muted tabular-nums"
                          >
                            {t("books.pageSummaryLine", {
                              total: formatNumber(item.page_count),
                              processing: formatNumber(item.processing_count),
                              needsReview: formatNumber(
                                item.needs_review_count,
                              ),
                              verified: formatNumber(item.verified_count),
                            })}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 xl:shrink-0 xl:grid-cols-[7.5rem_9.75rem_8.75rem_6.75rem]">
                      <ButtonLink
                        className="w-full whitespace-nowrap px-2.5"
                        href={`/admin/books/${encodeURIComponent(book.id)}`}
                        size="admin"
                        variant="secondary"
                      >
                        {t("books.viewPages")}
                      </ButtonLink>

                      <ButtonLink
                        className="w-full whitespace-nowrap px-2.5"
                        href={editHref}
                        size="admin"
                        variant="outline"
                      >
                        {missingTitle
                          ? t("books.repairTitle")
                          : t("books.editInfo")}
                      </ButtonLink>

                      <Button
                        className="w-full whitespace-nowrap px-2.5"
                        disabled={isBusy}
                        isLoading={lifecycleBusyBookId === book.id}
                        onClick={() => setPendingLifecycleBook(book)}
                        size="admin"
                        variant="outline"
                      >
                        {lifecycleBusyBookId === book.id
                          ? t("books.updating")
                          : book.lifecycle_status === "ACTIVE"
                            ? t("books.retire")
                            : t("books.reactivate")}
                      </Button>

                      <Button
                        className="w-full whitespace-nowrap px-2.5"
                        disabled={isBusy}
                        onClick={() => {
                          setActionNotice(null);
                          setDeleteError(null);
                          setPendingDelete(book);
                        }}
                        size="admin"
                        variant="destructive-outline"
                      >
                        <Trash2
                          aria-hidden="true"
                          className="size-3.5 shrink-0"
                        />
                        {t("books.deleteBook")}
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {showMultiPagePagination ? (
            <AdminResultsPagination
              itemLabel={t("books.itemLabel")}
              onPageChange={setPageNumber}
              page={safePage}
              pageSize={pageSize}
              total={filteredItems.length}
            />
          ) : null}
        </div>
      )}

      <Modal
        closeOnBackdropClick={lifecycleBusyBookId === null}
        closeOnEscape={lifecycleBusyBookId === null}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={lifecycleBusyBookId !== null}
              fullWidth={false}
              onClick={() => setPendingLifecycleBook(null)}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={lifecycleBusyBookId !== null}
              fullWidth={false}
              isLoading={lifecycleBusyBookId !== null}
              onClick={() => void confirmLifecycleChange()}
              size="admin"
              type="button"
              variant={
                pendingLifecycleBook?.lifecycle_status === "ACTIVE"
                  ? "destructive"
                  : "primary"
              }
            >
              {pendingLifecycleBook?.lifecycle_status === "ACTIVE"
                ? t("books.confirmModal.retireButton")
                : t("books.confirmModal.reactivateButton")}
            </Button>
          </div>
        }
        isOpen={pendingLifecycleBook !== null}
        onClose={() => {
          if (lifecycleBusyBookId === null) setPendingLifecycleBook(null);
        }}
        role="alertdialog"
        showCloseButton={lifecycleBusyBookId === null}
        title={
          pendingLifecycleBook?.lifecycle_status === "ACTIVE"
            ? t("books.confirmModal.retireTitle")
            : t("books.confirmModal.reactivateTitle")
        }
        tone="paper"
      >
        <p className="text-sm leading-relaxed text-ink">
          {pendingLifecycleBook?.lifecycle_status === "ACTIVE"
            ? t("books.confirmModal.retireBody")
            : t("books.confirmModal.reactivateBody")}
        </p>
      </Modal>

      <Modal
        closeOnEscape={deleteBusyBookId === null}
        isOpen={pendingDelete !== null}
        onClose={closeDeleteDialog}
        showCloseButton={deleteBusyBookId === null}
        title={t("books.deleteModal.title")}
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink">
            {t("books.deleteModal.body")}
          </p>
          {deleteError ? (
            <StatusMessage
              title={t("books.deleteModal.errorTitle")}
              tone="error"
            >
              {deleteError}
            </StatusMessage>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button
              disabled={deleteBusyBookId !== null}
              fullWidth={false}
              onClick={closeDeleteDialog}
              size="admin"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={deleteBusyBookId !== null}
              fullWidth={false}
              isLoading={deleteBusyBookId !== null}
              onClick={() => void confirmDeleteBook()}
              size="admin"
              variant="destructive"
            >
              {deleteBusyBookId !== null
                ? t("books.deleteModal.deleting")
                : t("books.deleteBook")}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
