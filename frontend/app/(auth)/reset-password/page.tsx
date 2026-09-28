import type { Metadata } from "next";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { ResetPasswordScreen } from "@/components/auth/reset-password-screen";
import { resolveAuthRuntime } from "@/lib/utils/auth-scenario";

export const metadata: Metadata = {
  title: "Đặt lại mật khẩu",
};

interface ResetPasswordPageProps {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const { mode, scenario } = resolveAuthRuntime((await searchParams).state);

  return (
    <AuthServiceProvider mode={mode} scenario={scenario}>
      <ResetPasswordScreen scenario={scenario} />
    </AuthServiceProvider>
  );
}
