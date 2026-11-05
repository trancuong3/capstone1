"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/common/button";
import { ProfileAvatarUpload } from "@/components/common/profile-avatar-upload";
import { TextField } from "@/components/common/text-field";
import { useHydrated } from "@/hooks/use-hydrated";
import { useProfileService } from "@/hooks/use-profile-service";
import type { ParentProfileDTO } from "@/types/profile";

interface ParentProfileFormProps {
  onCancel: () => void;
  onSaved: (profile: ParentProfileDTO, message: string) => void;
  onPartialSaved: (profile: ParentProfileDTO) => void;
  profile: ParentProfileDTO;
  displayName: string;
}

type EditableField = "display_name" | "email" | "contact_phone" | "avatar";

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

function canonicalStoredPhone(value: string | null): string | null {
  return value ? canonicalPhoneInput(value) : null;
}

function formatCreatedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Chưa có thông tin";

  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function getRoleLabel(role: ParentProfileDTO["role"]): string {
  return role === "admin" ? "Quản trị viên" : "Phụ huynh";
}

export function ParentProfileForm({
  onCancel,
  onSaved,
  onPartialSaved,
  profile,
  displayName,
}: ParentProfileFormProps) {
  const isHydrated = useHydrated();
  const profileService = useProfileService();
  const [name, setName] = useState(profile.display_name ?? displayName);
  const [email, setEmail] = useState(
    profile.pending_email ?? profile.email ?? "",
  );
  const [phone, setPhone] = useState(profile.contact_phone ?? "");
  const [selectedAvatarFile, setSelectedAvatarFile] = useState<File | null>(
    null,
  );
  const [isAvatarRemoved, setIsAvatarRemoved] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<EditableField, string>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  function validate(): boolean {
    const nextErrors: Partial<Record<EditableField, string>> = {};
    const nextName = name.trim();
    const nextEmail = email.trim().toLowerCase();
    const nextPhone = phone.trim();
    const currentEmail = (profile.pending_email ?? profile.email ?? "")
      .trim()
      .toLowerCase();

    if (!nextName) {
      nextErrors.display_name = "Ba mẹ vui lòng nhập tên hiển thị.";
    } else if (nextName.length > 120) {
      nextErrors.display_name = "Tên hiển thị không được dài quá 120 ký tự.";
    }

    if (currentEmail && !nextEmail) {
      nextErrors.email = "Ba mẹ vui lòng nhập email.";
    }

    if (nextEmail !== currentEmail && nextEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
        nextErrors.email = "Ba mẹ vui lòng nhập email hợp lệ.";
      } else if (profile.email?.trim().toLowerCase() === nextEmail) {
        nextErrors.email = "Email mới phải khác email hiện tại.";
      }
    }

    if (nextPhone && !canonicalPhoneInput(nextPhone)) {
      nextErrors.contact_phone =
        "Nhập số hợp lệ, ví dụ 0912345678 hoặc +84912345678.";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function saveChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving || !validate()) return;

    setFormError(null);
    setIsSaving(true);
    let currentProfile = profile;
    let activeField: EditableField = "display_name";
    const savedChanges: string[] = [];
    const nextName = name.trim();
    const nextEmail = email.trim().toLowerCase();
    const nextPhone = phone.trim();
    const currentEmail = (profile.pending_email ?? profile.email ?? "")
      .trim()
      .toLowerCase();

    try {
      if (nextName !== (profile.display_name ?? "").trim()) {
        activeField = "display_name";
        currentProfile = await profileService.update({
          display_name: nextName,
        });
        savedChanges.push("tên hiển thị");
      }

      const nextCanonicalPhone = nextPhone
        ? canonicalPhoneInput(nextPhone)
        : null;
      if (nextCanonicalPhone !== canonicalStoredPhone(profile.contact_phone)) {
        activeField = "contact_phone";
        currentProfile =
          await profileService.updateContactPhone(nextCanonicalPhone);
        savedChanges.push(
          nextCanonicalPhone ? "số điện thoại" : "xóa số điện thoại",
        );
      }

      if (nextEmail && nextEmail !== currentEmail) {
        activeField = "email";
        if (profile.pending_email?.trim().toLowerCase() === nextEmail) {
          await profileService.resendEmailChange(nextEmail);
          savedChanges.push("email xác minh");
        } else {
          await profileService.requestEmailChange(nextEmail);
          savedChanges.push("yêu cầu đổi email");
        }
        try {
          currentProfile = await profileService.get();
        } catch {
          // The email request itself is authoritative; a later profile load refreshes Auth.
        }
      }

      if (selectedAvatarFile) {
        activeField = "avatar";
        currentProfile = await profileService.uploadAvatar(selectedAvatarFile);
        savedChanges.push("ảnh đại diện");
      } else if (isAvatarRemoved && profile.avatar_url) {
        activeField = "avatar";
        currentProfile = await profileService.removeAvatar();
        savedChanges.push("xóa ảnh đại diện");
      }

      onSaved(
        currentProfile,
        savedChanges.includes("yêu cầu đổi email") ||
          savedChanges.includes("email xác minh")
          ? "Đã lưu thay đổi. Email mới chỉ có hiệu lực sau khi ba mẹ xác minh."
          : savedChanges.length
            ? "Đã lưu các thay đổi hồ sơ."
            : "Thông tin hồ sơ đã được cập nhật.",
      );
    } catch (error) {
      if (savedChanges.length) onPartialSaved(currentProfile);

      const message = safeErrorMessage(
        error,
        "Chưa lưu được thay đổi. Ba mẹ vui lòng thử lại sau.",
      );
      setErrors((current) => ({ ...current, [activeField]: message }));
      setFormError(
        savedChanges.length
          ? `Đã lưu ${savedChanges.join(", ")}; chưa lưu được thay đổi liên quan đến ${activeField === "avatar" ? "ảnh đại diện" : activeField === "email" ? "email" : activeField === "contact_phone" ? "số điện thoại" : "tên hiển thị"}. ${message}`
          : null,
      );
    } finally {
      setIsSaving(false);
    }
  }

  function removeOrRestoreAvatar() {
    if (isAvatarRemoved) {
      setIsAvatarRemoved(false);
      return;
    }

    setSelectedAvatarFile(null);
    setIsAvatarRemoved(Boolean(profile.avatar_url));
  }

  return (
    <form
      aria-busy={isSaving}
      aria-label="Chỉnh sửa hồ sơ ba mẹ"
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(event) => void saveChanges(event)}
    >
      <header>
        <p className="text-label font-bold text-primary">HỒ SƠ TÀI KHOẢN</p>
        <h2 className="mt-1 text-xl font-extrabold text-ink">
          Chỉnh sửa hồ sơ
        </h2>
      </header>

      <ProfileAvatarUpload
        displayName={displayName}
        imageUrl={profile.avatar_url}
        isRemoved={isAvatarRemoved}
        onRemove={removeOrRestoreAvatar}
        onSelectFile={(file) => {
          setSelectedAvatarFile(file);
          setIsAvatarRemoved(false);
          setErrors((current) => ({ ...current, avatar: undefined }));
        }}
        selectedFile={selectedAvatarFile}
      />
      {errors.avatar ? (
        <p className="-mt-4 text-sm text-danger" role="alert">
          {errors.avatar}
        </p>
      ) : null}

      <TextField
        autoComplete="name"
        error={errors.display_name}
        label="Họ và tên"
        maxLength={120}
        onChange={(event) => setName(event.target.value)}
        placeholder="Ví dụ: Nguyễn Minh Anh"
        value={name}
      />
      <div className="flex flex-col gap-2">
        <TextField
          autoComplete="email"
          error={errors.email}
          inputMode="email"
          label="Email"
          maxLength={254}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          type="email"
          value={email}
        />
        {profile.pending_email ? (
          <p className="text-sm text-amber-800">
            Đang chờ xác minh email mới:{" "}
            <strong>{profile.pending_email}</strong>
          </p>
        ) : null}
        {profile.email_verified === false ? (
          <p className="text-sm text-muted">
            Email mới chỉ được cập nhật sau khi xác minh.
          </p>
        ) : null}
      </div>
      <TextField
        autoComplete="tel"
        error={errors.contact_phone}
        inputMode="tel"
        label="Số điện thoại liên hệ"
        maxLength={16}
        onChange={(event) => setPhone(event.target.value)}
        placeholder="0912345678 hoặc +84912345678"
        type="tel"
        value={phone}
      />

      {formError ? (
        <p className="text-sm text-danger" role="alert">
          {formError}
        </p>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-control bg-canvas p-4">
          <dt className="text-sm font-bold text-muted">Vai trò</dt>
          <dd className="mt-1 text-label font-bold text-ink">
            {getRoleLabel(profile.role)}
          </dd>
        </div>
        <div className="rounded-control bg-canvas p-4">
          <dt className="text-sm font-bold text-muted">Ngày tạo tài khoản</dt>
          <dd className="mt-1 text-label font-bold text-ink">
            {formatCreatedDate(profile.created_at)}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          className="sm:w-auto sm:px-6"
          disabled={isSaving}
          onClick={onCancel}
          type="button"
          variant="quiet"
        >
          Hủy
        </Button>
        <Button
          className="sm:w-auto sm:px-6"
          disabled={!isHydrated || isSaving}
          isLoading={isSaving}
          type="submit"
        >
          {isSaving ? "Đang lưu…" : "Lưu thay đổi"}
        </Button>
      </div>
    </form>
  );
}
