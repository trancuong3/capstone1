"use client";

import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useAuthService } from "@/hooks/use-auth-service";
import { useHydrated } from "@/hooks/use-hydrated";
import { useI18n } from "@/hooks/use-i18n";
import { AuthServiceError, type OAuthProvider } from "@/lib/api/auth-service";
import {
  AUTH_NEXT_COOKIE,
  isSafeRelativeNextCandidate,
  sanitizeNextPath,
} from "@/lib/auth/route-policy";
import type { AuthMockScenario, LoginRequest } from "@/types/auth";

interface LoginFormProps {
  isAuthCallback?: boolean;
  nextPath?: string | null;
  scenario: AuthMockScenario;
  oauthError?: "email_required" | "oauth_failed" | null;
}

function setOAuthNextCookie(nextPath: string | null | undefined) {
  if (typeof document === "undefined") return;
  const safeNext = isSafeRelativeNextCandidate(nextPath);
  const secure =
    typeof window !== "undefined" && window.location.protocol === "https:"
      ? "; Secure"
      : "";
  if (!safeNext) {
    document.cookie = `${AUTH_NEXT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    return;
  }
  document.cookie = `${AUTH_NEXT_COOKIE}=${encodeURIComponent(safeNext)}; Path=/; Max-Age=600; SameSite=Lax${secure}`;
}

function clearOAuthNextCookie() {
  if (typeof document === "undefined") return;
  const secure =
    typeof window !== "undefined" && window.location.protocol === "https:"
      ? "; Secure"
      : "";
  document.cookie = `${AUTH_NEXT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

type LoginNoticeKind =
  | "email_required"
  | "oauth_failed"
  | "invalid_credentials"
  | "safe_error"
  | "oauth_start_failed";

function GoogleMark() {
  return (
    <svg aria-hidden="true" className="size-5 shrink-0" viewBox="0 0 48 48">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.91c-.58 2.96-2.26 5.48-4.74 7.18l7.73 6C44.4 37.96 46.98 31.9 46.98 24.55Z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59A14.45 14.45 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.52 2.56 10.78l7.97-6.19Z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.9-5.8l-7.73-6c-2.14 1.44-4.89 2.3-8.17 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"
      />
    </svg>
  );
}

function FacebookMark() {
  return (
    <svg aria-hidden="true" className="size-5 shrink-0" viewBox="0 0 24 24">
      <path
        fill="#1877F2"
        d="M24 12a12 12 0 1 0-13.875 11.85v-8.38H7.08V12h3.045V9.35c0-3 1.79-4.66 4.52-4.66 1.31 0 2.68.235 2.68.235v2.95h-1.51c-1.49 0-1.955.925-1.955 1.875V12h3.33l-.532 3.47H13.86v8.38A12 12 0 0 0 24 12Z"
      />
    </svg>
  );
}

export function LoginForm({
  isAuthCallback = false,
  nextPath = null,
  oauthError = null,
  scenario,
}: LoginFormProps) {
  const { t } = useI18n();
  const authService = useAuthService();
  const authRuntime = useAuthRuntime();
  const isHydrated = useHydrated();
  const { refresh, replace } = useRouter();
  const [socialLoading, setSocialLoading] = useState<OAuthProvider | null>(
    null,
  );
  const [noticeKind, setNoticeKind] = useState<LoginNoticeKind | null>(() => {
    if (oauthError === "email_required") return "email_required";
    if (oauthError === "oauth_failed") return "oauth_failed";
    if (scenario === "invalid-credentials") return "invalid_credentials";
    if (scenario === "safe-error") return "safe_error";
    return null;
  });

  const loginSchema = useMemo(
    () =>
      z.object({
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
  } = useForm<LoginRequest>({
    defaultValues: {
      email: "",
      password: "",
    },
    resolver: zodResolver(loginSchema),
  });
  const isCompletingCallback =
    isAuthCallback &&
    authRuntime.mode === "supabase" &&
    authRuntime.status === "ready" &&
    Boolean(authRuntime.session) &&
    noticeKind === null &&
    !isSubmitting;

  const clearSessionQuietly = useCallback(async () => {
    try {
      await authService.signOut();
    } catch {
      // Preserve the original safe failure if local cleanup also fails.
    }
  }, [authService]);

  const routeAuthenticatedUser = useCallback(async () => {
    const role = await authService.getCurrentRole();
    if (!role) {
      throw new Error("The signed-in account has no application role.");
    }

    clearOAuthNextCookie();
    replace(sanitizeNextPath(nextPath, role));
    refresh();
  }, [authService, nextPath, refresh, replace]);

  useEffect(() => {
    if (
      !isAuthCallback ||
      authRuntime.mode !== "supabase" ||
      authRuntime.status !== "ready" ||
      !authRuntime.session ||
      isSubmitting
    ) {
      return;
    }

    let isActive = true;

    void routeAuthenticatedUser().catch(async () => {
      if (isActive) {
        setNoticeKind("safe_error");
      }
      await clearSessionQuietly();
    });

    return () => {
      isActive = false;
    };
  }, [
    authRuntime.mode,
    authRuntime.session,
    authRuntime.status,
    clearSessionQuietly,
    isAuthCallback,
    isSubmitting,
    routeAuthenticatedUser,
  ]);

  const handleSocialSignIn = async (provider: OAuthProvider) => {
    setNoticeKind(null);
    setSocialLoading(provider);
    setOAuthNextCookie(nextPath);

    try {
      await authService.signInWithOAuth(provider);
      setSocialLoading(null);
    } catch {
      clearOAuthNextCookie();
      setSocialLoading(null);
      setNoticeKind("oauth_start_failed");
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    setNoticeKind(null);
    let hasAuthenticated = false;

    try {
      await authService.signIn(values);
      hasAuthenticated = true;
      await routeAuthenticatedUser();
    } catch (error) {
      if (hasAuthenticated) {
        await clearSessionQuietly();
      }

      if (
        error instanceof AuthServiceError &&
        error.reason === "invalid-credentials"
      ) {
        setNoticeKind("invalid_credentials");
        return;
      }

      setNoticeKind("safe_error");
    }
  });

  const noticeMessage =
    noticeKind === "email_required"
      ? t("auth.login.errors.facebookEmailRequired")
      : noticeKind === "oauth_failed"
        ? t("auth.login.errors.oauthFailed")
        : noticeKind === "invalid_credentials"
          ? t("auth.login.errors.invalidCredentials")
          : noticeKind === "oauth_start_failed"
            ? t("auth.login.errors.oauthStartFailed")
            : noticeKind === "safe_error"
              ? t("auth.errors.generic")
              : null;

  return (
    <form className="flex w-full flex-col gap-4" noValidate onSubmit={onSubmit}>
      {noticeMessage ? (
        <StatusMessage tone="error">{noticeMessage}</StatusMessage>
      ) : null}
      <TextField
        autoComplete="email"
        error={errors.email?.message}
        label={t("auth.fields.parentEmail")}
        type="email"
        {...register("email")}
      />
      <TextField
        autoComplete="current-password"
        error={errors.password?.message}
        label={t("auth.fields.password")}
        placeholder="••••••••••••"
        type="password"
        {...register("password")}
      />
      <Link href="/forgot-password" className="account-forgot">
        {t("auth.login.forgotPassword")}
      </Link>
      <Button
        disabled={
          !isHydrated ||
          authRuntime.status === "initializing" ||
          isSubmitting ||
          isCompletingCallback
        }
        isLoading={isSubmitting || isCompletingCallback}
        type="submit"
      >
        {isSubmitting || isCompletingCallback
          ? t("auth.login.submitting")
          : t("auth.login.submit")}
        {!isSubmitting && !isCompletingCallback ? (
          <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
        ) : null}
      </Button>
      <div className="account-providers grid gap-3">
        <div className="relative py-2">
          <div
            className="absolute inset-0 flex items-center"
            aria-hidden="true"
          >
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-white px-3 text-sm font-semibold text-muted">
              {t("auth.login.orContinueWith")}
            </span>
          </div>
        </div>
        <Button
          className="border border-border bg-white text-ink hover:bg-sky"
          disabled={
            !isHydrated ||
            authRuntime.status === "initializing" ||
            isSubmitting ||
            isCompletingCallback ||
            socialLoading !== null
          }
          isLoading={socialLoading === "google"}
          onClick={() => void handleSocialSignIn("google")}
          type="button"
          variant="quiet"
        >
          {socialLoading !== "google" ? <GoogleMark /> : null}
          {t("auth.login.continueWithGoogle")}
        </Button>
        <Button
          className="border border-border bg-white text-ink hover:bg-sky"
          disabled={
            !isHydrated ||
            authRuntime.status === "initializing" ||
            isSubmitting ||
            isCompletingCallback ||
            socialLoading !== null
          }
          isLoading={socialLoading === "facebook"}
          onClick={() => void handleSocialSignIn("facebook")}
          type="button"
          variant="quiet"
        >
          {socialLoading !== "facebook" ? <FacebookMark /> : null}
          {t("auth.login.continueWithFacebook")}
        </Button>
      </div>
      <ButtonLink href="/register" variant="quiet" className="account-signup">
        <span className="sm:hidden">{t("auth.login.signupMobile")}</span>
        <span className="hidden sm:inline">
          {t("auth.login.signupDesktop")}
        </span>
      </ButtonLink>
    </form>
  );
}
