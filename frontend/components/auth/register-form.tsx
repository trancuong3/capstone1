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
import type { AuthMockScenario, ParentRegistrationInput } from "@/types/auth";

const registerSchema = z.object({
  displayName: z.string().trim().min(1, "Ba mẹ vui lòng nhập họ và tên."),
  email: z
    .string()
    .trim()
    .min(1, "Ba mẹ vui lòng nhập email.")
    .email("Email chưa đúng định dạng."),
  password: z.string().min(8, "Mật khẩu cần có ít nhất 8 ký tự."),
});

const safeRegistrationError =
  "Chưa thể tạo tài khoản lúc này. Ba mẹ vui lòng thử lại sau.";
const registrationValidationError =
  "Thông tin đăng ký chưa hợp lệ. Ba mẹ vui lòng kiểm tra và thử lại.";

interface RegisterFormProps {
  scenario: AuthMockScenario;
}

export function RegisterForm({ scenario }: RegisterFormProps) {
  const authService = useAuthService();
  const isHydrated = useHydrated();
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(() => {
    if (scenario === "validation-error") {
      return registrationValidationError;
    }

    if (scenario === "email-used" || scenario === "safe-error") {
      return safeRegistrationError;
    }

    return null;
  });
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<ParentRegistrationInput>({
    defaultValues: {
      displayName: "",
      email: "",
      password: "",
    },
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = handleSubmit(async (values) => {
    setErrorMessage(null);

    try {
      await authService.registerParent(values);
      router.push("/children/new?from=register");
    } catch (error) {
      if (
        error instanceof AuthServiceError &&
        error.reason === "registration-validation"
      ) {
        setErrorMessage(registrationValidationError);
        return;
      }

      setErrorMessage(safeRegistrationError);
    }
  });

  return (
    <form
      className="flex w-full flex-col gap-4 sm:gap-6"
      noValidate
      onSubmit={onSubmit}
    >
      {errorMessage ? (
        <StatusMessage tone="error">{errorMessage}</StatusMessage>
      ) : null}
      <TextField
        autoComplete="name"
        error={errors.displayName?.message}
        label="Họ và tên ba mẹ"
        placeholder="Nguyễn Minh Anh"
        {...register("displayName")}
      />
      <TextField
        autoComplete="email"
        error={errors.email?.message}
        label="Email của ba mẹ"
        placeholder="minhanh@example.com"
        type="email"
        {...register("email")}
      />
      <TextField
        autoComplete="new-password"
        error={errors.password?.message}
        label="Mật khẩu"
        placeholder="Tối thiểu 8 ký tự"
        type="password"
        {...register("password")}
      />
      <Button
        disabled={!isHydrated || isSubmitting}
        isLoading={isSubmitting}
        type="submit"
      >
        {isSubmitting ? "Đang tạo tài khoản…" : "Tạo tài khoản"}
        {!isSubmitting ? (
          <ArrowRight aria-hidden="true" className="size-5" />
        ) : null}
      </Button>
      <ButtonLink href="/login" variant="secondary">
        Đã có tài khoản? Đăng nhập
      </ButtonLink>
    </form>
  );
}
