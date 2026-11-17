"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { AuthShell } from "@/components/auth/auth-shell";
import { RegisterForm } from "@/components/auth/register-form";
import { ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import type { AuthMockScenario } from "@/types/auth";

interface RegisterScreenProps {
  scenario: AuthMockScenario;
}

function RegisterLoadingState() {
  return (
    <AuthShell>
      <Card
        aria-busy="true"
        aria-label="Đang tải nội dung đăng ký"
        className="mx-auto max-w-[440px] border border-border bg-white"
      >
        <span className="sr-only" role="status">
          Đang tải…
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
  const [requiresEmailConfirmation, setRequiresEmailConfirmation] =
    useState(false);

  if (scenario === "loading") {
    return <RegisterLoadingState />;
  }

  if (requiresEmailConfirmation) {
    return (
      <AuthShell>
        <Card
          className="mx-auto max-w-[440px] border border-border"
          tone="success"
        >
          <div>
            <h1 className="text-heading font-extrabold text-success-ink">
              Kiểm tra email nhé
            </h1>
            <p className="mt-4 text-body leading-relaxed text-muted">
              Nếu yêu cầu đăng ký hợp lệ, ba mẹ sẽ nhận được liên kết xác nhận.
              Hãy kiểm tra cả thư rác trước khi đăng nhập.
            </p>
          </div>
          <StatusMessage tone="success">
            Vì lý do bảo mật, thông báo này không xác nhận một email đã có tài
            khoản hay chưa.
          </StatusMessage>
          <ButtonLink href="/login">
            Về đăng nhập
            <ArrowRight aria-hidden="true" className="size-5" />
          </ButtonLink>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Card className="mx-auto max-w-[440px] border border-border bg-white">
        <div>
          <p className="text-sm font-semibold text-primary">
            BẮT ĐẦU CÙNG VIREAD
          </p>
          <h1 className="mt-1 text-heading font-extrabold leading-tight text-ink">
            Tạo tài khoản phụ huynh
          </h1>
          <p className="mt-2 text-body leading-6 text-muted">
            Tạo tài khoản để quản lý hồ sơ bé và theo dõi quá trình đọc sách.
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
