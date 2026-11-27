"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
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
import type { AuthMockScenario, ParentRegistrationInput } from "@/types/auth";

interface RegisterFormProps {
  onEmailConfirmationRequired: () => void;
  scenario: AuthMockScenario;
}

type RegisterErrorKind = "validation" | "safe";

export function RegisterForm({
  onEmailConfirmationRequired,
  scenario,
}: RegisterFormProps) {
  const { t } = useI18n();
  const authService = useAuthService();
  const authRuntime = useAuthRuntime();
  const isHydrated = useHydrated();
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [errorKind, setErrorKind] = useState<RegisterErrorKind | null>(() => {
    if (scenario === "validation-error") return "validation";
    if (scenario === "safe-error") return "safe";
    return null;
  });

  const registerSchema = useMemo(
    () =>
      z.object({
        displayName: z
          .string()
          .trim()
          .min(1, t("validation.parentDisplayNameRequired")),
        email: z
          .string()
          .trim()
          .min(1, t("validation.parentEmailRequired"))
          .email(t("validation.emailInvalidShort")),
        password: z
          .string()
          .min(8, t("validation.passwordMinLengthShort", { min: 8 })),
      }),
    [t],
  );

  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<ParentRegistrationInput>({
    defaultValues: {
      displayName: "",
      email: "",
      password: "",
    },
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = handleSubmit(async (values) => {
    setErrorKind(null);
    let hasAuthenticated = false;

    try {
      const result = await authService.registerParent(values);

      if (result.status === "email-confirmation-required") {
        onEmailConfirmationRequired();
        return;
      }

      hasAuthenticated = true;
      const role = await authService.getCurrentRole();
      if (role !== "parent") {
        throw new Error("A new parent account has no parent profile role.");
      }

      router.replace("/children/new?from=register");
      router.refresh();
    } catch (error) {
      if (hasAuthenticated) {
        try {
          await authService.signOut();
        } catch {
          // Preserve the original safe registration failure on cleanup errors.
        }
      }

      if (
        error instanceof AuthServiceError &&
        error.reason === "registration-validation"
      ) {
        setErrorKind("validation");
        return;
      }

      setErrorKind("safe");
    }
  });

  const errorMessage =
    errorKind === "validation"
      ? t("auth.register.errors.validation")
      : errorKind === "safe"
        ? t("auth.register.errors.safe")
        : null;

  return (
    <form
      className="flex w-full flex-col gap-4 sm:gap-6"
      noValidate
      onSubmit={onSubmit}
    >
      {errorMessage ? (
        <StatusMessage tone="error">{errorMessage}</StatusMessage>
      ) : null}
      <TextField
        autoComplete="name"
        error={errors.displayName?.message}
        label={t("auth.fields.parentDisplayName")}
        placeholder={t("auth.placeholders.parentDisplayName")}
        {...register("displayName")}
      />
      <TextField
        autoComplete="email"
        error={errors.email?.message}
        label={t("auth.fields.parentEmail")}
        placeholder={t("auth.placeholders.email")}
        type="email"
        {...register("email")}
      />
      <TextField
        autoComplete="new-password"
        endAdornment={
          <button
            aria-label={
              showPassword
                ? t("auth.passwordToggle.hide")
                : t("auth.passwordToggle.show")
            }
            aria-pressed={showPassword}
            className="inline-flex size-9 items-center justify-center rounded-control text-muted hover:bg-canvas hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => setShowPassword((prev) => !prev)}
            type="button"
          >
            {showPassword ? (
              <EyeOff aria-hidden="true" className="size-5" />
            ) : (
              <Eye aria-hidden="true" className="size-5" />
            )}
          </button>
        }
        error={errors.password?.message}
        label={t("auth.fields.password")}
        placeholder={t("auth.placeholders.passwordMinLength", { min: 8 })}
        type={showPassword ? "text" : "password"}
        {...register("password")}
      />
      <Button
        disabled={
          !isHydrated || authRuntime.status === "initializing" || isSubmitting
        }
        isLoading={isSubmitting}
        type="submit"
      >
        {isSubmitting
          ? t("auth.register.submitting")
          : t("auth.register.createSubmit")}
        {!isSubmitting ? (
          <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
        ) : null}
      </Button>
      <ButtonLink href="/login" variant="secondary">
        {t("auth.register.haveAccountSignIn")}
      </ButtonLink>
    </form>
  );
}
