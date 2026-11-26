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
      "parent.children.detailPageTitle",
    ),
  };
}

interface ChildDetailsPageProps {
  params: Promise<{
    childId: string;
  }>;
  searchParams: Promise<{
    created?: string | string[];
    avatarError?: string | string[];
  }>;
}

export default async function ChildDetailsPage({
  params,
  searchParams,
}: ChildDetailsPageProps) {
  const [{ childId }, query] = await Promise.all([params, searchParams]);

  const created = Array.isArray(query.created)
    ? query.created[0]
    : query.created;
  const avatarError = Array.isArray(query.avatarError)
    ? query.avatarError[0]
    : query.avatarError;

  return (
    <ChildProfileScreen
      childId={childId}
      hasAvatarError={avatarError === "1"}
      hasCreatedNotice={created === "1"}
      mode="edit"
    />
  );
}
