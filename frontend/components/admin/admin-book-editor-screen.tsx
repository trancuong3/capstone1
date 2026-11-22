"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
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
              className="inline-flex min-h-11 items-center rounded-md px-1 font-semibold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
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
    <section className="figma-form-page mx-auto flex w-full max-w-[960px] flex-col gap-4">
      <AdminPageHeader
        title="Chỉnh sửa metadata sách"
        description="Cập nhật tên sách, tiêu đề và khoảng lớp; giữ nguyên trang sách, revision và lịch sử đọc."
      />
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
      <Card className="w-full bg-white sm:px-8 sm:py-8">
        <h2 className="text-2xl font-extrabold text-ink">Thông tin sách</h2>
        <AdminBookForm
          cancelHref={cancelHref}
          initial={initial}
          onSubmit={saveMetadata}
          submitLabel="Lưu metadata"
        />
      </Card>
    </section>
  );
}
