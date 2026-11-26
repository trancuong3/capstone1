"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import { isAdminAuthError } from "@/lib/api/admin-auth-service";
import { sanitizeNextPath } from "@/lib/auth/route-policy";
import type { AdminLoginRequest, AdminMockScenario } from "@/types/admin";

export function AdminLoginScreen({
  nextPath = null,
  scenario,
}: {
  nextPath?: string | null;
  scenario: AdminMockScenario;
}) {
  const { auth } = useAdminServices();
  const t = useTranslations("admin");
  const { refresh, replace } = useRouter();
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
    formState: { errors, isSubmitting },
  } = useForm<AdminLoginRequest>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });
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
    <div className="staff-login flex min-h-dvh w-full flex-col bg-canvas">
      <SiteHeader variant="admin-login" />
      <main className="grid w-full min-w-0 flex-1 place-items-center px-4 py-10">
        <Card className="max-w-[560px] gap-4 border border-border bg-white sm:px-8">
          <ShieldCheck aria-hidden className="size-14 text-primary" />
          <div>
            <p className="text-sm font-semibold text-primary">
              {t("login.areaLabel")}
            </p>
            <h1 className="mt-2 text-heading font-extrabold text-ink">
              {t("login.title")}
            </h1>
            <p className="mt-2 text-muted">{t("login.subtitle")}</p>
          </div>
          <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
            {noticeErrorKey ? (
              <StatusMessage tone="error">{t(noticeErrorKey)}</StatusMessage>
            ) : null}
            <TextField
              autoComplete="username"
              error={errors.email?.message}
              label={t("login.emailLabel")}
              type="email"
              {...register("email")}
            />
            <TextField
              autoComplete="current-password"
              error={errors.password?.message}
              label={t("login.passwordLabel")}
              type="password"
              {...register("password")}
            />
            <Button
              disabled={isSubmitting}
              isLoading={isSubmitting}
              type="submit"
            >
              {isSubmitting ? t("login.submitting") : t("login.submit")}
            </Button>
          </form>
          <p className="text-body text-muted">{t("login.adminOnlyHint")}</p>
        </Card>
      </main>
      <SiteFooter variant="admin" />
    </div>
  );
}
