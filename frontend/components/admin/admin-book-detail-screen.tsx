"use client";

import { ArrowLeft, FileSearch, RefreshCw } from "lucide-react";
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
        nextPages = await pages.list(bookId);
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
        actions={
          <>
            <Button disabled className="sm:w-auto" variant="secondary">
              Sửa thông tin
            </Button>
            <Button
              disabled
              className="sm:w-auto"
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
      <StatusMessage tone="info">
        Đang xem dữ liệu thật ở chế độ chỉ đọc. Tạo, sửa, tải ảnh và đổi trạng
        thái chưa sẵn sàng.
      </StatusMessage>
      <section className="mt-8" aria-labelledby="pages-title">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-black" id="pages-title">
            Trang sách
          </h2>
          <button
            className="flex min-h-12 items-center gap-2 rounded-control px-3 font-bold text-primary-hover hover:bg-sky"
            onClick={() => void load()}
            disabled={items === null}
            type="button"
          >
            <RefreshCw aria-hidden className="size-5" /> Tải lại
          </button>
        </div>
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
    </>
  );
}
