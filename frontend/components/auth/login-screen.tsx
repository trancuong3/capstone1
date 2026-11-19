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
      <Card className="border border-border bg-white">
        <div>
          <p className="text-sm font-semibold text-primary">
            Tài khoản phụ huynh
          </p>
          <h1 className="mt-1 text-heading font-extrabold leading-tight text-ink">
            Đăng nhập ViRead
          </h1>
          <p className="mt-2 text-body leading-6 text-muted">
            Mở tủ sách của bé và xem lại những buổi đọc gần đây.
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
