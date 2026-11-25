"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { BookCover } from "@/components/books/book-cover";
import { Button, ButtonLink } from "@/components/common/button";
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import type { AdminBookCreateDTO } from "@/types/admin";
import type { AssetSourceType } from "@/types/book-assets";

const schema = z
  .object({
    name: z.string().trim().min(1, "Vui lòng nhập tên sách."),
    title: z.string().trim().min(1, "Vui lòng nhập tiêu đề sách."),
    author: z.string().nullable(),
    min_grade: z
      .number()
      .int("Khối lớp nhỏ nhất phải là số nguyên từ 1 đến 5.")
      .min(1, "Khối lớp nhỏ nhất phải từ 1 đến 5.")
      .max(5, "Khối lớp nhỏ nhất phải từ 1 đến 5."),
    max_grade: z
      .number()
      .int("Khối lớp lớn nhất phải là số nguyên từ 1 đến 5.")
      .min(1, "Khối lớp lớn nhất phải từ 1 đến 5.")
      .max(5, "Khối lớp lớn nhất phải từ 1 đến 5."),
  })
  .refine((value) => value.min_grade <= value.max_grade, {
    message: "Khối lớp nhỏ nhất không được lớn hơn khối lớp lớn nhất.",
    path: ["max_grade"],
  });

type AdminBookFormInitial = Omit<Partial<AdminBookCreateDTO>, "name"> & {
  readonly name?: string | null;
};

interface AdminBookFormProps {
  bookId?: string;
  cancelHref?: string;
  coverSourceType?: AssetSourceType | null;
  coverStudioSlot?: ReactNode;
  coverUrl?: string | null;
  initial?: AdminBookFormInitial;
  onSubmit: (value: AdminBookCreateDTO) => Promise<void>;
  showLiveCoverPreview?: boolean;
  submitLabel?: string;
}

export function AdminBookForm({
  bookId = "draft-book",
  cancelHref = "/admin/books",
  coverSourceType = null,
  coverStudioSlot,
  coverUrl = null,
  initial,
  onSubmit,
  showLiveCoverPreview = false,
  submitLabel = "Lưu sách",
}: AdminBookFormProps) {
  const {
    control,
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<AdminBookCreateDTO>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? "",
      title: initial?.title ?? "",
      author: initial?.author ?? "",
      min_grade: initial?.min_grade ?? 1,
      max_grade: initial?.max_grade ?? 3,
    },
  });

  const watchedTitle = useWatch({ control, name: "title" });
  const watchedAuthor = useWatch({ control, name: "author" });
  const watchedMinGrade = useWatch({ control, name: "min_grade" });
  const watchedMaxGrade = useWatch({ control, name: "max_grade" });

  const submit = handleSubmit(async (value) => {
    try {
      await onSubmit({
        ...value,
        name: value.name.trim(),
        title: value.title.trim(),
        author: value.author?.trim() || null,
      });
    } catch {
      setError("root", {
        message: "Không thể lưu sách lúc này. Vui lòng thử lại.",
      });
    }
  });

  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      {errors.root?.message ? (
        <StatusMessage tone="error">{errors.root.message}</StatusMessage>
      ) : null}
      {showLiveCoverPreview ? (
        <div
          className="flex flex-wrap items-center gap-4 rounded-control border border-border bg-canvas/60 p-3"
          data-testid="admin-book-live-cover-preview"
        >
          <BookCover
            author={watchedAuthor || null}
            book={{
              id: bookId,
              title: watchedTitle?.trim() || "Tiêu đề sách mới",
              author: watchedAuthor || null,
              min_grade: Number.isFinite(watchedMinGrade) ? watchedMinGrade : 1,
              max_grade: Number.isFinite(watchedMaxGrade) ? watchedMaxGrade : 3,
              lifecycle_status: "ACTIVE",
            }}
            coverSourceType={coverSourceType}
            coverUrl={coverUrl}
            size="medium"
          />
          <div className="min-w-0 flex-1 text-xs text-muted">
            <p className="font-bold text-ink">Xem trước bìa chữ tự động</p>
            <p className="mt-1">
              Khi chưa tải ảnh bìa riêng, ViRead tự tạo bìa chữ tiếng Việt sắc
              nét theo tiêu đề, tác giả và khối lớp.
            </p>
          </div>
        </div>
      ) : null}
      {coverStudioSlot}
      <TextField
        error={errors.name?.message}
        label="Tên sách *"
        required
        {...register("name")}
      />
      <TextField
        error={errors.title?.message}
        label="Tiêu đề sách *"
        required
        {...register("title")}
      />
      <TextField
        error={errors.author?.message}
        label="Tác giả"
        {...register("author")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          error={errors.min_grade?.message}
          label="Khối lớp nhỏ nhất *"
          required
          {...register("min_grade", { valueAsNumber: true })}
        >
          {initial?.min_grade !== undefined &&
          (initial.min_grade < 1 || initial.min_grade > 5) ? (
            <option value={initial.min_grade}>
              Giá trị hiện tại không hợp lệ ({initial.min_grade}) — cần sửa
            </option>
          ) : null}
          {[1, 2, 3, 4, 5].map((grade) => (
            <option key={grade} value={grade}>
              Khối {grade}
            </option>
          ))}
        </SelectField>
        <SelectField
          error={errors.max_grade?.message}
          label="Khối lớp lớn nhất *"
          required
          {...register("max_grade", { valueAsNumber: true })}
        >
          {initial?.max_grade !== undefined &&
          (initial.max_grade < 1 || initial.max_grade > 5) ? (
            <option value={initial.max_grade}>
              Giá trị hiện tại không hợp lệ ({initial.max_grade}) — cần sửa
            </option>
          ) : null}
          {[1, 2, 3, 4, 5].map((grade) => (
            <option key={grade} value={grade}>
              Khối {grade}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Button
          className="!max-w-none"
          disabled={isSubmitting}
          isLoading={isSubmitting}
          size="compact"
          type="submit"
        >
          {isSubmitting ? "Đang lưu…" : submitLabel}
        </Button>
        <ButtonLink href={cancelHref} size="compact" variant="quiet">
          Hủy
        </ButtonLink>
      </div>
    </form>
  );
}
