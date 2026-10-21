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
  initial?: AdminBookFormInitial;
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
        message: "Không thể lưu sách lúc này. Vui lòng thử lại.",
      });
    }
  });
  return (
    <form className="grid gap-5" noValidate onSubmit={submit}>
      {errors.root?.message ? (
        <StatusMessage tone="error">{errors.root.message}</StatusMessage>
      ) : null}
      <p className="text-sm text-muted">
        Tên sách và tiêu đề sách là hai thông tin riêng biệt; cả hai đều bắt
        buộc.
      </p>
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
      <div className="grid gap-5 sm:grid-cols-2">
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
