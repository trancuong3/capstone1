"use client";

import { Bot, ChevronLeft, EyeOff, Loader2, X } from "lucide-react";
import dynamic, { type DynamicOptionsLoadingProps } from "next/dynamic";
import { usePathname } from "next/navigation";
import {
  Component,
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

import { Skeleton } from "@/components/common/skeleton";
import { useI18n } from "@/hooks/use-i18n";
import {
  hasMobileBottomNavPath,
  inferAssistantRoleScope,
  isAdminPath,
  isReadingSessionPath,
} from "@/lib/assistant/route-helpers";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import type {
  AssistantMessage,
  AssistantRoleScope,
  AssistantVisibilityState,
} from "@/types/assistant";

const VISIBILITY_STORAGE_KEY = "viread:assistant:visibility";
const OPEN_ASSISTANT_EVENT = "viread:assistant:open";
const PREFS_CHANGE_EVENT = "viread:assistant:prefs-changed";

export function openViReadAssistant(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_EVENT));
}

function readStoredVisibilitySnapshot(): "hidden" | "minimized" {
  try {
    const raw = window.localStorage.getItem(VISIBILITY_STORAGE_KEY);
    return raw === "hidden" ? "hidden" : "minimized";
  } catch {
    return "minimized";
  }
}

function writeStoredVisibility(state: "hidden" | "minimized"): void {
  try {
    window.localStorage.setItem(VISIBILITY_STORAGE_KEY, state);
    window.dispatchEvent(new CustomEvent(PREFS_CHANGE_EVENT));
  } catch {
    // Ignore storage errors (private browsing / quota restrictions).
  }
}

function subscribePrefsStore(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === VISIBILITY_STORAGE_KEY) {
      onStoreChange();
    }
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(PREFS_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(PREFS_CHANGE_EVENT, onStoreChange);
  };
}

function resolvePanelPositionClass(
  isReadingRoute: boolean,
  isAdminRoute: boolean,
  hasBottomNav: boolean,
): string {
  return isReadingRoute
    ? "top-[7.25rem] end-2 sm:end-4"
    : hasBottomNav
      ? isAdminRoute
        ? "bottom-[calc(4.75rem+env(safe-area-inset-bottom))] end-3 lg:bottom-4 lg:end-4"
        : "bottom-[calc(4.75rem+env(safe-area-inset-bottom))] end-3 xl:bottom-4 xl:end-4"
      : "bottom-4 end-4";
}

interface AssistantDynamicFallbackContextValue {
  readonly onClose: () => void;
  readonly positionClass: string;
  readonly consumeRetryOnRemount: () => boolean;
  readonly markRetryOnRemount: () => void;
}

const AssistantDynamicFallbackContext =
  createContext<AssistantDynamicFallbackContextValue | null>(null);

function AssistantPanelLoadingFallback(props: DynamicOptionsLoadingProps) {
  const { t } = useI18n();
  const pathname = usePathname() ?? "/";
  const fallbackCtx = useContext(AssistantDynamicFallbackContext);
  const isReadingRoute = isReadingSessionPath(pathname);
  const isAdminRoute = isAdminPath(pathname);
  const hasBottomNav = hasMobileBottomNavPath(pathname);
  const resolvedPositionClass =
    fallbackCtx?.positionClass ??
    resolvePanelPositionClass(isReadingRoute, isAdminRoute, hasBottomNav);

  const hasError = Boolean(props.error);
  const retry = props.retry;
  const [isSlowLoading, setIsSlowLoading] = useState(false);

  useEffect(() => {
    if (hasError) return;
    const timer = window.setTimeout(() => {
      setIsSlowLoading(true);
    }, 3000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [hasError]);

  useEffect(() => {
    if (hasError && retry && fallbackCtx?.consumeRetryOnRemount()) {
      retry();
    }
  }, [fallbackCtx, hasError, retry]);

  useEffect(() => {
    if (!hasError || !fallbackCtx) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      fallbackCtx.markRetryOnRemount();
      fallbackCtx.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [fallbackCtx, hasError]);

  if (hasError) {
    return (
      <aside
        aria-label={t("common.states.unavailable")}
        className={cn(
          "fixed z-[46] flex w-[min(320px,calc(100vw-1.5rem))] flex-col gap-2.5 rounded-card border border-border bg-white p-3 text-xs text-ink shadow-xl",
          resolvedPositionClass,
        )}
        data-testid="viread-assistant-panel-error"
        role="complementary"
      >
        <span>{t("common.states.unavailable")}</span>
        <div className="flex items-center justify-end gap-2">
          {typeof retry === "function" ? (
            <button
              className="rounded-control border border-primary bg-primary px-2.5 py-1 text-xs font-semibold text-white hover:bg-primary-hover"
              onClick={() => retry()}
              type="button"
            >
              {t("common.actions.retry")}
            </button>
          ) : null}
          {fallbackCtx ? (
            <button
              className="rounded-control border border-border px-2.5 py-1 text-xs font-semibold hover:bg-canvas"
              onClick={() => {
                fallbackCtx.markRetryOnRemount();
                fallbackCtx.onClose();
              }}
              type="button"
            >
              {t("common.actions.close")}
            </button>
          ) : null}
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-busy="true"
      aria-label={t("common.assistant.panelAria")}
      className={cn(
        "fixed z-[46] flex w-[min(352px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-card border border-border bg-white shadow-xl",
        isReadingRoute
          ? "h-[min(360px,calc(100dvh-8.5rem))]"
          : hasBottomNav
            ? "h-[min(420px,calc(100dvh-7.5rem))] xl:h-[min(448px,calc(100dvh-6rem))]"
            : "h-[min(448px,calc(100dvh-6rem))]",
        resolvedPositionClass,
      )}
      data-testid="viread-assistant-panel-loading"
      role="complementary"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 bg-primary px-3 py-2.5 text-white">
        <div className="flex items-center gap-2">
          <Bot aria-hidden="true" className="size-4" />
          <span className="text-xs font-extrabold">
            {t("common.assistant.title")}
          </span>
        </div>
        {fallbackCtx ? (
          <button
            aria-label={t("common.actions.close")}
            className="flex size-6 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
            onClick={() => {
              fallbackCtx.markRetryOnRemount();
              fallbackCtx.onClose();
            }}
            type="button"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div className="flex-1 space-y-2.5 bg-canvas/75 p-3">
        <div className="flex items-center gap-2 rounded-control border border-border/80 bg-white px-2.5 py-2 text-xs font-medium text-ink shadow-2xs">
          <Loader2
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin text-primary"
          />
          <span>
            {isSlowLoading
              ? t("common.assistant.loadingPanelSlow")
              : t("common.assistant.loadingPanel")}
          </span>
        </div>
        <Skeleton className="h-14 w-full rounded-control" />
        <Skeleton className="h-10 w-3/4 rounded-control" />
        <Skeleton className="h-8 w-5/6 rounded-full" />
      </div>
    </aside>
  );
}

const ViReadAssistantPanel = dynamic(
  () =>
    import("@/components/assistant/viread-assistant-panel").then(
      (mod) => mod.ViReadAssistantPanel,
    ),
  {
    ssr: false,
    loading: (loadingProps) => (
      <AssistantPanelLoadingFallback {...loadingProps} />
    ),
  },
);

function preloadAssistantPanel(): void {
  void import("@/components/assistant/viread-assistant-panel").catch(() => {
    // Ignore speculative prefetch errors when offline.
  });
}

interface AssistantPanelErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallbackLabel: string;
  readonly closeLabel: string;
  readonly positionClass: string;
  readonly onClose: () => void;
}

interface AssistantPanelErrorBoundaryState {
  readonly hasError: boolean;
}

class AssistantPanelErrorBoundary extends Component<
  AssistantPanelErrorBoundaryProps,
  AssistantPanelErrorBoundaryState
> {
  state: AssistantPanelErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AssistantPanelErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <aside
          aria-label={this.props.fallbackLabel}
          className={cn(
            "fixed z-[46] flex w-[min(320px,calc(100vw-1.5rem))] items-center justify-between gap-2 rounded-card border border-border bg-white p-3 text-xs text-ink shadow-xl",
            this.props.positionClass,
          )}
          data-testid="viread-assistant-panel-error"
          role="complementary"
        >
          <span>{this.props.fallbackLabel}</span>
          <button
            className="rounded-control border border-border px-2.5 py-1 text-xs font-semibold hover:bg-canvas"
            onClick={() => {
              this.setState({ hasError: false });
              this.props.onClose();
            }}
            type="button"
          >
            {this.props.closeLabel}
          </button>
        </aside>
      );
    }
    return this.props.children;
  }
}

export function ViReadAssistantWidget() {
  const { t } = useI18n();
  const pathname = usePathname() ?? "/";

  // useSyncExternalStore keeps SSR HTML === first client render with zero hydration mismatch.
  const storedVisibility = useSyncExternalStore<"hidden" | "minimized">(
    subscribePrefsStore,
    readStoredVisibilitySnapshot,
    () => "minimized",
  );

  const [isOpen, setIsOpen] = useState(false);
  const [openTrigger, setOpenTrigger] = useState(0);
  const [isImmersiveEvent, setIsImmersiveEvent] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [activeUserId, setActiveUserId] = useState<string | null | undefined>(
    undefined,
  );
  const shouldRetryOnRemountRef = useRef(false);

  const currentRoleScope = inferAssistantRoleScope(pathname);
  const prevRoleScopeRef = useRef<AssistantRoleScope>(currentRoleScope);
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  const visibility: AssistantVisibilityState = isOpen
    ? "open"
    : storedVisibility;

  const isReadingRoute = isReadingSessionPath(pathname);
  const isAdminRoute = isAdminPath(pathname);
  const hasBottomNav = hasMobileBottomNavPath(pathname) && !isImmersiveEvent;

  useEffect(() => {
    let active = true;
    let subscription: { unsubscribe: () => void } | null = null;

    try {
      const supabase = createBrowserSupabaseClient();
      void supabase.auth
        .getSession()
        .then(({ data }) => {
          if (!active) return;
          setActiveUserId(data.session?.user?.id ?? null);
        })
        .catch(() => {
          if (!active) return;
          setActiveUserId(null);
        });

      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return;
        setActiveUserId(session?.user?.id ?? null);
      });
      subscription = data.subscription;
    } catch {
      queueMicrotask(() => {
        if (active) {
          setActiveUserId(null);
        }
      });
    }

    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const roleChanged = prevRoleScopeRef.current !== currentRoleScope;
    const userChanged =
      activeUserId !== undefined &&
      prevUserIdRef.current !== undefined &&
      prevUserIdRef.current !== activeUserId;

    if (roleChanged) {
      prevRoleScopeRef.current = currentRoleScope;
    }
    if (activeUserId !== undefined) {
      prevUserIdRef.current = activeUserId;
    }

    if (roleChanged || userChanged) {
      setMessages([]);
    }
  }, [activeUserId, currentRoleScope]);

  useEffect(() => {
    const handleOpenEvent = () => {
      writeStoredVisibility("minimized");
      setIsOpen(true);
      setOpenTrigger((count) => count + 1);
    };
    const handleImmersive = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: unknown }>).detail;
      setIsImmersiveEvent(Boolean(detail?.active));
    };

    window.addEventListener(OPEN_ASSISTANT_EVENT, handleOpenEvent);
    window.addEventListener("viread:immersive-mode", handleImmersive);

    return () => {
      window.removeEventListener(OPEN_ASSISTANT_EVENT, handleOpenEvent);
      window.removeEventListener("viread:immersive-mode", handleImmersive);
    };
  }, []);

  const updateVisibility = useCallback((next: AssistantVisibilityState) => {
    if (next === "open") {
      writeStoredVisibility("minimized");
      setIsOpen(true);
      setOpenTrigger((count) => count + 1);
    } else if (next === "hidden") {
      setIsOpen(false);
      writeStoredVisibility("hidden");
    } else {
      setIsOpen(false);
      writeStoredVisibility("minimized");
    }
  }, []);

  const handleMinimize = useCallback(
    () => updateVisibility("minimized"),
    [updateVisibility],
  );

  const panelPositionClass = resolvePanelPositionClass(
    isReadingRoute,
    isAdminRoute,
    hasBottomNav,
  );

  const consumeRetryOnRemount = useCallback(() => {
    if (!shouldRetryOnRemountRef.current) return false;
    shouldRetryOnRemountRef.current = false;
    return true;
  }, []);

  const markRetryOnRemount = useCallback(() => {
    shouldRetryOnRemountRef.current = true;
  }, []);

  const fallbackContextValue = useMemo<AssistantDynamicFallbackContextValue>(
    () => ({
      onClose: handleMinimize,
      positionClass: panelPositionClass,
      consumeRetryOnRemount,
      markRetryOnRemount,
    }),
    [
      consumeRetryOnRemount,
      handleMinimize,
      markRetryOnRemount,
      panelPositionClass,
    ],
  );

  // Positioning keeps clear of MobileBottomNav and active /reading/* header, topBar, and dock.
  const launcherPositionClass = isReadingRoute
    ? "top-[42%] -translate-y-1/2 end-0 flex-col items-end"
    : hasBottomNav
      ? isAdminRoute
        ? "bottom-[calc(4.75rem+env(safe-area-inset-bottom))] end-3 lg:bottom-4 lg:end-4"
        : "bottom-[calc(4.75rem+env(safe-area-inset-bottom))] end-3 xl:bottom-4 xl:end-4"
      : "bottom-4 end-4";

  const hiddenTabPositionClass = isReadingRoute
    ? "top-[42%] -translate-y-1/2 end-0"
    : hasBottomNav
      ? isAdminRoute
        ? "bottom-24 end-0 lg:bottom-6"
        : "bottom-24 end-0 xl:bottom-6"
      : "bottom-6 end-0";

  // 1. HIDDEN STATE — tiny unobtrusive edge restore tab (user can bring it back anytime).
  if (visibility === "hidden") {
    return (
      <div
        className={cn("fixed z-[45]", hiddenTabPositionClass)}
        data-testid="viread-assistant-hidden-tab"
      >
        <button
          aria-label={t("common.assistant.restoreAria")}
          className="flex h-8 w-5 items-center justify-center rounded-s-full border border-e-0 border-border bg-white/90 text-primary shadow-sm opacity-55 transition-all hover:w-6 hover:bg-sky hover:opacity-100 focus-visible:w-6 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary"
          onClick={() => updateVisibility("minimized")}
          title={t("common.assistant.restoreTitle")}
          type="button"
        >
          <ChevronLeft
            aria-hidden="true"
            className="size-3.5 viread-rtl-flip"
          />
        </button>
      </div>
    );
  }

  // 2. MINIMIZED STATE — compact corner pill/button with quick hide control.
  if (visibility === "minimized") {
    return (
      <div
        className={cn(
          "fixed z-[45] flex items-center gap-1",
          launcherPositionClass,
        )}
        data-testid="viread-assistant-launcher-wrap"
      >
        {!isReadingRoute ? (
          <button
            aria-label={t("common.assistant.hideButtonAria")}
            className="flex size-6 items-center justify-center rounded-full border border-border bg-white/90 text-muted shadow-xs opacity-75 transition-all hover:border-primary/40 hover:text-ink hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary"
            data-testid="viread-assistant-quick-hide"
            onClick={() => updateVisibility("hidden")}
            title={t("common.assistant.hideTooltip")}
            type="button"
          >
            <EyeOff aria-hidden="true" className="size-3" />
          </button>
        ) : null}

        <button
          aria-expanded={false}
          aria-label={t("common.assistant.openAria")}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 border border-primary/20 bg-primary text-white shadow-md transition-all hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
            isReadingRoute
              ? "h-9 w-8 rounded-s-full border-e-0 opacity-80 hover:w-9 hover:opacity-100"
              : "size-10 rounded-full sm:h-10 sm:w-auto sm:px-3.5 text-xs font-bold",
          )}
          data-testid="viread-assistant-launcher"
          onClick={() => updateVisibility("open")}
          onFocus={preloadAssistantPanel}
          onPointerEnter={preloadAssistantPanel}
          title={t("common.assistant.openAria")}
          type="button"
        >
          <Bot aria-hidden="true" className="size-4 shrink-0" />
          <span className={isReadingRoute ? "sr-only" : "hidden sm:inline"}>
            {t("common.assistant.launcherLabel")}
          </span>
        </button>

        {isReadingRoute ? (
          <button
            aria-label={t("common.assistant.hideButtonAria")}
            className="flex h-6 w-7 items-center justify-center rounded-s-full border border-e-0 border-border bg-white/90 text-muted shadow-xs opacity-70 transition-all hover:border-primary/40 hover:text-ink hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary"
            data-testid="viread-assistant-quick-hide"
            onClick={() => updateVisibility("hidden")}
            title={t("common.assistant.hideTooltip")}
            type="button"
          >
            <EyeOff aria-hidden="true" className="size-3" />
          </button>
        ) : null}
      </div>
    );
  }

  // 3. OPEN STATE — dynamically loaded corner panel inside an ErrorBoundary.
  return (
    <AssistantDynamicFallbackContext.Provider value={fallbackContextValue}>
      <AssistantPanelErrorBoundary
        closeLabel={t("common.actions.close")}
        fallbackLabel={t("common.states.unavailable")}
        onClose={handleMinimize}
        positionClass={panelPositionClass}
      >
        <ViReadAssistantPanel
          activeUserId={activeUserId}
          autoFocusTrigger={openTrigger}
          hasBottomNav={hasBottomNav}
          isAdminRoute={isAdminRoute}
          isReadingRoute={isReadingRoute}
          messages={messages}
          onMessagesChange={setMessages}
          onUpdateVisibility={updateVisibility}
          pathname={pathname}
        />
      </AssistantPanelErrorBoundary>
    </AssistantDynamicFallbackContext.Provider>
  );
}
