"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  ACTOR_SWITCH_BROADCAST_KEY,
  buildTaskActorCacheKey,
  clearGlobalTasksMemoryCache,
  createGlobalTasksService,
  getCachedGlobalTasksSnapshot,
  setCachedGlobalTasksSnapshot,
  STUDIO_TASKS_CHANGED_EVENT,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import {
  acknowledgeTaskAlerts,
  computeUnreadTaskAlertCounts,
  EMPTY_TASK_ALERT_ACK_STATE,
  getTaskAlertAckState,
  resetTaskAlertAckMemoryCache,
  subscribeTaskAlertAck,
} from "@/lib/tasks/task-alert-acknowledgment";
import {
  ACTIVE_GLOBAL_TASK_STATUSES,
  type GlobalTaskActorRole,
  type GlobalTaskItem,
  type GlobalTaskListResponse,
  type StudioTasksChangedDetail,
} from "@/types/global-tasks";

export interface AiTaskCenterContextValue {
  readonly scopeKey: string | null;
  readonly actorId: string | null;
  readonly actorRole: GlobalTaskActorRole | null;
  readonly tasks: readonly GlobalTaskItem[];
  readonly activeCount: number;
  readonly waitingReviewCount: number;
  readonly failedCount: number;
  readonly completedCount: number;
  readonly unreadWaitingReviewCount: number;
  readonly unreadFailedCount: number;
  readonly unreadCompletedCount: number;
  readonly unreadAlertCount: number;
  readonly workerOnline: boolean | null;
  readonly isOpen: boolean;
  readonly isRefreshing: boolean;
  readonly pendingActionJobIds: ReadonlySet<string>;
  readonly errorMessage: string | null;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly togglePanel: () => void;
  readonly markAllAlertsSeen: () => void;
  readonly markTaskAlertSeen: (taskOrId: GlobalTaskItem | string) => void;
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
  /** Resolve current authenticated user ID from browser Supabase session (e.g. fallback outside SSR layout). */
  readonly resolveSessionActor?: boolean;
  readonly service?: GlobalTasksService;
  readonly enabled?: boolean;
  /** When false, defers initial background GET until panel opens, cache exists, or task event fires. */
  readonly autoSyncOnMount?: boolean;
  readonly children: ReactNode;
}

const MIN_POLL_MS = 2500;
const MAX_POLL_MS = 15000;
const DEFAULT_ACTIVE_POLL_MS = 4000;
const EMPTY_TASKS: readonly GlobalTaskItem[] = [];

function clampPollMs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ACTIVE_POLL_MS;
  }
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Math.round(value)));
}

/**
 * Defense-in-depth scope check: reject any snapshot whose actor_id, actor_role,
 * or portal does not match the active portal/user, and filter tasks + recompute counts.
 */
export function sanitizeScopedTaskFeed(
  data: GlobalTaskListResponse,
  expectedActorId: string,
  expectedRole: GlobalTaskActorRole,
): GlobalTaskListResponse | null {
  const trimmedActorId = expectedActorId.trim();
  if (!trimmedActorId) return null;
  if (data.actor_id !== trimmedActorId) return null;
  if (data.actor_role !== expectedRole) return null;
  if (data.portal && data.portal !== expectedRole) return null;

  const filteredTasks = data.tasks.filter((task) => {
    if (task.actor_role !== expectedRole) return false;
    if (task.portal && task.portal !== expectedRole) return false;
    if (task.actor_id && task.actor_id !== trimmedActorId) return false;
    return true;
  });

  const activeCount = filteredTasks.filter((task) =>
    ACTIVE_GLOBAL_TASK_STATUSES.has(task.status),
  ).length;
  const waitingReviewCount = filteredTasks.filter(
    (task) => task.status === "WAITING_FOR_REVIEW",
  ).length;
  const failedCount = filteredTasks.filter(
    (task) => task.status === "FAILED" || task.status === "PARTIAL_SUCCESS",
  ).length;
  const completedCount = filteredTasks.filter(
    (task) => task.status === "SUCCEEDED",
  ).length;

  return {
    ...data,
    portal: expectedRole,
    tasks: filteredTasks,
    active_count: activeCount,
    waiting_review_count: waitingReviewCount,
    failed_count: failedCount,
    completed_count: completedCount,
  };
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

  // Optionally resolve actor ID from Supabase browser auth when mounted outside SSR layout.
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

  // Cross-tab logout / actor switch listener: immediately clear in-memory task feed.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function handleStorage(event: StorageEvent) {
      if (event.key !== ACTOR_SWITCH_BROADCAST_KEY) return;
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
      clearGlobalTasksMemoryCache();
      resetTaskAlertAckMemoryCache();
      setFeedState({
        scopeKey: null,
        data: null,
        error: null,
        isRefreshing: false,
      });
      setPanelState({ scopeKey: null, open: false });
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

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
        const rawData = await resolvedService.listTasks({
          portal: targetRole,
          limit: 40,
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          latestScopeRef.current !== targetScope
        ) {
          return;
        }
        const sanitized = sanitizeScopedTaskFeed(
          rawData,
          targetActorId,
          targetRole,
        );
        if (!sanitized) {
          // Scope mismatch (e.g. token switched mid-flight): discard cleanly & wipe cache.
          clearGlobalTasksMemoryCache();
          setFeedState({
            scopeKey: targetScope,
            data: null,
            error: null,
            isRefreshing: false,
          });
          return;
        }
        setCachedGlobalTasksSnapshot(targetActorId, targetRole, sanitized);
        setFeedState({
          scopeKey: targetScope,
          data: sanitized,
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
      return sanitizeScopedTaskFeed(
        feedState.data,
        effectiveActorId,
        actorRole,
      );
    }
    const cached = getCachedGlobalTasksSnapshot(effectiveActorId, actorRole);
    return cached
      ? sanitizeScopedTaskFeed(cached, effectiveActorId, actorRole)
      : null;
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
        .listTasks({
          portal: targetRole,
          limit: 40,
          signal: controller.signal,
        })
        .then((rawData) => {
          if (
            !isActive ||
            controller.signal.aborted ||
            latestScopeRef.current !== targetScope
          ) {
            return;
          }
          const sanitized = sanitizeScopedTaskFeed(
            rawData,
            targetActorId,
            targetRole,
          );
          if (!sanitized) {
            clearGlobalTasksMemoryCache();
            setFeedState({
              scopeKey: targetScope,
              data: null,
              error: null,
              isRefreshing: false,
            });
            return;
          }
          setCachedGlobalTasksSnapshot(targetActorId, targetRole, sanitized);
          setFeedState({
            scopeKey: targetScope,
            data: sanitized,
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
      const detail = (
        event as CustomEvent<StudioTasksChangedDetail | undefined>
      ).detail;
      if (detail?.source === "ai-task-center-provider") {
        return;
      }
      if (detail?.portal && detail.portal !== targetRole) {
        return;
      }
      if (detail?.actorId && detail.actorId !== targetActorId) {
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

  const scopedTasks = scopedData?.tasks ?? EMPTY_TASKS;
  const isOpen = Boolean(
    scopeKey && panelState.scopeKey === scopeKey && panelState.open,
  );

  const subscribeAck = useCallback(
    (onStoreChange: () => void) =>
      subscribeTaskAlertAck(scopeKey, effectiveActorId, actorRole, onStoreChange),
    [actorRole, effectiveActorId, scopeKey],
  );
  const getAckSnapshot = useCallback(
    () => getTaskAlertAckState(scopeKey, effectiveActorId, actorRole),
    [actorRole, effectiveActorId, scopeKey],
  );
  const ackState = useSyncExternalStore(
    subscribeAck,
    getAckSnapshot,
    () => EMPTY_TASK_ALERT_ACK_STATE,
  );

  const unreadCounts = useMemo(
    () => computeUnreadTaskAlertCounts(scopedTasks, ackState),
    [ackState, scopedTasks],
  );

  const markAllAlertsSeen = useCallback(() => {
    if (!scopeKey || scopedTasks.length === 0) return;
    acknowledgeTaskAlerts(scopeKey, scopedTasks, effectiveActorId, actorRole);
  }, [actorRole, effectiveActorId, scopeKey, scopedTasks]);

  const markTaskAlertSeen = useCallback(
    (taskOrId: GlobalTaskItem | string) => {
      if (!scopeKey) return;
      const targetTask =
        typeof taskOrId === "string"
          ? scopedTasks.find((item) => item.id === taskOrId)
          : taskOrId;
      if (!targetTask) return;
      acknowledgeTaskAlerts(
        scopeKey,
        [targetTask],
        effectiveActorId,
        actorRole,
      );
    },
    [actorRole, effectiveActorId, scopeKey, scopedTasks],
  );

  // While the AI Task Center drawer is open and visible, acknowledge any alert
  // tasks that load asynchronously or complete while the user is reading them.
  useEffect(() => {
    if (!isOpen || !scopeKey || scopedTasks.length === 0) {
      return;
    }
    const acknowledgeIfVisible = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      acknowledgeTaskAlerts(scopeKey, scopedTasks, effectiveActorId, actorRole);
    };
    acknowledgeIfVisible();
    if (typeof document === "undefined") {
      return;
    }
    document.addEventListener("visibilitychange", acknowledgeIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", acknowledgeIfVisible);
    };
  }, [actorRole, effectiveActorId, isOpen, scopeKey, scopedTasks]);

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
      markTaskAlertSeen(jobId);
      setPendingActionIds((prev) => new Set(prev).add(jobId));
      try {
        await resolvedService.retryTask(jobId, { portal: actorRole });
        await fetchTasksForScope(scopeKey, effectiveActorId, actorRole);
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent<StudioTasksChangedDetail>(
              STUDIO_TASKS_CHANGED_EVENT,
              {
                detail: {
                  source: "ai-task-center-provider",
                  actorId: effectiveActorId,
                  portal: actorRole,
                },
              },
            ),
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
      markTaskAlertSeen,
      resolvedService,
      scopeKey,
    ],
  );

  const cancelTask = useCallback(
    async (jobId: string) => {
      if (!scopeKey || !effectiveActorId || !actorRole) return;
      markTaskAlertSeen(jobId);
      setPendingActionIds((prev) => new Set(prev).add(jobId));
      try {
        await resolvedService.cancelTask(jobId, { portal: actorRole });
        await fetchTasksForScope(scopeKey, effectiveActorId, actorRole);
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent<StudioTasksChangedDetail>(
              STUDIO_TASKS_CHANGED_EVENT,
              {
                detail: {
                  source: "ai-task-center-provider",
                  actorId: effectiveActorId,
                  portal: actorRole,
                },
              },
            ),
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
      markTaskAlertSeen,
      resolvedService,
      scopeKey,
    ],
  );

  const openPanel = useCallback(() => {
    if (!scopeKey) return;
    markAllAlertsSeen();
    setPanelState({ scopeKey, open: true });
    if (effectiveActorId && actorRole) {
      void fetchTasksForScope(scopeKey, effectiveActorId, actorRole);
    }
  }, [
    actorRole,
    effectiveActorId,
    fetchTasksForScope,
    markAllAlertsSeen,
    scopeKey,
  ]);

  const closePanel = useCallback(() => {
    markAllAlertsSeen();
    setPanelState({ scopeKey, open: false });
  }, [markAllAlertsSeen, scopeKey]);

  const togglePanel = useCallback(() => {
    if (!scopeKey) return;
    const nextOpen = !isOpen;
    markAllAlertsSeen();
    setPanelState({ scopeKey, open: nextOpen });
    if (nextOpen && effectiveActorId && actorRole) {
      void fetchTasksForScope(scopeKey, effectiveActorId, actorRole);
    }
  }, [
    actorRole,
    effectiveActorId,
    fetchTasksForScope,
    isOpen,
    markAllAlertsSeen,
    scopeKey,
  ]);

  const clearForLogout = useCallback(() => {
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    clearGlobalTasksMemoryCache();
    resetTaskAlertAckMemoryCache();
    setFeedState({
      scopeKey: null,
      data: null,
      error: null,
      isRefreshing: false,
    });
    setPanelState({ scopeKey: null, open: false });
  }, []);

  const errorMessage =
    scopeKey && feedState.scopeKey === scopeKey ? feedState.error : null;
  const isRefreshing = Boolean(
    scopeKey && feedState.scopeKey === scopeKey && feedState.isRefreshing,
  );

  const contextValue = useMemo<AiTaskCenterContextValue>(
    () => ({
      scopeKey,
      actorId: effectiveActorId,
      actorRole,
      tasks: scopedTasks,
      activeCount,
      waitingReviewCount: scopedData?.waiting_review_count ?? 0,
      failedCount: scopedData?.failed_count ?? 0,
      completedCount: scopedData?.completed_count ?? 0,
      unreadWaitingReviewCount: unreadCounts.unreadWaitingReviewCount,
      unreadFailedCount: unreadCounts.unreadFailedCount,
      unreadCompletedCount: unreadCounts.unreadCompletedCount,
      unreadAlertCount: unreadCounts.unreadAlertCount,
      workerOnline: scopedData?.worker_online ?? null,
      isOpen,
      isRefreshing,
      pendingActionJobIds: pendingActionIds,
      errorMessage,
      openPanel,
      closePanel,
      togglePanel,
      markAllAlertsSeen,
      markTaskAlertSeen,
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
      effectiveActorId,
      errorMessage,
      isOpen,
      isRefreshing,
      markAllAlertsSeen,
      markTaskAlertSeen,
      openPanel,
      pendingActionIds,
      refresh,
      retryTask,
      scopeKey,
      scopedData?.completed_count,
      scopedData?.failed_count,
      scopedData?.waiting_review_count,
      scopedData?.worker_online,
      scopedTasks,
      togglePanel,
      unreadCounts.unreadAlertCount,
      unreadCounts.unreadCompletedCount,
      unreadCounts.unreadFailedCount,
      unreadCounts.unreadWaitingReviewCount,
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
