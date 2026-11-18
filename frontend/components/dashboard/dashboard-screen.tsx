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
} from "lucide-react";
import Link from "next/link";
import { FamilyReadingDesk } from "./family-reading-desk";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAppStore } from "@/components/providers/app-store-provider";
import { useChildService } from "@/hooks/use-child-service";
import type { ChildProfileDTO } from "@/types/child";

type DashboardState =
  | { status: "loading" }
  | {
      status: "ready";
      children: ChildProfileDTO[];
    }
  | { status: "error" };

function DashboardLoadingState() {
  return (
    <section
      aria-busy="true"
      aria-label="Đang tải tổng quan"
      className="mx-auto flex w-full max-w-[1120px] flex-col gap-7"
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
          <Skeleton className="h-32 w-full rounded-card" key={item} />
        ))}
      </div>
    </section>
  );
}

export function DashboardScreen() {
  const { push, replace } = useRouter();
  const searchParams = useSearchParams();
  const childService = useChildService();
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
        const children = await childService.list();

        if (isActive) setState({ status: "ready", children });
      } catch {
        if (isActive) setState({ status: "error" });
      }
    }

    void loadDashboard();
    return () => {
      isActive = false;
    };
  }, [childService, requestKey]);

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

  const selectedChild = state.children.find(
    (child) => child.id === selectedChildId,
  );

  return (
    <section className="family-dashboard">
      <header className="family-title">
        <h1 className="book-title">Góc đọc gia đình</h1>
        <Link href="/children" className="family-inline-link">
          <UsersRound aria-hidden="true" size={17} /> Quản lý hồ sơ
        </Link>
      </header>
      <div className="family-spread">
        <FamilyReadingDesk
          key={selectedChild?.id ?? "family"}
          child={selectedChild}
          hasProfiles={state.children.length > 0}
          onChooseBook={() => handleReadingAction("/books")}
        />
        <section
          id="child-selection"
          ref={selectionSectionRef}
          tabIndex={-1}
          aria-labelledby="child-selection-title"
          className={
            "family-profiles" +
            (selectionRequired ? " family-profiles-prompt" : "")
          }
        >
          <h2 id="child-selection-title">Chọn hồ sơ trẻ</h2>
          {selectionRequired && state.children.length > 0 ? (
            <p role="status" className="family-selection-notice">
              {invalidSelection
                ? "Hồ sơ đã thay đổi hoặc không còn khả dụng. Vui lòng chọn lại hồ sơ trẻ."
                : "Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc hoặc chơi."}
            </p>
          ) : null}
          {state.children.length ? (
            <>
              <div className="family-profile-list">
                {state.children.map((child) => (
                  <ChildProfileCard
                    key={child.id}
                    child={child}
                    selected={selectedChild?.id === child.id}
                    onSelect={() => {
                      selectChild(child.id);
                      setSelectionPrompt(false);
                      if (searchParams.toString()) replace("/dashboard");
                    }}
                  />
                ))}
              </div>
              <Link href="/children/new" className="family-inline-link">
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
      {state.children.length > 0 ? (
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
              className="family-inline-link"
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
      ) : null}
    </section>
  );
}
