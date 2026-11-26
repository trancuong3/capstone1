"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { RegisterForm } from "@/components/auth/register-form";
import { ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";
import type { AuthMockScenario } from "@/types/auth";

interface RegisterScreenProps {
  scenario: AuthMockScenario;
}

function RegisterLoadingState() {
  const tAuth = useTranslations("auth");
  const tCommon = useTranslations("common");

  return (
    <AuthShell>
      <Card
        aria-busy="true"
        aria-label={tAuth("register.loadingAria")}
        className="border border-border bg-white"
      >
        <span className="sr-only" role="status">
          {tCommon("states.loading")}
        </span>
        <Skeleton className="h-11 w-3/5" />
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </Card>
    </AuthShell>
  );
}

export function RegisterScreen({ scenario }: RegisterScreenProps) {
  const tAuth = useTranslations("auth");
  const [requiresEmailConfirmation, setRequiresEmailConfirmation] =
    useState(false);

  if (scenario === "loading") {
    return <RegisterLoadingState />;
  }

  if (requiresEmailConfirmation) {
    return (
      <AuthShell>
        <Card className="border border-border" tone="success">
          <div>
            <h1 className="text-heading font-extrabold text-success-ink">
              {tAuth("register.checkEmailTitle")}
            </h1>
            <p className="mt-4 text-body leading-relaxed text-muted">
              {tAuth("register.checkEmailBody")}
            </p>
          </div>
          <StatusMessage tone="success">
            {tAuth("register.checkEmailSecurityNotice")}
          </StatusMessage>
          <ButtonLink href="/login">
            {tAuth("register.backToLogin")}
            <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
          </ButtonLink>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Card className="border border-border bg-white">
        <div>
          <p className="text-sm font-semibold text-primary">
            {tAuth("login.eyebrow")}
          </p>
          <h1 className="mt-1 text-heading font-extrabold leading-tight text-ink">
            {tAuth("register.heading")}
          </h1>
          <p className="mt-2 text-body leading-6 text-muted">
            {tAuth("register.description")}
          </p>
        </div>
        <RegisterForm
          onEmailConfirmationRequired={() => setRequiresEmailConfirmation(true)}
          scenario={scenario}
        />
      </Card>
    </AuthShell>
  );
}
