import type { Metadata } from "next";
import { AdminNewBookScreen } from "@/components/admin/admin-new-book-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
export const metadata: Metadata = { title: "Tạo sách mới" };
export default function Page() {
  return (
    <AdminServicesProvider>
      <AdminNewBookScreen />
    </AdminServicesProvider>
  );
}
