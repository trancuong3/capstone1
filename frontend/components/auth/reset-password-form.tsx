"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useAuthService } from "@/hooks/use-auth-service";
import { useHydrated } from "@/hooks/use-hydrated";
import { useI18n } from "@/hooks/use-i18n";
import { AuthServiceError } from "@/lib/api/auth-service";
import type { AuthMockScenario } from "@/types/auth";

interface ResetPasswordFormValues {
  newPassword: string;
  confirmPassword: string;
}

interface ResetPasswordFormProps {
  onRecoveryFailure: (reason: "invalid-token" | "expired-token") => void;
  onSuccess: () => void;
  scenario: AuthMockScenario;
}

export function ResetPasswordForm({
  onRecoveryFailure,
  onSuccess,
  scenario,
}: ResetPasswordFormProps) {
  const { t } = useI18n();
  const authService = useAuthService();
  const authRuntime = useAuthRuntime();
  const isHydrated = useHydrated();
  const [hasError, setHasError] = useState(scenario === "safe-error");

  const resetPasswordSchema = useMemo(
    () =>
      z
        .object({
          newPassword: z
            .string()
            .min(8, t("validation.passwordMinLength", { min: 8 })),
          confirmPassword: z
            .string()
            .min(1, t("validation.confirmNewPasswordRequired")),
        })
        .refine((values) => values.newPassword === values.confirmPassword, {
          message: t("validation.passwordMismatchShort"),
          path: ["confirmPassword"],
        }),
    [t],
  );

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
    } catch (error) {
      if (error instanceof AuthServiceError) {
        if (error.reason === "invalid-recovery-context") {
          onRecoveryFailure("invalid-token");
          return;
        }

        if (error.reason === "expired-recovery-context") {
          onRecoveryFailure("expired-token");
          return;
        }
      }

      setHasError(true);
    }
  });

  return (
    <form
      className="flex w-full flex-col gap-5 sm:gap-6"
      noValidate
      onSubmit={onSubmit}
    >
      {hasError ? (
        <StatusMessage tone="error">{t("auth.errors.generic")}</StatusMessage>
      ) : null}
      <TextField
        autoComplete="new-password"
        error={errors.newPassword?.message}
        label={t("auth.fields.newPassword")}
        placeholder="••••••••••••"
        type="password"
        {...register("newPassword")}
      />
      <TextField
        autoComplete="new-password"
        error={errors.confirmPassword?.message}
        label={t("auth.fields.reenterNewPassword")}
        placeholder="••••••••••••"
        type="password"
        {...register("confirmPassword")}
      />
      <Button
        disabled={
          !isHydrated || authRuntime.status === "initializing" || isSubmitting
        }
        isLoading={isSubmitting}
        type="submit"
      >
        {isSubmitting
          ? t("common.actions.saving")
          : t("auth.resetPassword.submit")}
        {!isSubmitting ? (
          <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
        ) : null}
      </Button>
      <ButtonLink href="/login" variant="quiet">
        <ArrowLeft aria-hidden="true" className="size-5 viread-rtl-flip" />
        {t("auth.forgotPassword.backToLogin")}
      </ButtonLink>
    </form>
  );
}
