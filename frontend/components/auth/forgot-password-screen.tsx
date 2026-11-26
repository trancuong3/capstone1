"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthService } from "@/hooks/use-auth-service";
import { useTranslations } from "@/hooks/use-i18n";
import type { AuthMockScenario } from "@/types/auth";

interface ForgotPasswordScreenProps {
  scenario: AuthMockScenario;
}

export function ForgotPasswordScreen({ scenario }: ForgotPasswordScreenProps) {
  const tAuth = useTranslations("auth");
  const authService = useAuthService();
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(
    scenario === "submitted" ? "minhanh@example.com" : null,
  );
  const [resendState, setResendState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");

  if (scenario === "loading") {
    return <AuthLoadingState />;
  }

  async function handleResend() {
    if (!submittedEmail || resendState === "loading") {
      return;
    }

    setResendState("loading");

    try {
      await authService.requestPasswordReset({ email: submittedEmail });
      setResendState("success");
    } catch {
      setResendState("error");
    }
  }

  if (submittedEmail) {
    return (
      <AuthShell>
        <Card className="border border-border bg-white">
          <div>
            <p className="text-sm font-semibold text-primary">
              {tAuth("securityEyebrow")}
            </p>
            <h1 className="mt-2 text-heading font-extrabold text-ink">
              {resendState === "success"
                ? tAuth("forgotPassword.resentTitle")
                : tAuth("forgotPassword.checkEmailTitle")}
            </h1>
            <p className="mt-3 text-body leading-relaxed text-muted">
              {tAuth("forgotPassword.checkEmailBody")}
            </p>
          </div>
          {resendState === "error" ? (
            <StatusMessage tone="error">
              {tAuth("errors.generic")}
            </StatusMessage>
          ) : null}
          <ButtonLink href="/login">
            {tAuth("forgotPassword.backToLogin")}
            <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
          </ButtonLink>
          <Button
            disabled={resendState === "loading"}
            isLoading={resendState === "loading"}
            onClick={handleResend}
            variant="secondary"
          >
            {resendState === "loading"
              ? tAuth("forgotPassword.resending")
              : tAuth("forgotPassword.resend")}
          </Button>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Card className="border border-border bg-white">
        <div>
          <p className="text-sm font-semibold text-primary">
            {tAuth("securityEyebrow")}
          </p>
          <h1 className="mt-2 text-heading font-extrabold text-ink">
            {tAuth("forgotPassword.heading")}
          </h1>
          <p className="mt-3 text-body leading-relaxed text-muted">
            {tAuth("forgotPassword.subtitleShort")}
          </p>
        </div>
        <ForgotPasswordForm
          hasInitialError={scenario === "safe-error"}
          onSubmitted={setSubmittedEmail}
        />
      </Card>
    </AuthShell>
  );
}
