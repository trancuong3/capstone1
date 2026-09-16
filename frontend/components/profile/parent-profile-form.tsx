"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Save } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useHydrated } from "@/hooks/use-hydrated";
import { useProfileService } from "@/hooks/use-profile-service";
import type { ParentProfileDTO } from "@/types/profile";

const parentProfileSchema = z.object({
  displayName: z.string().trim().min(1, "Ba mẹ vui lòng nhập tên hiển thị."),
});

type ParentProfileFormValues = z.infer<typeof parentProfileSchema>;

interface ParentProfileFormProps {
  onCancel: () => void;
  onUpdated: (profile: ParentProfileDTO) => void;
  profile: ParentProfileDTO;
}

export function ParentProfileForm({
  onCancel,
  onUpdated,
  profile,
}: ParentProfileFormProps) {
  const isHydrated = useHydrated();
  const profileService = useProfileService();
  const [hasSafeError, setHasSafeError] = useState(false);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<ParentProfileFormValues>({
    defaultValues: {
      displayName: profile.display_name ?? "",
    },
    resolver: zodResolver(parentProfileSchema),
  });

  const onSubmit = handleSubmit(async (values) => {
    setHasSafeError(false);

    try {
      const updatedProfile = await profileService.update({
        display_name: values.displayName.trim(),
      });
      onUpdated(updatedProfile);
    } catch {
      setHasSafeError(true);
    }
  });

  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={onSubmit}>
      {hasSafeError ? (
        <StatusMessage title="Chưa lưu được thay đổi" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
      ) : null}

      <TextField
        autoComplete="name"
        error={errors.displayName?.message}
        label="Tên hiển thị của ba mẹ"
        placeholder="Ví dụ: Nguyễn Minh Anh"
        {...register("displayName")}
      />

      <div className="rounded-control bg-sky p-4">
        <p className="text-label font-bold text-muted">Vai trò</p>
        <p className="mt-1 text-body font-bold text-ink">
          {profile.role === "admin" ? "Quản trị viên" : "Phụ huynh"}
        </p>
        <p className="mt-1 text-label text-muted">
          Vai trò tài khoản là dữ liệu chỉ đọc và không thể tự thay đổi.
        </p>
      </div>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          className="sm:w-auto sm:min-w-40"
          disabled={isSubmitting}
          onClick={onCancel}
          type="button"
          variant="quiet"
        >
          Hủy
        </Button>
        <Button
          className="sm:w-auto sm:min-w-52"
          disabled={!isHydrated}
          isLoading={isSubmitting}
          type="submit"
        >
          {!isSubmitting ? (
            <Save aria-hidden="true" className="size-5" />
          ) : null}
          {isSubmitting ? "Đang lưu…" : "Lưu thay đổi"}
        </Button>
      </div>
    </form>
  );
}
