import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";
import { AppStoreProvider } from "@/components/providers/app-store-provider";

export default function ParentAppLayout({ children }: { children: ReactNode }) {
  return (
    <AppStoreProvider>
      <AppShell>{children}</AppShell>
    </AppStoreProvider>
  );
}
