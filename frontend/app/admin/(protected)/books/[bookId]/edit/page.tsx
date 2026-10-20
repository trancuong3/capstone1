import type { Metadata } from "next";

import { AdminBookEditorScreen } from "@/components/admin/admin-book-editor-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";

export const metadata: Metadata = { title: "Chỉnh sửa metadata sách" };

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{ returnTo?: string; issue?: string }>;
}) {
  const { bookId } = await params;
  const query = await searchParams;
  return (
    <AdminServicesProvider>
      <AdminBookEditorScreen
        bookId={bookId}
        issue={query.issue}
        returnTo={query.returnTo === "metadata-quality" ? "metadata-quality" : "detail"}
      />
    </AdminServicesProvider>
  );
}
