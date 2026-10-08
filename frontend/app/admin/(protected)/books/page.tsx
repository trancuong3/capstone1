import type { Metadata } from "next";
import { AdminBooksScreen } from "@/components/admin/admin-books-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
export const metadata: Metadata = { title: "Kho sách quản trị" };
export default function Page() {
  return (
    <AdminServicesProvider>
      <AdminBooksScreen />
    </AdminServicesProvider>
  );
}
