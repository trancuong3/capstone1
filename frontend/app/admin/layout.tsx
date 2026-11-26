import type { ReactNode } from "react";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AdminServicesProvider>
      <AiTaskCenterProvider
        actorRole="admin"
        autoSyncOnMount={false}
        resolveSessionActor
      >
        {children}
      </AiTaskCenterProvider>
    </AdminServicesProvider>
  );
}
