import type { Metadata } from "next";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
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
      "entertainment.hub.title",
    ),
    description: translateMessage(
      messages,
      viMessages,
      locale,
      "entertainment.hub.subtitle",
    ),
  };
}

export default function EntertainmentPage() {
  return <EntertainmentScreen />;
}
