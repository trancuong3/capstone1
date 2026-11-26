"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/common/button";
import { ProfileAvatarUpload } from "@/components/common/profile-avatar-upload";
import { TextField } from "@/components/common/text-field";
import { useHydrated } from "@/hooks/use-hydrated";
import { useI18n } from "@/hooks/use-i18n";
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

export function ParentProfileForm({
  onCancel,
  onSaved,
  onPartialSaved,
  profile,
  displayName,
}: ParentProfileFormProps) {
  const { t, formatDate, formatList } = useI18n();
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

  function getRoleLabel(role: ParentProfileDTO["role"]): string {
    return role === "admin"
      ? t("parent.profile.roleAdmin")
      : t("parent.profile.roleParent");
  }

  function validate(): boolean {
    const nextErrors: Partial<Record<EditableField, string>> = {};
    const nextName = name.trim();
    const nextEmail = email.trim().toLowerCase();
    const nextPhone = phone.trim();
    const currentEmail = (profile.pending_email ?? profile.email ?? "")
      .trim()
      .toLowerCase();

    if (!nextName) {
      nextErrors.display_name = t("validation.displayNameRequired");
    } else if (nextName.length > 120) {
      nextErrors.display_name = t("validation.displayNameMaxLength", {
        max: 120,
      });
    }

    if (currentEmail && !nextEmail) {
      nextErrors.email = t("validation.parentEmailRequired");
    }

    if (nextEmail !== currentEmail && nextEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
        nextErrors.email = t("validation.parentEmailInvalid");
      } else if (profile.email?.trim().toLowerCase() === nextEmail) {
        nextErrors.email = t("validation.emailMustDiffer");
      }
    }

    if (nextPhone && !canonicalPhoneInput(nextPhone)) {
      nextErrors.contact_phone = t("validation.phoneInvalidExample");
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
    let hasPendingEmailChange = false;
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
        savedChanges.push(t("parent.profile.fields.displayName"));
      }

      const nextCanonicalPhone = nextPhone
        ? canonicalPhoneInput(nextPhone)
        : null;
      if (nextCanonicalPhone !== canonicalStoredPhone(profile.contact_phone)) {
        activeField = "contact_phone";
        currentProfile =
          await profileService.updateContactPhone(nextCanonicalPhone);
        savedChanges.push(
          nextCanonicalPhone
            ? t("parent.profile.fields.contactPhone")
            : t("parent.profile.fields.removePhone"),
        );
      }

      if (nextEmail && nextEmail !== currentEmail) {
        activeField = "email";
        hasPendingEmailChange = true;
        if (profile.pending_email?.trim().toLowerCase() === nextEmail) {
          await profileService.resendEmailChange(nextEmail);
          savedChanges.push(t("parent.profile.fields.emailVerify"));
        } else {
          await profileService.requestEmailChange(nextEmail);
          savedChanges.push(t("parent.profile.fields.emailChangeRequest"));
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
        savedChanges.push(t("parent.profile.fields.avatar"));
      } else if (isAvatarRemoved && profile.avatar_url) {
        activeField = "avatar";
        currentProfile = await profileService.removeAvatar();
        savedChanges.push(t("parent.profile.fields.removeAvatar"));
      }

      onSaved(
        currentProfile,
        hasPendingEmailChange
          ? t("parent.profile.savedWithEmailPending")
          : savedChanges.length
            ? t("parent.profile.savedChanges")
            : t("parent.profile.savedNoChanges"),
      );
    } catch (error) {
      if (savedChanges.length) onPartialSaved(currentProfile);

      const message = safeErrorMessage(error, t("parent.profile.saveError"));
      setErrors((current) => ({ ...current, [activeField]: message }));
      const failedFieldLabel =
        activeField === "avatar"
          ? t("parent.profile.fields.avatar")
          : activeField === "email"
            ? t("parent.profile.fields.email")
            : activeField === "contact_phone"
              ? t("parent.profile.fields.contactPhone")
              : t("parent.profile.fields.displayName");
      setFormError(
        savedChanges.length
          ? t("parent.profile.partialSaveError", {
              saved: formatList(savedChanges),
              field: failedFieldLabel,
              detail: message,
            })
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
      aria-label={t("parent.profile.editFormAria")}
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => void saveChanges(event)}
    >
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
        label={t("parent.profile.fullNameLabel")}
        maxLength={120}
        onChange={(event) => setName(event.target.value)}
        placeholder={t("parent.profile.fullNamePlaceholder")}
        value={name}
      />
      <div className="flex flex-col gap-2">
        <TextField
          autoComplete="email"
          error={errors.email}
          inputMode="email"
          label={t("parent.profile.emailShortLabel")}
          maxLength={254}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t("parent.profile.emailPlaceholder")}
          type="email"
          value={email}
        />
        {profile.pending_email ? (
          <p className="text-sm text-warning">
            {t("parent.profile.pendingEmailPrefix")}{" "}
            <strong>{profile.pending_email}</strong>
          </p>
        ) : null}
        {profile.email_verified === false ? (
          <p className="text-sm text-muted">
            {t("parent.profile.emailVerifyHint")}
          </p>
        ) : null}
      </div>
      <TextField
        autoComplete="tel"
        error={errors.contact_phone}
        inputMode="tel"
        label={t("parent.profile.phoneShortLabel")}
        maxLength={16}
        onChange={(event) => setPhone(event.target.value)}
        placeholder={t("parent.profile.phonePlaceholder")}
        type="tel"
        value={phone}
      />

      {formError ? (
        <p className="text-sm text-danger" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="rounded-card bg-sky p-4">
        <h3 className="font-extrabold text-ink">
          {t("parent.profile.changeEmailHeading")}
        </h3>
        <p className="mt-2 text-body text-muted">
          {t("parent.profile.changeEmailNotice")}
        </p>
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-semibold text-primary">
          {t("parent.profile.accountDetailsSummary")}
        </summary>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-control bg-canvas p-4">
            <dt className="text-sm font-semibold text-muted">
              {t("parent.profile.roleLabel")}
            </dt>
            <dd className="mt-1 text-label font-semibold text-ink">
              {getRoleLabel(profile.role)}
            </dd>
          </div>
          <div className="rounded-control bg-canvas p-4">
            <dt className="text-sm font-semibold text-muted">
              {t("parent.profile.createdAtLabel")}
            </dt>
            <dd className="mt-1 text-label font-semibold text-ink">
              {formatDate(profile.created_at, {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                fallback: t("parent.profile.noInfo"),
              })}
            </dd>
          </div>
        </dl>
      </details>

      <div className="grid gap-4 sm:grid-cols-2">
        <Button
          className="order-last sm:px-6"
          disabled={isSaving}
          onClick={onCancel}
          type="button"
          variant="quiet"
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          className="sm:px-6"
          disabled={!isHydrated || isSaving}
          isLoading={isSaving}
          type="submit"
        >
          {isSaving
            ? t("common.actions.saving")
            : t("parent.profile.saveChanges")}
        </Button>
      </div>
    </form>
  );
}
