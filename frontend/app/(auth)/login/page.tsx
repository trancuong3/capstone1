import type { Metadata } from "next";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { LoginScreen } from "@/components/auth/login-screen";
import { parseAuthScenario } from "@/lib/utils/auth-scenario";

export const metadata: Metadata = {
  title: "Đăng nhập",
};

interface LoginPageProps {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const scenario = parseAuthScenario((await searchParams).state);

  return (
    <AuthServiceProvider scenario={scenario}>
      <LoginScreen scenario={scenario} />
    </AuthServiceProvider>
  );
}
