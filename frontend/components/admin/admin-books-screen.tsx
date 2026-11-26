"use client";

import Link from "next/link";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AdminLoading,
  AdminPageHeader,
  AdminResultsPagination,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookDTO, AdminBookListItemUI } from "@/types/admin";
import type { BookLifecycleStatus } from "@/types/book";
import type { PageRevisionVerificationStatus } from "@/types/reading";

interface ActionNotice {
  tone: "error" | "info";
  title: string;
  message: string;
}

export function AdminBooksScreen() {
  const { books } = useAdminServices();
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const pageSize = 30;
  const [pageNumber, setPageNumber] = useState(1);
  const [items, setItems] = useState<readonly AdminBookListItemUI[] | null>(
    null,
  );
  const [error, setError] = useState<"auth" | "forbidden" | "safe" | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState<BookLifecycleStatus | "">("");
  const [verification, setVerification] = useState<
    PageRevisionVerificationStatus | ""
  >("");
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

  const visibleItems = items?.slice(
    (pageNumber - 1) * pageSize,
    pageNumber * pageSize,
  );

  return (
    <>
      <AdminPageHeader
        eyebrow={t("books.eyebrow")}
        title={t("books.title")}
        description={t("books.subtitle")}
        actions={
          <ButtonLink className="sm:w-auto sm:px-6" href="/admin/books/new">
            {t("books.newBook")}
          </ButtonLink>
        }
      />
      <p
        aria-label={t("books.overviewAria")}
        className="mb-4 text-sm text-muted"
      >
        {items
          ? t("books.summaryLine", {
              total: formatNumber(items.length),
              active: formatNumber(
                items.filter((i) => i.book.lifecycle_status === "ACTIVE")
                  .length,
              ),
              needsReview: formatNumber(
                items.reduce((acc, i) => acc + i.needs_review_count, 0),
              ),
            })
          : t("books.loadingSummary")}
      </p>
      <div className="mb-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="relative">
            <TextField
              label={t("books.searchLabel")}
              onChange={(event) => setSearch(event.target.value)}
              value={search}
            />
          </div>
          <SelectField
            label={t("books.lifecycleLabel")}
            onChange={(event) =>
              setLifecycle(event.target.value as BookLifecycleStatus | "")
            }
            value={lifecycle}
          >
            <option value="">{t("common.all")}</option>
            <option value="ACTIVE">{t("books.lifecycleOptions.ACTIVE")}</option>
            <option value="RETIRED">
              {t("books.lifecycleOptions.RETIRED")}
            </option>
          </SelectField>
          <SelectField
            label={t("books.ocrStatusLabel")}
            onChange={(event) =>
              setVerification(
                event.target.value as PageRevisionVerificationStatus | "",
              )
            }
            value={verification}
          >
            <option value="">{t("common.all")}</option>
            <option value="PROCESSING">{t("statusBadges.PROCESSING")}</option>
            <option value="NEEDS_REVIEW">
              {t("statusBadges.NEEDS_REVIEW")}
            </option>
            <option value="VERIFIED">{t("statusBadges.VERIFIED")}</option>
          </SelectField>
        </div>
      </div>

      {actionNotice ? (
        <StatusMessage
          className="mb-5"
          tone={actionNotice.tone}
          title={actionNotice.title}
        >
          {actionNotice.message}
        </StatusMessage>
      ) : null}

      {items === null ? (
        <AdminLoading />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? t("books.loadErrorAuth")
              : error === "forbidden"
                ? t("books.loadErrorForbidden")
                : t("books.loadErrorGeneric")
          }
        >
          {error === "safe" ? (
            <Button
              className="mt-2 sm:w-auto"
              onClick={() => void load()}
              type="button"
              variant="secondary"
            >
              {t("common.retry")}
            </Button>
          ) : (
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/login"
            >
              {t("common.goToLogin")}
            </Link>
          )}
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          description={t("books.emptyDesc")}
          title={t("books.emptyTitle")}
        />
      ) : (
        <div className="grid gap-5">
          <AdminResultsPagination
            itemLabel={t("books.itemLabel")}
            onPageChange={setPageNumber}
            page={pageNumber}
            pageSize={pageSize}
            total={items.length}
          />
          {visibleItems?.map((item) => {
            const book = item.book;
            const missingTitle = !book.title.trim();
            const isBusy =
              lifecycleBusyBookId !== null || deleteBusyBookId !== null;
            const editHref = missingTitle
              ? `/admin/books/${encodeURIComponent(book.id)}/edit?issue=MISSING_TITLE`
              : `/admin/books/${encodeURIComponent(book.id)}/edit`;

            return (
              <Card className="catalog-admin-row" key={book.id}>
                <Link
                  className="w-fit rounded-sm focus-visible:outline-3 focus-visible:outline-primary"
                  href={`/admin/books/${encodeURIComponent(book.id)}`}
                >
                  <h2 className="break-words text-2xl font-extrabold text-ink">
                    {missingTitle ? (
                      t("books.missingTitle")
                    ) : (
                      <span dir="auto">{book.title}</span>
                    )}
                  </h2>
                </Link>
                <p className="break-words text-body text-muted">
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
                <div className="flex flex-wrap gap-2">
                  <AdminStatusBadge status={book.lifecycle_status} />
                  {item.parent_catalog_eligible ? (
                    <span className="rounded-control bg-sky px-3 py-1 text-sm font-bold text-primary">
                      {t("books.inParentLibrary")}
                    </span>
                  ) : book.lifecycle_status === "ACTIVE" ? (
                    <span className="rounded-control bg-amber-100 px-3 py-1 text-sm font-bold text-amber-950">
                      {t("books.notReadyChildren")}
                    </span>
                  ) : null}
                </div>
                <p
                  aria-label={t("books.pageStatusAria")}
                  className="text-label text-muted"
                >
                  {t("books.pageSummaryLine", {
                    total: formatNumber(item.page_count),
                    processing: formatNumber(item.processing_count),
                    needsReview: formatNumber(item.needs_review_count),
                    verified: formatNumber(item.verified_count),
                  })}
                </p>
                <div className="grid w-full max-w-[820px] grid-cols-2 gap-3 sm:grid-cols-4">
                  <ButtonLink
                    className="!min-h-[76px] !h-auto !w-full !min-w-0 !max-w-none whitespace-normal px-2 py-2 text-center"
                    variant="secondary"
                    href={`/admin/books/${encodeURIComponent(book.id)}`}
                  >
                    {t("books.viewPages")}
                  </ButtonLink>

                  <ButtonLink
                    className="!min-h-[76px] !h-auto !w-full !min-w-0 !max-w-none whitespace-normal px-2 py-2 text-center"
                    variant="quiet"
                    href={editHref}
                  >
                    {missingTitle
                      ? t("books.repairTitle")
                      : t("books.editInfo")}
                  </ButtonLink>

                  <Button
                    className="!min-h-[76px] !h-auto !w-full !min-w-0 !max-w-none whitespace-normal px-2 py-2 text-center"
                    disabled={isBusy}
                    isLoading={lifecycleBusyBookId === book.id}
                    onClick={() => setPendingLifecycleBook(book)}
                    variant="quiet"
                  >
                    {lifecycleBusyBookId === book.id
                      ? t("books.updating")
                      : book.lifecycle_status === "ACTIVE"
                        ? t("books.retire")
                        : t("books.reactivate")}
                  </Button>

                  <Button
                    className="!min-h-[76px] !h-auto !w-full !min-w-0 !max-w-none whitespace-normal px-2 py-2"
                    disabled={isBusy}
                    onClick={() => {
                      setActionNotice(null);
                      setDeleteError(null);
                      setPendingDelete(book);
                    }}
                    variant="destructive"
                  >
                    <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                    {t("books.deleteBook")}
                  </Button>
                </div>
              </Card>
            );
          })}
          <AdminResultsPagination
            itemLabel={t("books.itemLabel")}
            onPageChange={setPageNumber}
            page={pageNumber}
            pageSize={pageSize}
            total={items.length}
          />
        </div>
      )}
      <Modal
        closeOnBackdropClick={lifecycleBusyBookId === null}
        closeOnEscape={lifecycleBusyBookId === null}
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              disabled={lifecycleBusyBookId !== null}
              fullWidth={false}
              onClick={() => setPendingLifecycleBook(null)}
              type="button"
              variant="secondary"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={lifecycleBusyBookId !== null}
              fullWidth={false}
              isLoading={lifecycleBusyBookId !== null}
              onClick={() => void confirmLifecycleChange()}
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
        <p className="text-body text-ink">
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
        <div className="grid gap-5">
          <p className="text-body text-ink">{t("books.deleteModal.body")}</p>
          {deleteError ? (
            <StatusMessage
              tone="error"
              title={t("books.deleteModal.errorTitle")}
            >
              {deleteError}
            </StatusMessage>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              disabled={deleteBusyBookId !== null}
              onClick={closeDeleteDialog}
              variant="secondary"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={deleteBusyBookId !== null}
              isLoading={deleteBusyBookId !== null}
              onClick={() => void confirmDeleteBook()}
              variant="destructive"
            >
              {deleteBusyBookId !== null
                ? t("books.deleteModal.deleting")
                : t("books.deleteBook")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
