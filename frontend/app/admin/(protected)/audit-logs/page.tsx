import type { Metadata } from "next";
import { AdminAuditScreen } from "@/components/admin/admin-audit-screen";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
export const metadata: Metadata = { title: "Nhật ký kiểm toán" };
export default function Page() {
  return (
    <AdminServicesProvider>
      <AdminAuditScreen />
    </AdminServicesProvider>
  );
}
