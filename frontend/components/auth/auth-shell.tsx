import Image from "next/image";
import type { ReactNode } from "react";

import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { SiteHeader } from "@/components/layout/site-header";
import { SiteFooter } from "@/components/layout/site-footer";
import { ButtonSizeProvider } from "@/components/common/button";

interface AuthShellProps {
  activeRoute?: "login" | "register";
  children: ReactNode;
}

export function AuthShell({ activeRoute, children }: AuthShellProps) {
  return (
    <div className="account-spread flex min-h-dvh w-full flex-col overflow-x-hidden bg-canvas">
      <SiteHeader activeRoute={activeRoute} />
      <main className="flex w-full min-w-0 flex-1 items-center justify-center px-4 py-8 sm:min-h-[640px] sm:px-12 sm:py-12">
        <ButtonSizeProvider size="compact">
          <div className="account-spread-inner grid w-full max-w-[560px] lg:max-w-[1088px] items-stretch overflow-hidden rounded-card border border-border bg-white lg:grid-cols-[1.1fr_1fr]">
            <div
              aria-hidden="true"
              className="relative hidden overflow-hidden bg-cream lg:block"
            >
              <Image
                alt=""
                src="/images/reading-studio.webp"
                fill
                unoptimized
                sizes="560px"
                loading="eager"
                className="object-cover object-[41%_center]"
              />
            </div>
            <div className="mx-auto flex w-full max-w-[560px] flex-col justify-center [&>div]:rounded-none [&>div]:border-0 [&>div]:gap-4 [&>div]:max-w-none [&>div]:shadow-none [&>div]:sm:px-8">
              {children}
            </div>
          </div>
        </ButtonSizeProvider>
      </main>
      <SiteFooter variant="public" />
    </div>
  );
}

export function AuthLoadingState({
  activeRoute,
}: {
  activeRoute?: "login" | "register";
} = {}) {
  return (
    <AuthShell activeRoute={activeRoute}>
      <Card
        aria-busy="true"
        aria-label="Đang tải nội dung"
        className="border border-border bg-white"
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
