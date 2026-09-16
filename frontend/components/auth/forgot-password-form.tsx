"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthService } from "@/hooks/use-auth-service";
import { useHydrated } from "@/hooks/use-hydrated";
import type { PasswordRecoveryRequest } from "@/types/auth";

const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Ba mẹ vui lòng nhập email.")
    .email("Email chưa đúng định dạng."),
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
  const isHydrated = useHydrated();
  const [hasError, setHasError] = useState(hasInitialError);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<PasswordRecoveryRequest>({
    defaultValues: { email: "minhanh@example.com" },
    resolver: zodResolver(forgotPasswordSchema),
  });

  const onSubmit = handleSubmit(async (values) => {
    setHasError(false);

    try {
      await authService.requestPasswordReset(values);
      onSubmitted(values.email);
    } catch {
      setHasError(true);
    }
  });

  return (
    <form
      className="flex w-full flex-col gap-4 sm:gap-6"
      noValidate
      onSubmit={onSubmit}
    >
      {hasError ? (
        <StatusMessage tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
      ) : null}
      <TextField
        autoComplete="email"
        error={errors.email?.message}
        label="Email của ba mẹ"
        type="email"
        {...register("email")}
      />
      <Button disabled={!isHydrated} isLoading={isSubmitting} type="submit">
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
