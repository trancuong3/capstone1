"use client";

import { ArrowLeft, FileSearch, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminBookForm } from "@/components/admin/admin-book-form";
import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import {
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookDTO, AdminPageListItemUI } from "@/types/admin";

export function AdminBookDetailScreen({ bookId }: { bookId: string }) {
  const { books, pages } = useAdminServices();
  const [book, setBook] = useState<AdminBookDTO | null>(null);
  const [items, setItems] = useState<readonly AdminPageListItemUI[] | null>(
    null,
  );
  const [error, setError] = useState<"not-found" | "safe" | null>(null);
  const [edit, setEdit] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const requestIdRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setError(null);
    try {
      const [nextBook, nextPages] = await Promise.all([
        books.get(bookId),
        pages.list(bookId),
      ]);
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
          <Link
            className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
            href="/admin/books"
          >
            Quay lại kho sách
          </Link>
        }
      />
    );
  if (!book) return null;
  const nextPage =
    Math.max(0, ...(items ?? []).map((item) => item.page_number)) + 1;
  async function toggleStatus() {
    if (!book) return;
    setStatusBusy(true);
    try {
      const updated = await books.updateStatus(book.id, {
        status: book.lifecycle_status === "ACTIVE" ? "RETIRED" : "ACTIVE",
      });
      setBook(updated);
      setNotice("Đã cập nhật vòng đời sách.");
    } catch {
      setNotice(
        "Không thể kích hoạt: sách cần ít nhất một trang ACTIVE có revision VERIFIED hiện hành.",
      );
    } finally {
      setStatusBusy(false);
      setConfirmStatus(false);
    }
  }
  async function reloadPages() {
    if (!items) return;
    setItems(null);
    try {
      await Promise.all(
        items
          .filter(
            (item) => item.processing.verification_status === "PROCESSING",
          )
          .map((item) => pages.reload(item.processing.page_id)),
      );
      await load();
      setNotice("Đã tải lại trạng thái xử lý trang.");
    } catch {
      setNotice("Không thể tải lại trạng thái trang lúc này.");
      await load();
    }
  }
  return (
    <>
      <AdminPageHeader
        eyebrow="Chi tiết sách"
        title={book.title}
        description={`${book.author ?? "Chưa có tác giả"} · Khối ${book.min_grade}–${book.max_grade}`}
        actions={
          <>
            <Button
              className="sm:w-auto"
              onClick={() => setEdit((value) => !value)}
              variant="secondary"
            >
              {edit ? "Đóng chỉnh sửa" : "Sửa thông tin"}
            </Button>
            <Button
              className="sm:w-auto"
              onClick={() => setConfirmStatus(true)}
              variant={book.lifecycle_status === "ACTIVE" ? "quiet" : "primary"}
            >
              {book.lifecycle_status === "ACTIVE"
                ? "Ngừng phát hành"
                : "Kích hoạt"}
            </Button>
          </>
        }
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
      {notice ? (
        <StatusMessage
          className="mb-6"
          tone={notice.startsWith("Đã") ? "success" : "warning"}
        >
          {notice}
        </StatusMessage>
      ) : null}
      {edit ? (
        <Card className="mb-6 bg-white">
          <h2 className="text-2xl font-black">Chỉnh sửa metadata</h2>
          <AdminBookForm
            initial={{
              title: book.title,
              author: book.author,
              min_grade: book.min_grade,
              max_grade: book.max_grade,
            }}
            onSubmit={async (value) => {
              const updated = await books.update(book.id, value);
              setBook(updated);
              setEdit(false);
              setNotice("Đã lưu thông tin sách.");
            }}
          />
        </Card>
      ) : null}
      <AdminPageUploader
        bookId={book.id}
        nextPageNumber={nextPage}
        onUploaded={() => void load()}
      />
      <section className="mt-8" aria-labelledby="pages-title">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-black" id="pages-title">
            Trang sách
          </h2>
          <button
            className="flex min-h-12 items-center gap-2 rounded-control px-3 font-bold text-primary-hover hover:bg-sky"
            onClick={() => void reloadPages()}
            type="button"
          >
            <RefreshCw aria-hidden className="size-5" /> Tải lại
          </button>
        </div>
        {!items ? (
          <AdminLoading />
        ) : items.length === 0 ? (
          <EmptyState
            title="Sách chưa có trang"
            description="Tải ảnh trang đầu tiên để tạo revision R1."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <Link
                className="rounded-card focus-visible:outline-3 focus-visible:outline-primary"
                href={`/admin/books/${book.id}/pages/${item.processing.page_id}`}
                key={item.processing.page_id}
              >
                <Card className="h-full bg-white hover:shadow-lg">
                  <div className="flex items-start justify-between">
                    <div className="grid size-12 place-items-center rounded-control bg-sky text-primary">
                      <FileSearch aria-hidden />
                    </div>
                    <AdminStatusBadge
                      status={item.processing.verification_status}
                    />
                  </div>
                  <div>
                    <h3 className="text-xl font-black">
                      Trang {item.page_number}
                    </h3>
                    <p className="mt-1 text-sm text-muted">
                      Revision R{item.processing.revision_no} ·{" "}
                      {item.processing.lifecycle_status}
                    </p>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
      <Modal
        isOpen={confirmStatus}
        onClose={() => setConfirmStatus(false)}
        title={
          book.lifecycle_status === "ACTIVE"
            ? "Ngừng phát hành sách?"
            : "Kích hoạt sách?"
        }
      >
        <p className="text-body text-muted">
          {book.lifecycle_status === "ACTIVE"
            ? "Sách RETIRED sẽ không xuất hiện trong lượt chấm điểm mới; dữ liệu lịch sử vẫn được giữ nguyên."
            : "Chỉ sách có trang ACTIVE và revision VERIFIED hiện hành mới đủ điều kiện."}
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button
            disabled={statusBusy}
            isLoading={statusBusy}
            onClick={() => void toggleStatus()}
          >
            {book.lifecycle_status === "ACTIVE"
              ? "Xác nhận ngừng"
              : "Xác nhận kích hoạt"}
          </Button>
          <Button
            disabled={statusBusy}
            onClick={() => setConfirmStatus(false)}
            variant="quiet"
          >
            Hủy
          </Button>
        </div>
      </Modal>
    </>
  );
}
