import { Card } from "@/components/common/card";
import { AuthLoadingState, AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
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
      <Card>
        <div>
          <h1 className="text-heading font-extrabold text-ink">Đăng nhập</h1>
          <p className="mt-4 text-body text-muted sm:mt-6">
            <span className="sm:hidden">
              Ba mẹ đăng nhập để cùng bé đọc sách.
            </span>
            <span className="hidden sm:inline">
              Bé không cần tài khoản riêng.
            </span>
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
