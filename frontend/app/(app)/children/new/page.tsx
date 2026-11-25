import type { Metadata } from "next";

import { ChildProfileScreen } from "@/components/children/child-profile-screen";

export const metadata: Metadata = {
  title: "Tạo hồ sơ bé",
};

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
