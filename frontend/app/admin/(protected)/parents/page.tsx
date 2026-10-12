import type { Metadata } from "next";
import { AdminParentsScreen } from "@/components/admin/admin-parents-screen";

export const metadata: Metadata = { title: "Danh sách phụ huynh" };

export default function Page() {
  return <AdminParentsScreen />;
}
