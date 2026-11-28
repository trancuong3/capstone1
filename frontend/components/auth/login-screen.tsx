"use client";

import { useEffect } from "react";

import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { Card } from "@/components/common/card";
import { useTranslations } from "@/hooks/use-i18n";
import { registerCacheResetListener } from "@/lib/api/read-cache";
import { getApiBaseUrl } from "@/lib/supabase/config";
import type { AuthMockScenario } from "@/types/auth";

const HEALTH_WARMUP_COOLDOWN_MS = 60_000;
const HEALTH_WARMUP_TIMEOUT_MS = 55_000;
let lastHealthWarmupAt = 0;

registerCacheResetListener(() => {
  lastHealthWarmupAt = 0;
});

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

  useEffect(() => {
    if (scenario !== "default") return;

    const now = Date.now();
    if (
      lastHealthWarmupAt > 0 &&
      now - lastHealthWarmupAt < HEALTH_WARMUP_COOLDOWN_MS
    ) {
      return;
    }

    let apiBaseUrl: string;
    try {
      apiBaseUrl = getApiBaseUrl();
    } catch {
      return;
    }

    lastHealthWarmupAt = now;
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(
      () => controller.abort(),
      HEALTH_WARMUP_TIMEOUT_MS,
    );

    try {
      void Promise.resolve(
        fetch(`${apiBaseUrl}/health`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        }),
      )
        .catch(() => undefined)
        .finally(() => {
          globalThis.clearTimeout(timeoutId);
        });
    } catch {
      globalThis.clearTimeout(timeoutId);
    }

    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [scenario]);

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
