"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  buildTaskActorCacheKey,
  clearGlobalTasksMemoryCache,
  createGlobalTasksService,
  getCachedGlobalTasksSnapshot,
  setCachedGlobalTasksSnapshot,
  STUDIO_TASKS_CHANGED_EVENT,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import type {
  GlobalTaskActorRole,
  GlobalTaskItem,
  GlobalTaskListResponse,
} from "@/types/global-tasks";

export interface AiTaskCenterContextValue {
  readonly scopeKey: string | null;
  readonly actorRole: GlobalTaskActorRole | null;
  readonly tasks: readonly GlobalTaskItem[];
  readonly activeCount: number;
  readonly waitingReviewCount: number;
  readonly failedCount: number;
  readonly completedCount: number;
  readonly workerOnline: boolean | null;
  readonly isOpen: boolean;
  readonly isRefreshing: boolean;
  readonly pendingActionJobIds: ReadonlySet<string>;
  readonly errorMessage: string | null;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly togglePanel: () => void;
  readonly refresh: () => Promise<void>;
  readonly retryTask: (jobId: string) => Promise<void>;
  readonly cancelTask: (jobId: string) => Promise<void>;
  readonly clearForLogout: () => void;
}

export const AiTaskCenterContext =
  createContext<AiTaskCenterContextValue | null>(null);

interface FeedState {
  readonly scopeKey: string | null;
  readonly data: GlobalTaskListResponse | null;
  readonly error: string | null;
  readonly isRefreshing: boolean;
}

interface PanelState {
  readonly scopeKey: string | null;
  readonly open: boolean;
}

export interface AiTaskCenterProviderProps {
  readonly actorId?: string | null;
  readonly actorRole?: GlobalTaskActorRole | null;
  /** Resolve current authenticated user ID from browser Supabase session (e.g. Admin layout). */
  readonly resolveSessionActor?: boolean;
  readonly service?: GlobalTasksService;
  readonly enabled?: boolean;
  /** When false, defers initial background GET /studio/tasks until panel opens, cache exists, or task event fires. */
  readonly autoSyncOnMount?: boolean;
  readonly children: ReactNode;
}

const MIN_POLL_MS = 2500;
const MAX_POLL_MS = 15000;
const DEFAULT_ACTIVE_POLL_MS = 4000;

function clampPollMs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ACTIVE_POLL_MS;
  }
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Math.round(value)));
}

export function AiTaskCenterProvider({
  actorId,
  actorRole = null,
  resolveSessionActor = false,
  service,
  enabled = true,
  autoSyncOnMount = true,
  children,
}: AiTaskCenterProviderProps) {
  const resolvedService = useMemo(
    () => service ?? createGlobalTasksService(),
    [service],
  );

  const [sessionActorId, setSessionActorId] = useState<string | null>(null);
  const effectiveActorId =
    actorId !== undefined
      ? actorId
      : resolveSessionActor
        ? sessionActorId
        : null;
  const scopeKey = enabled
    ? buildTaskActorCacheKey(effectiveActorId, actorRole)
    : null;

  const [feedState, setFeedState] = useState<FeedState>({
    scopeKey: null,
    data: null,
    error: null,
    isRefreshing: false,
  });
  const [panelState, setPanelState] = useState<PanelState>({
    scopeKey: null,
    open: false,
  });
  const [pendingActionIds, setPendingActionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const prevScopeKeyRef = useRef<string | null>(scopeKey);
  const activeAbortRef = useRef<AbortController | null>(null);
  const latestScopeRef = useRef<string | null>(scopeKey);

  // Optionally resolve actor ID from Supabase browser auth when mounted outside AuthRuntimeContext.
  useEffect(() => {
    if (!resolveSessionActor || actorId !== undefined || !enabled) {
      return;
    }
    let mounted = true;
    let unsubscribe: (() => void) | undefined;

    try {
      const supabase = createBrowserSupabaseClient();
      const auth = supabase.auth as unknown as {
        getSession?: () => Promise<{
          data?: { session?: { user?: { id?: string | null } | null } | null };
        }>;
        onAuthStateChange?: (
          cb: (
            event: string,
            session: { user?: { id?: string | null } | null } | null,
          ) => void,
        ) => { data?: { subscription?: { unsubscribe?: () => void } } };
      };

      if (typeof auth.getSession === "function") {
        void auth
          .getSession()
          .then((res) => {
            if (!mounted) return;
            const nextId = res?.data?.session?.user?.id ?? null;
            setSessionActorId(nextId);
          })
          .catch(() => {
            if (mounted) setSessionActorId(null);
          });
      }

      if (typeof auth.onAuthStateChange === "function") {
        const sub = auth.onAuthStateChange((event, session) => {
          if (!mounted) return;
          const nextId =
            event === "SIGNED_OUT" ? null : (session?.user?.id ?? null);
          if (!nextId) {
            clearGlobalTasksMemoryCache();
          }
          setSessionActorId(nextId);
        });
        unsubscribe = sub?.data?.subscription?.unsubscribe;
      }
    } catch {
      // Missing Supabase browser env in isolated unit tests: stay quietly idle.
    }

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [actorId, enabled, resolveSessionActor]);

  // Wipe actor-scoped memory cache whenever actor logs out or switches accounts (no sync setState).
  useEffect(() => {
    latestScopeRef.current = scopeKey;
    if (prevScopeKeyRef.current !== scopeKey) {
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
      if (prevScopeKeyRef.current !== null) {
        clearGlobalTasksMemoryCache();
      }
      prevScopeKeyRef.current = scopeKey;
    }
  }, [scopeKey]);

  const fetchTasksForScope = useCallback(
    async (
      targetScope: string,
      targetActorId: string,
      targetRole: GlobalTaskActorRole,
    ) => {
      activeAbortRef.current?.abort();
      const controller = new AbortController();
      activeAbortRef.current = controller;

      try {
        const data = await resolvedService.listTasks({
          limit: 40,
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          latestScopeRef.current !== targetScope
        ) {
          return;
        }
        setCachedGlobalTasksSnapshot(targetActorId, targetRole, data);
        setFeedState({
          scopeKey: targetScope,
          data,
          error: null,
          isRefreshing: false,
        });
      } catch (err) {
        if (
          controller.signal.aborted ||
          latestScopeRef.current !== targetScope
        ) {
          return;
        }
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Chưa tải được danh sách tác vụ AI.";
        setFeedState((prev) => ({
          scopeKey: targetScope,
          data: prev.scopeKey === targetScope ? prev.data : null,
          error: message,
          isRefreshing: false,
        }));
      }
    },
    [resolvedService],
  );

  // Derive scoped data cleanly during render so logout/actor switch clears UI instantaneously!
  const scopedData: GlobalTaskListResponse | null = useMemo(() => {
    if (!scopeKey || !effectiveActorId || !actorRole) {
      return null;
    }
    if (feedState.scopeKey === scopeKey && feedState.data) {
      return feedState.data;
    }
    return getCachedGlobalTasksSnapshot(effectiveActorId, actorRole);
  }, [
    actorRole,
    effectiveActorId,
    feedState.data,
    feedState.scopeKey,
    scopeKey,
  ]);

  const activeCount = scopedData?.active_count ?? 0;
  const recommendedPollMs = scopedData?.recommended_poll_ms ?? null;

  // Initial sync + lifecycle re-sync on visibilitychange / focus / viread:android-resume.
  useEffect(() => {
    if (!scopeKey || !effectiveActorId || !actorRole) {
      return;
    }
    const targetScope = scopeKey;
    const targetActorId = effectiveActorId;
    const targetRole = actorRole;
    let isActive = true;

    const triggerSync = () => {
      activeAbortRef.current?.abort();
      const controller = new AbortController();
      activeAbortRef.current = controller;
      void resolvedService
        .listTasks({ limit: 40, signal: controller.signal })
        .then((data) => {
          if (
            !isActive ||
            controller.signal.aborted ||
            latestScopeRef.current !== targetScope
          ) {
            return;
          }
          setCachedGlobalTasksSnapshot(targetActorId, targetRole, data);
          setFeedState({
            scopeKey: targetScope,
            data,
            error: null,
            isRefreshing: false,
          });
        })
        .catch((err: unknown) => {
          if (!isActive || latestScopeRef.current !== targetScope) {
            return;
          }
          if (err instanceof DOMException && err.name === "AbortError") {
            return;
          }
          const message =
            err instanceof Error && err.message
              ? err.message
              : "Chưa tải được danh sách tác vụ AI.";
          setFeedState((prev) => ({
            scopeKey: targetScope,
            data: prev.scopeKey === targetScope ? prev.data : null,
            error: message,
            isRefreshing: false,
          }));
        });
    };

    const hasCachedSnapshot =
      getCachedGlobalTasksSnapshot(targetActorId, targetRole) !== null;
    if (autoSyncOnMount || hasCachedSnapshot || panelState.open) {
      triggerSync();
    }

    const handledResumeEvents = new WeakSet<Event>();

    function handleResumeSync() {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      const hasLiveCache =
        getCachedGlobalTasksSnapshot(targetActorId, targetRole) !== null;
      if (autoSyncOnMount || hasLiveCache || panelState.open) {
        triggerSync();
      }
    }

    function handleAndroidResume(event: Event) {
      if (handledResumeEvents.has(event)) {
        return;
      }
      handledResumeEvents.add(event);
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      // Always refresh immediately when Android WebView resumes from background.
      triggerSync();
    }

    function handleTaskChanged(event: Event) {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source === "ai-task-center-provider") {
        return;
      }
      triggerSync();
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleResumeSync);
      document.addEventListener("viread:android-resume", handleAndroidResume);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleResumeSync);
      window.addEventListener("viread:android-resume", handleAndroidResume);
      window.addEventListener(STUDIO_TASKS_CHANGED_EVENT, handleTaskChanged);
    }

    return () => {
      isActive = false;
      activeAbortRef.current?.abort();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleResumeSync);
        document.removeEventListener(
          "viread:android-resume",
          handleAndroidResume,
        );
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleResumeSync);
        window.removeEventListener(
          "viread:android-resume",
          handleAndroidResume,
        );
        window.removeEventListener(
          STUDIO_TASKS_CHANGED_EVENT,
          handleTaskChanged,
        );
      }
    };
  }, [
    actorRole,
    autoSyncOnMount,
    effectiveActorId,
    panelState.open,
    resolvedService,
    scopeKey,
  ]);

  // Adaptive polling ONLY while active jobs exist AND tab is visible!
  useEffect(() => {
    if (!scopeKey || !effectiveActorId || !actorRole || activeCount <= 0) {
      return;
    }
    const targetScope = scopeKey;
    const targetActorId = effectiveActorId;
    const targetRole = actorRole;
    const intervalMs = clampPollMs(recommendedPollMs);
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleNext = () => {
      if (disposed) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      timerId = setTimeout(() => {
        if (disposed) return;
        if (
          typeof document !== "undefined" &&
          document.visibilityState === "hidden"
        ) {
          return;
        }
        void fetchTasksForScope(targetScope, targetActorId, targetRole).finally(
          () => {
            if (!disposed) {
              scheduleNext();
            }
          },
        );
      }, intervalMs);
    };

    const handleVisibilityChange = () => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "hidden"
      ) {
        scheduleNext();
      }
    };

    scheduleNext();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      disposed = true;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
    };
  }, [
    activeCount,
    actorRole,
    effectiveActorId,
    fetchTasksForScope,
    recommendedPollMs,
    scopeKey,
  ]);

  const refresh = useCallback(async () => {
    if (!scopeKey || !effectiveActorId || !actorRole) return;
    setFeedState((prev) => ({
      scopeKey,
      data: prev.scopeKey === scopeKey ? prev.data : scopedData,
      error: null,
      isRefreshing: true,
    }));
    await fetchTasksForScope(scopeKey, effectiveActorId, actorRole);
  }, [actorRole, effectiveActorId, fetchTasksForScope, scopeKey, scopedData]);

  const retryTask = useCallback(
    async (jobId: string) => {
      if (!scopeKey || !effectiveActorId || !actorRole) return;
      setPendingActionIds((prev) => new Set(prev).add(jobId));
      try {
        await resolvedService.retryTask(jobId);
        await fetchTasksForScope(scopeKey, effectiveActorId, actorRole);
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent(STUDIO_TASKS_CHANGED_EVENT, {
              detail: { source: "ai-task-center-provider" },
            }),
          );
        }
      } finally {
        setPendingActionIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [
      actorRole,
      effectiveActorId,
      fetchTasksForScope,
      resolvedService,
      scopeKey,
    ],
  );

  const cancelTask = useCallback(
    async (jobId: string) => {
      if (!scopeKey || !effectiveActorId || !actorRole) return;
      setPendingActionIds((prev) => new Set(prev).add(jobId));
      try {
        await resolvedService.cancelTask(jobId);
        await fetchTasksForScope(scopeKey, effectiveActorId, actorRole);
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent(STUDIO_TASKS_CHANGED_EVENT, {
              detail: { source: "ai-task-center-provider" },
            }),
          );
        }
      } finally {
        setPendingActionIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [
      actorRole,
      effectiveActorId,
      fetchTasksForScope,
      resolvedService,
      scopeKey,
    ],
  );

  const openPanel = useCallback(() => {
    if (!scopeKey) return;
    setPanelState({ scopeKey, open: true });
    if (effectiveActorId && actorRole) {
      void fetchTasksForScope(scopeKey, effectiveActorId, actorRole);
    }
  }, [actorRole, effectiveActorId, fetchTasksForScope, scopeKey]);

  const closePanel = useCallback(() => {
    setPanelState({ scopeKey, open: false });
  }, [scopeKey]);

  const togglePanel = useCallback(() => {
    if (!scopeKey) return;
    setPanelState((prev) => {
      const nextOpen = !(prev.scopeKey === scopeKey && prev.open);
      if (nextOpen && effectiveActorId && actorRole) {
        void fetchTasksForScope(scopeKey, effectiveActorId, actorRole);
      }
      return { scopeKey, open: nextOpen };
    });
  }, [actorRole, effectiveActorId, fetchTasksForScope, scopeKey]);

  const clearForLogout = useCallback(() => {
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    clearGlobalTasksMemoryCache();
    setFeedState({
      scopeKey: null,
      data: null,
      error: null,
      isRefreshing: false,
    });
    setPanelState({ scopeKey: null, open: false });
  }, []);

  const isOpen = Boolean(
    scopeKey && panelState.scopeKey === scopeKey && panelState.open,
  );
  const errorMessage =
    scopeKey && feedState.scopeKey === scopeKey ? feedState.error : null;
  const isRefreshing = Boolean(
    scopeKey && feedState.scopeKey === scopeKey && feedState.isRefreshing,
  );

  const contextValue = useMemo<AiTaskCenterContextValue>(
    () => ({
      scopeKey,
      actorRole,
      tasks: scopedData?.tasks ?? [],
      activeCount,
      waitingReviewCount: scopedData?.waiting_review_count ?? 0,
      failedCount: scopedData?.failed_count ?? 0,
      completedCount: scopedData?.completed_count ?? 0,
      workerOnline: scopedData?.worker_online ?? null,
      isOpen,
      isRefreshing,
      pendingActionJobIds: pendingActionIds,
      errorMessage,
      openPanel,
      closePanel,
      togglePanel,
      refresh,
      retryTask,
      cancelTask,
      clearForLogout,
    }),
    [
      activeCount,
      actorRole,
      cancelTask,
      clearForLogout,
      closePanel,
      errorMessage,
      isOpen,
      isRefreshing,
      openPanel,
      pendingActionIds,
      refresh,
      retryTask,
      scopeKey,
      scopedData?.completed_count,
      scopedData?.failed_count,
      scopedData?.tasks,
      scopedData?.waiting_review_count,
      scopedData?.worker_online,
      togglePanel,
    ],
  );

  return (
    <AiTaskCenterContext.Provider value={contextValue}>
      {children}
    </AiTaskCenterContext.Provider>
  );
}

export function useOptionalAiTaskCenter(): AiTaskCenterContextValue | null {
  return useContext(AiTaskCenterContext);
}

export function useAiTaskCenter(): AiTaskCenterContextValue {
  const ctx = useContext(AiTaskCenterContext);
  if (!ctx) {
    throw new Error(
      "useAiTaskCenter must be used within an AiTaskCenterProvider",
    );
  }
  return ctx;
}
