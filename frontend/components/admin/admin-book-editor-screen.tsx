"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { AdminBookForm } from "@/components/admin/admin-book-form";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookCreateDTO, AdminBookDTO } from "@/types/admin";

const issueLabels: Record<string, string> = {
  MISSING_TITLE: "Thiếu tiêu đề",
  MISSING_AUTHOR: "Chưa có tác giả",
  INVALID_GRADE_RANGE: "Khoảng lớp không hợp lệ",
  POSSIBLE_DUPLICATE: "Có thể trùng sách",
};

interface AdminBookEditorScreenProps {
  bookId: string;
  returnTo?: "detail" | "metadata-quality";
  issue?: string;
}

export function AdminBookEditorScreen({
  bookId,
  returnTo = "detail",
  issue,
}: AdminBookEditorScreenProps) {
  const { books } = useAdminServices();
  const router = useRouter();
  const [book, setBook] = useState<AdminBookDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"not-found" | "safe" | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
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
    const confirmation =
      nextStatus === "RETIRED"
        ? "Ngừng hoạt động sách này? Trang sách và lịch sử đọc sẽ được giữ nguyên."
        : "Kích hoạt lại sách này trong catalog dành cho phụ huynh?";
    if (!window.confirm(confirmation)) return;

    setStatusBusy(true);
    setNotice(null);
    try {
      const updated = await books.updateStatus(bookId, { status: nextStatus });
      if (updated.id !== bookId || updated.lifecycle_status !== nextStatus) {
        throw new Error("Unexpected lifecycle response");
      }
      setBook(updated);
      setNotice({
        tone: "info",
        title:
          nextStatus === "RETIRED"
            ? "Đã ngừng hoạt động sách"
            : "Đã kích hoạt lại sách",
        message:
          nextStatus === "RETIRED"
            ? "Sách không còn xuất hiện trong catalog Parent. Metadata, trang sách, revision và lịch sử đọc vẫn được giữ nguyên."
            : "Trạng thái mới đã được lưu. Kho sách và dashboard sẽ đọc lại dữ liệu từ API khi mở hoặc tải lại.",
      });
    } catch (cause) {
      setNotice({
        tone: "error",
        title:
          nextStatus === "ACTIVE"
            ? "Không thể kích hoạt sách"
            : "Không thể ngừng hoạt động sách",
        message:
          nextStatus === "ACTIVE" &&
          isServiceError(cause) &&
          cause.status === 422
            ? "Metadata hiện tại chưa hợp lệ. Hãy sửa tiêu đề và khoảng lớp ở biểu mẫu rồi lưu trước khi kích hoạt."
            : "Yêu cầu không được xác nhận. Hãy kiểm tra quyền Admin hoặc kết nối Backend rồi thử lại.",
      });
    } finally {
      setStatusBusy(false);
    }
  }

  if (loading) return <AdminLoading label="Đang tải metadata sách…" />;

  if (error || !book) {
    return (
      <EmptyState
        headingLevel={1}
        title={
          error === "not-found"
            ? "Không tìm thấy sách"
            : "Không thể tải metadata sách"
        }
        description={
          error === "not-found"
            ? "Sách không tồn tại hoặc không còn trong dữ liệu quản trị."
            : "Không thể tải dữ liệu từ Backend. Vui lòng thử lại."
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
  }

  const initial: AdminBookCreateDTO = {
    title: book.title.trim() ? book.title : "",
    author: book.author ?? "",
    min_grade: book.min_grade,
    max_grade: book.max_grade,
  };

  return (
    <>
      <AdminPageHeader
        eyebrow="Kho sách · Metadata"
        title="Chỉnh sửa metadata sách"
        description="Chỉnh sửa đầu sách hiện có. Thay đổi này không sửa hoặc xóa trang sách, revision hay lịch sử đọc."
      />
      <Link
        className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href={
          returnTo === "metadata-quality"
            ? "/admin/metadata-quality"
            : `/admin/books/${encodeURIComponent(bookId)}`
        }
      >
        <ArrowLeft aria-hidden className="size-5" />
        {returnTo === "metadata-quality"
          ? "Quay lại chất lượng metadata"
          : "Quay lại chi tiết sách"}
      </Link>
      {issue && issueLabels[issue] ? (
        <StatusMessage
          className="mb-5"
          tone="info"
          title={`Cần xử lý: ${issueLabels[issue]}`}
        >
          Kiểm tra trường liên quan bên dưới. Dashboard chỉ xóa cảnh báo sau khi
          tải lại dữ liệu từ Backend và điều kiện đó đã được khắc phục.
        </StatusMessage>
      ) : null}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <AdminStatusBadge status={book.lifecycle_status} />
        <span className="text-sm text-muted">ID: {book.id}</span>
        <Button
          disabled={statusBusy}
          isLoading={statusBusy}
          onClick={() => void changeLifecycle()}
          variant="secondary"
        >
          {book.lifecycle_status === "ACTIVE"
            ? "Ngừng hoạt động"
            : "Kích hoạt lại"}
        </Button>
      </div>
      {notice ? (
        <StatusMessage className="mb-5" tone={notice.tone} title={notice.title}>
          {notice.message}
        </StatusMessage>
      ) : null}
      <Card className="max-w-3xl bg-white">
        <h2 className="mb-5 text-xl font-black">Thông tin sách</h2>
        <AdminBookForm
          initial={initial}
          onSubmit={saveMetadata}
          submitLabel="Lưu metadata"
        />
      </Card>
    </>
  );
}
