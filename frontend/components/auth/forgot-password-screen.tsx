"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthService } from "@/hooks/use-auth-service";
import type { AuthMockScenario } from "@/types/auth";

interface ForgotPasswordScreenProps {
  scenario: AuthMockScenario;
}

export function ForgotPasswordScreen({ scenario }: ForgotPasswordScreenProps) {
  const authService = useAuthService();
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(
    scenario === "submitted" ? "minhanh@example.com" : null,
  );
  const [resendState, setResendState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");

  if (scenario === "loading") {
    return <AuthLoadingState />;
  }

  async function handleResend() {
    if (!submittedEmail || resendState === "loading") {
      return;
    }

    setResendState("loading");

    try {
      await authService.requestPasswordReset({ email: submittedEmail });
      setResendState("success");
    } catch {
      setResendState("error");
    }
  }

  if (submittedEmail) {
    return (
      <AuthShell>
        <Card className="mx-auto max-w-[560px] border border-border bg-white shadow-lg">
          <div>
            <p className="text-sm font-extrabold uppercase tracking-[0.12em] text-primary">
              Bảo mật tài khoản ViRead
            </p>
            <h1 className="mt-2 text-heading font-extrabold text-ink">
              {resendState === "success"
                ? "Đã yêu cầu gửi lại"
                : "Kiểm tra email nhé"}
            </h1>
            <p className="mt-3 text-body leading-relaxed text-muted">
              Nếu email này đã được đăng ký, ba mẹ sẽ nhận được hướng dẫn đặt
              lại mật khẩu. Hãy kiểm tra cả thư rác.
            </p>
          </div>
          {resendState === "error" ? (
            <StatusMessage tone="error">
              Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
            </StatusMessage>
          ) : null}
          <ButtonLink href="/login">
            Về đăng nhập
            <ArrowRight aria-hidden="true" className="size-5" />
          </ButtonLink>
          <Button
            disabled={resendState === "loading"}
            isLoading={resendState === "loading"}
            onClick={handleResend}
            variant="secondary"
          >
            {resendState === "loading" ? "Đang gửi lại…" : "Gửi lại hướng dẫn"}
          </Button>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Card className="mx-auto max-w-[560px] border border-border bg-white shadow-lg">
        <div>
          <p className="text-sm font-extrabold uppercase tracking-[0.12em] text-primary">
            Bảo mật tài khoản ViRead
          </p>
          <h1 className="mt-2 text-heading font-extrabold text-ink">
            Khôi phục mật khẩu
          </h1>
          <p className="mt-3 text-body leading-relaxed text-muted">
            Nhập email của ba mẹ để nhận hướng dẫn đặt lại mật khẩu.
          </p>
        </div>
        <ForgotPasswordForm
          hasInitialError={scenario === "safe-error"}
          onSubmitted={setSubmittedEmail}
        />
      </Card>
    </AuthShell>
  );
}
