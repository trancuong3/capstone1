"use client";

import { ArrowLeft, FileSearch, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookDTO, AdminPageListItemUI } from "@/types/admin";

export function AdminBookDetailScreen({ bookId }: { bookId: string }) {
  const { books, pages } = useAdminServices();
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
  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setError(null);
    setBook(null);
    setItems(null);
    setPagesUnavailable(false);
    try {
      const nextBook = await books.get(bookId);
      if (requestId !== requestIdRef.current) return;
      setBook(nextBook);
      let nextPages: readonly AdminPageListItemUI[];
      try {
        nextPages = (await pages.list(bookId)).filter(
          (item) => item.processing.lifecycle_status === "ACTIVE",
        );
      } catch (cause) {
        if (isServiceError(cause) && [501, 503].includes(cause.status)) {
          if (requestId !== requestIdRef.current) return;
          setPagesUnavailable(true);
          setItems([]);
          return;
        }
        throw cause;
      }
      if (requestId !== requestIdRef.current) return;
      setBook(nextBook);
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
  }, [bookId, books, pages]);
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
      setItems((current) =>
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
      if (requestId !== requestIdRef.current) return;
      setPageActionNotice({
        tone: "error",
        title: "Không thể xóa trang",
        message:
          "Không thể ngừng sử dụng trang lúc này. Hãy kiểm tra quyền Admin hoặc kết nối Backend rồi thử lại.",
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
  return (
    <>
      <AdminPageHeader
        eyebrow="Chi tiết sách"
        title={book.title}
        description={`${book.author ?? "Chưa có tác giả"} · Khối ${book.min_grade}–${book.max_grade}`}
      />
      <Link
        className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href="/admin/books"
      >
        <ArrowLeft aria-hidden className="size-5" /> Kho sách
      </Link>
      <div className="mb-6 flex items-center gap-3">
        <AdminStatusBadge status={book.lifecycle_status} />
        <span className="text-sm text-muted">ID: {book.id}</span>
      </div>
      <AdminPageUploader
        bookId={book.id}
        nextPageNumber={Math.max(
          1,
          book.next_page_number ?? 1,
          ...(items ?? []).map((item) => item.page_number + 1),
        )}
        onUploaded={() => void load()}
      />
      <section className="mt-8" aria-labelledby="pages-title">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-black" id="pages-title">
            Trang sách
          </h2>
          <button
            className="flex min-h-12 items-center gap-2 rounded-control px-3 font-bold text-primary-hover hover:bg-sky"
            onClick={() => void load()}
            disabled={items === null || retiringPageId !== null}
            type="button"
          >
            <RefreshCw aria-hidden className="size-5" /> Tải lại
          </button>
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
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => {
              const active = item.processing.lifecycle_status === "ACTIVE";
              return (
                <Card className="h-full bg-white" key={item.processing.page_id}>
                  <div className="flex h-full flex-col gap-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="grid size-12 shrink-0 place-items-center rounded-control bg-sky text-primary">
                        <FileSearch aria-hidden />
                      </div>
                      <AdminStatusBadge
                        status={
                          active
                            ? item.processing.verification_status
                            : "RETIRED"
                        }
                      />
                    </div>
                    <div>
                      <h3 className="text-xl font-black">
                        Trang {item.page_number}
                      </h3>
                      <p className="mt-1 text-sm text-muted">
                        Revision R{item.processing.revision_no}
                      </p>
                      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-ink">
                        {item.text_preview?.trim()
                          ? item.text_preview
                          : "Chưa có văn bản OCR để xem trước."}
                      </p>
                    </div>
                    <div className="mt-auto flex flex-wrap items-center gap-3 border-t border-border pt-3">
                      <Link
                        className="inline-flex min-h-10 items-center rounded-md px-1 font-extrabold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
                        href={`/admin/books/${book.id}/pages/${item.processing.page_id}`}
                      >
                        {active ? "Xem/Sửa nội dung" : "Xem lịch sử OCR"}
                      </Link>
                      {active ? (
                        <Button
                          className="sm:w-auto"
                          disabled={retiringPageId !== null}
                          onClick={() => {
                            setPageActionNotice(null);
                            setPendingRetire(item);
                          }}
                          variant="secondary"
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
        )}
      </section>
      {pendingRetire ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            aria-labelledby="retire-page-title"
            aria-modal="true"
            className="w-full max-w-lg rounded-card bg-white p-6 shadow-2xl"
            role="alertdialog"
          >
            <h2 className="text-xl font-black" id="retire-page-title">
              Xóa Trang {pendingRetire.page_number}?
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              Trang sẽ được ngừng sử dụng và không còn xuất hiện trong các lượt
              đọc mới. Ảnh nguồn, các revision và lịch sử đọc cũ vẫn được giữ để
              bảo toàn dữ liệu.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <Button
                disabled={retiringPageId !== null}
                onClick={() => setPendingRetire(null)}
                variant="secondary"
              >
                Hủy
              </Button>
              <Button
                disabled={retiringPageId !== null}
                isLoading={retiringPageId === pendingRetire.processing.page_id}
                onClick={() => void retirePendingPage()}
              >
                Xóa trang
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
