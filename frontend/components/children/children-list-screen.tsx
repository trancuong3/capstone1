"use client";

import { Plus, RefreshCw, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useIsMobileViewport } from "@/components/dashboard/use-is-mobile-viewport";
import { useChildService } from "@/hooks/use-child-service";
import { useI18n } from "@/hooks/use-i18n";
import type { ChildProfileDTO } from "@/types/child";

type ChildrenState =
  | { status: "loading" }
  | { status: "ready"; children: ChildProfileDTO[] }
  | { status: "error" };

export function ChildrenListScreen() {
  const { t } = useI18n();
  const childService = useChildService();
  const isMobile = useIsMobileViewport();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ChildrenState>({ status: "loading" });

  useEffect(() => {
    let isActive = true;

    async function load() {
      setState({ status: "loading" });

      try {
        const children = await childService.list();
        if (isActive) {
          setState({ status: "ready", children });
        }
      } catch {
        if (isActive) {
          setState({ status: "error" });
        }
      }
    }

    void load();
    return () => {
      isActive = false;
    };
  }, [childService, requestKey]);

  if (isMobile) {
    return (
      <section className="flex w-full flex-col gap-5 pb-2">
        <header className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
              {t("parent.children.listPageTitle")}
            </span>
            <h1 className="book-title text-[26px] leading-tight text-ink">
              {t("parent.children.listTitle")}
            </h1>
            <p className="text-sm leading-relaxed text-muted">
              {t("parent.children.listDescription")}
            </p>
          </div>
          <ButtonLink
            className="min-h-12 text-button"
            href="/children/new"
            size="touch"
          >
            <Plus aria-hidden="true" className="size-5" />
            {t("parent.children.createButton")}
          </ButtonLink>
        </header>

        {state.status === "loading" ? (
          <div
            aria-busy="true"
            aria-label={t("parent.children.loadingAria")}
            className="flex flex-col gap-3"
          >
            <span className="sr-only" role="status">
              {t("common.states.loading")}
            </span>
            {[0, 1, 2].map((item) => (
              <Skeleton className="h-20 w-full rounded-control" key={item} />
            ))}
          </div>
        ) : null}

        {state.status === "error" ? (
          <div className="flex flex-col gap-4">
            <StatusMessage
              compact
              title={t("parent.children.loadErrorTitle")}
              tone="error"
            >
              {t("auth.errors.generic")}
            </StatusMessage>
            <Button
              onClick={() => setRequestKey((key) => key + 1)}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-5" />
              {t("common.actions.retry")}
            </Button>
          </div>
        ) : null}

        {state.status === "ready" && state.children.length === 0 ? (
          <EmptyState
            action={
              <ButtonLink href="/children/new" size="compact">
                <Plus aria-hidden="true" className="size-5" />
                {t("parent.children.createFirstButton")}
              </ButtonLink>
            }
            description={t("parent.children.emptyDescription")}
            icon={
              <UsersRound aria-hidden="true" className="size-10 text-primary" />
            }
            title={t("parent.children.emptyTitle")}
          />
        ) : null}

        {state.status === "ready" && state.children.length > 0 ? (
          <div className="flex flex-col gap-3">
            {state.children.map((child) => (
              <ChildProfileCard
                child={child}
                href={`/children/${child.id}`}
                key={child.id}
                showEditAction
              />
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 pb-4">
      <PageHeader
        action={
          <ButtonLink className="sm:min-w-60" href="/children/new">
            <Plus aria-hidden="true" className="size-5" />
            {t("parent.children.createButton")}
          </ButtonLink>
        }
        className="mb-0"
        description={t("parent.children.listDescription")}
        title={t("parent.children.listTitle")}
      />

      {state.status === "loading" ? (
        <div
          aria-busy="true"
          aria-label={t("parent.children.loadingAria")}
          className="grid gap-6 sm:grid-cols-2"
        >
          <span className="sr-only" role="status">
            {t("common.states.loading")}
          </span>
          {[0, 1, 2].map((item) => (
            <Skeleton className="h-20 w-full rounded-card" key={item} />
          ))}
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="flex flex-col gap-4">
          <StatusMessage
            title={t("parent.children.loadErrorTitle")}
            tone="error"
          >
            {t("auth.errors.generic")}
          </StatusMessage>
          <Button
            className="sm:w-auto sm:self-start sm:px-8"
            onClick={() => setRequestKey((key) => key + 1)}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-5" />
            {t("common.actions.retry")}
          </Button>
        </div>
      ) : null}

      {state.status === "ready" && state.children.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink className="max-w-80" href="/children/new">
              <Plus aria-hidden="true" className="size-5" />
              {t("parent.children.createFirstButton")}
            </ButtonLink>
          }
          description={t("parent.children.emptyDescription")}
          icon={
            <UsersRound aria-hidden="true" className="size-10 text-primary" />
          }
          title={t("parent.children.emptyTitle")}
        />
      ) : null}

      {state.status === "ready" && state.children.length > 0 ? (
        <div className="grid gap-6 sm:grid-cols-2">
          {state.children.map((child) => (
            <ChildProfileCard
              child={child}
              href={`/children/${child.id}`}
              key={child.id}
              showEditAction
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
