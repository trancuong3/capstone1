"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button, ButtonLink } from "@/components/common/button";
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useTranslations } from "@/hooks/use-i18n";
import type { AdminBookCreateDTO } from "@/types/admin";

type AdminBookFormInitial = Omit<Partial<AdminBookCreateDTO>, "name"> & {
  readonly name?: string | null;
};

interface AdminBookFormProps {
  cancelHref?: string;
  initial?: AdminBookFormInitial;
  onSubmit: (value: AdminBookCreateDTO) => Promise<void>;
  submitLabel?: string;
}

export function AdminBookForm({
  cancelHref = "/admin/books",
  initial,
  onSubmit,
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
        message: t("books.form.genericSaveError"),
      });
    }
  });
  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      {errors.root?.message ? (
        <StatusMessage tone="error">{errors.root.message}</StatusMessage>
      ) : null}
      <TextField
        error={errors.name?.message}
        label={t("books.form.nameLabel")}
        required
        {...register("name")}
      />
      <TextField
        error={errors.title?.message}
        label={t("books.form.titleLabel")}
        required
        {...register("title")}
      />
      <TextField
        error={errors.author?.message}
        label={t("books.form.authorLabel")}
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
