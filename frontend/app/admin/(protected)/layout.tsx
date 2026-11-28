import type { ReactNode } from "react";

import { AdminLayout } from "@/components/admin/admin-layout";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { requireAppRole } from "@/lib/auth/server-authorization";

// Admin routes require runtime auth — never statically pre-render
export const dynamic = "force-dynamic";

export default async function ProtectedAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const identity = await requireAppRole("admin");

  return (
    <AiTaskCenterProvider
      actorId={identity.id}
      actorRole="admin"
      autoSyncOnMount
    >
      <AdminLayout>{children}</AdminLayout>
    </AiTaskCenterProvider>
  );
}
