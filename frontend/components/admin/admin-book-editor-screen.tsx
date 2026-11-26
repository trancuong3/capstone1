"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { AdminBookForm } from "@/components/admin/admin-book-form";
import { BookCover } from "@/components/books/book-cover";
import { BookCoverStudio } from "@/components/books/book-cover-studio";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import {
  createBookAssetsService,
  type BookAssetsService,
} from "@/lib/api/book-assets-service";
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
  assetsService?: BookAssetsService;
}

export function AdminBookEditorScreen({
  bookId,
  returnTo = "detail",
  issue,
  defaultCoverStudioOpen = false,
  assetsService,
}: AdminBookEditorScreenProps) {
  const { books } = useAdminServices();
  const resolvedAssetsService = useMemo(
    () => assetsService ?? createBookAssetsService(),
    [assetsService],
  );
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
  const [coverExplicitlyCleared, setCoverExplicitlyCleared] = useState(false);
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
    setCoverExplicitlyCleared(false);
    try {
      const current = await books.get(bookId);
      if (requestId !== requestIdRef.current) return;
      setBook(current);
      // Hydrate active cover asset immediately on mount without waiting for Cover Studio modal.
      void resolvedAssetsService
        .getBookAssets(bookId)
        .then((summary) => {
          if (requestId !== requestIdRef.current) return;
          setActiveCoverAsset(summary.active_cover ?? null);
          setCoverExplicitlyCleared(summary.active_cover == null);
        })
        .catch(() => {
          // Graceful degradation: fall back to book.cover_url / METADATA_RENDER.
        });
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
  }, [bookId, books, resolvedAssetsService]);

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
        headingLevel={1}
        title={
          error === "not-found"
            ? t("books.editor.notFoundTitle")
            : t("books.editor.loadErrorTitle")
        }
        description={
          error === "not-found"
            ? t("books.editor.notFoundDesc")
            : t("books.editor.genericErrorDesc")
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void load()} variant="secondary">
              {t("common.retry")}
            </Button>
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-semibold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/books"
            >
              {t("books.detail.backToBooks")}
            </Link>
          </div>
        }
      />
    );
  }

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

  const resolvedCoverUrl = coverExplicitlyCleared
    ? null
    : (activeCoverAsset?.media_url ?? book.cover_url ?? null);
  const resolvedCoverSourceType: AssetSourceType | null = coverExplicitlyCleared
    ? "METADATA_RENDER"
    : (activeCoverAsset?.source_type ??
      ((book.cover_source_type as AssetSourceType | null | undefined) ?? null));

  return (
    <section className="figma-form-page mx-auto flex w-full max-w-[960px] flex-col gap-4">
      <AdminPageHeader
        title={t("books.editor.title")}
        description={t("books.editor.description")}
      />
      {issue && ISSUE_KEYS.has(issue) ? (
        <StatusMessage
          className="mb-5"
          tone="info"
          title={t("books.editor.issueTitle", {
            issue: t(`books.editor.issueLabels.${issue}`),
          })}
        >
          {t("books.editor.issueHint")}
        </StatusMessage>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <Button
          className="sm:w-auto"
          disabled={statusBusy}
          isLoading={statusBusy}
          onClick={() => setConfirmLifecycleOpen(true)}
          variant="secondary"
        >
          {book.lifecycle_status === "ACTIVE"
            ? t("books.editor.retire")
            : t("books.editor.reactivate")}
        </Button>
      </div>
      {notice ? (
        <StatusMessage tone={notice.tone} title={notice.title}>
          {notice.message}
        </StatusMessage>
      ) : null}
      <Card className="w-full bg-white sm:px-8 sm:py-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <BookCover
              author={book.author}
              book={{
                id: book.id,
                title: book.title.trim() ? book.title : "Chưa có tiêu đề",
                author: book.author,
                min_grade: book.min_grade,
                max_grade: book.max_grade,
                lifecycle_status: book.lifecycle_status,
              }}
              coverSourceType={resolvedCoverSourceType}
              coverUrl={resolvedCoverUrl}
              showTitle={false}
              size="small"
            />
            <div className="min-w-0">
              <h2 className="text-xl font-extrabold text-ink">Ảnh bìa sách</h2>
              <p className="mt-0.5 text-xs text-muted">
                Cập nhật ảnh bìa (tải lên, cắt 3:4, xoay hoặc tạo bìa AI) mà
                không làm thay đổi các trang đọc hay revision đã xác minh.
              </p>
            </div>
          </div>
          <Button
            className="sm:w-auto"
            fullWidth={false}
            onClick={() => setCoverStudioOpen((open) => !open)}
            size="compact"
            type="button"
            variant="secondary"
          >
            {coverStudioOpen ? "Đóng Cover Studio" : "Mở Cover Studio"}
          </Button>
        </div>
        {coverStudioOpen ? (
          <div className="mt-4">
            <BookCoverStudio
              actorRole="admin"
              author={book.author}
              autoLoad
              bookId={bookId}
              bookTitle={book.title.trim() ? book.title : "Chưa có tiêu đề"}
              initialCoverSourceType={resolvedCoverSourceType}
              initialCoverUrl={resolvedCoverUrl}
              maxGrade={book.max_grade}
              minGrade={book.min_grade}
              onCoverUpdated={(asset) => {
                setActiveCoverAsset(asset);
                setCoverExplicitlyCleared(asset === null);
              }}
              service={resolvedAssetsService}
            />
          </div>
        ) : null}
      </Card>
      <Card className="w-full bg-white sm:px-8 sm:py-8">
        <h2 className="text-2xl font-extrabold text-ink">
          {t("books.editor.infoHeading")}
        </h2>
        <AdminBookForm
          bookId={bookId}
          cancelHref={cancelHref}
          coverSourceType={resolvedCoverSourceType}
          coverUrl={resolvedCoverUrl}
          initial={initial}
          onSubmit={saveMetadata}
          submitLabel={t("books.editor.submitLabel")}
        />
      </Card>
      <Modal
        closeOnBackdropClick={!statusBusy}
        closeOnEscape={!statusBusy}
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              disabled={statusBusy}
              fullWidth={false}
              onClick={() => setConfirmLifecycleOpen(false)}
              type="button"
              variant="secondary"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={statusBusy}
              fullWidth={false}
              isLoading={statusBusy}
              onClick={() => void changeLifecycle()}
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
        <p className="text-body text-ink">
          {book.lifecycle_status === "ACTIVE"
            ? t("books.editor.modalRetireBody")
            : t("books.editor.modalReactivateBody")}
        </p>
      </Modal>
    </section>
  );
}
