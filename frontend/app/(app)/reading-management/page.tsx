import type { Metadata } from "next";

import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";

export const metadata: Metadata = { title: "Quản lý đọc sách" };

interface PageProps {
  searchParams: Promise<{ childId?: string | string[] }>;
}

export default async function ReadingManagementPage({
  searchParams,
}: PageProps) {
  const query = await searchParams;
  const childId = Array.isArray(query.childId)
    ? query.childId[0]
    : query.childId;
  return <ReadingManagementScreen requestedChildId={childId} />;
}
