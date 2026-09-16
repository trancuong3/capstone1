"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthService } from "@/hooks/use-auth-service";
import { useHydrated } from "@/hooks/use-hydrated";
import { AuthServiceError } from "@/lib/api/auth-service";
import type { AuthMockScenario, LoginRequest } from "@/types/auth";

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Ba mẹ vui lòng nhập email.")
    .email("Email chưa đúng định dạng."),
  password: z.string().min(8, "Mật khẩu cần có ít nhất 8 ký tự."),
});

interface LoginFormProps {
  scenario: AuthMockScenario;
}

type Notice = { tone: "error"; message: string } | null;

export function LoginForm({ scenario }: LoginFormProps) {
  const authService = useAuthService();
  const isHydrated = useHydrated();
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>(() => {
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
      email: "minhanh@example.com",
      password: "",
    },
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = handleSubmit(async (values) => {
    setNotice(null);

    try {
      await authService.signIn(values);
      router.push("/dashboard");
    } catch (error) {
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
        disabled={!isHydrated || isSubmitting}
        isLoading={isSubmitting}
        type="submit"
      >
        {isSubmitting ? "Đang đăng nhập…" : "Đăng nhập"}
        {!isSubmitting ? (
          <ArrowRight aria-hidden="true" className="size-5" />
        ) : null}
      </Button>
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
