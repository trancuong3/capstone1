import type { Metadata } from "next";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { ForgotPasswordScreen } from "@/components/auth/forgot-password-screen";
import { resolveAuthRuntime } from "@/lib/utils/auth-scenario";

export const metadata: Metadata = {
  title: "Quên mật khẩu",
};

interface ForgotPasswordPageProps {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function ForgotPasswordPage({
  searchParams,
}: ForgotPasswordPageProps) {
  const { mode, scenario } = resolveAuthRuntime((await searchParams).state);

  return (
    <AuthServiceProvider mode={mode} scenario={scenario}>
      <ForgotPasswordScreen scenario={scenario} />
    </AuthServiceProvider>
  );
}
