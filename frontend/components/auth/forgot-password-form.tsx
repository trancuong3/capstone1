"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useAuthService } from "@/hooks/use-auth-service";
import { useHydrated } from "@/hooks/use-hydrated";
import {
  isEmailAddress,
  normalizeEmail,
  normalizePhoneNumber,
} from "@/lib/auth/phone";

interface ForgotFormValues {
  identifier: string;
}
const forgotPasswordSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, "Ba mẹ vui lòng nhập email hoặc số điện thoại.")
    .refine(
      (value) => isEmailAddress(value) || normalizePhoneNumber(value) !== null,
      "Email hoặc số điện thoại chưa đúng định dạng.",
    ),
});

interface ForgotPasswordFormProps {
  hasInitialError: boolean;
  onSubmitted: (email: string) => void;
}

export function ForgotPasswordForm({
  hasInitialError,
  onSubmitted,
}: ForgotPasswordFormProps) {
  const authService = useAuthService();
  const authRuntime = useAuthRuntime();
  const isHydrated = useHydrated();
  const [hasError, setHasError] = useState(hasInitialError);
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [phoneResetComplete, setPhoneResetComplete] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [isResettingPhone, setIsResettingPhone] = useState(false);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<ForgotFormValues>({
    defaultValues: { identifier: "" },
    resolver: zodResolver(forgotPasswordSchema),
  });

  const onSubmit = handleSubmit(async ({ identifier }) => {
    setHasError(false);
    try {
      if (isEmailAddress(identifier)) {
        const email = normalizeEmail(identifier);
        await authService.requestPasswordReset({ email });
        onSubmitted(email);
        return;
      }
      const phone = normalizePhoneNumber(identifier);
      if (!phone) throw new Error("Invalid identifier");
      await authService.requestPhonePasswordReset({ phone });
      setPendingPhone(phone);
    } catch {
      setHasError(true);
    }
  });

  const onResetPhonePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isResettingPhone) return;
    setHasError(false);
    if (
      !pendingPhone ||
      !/^\d{4,8}$/.test(otp.trim()) ||
      newPassword.length < 8
    ) {
      setHasError(true);
      return;
    }
    setIsResettingPhone(true);
    try {
      await authService.resetPasswordByPhone({
        phone: pendingPhone,
        token: otp.trim(),
        newPassword,
      });
      setPhoneResetComplete(true);
    } catch {
      setHasError(true);
    } finally {
      setIsResettingPhone(false);
    }
  };

  const resendPhoneOtp = async () => {
    if (!pendingPhone || isResending) return;
    setIsResending(true);
    setHasError(false);
    try {
      await authService.resendPhonePasswordReset({ phone: pendingPhone });
    } catch {
      setHasError(true);
    } finally {
      setIsResending(false);
    }
  };

  if (phoneResetComplete) {
    return (
      <div className="flex w-full flex-col gap-5">
        <StatusMessage tone="success">
          Đã cập nhật mật khẩu. Ba mẹ có thể đăng nhập bằng số điện thoại và mật
          khẩu mới.
        </StatusMessage>
        <ButtonLink href="/login">
          Về đăng nhập
          <ArrowRight aria-hidden="true" className="size-5" />
        </ButtonLink>
      </div>
    );
  }

  if (pendingPhone) {
    return (
      <div className="flex w-full flex-col gap-4 sm:gap-6">
        {hasError ? (
          <StatusMessage tone="error">
            Không thể xác minh hoặc cập nhật mật khẩu. Ba mẹ kiểm tra mã, mật
            khẩu mới và thử lại.
          </StatusMessage>
        ) : null}
        <p className="text-sm text-muted">
          Nhập mã SMS gửi đến {pendingPhone} và tạo mật khẩu mới.
        </p>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={onResetPhonePassword}
        >
          <TextField
            autoComplete="one-time-code"
            inputMode="numeric"
            label="Mã xác minh OTP"
            value={otp}
            onChange={(event) =>
              setOtp(event.currentTarget.value.replace(/\D/g, "").slice(0, 8))
            }
          />
          <TextField
            autoComplete="new-password"
            label="Mật khẩu mới"
            placeholder="Tối thiểu 8 ký tự"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.currentTarget.value)}
          />
          <Button
            disabled={
              isResettingPhone ||
              otp.trim().length < 4 ||
              newPassword.length < 8
            }
            isLoading={isResettingPhone}
            type="submit"
          >
            Xác minh và đặt lại mật khẩu
          </Button>
        </form>
        <Button
          disabled={isResending}
          isLoading={isResending}
          onClick={() => void resendPhoneOtp()}
          type="button"
          variant="quiet"
        >
          Gửi lại mã SMS
        </Button>
        <ButtonLink href="/login" variant="quiet">
          <ArrowLeft aria-hidden="true" className="size-5" />
          Về đăng nhập
        </ButtonLink>
      </div>
    );
  }

  return (
    <form
      className="flex w-full flex-col gap-4 sm:gap-6"
      noValidate
      onSubmit={onSubmit}
    >
      {hasError ? (
        <StatusMessage tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng kiểm tra thông tin hoặc thử lại sau.
        </StatusMessage>
      ) : null}
      <TextField
        autoComplete="username"
        error={errors.identifier?.message}
        label="Email hoặc số điện thoại"
        placeholder="Nhập email hoặc số điện thoại"
        type="text"
        {...register("identifier")}
      />
      <Button
        disabled={
          !isHydrated || authRuntime.status === "initializing" || isSubmitting
        }
        isLoading={isSubmitting}
        type="submit"
      >
        {isSubmitting ? "Đang gửi…" : "Gửi hướng dẫn"}
        {!isSubmitting ? (
          <ArrowRight aria-hidden="true" className="size-5" />
        ) : null}
      </Button>
      <ButtonLink href="/login" variant="quiet">
        <ArrowLeft aria-hidden="true" className="size-5" />
        Về đăng nhập
      </ButtonLink>
    </form>
  );
}
