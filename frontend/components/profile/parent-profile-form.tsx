"use client";

import { useState } from "react";

import { Button } from "@/components/common/button";
import { TextField } from "@/components/common/text-field";
import { useHydrated } from "@/hooks/use-hydrated";
import { useProfileService } from "@/hooks/use-profile-service";
import type { ParentProfileDTO } from "@/types/profile";

export type ParentProfileEditableField =
  | "display_name"
  | "email"
  | "contact_phone";

interface ParentProfileFormProps {
  field: ParentProfileEditableField;
  onCancel: () => void;
  onSaved: (
    field: ParentProfileEditableField,
    profile: ParentProfileDTO,
    message: string,
  ) => void;
  profile: ParentProfileDTO;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    error.message &&
    !/token|secret|authorization|private|stack|otp/i.test(error.message)
  ) {
    return error.message;
  }

  return fallback;
}

function canonicalPhoneInput(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, "");

  if (/^0\d{9}$/.test(compact)) return `+84${compact.slice(1)}`;
  if (/^84\d{9}$/.test(compact)) return `+${compact}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;

  return null;
}

export function ParentProfileForm({
  field,
  onCancel,
  onSaved,
  profile,
}: ParentProfileFormProps) {
  const isHydrated = useHydrated();
  const profileService = useProfileService();

  const [value, setValue] = useState(() => {
    switch (field) {
      case "display_name":
        return profile.display_name ?? "";
      case "email":
        return profile.pending_email ?? profile.email ?? "";
      case "contact_phone":
        return profile.contact_phone ?? "";
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const label =
    field === "display_name"
      ? "Tên hiển thị của ba mẹ"
      : field === "email"
        ? "Email"
        : "Số điện thoại liên hệ";

  async function saveField() {
    if (isSaving) return;
    setError(null);

    const trimmed = value.trim();
    if (!trimmed) {
      setError(
        field === "display_name"
          ? "Ba mẹ vui lòng nhập tên hiển thị."
          : field === "email"
            ? "Ba mẹ vui lòng nhập email."
            : "Ba mẹ vui lòng nhập số điện thoại liên hệ.",
      );
      return;
    }

    setIsSaving(true);

    try {
      if (field === "display_name") {
        const updatedProfile = await profileService.update({
          display_name: trimmed,
        });
        onSaved(
          field,
          updatedProfile,
          "Đã cập nhật tên hiển thị.",
        );
        return;
      }

      if (field === "email") {
        const normalizedEmail = trimmed.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
          setError("Ba mẹ vui lòng nhập email hợp lệ.");
          return;
        }

        if (profile.pending_email?.toLowerCase() === normalizedEmail) {
          await profileService.resendEmailChange(normalizedEmail);
          let currentProfile = profile;
          try {
            currentProfile = await profileService.get();
          } catch {
            // The resend request succeeded; the next page load will refresh Auth.
          }
          onSaved(
            field,
            currentProfile,
            "Đã gửi lại email xác minh. Ba mẹ hãy kiểm tra hộp thư.",
          );
          return;
        }

        if (profile.email?.toLowerCase() === normalizedEmail) {
          setError("Email mới phải khác email hiện tại.");
          return;
        }

        await profileService.requestEmailChange(normalizedEmail);
        let currentProfile = profile;
        try {
          currentProfile = await profileService.get();
        } catch {
          // Keep the confirmed profile snapshot; Auth remains the source of truth.
        }
        onSaved(
          field,
          currentProfile,
          "Đã gửi yêu cầu đổi email. Email mới chỉ có hiệu lực sau khi xác minh.",
        );
        return;
      }

      const normalizedPhone = canonicalPhoneInput(trimmed);
      if (!normalizedPhone) {
        setError(
          "Nhập số hợp lệ, ví dụ 0912345678 hoặc +84912345678.",
        );
        return;
      }

      const currentPhone = canonicalPhoneInput(profile.contact_phone ?? "");
      if (currentPhone === normalizedPhone) {
        setError("Số điện thoại mới phải khác số hiện tại.");
        return;
      }

      const updatedProfile =
        await profileService.updateContactPhone(normalizedPhone);
      onSaved(
        field,
        updatedProfile,
        "Đã lưu số điện thoại liên hệ. Không cần xác minh.",
      );
    } catch (saveError) {
      setError(
        safeErrorMessage(
          saveError,
          "Chưa lưu được thay đổi. Ba mẹ vui lòng thử lại sau.",
        ),
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form
      aria-label={`Chỉnh sửa ${label}`}
      className="mt-2 flex min-w-0 flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void saveField();
      }}
    >
      <TextField
        autoComplete={
          field === "display_name"
            ? "name"
            : field === "email"
              ? "email"
              : "tel"
        }
        autoFocus
        error={error ?? undefined}
        inputMode={
          field === "email"
            ? "email"
            : field === "contact_phone"
              ? "tel"
              : undefined
        }
        label={label}
        maxLength={field === "contact_phone" ? 16 : 254}
        onChange={(event) => setValue(event.target.value)}
        placeholder={
          field === "display_name"
            ? "Ví dụ: Nguyễn Minh Anh"
            : field === "email"
              ? "name@example.com"
              : "0912345678 hoặc +84912345678"
        }
        type={
          field === "email"
            ? "email"
            : field === "contact_phone"
              ? "tel"
              : "text"
        }
        value={value}
      />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        <Button
          className="!h-11 !w-auto px-4"
          disabled={!isHydrated || isSaving}
          isLoading={isSaving}
          type="submit"
        >
          {isSaving ? "Đang lưu…" : "Lưu"}
        </Button>
        <Button
          className="!h-11 !w-auto px-4"
          disabled={isSaving}
          onClick={onCancel}
          type="button"
          variant="quiet"
        >
          Hủy
        </Button>
      </div>
    </form>
  );
}
