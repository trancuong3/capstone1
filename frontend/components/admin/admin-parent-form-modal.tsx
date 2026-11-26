"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useTranslations } from "@/hooks/use-i18n";
import type {
  AdminParentCreateInput,
  AdminParentUpdateInput,
} from "@/lib/api/admin-parent-service";
import { isServiceError } from "@/lib/api/service-error";
import { translateMessage } from "@/lib/i18n/formatter";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import type { TranslateFn } from "@/lib/i18n/types";
import { viMessages } from "@/messages/vi";

export interface AdminParentFormValues {
  readonly display_name: string;
  readonly email: string;
  readonly phone: string;
}

export type AdminParentFormSubmission =
  | { readonly mode: "create"; readonly input: AdminParentCreateInput }
  | { readonly mode: "edit"; readonly input: AdminParentUpdateInput };

interface AdminParentFormModalProps {
  readonly isOpen: boolean;
  readonly mode: "create" | "edit";
  readonly isLoading?: boolean;
  readonly initialValues: AdminParentFormValues;
  readonly contactInfoEditable?: boolean;
  readonly contactInfoMessage?: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (submission: AdminParentFormSubmission) => Promise<void>;
  readonly onSuccess: () => void;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[0-9][0-9\s().-]{5,24}$/;

const defaultTranslate: TranslateFn = (key, params, fallback) =>
  translateMessage(
    viMessages,
    viMessages,
    DEFAULT_LOCALE,
    key.includes(".") && !key.startsWith("admin.") ? `admin.${key}` : key,
    params,
    fallback,
  );

export function getAdminParentMutationErrorMessage(
  error: unknown,
  t: TranslateFn = defaultTranslate,
): string {
  if (isServiceError(error)) {
    switch (error.status) {
      case 401:
        return t("parents.modal.errors.unauthorized");
      case 403:
        return t("parents.modal.errors.forbidden");
      case 404:
        return t("parents.modal.errors.notFound");
      case 409:
        return t("parents.modal.errors.conflict");
      case 422:
        return t("parents.modal.errors.validation");
      case 500:
      case 503:
        return error.request_id
          ? t("parents.modal.errors.serviceErrorWithRequest", {
              requestId: error.request_id,
            })
          : t("parents.modal.errors.serviceError");
      default:
        return error.status === 0
          ? t("parents.modal.errors.networkError")
          : t("parents.modal.errors.genericUpdate");
    }
  }
  return t("parents.modal.errors.fallback");
}

export function AdminParentFormModal({
  isOpen,
  mode,
  isLoading = false,
  initialValues,
  contactInfoEditable = true,
  contactInfoMessage,
  onClose,
  onSubmit,
  onSuccess,
}: AdminParentFormModalProps) {
  const t = useTranslations("admin");
  const formId = useId();
  const [values, setValues] = useState<AdminParentFormValues>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof AdminParentFormValues, string>>
  >({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submitLockRef = useRef(false);

  function updateField(field: keyof AdminParentFormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  }

  function close() {
    if (saving) return;
    setFieldErrors({});
    setFormError(null);
    onClose();
  }

  async function submitForm() {
    if (saving || isLoading || submitLockRef.current) return;

    const displayName = values.display_name.trim();
    const email = values.email.trim().toLowerCase();
    const phone = values.phone.trim();
    const originalName = initialValues.display_name.trim();
    const originalEmail = initialValues.email.trim().toLowerCase();
    const originalPhone = initialValues.phone.trim();
    const nextErrors: Partial<Record<keyof AdminParentFormValues, string>> = {};

    if (!displayName) {
      nextErrors.display_name = t(
        "parents.modal.validation.displayNameRequired",
      );
    } else if (displayName.length > 120) {
      nextErrors.display_name = t("parents.modal.validation.displayNameMax");
    }

    if (mode === "create" && !email) {
      nextErrors.email = t("parents.modal.validation.emailRequired");
    } else if (email && !emailPattern.test(email)) {
      nextErrors.email = t("parents.modal.validation.emailInvalid");
    } else if (
      mode === "edit" &&
      contactInfoEditable &&
      originalEmail &&
      !email
    ) {
      nextErrors.email = t("parents.modal.validation.emailCannotClear");
    }

    if (phone && (phone.length > 30 || !phonePattern.test(phone))) {
      nextErrors.phone = t("parents.modal.validation.phoneInvalid");
    } else if (
      mode === "edit" &&
      contactInfoEditable &&
      originalPhone &&
      !phone
    ) {
      nextErrors.phone = t("parents.modal.validation.phoneCannotClear");
    }

    setFieldErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) return;

    let submission: AdminParentFormSubmission;
    if (mode === "create") {
      submission = {
        mode,
        input: {
          display_name: displayName,
          email,
          ...(phone ? { phone } : {}),
        },
      };
    } else {
      const input: { display_name?: string; email?: string; phone?: string } =
        {};
      if (displayName !== originalName) input.display_name = displayName;
      if (contactInfoEditable && email !== originalEmail) input.email = email;
      if (contactInfoEditable && phone !== originalPhone) input.phone = phone;
      if (Object.keys(input).length === 0) {
        setFormError(t("parents.modal.noChangesError"));
        return;
      }
      submission = { mode, input };
    }

    submitLockRef.current = true;
    setSaving(true);
    try {
      await onSubmit(submission);
    } catch (error) {
      setFormError(getAdminParentMutationErrorMessage(error, t));
      submitLockRef.current = false;
      setSaving(false);
      return;
    }

    submitLockRef.current = false;
    setSaving(false);
    onSuccess();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitForm();
  }

  return (
    <Modal
      closeOnBackdropClick={!saving}
      closeOnEscape={!saving}
      footer={
        isLoading ? undefined : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              disabled={saving}
              fullWidth={false}
              onClick={close}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={isLoading || saving}
              fullWidth={false}
              isLoading={saving}
              onClick={() => void submitForm()}
              size="admin"
              type="button"
              variant="primary"
            >
              {mode === "create"
                ? t("parents.modal.createSubmit")
                : t("parents.modal.editSubmit")}
            </Button>
          </div>
        )
      }
      isOpen={isOpen}
      onClose={close}
      showCloseButton={!saving}
      title={
        mode === "create"
          ? t("parents.modal.createTitle")
          : t("parents.modal.editTitle")
      }
      tone="paper"
    >
      {isLoading ? (
        <div
          aria-live="polite"
          className="grid min-h-40 place-items-center text-center"
          role="status"
        >
          <p className="font-semibold text-muted">
            {t("parents.modal.loading")}
          </p>
        </div>
      ) : (
        <form
          className="grid gap-4"
          id={formId}
          noValidate
          onSubmit={handleSubmit}
        >
          {formError ? (
            <StatusMessage tone="error" title={formError}>
              {t("parents.modal.errorPreservedHint")}
            </StatusMessage>
          ) : null}
          <TextField
            label={t("parents.modal.displayNameLabel")}
            autoComplete="name"
            value={values.display_name}
            onChange={(event) =>
              updateField("display_name", event.target.value)
            }
            error={fieldErrors.display_name}
            required
            maxLength={120}
            disabled={saving}
          />
          <TextField
            label={t("parents.modal.emailLabel")}
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={(event) => updateField("email", event.target.value)}
            error={fieldErrors.email}
            required={mode === "create"}
            disabled={saving || (mode === "edit" && !contactInfoEditable)}
          />
          <TextField
            label={t("parents.modal.phoneLabel")}
            type="tel"
            autoComplete="tel"
            value={values.phone}
            onChange={(event) => updateField("phone", event.target.value)}
            error={fieldErrors.phone}
            maxLength={30}
            disabled={saving || (mode === "edit" && !contactInfoEditable)}
          />
          {mode === "edit" && !contactInfoEditable ? (
            <StatusMessage
              tone="warning"
              title={t("parents.modal.readOnlyContactTitle")}
            >
              {contactInfoMessage ?? t("parents.modal.readOnlyContactNote")}
            </StatusMessage>
          ) : (
            <p className="text-sm text-muted">
              {t("parents.modal.contactSyncNote")}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
