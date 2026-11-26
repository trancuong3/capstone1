import type { Metadata } from "next";

import { ParentProfileScreen } from "@/components/profile/parent-profile-screen";
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
      "parent.profile.pageTitle",
    ),
  };
}

export default function ProfilePage() {
  return <ParentProfileScreen />;
}
