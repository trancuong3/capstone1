import type { ReactNode } from "react";

import { BrandHeader } from "@/components/common/brand-header";
import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";

interface AuthShellProps {
  children: ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    <main className="flex min-h-dvh w-full flex-col items-center gap-4 overflow-x-hidden bg-canvas p-4 sm:gap-6 sm:p-8">
      <BrandHeader />
      <div className="w-full max-w-[640px]">{children}</div>
    </main>
  );
}

export function AuthLoadingState() {
  return (
    <AuthShell>
      <Card aria-busy="true" aria-label="Đang tải nội dung">
        <span className="sr-only" role="status">
          Đang tải…
        </span>
        <Skeleton className="h-11 w-3/5" />
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-[90px] w-full sm:h-24" />
        <Skeleton className="h-[90px] w-full sm:h-24" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </Card>
    </AuthShell>
  );
}
