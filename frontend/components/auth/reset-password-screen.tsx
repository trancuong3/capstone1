"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useTranslations } from "@/hooks/use-i18n";
import type { AuthMockScenario } from "@/types/auth";

interface ResetPasswordScreenProps {
  scenario: AuthMockScenario;
}

export function ResetPasswordScreen({ scenario }: ResetPasswordScreenProps) {
  const tAuth = useTranslations("auth");
  const authRuntime = useAuthRuntime();
  const [isSuccessful, setIsSuccessful] = useState(scenario === "success");
  const [recoveryFailure, setRecoveryFailure] = useState<
    "invalid-token" | "expired-token" | null
  >(
    scenario === "invalid-token" || scenario === "expired-token"
      ? scenario
      : null,
  );

  if (scenario === "loading") {
    return <AuthLoadingState />;
  }

  if (
    authRuntime.mode === "supabase" &&
    authRuntime.status === "initializing"
  ) {
    return <AuthLoadingState />;
  }

  const runtimeRecoveryFailure =
    authRuntime.mode === "supabase" &&
    (authRuntime.status === "error" ||
      (authRuntime.status === "ready" && !authRuntime.isPasswordRecovery))
      ? authRuntime.initializationFailure === "expired-recovery-context"
        ? "expired-token"
        : "invalid-token"
      : null;
  const effectiveRecoveryFailure = recoveryFailure ?? runtimeRecoveryFailure;

  if (isSuccessful) {
    return (
      <AuthShell>
        <div className="flex w-full flex-col gap-4 rounded-card border border-border bg-success-surface p-5 sm:rounded-none sm:border-0 sm:px-8 sm:py-6">
          <div>
            <p className="inline-flex w-fit items-center rounded-full bg-white/80 px-3 py-1 text-xs font-bold text-success-ink sm:rounded-none sm:bg-transparent sm:px-0 sm:py-0 sm:text-sm sm:font-semibold">
              {tAuth("accountEyebrow")}
            </p>
            <h1 className="mt-2.5 text-heading font-extrabold text-success-ink sm:mt-2">
              {tAuth("resetPassword.successTitle")}
            </h1>
            <p className="mt-3 text-body leading-relaxed text-muted">
              {tAuth("resetPassword.successBody")}
            </p>
          </div>
          <ButtonLink href="/login">
            {tAuth("login.submit")}
            <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
          </ButtonLink>
        </div>
      </AuthShell>
    );
  }

  if (effectiveRecoveryFailure) {
    const isExpired = effectiveRecoveryFailure === "expired-token";

    return (
      <AuthShell>
        <div className="flex w-full flex-col gap-5 sm:gap-4 sm:px-8 sm:py-6">
          <div>
            <p className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-bold text-primary-hover sm:rounded-none sm:bg-transparent sm:px-0 sm:py-0 sm:text-sm sm:font-semibold sm:text-primary">
              {tAuth("securityEyebrow")}
            </p>
            <h1 className="mt-2.5 text-heading font-extrabold text-ink sm:mt-2">
              {isExpired
                ? tAuth("resetPassword.expiredTitle")
                : tAuth("resetPassword.invalidTitle")}
            </h1>
            <p className="mt-3 text-body leading-relaxed text-muted">
              {isExpired
                ? tAuth("resetPassword.expiredBody")
                : tAuth("resetPassword.invalidBody")}
            </p>
          </div>
          <StatusMessage tone="warning">
            {tAuth("resetPassword.unusableWarning")}
          </StatusMessage>
          <ButtonLink href="/forgot-password" variant="secondary">
            {tAuth("resetPassword.requestNewLink")}
            <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
          </ButtonLink>
          <ButtonLink href="/login" variant="quiet">
            {tAuth("forgotPassword.backToLogin")}
          </ButtonLink>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="flex w-full flex-col gap-5 sm:gap-4 sm:px-8 sm:py-6">
        <div>
          <p className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-bold text-primary-hover sm:rounded-none sm:bg-transparent sm:px-0 sm:py-0 sm:text-sm sm:font-semibold sm:text-primary">
            {tAuth("securityEyebrow")}
          </p>
          <h1 className="mt-2.5 text-heading font-extrabold text-ink sm:mt-2">
            {tAuth("resetPassword.heading")}
          </h1>
          <p className="mt-3 text-body leading-relaxed text-muted">
            {tAuth("resetPassword.instructions")}
          </p>
        </div>
        <ResetPasswordForm
          onRecoveryFailure={setRecoveryFailure}
          onSuccess={() => setIsSuccessful(true)}
          scenario={scenario}
        />
      </div>
    </AuthShell>
  );
}
