import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { Card } from "@/components/common/card";
import type { AuthMockScenario } from "@/types/auth";

interface LoginScreenProps {
  isAuthCallback?: boolean;
  scenario: AuthMockScenario;
  oauthError?: "email_required" | "oauth_failed" | null;
}

export function LoginScreen({
  isAuthCallback = false,
  oauthError = null,
  scenario,
}: LoginScreenProps) {
  if (scenario === "loading") {
    return <AuthLoadingState />;
  }

  return (
    <AuthShell>
      <Card className="mx-auto max-w-[560px] border border-border bg-white shadow-lg">
        <div>
          <p className="text-sm font-extrabold uppercase tracking-[0.12em] text-primary">
            Dành cho ba mẹ
          </p>
          <h1 className="mt-2 text-heading font-extrabold text-ink">
            Chào mừng trở lại
          </h1>
          <p className="mt-3 text-body leading-relaxed text-muted">
            Đăng nhập ViRead để cùng bé đọc sách và theo dõi hành trình tiến bộ
            mỗi ngày.
          </p>
        </div>
        <LoginForm
          isAuthCallback={isAuthCallback}
          oauthError={oauthError}
          scenario={scenario}
        />
      </Card>
    </AuthShell>
  );
}
