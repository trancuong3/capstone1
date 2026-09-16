"use client";

import { Plus, RefreshCw, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useChildService } from "@/hooks/use-child-service";
import type { ChildProfileDTO } from "@/types/child";

type ChildrenState =
  | { status: "loading" }
  | { status: "ready"; children: ChildProfileDTO[] }
  | { status: "error" };

export function ChildrenListScreen() {
  const childService = useChildService();
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

  return (
    <section className="mx-auto flex w-full max-w-[960px] flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-label font-bold text-primary">HỒ SƠ BÉ</p>
          <h1 className="mt-2 text-heading font-extrabold text-ink">
            Các bạn nhỏ của gia đình
          </h1>
          <p className="mt-2 text-body text-muted">
            Ba mẹ có thể tạo và chỉnh sửa những hồ sơ thuộc tài khoản này.
          </p>
        </div>
        <ButtonLink className="sm:w-auto sm:min-w-60" href="/children/new">
          <Plus aria-hidden="true" className="size-5" />
          Tạo hồ sơ bé
        </ButtonLink>
      </header>

      {state.status === "loading" ? (
        <div
          aria-busy="true"
          aria-label="Đang tải hồ sơ bé"
          className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          <span className="sr-only" role="status">
            Đang tải…
          </span>
          {[0, 1, 2].map((item) => (
            <Skeleton className="h-[280px] w-full rounded-card" key={item} />
          ))}
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="flex flex-col gap-4">
          <StatusMessage title="Chưa tải được hồ sơ bé" tone="error">
            Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
          </StatusMessage>
          <Button
            className="sm:w-auto sm:self-start sm:px-8"
            onClick={() => setRequestKey((key) => key + 1)}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-5" />
            Thử lại
          </Button>
        </div>
      ) : null}

      {state.status === "ready" && state.children.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink className="max-w-80" href="/children/new">
              <Plus aria-hidden="true" className="size-5" />
              Tạo hồ sơ đầu tiên
            </ButtonLink>
          }
          description="Tạo hồ sơ đầu tiên để bé bắt đầu hành trình đọc sách."
          icon={
            <UsersRound aria-hidden="true" className="size-10 text-primary" />
          }
          title="Chưa có hồ sơ bé"
        />
      ) : null}

      {state.status === "ready" && state.children.length > 0 ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
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
