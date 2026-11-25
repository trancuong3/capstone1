import type { ReactNode } from "react";

import { AdminLayout } from "@/components/admin/admin-layout";
import { requireAppRole } from "@/lib/auth/server-authorization";

// Admin routes require runtime auth — never statically pre-render
export const dynamic = "force-dynamic";

export default async function ProtectedAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireAppRole("admin");

  return <AdminLayout>{children}</AdminLayout>;
}
