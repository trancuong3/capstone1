import type { Metadata } from "next";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { RegisterScreen } from "@/components/auth/register-screen";
import { parseAuthScenario } from "@/lib/utils/auth-scenario";

export const metadata: Metadata = {
  title: "Đăng ký",
};

interface RegisterPageProps {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function RegisterPage({
  searchParams,
}: RegisterPageProps) {
  const scenario = parseAuthScenario((await searchParams).state);

  return (
    <AuthServiceProvider scenario={scenario}>
      <RegisterScreen scenario={scenario} />
    </AuthServiceProvider>
  );
}
