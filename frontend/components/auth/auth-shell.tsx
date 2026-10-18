import type { ReactNode } from "react";

import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { SiteHeader } from "@/components/layout/site-header";

interface AuthShellProps {
  children: ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="flex min-h-dvh w-full flex-col overflow-x-hidden bg-canvas">
      <SiteHeader />
      <main className="flex w-full min-w-0 flex-1 flex-col items-center justify-center px-4 py-8 sm:px-8 sm:py-12">
        <div className="w-full max-w-[560px]">{children}</div>
      </main>
    </div>
  );
}

export function AuthLoadingState() {
  return (
    <AuthShell>
      <Card
        aria-busy="true"
        aria-label="Đang tải nội dung"
        className="mx-auto max-w-[560px] border border-border bg-white shadow-sm"
      >
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
