import type { Metadata } from "next";

import { HelpSupportScreen } from "@/components/support/help-support-screen";
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
      "parent.support.title",
    ),
  };
}

export default function HelpSupportPage() {
  return <HelpSupportScreen />;
}
