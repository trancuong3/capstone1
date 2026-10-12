import type { Metadata } from "next";

import { AdminParentDetailScreen } from "@/components/admin/admin-parent-detail-screen";

export const metadata: Metadata = { title: "Chi tiết phụ huynh" };

export default async function Page({
  params,
}: {
  params: Promise<{ parentId: string }>;
}) {
  const { parentId } = await params;
  return <AdminParentDetailScreen parentId={parentId} />;
}
