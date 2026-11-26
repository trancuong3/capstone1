import type { Metadata } from "next";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { ForgotPasswordScreen } from "@/components/auth/forgot-password-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { resolveAuthRuntime } from "@/lib/utils/auth-scenario";
import { viMessages } from "@/messages/vi";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "auth.forgotPassword.title",
    ),
  };
}

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
