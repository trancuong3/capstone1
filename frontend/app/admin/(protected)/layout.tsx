import type { ReactNode } from "react";

import { AdminLayout } from "@/components/admin/admin-layout";
import { requireAppRole } from "@/lib/auth/server-authorization";

export default async function ProtectedAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireAppRole("admin");

  return <AdminLayout>{children}</AdminLayout>;
}
