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
import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import { AdminPageImagePreview } from "@/components/admin/admin-page-image-preview";
import { AdminBookAiBatchReview } from "@/components/admin/admin-book-ai-batch-review";
import { clearApiReadCache } from "@/lib/api/read-cache";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookDTO, AdminPageListItemUI } from "@/types/admin";

export function AdminBookDetailScreen({ bookId }: { bookId: string }) {
  const { books, pages } = useAdminServices();
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
  const mountedRef = useRef(true);
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
        title: "Không thể làm mới trạng thái trang",
        message:
          "Thao tác đã gửi tới Backend; hãy bấm Tải lại để xác nhận trạng thái cuối cùng.",
      });
    }
  }, [bookId, pages]);
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
        title: "Trang đã ngừng sử dụng",
        message: `Trang ${item.page_number} đã được ẩn khỏi nội dung đọc mới. Ảnh nguồn, các revision và lịch sử phiên đọc được giữ nguyên.`,
      });
      await load();
    } catch {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setPageActionNotice({
        tone: "error",
        title: "Không thể xóa trang",
        message:
          "Không thể ngừng sử dụng trang lúc này. Hãy kiểm tra quyền Admin hoặc kết nối Backend rồi thử lại.",
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
  if (!book && !error) return <AdminLoading />;
  if (error)
    return (
      <EmptyState
        headingLevel={1}
        title={
          error === "not-found" ? "Không tìm thấy sách" : "Không thể tải sách"
        }
        description={
          error === "not-found"
            ? "ID sách không thuộc dữ liệu quản trị hiện tại."
            : "Vui lòng thử lại sau."
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void load()} variant="secondary">
              Thử lại
            </Button>
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/books"
            >
              Quay lại kho sách
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
        eyebrow="Chi tiết sách"
        title={book.title.trim() ? book.title : "Chưa có tiêu đề"}
        description={`Tên sách: ${book.name?.trim() ? book.name : "Chưa có tên sách"} · ${book.author ?? "Chưa có tác giả"} · Khối ${book.min_grade}–${book.max_grade}`}
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Link
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-control bg-white px-4 font-bold text-ink focus-visible:outline-3 focus-visible:outline-primary"
          href="/admin/books"
        >
          <ArrowLeft aria-hidden className="size-5" /> Kho sách
        </Link>
        <Link
          className="inline-flex min-h-12 items-center justify-center rounded-control bg-sky px-4 font-bold text-primary focus-visible:outline-3 focus-visible:outline-primary"
          href={`/admin/books/${encodeURIComponent(book.id)}/edit`}
        >
          Chỉnh sửa metadata / vòng đời
        </Link>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <AdminStatusBadge status={book.lifecycle_status} />
        <span className="break-all text-sm text-muted">ID: {book.id}</span>
      </div>
      <StatusMessage
        className="mb-6"
        tone="info"
        title="Sách chưa tự động được mở cho trẻ"
      >
        Backend chỉ cho sách vào thư viện trẻ em khi mọi trang đang hoạt động có
        revision OCR VERIFIED, Safety đã xác nhận trên đúng Candidate và không
        có finding HIGH hoặc suitability NOT_RECOMMENDED. Trang đang OCR, Safety
        lỗi / stale hoặc chờ Admin đều khiến sách bị ẩn khỏi Child, Reading
        Session và Game.
      </StatusMessage>
      <AdminPageUploader bookId={book.id} onUploaded={refreshPages} />
      {items && items.length > 0 ? (
        <section className="mt-6" aria-label="Rà soát OCR hàng loạt">
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
              Trang sách
            </h2>
            {items ? (
              <p className="mt-1 text-sm text-muted">{items.length} trang</p>
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
            <RefreshCw aria-hidden className="size-5" /> Tải lại
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
          <StatusMessage tone="info" title="Dữ liệu trang đang chờ bổ sung">
            Metadata sách đã tải được, nhưng revision hoặc ảnh chưa đáp ứng
            contract hiện tại.
          </StatusMessage>
        ) : items.length === 0 ? (
          <EmptyState
            title="Sách chưa có trang"
            description="Database chưa có trang nào cho sách này."
          />
        ) : (
          <div className="grid gap-4">
            <AdminResultsPagination
              itemLabel="trang"
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
                            title: "Ảnh mới đang chờ duyệt",
                            message:
                              "Bản mới cần được xác minh trước khi dùng cho lượt đọc. Ảnh và nội dung lịch sử vẫn được giữ nguyên.",
                          });
                          void load();
                        }}
                      />
                      <h3 className="text-2xl font-extrabold">
                        Trang {item.page_number}
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
                          AI tự VERIFIED · Admin cần rà soát
                        </span>
                      ) : null}
                      {item.processing.verification_status === "NEEDS_REVIEW" &&
                      (skippedAiPageIds.has(item.processing.page_id) ||
                        skippedAiPageIds.has(
                          item.processing.page_revision_id,
                        )) ? (
                        <span className="inline-flex w-fit rounded-full bg-red-100 px-3 py-1 text-sm font-extrabold text-red-700">
                          Cần Admin xác minh để dùng train
                        </span>
                      ) : null}
                      <div>
                        <p className="mt-1 text-sm text-muted">
                          Revision R{item.processing.revision_no}
                        </p>
                        <p className="mt-3 line-clamp-2 break-words text-sm leading-6 text-ink">
                          {item.text_preview?.trim()
                            ? item.text_preview
                            : "Chưa có văn bản OCR để xem trước."}
                        </p>
                      </div>
                      <div className="mt-auto flex flex-col items-stretch gap-3">
                        <Link
                          className="inline-flex min-h-12 items-center justify-center rounded-control bg-sky px-4 font-bold text-primary focus-visible:outline-3 focus-visible:outline-primary"
                          href={`/admin/books/${book.id}/pages/${item.processing.page_id}`}
                        >
                          {active
                            ? "Xem / Thay ảnh / Duyệt OCR"
                            : "Xem lịch sử OCR"}
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
                            <Trash2 aria-hidden className="size-4" /> Xóa trang
                          </Button>
                        ) : (
                          <span className="text-xs font-semibold text-muted">
                            Đã ngừng sử dụng
                          </span>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
            <AdminResultsPagination
              itemLabel="trang"
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
              Hủy
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
              Xóa trang
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
            ? `Xóa Trang ${pendingRetire.page_number}?`
            : "Xóa trang"
        }
        tone="paper"
      >
        <p className="text-sm leading-6 text-muted">
          Trang sẽ được ngừng sử dụng và không còn xuất hiện trong các lượt đọc
          mới. Ảnh nguồn, các revision và lịch sử đọc cũ vẫn được giữ để bảo
          toàn dữ liệu.
        </p>
      </Modal>
    </>
  );
}
