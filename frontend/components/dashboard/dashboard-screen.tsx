"use client";

import {
  BarChart3,
  BookOpenText,
  History,
  Plus,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useChildService } from "@/hooks/use-child-service";
import { useProfileService } from "@/hooks/use-profile-service";
import type { ChildProfileDTO } from "@/types/child";
import type { ParentProfileDTO } from "@/types/profile";

type DashboardState =
  | { status: "loading" }
  | {
      status: "ready";
      children: ChildProfileDTO[];
      profile: ParentProfileDTO;
    }
  | { status: "error" };

function DashboardLoadingState() {
  return (
    <section
      aria-busy="true"
      aria-label="Đang tải tổng quan"
      className="mx-auto flex w-full max-w-[1120px] flex-col gap-6"
    >
      <span className="sr-only" role="status">
        Đang tải…
      </span>
      <Card>
        <Skeleton className="h-10 w-3/5" />
        <Skeleton className="h-7 w-4/5" />
      </Card>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1].map((item) => (
          <Skeleton className="h-[280px] w-full rounded-card" key={item} />
        ))}
      </div>
    </section>
  );
}

export function DashboardScreen() {
  const childService = useChildService();
  const profileService = useProfileService();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DashboardState>({ status: "loading" });

  useEffect(() => {
    let isActive = true;

    async function loadDashboard() {
      setState({ status: "loading" });

      try {
        const [profile, children] = await Promise.all([
          profileService.get(),
          childService.list(),
        ]);

        if (isActive) {
          setState({ status: "ready", children, profile });
        }
      } catch {
        if (isActive) {
          setState({ status: "error" });
        }
      }
    }

    void loadDashboard();

    return () => {
      isActive = false;
    };
  }, [childService, profileService, requestKey]);

  if (state.status === "loading") {
    return <DashboardLoadingState />;
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <StatusMessage title="Chưa tải được tổng quan" tone="error">
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
      </section>
    );
  }

  const parentName = state.profile.display_name?.trim() || "ba mẹ";

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 sm:gap-8">
      <Card className="mx-auto max-w-[744px] items-start text-left sm:flex-row sm:items-center sm:p-6">
        <div className="hidden size-24 shrink-0 items-center justify-center rounded-card bg-sky text-primary sm:flex">
          <BookOpenText aria-hidden="true" className="size-12" />
        </div>
        <div className="max-w-[720px]">
          <p className="hidden text-label font-bold text-primary sm:block">
            TỔNG QUAN
          </p>
          <h1 className="text-heading font-extrabold text-ink sm:mt-2">
            <span className="sm:hidden">Hôm nay mình cùng đọc nhé!</span>
            <span className="hidden sm:inline">
              Chào {parentName}, hôm nay mình đọc gì cùng bé?
            </span>
          </h1>
          <p className="mt-3 text-body text-muted">
            <span className="sm:hidden">Ba mẹ chọn hồ sơ của bé.</span>
            <span className="hidden sm:inline">
              Chọn một hồ sơ để tiếp tục hành trình đọc sách của gia đình.
            </span>
          </p>
        </div>
      </Card>

      {state.children.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink className="max-w-80" href="/children/new">
              <Plus aria-hidden="true" className="size-5" />
              Tạo hồ sơ đầu tiên
            </ButtonLink>
          }
          description="Tạo hồ sơ đầu tiên để bé bắt đầu đọc sách nhé."
          icon={
            <UsersRound aria-hidden="true" className="size-10 text-primary" />
          }
          title="Gia đình mình chưa có hồ sơ bé"
        />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="mx-auto flex w-full max-w-[744px] flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-extrabold leading-[1.4] text-ink">
                Chọn bạn nhỏ
              </h2>
              <p className="text-body text-muted">
                Chỉ hiển thị hồ sơ thuộc tài khoản hiện tại.
              </p>
            </div>
            <Link
              className="inline-flex min-h-11 w-fit items-center rounded-md px-1 text-label font-bold text-primary underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
              href="/children"
            >
              Quản lý hồ sơ
            </Link>
          </div>

          <div className="mx-auto grid w-full max-w-[552px] gap-6 sm:grid-cols-2">
            {state.children.map((child) => (
              <ChildProfileCard
                child={child}
                href={`/books?childId=${encodeURIComponent(child.id)}`}
                key={child.id}
              />
            ))}
          </div>

          <div className="mx-auto flex w-full flex-col gap-3 sm:max-w-[600px] sm:flex-row sm:justify-center">
            <ButtonLink className="sm:max-w-72" href="/books">
              Chọn sách
            </ButtonLink>
            <ButtonLink
              className="sm:max-w-72"
              href="/children/new"
              variant="secondary"
            >
              <Plus aria-hidden="true" className="size-5" />
              Tạo hồ sơ bé
            </ButtonLink>
          </div>

          <div className="mx-auto grid w-full max-w-[744px] gap-3 sm:grid-cols-2">
            <ButtonLink
              href={`/reports?childId=${encodeURIComponent(state.children[0].id)}`}
              variant="secondary"
            >
              <BarChart3 aria-hidden="true" className="size-5" />
              Xem tiến bộ
            </ButtonLink>
            <ButtonLink
              href={`/sessions?childId=${encodeURIComponent(state.children[0].id)}`}
              variant="secondary"
            >
              <History aria-hidden="true" className="size-5" />
              Lịch sử đọc
            </ButtonLink>
          </div>
        </div>
      )}
    </section>
  );
}
