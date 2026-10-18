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
        className="mx-auto max-w-[560px] border border-border bg-white shadow-sm"
      >
        <span className="sr-only" role="status">
          Đang tải…
        </span>
        <Skeleton className="h-11 w-3/5" />
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-[90px] w-full sm:h-24" />
        <Skeleton className="h-[90px] w-full sm:h-24" />
        <Skeleton className="h-[90px] w-full sm:h-24" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
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
          className="mx-auto max-w-[560px] border border-border shadow-sm"
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
      <Card className="mx-auto max-w-[560px] border border-border bg-white shadow-lg">
        <div>
          <p className="text-sm font-extrabold uppercase tracking-[0.12em] text-primary">
            Bắt đầu cùng ViRead
          </p>
          <h1 className="mt-2 text-heading font-extrabold text-ink">
            Tạo tài khoản phụ huynh
          </h1>
          <p className="mt-3 text-body leading-relaxed text-muted">
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
