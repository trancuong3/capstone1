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
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { MobileDashboard } from "@/components/dashboard/mobile-dashboard";
import { useIsMobileViewport } from "@/components/dashboard/use-is-mobile-viewport";
import { useAppStore } from "@/components/providers/app-store-provider";
import { useI18n } from "@/hooks/use-i18n";
import { useProfileService } from "@/hooks/use-profile-service";
import {
  DEFAULT_USER_CACHE_TTL_MS,
  PERSISTENT_USER_CACHE_MAX_STALE_MS,
  readUserCacheWithStale,
  sanitizeDashboardSummaryForCache,
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
  const { t } = useI18n();
  const isMobile = useIsMobileViewport();
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
          const cacheableSummary = sanitizeDashboardSummaryForCache(summary);
          writeUserCache(cacheOwnerId, "dashboard-summary", cacheableSummary, {
            persist: "session",
          });
          writeUserCache(cacheOwnerId, "children", cacheableSummary.children, {
            persist: "session",
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
        <StatusMessage
          title={t("parent.dashboard.loadErrorTitle")}
          tone="error"
        >
          {t("auth.errors.generic")}
        </StatusMessage>
        <Button
          className="w-full px-4 py-2.5 sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          {t("common.actions.retry")}
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
  const summarySource =
    state.status === "ready" ? state.summarySource : undefined;

  const handleSelectChild = (child: ChildProfileDTO) => {
    selectChild(child.id);
    setValidatedSelectedChild(child);
    setSelectionPrompt(false);
    if (searchParams.toString()) replace("/dashboard");
  };

  if (isMobile) {
    return (
      <MobileDashboard
        profiles={children}
        selectedChild={selectedChild}
        latestSessionForSelected={latestSessionForSelected}
        summarySource={summarySource}
        isLoading={isLoading}
        selectionRequired={selectionRequired}
        invalidSelection={invalidSelection}
        selectionSectionRef={selectionSectionRef}
        onSelectChild={handleSelectChild}
        onReadingAction={handleReadingAction}
      />
    );
  }

  return (
    <section className="family-dashboard">
      <header className="family-title">
        <h1 className="book-title">{t("parent.dashboard.familyTitle")}</h1>
        <Link href="/children" className="family-inline-link min-h-12">
          <UsersRound aria-hidden="true" size={16} />{" "}
          {t("parent.dashboard.manageProfiles")}
        </Link>
      </header>
      <div className="family-spread">
        <FamilyReadingDesk
          key={selectedChild?.id ?? "family"}
          child={selectedChild}
          hasProfiles={children.length > 0}
          isLoadingProfiles={isLoading}
          latestSession={latestSessionForSelected}
          summarySource={summarySource}
          onChooseBook={() => handleReadingAction("/books")}
        />
        <section
          id="child-selection"
          ref={selectionSectionRef}
          tabIndex={-1}
          aria-labelledby="child-selection-title"
          aria-busy={isLoading ? "true" : undefined}
          className={
            "family-profiles order-1 sm:order-2" +
            (selectionRequired ? " family-profiles-prompt" : "")
          }
        >
          <h2 id="child-selection-title">
            {t("parent.dashboard.selectChildHeading")}
          </h2>
          {selectionRequired && children.length > 0 ? (
            <p role="status" className="family-selection-notice">
              {invalidSelection
                ? t("parent.dashboard.invalidSelectionNotice")
                : t("parent.dashboard.missingSelectionNotice")}
            </p>
          ) : null}
          {isLoading ? (
            <div
              className="family-profile-list"
              aria-label={t("parent.dashboard.loadingChildrenAria")}
            >
              <span className="sr-only" role="status">
                {t("common.states.loading")}
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
                    onSelect={() => handleSelectChild(child)}
                  />
                ))}
              </div>
              <Link
                href="/children/new"
                className="family-inline-link min-h-12"
              >
                <Plus aria-hidden="true" size={16} />{" "}
                {t("parent.dashboard.createChildLink")}
              </Link>
            </>
          ) : (
            <p className="text-body text-muted">
              {t("parent.dashboard.emptyChildrenDescription")}
            </p>
          )}
        </section>
      </div>

      {!isLoading && children.length > 0 ? (
        <section
          aria-labelledby="reading-actions-title"
          className="family-tools"
        >
          <div className="family-tools-heading">
            <h2 id="reading-actions-title">
              {t("parent.dashboard.readingActionsTitle")}
            </h2>
            <Link
              href={
                selectedChild
                  ? `/sessions?childId=${encodeURIComponent(selectedChild.id)}`
                  : "/sessions"
              }
              className="family-inline-link min-h-12"
            >
              <History aria-hidden="true" size={16} />{" "}
              {t("parent.dashboard.readingHistoryLink")}
            </Link>
          </div>
          <div className="family-tool-list">
            <button
              type="button"
              aria-label={t("parent.dashboard.scanBookTitle")}
              onClick={() => handleReadingAction("/book-scanner")}
            >
              <Camera aria-hidden="true" />
              <span className="min-w-0">
                <strong>{t("parent.dashboard.scanBookTitle")}</strong>
                <small>{t("parent.dashboard.scanBookDesc")}</small>
              </span>
              <ArrowUpRight aria-hidden="true" className="viread-rtl-flip" />
            </button>
            <button
              type="button"
              aria-label={t("parent.dashboard.entertainmentTitle")}
              onClick={() => handleReadingAction("/entertainment")}
            >
              <Music2 aria-hidden="true" />
              <span className="min-w-0">
                <strong>{t("parent.dashboard.entertainmentTitle")}</strong>
                <small>{t("parent.dashboard.entertainmentDesc")}</small>
              </span>
              <ArrowUpRight aria-hidden="true" className="viread-rtl-flip" />
            </button>
            <Link
              href={
                selectedChild
                  ? `/reports?childId=${encodeURIComponent(selectedChild.id)}`
                  : "/reports"
              }
            >
              <BarChart3 aria-hidden="true" />
              <span className="min-w-0">
                <strong>{t("parent.dashboard.progressTitle")}</strong>
                <small>{t("parent.dashboard.progressDesc")}</small>
              </span>
              <ArrowUpRight aria-hidden="true" className="viread-rtl-flip" />
            </Link>
          </div>
        </section>
      ) : null}
    </section>
  );
}
