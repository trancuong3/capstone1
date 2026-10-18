import type { Metadata } from "next";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { LoginScreen } from "@/components/auth/login-screen";
import { resolveAuthRuntime } from "@/lib/utils/auth-scenario";

export const metadata: Metadata = {
  title: "Đăng nhập",
};

interface LoginPageProps {
  searchParams: Promise<{
    auth_callback?: string | string[];
    state?: string | string[];
    oauth_error?: string | string[];
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const { mode, scenario } = resolveAuthRuntime(params.state);
  const authCallback = Array.isArray(params.auth_callback)
    ? params.auth_callback[0]
    : params.auth_callback;
  const oauthErrorValue = Array.isArray(params.oauth_error)
    ? params.oauth_error[0]
    : params.oauth_error;
  const oauthError =
    oauthErrorValue === "email_required" || oauthErrorValue === "oauth_failed"
      ? oauthErrorValue
      : null;

  return (
    <AuthServiceProvider mode={mode} scenario={scenario}>
      <LoginScreen
        isAuthCallback={authCallback === "signup"}
        oauthError={oauthError}
        scenario={scenario}
      />
    </AuthServiceProvider>
  );
}
