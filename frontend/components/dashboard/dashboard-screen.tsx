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
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAppStore } from "@/components/providers/app-store-provider";
import { useProfileService } from "@/hooks/use-profile-service";
import {
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
  const userId = authRuntime?.session?.user?.id ?? null;

  const {
    selectedChildId,
    selectChild,
    clearSelectedChild,
    setValidatedSelectedChild,
  } = useAppStore();

  const initialCachedSummary = useMemo(
    () =>
      readUserCacheWithStale<DashboardSummaryDTO>(userId, "dashboard-summary")
        ?.data ?? null,
    [userId],
  );

  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DashboardState>(() =>
    initialCachedSummary
      ? {
          status: "ready",
          children: initialCachedSummary.children,
          latestSessionsByChild: initialCachedSummary.latest_sessions_by_child,
          summarySource: initialCachedSummary.source,
        }
      : { status: "loading" },
  );
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
          writeUserCache(cacheOwnerId, "dashboard-summary", summary);
          writeUserCache(cacheOwnerId, "children", summary.children);
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

  const isLoading = state.status === "loading";
  const children = state.status === "ready" ? state.children : [];
  const selectedChild = children.find((child) => child.id === selectedChildId);
  const latestSessionForSelected =
    state.status === "ready" && selectedChild
      ? (state.latestSessionsByChild[selectedChild.id] ?? null)
      : null;

  return (
    <section className="family-dashboard">
      <header className="family-title">
        <h1 className="book-title">Góc đọc gia đình</h1>
        <Link href="/children" className="family-inline-link min-h-12">
          <UsersRound aria-hidden="true" size={17} /> Quản lý hồ sơ
        </Link>
      </header>
      <div className="family-spread">
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
            "family-profiles order-1 md:order-2" +
            (selectionRequired ? " family-profiles-prompt" : "")
          }
        >
          <h2 id="child-selection-title">Chọn hồ sơ trẻ</h2>
          {selectionRequired && children.length > 0 ? (
            <p role="status" className="family-selection-notice">
              {invalidSelection
                ? "Hồ sơ đã thay đổi hoặc không còn khả dụng. Vui lòng chọn lại hồ sơ trẻ."
                : "Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc hoặc chơi."}
            </p>
          ) : null}
          {isLoading ? (
            <div
              className="family-profile-list"
              aria-label="Đang tải hồ sơ trẻ"
            >
              <span className="sr-only" role="status">
                Đang tải…
              </span>
              <Skeleton className="h-[68px] w-full rounded-control" />
              <Skeleton className="h-[68px] w-full rounded-control" />
            </div>
          ) : children.length ? (
            <>
              <div className="family-profile-list">
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
                className="family-inline-link min-h-12"
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
          <div className="mt-4 grid grid-cols-2 gap-2.5 md:hidden">
            <Link
              className="flex min-h-12 items-center gap-2.5 rounded-card border border-border bg-white px-3.5 py-3 text-sm font-bold text-ink shadow-xs transition-colors hover:bg-sky/40 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              href={
                selectedChild
                  ? `/reports?childId=${encodeURIComponent(selectedChild.id)}`
                  : "/reports"
              }
            >
              <BarChart3
                aria-hidden="true"
                className="size-5 shrink-0 text-primary"
              />
              <span className="truncate">Tiến bộ gần đây</span>
            </Link>
            <Link
              className="flex min-h-12 items-center gap-2.5 rounded-card border border-border bg-white px-3.5 py-3 text-sm font-bold text-ink shadow-xs transition-colors hover:bg-warning-surface/50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              href={
                selectedChild
                  ? `/reports/difficult-words?childId=${encodeURIComponent(selectedChild.id)}`
                  : "/reports/difficult-words"
              }
            >
              <Volume2
                aria-hidden="true"
                className="size-5 shrink-0 text-warning"
              />
              <span className="truncate">Từ cần luyện</span>
            </Link>
          </div>

          <section
            aria-labelledby="reading-actions-title"
            className="family-tools"
          >
            <div className="family-tools-heading">
              <h2 id="reading-actions-title">Hoạt động đọc sách</h2>
              <Link
                href={
                  selectedChild
                    ? `/sessions?childId=${encodeURIComponent(selectedChild.id)}`
                    : "/sessions"
                }
                className="family-inline-link min-h-12"
              >
                <History aria-hidden="true" size={16} /> Lịch sử đọc
              </Link>
            </div>
            <div className="family-tool-list">
              <button
                type="button"
                aria-label="Quét sách"
                onClick={() => handleReadingAction("/book-scanner")}
              >
                <Camera aria-hidden="true" />
                <span>
                  <strong>Quét sách</strong>
                  <small>Mở một trang sách giấy bằng camera.</small>
                </span>
                <ArrowUpRight aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Trò chơi và âm nhạc"
                onClick={() => handleReadingAction("/entertainment")}
              >
                <Music2 aria-hidden="true" />
                <span>
                  <strong>Trò chơi và âm nhạc</strong>
                  <small>Ghép câu, kể chuyện hoặc hát cùng bé.</small>
                </span>
                <ArrowUpRight aria-hidden="true" />
              </button>
              <Link
                href={
                  selectedChild
                    ? `/reports?childId=${encodeURIComponent(selectedChild.id)}`
                    : "/reports"
                }
              >
                <BarChart3 aria-hidden="true" />
                <span>
                  <strong>Xem tiến bộ</strong>
                  <small>Theo dõi kết quả qua từng buổi đọc.</small>
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
