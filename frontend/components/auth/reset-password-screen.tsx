"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import type { AuthMockScenario } from "@/types/auth";

interface ResetPasswordScreenProps {
  scenario: AuthMockScenario;
}

export function ResetPasswordScreen({ scenario }: ResetPasswordScreenProps) {
  const authRuntime = useAuthRuntime();
  const [isSuccessful, setIsSuccessful] = useState(scenario === "success");
  const [recoveryFailure, setRecoveryFailure] = useState<
    "invalid-token" | "expired-token" | null
  >(
    scenario === "invalid-token" || scenario === "expired-token"
      ? scenario
      : null,
  );

  if (scenario === "loading") {
    return <AuthLoadingState />;
  }

  if (
    authRuntime.mode === "supabase" &&
    authRuntime.status === "initializing"
  ) {
    return <AuthLoadingState />;
  }

  const runtimeRecoveryFailure =
    authRuntime.mode === "supabase" &&
    (authRuntime.status === "error" ||
      (authRuntime.status === "ready" && !authRuntime.isPasswordRecovery))
      ? authRuntime.initializationFailure === "expired-recovery-context"
        ? "expired-token"
        : "invalid-token"
      : null;
  const effectiveRecoveryFailure = recoveryFailure ?? runtimeRecoveryFailure;

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
          <ButtonLink
            href={
              authRuntime.mode === "mock" ? "/login?state=default" : "/login"
            }
          >
            Đăng nhập
            <ArrowRight aria-hidden="true" className="size-5" />
          </ButtonLink>
        </Card>
      </AuthShell>
    );
  }

  if (effectiveRecoveryFailure) {
    const isExpired = effectiveRecoveryFailure === "expired-token";

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
          <ButtonLink
            href={
              authRuntime.mode === "mock"
                ? "/forgot-password?state=default"
                : "/forgot-password"
            }
            variant="secondary"
          >
            Yêu cầu hướng dẫn mới
            <ArrowRight aria-hidden="true" className="size-5" />
          </ButtonLink>
          <ButtonLink
            href={
              authRuntime.mode === "mock" ? "/login?state=default" : "/login"
            }
            variant="quiet"
          >
            Về đăng nhập
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
          onRecoveryFailure={setRecoveryFailure}
          onSuccess={() => setIsSuccessful(true)}
          scenario={scenario}
        />
      </Card>
    </AuthShell>
  );
}
