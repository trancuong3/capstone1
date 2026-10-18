"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Mail, Phone, Save, ShieldCheck } from "lucide-react";
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

type Feedback = {
  tone: "success" | "error";
  title: string;
  message: string;
};

interface ParentProfileFormProps {
  onCancel: () => void;
  onUpdated: (profile: ParentProfileDTO) => void;
  onProfileRefresh: (profile: ParentProfileDTO) => void;
  profile: ParentProfileDTO;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    error.message &&
    !/token|secret|authorization|private|stack/i.test(error.message)
  ) {
    return error.message;
  }

  return fallback;
}

function validEmail(value: string): boolean {
  return z.email().safeParse(value.trim()).success;
}

function validPhoneInput(value: string): boolean {
  const compact = value.trim().replace(/[\s().-]/g, "");
  return /^(?:0\d{9}|84\d{9}|\+[1-9]\d{7,14})$/.test(compact);
}

export function ParentProfileForm({
  onCancel,
  onUpdated,
  onProfileRefresh,
  profile,
}: ParentProfileFormProps) {
  const isHydrated = useHydrated();
  const profileService = useProfileService();
  const [displayNameFeedback, setDisplayNameFeedback] = useState<Feedback | null>(null);
  const [emailFeedback, setEmailFeedback] = useState<Feedback | null>(null);
  const [phoneFeedback, setPhoneFeedback] = useState<Feedback | null>(null);
  const [emailValue, setEmailValue] = useState(profile.email ?? "");
  const [phoneValue, setPhoneValue] = useState(profile.pending_phone ?? profile.phone ?? "");
  const [otpValue, setOtpValue] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const [otpError, setOtpError] = useState<string | undefined>();
  const [contactBusy, setContactBusy] = useState<
    "email" | "resend-email" | "phone" | "verify-phone" | "resend-phone" | null
  >(null);

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
    setDisplayNameFeedback(null);

    try {
      const updatedProfile = await profileService.update({
        display_name: values.displayName.trim(),
      });
      onUpdated(updatedProfile);
    } catch {
      setDisplayNameFeedback({
        tone: "error",
        title: "Chưa lưu được tên hiển thị",
        message: "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
      });
    }
  });

  async function refreshContactProfile() {
    try {
      const freshProfile = await profileService.get();
      onProfileRefresh(freshProfile);
    } catch {
      // The Auth operation result remains valid; the UI will refresh on reload.
    }
  }

  async function saveEmail() {
    setEmailError(undefined);
    setEmailFeedback(null);
    const normalized = emailValue.trim().toLowerCase();

    if (!validEmail(normalized)) {
      setEmailError("Ba mẹ vui lòng nhập email hợp lệ.");
      return;
    }

    if (profile.pending_email?.toLowerCase() === normalized) {
      setContactBusy("resend-email");
      try {
        await profileService.resendEmailChange(normalized);
        setEmailFeedback({
          tone: "success",
          title: "Đã gửi lại email xác minh",
          message: "Ba mẹ hãy kiểm tra hộp thư đến và thư rác để hoàn tất xác minh.",
        });
        await refreshContactProfile();
      } catch (error) {
        setEmailFeedback({
          tone: "error",
          title: "Chưa gửi lại được email xác minh",
          message: safeErrorMessage(error, "Ba mẹ vui lòng thử lại sau."),
        });
      } finally {
        setContactBusy(null);
      }
      return;
    }

    if (profile.email?.toLowerCase() === normalized) {
      setEmailError("Email mới phải khác email hiện tại.");
      return;
    }

    setContactBusy("email");
    try {
      await profileService.requestEmailChange(normalized);
      setEmailFeedback({
        tone: "success",
        title: "Đã gửi yêu cầu đổi email",
        message:
          "Email mới chưa được áp dụng ngay. Ba mẹ hãy làm theo liên kết xác minh được gửi bởi Supabase Auth.",
      });
      await refreshContactProfile();
    } catch (error) {
      setEmailFeedback({
        tone: "error",
        title: "Chưa gửi được yêu cầu đổi email",
        message: safeErrorMessage(error, "Ba mẹ vui lòng kiểm tra cấu hình email và thử lại."),
      });
    } finally {
      setContactBusy(null);
    }
  }

  async function savePhone() {
    setPhoneError(undefined);
    setPhoneFeedback(null);
    const normalized = phoneValue.trim();

    if (!validPhoneInput(normalized)) {
      setPhoneError("Nhập số điện thoại hợp lệ, ví dụ 0912345678 hoặc +84912345678.");
      return;
    }

    if (profile.pending_phone && normalized === profile.pending_phone) {
      setContactBusy("resend-phone");
      try {
        await profileService.resendPhoneChangeOtp(profile.pending_phone);
        setPhoneFeedback({
          tone: "success",
          title: "Đã gửi lại mã OTP",
          message: "Ba mẹ nhập mã OTP mới nhất được gửi đến số điện thoại đang chờ xác minh.",
        });
      } catch (error) {
        setPhoneFeedback({
          tone: "error",
          title: "Chưa gửi lại được mã OTP",
          message: safeErrorMessage(error, "Ba mẹ vui lòng thử lại sau."),
        });
      } finally {
        setContactBusy(null);
      }
      return;
    }

    if (profile.pending_phone) {
      setPhoneError(
        "Đang có một số điện thoại chờ xác minh. Ba mẹ hãy xác minh số đó trước khi bắt đầu yêu cầu mới.",
      );
      return;
    }

    if (profile.phone === normalized) {
      setPhoneError("Số điện thoại mới phải khác số hiện tại.");
      return;
    }

    setContactBusy("phone");
    try {
      await profileService.requestPhoneChange(normalized);
      setPhoneFeedback({
        tone: "success",
        title: "Đã gửi yêu cầu xác minh số điện thoại",
        message: "Nhập mã OTP được gửi qua SMS để hoàn tất thay đổi số điện thoại.",
      });
      await refreshContactProfile();
    } catch (error) {
      setPhoneFeedback({
        tone: "error",
        title: "Chưa gửi được mã OTP",
        message: safeErrorMessage(error, "Ba mẹ vui lòng kiểm tra cấu hình SMS và thử lại."),
      });
    } finally {
      setContactBusy(null);
    }
  }

  async function verifyPhone() {
    setOtpError(undefined);
    setPhoneFeedback(null);
    const pendingPhone = profile.pending_phone;
    if (!pendingPhone) {
      setOtpError("Không tìm thấy số điện thoại đang chờ xác minh. Ba mẹ hãy tải lại hồ sơ.");
      return;
    }

    if (!/^\d{6}$/.test(otpValue.trim())) {
      setOtpError("Mã OTP phải gồm 6 chữ số.");
      return;
    }

    setContactBusy("verify-phone");
    try {
      await profileService.verifyPhoneChange(pendingPhone, otpValue.trim());
      setOtpValue("");
      setPhoneFeedback({
        tone: "success",
        title: "Đã xác minh số điện thoại",
        message: "Số điện thoại mới đã được xác nhận bởi Supabase Auth.",
      });
      await refreshContactProfile();
    } catch (error) {
      setPhoneFeedback({
        tone: "error",
        title: "Chưa xác minh được số điện thoại",
        message: safeErrorMessage(error, "Mã OTP không hợp lệ hoặc đã hết hạn."),
      });
    } finally {
      setContactBusy(null);
    }
  }

  const isContactBusy = contactBusy !== null;

  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={onSubmit}>
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
        <h3 className="text-lg font-extrabold text-ink">Chỉnh sửa thông tin hồ sơ</h3>
      </div>

      {displayNameFeedback ? (
        <StatusMessage title={displayNameFeedback.title} tone={displayNameFeedback.tone}>
          {displayNameFeedback.message}
        </StatusMessage>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="display-name-heading">
        <h4 id="display-name-heading" className="font-bold text-ink">Tên hiển thị</h4>
        <TextField
          autoComplete="name"
          error={errors.displayName?.message}
          label="Tên hiển thị của ba mẹ"
          placeholder="Ví dụ: Nguyễn Minh Anh"
          {...register("displayName")}
        />
        <Button
          className="sm:w-auto sm:self-start"
          disabled={!isHydrated || isSubmitting || isContactBusy}
          isLoading={isSubmitting}
          type="submit"
        >
          {!isSubmitting ? <Save aria-hidden="true" className="size-5" /> : null}
          {isSubmitting ? "Đang lưu…" : "Lưu tên hiển thị"}
        </Button>
      </section>

      <section className="flex flex-col gap-3 border-t border-border pt-5" aria-labelledby="email-heading">
        <h4 id="email-heading" className="flex items-center gap-2 font-bold text-ink">
          <Mail aria-hidden="true" className="size-5" />
          Email
        </h4>
        <p className="text-sm text-muted">
          Email hiện tại: <span className="break-all font-semibold text-ink">{profile.email ?? "Chưa cập nhật"}</span>
        </p>
        {profile.pending_email ? (
          <p className="break-words text-sm text-amber-700">
            Đang chờ xác minh email mới: <strong>{profile.pending_email}</strong>
          </p>
        ) : null}
        <TextField
          autoComplete="email"
          error={emailError}
          inputMode="email"
          label="Email mới"
          onChange={(event) => setEmailValue(event.target.value)}
          placeholder="name@example.com"
          type="email"
          value={emailValue}
        />
        {emailFeedback ? (
          <StatusMessage title={emailFeedback.title} tone={emailFeedback.tone}>
            {emailFeedback.message}
          </StatusMessage>
        ) : null}
        <Button
          className="sm:w-auto sm:self-start"
          disabled={!isHydrated || isContactBusy}
          isLoading={contactBusy === "email" || contactBusy === "resend-email"}
          onClick={() => void saveEmail()}
          type="button"
          variant="secondary"
        >
          {profile.pending_email && emailValue.trim().toLowerCase() === profile.pending_email.toLowerCase()
            ? "Gửi lại email xác minh"
            : "Yêu cầu đổi email"}
        </Button>
      </section>

      <section className="flex flex-col gap-3 border-t border-border pt-5" aria-labelledby="phone-heading">
        <h4 id="phone-heading" className="flex items-center gap-2 font-bold text-ink">
          <Phone aria-hidden="true" className="size-5" />
          Số điện thoại
        </h4>
        <p className="text-sm text-muted">
          Số hiện tại: <span className="break-all font-semibold text-ink">{profile.phone ?? "Chưa cập nhật"}</span>
        </p>
        {profile.pending_phone ? (
          <p className="break-words text-sm text-amber-700">
            Đang chờ xác minh số mới: <strong>{profile.pending_phone}</strong>
          </p>
        ) : null}
        <TextField
          autoComplete="tel"
          error={phoneError}
          inputMode="tel"
          label="Số điện thoại mới"
          onChange={(event) => setPhoneValue(event.target.value)}
          placeholder="0912345678 hoặc +84912345678"
          type="tel"
          value={phoneValue}
        />
        {phoneFeedback ? (
          <StatusMessage title={phoneFeedback.title} tone={phoneFeedback.tone}>
            {phoneFeedback.message}
          </StatusMessage>
        ) : null}
        <Button
          className="sm:w-auto sm:self-start"
          disabled={!isHydrated || isContactBusy}
          isLoading={contactBusy === "phone" || contactBusy === "resend-phone"}
          onClick={() => void savePhone()}
          type="button"
          variant="secondary"
        >
          {profile.pending_phone && phoneValue.trim() === profile.pending_phone
            ? "Gửi lại mã OTP"
            : "Gửi mã OTP để đổi số"}
        </Button>

        {profile.pending_phone ? (
          <div className="flex flex-col gap-3 rounded-control bg-sky p-4">
            <TextField
              autoComplete="one-time-code"
              error={otpError}
              inputMode="numeric"
              label="Mã OTP gồm 6 chữ số"
              maxLength={6}
              onChange={(event) => setOtpValue(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="Nhập mã OTP"
              type="text"
              value={otpValue}
            />
            <Button
              className="sm:w-auto sm:self-start"
              disabled={!isHydrated || isContactBusy}
              isLoading={contactBusy === "verify-phone"}
              onClick={() => void verifyPhone()}
              type="button"
            >
              <Check aria-hidden="true" className="size-5" />
              Xác minh số điện thoại
            </Button>
          </div>
        ) : null}
      </section>

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
          disabled={isSubmitting || isContactBusy}
          onClick={onCancel}
          type="button"
          variant="quiet"
        >
          Đóng
        </Button>
      </div>
    </form>
  );
}
