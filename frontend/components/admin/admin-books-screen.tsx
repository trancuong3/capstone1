"use client";

import { Archive, ArchiveRestore, PencilLine, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AdminLoading,
  AdminPageHeader,
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
    const timeout = globalThis.setTimeout(() => void load(), 0);
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
                  ? "Trạng thái mới đã được tải lại từ API. Dữ liệu sách và lịch sử đọc vẫn được giữ nguyên."
                  : "Trạng thái mới đã được tải lại từ API và sách có thể xuất hiện lại trong catalog nếu đáp ứng quy tắc hiện hành.",
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
          cause.status === 422
            ? "Metadata chưa hợp lệ. Hãy chỉnh sửa tiêu đề và khoảng lớp rồi thử kích hoạt lại."
            : "Backend chưa xác nhận thay đổi. Hãy kiểm tra quyền Admin hoặc kết nối rồi thử lại.",
      });
    } finally {
      setLifecycleBusyBookId(null);
    }
  }

  return (
    <>
      <AdminPageHeader
        eyebrow="Quản trị nội dung"
        title="Kho sách"
        description="Tạo sách, bổ sung tiêu đề còn thiếu, chỉnh sửa metadata và quản lý trạng thái hoạt động của từng sách."
        actions={
          <ButtonLink className="sm:w-auto" href="/admin/books/new">
            Tạo sách mới
          </ButtonLink>
        }
      />
      <StatusMessage className="mb-6" tone="info">
        Danh mục được tải từ API thật. Các thao tác cập nhật chỉ thay đổi
        metadata hoặc vòng đời sách; trang sách, revision và lịch sử đọc được
        giữ nguyên.
      </StatusMessage>
      <Card className="mb-6 bg-white">
        <div className="grid gap-4 lg:grid-cols-[1fr_240px_240px]">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute right-5 top-9 size-5 text-muted"
            />
            <TextField
              label="Tìm theo tên sách hoặc tác giả"
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
      </Card>

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
            <button
              className="mt-2 inline-flex min-h-11 items-center rounded-md px-1 font-extrabold underline focus-visible:outline-3 focus-visible:outline-primary"
              onClick={() => void load()}
              type="button"
            >
              Thử lại
            </button>
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
          description="Điều chỉnh bộ lọc hoặc kiểm tra dữ liệu sách trong database."
          title="Không tìm thấy sách"
        />
      ) : (
        <div className="grid gap-4">
          {items.map((item) => {
            const book = item.book;
            const missingTitle = !book.title.trim();
            const isBusy = lifecycleBusyBookId !== null;
            const editHref = missingTitle
              ? `/admin/books/${encodeURIComponent(book.id)}/edit?issue=MISSING_TITLE`
              : `/admin/books/${encodeURIComponent(book.id)}/edit`;

            return (
              <Card className="bg-white" key={book.id}>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
                    <div className="min-w-0">
                      <div className="mb-2 flex flex-wrap gap-2">
                        <AdminStatusBadge status={book.lifecycle_status} />
                        {item.parent_catalog_eligible ? (
                          <span className="rounded-full bg-sky px-3 py-1 text-sm font-extrabold text-primary-hover">
                            Có trong thư viện ba mẹ
                          </span>
                        ) : null}
                      </div>
                      <Link
                        className="inline-block rounded-sm focus-visible:outline-3 focus-visible:outline-primary"
                        href={`/admin/books/${encodeURIComponent(book.id)}`}
                      >
                        <h2 className="text-2xl font-black">
                          {missingTitle ? "Chưa có tiêu đề" : book.title}
                        </h2>
                      </Link>
                      <p className="text-muted">
                        {book.author?.trim() ? book.author : "Chưa có tác giả"}{" "}
                        · Khối {book.min_grade}–{book.max_grade}
                      </p>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                      <Metric label="Trang" value={item.page_count} />
                      <Metric label="Xử lý" value={item.processing_count} />
                      <Metric
                        label="Cần duyệt"
                        value={item.needs_review_count}
                      />
                      <Metric label="Đã duyệt" value={item.verified_count} />
                    </dl>
                  </div>

                  <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                    <Link
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-border px-3 py-2 text-sm font-bold text-primary hover:bg-sky focus-visible:outline-3 focus-visible:outline-primary"
                      href={editHref}
                    >
                      <PencilLine aria-hidden className="size-4" />
                      {missingTitle ? "Bổ sung tiêu đề" : "Chỉnh sửa thông tin"}
                    </Link>
                    <Button
                      className="h-auto min-h-11 w-auto px-3 py-2 text-sm"
                      disabled={isBusy}
                      isLoading={lifecycleBusyBookId === book.id}
                      onClick={() => void changeLifecycle(book)}
                      variant="secondary"
                    >
                      {book.lifecycle_status === "ACTIVE" ? (
                        <Archive aria-hidden className="size-4" />
                      ) : (
                        <ArchiveRestore aria-hidden className="size-4" />
                      )}
                      {lifecycleBusyBookId === book.id
                        ? "Đang cập nhật…"
                        : book.lifecycle_status === "ACTIVE"
                          ? "Ngừng hoạt động"
                          : "Kích hoạt lại"}
                    </Button>
                    <Link
                      className="inline-flex min-h-11 items-center justify-center rounded-control px-3 py-2 text-sm font-bold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
                      href={`/admin/books/${encodeURIComponent(book.id)}`}
                    >
                      Xem chi tiết / trang sách
                    </Link>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-control bg-canvas px-3 py-2">
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="text-xl font-black">{value}</dd>
    </div>
  );
}
