"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import type {
  AdminParentCreateInput,
  AdminParentUpdateInput,
} from "@/lib/api/admin-parent-service";
import { isServiceError } from "@/lib/api/service-error";

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

export function getAdminParentMutationErrorMessage(error: unknown): string {
  if (isServiceError(error)) {
    switch (error.status) {
      case 401:
        return "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.";
      case 403:
        return "Tài khoản hiện tại không có quyền quản trị phụ huynh.";
      case 404:
        return "Không tìm thấy tài khoản phụ huynh. Hãy tải lại danh sách.";
      case 409:
        return "Email hoặc số điện thoại đã được một tài khoản khác sử dụng.";
      case 422:
        return "Thông tin chưa hợp lệ. Vui lòng kiểm tra lại các trường.";
      case 500:
      case 503:
        return error.request_id
          ? "Dịch vụ quản trị hoặc Supabase Auth đang gặp sự cố. Mã yêu cầu: " +
              error.request_id
          : "Dịch vụ quản trị hoặc Supabase Auth đang tạm thời không khả dụng.";
      default:
        return error.status === 0
          ? "Không thể kết nối đến máy chủ. Kiểm tra mạng rồi thử lại."
          : "Không thể cập nhật tài khoản lúc này. Vui lòng thử lại.";
    }
  }
  return "Không thể cập nhật tài khoản lúc này. Dữ liệu đã nhập vẫn được giữ.";
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || isLoading || submitLockRef.current) return;

    const displayName = values.display_name.trim();
    const email = values.email.trim().toLowerCase();
    const phone = values.phone.trim();
    const originalName = initialValues.display_name.trim();
    const originalEmail = initialValues.email.trim().toLowerCase();
    const originalPhone = initialValues.phone.trim();
    const nextErrors: Partial<Record<keyof AdminParentFormValues, string>> = {};

    if (!displayName) {
      nextErrors.display_name = "Vui lòng nhập tên hiển thị.";
    } else if (displayName.length > 120) {
      nextErrors.display_name = "Tên hiển thị không được vượt quá 120 ký tự.";
    }

    if (mode === "create" && !email) {
      nextErrors.email = "Email là trường bắt buộc.";
    } else if (email && !emailPattern.test(email)) {
      nextErrors.email = "Email chưa đúng định dạng.";
    } else if (
      mode === "edit" &&
      contactInfoEditable &&
      originalEmail &&
      !email
    ) {
      nextErrors.email =
        "Backend hiện không hỗ trợ xóa email. Hãy giữ giá trị hiện tại hoặc nhập email mới.";
    }

    if (phone && (phone.length > 30 || !phonePattern.test(phone))) {
      nextErrors.phone = "Số điện thoại chưa đúng định dạng.";
    } else if (
      mode === "edit" &&
      contactInfoEditable &&
      originalPhone &&
      !phone
    ) {
      nextErrors.phone =
        "Backend hiện không hỗ trợ xóa số điện thoại. Hãy giữ giá trị hiện tại hoặc nhập số mới.";
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
        setFormError("Chưa có thay đổi nào để lưu.");
        return;
      }
      submission = { mode, input };
    }

    submitLockRef.current = true;
    setSaving(true);
    try {
      await onSubmit(submission);
    } catch (error) {
      setFormError(getAdminParentMutationErrorMessage(error));
      submitLockRef.current = false;
      setSaving(false);
      return;
    }

    submitLockRef.current = false;
    setSaving(false);
    onSuccess();
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={mode === "create" ? "Thêm Parent" : "Sửa hồ sơ Parent"}
    >
      {isLoading ? (
        <div
          aria-live="polite"
          className="grid min-h-40 place-items-center text-center"
          role="status"
        >
          <p className="font-bold text-muted">Đang tải thông tin tài khoản…</p>
        </div>
      ) : (
        <form className="grid gap-4" noValidate onSubmit={handleSubmit}>
          {formError ? (
            <StatusMessage tone="error" title={formError}>
              Thông tin đã nhập vẫn được giữ. Hãy kiểm tra lỗi và thử lại.
            </StatusMessage>
          ) : null}
          <TextField
            label="Tên hiển thị"
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
            label="Email"
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={(event) => updateField("email", event.target.value)}
            error={fieldErrors.email}
            required={mode === "create"}
            disabled={saving || (mode === "edit" && !contactInfoEditable)}
          />
          <TextField
            label="Số điện thoại"
            type="tel"
            autoComplete="tel"
            value={values.phone}
            onChange={(event) => updateField("phone", event.target.value)}
            error={fieldErrors.phone}
            maxLength={30}
            disabled={saving || (mode === "edit" && !contactInfoEditable)}
          />
          {mode === "edit" && !contactInfoEditable ? (
            <StatusMessage tone="warning" title="Thông tin liên hệ chỉ đọc">
              {contactInfoMessage ??
                "Backend chưa xác nhận được thông tin Supabase Auth. Tên hiển thị vẫn có thể chỉnh sửa."}
            </StatusMessage>
          ) : (
            <p className="text-sm text-muted">
              Email và số điện thoại được cập nhật qua Supabase Auth ở backend.
              API hiện không hỗ trợ xóa trống hai trường này.
            </p>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button
              className="sm:w-auto"
              disabled={saving}
              onClick={close}
              type="button"
              variant="secondary"
            >
              Hủy
            </Button>
            <Button
              className="sm:w-auto"
              disabled={isLoading}
              isLoading={saving}
              type="submit"
            >
              {mode === "create" ? "Tạo Parent" : "Lưu thay đổi"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
