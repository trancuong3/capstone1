"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LockKeyhole } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isAdminAuthError } from "@/lib/api/admin-auth-service";
import type { AdminLoginRequest, AdminMockScenario } from "@/types/admin";

const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Vui lòng nhập email.")
    .email("Email chưa đúng định dạng."),
  password: z.string().min(8, "Mật khẩu cần có ít nhất 8 ký tự."),
});

export function AdminLoginScreen({
  scenario,
}: {
  scenario: AdminMockScenario;
}) {
  const { auth } = useAdminServices();
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(
    scenario === "unauthenticated"
      ? "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
      : scenario === "forbidden"
        ? "Tài khoản này không có quyền truy cập khu vực quản trị."
        : null,
  );
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AdminLoginRequest>({
    resolver: zodResolver(schema),
    defaultValues: { email: "admin@example.com", password: "" },
  });
  const submit = handleSubmit(async (values) => {
    setNotice(null);
    try {
      await auth.signIn(values);
      router.push("/admin/books");
    } catch (error) {
      setNotice(
        isAdminAuthError(error) && error.reason === "forbidden"
          ? "Tài khoản này không có quyền truy cập khu vực quản trị."
          : isAdminAuthError(error) && error.reason === "invalid-credentials"
            ? "Thông tin đăng nhập chưa đúng. Vui lòng thử lại."
            : "Không thể đăng nhập lúc này. Vui lòng thử lại sau.",
      );
    }
  });
  return (
    <main className="grid min-h-dvh place-items-center bg-sky px-4 py-10">
      <Card className="max-w-[560px] bg-cream shadow-xl">
        <div className="mx-auto grid size-16 place-items-center rounded-full bg-primary text-white">
          <LockKeyhole aria-hidden className="size-8" />
        </div>
        <div className="text-center">
          <p className="font-extrabold text-primary">ReadAlong Vision</p>
          <h1 className="mt-2 text-heading font-black">Đăng nhập quản trị</h1>
          <p className="mt-2 text-muted">
            Quản lý sách, OCR và trạng thái vận hành.
          </p>
        </div>
        <form className="flex flex-col gap-5" noValidate onSubmit={submit}>
          {notice ? <StatusMessage tone="error">{notice}</StatusMessage> : null}
          <TextField
            autoComplete="username"
            error={errors.email?.message}
            label="Email quản trị"
            type="email"
            {...register("email")}
          />
          <TextField
            autoComplete="current-password"
            error={errors.password?.message}
            label="Mật khẩu"
            type="password"
            {...register("password")}
          />
          <Button
            disabled={isSubmitting}
            isLoading={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "Đang đăng nhập…" : "Đăng nhập"}
          </Button>
        </form>
        <p className="text-center text-sm text-muted">
          Bản trình diễn frontend sử dụng dịch vụ xác thực mock.
        </p>
      </Card>
    </main>
  );
}
