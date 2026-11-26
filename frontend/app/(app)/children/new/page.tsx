import type { Metadata } from "next";

import { ChildProfileScreen } from "@/components/children/child-profile-screen";
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
      "parent.children.createPageTitle",
    ),
  };
}

interface NewChildPageProps {
  searchParams: Promise<{
    from?: string | string[];
  }>;
}

export default async function NewChildPage({
  searchParams,
}: NewChildPageProps) {
  const query = await searchParams;

  const from = Array.isArray(query.from) ? query.from[0] : query.from;

  return (
    <ChildProfileScreen fromRegistration={from === "register"} mode="create" />
  );
}
