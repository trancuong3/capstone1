"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { BookCover } from "@/components/books/book-cover";
import { Button, ButtonLink } from "@/components/common/button";
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useTranslations } from "@/hooks/use-i18n";
import type { AdminBookCreateDTO } from "@/types/admin";
import type { AssetSourceType } from "@/types/book-assets";

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
  submitErrorFallback?: string;
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
  submitErrorFallback,
  submitLabel,
}: AdminBookFormProps) {
  const t = useTranslations("admin");
  const schema = useMemo(
    () =>
      z
        .object({
          name: z
            .string()
            .trim()
            .min(1, t("books.form.validation.nameRequired")),
          title: z
            .string()
            .trim()
            .min(1, t("books.form.validation.titleRequired")),
          author: z.string().nullable(),
          min_grade: z
            .number()
            .int(t("books.form.validation.minInt"))
            .min(1, t("books.form.validation.minRange"))
            .max(5, t("books.form.validation.minRange")),
          max_grade: z
            .number()
            .int(t("books.form.validation.maxInt"))
            .min(1, t("books.form.validation.maxRange"))
            .max(5, t("books.form.validation.maxRange")),
        })
        .refine((value) => value.min_grade <= value.max_grade, {
          message: t("books.form.validation.gradeOrder"),
          path: ["max_grade"],
        }),
    [t],
  );
  const resolvedSubmitLabel = submitLabel ?? t("books.form.defaultSubmit");
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
        message: submitErrorFallback ?? t("books.form.genericSaveError"),
      });
    }
  });

  const resolvedMinGrade = Number.isFinite(watchedMinGrade)
    ? watchedMinGrade
    : 1;
  const resolvedMaxGrade = Number.isFinite(watchedMaxGrade)
    ? watchedMaxGrade
    : 3;
  const gradePreviewLabel =
    resolvedMinGrade === resolvedMaxGrade
      ? `Lớp ${resolvedMinGrade}`
      : `Lớp ${resolvedMinGrade}–${resolvedMaxGrade}`;

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
            author={watchedAuthor?.trim() || null}
            book={{
              id: bookId,
              title: watchedTitle?.trim() || "Tiêu đề sách mới",
              author: watchedAuthor?.trim() || null,
              min_grade: resolvedMinGrade,
              max_grade: resolvedMaxGrade,
              lifecycle_status: "ACTIVE",
            }}
            coverSourceType={coverSourceType}
            coverUrl={coverUrl}
            grade={gradePreviewLabel}
            size="medium"
          />
          <div className="min-w-0 flex-1 text-xs text-muted">
            <p className="font-bold text-ink">
              {coverUrl
                ? "Xem trước ảnh bìa đã chọn"
                : "Xem trước bìa chữ tự động"}
            </p>
            <p className="mt-1">
              {coverUrl
                ? "Ảnh bìa sẽ được chuẩn hóa 3:4 WebP và ưu tiên hiển thị cao nhất cho sách này."
                : "Khi chưa tải ảnh bìa riêng, ViRead tự tạo bìa chữ tiếng Việt sắc nét theo tiêu đề, tác giả và khối lớp."}
            </p>
          </div>
        </div>
      ) : null}
      {coverStudioSlot}
      <TextField
        error={errors.name?.message}
        errorRole="alert"
        label={t("books.form.nameLabel")}
        maxLength={250}
        required
        {...register("name")}
      />
      <TextField
        error={errors.title?.message}
        errorRole="alert"
        label={t("books.form.titleLabel")}
        maxLength={250}
        required
        {...register("title")}
      />
      <TextField
        error={errors.author?.message}
        label={t("books.form.authorLabel")}
        maxLength={250}
        {...register("author")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          error={errors.min_grade?.message}
          label={t("books.form.minGradeLabel")}
          required
          {...register("min_grade", { valueAsNumber: true })}
        >
          {initial?.min_grade !== undefined &&
          (initial.min_grade < 1 || initial.min_grade > 5) ? (
            <option value={initial.min_grade}>
              {t("books.form.invalidGradeOption", {
                grade: initial.min_grade,
              })}
            </option>
          ) : null}
          {[1, 2, 3, 4, 5].map((grade) => (
            <option key={grade} value={grade}>
              {t("books.form.gradeOption", { grade })}
            </option>
          ))}
        </SelectField>
        <SelectField
          error={errors.max_grade?.message}
          label={t("books.form.maxGradeLabel")}
          required
          {...register("max_grade", { valueAsNumber: true })}
        >
          {initial?.max_grade !== undefined &&
          (initial.max_grade < 1 || initial.max_grade > 5) ? (
            <option value={initial.max_grade}>
              {t("books.form.invalidGradeOption", {
                grade: initial.max_grade,
              })}
            </option>
          ) : null}
          {[1, 2, 3, 4, 5].map((grade) => (
            <option key={grade} value={grade}>
              {t("books.form.gradeOption", { grade })}
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
          {isSubmitting ? t("common.saving") : resolvedSubmitLabel}
        </Button>
        <ButtonLink href={cancelHref} size="compact" variant="quiet">
          {t("common.cancel")}
        </ButtonLink>
      </div>
    </form>
  );
}
