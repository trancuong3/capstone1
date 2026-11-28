"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useAuthService } from "@/hooks/use-auth-service";
import { useHydrated } from "@/hooks/use-hydrated";
import { useI18n } from "@/hooks/use-i18n";
import type { PasswordRecoveryRequest } from "@/types/auth";

interface ForgotPasswordFormProps {
  hasInitialError: boolean;
  onSubmitted: (email: string) => void;
}

export function ForgotPasswordForm({
  hasInitialError,
  onSubmitted,
}: ForgotPasswordFormProps) {
  const { locale, t } = useI18n();
  const authService = useAuthService();
  const authRuntime = useAuthRuntime();
  const isHydrated = useHydrated();
  const [hasError, setHasError] = useState(hasInitialError);

  const forgotPasswordSchema = useMemo(
    () =>
      z.object({
        email: z
          .string()
          .trim()
          .min(1, t("validation.parentEmailRequired"))
          .email(t("validation.emailInvalidShort")),
      }),
    [t],
  );

  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    trigger,
  } = useForm<PasswordRecoveryRequest>({
    defaultValues: { email: "" },
    resolver: zodResolver(forgotPasswordSchema),
  });
  const prevLocaleRef = useRef(locale);
  const errorsRef = useRef(errors);

  useEffect(() => {
    errorsRef.current = errors;
  }, [errors]);

  useEffect(() => {
    if (prevLocaleRef.current === locale) {
      return;
    }
    prevLocaleRef.current = locale;
    const activeFields = Object.keys(errorsRef.current) as Array<
      keyof PasswordRecoveryRequest
    >;
    if (activeFields.length > 0) {
      void trigger(activeFields);
    }
  }, [locale, trigger]);

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
        <StatusMessage tone="error">{t("auth.errors.generic")}</StatusMessage>
      ) : null}
      <TextField
        autoComplete="email"
        error={errors.email?.message}
        label={t("auth.fields.parentEmail")}
        type="email"
        {...register("email")}
      />
      <Button
        disabled={
          !isHydrated || authRuntime.status === "initializing" || isSubmitting
        }
        isLoading={isSubmitting}
        type="submit"
      >
        {isSubmitting
          ? t("auth.forgotPassword.sending")
          : t("auth.forgotPassword.sendSubmit")}
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
