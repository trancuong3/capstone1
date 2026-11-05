import type { Metadata } from "next";

import { ChildProfileScreen } from "@/components/children/child-profile-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

export const metadata: Metadata = {
  title: "Chi tiết hồ sơ bé",
};

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
  const [{ childId }, query] = await Promise.all([
    params,
    searchParams,
  ]);

  const created = Array.isArray(query.created)
    ? query.created[0]
    : query.created;
  const avatarError = Array.isArray(query.avatarError)
    ? query.avatarError[0]
    : query.avatarError;

  return (
    <AppServicesProvider>
      <ChildProfileScreen
        childId={childId}
        hasAvatarError={avatarError === "1"}
        hasCreatedNotice={created === "1"}
        mode="edit"
      />
    </AppServicesProvider>
  );
}
