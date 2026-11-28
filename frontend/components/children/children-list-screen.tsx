"use client";

import { Plus, RefreshCw, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useChildService } from "@/hooks/use-child-service";
import { useI18n } from "@/hooks/use-i18n";
import type { ChildProfileDTO } from "@/types/child";

const CHILDREN_PAGE_SIZE = 6;

type ChildrenState =
  | { status: "loading" }
  | { status: "ready"; children: ChildProfileDTO[] }
  | { status: "error" };

export function ChildrenListScreen() {
  const { t } = useI18n();
  const childService = useChildService();
  const [requestKey, setRequestKey] = useState(0);
  const [page, setPage] = useState(1);
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

  const totalChildren = state.status === "ready" ? state.children.length : 0;
  const totalPages = Math.max(1, Math.ceil(totalChildren / CHILDREN_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visibleChildren =
    state.status === "ready"
      ? state.children.slice(
          (safePage - 1) * CHILDREN_PAGE_SIZE,
          safePage * CHILDREN_PAGE_SIZE,
        )
      : [];

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6">
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
            onClick={() => {
              setPage(1);
              setRequestKey((key) => key + 1);
            }}
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
        <>
          <div className="grid gap-6 sm:grid-cols-2">
            {visibleChildren.map((child) => (
              <ChildProfileCard
                child={child}
                href={`/children/${child.id}`}
                key={child.id}
                showEditAction
              />
            ))}
          </div>
          <PaginationBar
            itemLabel={t("parent.dashboard.childProfilesTitle")}
            onPageChange={setPage}
            page={safePage}
            pageSize={CHILDREN_PAGE_SIZE}
            total={state.children.length}
          />
        </>
      ) : null}
    </section>
  );
}
