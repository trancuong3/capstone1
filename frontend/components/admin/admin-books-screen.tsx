"use client";

import Link from "next/link";
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
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAdminServices } from "@/hooks/use-admin-services";
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
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const requestIdRef = useRef(0);
  const loadRef = useRef<() => Promise<boolean>>(async () => false);

  const load = useCallback(async (): Promise<boolean> => {
    const requestId = ++requestIdRef.current;
    setPageNumber(1);
    setError(null);
    setItems(null);
    try {
      const nextItems = await books.list({
        search,
        lifecycle_status: lifecycle || undefined,
        verification_status: verification || undefined,
      });
      if (requestId !== requestIdRef.current) return false;
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
  }, [books, lifecycle, search, verification]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 200);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);

  async function changeLifecycle(book: AdminBookDTO) {
    if (lifecycleBusyBookId !== null) return;

    const nextStatus =
      book.lifecycle_status === "ACTIVE" ? "RETIRED" : "ACTIVE";
    const confirmation =
      nextStatus === "RETIRED"
        ? "Ngừng hoạt động sách này? Trang sách, revision và lịch sử đọc sẽ được giữ nguyên."
        : "Kích hoạt lại sách này? Sách chỉ được kích hoạt khi metadata hợp lệ.";
    if (!window.confirm(confirmation)) return;

    setLifecycleBusyBookId(book.id);
    setActionNotice(null);
    try {
      const updated = await books.updateStatus(book.id, { status: nextStatus });
      if (updated.id !== book.id || updated.lifecycle_status !== nextStatus) {
        throw new Error("Unexpected lifecycle response");
      }

      const reloaded = await loadRef.current();
      setActionNotice(
        reloaded
          ? {
              tone: "info",
              title:
                nextStatus === "RETIRED"
                  ? "Đã ngừng hoạt động sách"
                  : "Đã kích hoạt lại sách",
              message:
                nextStatus === "RETIRED"
                  ? "Các trang sách và lịch sử đọc đã được giữ lại."
                  : "Sách có thể xuất hiện lại trong thư viện khi có trang đã duyệt.",
            }
          : {
              tone: "error",
              title: "Đã lưu trạng thái nhưng chưa tải lại được Kho sách",
              message:
                "Backend đã xác nhận cập nhật. Danh sách chưa đồng bộ được; hãy bấm Thử lại để tải trạng thái mới từ API.",
            },
      );
    } catch (cause) {
      setActionNotice({
        tone: "error",
        title:
          nextStatus === "ACTIVE"
            ? "Không thể kích hoạt lại sách"
            : "Không thể ngừng hoạt động sách",
        message:
          nextStatus === "ACTIVE" &&
          isServiceError(cause) &&
          cause.status === 409
            ? "Child Safety chưa cho phép đưa sách vào thư viện. Hoàn tất OCR VERIFIED và xác nhận Safety khớp Candidate cho tất cả trang; finding HIGH hoặc NOT_RECOMMENDED tiếp tục bị chặn."
            : nextStatus === "ACTIVE" &&
                isServiceError(cause) &&
                cause.status === 422
              ? "Metadata chưa hợp lệ. Hãy chỉnh sửa tiêu đề và khoảng lớp rồi thử kích hoạt lại."
              : "Backend chưa xác nhận thay đổi. Hãy kiểm tra quyền Admin hoặc kết nối rồi thử lại.",
      });
    } finally {
      setLifecycleBusyBookId(null);
    }
  }

  const visibleItems = items?.slice(
    (pageNumber - 1) * pageSize,
    pageNumber * pageSize,
  );

  return (
    <>
      <AdminPageHeader
        eyebrow="Quản trị nội dung"
        title="Kho sách"
        description="Chỉnh sửa thông tin sách và kiểm tra những trang đang chờ duyệt."
        actions={
          <ButtonLink className="sm:w-auto sm:px-6" href="/admin/books/new">
            Tạo sách mới
          </ButtonLink>
        }
      />
      <p aria-label="Tổng quan kho sách" className="mb-4 text-sm text-muted">
        {items
          ? `${items.length} sách · ${items.filter((i) => i.book.lifecycle_status === "ACTIVE").length} đang hoạt động · ${items.reduce((t, i) => t + i.needs_review_count, 0)} trang cần duyệt OCR`
          : "Đang tải…"}
      </p>
      <div className="mb-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="relative">
            <TextField
              label="Tìm theo tên sách, tiêu đề hoặc tác giả"
              onChange={(event) => setSearch(event.target.value)}
              value={search}
            />
          </div>
          <SelectField
            label="Vòng đời"
            onChange={(event) =>
              setLifecycle(event.target.value as BookLifecycleStatus | "")
            }
            value={lifecycle}
          >
            <option value="">Tất cả</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="RETIRED">RETIRED</option>
          </SelectField>
          <SelectField
            label="Trạng thái OCR"
            onChange={(event) =>
              setVerification(
                event.target.value as PageRevisionVerificationStatus | "",
              )
            }
            value={verification}
          >
            <option value="">Tất cả</option>
            <option value="PROCESSING">PROCESSING</option>
            <option value="NEEDS_REVIEW">NEEDS_REVIEW</option>
            <option value="VERIFIED">VERIFIED</option>
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
              ? "Cần đăng nhập quản trị"
              : error === "forbidden"
                ? "Không có quyền truy cập"
                : "Không thể tải kho sách"
          }
        >
          {error === "safe" ? (
            <Button
              className="mt-2 sm:w-auto"
              onClick={() => void load()}
              type="button"
              variant="secondary"
            >
              Thử lại
            </Button>
          ) : (
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/login"
            >
              Đến trang đăng nhập
            </Link>
          )}
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          description="Thử tên sách khác hoặc thay đổi bộ lọc."
          title="Không tìm thấy sách"
        />
      ) : (
        <div className="grid gap-5">
          <AdminResultsPagination
            itemLabel="sách"
            onPageChange={setPageNumber}
            page={pageNumber}
            pageSize={pageSize}
            total={items.length}
          />
          {visibleItems?.map((item) => {
            const book = item.book;
            const missingTitle = !book.title.trim();
            const isBusy = lifecycleBusyBookId !== null;
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
                    {missingTitle ? "Chưa có tiêu đề" : book.title}
                  </h2>
                </Link>
                <p className="text-body text-muted">
                  Tên sách: {book.name?.trim() ? book.name : "Chưa có tên sách"}{" "}
                  · {book.author?.trim() ? book.author : "Chưa có tác giả"} ·
                  Khối {book.min_grade}–{book.max_grade}
                </p>
                <div className="flex flex-wrap gap-2">
                  <AdminStatusBadge status={book.lifecycle_status} />
                  {item.parent_catalog_eligible ? (
                    <span className="rounded-control bg-sky px-3 py-1 text-sm font-bold text-primary">
                      Có trong thư viện ba mẹ
                    </span>
                  ) : book.lifecycle_status === "ACTIVE" ? (
                    <span className="rounded-control bg-amber-100 px-3 py-1 text-sm font-bold text-amber-950">
                      Chưa đủ điều kiện thư viện trẻ em · OCR / Safety
                    </span>
                  ) : null}
                </div>
                <p
                  aria-label="Trạng thái trang sách"
                  className="text-label text-muted"
                >
                  {item.page_count} trang · Đang xử lý {item.processing_count} ·
                  Cần duyệt {item.needs_review_count} · Đã duyệt{" "}
                  {item.verified_count}
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <ButtonLink
                    variant="secondary"
                    href={`/admin/books/${encodeURIComponent(book.id)}`}
                  >
                    Xem các trang
                  </ButtonLink>
                  <ButtonLink variant="quiet" href={editHref}>
                    {missingTitle ? "Bổ sung tiêu đề" : "Chỉnh sửa thông tin"}
                  </ButtonLink>
                  <Button
                    disabled={isBusy}
                    isLoading={lifecycleBusyBookId === book.id}
                    onClick={() => void changeLifecycle(book)}
                    variant="quiet"
                  >
                    {lifecycleBusyBookId === book.id
                      ? "Đang cập nhật…"
                      : book.lifecycle_status === "ACTIVE"
                        ? "Ngừng hoạt động"
                        : "Kích hoạt lại"}
                  </Button>
                </div>
              </Card>
            );
          })}
          <AdminResultsPagination
            itemLabel="sách"
            onPageChange={setPageNumber}
            page={pageNumber}
            pageSize={pageSize}
            total={items.length}
          />
        </div>
      )}
    </>
  );
}
