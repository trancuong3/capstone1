"use client";

import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
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
      <div className="flex w-full flex-col gap-5 sm:gap-4 sm:px-8 sm:py-6">
        <div>
          <p className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-bold text-primary-hover sm:rounded-none sm:bg-transparent sm:px-0 sm:py-0 sm:text-sm sm:font-semibold sm:text-primary">
            {tAuth("login.eyebrow")}
          </p>
          <h1 className="mt-2.5 text-heading font-extrabold leading-tight text-ink sm:mt-1">
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
      </div>
    </AuthShell>
  );
}
