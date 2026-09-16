import type { Metadata } from "next";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { ResetPasswordScreen } from "@/components/auth/reset-password-screen";
import { parseAuthScenario } from "@/lib/utils/auth-scenario";

export const metadata: Metadata = {
  title: "Đặt lại mật khẩu",
};

interface ResetPasswordPageProps {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const scenario = parseAuthScenario((await searchParams).state);

  return (
    <AuthServiceProvider scenario={scenario}>
      <ResetPasswordScreen scenario={scenario} />
    </AuthServiceProvider>
  );
}
