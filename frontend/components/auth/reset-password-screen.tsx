"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import type { AuthMockScenario } from "@/types/auth";

interface ResetPasswordScreenProps {
  scenario: AuthMockScenario;
}

export function ResetPasswordScreen({ scenario }: ResetPasswordScreenProps) {
  const [isSuccessful, setIsSuccessful] = useState(scenario === "success");

  if (scenario === "loading") {
    return <AuthLoadingState />;
  }

  if (scenario === "invalid-token" || scenario === "expired-token") {
    const isExpired = scenario === "expired-token";

    return (
      <AuthShell>
        <Card>
          <div>
            <h1 className="text-heading font-extrabold text-ink">
              {isExpired ? "Liên kết đã hết hạn" : "Liên kết không hợp lệ"}
            </h1>
            <p className="mt-4 text-body text-muted sm:mt-6">
              {isExpired
                ? "Ba mẹ hãy yêu cầu một hướng dẫn đặt lại mật khẩu mới."
                : "Ba mẹ vui lòng kiểm tra lại email hoặc yêu cầu một liên kết mới."}
            </p>
          </div>
          <StatusMessage tone="warning">
            Liên kết khôi phục không thể được sử dụng để đổi mật khẩu.
          </StatusMessage>
          <ButtonLink href="/forgot-password" variant="secondary">
            Yêu cầu hướng dẫn mới
            <ArrowRight aria-hidden="true" className="size-5" />
          </ButtonLink>
          <ButtonLink href="/login" variant="quiet">
            Về đăng nhập
          </ButtonLink>
        </Card>
      </AuthShell>
    );
  }

  if (isSuccessful) {
    return (
      <AuthShell>
        <Card tone="success">
          <div>
            <h1 className="text-heading font-extrabold text-success-ink">
              Đã đổi mật khẩu
            </h1>
            <p className="mt-4 text-body text-muted sm:mt-6">
              Mật khẩu mới đã được lưu. Ba mẹ đăng nhập để tiếp tục cùng bé đọc
              sách.
            </p>
          </div>
          <ButtonLink href="/login">
            Đăng nhập
            <ArrowRight aria-hidden="true" className="size-5" />
          </ButtonLink>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Card>
        <div>
          <h1 className="text-heading font-extrabold text-ink">
            Đặt mật khẩu mới
          </h1>
          <p className="mt-4 text-body text-muted sm:mt-6">
            Dùng ít nhất 8 ký tự. Nhập lại mật khẩu mới để xác nhận.
          </p>
        </div>
        <ResetPasswordForm
          onSuccess={() => setIsSuccessful(true)}
          scenario={scenario}
        />
      </Card>
    </AuthShell>
  );
}
