"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Heart } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/common/button";
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useHydrated } from "@/hooks/use-hydrated";
import type { ChildProfileCreateDTO } from "@/types/child";

const childProfileSchema = z.object({
  alias: z.string().trim().min(1, "Ba mẹ vui lòng nhập tên gọi của bé."),
  grade: z.coerce
    .number<number>()
    .int("Lớp của bé cần là số nguyên từ 1 đến 5.")
    .min(1, "Ba mẹ vui lòng chọn lớp từ 1 đến 5.")
    .max(5, "Ba mẹ vui lòng chọn lớp từ 1 đến 5."),
});

type ChildProfileFormValues = z.input<typeof childProfileSchema>;

interface ChildProfileFormProps {
  defaultValues?: Pick<ChildProfileCreateDTO, "alias" | "grade">;
  mode: "create" | "edit";
  onSubmit: (values: ChildProfileCreateDTO) => Promise<void>;
  submitLabel?: string;
}

export function ChildProfileForm({
  defaultValues,
  mode,
  onSubmit,
  submitLabel,
}: ChildProfileFormProps) {
  const isHydrated = useHydrated();
  const [avatarNotice, setAvatarNotice] = useState(false);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<ChildProfileFormValues>({
    defaultValues: {
      alias: defaultValues?.alias ?? "",
      grade: defaultValues?.grade ?? 2,
    },
    resolver: zodResolver(childProfileSchema),
  });

  const submitForm = handleSubmit(async (values) => {
    if (isSubmitting) {
      return;
    }

    const parsed = childProfileSchema.parse(values);
    await onSubmit({ alias: parsed.alias, grade: parsed.grade });
  });

  return (
    <form
      className="flex w-full flex-col gap-4 sm:gap-6"
      noValidate
      onSubmit={submitForm}
    >
      <TextField
        autoComplete="off"
        error={errors.alias?.message}
        label="Tên gọi của bé"
        placeholder="Ví dụ: Bé An"
        {...register("alias")}
      />
      <SelectField
        error={errors.grade?.message}
        label="Lớp của bé"
        {...register("grade")}
      >
        {[1, 2, 3, 4, 5].map((grade) => (
          <option key={grade} value={grade}>
            Lớp {grade}
          </option>
        ))}
      </SelectField>
      {avatarNotice ? (
        <StatusMessage tone="info">
          Bản mock đang dùng chữ trong tên gọi làm hình đại diện của bé.
        </StatusMessage>
      ) : null}
      <Button
        aria-expanded={avatarNotice}
        onClick={() => setAvatarNotice((visible) => !visible)}
        type="button"
        variant="secondary"
      >
        <Heart aria-hidden="true" className="size-5" />
        Chọn hình đại diện
      </Button>
      <Button disabled={!isHydrated} isLoading={isSubmitting} type="submit">
        {isSubmitting
          ? "Đang lưu…"
          : (submitLabel ?? (mode === "create" ? "Lưu hồ sơ" : "Lưu thay đổi"))}
        {!isSubmitting ? (
          <ArrowRight aria-hidden="true" className="size-5" />
        ) : null}
      </Button>
    </form>
  );
}
