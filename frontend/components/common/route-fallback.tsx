"use client";

import { AlertTriangle, Compass, Home, RefreshCw } from "lucide-react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";

export function NotFoundFallback() {
  const tCommon = useTranslations("common");

  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-[744px] flex-col items-center justify-center px-4 py-12">
      <EmptyState
        action={
          <div className="flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
            <ButtonLink className="sm:w-auto sm:px-6" href="/dashboard">
              <Home aria-hidden="true" className="size-5" />
              {tCommon("notFound.backHome")}
            </ButtonLink>
            <ButtonLink
              className="sm:w-auto sm:px-6"
              href="/login"
              variant="secondary"
            >
              {tCommon("notFound.backLogin")}
            </ButtonLink>
          </div>
        }
        description={tCommon("notFound.description")}
        headingLevel={1}
        icon={<Compass aria-hidden="true" className="size-8 text-primary" />}
        title={tCommon("notFound.title")}
      />
    </main>
  );
}

export function RouteErrorFallback({
  onRetry,
}: {
  readonly onRetry?: () => void;
}) {
  const tCommon = useTranslations("common");

  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-[744px] flex-col justify-center gap-4 px-4 py-12">
      <StatusMessage title={tCommon("errorPage.title")} tone="error">
        {tCommon("errorPage.description")}
      </StatusMessage>
      <div className="flex flex-col gap-3 sm:flex-row">
        {onRetry ? (
          <Button className="sm:w-auto sm:px-6" onClick={onRetry} type="button">
            <RefreshCw aria-hidden="true" className="size-5" />
            {tCommon("actions.retry")}
          </Button>
        ) : null}
        <ButtonLink
          className="sm:w-auto sm:px-6"
          href="/dashboard"
          variant="secondary"
        >
          <AlertTriangle aria-hidden="true" className="hidden" />
          {tCommon("errorPage.backHome")}
        </ButtonLink>
      </div>
    </main>
  );
}
