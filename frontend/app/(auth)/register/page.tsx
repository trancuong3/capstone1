import type { Metadata } from "next";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { RegisterScreen } from "@/components/auth/register-screen";
import { resolveAuthRuntime } from "@/lib/utils/auth-scenario";

export const metadata: Metadata = {
  title: "Đăng ký",
};

interface RegisterPageProps {
  searchParams: Promise<{ state?: string | string[] }>;
}

export default async function RegisterPage({
  searchParams,
}: RegisterPageProps) {
  const { mode, scenario } = resolveAuthRuntime((await searchParams).state);

  return (
    <AuthServiceProvider mode={mode} scenario={scenario}>
      <RegisterScreen scenario={scenario} />
    </AuthServiceProvider>
  );
}
