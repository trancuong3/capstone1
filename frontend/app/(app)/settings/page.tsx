import type { Metadata } from "next";

import { AccountSettingsScreen } from "@/components/settings/account-settings-screen";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "settings.account.title",
    ),
  };
}

export default function SettingsPage() {
  return <AccountSettingsScreen />;
}
