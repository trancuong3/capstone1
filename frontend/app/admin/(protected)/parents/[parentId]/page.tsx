import type { Metadata } from "next";

import { AdminParentDetailScreen } from "@/components/admin/admin-parent-detail-screen";

export const metadata: Metadata = { title: "Chi tiết phụ huynh" };

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ parentId: string }>;
  searchParams: Promise<{ include_hidden?: string }>;
}) {
  const [{ parentId }, query] = await Promise.all([params, searchParams]);
  return (
    <AdminParentDetailScreen
      parentId={parentId}
      includeHidden={query.include_hidden === "true"}
    />
  );
}
