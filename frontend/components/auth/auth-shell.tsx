import type { ReactNode } from "react";

import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { SiteHeader } from "@/components/layout/site-header";
import { SiteFooter } from "@/components/layout/site-footer";
import { ButtonSizeProvider } from "@/components/common/button";

interface AuthShellProps {
  children: ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="flex min-h-dvh w-full flex-col overflow-x-hidden bg-canvas">
      <SiteHeader />
      <main className="flex w-full min-w-0 flex-1 items-center justify-center px-4 py-8 sm:min-h-[774px] sm:px-12 sm:py-12">
        <ButtonSizeProvider size="compact">
          <div className="w-full max-w-[560px] [&_h1]:text-[32px] [&>div]:gap-4 [&>div]:max-w-none [&>div]:shadow-none [&>div]:sm:px-8">
            {children}
          </div>
        </ButtonSizeProvider>
      </main>
      <SiteFooter variant="public" />
    </div>
  );
}

export function AuthLoadingState() {
  return (
    <AuthShell>
      <Card
        aria-busy="true"
        aria-label="Đang tải nội dung"
        className="mx-auto max-w-[440px] border border-border bg-white"
      >
        <span className="sr-only" role="status">
          Đang tải…
        </span>
        <Skeleton className="h-11 w-3/5" />
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </Card>
    </AuthShell>
  );
}
