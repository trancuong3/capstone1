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
      <Card className="mx-auto max-w-[440px] border border-border bg-white">
        <div>
          <p className="text-sm font-semibold text-primary">DÀNH CHO BA MẸ</p>
          <h1 className="mt-1 text-heading font-extrabold leading-tight text-ink">
            Chào mừng trở lại
          </h1>
          <p className="mt-2 text-body leading-6 text-muted">
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
