"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useAuthService } from "@/hooks/use-auth-service";
import { useHydrated } from "@/hooks/use-hydrated";
import { AuthServiceError } from "@/lib/api/auth-service";
import type { AuthMockScenario, LoginRequest } from "@/types/auth";
import type { OAuthProvider } from "@/lib/api/auth-service";

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Ba mẹ vui lòng nhập email.")
    .email("Email chưa đúng định dạng."),
  password: z.string().min(8, "Mật khẩu cần có ít nhất 8 ký tự."),
});

interface LoginFormProps {
  isAuthCallback?: boolean;
  scenario: AuthMockScenario;
  oauthError?: "email_required" | "oauth_failed" | null;
}

type Notice = { tone: "error"; message: string } | null;

function GoogleMark() {
  return (
    <svg aria-hidden="true" className="size-5 shrink-0" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.91c-.58 2.96-2.26 5.48-4.74 7.18l7.73 6C44.4 37.96 46.98 31.9 46.98 24.55Z" />
      <path fill="#FBBC05" d="M10.53 28.59A14.45 14.45 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.52 2.56 10.78l7.97-6.19Z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.8l-7.73-6c-2.14 1.44-4.89 2.3-8.17 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" />
    </svg>
  );
}

function FacebookMark() {
  return (
    <svg aria-hidden="true" className="size-5 shrink-0" viewBox="0 0 24 24">
      <path fill="#1877F2" d="M24 12a12 12 0 1 0-13.875 11.85v-8.38H7.08V12h3.045V9.35c0-3 1.79-4.66 4.52-4.66 1.31 0 2.68.235 2.68.235v2.95h-1.51c-1.49 0-1.955.925-1.955 1.875V12h3.33l-.532 3.47H13.86v8.38A12 12 0 0 0 24 12Z" />
    </svg>
  );
}

export function LoginForm({
  isAuthCallback = false,
  oauthError = null,
  scenario,
}: LoginFormProps) {
  const authService = useAuthService();
  const authRuntime = useAuthRuntime();
  const isHydrated = useHydrated();
  const { refresh, replace } = useRouter();
  const [socialLoading, setSocialLoading] = useState<OAuthProvider | null>(null);
  const [notice, setNotice] = useState<Notice>(() => {
    if (oauthError === "email_required") {
      return {
        tone: "error",
        message:
          "Facebook không cung cấp email cho tài khoản này. Hãy cấp quyền email trong Facebook hoặc đăng nhập bằng Google/email và mật khẩu.",
      };
    }

    if (oauthError === "oauth_failed") {
      return {
        tone: "error",
        message:
          "Không thể hoàn tất đăng nhập xã hội. Nếu dùng Facebook, hãy kiểm tra quyền email của ứng dụng Facebook rồi thử lại.",
      };
    }

    if (scenario === "invalid-credentials") {
      return {
        tone: "error",
        message: "Email hoặc mật khẩu chưa đúng. Ba mẹ thử lại nhé.",
      };
    }

    if (scenario === "safe-error") {
      return {
        tone: "error",
        message: "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
      };
    }

    return null;
  });
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
    notice === null &&
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

    replace(role === "admin" ? "/admin/books" : "/dashboard");
    refresh();
  }, [authService, refresh, replace]);

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
        setNotice({
          tone: "error",
          message: "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
        });
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
    setNotice(null);
    setSocialLoading(provider);

    try {
      await authService.signInWithOAuth(provider);
      setSocialLoading(null);
    } catch {
      setSocialLoading(null);
      setNotice({
        tone: "error",
        message:
          "Không thể bắt đầu đăng nhập xã hội. Ba mẹ vui lòng kiểm tra cấu hình hoặc thử lại sau.",
      });
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    setNotice(null);
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
        setNotice({
          tone: "error",
          message: "Email hoặc mật khẩu chưa đúng. Ba mẹ thử lại nhé.",
        });
        return;
      }

      setNotice({
        tone: "error",
        message: "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
      });
    }
  });

  return (
    <form
      className="flex w-full flex-col gap-4 sm:gap-6"
      noValidate
      onSubmit={onSubmit}
    >
      {notice ? (
        <StatusMessage tone={notice.tone}>{notice.message}</StatusMessage>
      ) : null}
      <TextField
        autoComplete="email"
        error={errors.email?.message}
        label="Email của ba mẹ"
        type="email"
        {...register("email")}
      />
      <TextField
        autoComplete="current-password"
        error={errors.password?.message}
        label="Mật khẩu"
        placeholder="••••••••••••"
        type="password"
        {...register("password")}
      />
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
        {isSubmitting || isCompletingCallback ? "Đang đăng nhập…" : "Đăng nhập"}
        {!isSubmitting && !isCompletingCallback ? (
          <ArrowRight aria-hidden="true" className="size-5" />
        ) : null}
      </Button>
      <div className="flex flex-col gap-3">
        <div className="relative py-2">
          <div className="absolute inset-0 flex items-center" aria-hidden="true">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-white px-3 text-sm font-semibold text-muted">
              Hoặc tiếp tục với
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
          Tiếp tục với Google
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
          Tiếp tục với Facebook
        </Button>
      </div>
      <ButtonLink href="/forgot-password" variant="quiet">
        Quên mật khẩu?
      </ButtonLink>
      <ButtonLink href="/register" variant="secondary">
        <span className="sm:hidden">Đăng ký tài khoản</span>
        <span className="hidden sm:inline">Chưa có tài khoản? Đăng ký</span>
      </ButtonLink>
    </form>
  );
}
