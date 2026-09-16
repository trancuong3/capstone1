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
import type { AuthMockScenario } from "@/types/auth";

const resetPasswordSchema = z
  .object({
    newPassword: z.string().min(8, "Mật khẩu mới cần có ít nhất 8 ký tự."),
    confirmPassword: z.string().min(1, "Ba mẹ vui lòng nhập lại mật khẩu mới."),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "Hai mật khẩu chưa khớp.",
    path: ["confirmPassword"],
  });

type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;

interface ResetPasswordFormProps {
  onSuccess: () => void;
  scenario: AuthMockScenario;
}

export function ResetPasswordForm({
  onSuccess,
  scenario,
}: ResetPasswordFormProps) {
  const authService = useAuthService();
  const isHydrated = useHydrated();
  const [hasError, setHasError] = useState(scenario === "safe-error");
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<ResetPasswordFormValues>({
    defaultValues: { confirmPassword: "", newPassword: "" },
    resolver: zodResolver(resetPasswordSchema),
  });

  const onSubmit = handleSubmit(async (values) => {
    setHasError(false);

    try {
      await authService.resetPassword({ newPassword: values.newPassword });
      onSuccess();
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
        autoComplete="new-password"
        error={errors.newPassword?.message}
        label="Mật khẩu mới"
        placeholder="••••••••••••"
        type="password"
        {...register("newPassword")}
      />
      <TextField
        autoComplete="new-password"
        error={errors.confirmPassword?.message}
        label="Nhập lại mật khẩu mới"
        placeholder="••••••••••••"
        type="password"
        {...register("confirmPassword")}
      />
      <Button disabled={!isHydrated} isLoading={isSubmitting} type="submit">
        {isSubmitting ? "Đang lưu…" : "Lưu mật khẩu mới"}
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
