"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useAuthService } from "@/hooks/use-auth-service";
import { useHydrated } from "@/hooks/use-hydrated";
import { AuthServiceError } from "@/lib/api/auth-service";
import { isEmailAddress, normalizeEmail, normalizePhoneNumber } from "@/lib/auth/phone";
import type { AuthMockScenario, ParentRegistrationInput } from "@/types/auth";

interface RegisterFormValues {
  displayName: string;
  email: string;
  phone: string;
  password: string;
}

const registerSchema = z.object({
  displayName: z.string().trim().min(1, "Ba mẹ vui lòng nhập họ và tên."),
  email: z.string().trim().refine(
    (value) => !value || isEmailAddress(value),
    "Email chưa đúng định dạng.",
  ),
  phone: z.string().trim().refine(
    (value) => !value || normalizePhoneNumber(value) !== null,
    "Số điện thoại chưa đúng định dạng. Ví dụ: 0912345678.",
  ),
  password: z.string().min(8, "Mật khẩu cần có ít nhất 8 ký tự."),
}).superRefine((value, context) => {
  if (!value.email && !value.phone) {
    context.addIssue({
      code: "custom",
      path: ["email"],
      message: "Ba mẹ vui lòng nhập email hoặc số điện thoại.",
    });
  }
});

const safeRegistrationError =
  "Không thể hoàn tất đăng ký. Ba mẹ vui lòng kiểm tra thông tin hoặc đăng nhập nếu đã có tài khoản.";
const registrationValidationError =
  "Thông tin đăng ký chưa hợp lệ. Ba mẹ vui lòng kiểm tra và thử lại.";

interface RegisterFormProps {
  onEmailConfirmationRequired: () => void;
  scenario: AuthMockScenario;
}

type EmailLinkState = "not-requested" | "confirmation-sent" | "failed";

export function RegisterForm({
  onEmailConfirmationRequired,
  scenario,
}: RegisterFormProps) {
  const authService = useAuthService();
  const authRuntime = useAuthRuntime();
  const isHydrated = useHydrated();
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(() => {
    if (scenario === "validation-error") return registrationValidationError;
    if (scenario === "safe-error") return safeRegistrationError;
    return null;
  });
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [emailLinkState, setEmailLinkState] = useState<EmailLinkState>("not-requested");
  const [isResending, setIsResending] = useState(false);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<RegisterFormValues>({
    defaultValues: { displayName: "", email: "", phone: "", password: "" },
    resolver: zodResolver(registerSchema),
  });

  const finishParentOnboarding = async () => {
    const role = await authService.getCurrentRole();
    if (role !== "parent") {
      throw new Error("A new parent account has no parent profile role.");
    }
    router.replace("/children/new?from=register");
    router.refresh();
  };

  const linkEmailIfProvided = async (email: string) => {
    try {
      await authService.addEmailToCurrentUser({ email });
      setEmailLinkState("confirmation-sent");
      setErrorMessage(null);
    } catch {
      // Phone verification remains valid if email linking fails.
      setEmailLinkState("failed");
      setErrorMessage(
        "Số điện thoại đã được xác minh, nhưng chưa thể liên kết email. Ba mẹ có thể thử lại hoặc tiếp tục chỉ bằng số điện thoại.",
      );
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    setErrorMessage(null);
    let hasAuthenticated = false;
    const email = values.email.trim() ? normalizeEmail(values.email) : undefined;
    const phone = values.phone.trim()
      ? normalizePhoneNumber(values.phone) ?? undefined
      : undefined;
    const input: ParentRegistrationInput = {
      displayName: values.displayName.trim(),
      password: values.password,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    };

    try {
      const result = await authService.registerParent(input);
      if (result.status === "email-confirmation-required") {
        onEmailConfirmationRequired();
        return;
      }
      if (result.status === "phone-confirmation-required") {
        setPendingPhone(result.phone);
        setPendingEmail(email ?? null);
        setPhoneVerified(false);
        setOtp("");
        return;
      }

      hasAuthenticated = true;
      await finishParentOnboarding();
    } catch (error) {
      if (hasAuthenticated) {
        try {
          await authService.signOut();
        } catch {
          // Preserve the original safe registration failure.
        }
      }
      setErrorMessage(
        error instanceof AuthServiceError &&
          (error.reason === "registration-validation" || error.reason === "phone-validation")
          ? registrationValidationError
          : safeRegistrationError,
      );
    }
  });

  const verifyPhone = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pendingPhone || isSubmitting || !/^\\d{4,8}$/.test(otp.trim())) {
      setErrorMessage("Ba mẹ vui lòng nhập mã xác minh hợp lệ.");
      return;
    }

    setErrorMessage(null);
    try {
      await authService.verifyPhoneSignup({ phone: pendingPhone, token: otp.trim() });
      setPhoneVerified(true);
      if (pendingEmail) await linkEmailIfProvided(pendingEmail);
    } catch (error) {
      setErrorMessage(
        error instanceof AuthServiceError && error.reason === "expired-otp"
          ? "Mã xác minh đã hết hạn. Ba mẹ vui lòng gửi lại mã."
          : "Không thể xác minh mã. Ba mẹ kiểm tra mã SMS hoặc thử gửi lại.",
      );
    }
  };

  const resendPhoneOtp = async () => {
    if (!pendingPhone || isResending) return;
    setIsResending(true);
    setErrorMessage(null);
    try {
      await authService.resendPhoneSignupConfirmation({ phone: pendingPhone });
    } catch {
      setErrorMessage("Chưa thể gửi lại SMS. Ba mẹ vui lòng chờ một chút rồi thử lại.");
    } finally {
      setIsResending(false);
    }
  };

  const continueAfterPhoneVerification = async () => {
    setErrorMessage(null);
    try {
      await finishParentOnboarding();
    } catch {
      setErrorMessage(safeRegistrationError);
    }
  };

  if (pendingPhone) {
    return (
      <div className="flex w-full flex-col gap-4 sm:gap-6">
        {errorMessage ? <StatusMessage tone="error">{errorMessage}</StatusMessage> : null}
        {!phoneVerified ? (
          <>
            <div>
              <h2 className="text-lg font-extrabold text-ink">Xác minh số điện thoại</h2>
              <p className="mt-2 text-sm text-muted">
                Nhập mã OTP được gửi bằng SMS đến {pendingPhone}.
              </p>
            </div>
            <form className="flex flex-col gap-4" noValidate onSubmit={verifyPhone}>
              <TextField
                autoComplete="one-time-code"
                inputMode="numeric"
                label="Mã xác minh OTP"
                placeholder="Nhập mã trong SMS"
                value={otp}
                onChange={(event) => setOtp(event.currentTarget.value.replace(/\\D/g, "").slice(0, 8))}
              />
              <Button disabled={isSubmitting || otp.trim().length < 4} isLoading={isSubmitting} type="submit">
                Xác minh số điện thoại
              </Button>
            </form>
            <Button disabled={isResending} isLoading={isResending} onClick={() => void resendPhoneOtp()} type="button" variant="quiet">
              Gửi lại mã SMS
            </Button>
            <ButtonLink href="/login" variant="secondary">Về đăng nhập</ButtonLink>
          </>
        ) : (
          <>
            <StatusMessage tone="success">
              Số điện thoại đã được xác minh thành công.
              {emailLinkState === "confirmation-sent"
                ? " Supabase đã gửi email xác nhận để liên kết email với tài khoản này."
                : ""}
            </StatusMessage>
            {emailLinkState === "failed" && pendingEmail ? (
              <Button onClick={() => void linkEmailIfProvided(pendingEmail)} type="button" variant="secondary">
                Thử liên kết email lại
              </Button>
            ) : null}
            <Button onClick={() => void continueAfterPhoneVerification()} type="button">
              Tiếp tục thiết lập hồ sơ bé
              <ArrowRight aria-hidden="true" className="size-5" />
            </Button>
            <ButtonLink href="/login" variant="quiet">Hoàn tất sau, về đăng nhập</ButtonLink>
          </>
        )}
      </div>
    );
  }

  return (
    <form className="flex w-full flex-col gap-4 sm:gap-6" noValidate onSubmit={onSubmit}>
      {errorMessage ? <StatusMessage tone="error">{errorMessage}</StatusMessage> : null}
      <p className="text-sm text-muted">
        Nhập email hoặc số điện thoại để tạo tài khoản. Bạn cần cung cấp ít nhất một trong hai thông tin.
      </p>
      <TextField autoComplete="name" error={errors.displayName?.message} label="Họ và tên ba mẹ" placeholder="Nguyễn Minh Anh" {...register("displayName")} />
      <TextField autoComplete="email" error={errors.email?.message} label="Email của ba mẹ (không bắt buộc)" placeholder="minhanh@example.com" type="email" {...register("email")} />
      <TextField autoComplete="tel" error={errors.phone?.message} label="Số điện thoại (không bắt buộc)" placeholder="0912345678" type="tel" {...register("phone")} />
      <TextField autoComplete="new-password" error={errors.password?.message} label="Mật khẩu" placeholder="Tối thiểu 8 ký tự" type="password" {...register("password")} />
      <Button disabled={!isHydrated || authRuntime.status === "initializing" || isSubmitting} isLoading={isSubmitting} type="submit">
        {isSubmitting ? "Đang tạo tài khoản…" : "Tạo tài khoản"}
        {!isSubmitting ? <ArrowRight aria-hidden="true" className="size-5" /> : null}
      </Button>
      <ButtonLink href="/login" variant="secondary">Đã có tài khoản? Đăng nhập</ButtonLink>
    </form>
  );
}
