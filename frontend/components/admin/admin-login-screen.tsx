"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isAdminAuthError } from "@/lib/api/admin-auth-service";
import { sanitizeNextPath } from "@/lib/auth/route-policy";
import { cn } from "@/lib/utils/cn";
import type { AdminLoginRequest, AdminMockScenario } from "@/types/admin";

export function AdminLoginScreen({
  nextPath = null,
  scenario,
}: {
  nextPath?: string | null;
  scenario: AdminMockScenario;
}) {
  const { auth } = useAdminServices();
  const { locale } = useI18n();
  const t = useTranslations("admin");
  const tAuth = useTranslations("auth");
  const [showPassword, setShowPassword] = useState(false);
  const { refresh, replace } = useRouter();
  const emailId = useId();
  const passwordId = useId();

  const schema = useMemo(
    () =>
      z.object({
        email: z
          .string()
          .trim()
          .min(1, t("login.validation.emailRequired"))
          .email(t("login.validation.emailInvalid")),
        password: z.string().min(8, t("login.validation.passwordMin")),
      }),
    [t],
  );
  const [noticeErrorKey, setNoticeErrorKey] = useState<string | null>(
    scenario === "unauthenticated"
      ? "login.errors.sessionExpired"
      : scenario === "forbidden"
        ? "login.errors.forbidden"
        : null,
  );
  const {
    register,
    handleSubmit,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<AdminLoginRequest>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
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
      keyof AdminLoginRequest
    >;
    if (activeFields.length > 0) {
      void trigger(activeFields);
    }
  }, [locale, trigger]);

  const submit = handleSubmit(async (values) => {
    setNoticeErrorKey(null);
    try {
      await auth.signIn(values);
      replace(sanitizeNextPath(nextPath, "admin"));
      refresh();
    } catch (error) {
      setNoticeErrorKey(
        isAdminAuthError(error) && error.reason === "forbidden"
          ? "login.errors.forbidden"
          : isAdminAuthError(error) && error.reason === "invalid-credentials"
            ? "login.errors.invalidCredentials"
            : "login.errors.generic",
      );
    }
  });

  return (
    <div
      className="flex min-h-dvh w-full flex-col bg-admin-canvas"
      data-admin-workspace="true"
    >
      <SiteHeader variant="admin-login" />
      <main className="grid w-full min-w-0 flex-1 place-items-center px-4 py-8 sm:py-12">
        <Card className="w-full max-w-[440px] gap-5 rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
          <div className="flex items-start gap-3.5">
            <span
              aria-hidden="true"
              className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-sky text-primary"
            >
              <ShieldCheck className="size-6" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wider text-primary">
                {t("login.areaLabel")}
              </p>
              <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight text-ink">
                {t("login.title")}
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {t("login.subtitle")}
              </p>
            </div>
          </div>

          <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
            {noticeErrorKey ? (
              <StatusMessage tone="error">{t(noticeErrorKey)}</StatusMessage>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-bold text-ink" htmlFor={emailId}>
                {t("login.emailLabel")}
              </label>
              <input
                aria-describedby={
                  errors.email?.message ? `${emailId}-error` : undefined
                }
                aria-invalid={Boolean(errors.email)}
                autoComplete="username"
                className={cn(
                  "h-11 w-full rounded-control border bg-white px-3.5 text-sm text-ink outline-none placeholder:text-muted/70 transition-colors focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted",
                  errors.email ? "border-danger" : "border-border",
                )}
                id={emailId}
                type="email"
                {...register("email")}
              />
              {errors.email?.message ? (
                <p
                  className="text-xs font-semibold text-danger"
                  id={`${emailId}-error`}
                >
                  {errors.email.message}
                </p>
              ) : null}
            </div>

            <div className="relative flex flex-col gap-1.5">
              <label
                className="text-xs font-bold text-ink"
                htmlFor={passwordId}
              >
                {t("login.passwordLabel")}
              </label>
              <input
                aria-describedby={
                  errors.password?.message ? `${passwordId}-error` : undefined
                }
                aria-invalid={Boolean(errors.password)}
                autoComplete="current-password"
                className={cn(
                  "h-11 w-full rounded-control border bg-white px-3.5 text-sm text-ink outline-none placeholder:text-muted/70 transition-colors focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted",
                  errors.password ? "border-danger" : "border-border",
                  "pe-12",
                )}
                id={passwordId}
                type={showPassword ? "text" : "password"}
                {...register("password")}
              />
              <button
                aria-label={
                  showPassword
                    ? tAuth("passwordToggle.hide")
                    : tAuth("passwordToggle.show")
                }
                aria-pressed={showPassword}
                className="absolute end-2 top-7 inline-flex size-9 items-center justify-center rounded-control text-muted hover:bg-canvas hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"
                onClick={() => setShowPassword((prev) => !prev)}
                type="button"
              >
                {showPassword ? (
                  <EyeOff aria-hidden className="size-5" />
                ) : (
                  <Eye aria-hidden className="size-5" />
                )}
              </button>
              {errors.password?.message ? (
                <p
                  className="text-xs font-semibold text-danger"
                  id={`${passwordId}-error`}
                >
                  {errors.password.message}
                </p>
              ) : null}
            </div>

            <Button
              disabled={isSubmitting}
              fullWidth
              isLoading={isSubmitting}
              size="compact"
              type="submit"
            >
              {isSubmitting ? t("login.submitting") : t("login.submit")}
            </Button>
          </form>

          <p className="rounded-control border border-border/80 bg-surface-subtle px-3.5 py-2.5 text-xs leading-relaxed text-muted">
            {t("login.adminOnlyHint")}
          </p>
        </Card>
      </main>
      <SiteFooter variant="admin-login" />
    </div>
  );
}
