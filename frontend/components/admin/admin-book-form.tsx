"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/common/button";
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import type { AdminBookCreateDTO } from "@/types/admin";

const schema = z
  .object({
    title: z.string().trim().min(1, "Vui lòng nhập tên sách."),
    author: z.string().nullable(),
    min_grade: z.number().int().min(1).max(5),
    max_grade: z.number().int().min(1).max(5),
  })
  .refine((value) => value.min_grade <= value.max_grade, {
    message: "Khối tối đa phải lớn hơn hoặc bằng khối tối thiểu.",
    path: ["max_grade"],
  });

interface AdminBookFormProps {
  initial?: AdminBookCreateDTO;
  onSubmit: (value: AdminBookCreateDTO) => Promise<void>;
  submitLabel?: string;
}

export function AdminBookForm({
  initial,
  onSubmit,
  submitLabel = "Lưu sách",
}: AdminBookFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<AdminBookCreateDTO>({
    resolver: zodResolver(schema),
    defaultValues: initial ?? {
      title: "",
      author: "",
      min_grade: 1,
      max_grade: 3,
    },
  });
  const submit = handleSubmit(async (value) => {
    try {
      await onSubmit({ ...value, author: value.author?.trim() || null });
    } catch {
      setError("root", {
        message: "Không thể lưu sách lúc này. Vui lòng thử lại.",
      });
    }
  });
  return (
    <form className="grid gap-5" noValidate onSubmit={submit}>
      {errors.root?.message ? (
        <StatusMessage tone="error">{errors.root.message}</StatusMessage>
      ) : null}
      <TextField
        error={errors.title?.message}
        label="Tên sách"
        {...register("title")}
      />
      <TextField
        error={errors.author?.message}
        label="Tác giả (không bắt buộc)"
        {...register("author")}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <SelectField
          error={errors.min_grade?.message}
          label="Khối tối thiểu"
          {...register("min_grade", { valueAsNumber: true })}
        >
          {[1, 2, 3, 4, 5].map((grade) => (
            <option key={grade} value={grade}>
              Khối {grade}
            </option>
          ))}
        </SelectField>
        <SelectField
          error={errors.max_grade?.message}
          label="Khối tối đa"
          {...register("max_grade", { valueAsNumber: true })}
        >
          {[1, 2, 3, 4, 5].map((grade) => (
            <option key={grade} value={grade}>
              Khối {grade}
            </option>
          ))}
        </SelectField>
      </div>
      <Button
        className="sm:w-auto sm:min-w-48"
        disabled={isSubmitting}
        isLoading={isSubmitting}
        type="submit"
      >
        {isSubmitting ? "Đang lưu…" : submitLabel}
      </Button>
    </form>
  );
}
