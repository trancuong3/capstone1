"use client";

import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { Card } from "@/components/common/card";
import { useTranslations } from "@/hooks/use-i18n";
import type { AuthMockScenario } from "@/types/auth";

interface LoginScreenProps {
  isAuthCallback?: boolean;
  nextPath?: string | null;
  scenario: AuthMockScenario;
  oauthError?: "email_required" | "oauth_failed" | null;
}

export function LoginScreen({
  isAuthCallback = false,
  nextPath = null,
  oauthError = null,
  scenario,
}: LoginScreenProps) {
  const tAuth = useTranslations("auth");

  if (scenario === "loading") {
    return <AuthLoadingState />;
  }

  return (
    <AuthShell>
      <Card className="border border-border bg-white">
        <div>
          <p className="text-sm font-semibold text-primary">
            {tAuth("login.eyebrow")}
          </p>
          <h1 className="mt-1 text-heading font-extrabold leading-tight text-ink">
            {tAuth("login.heading")}
          </h1>
          <p className="mt-2 text-body leading-6 text-muted">
            {tAuth("login.description")}
          </p>
        </div>
        <LoginForm
          isAuthCallback={isAuthCallback}
          nextPath={nextPath}
          oauthError={oauthError}
          scenario={scenario}
        />
      </Card>
    </AuthShell>
  );
}
