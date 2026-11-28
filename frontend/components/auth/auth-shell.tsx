"use client";

import Image from "next/image";
import type { ReactNode } from "react";

import { ButtonSizeProvider } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { useTranslations } from "@/hooks/use-i18n";

interface AuthShellProps {
  children: ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="account-spread flex min-h-dvh w-full flex-col overflow-x-hidden bg-canvas">
      <SiteHeader />
      <main className="flex w-full min-w-0 flex-1 items-start justify-center px-3 max-sm:py-3! sm:min-h-[640px] sm:items-center sm:px-12 sm:py-12">
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
                loading="eager"
                sizes="(min-width: 1024px) 560px, 1px"
                className="object-cover object-[41%_center]"
              />
            </div>
            <div className="mx-auto flex w-full max-w-[560px] flex-col justify-center [&>div]:rounded-none [&>div]:border-0 [&>div]:gap-3 [&>div]:p-4 [&>div]:max-w-none [&>div]:shadow-none [&>div]:sm:gap-4 [&>div]:sm:px-8 [&>div]:sm:py-6">
              {children}
            </div>
          </div>
        </ButtonSizeProvider>
      </main>
      <SiteFooter variant="public" />
    </div>
  );
}

export function AuthLoadingState() {
  const tA11y = useTranslations("accessibility");
  const tCommon = useTranslations("common");

  return (
    <AuthShell>
      <Card
        aria-busy="true"
        aria-label={tA11y("loadingContent")}
        className="border border-border bg-white"
      >
        <span className="sr-only" role="status">
          {tCommon("states.loading")}
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
