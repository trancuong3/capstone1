"use client";

import {
  ArrowUpRight,
  BarChart3,
  Camera,
  History,
  Music2,
  Plus,
  RefreshCw,
  UsersRound,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAppStore } from "@/components/providers/app-store-provider";
import { useProfileService } from "@/hooks/use-profile-service";
import {
  DEFAULT_USER_CACHE_TTL_MS,
  PERSISTENT_USER_CACHE_MAX_STALE_MS,
  readUserCacheWithStale,
  writeUserCache,
} from "@/lib/cache/user-query-cache";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DashboardLatestSessionDTO,
  DashboardSummaryDTO,
} from "@/types/profile";
import { FamilyReadingDesk } from "./family-reading-desk";

type DashboardState =
  | { status: "loading" }
  | {
      status: "ready";
      children: ChildProfileDTO[];
      latestSessionsByChild: Record<string, DashboardLatestSessionDTO | null>;
      summarySource: "dashboard-summary" | "fallback";
    }
  | { status: "error" };

export function DashboardScreen() {
  const { push, replace } = useRouter();
  const searchParams = useSearchParams();
  const profileService = useProfileService();
  const authRuntime = useContext(AuthRuntimeContext);
  const userId =
    authRuntime?.session?.user?.id ?? authRuntime?.initialUserId ?? null;

  const {
    selectedChildId,
    selectChild,
    clearSelectedChild,
    setValidatedSelectedChild,
    syncAvailableChildren,
  } = useAppStore();

  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DashboardState>({ status: "loading" });
  const [selectionPrompt, setSelectionPrompt] = useState(false);
  const selectionSectionRef = useRef<HTMLElement | null>(null);
  const focusRequestHandledRef = useRef(false);
  const hasReadyDataRef = useRef(state.status === "ready");
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
    hasReadyDataRef.current = state.status === "ready";
  }, [state.status]);

  useEffect(() => {
    let isActive = true;

    async function loadDashboard() {
      const cached = readUserCacheWithStale<DashboardSummaryDTO>(
        userId,
        "dashboard-summary",
        DEFAULT_USER_CACHE_TTL_MS,
        PERSISTENT_USER_CACHE_MAX_STALE_MS,
      )?.data;

      if (cached && isActive) {
        setState({
          status: "ready",
          children: cached.children,
          latestSessionsByChild: cached.latest_sessions_by_child,
          summarySource: cached.source,
        });
      } else if (!hasReadyDataRef.current) {
        setState({ status: "loading" });
      }

      try {
        const summary = await profileService.getDashboardSummary();
        if (!isActive) return;

        const cacheOwnerId = userId ?? summary.profile?.id ?? null;
        if (cacheOwnerId) {
          writeUserCache(cacheOwnerId, "dashboard-summary", summary, {
            persist: "local",
          });
          writeUserCache(cacheOwnerId, "children", summary.children, {
            persist: "local",
          });
        }

        setState({
          status: "ready",
          children: summary.children,
          latestSessionsByChild: summary.latest_sessions_by_child,
          summarySource: summary.source,
        });
      } catch {
        if (!isActive) return;
        if (!cached && !hasReadyDataRef.current) {
          setState({ status: "error" });
        }
      }
    }

    void loadDashboard();
    return () => {
      isActive = false;
    };
  }, [profileService, requestKey, userId]);

  useEffect(() => {
    if (state.status !== "ready" || state.children.length === 0) return;
    syncAvailableChildren(state.children);
  }, [state, syncAvailableChildren]);

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

  if (state.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-7">
        <StatusMessage title="Chưa tải được tổng quan" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
        <Button
          className="min-[640px]:w-auto min-[640px]:self-start min-[640px]:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

  const isLoading = state.status === "loading";
  const children = state.status === "ready" ? state.children : [];
  const selectedChild = children.find((child) => child.id === selectedChildId);
  const latestSessionForSelected =
    state.status === "ready" && selectedChild
      ? (state.latestSessionsByChild[selectedChild.id] ?? null)
      : null;

  return (
    <section className="family-dashboard">
      <header className="family-title max-md:mb-2.5! max-md:items-center!">
        <h1 className="book-title max-md:text-xl!">Góc đọc gia đình</h1>
        <Link
          href="/children"
          className="family-inline-link min-h-11 max-md:text-xs!"
        >
          <UsersRound aria-hidden="true" size={16} /> Quản lý hồ sơ
        </Link>
      </header>
      <div className="family-spread max-md:gap-3!">
        <FamilyReadingDesk
          key={selectedChild?.id ?? "family"}
          child={selectedChild}
          hasProfiles={children.length > 0}
          isLoadingProfiles={isLoading}
          latestSession={latestSessionForSelected}
          summarySource={
            state.status === "ready" ? state.summarySource : undefined
          }
          onChooseBook={() => handleReadingAction("/books")}
        />
        <section
          id="child-selection"
          ref={selectionSectionRef}
          tabIndex={-1}
          aria-labelledby="child-selection-title"
          aria-busy={isLoading ? "true" : undefined}
          className={
            "family-profiles order-1 max-md:gap-2! md:order-2" +
            (selectionRequired ? " family-profiles-prompt" : "")
          }
        >
          <h2 id="child-selection-title" className="max-md:text-base!">
            Chọn hồ sơ trẻ
          </h2>
          {selectionRequired && children.length > 0 ? (
            <p
              role="status"
              className="family-selection-notice max-md:text-xs!"
            >
              {invalidSelection
                ? "Hồ sơ đã thay đổi hoặc không còn khả dụng. Vui lòng chọn lại hồ sơ trẻ."
                : "Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc hoặc chơi."}
            </p>
          ) : null}
          {isLoading ? (
            <div
              className="family-profile-list min-[640px]:max-md:grid! min-[640px]:max-md:grid-cols-2! min-[640px]:max-md:overflow-visible! min-[640px]:max-md:[&>*]:min-w-0! min-[640px]:max-md:[&>*]:max-w-none!"
              aria-label="Đang tải hồ sơ trẻ"
            >
              <span className="sr-only" role="status">
                Đang tải…
              </span>
              <Skeleton className="h-[64px] w-full rounded-control" />
              <Skeleton className="h-[64px] w-full rounded-control" />
            </div>
          ) : children.length ? (
            <>
              <div className="family-profile-list min-[640px]:max-md:grid! min-[640px]:max-md:grid-cols-2! min-[640px]:max-md:overflow-visible! min-[640px]:max-md:[&>*]:min-w-0! min-[640px]:max-md:[&>*]:max-w-none!">
                {children.map((child) => (
                  <ChildProfileCard
                    key={child.id}
                    child={child}
                    selected={selectedChild?.id === child.id}
                    onSelect={() => {
                      selectChild(child.id);
                      setValidatedSelectedChild(child);
                      setSelectionPrompt(false);
                      if (searchParams.toString()) replace("/dashboard");
                    }}
                  />
                ))}
              </div>
              <Link
                href="/children/new"
                className="family-inline-link min-h-11 md:min-h-12!"
              >
                <Plus aria-hidden="true" size={17} /> Tạo hồ sơ bé
              </Link>
            </>
          ) : (
            <p className="text-muted">
              Gia đình mình chưa có hồ sơ bé. Mỗi hồ sơ sẽ có tủ sách và lịch sử
              đọc riêng.
            </p>
          )}
        </section>
      </div>

      {!isLoading && children.length > 0 ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 md:hidden">
            <Link
              className="flex min-h-11 items-center gap-2 rounded-card border border-border bg-white px-3 py-2 text-xs font-bold text-ink shadow-xs transition-colors hover:bg-sky/40 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              href={
                selectedChild
                  ? `/reports?childId=${encodeURIComponent(selectedChild.id)}`
                  : "/reports"
              }
            >
              <BarChart3
                aria-hidden="true"
                className="size-4 shrink-0 text-primary"
              />
              <span className="truncate">Xem tiến bộ</span>
            </Link>
            <Link
              className="flex min-h-11 items-center gap-2 rounded-card border border-border bg-white px-3 py-2 text-xs font-bold text-ink shadow-xs transition-colors hover:bg-warning-surface/50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              href={
                selectedChild
                  ? `/reports/difficult-words?childId=${encodeURIComponent(selectedChild.id)}`
                  : "/reports/difficult-words"
              }
            >
              <Volume2
                aria-hidden="true"
                className="size-4 shrink-0 text-warning"
              />
              <span className="truncate">Từ cần luyện</span>
            </Link>
          </div>

          <section
            aria-labelledby="reading-actions-title"
            className="family-tools max-md:mt-3!"
          >
            <div className="family-tools-heading max-md:items-center! max-md:pb-1.5!">
              <h2 id="reading-actions-title" className="max-md:text-lg!">
                Hoạt động đọc sách
              </h2>
              <Link
                href={
                  selectedChild
                    ? `/sessions?childId=${encodeURIComponent(selectedChild.id)}`
                    : "/sessions"
                }
                className="family-inline-link min-h-11 max-md:text-xs!"
              >
                <History aria-hidden="true" size={16} /> Lịch sử đọc
              </Link>
            </div>
            <div className="family-tool-list min-[640px]:grid-cols-2! min-[640px]:gap-x-4! min-[640px]:[&>*]:px-2! md:grid-cols-3! md:gap-x-0! md:[&>*]:px-[18px]! md:[&>*:first-child]:pl-0! md:[&>*:last-child]:pr-0!">
              <button
                type="button"
                aria-label="Quét sách"
                className="max-md:min-h-12! max-md:py-2.5!"
                onClick={() => handleReadingAction("/book-scanner")}
              >
                <Camera aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <strong className="max-md:text-base!">Quét sách</strong>
                  <small className="max-md:text-xs!">
                    Mở một trang sách giấy bằng camera.
                  </small>
                </span>
                <ArrowUpRight aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Trò chơi và âm nhạc"
                className="max-md:min-h-12! max-md:py-2.5!"
                onClick={() => handleReadingAction("/entertainment")}
              >
                <Music2 aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <strong className="max-md:text-base!">
                    Trò chơi và âm nhạc
                  </strong>
                  <small className="max-md:text-xs!">
                    Ghép câu, kể chuyện hoặc hát cùng bé.
                  </small>
                </span>
                <ArrowUpRight aria-hidden="true" />
              </button>
              <Link
                className="max-md:min-h-12! max-md:py-2.5!"
                href={
                  selectedChild
                    ? `/reports?childId=${encodeURIComponent(selectedChild.id)}`
                    : "/reports"
                }
              >
                <BarChart3 aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <strong className="max-md:text-base!">Xem tiến bộ</strong>
                  <small className="max-md:text-xs!">
                    Theo dõi kết quả qua từng buổi đọc.
                  </small>
                </span>
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
