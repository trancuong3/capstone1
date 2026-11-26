"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown } from "lucide-react";
import { useId, useMemo, useRef, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { BookCover } from "@/components/books/book-cover";
import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import type { AdminBookCreateDTO } from "@/types/admin";
import type { BookLifecycleStatus } from "@/types/book";
import type { AssetSourceType } from "@/types/book-assets";

type AdminBookFormInitial = Omit<Partial<AdminBookCreateDTO>, "name"> & {
  readonly name?: string | null;
};

export interface AdminBookFormProps {
  bookId?: string;
  cancelHref?: string;
  coverSourceType?: AssetSourceType | null;
  coverStudioSlot?: ReactNode;
  coverUrl?: string | null;
  errorFallbackMessage?: string;
  formBanner?: ReactNode;
  formHeading?: string;
  initial?: AdminBookFormInitial;
  lifecycleStatus?: BookLifecycleStatus;
  onSubmit: (value: AdminBookCreateDTO) => Promise<void>;
  showLiveCoverPreview?: boolean;
  sidebarExtra?: ReactNode;
  submitErrorFallback?: string;
  submitLabel?: string;
}

const inputBaseClassName =
  "h-11 w-full rounded-control border bg-white px-3.5 text-sm text-ink placeholder:text-muted/70 transition-colors focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted";

export function AdminBookForm({
  bookId = "draft-book",
  cancelHref = "/admin/books",
  coverSourceType = null,
  coverStudioSlot,
  coverUrl = null,
  errorFallbackMessage,
  formBanner,
  formHeading,
  initial,
  lifecycleStatus = "ACTIVE",
  onSubmit,
  showLiveCoverPreview = false,
  sidebarExtra,
  submitErrorFallback,
  submitLabel,
}: AdminBookFormProps) {
  const t = useTranslations("admin");
  const baseId = useId();
  const submittingRef = useRef(false);

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
  const resolvedErrorFallback =
    errorFallbackMessage ??
    submitErrorFallback ??
    t("books.form.genericSaveError");

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
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onSubmit({
        ...value,
        name: value.name.trim(),
        title: value.title.trim(),
        author: value.author?.trim() || null,
      });
    } catch {
      setError("root", {
        message: resolvedErrorFallback,
      });
    } finally {
      submittingRef.current = false;
    }
  });

  const nameId = `${baseId}-name`;
  const titleId = `${baseId}-title`;
  const authorId = `${baseId}-author`;
  const minGradeId = `${baseId}-min-grade`;
  const maxGradeId = `${baseId}-max-grade`;

  const formFields = (
    <form className="space-y-4" noValidate onSubmit={submit}>
      {formBanner}
      {formHeading ? (
        <h2 className="text-lg font-extrabold tracking-tight text-ink">
          {formHeading}
        </h2>
      ) : null}
      {errors.root?.message ? (
        <StatusMessage tone="error">{errors.root.message}</StatusMessage>
      ) : null}

      <div className="space-y-1.5">
        <label className="block text-xs font-bold text-ink" htmlFor={nameId}>
          {t("books.form.nameLabel")}
        </label>
        <input
          aria-describedby={errors.name ? `${nameId}-error` : undefined}
          aria-invalid={Boolean(errors.name)}
          className={cn(
            inputBaseClassName,
            errors.name ? "border-danger" : "border-border",
          )}
          id={nameId}
          maxLength={250}
          placeholder={t(
            "books.form.namePlaceholder",
            undefined,
            "Ví dụ: Chú mèo đi hia (tên quản lý nội bộ)",
          )}
          required
          {...register("name")}
        />
        {errors.name?.message ? (
          <p
            className="text-xs font-semibold text-danger"
            id={`${nameId}-error`}
            role="alert"
          >
            {errors.name.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-bold text-ink" htmlFor={titleId}>
          {t("books.form.titleLabel")}
        </label>
        <input
          aria-describedby={errors.title ? `${titleId}-error` : undefined}
          aria-invalid={Boolean(errors.title)}
          className={cn(
            inputBaseClassName,
            errors.title ? "border-danger" : "border-border",
          )}
          id={titleId}
          maxLength={250}
          placeholder={t(
            "books.form.titlePlaceholder",
            undefined,
            "Ví dụ: Chú mèo đi hia",
          )}
          required
          {...register("title")}
        />
        {errors.title?.message ? (
          <p
            className="text-xs font-semibold text-danger"
            id={`${titleId}-error`}
            role="alert"
          >
            {errors.title.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs font-bold text-ink" htmlFor={authorId}>
          {t("books.form.authorLabel")}
        </label>
        <input
          aria-describedby={errors.author ? `${authorId}-error` : undefined}
          aria-invalid={Boolean(errors.author)}
          className={cn(
            inputBaseClassName,
            errors.author ? "border-danger" : "border-border",
          )}
          id={authorId}
          maxLength={250}
          placeholder={t(
            "books.form.authorPlaceholder",
            undefined,
            "Ví dụ: Charles Perrault",
          )}
          {...register("author")}
        />
        {errors.author?.message ? (
          <p
            className="text-xs font-semibold text-danger"
            id={`${authorId}-error`}
            role="alert"
          >
            {errors.author.message}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label
            className="block text-xs font-bold text-ink"
            htmlFor={minGradeId}
          >
            {t("books.form.minGradeLabel")}
          </label>
          <div className="relative flex items-center">
            <select
              aria-describedby={
                errors.min_grade ? `${minGradeId}-error` : undefined
              }
              aria-invalid={Boolean(errors.min_grade)}
              className={cn(
                inputBaseClassName,
                "cursor-pointer appearance-none pe-9",
                errors.min_grade ? "border-danger" : "border-border",
              )}
              id={minGradeId}
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
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute end-3 size-4 text-muted"
            />
          </div>
          {errors.min_grade?.message ? (
            <p
              className="text-xs font-semibold text-danger"
              id={`${minGradeId}-error`}
              role="alert"
            >
              {errors.min_grade.message}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <label
            className="block text-xs font-bold text-ink"
            htmlFor={maxGradeId}
          >
            {t("books.form.maxGradeLabel")}
          </label>
          <div className="relative flex items-center">
            <select
              aria-describedby={
                errors.max_grade ? `${maxGradeId}-error` : undefined
              }
              aria-invalid={Boolean(errors.max_grade)}
              className={cn(
                inputBaseClassName,
                "cursor-pointer appearance-none pe-9",
                errors.max_grade ? "border-danger" : "border-border",
              )}
              id={maxGradeId}
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
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute end-3 size-4 text-muted"
            />
          </div>
          {errors.max_grade?.message ? (
            <p
              className="text-xs font-semibold text-danger"
              id={`${maxGradeId}-error`}
              role="alert"
            >
              {errors.max_grade.message}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border pt-4">
        <ButtonLink href={cancelHref} size="admin" variant="outline">
          {t("common.cancel")}
        </ButtonLink>
        <Button
          disabled={isSubmitting}
          isLoading={isSubmitting}
          size="admin"
          type="submit"
          variant="primary"
        >
          {isSubmitting ? t("common.saving") : resolvedSubmitLabel}
        </Button>
      </div>
    </form>
  );

  if (!showLiveCoverPreview && !coverStudioSlot && !sidebarExtra) {
    return formFields;
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-12">
      <div className="rounded-xl border border-border bg-white p-5 shadow-2xs sm:p-6 lg:col-span-7">
        {formFields}
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:col-span-5">
        {showLiveCoverPreview ? (
          <div
            className="rounded-xl border border-border bg-white p-5 shadow-2xs"
            data-testid="admin-book-live-cover-preview"
          >
            <div className="flex items-start gap-4">
              <BookCover
                author={watchedAuthor || null}
                book={{
                  id: bookId,
                  title:
                    watchedTitle?.trim() ||
                    t(
                      "books.form.livePreviewTitleFallback",
                      undefined,
                      "Tiêu đề sách mới",
                    ),
                  author: watchedAuthor || null,
                  min_grade: Number.isFinite(watchedMinGrade)
                    ? watchedMinGrade
                    : 1,
                  max_grade: Number.isFinite(watchedMaxGrade)
                    ? watchedMaxGrade
                    : 5,
                  lifecycle_status: lifecycleStatus,
                }}
                coverSourceType={coverSourceType}
                coverUrl={coverUrl}
                size="medium"
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-sm font-extrabold text-ink">
                  {t(
                    "books.form.livePreviewHeading",
                    undefined,
                    "Xem trước bìa sách",
                  )}
                </p>
                <p className="text-xs leading-relaxed text-muted">
                  {t(
                    "books.form.livePreviewDesc",
                    undefined,
                    "Khi chưa tải ảnh bìa riêng, ViRead tự tạo bìa chữ tiếng Việt sắc nét theo tiêu đề, tác giả và khối lớp.",
                  )}
                </p>
              </div>
            </div>
            {coverStudioSlot ? (
              <div className="mt-4 border-t border-border pt-4">
                {coverStudioSlot}
              </div>
            ) : null}
          </div>
        ) : coverStudioSlot ? (
          <div className="rounded-xl border border-border bg-white p-5 shadow-2xs">
            {coverStudioSlot}
          </div>
        ) : null}

        {sidebarExtra}
      </aside>
    </div>
  );
}
