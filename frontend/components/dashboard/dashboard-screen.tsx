"use client";

import {
  ArrowDown,
  BarChart3,
  BookOpenText,
  Camera,
  History,
  Music2,
  Plus,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAppStore } from "@/components/providers/app-store-provider";
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
      className="mx-auto flex w-full max-w-[744px] flex-col gap-4"
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
  const { push, replace } = useRouter();
  const searchParams = useSearchParams();
  const childService = useChildService();
  const profileService = useProfileService();
  const {
    selectedChildId,
    selectChild,
    clearSelectedChild,
    setValidatedSelectedChild,
  } = useAppStore();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DashboardState>({ status: "loading" });
  const [selectionPrompt, setSelectionPrompt] = useState(false);
  const selectionSectionRef = useRef<HTMLElement | null>(null);
  const focusRequestHandledRef = useRef(false);
  const selectionReason = searchParams.get("reason");
  const routeSelectionPrompt =
    searchParams.get("focus") === "child-selection" &&
    (!selectedChildId ||
      selectionReason === "missing" ||
      selectionReason === "invalid" ||
      selectionReason === "change");
  const selectionRequired = selectionPrompt || routeSelectionPrompt;
  const invalidSelection =
    routeSelectionPrompt && selectionReason === "invalid";

  useEffect(() => {
    let isActive = true;

    async function loadDashboard() {
      setState({ status: "loading" });

      try {
        const [profile, children] = await Promise.all([
          profileService.get(),
          childService.list(),
        ]);

        if (isActive) setState({ status: "ready", children, profile });
      } catch {
        if (isActive) setState({ status: "error" });
      }
    }

    void loadDashboard();
    return () => {
      isActive = false;
    };
  }, [childService, profileService, requestKey]);

  useEffect(() => {
    if (state.status !== "ready" || !selectedChildId) return;
    const child = state.children.find(
      (candidate) => candidate.id === selectedChildId,
    );
    if (!child) {
      clearSelectedChild();
      replace("/dashboard?focus=child-selection&reason=invalid");
      return;
    }
    setValidatedSelectedChild(child);
  }, [
    clearSelectedChild,
    replace,
    selectedChildId,
    setValidatedSelectedChild,
    state,
  ]);

  const focusSelectionSection = useCallback(() => {
    const focus = () => {
      const section = selectionSectionRef.current;
      const prefersReducedMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      section?.scrollIntoView?.({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "center",
      });
      section?.focus();
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focus);
    } else {
      focus();
    }
  }, []);

  useEffect(() => {
    if (
      focusRequestHandledRef.current ||
      searchParams.get("focus") !== "child-selection" ||
      state.status !== "ready"
    ) {
      return;
    }
    focusRequestHandledRef.current = true;
    focusSelectionSection();
  }, [focusSelectionSection, searchParams, selectedChildId, state.status]);

  const handleReadingAction = useCallback(
    (destination: "/books" | "/book-scanner" | "/entertainment") => {
      if (!selectedChildId) {
        setSelectionPrompt(true);
        focusSelectionSection();
        return;
      }
      push(destination);
    },
    [focusSelectionSection, push, selectedChildId],
  );

  if (state.status === "loading") return <DashboardLoadingState />;

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

  const selectedChild = state.children.find(
    (child) => child.id === selectedChildId,
  );

  return (
    <section className="mx-auto flex w-full max-w-[744px] flex-col gap-4">
      <Card className="items-start text-left sm:flex-row sm:gap-6 sm:p-6">
        <div className="hidden shrink-0 sm:block">
          <Image
            alt=""
            aria-hidden="true"
            height={96}
            src="/images/figma/dashboard-book.svg"
            width={96}
          />
        </div>
        <div className="max-w-[720px]">
          <p className="text-label font-bold text-primary">TỔNG QUAN</p>
          <h1 className="mt-1 text-heading font-extrabold leading-tight text-ink">
            {state.profile.display_name
              ? `Chào ${state.profile.display_name}, hôm nay mình đọc gì cùng bé?`
              : "Hôm nay cùng bé đọc gì?"}
          </h1>
          <p className="mt-2 text-body leading-6 text-muted">
            Chọn một hồ sơ để tiếp tục hành trình đọc sách của gia đình.
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
        <div className="flex flex-col gap-4">
          <section
            aria-labelledby="child-selection-title"
            className={
              "flex w-full scroll-mt-8 flex-col gap-4 rounded-card transition-shadow focus:outline-none " +
              (selectionRequired ? "ring-4 ring-warning" : "")
            }
            id="child-selection"
            ref={selectionSectionRef}
            tabIndex={-1}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2
                  className="text-2xl font-semibold leading-[1.4] text-ink"
                  id="child-selection-title"
                >
                  Chọn hồ sơ trẻ
                </h2>
                <p className="text-body text-muted">
                  Chỉ hiển thị hồ sơ thuộc tài khoản hiện tại.
                </p>
              </div>
            </div>

            {selectionRequired ? (
              <div
                aria-live="polite"
                className="flex items-start gap-3 rounded-card border border-warning bg-warning-surface p-4"
              >
                <ArrowDown
                  aria-hidden="true"
                  className="mt-1 size-5 shrink-0 text-warning"
                />
                <div>
                  <p className="font-semibold text-warning-ink">
                    {invalidSelection
                      ? "Hồ sơ đã thay đổi hoặc không còn khả dụng. Vui lòng chọn lại hồ sơ trẻ."
                      : "Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc hoặc chơi."}
                  </p>
                  <p className="mt-1 text-sm text-ink">
                    Chạm vào hồ sơ của bé bên dưới để chọn người sẽ đọc hoặc
                    chơi.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="grid w-full gap-4 sm:grid-cols-2">
              {state.children.map((child) => (
                <ChildProfileCard
                  child={child}
                  key={child.id}
                  onSelect={() => {
                    selectChild(child.id);
                    setSelectionPrompt(false);
                    if (searchParams.toString()) replace("/dashboard");
                  }}
                  selected={selectedChildId === child.id}
                />
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <ButtonLink href="/children/new" variant="secondary">
                <Plus aria-hidden="true" className="size-5" />
                Tạo hồ sơ bé
              </ButtonLink>
              <ButtonLink href="/children" variant="quiet">
                Quản lý hồ sơ
              </ButtonLink>
            </div>
          </section>

          <section
            aria-labelledby="reading-actions-title"
            className="flex w-full flex-col gap-4 rounded-card border border-border bg-white p-4 sm:p-6"
          >
            <div>
              <h2
                className="text-2xl font-semibold leading-[1.4] text-ink"
                id="reading-actions-title"
              >
                Hoạt động đọc sách
              </h2>
              {selectedChild ? (
                <>
                  <p className="mt-1 text-body font-semibold text-primary">
                    Đang chọn: {selectedChild.alias} – Lớp {selectedChild.grade}
                  </p>
                  <p className="mt-2 text-body text-muted">
                    Bạn muốn cho bé bắt đầu bằng cách nào?
                  </p>
                </>
              ) : (
                <p className="mt-2 text-body text-muted">
                  Chọn hồ sơ trẻ trước khi mở sách, quét trang hoặc vào Hát vui.
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                className="w-full"
                onClick={() => handleReadingAction("/book-scanner")}
              >
                <Camera aria-hidden="true" className="size-5" />
                Quét sách
              </Button>
              <Button
                className="w-full"
                onClick={() => handleReadingAction("/books")}
                variant="secondary"
              >
                <BookOpenText aria-hidden="true" className="size-5" />
                Chọn sách
              </Button>
              <Button
                className="w-full sm:col-span-2"
                variant="secondary"
                onClick={() => handleReadingAction("/entertainment")}
              >
                <Music2 aria-hidden="true" className="size-5" />
                Hát vui
              </Button>
            </div>
          </section>

          <div className="grid w-full gap-4 sm:grid-cols-2">
            <ButtonLink
              href={
                selectedChildId
                  ? `/reports?childId=${encodeURIComponent(selectedChildId)}`
                  : "/reports"
              }
              variant="quiet"
            >
              <BarChart3 aria-hidden="true" className="size-5" />
              Xem tiến bộ
            </ButtonLink>
            <ButtonLink
              href={
                selectedChildId
                  ? `/sessions?childId=${encodeURIComponent(selectedChildId)}`
                  : "/sessions"
              }
              variant="quiet"
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
