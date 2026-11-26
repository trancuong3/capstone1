"use client";

import { ImageIcon, Power } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { AdminBookForm } from "@/components/admin/admin-book-form";
import {
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { BookCoverStudio } from "@/components/books/book-cover-studio";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookCreateDTO, AdminBookDTO } from "@/types/admin";
import type {
  AssetSourceType,
  BookPresentationAssetDTO,
} from "@/types/book-assets";

const ISSUE_KEYS = new Set([
  "MISSING_TITLE",
  "MISSING_AUTHOR",
  "INVALID_GRADE_RANGE",
  "POSSIBLE_DUPLICATE",
]);

interface AdminBookEditorScreenProps {
  bookId: string;
  returnTo?: "detail" | "metadata-quality";
  issue?: string;
  defaultCoverStudioOpen?: boolean;
}

export function AdminBookEditorScreen({
  bookId,
  returnTo = "detail",
  issue,
  defaultCoverStudioOpen = false,
}: AdminBookEditorScreenProps) {
  const { books } = useAdminServices();
  const t = useTranslations("admin");
  const router = useRouter();
  const [book, setBook] = useState<AdminBookDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"not-found" | "safe" | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [confirmLifecycleOpen, setConfirmLifecycleOpen] = useState(false);
  const [coverStudioOpen, setCoverStudioOpen] = useState(
    defaultCoverStudioOpen,
  );
  const [activeCoverAsset, setActiveCoverAsset] =
    useState<BookPresentationAssetDTO | null>(null);
  const [notice, setNotice] = useState<{
    tone: "info" | "error";
    title: string;
    message: string;
  } | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const current = await books.get(bookId);
      if (requestId !== requestIdRef.current) return;
      setBook(current);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setBook(null);
      setError(
        isServiceError(cause) && cause.code === "RESOURCE_NOT_FOUND"
          ? "not-found"
          : "safe",
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [bookId, books]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);

  async function saveMetadata(value: AdminBookCreateDTO) {
    await books.update(bookId, {
      ...value,
      name: value.name.trim(),
      title: value.title.trim(),
      author: value.author?.trim() || null,
    });
    if (returnTo === "metadata-quality") {
      router.push("/admin/metadata-quality");
    } else {
      router.push(`/admin/books/${encodeURIComponent(bookId)}`);
    }
    router.refresh();
  }

  async function changeLifecycle() {
    if (!book || statusBusy) return;
    const nextStatus =
      book.lifecycle_status === "ACTIVE" ? "RETIRED" : "ACTIVE";

    setStatusBusy(true);
    setNotice(null);
    try {
      const updated = await books.updateStatus(bookId, { status: nextStatus });
      if (updated.id !== bookId || updated.lifecycle_status !== nextStatus) {
        throw new Error("Unexpected lifecycle response");
      }
      setConfirmLifecycleOpen(false);
      setBook(updated);
      setNotice({
        tone: "info",
        title:
          nextStatus === "RETIRED"
            ? t("books.editor.retiredSuccessTitle")
            : t("books.editor.reactivatedSuccessTitle"),
        message:
          nextStatus === "RETIRED"
            ? t("books.editor.retiredSuccessDesc")
            : t("books.editor.reactivatedSuccessDesc"),
      });
    } catch (cause) {
      setConfirmLifecycleOpen(false);
      setNotice({
        tone: "error",
        title:
          nextStatus === "ACTIVE"
            ? t("books.editor.cannotActivateTitle")
            : t("books.editor.cannotRetireTitle"),
        message:
          nextStatus === "ACTIVE" &&
          isServiceError(cause) &&
          cause.status === 409
            ? t("books.editor.safetyBlocked")
            : nextStatus === "ACTIVE" &&
                isServiceError(cause) &&
                cause.status === 422
              ? t("books.editor.invalidMetadata")
              : t("books.editor.genericToggleError"),
      });
    } finally {
      setStatusBusy(false);
    }
  }

  if (loading) return <AdminLoading label={t("books.editor.loading")} />;

  if (error || !book) {
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
              className="inline-flex min-h-10 items-center rounded-md px-1 font-semibold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/books"
            >
              {t("books.detail.backToBooks")}
            </Link>
          </div>
        }
        description={
          error === "not-found"
            ? t("books.editor.notFoundDesc")
            : t("books.editor.genericErrorDesc")
        }
        headingLevel={1}
        title={
          error === "not-found"
            ? t("books.editor.notFoundTitle")
            : t("books.editor.loadErrorTitle")
        }
      />
    );
  }

  const resolvedTitle = book.title.trim() || t("books.missingTitle");
  const resolvedCoverUrl =
    activeCoverAsset?.media_url ?? book.cover_url ?? null;
  const resolvedCoverSourceType =
    activeCoverAsset?.source_type ??
    (book.cover_source_type as AssetSourceType | null) ??
    null;

  const initial: AdminBookCreateDTO = {
    name: book.name ?? "",
    title: book.title.trim() ? book.title : "",
    author: book.author ?? "",
    min_grade: book.min_grade,
    max_grade: book.max_grade,
  };
  const cancelHref =
    returnTo === "metadata-quality"
      ? "/admin/metadata-quality"
      : `/admin/books/${encodeURIComponent(bookId)}`;

  return (
    <section className="space-y-4">
      <AdminPageHeader
        badge={<AdminStatusBadge status={book.lifecycle_status} />}
        breadcrumbs={[
          { label: t("books.detail.backToBooks"), href: "/admin/books" },
          {
            label: resolvedTitle,
            href: `/admin/books/${encodeURIComponent(bookId)}`,
          },
          { label: t("books.editor.title") },
        ]}
        description={t("books.editor.description")}
        eyebrow={t("books.eyebrow")}
        title={t("books.editor.title")}
      />

      {issue && ISSUE_KEYS.has(issue) ? (
        <StatusMessage
          title={t("books.editor.issueTitle", {
            issue: t(`books.editor.issueLabels.${issue}`),
          })}
          tone="info"
        >
          {t("books.editor.issueHint")}
        </StatusMessage>
      ) : null}

      {notice ? (
        <StatusMessage title={notice.title} tone={notice.tone}>
          {notice.message}
        </StatusMessage>
      ) : null}

      <AdminBookForm
        bookId={bookId}
        cancelHref={cancelHref}
        coverSourceType={resolvedCoverSourceType}
        coverStudioSlot={
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-extrabold text-ink">
                  {t("books.editor.coverHeading", undefined, "Ảnh bìa sách")}
                </h2>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  {t(
                    "books.editor.coverDesc",
                    undefined,
                    "Cập nhật ảnh bìa (tải lên, cắt 3:4, xoay hoặc tạo bìa AI) mà không làm thay đổi các trang đọc hay revision đã xác minh.",
                  )}
                </p>
              </div>
              <Button
                onClick={() => setCoverStudioOpen((open) => !open)}
                size="admin"
                type="button"
                variant="secondary"
              >
                <ImageIcon aria-hidden="true" className="size-4 shrink-0" />
                {coverStudioOpen
                  ? t(
                      "books.editor.closeCoverStudio",
                      undefined,
                      "Đóng Cover Studio",
                    )
                  : t(
                      "books.editor.openCoverStudio",
                      undefined,
                      "Mở Cover Studio",
                    )}
              </Button>
            </div>
            {coverStudioOpen ? (
              <div className="pt-2">
                <BookCoverStudio
                  actorRole="admin"
                  author={book.author}
                  autoLoad
                  bookId={bookId}
                  bookTitle={resolvedTitle}
                  initialCoverSourceType={resolvedCoverSourceType}
                  initialCoverUrl={resolvedCoverUrl}
                  maxGrade={book.max_grade}
                  minGrade={book.min_grade}
                  onCoverUpdated={(asset) => setActiveCoverAsset(asset)}
                />
              </div>
            ) : null}
          </div>
        }
        coverUrl={resolvedCoverUrl}
        formHeading={t("books.editor.infoHeading")}
        initial={initial}
        lifecycleStatus={book.lifecycle_status}
        onSubmit={saveMetadata}
        showLiveCoverPreview
        sidebarExtra={
          <section
            aria-labelledby="book-lifecycle-danger-title"
            className={
              book.lifecycle_status === "ACTIVE"
                ? "rounded-xl border border-danger/25 bg-white p-5 shadow-2xs"
                : "rounded-xl border border-border bg-white p-5 shadow-2xs"
            }
          >
            <div className="flex items-center justify-between gap-2">
              <h2
                className="text-sm font-extrabold text-ink"
                id="book-lifecycle-danger-title"
              >
                {t(
                  "books.editor.dangerZoneHeading",
                  undefined,
                  "Vòng đời sách",
                )}
              </h2>
              <AdminStatusBadge status={book.lifecycle_status} />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              {book.lifecycle_status === "ACTIVE"
                ? t(
                    "books.editor.dangerZoneActiveDesc",
                    undefined,
                    "Ngừng hoạt động sẽ ẩn sách khỏi thư viện phụ huynh nhưng vẫn giữ nguyên toàn bộ trang, revision và lịch sử đọc.",
                  )
                : t(
                    "books.editor.dangerZoneRetiredDesc",
                    undefined,
                    "Sách đang ngừng hoạt động. Bạn có thể kích hoạt lại khi metadata và các trang OCR đã đáp ứng yêu cầu.",
                  )}
            </p>
            <div className="mt-4">
              <Button
                disabled={statusBusy}
                isLoading={statusBusy}
                onClick={() => setConfirmLifecycleOpen(true)}
                size="admin"
                type="button"
                variant={
                  book.lifecycle_status === "ACTIVE"
                    ? "destructive-outline"
                    : "secondary"
                }
              >
                <Power aria-hidden="true" className="size-4 shrink-0" />
                {book.lifecycle_status === "ACTIVE"
                  ? t("books.editor.retire")
                  : t("books.editor.reactivate")}
              </Button>
            </div>
          </section>
        }
        submitLabel={t("books.editor.submitLabel")}
      />

      <Modal
        closeOnBackdropClick={!statusBusy}
        closeOnEscape={!statusBusy}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={statusBusy}
              fullWidth={false}
              onClick={() => setConfirmLifecycleOpen(false)}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={statusBusy}
              fullWidth={false}
              isLoading={statusBusy}
              onClick={() => void changeLifecycle()}
              size="admin"
              type="button"
              variant={
                book.lifecycle_status === "ACTIVE" ? "destructive" : "primary"
              }
            >
              {book.lifecycle_status === "ACTIVE"
                ? t("books.editor.confirmRetire")
                : t("books.editor.confirmReactivate")}
            </Button>
          </div>
        }
        isOpen={confirmLifecycleOpen}
        onClose={() => {
          if (!statusBusy) setConfirmLifecycleOpen(false);
        }}
        role="alertdialog"
        showCloseButton={!statusBusy}
        title={
          book.lifecycle_status === "ACTIVE"
            ? t("books.editor.modalRetireTitle")
            : t("books.editor.modalReactivateTitle")
        }
        tone="paper"
      >
        <p className="text-sm leading-relaxed text-ink">
          {book.lifecycle_status === "ACTIVE"
            ? t("books.editor.modalRetireBody")
            : t("books.editor.modalReactivateBody")}
        </p>
      </Modal>
    </section>
  );
}
