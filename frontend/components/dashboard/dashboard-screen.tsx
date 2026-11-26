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
          className="sm:w-auto sm:self-start sm:px-8"
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

  return (
    <section className="family-dashboard">
      <header className="family-title">
        <h1 className="book-title">{t("parent.dashboard.familyTitle")}</h1>
        <Link href="/children" className="family-inline-link min-h-12">
          <UsersRound aria-hidden="true" size={17} />{" "}
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
                <Plus aria-hidden="true" size={17} />{" "}
                {t("parent.dashboard.createChildLink")}
              </Link>
            </>
          ) : (
            <p className="text-muted">
              {t("parent.dashboard.emptyChildrenDescription")}
            </p>
          )}
        </section>
      </div>

      {!isLoading && children.length > 0 ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2.5 md:hidden">
            <Link
              className="flex min-h-12 items-center gap-2 rounded-card border border-border bg-white px-3 py-3 text-sm font-bold text-ink shadow-xs transition-colors hover:bg-sky/40 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
              <span className="truncate">
                {t("parent.dashboard.recentProgressLink")}
              </span>
            </Link>
            <Link
              className="flex min-h-12 items-center gap-2 rounded-card border border-border bg-white px-3 py-3 text-sm font-bold text-ink shadow-xs transition-colors hover:bg-warning-surface/50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
              <span className="truncate">
                {t("parent.dashboard.difficultWordsLink")}
              </span>
            </Link>
          </div>

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
                <span>
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
                <span>
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
                <span>
                  <strong>{t("parent.dashboard.progressTitle")}</strong>
                  <small>{t("parent.dashboard.progressDesc")}</small>
                </span>
                <ArrowUpRight aria-hidden="true" className="viread-rtl-flip" />
              </Link>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
