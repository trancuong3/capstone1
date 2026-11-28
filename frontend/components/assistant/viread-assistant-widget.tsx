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
  AssistantNavigationOffer,
  AssistantQuickAction,
  AssistantRoleScope,
  AssistantSourceTier,
  AssistantVisibilityState,
} from "@/types/assistant";

const VISIBILITY_STORAGE_KEY = "viread:assistant:visibility";
const HISTORY_STORAGE_PREFIX = "viread:assistant:history:v1:";
const MAX_PERSISTED_MESSAGES = 12;
const OPEN_ASSISTANT_EVENT = "viread:assistant:open";
const PREFS_CHANGE_EVENT = "viread:assistant:prefs-changed";

const VALID_SOURCE_TIERS: ReadonlySet<AssistantSourceTier> = new Set([
  "cache",
  "tier_0_kb",
  "tier_1_cloud",
  "tier_2_ollama",
  "tier_3_fallback",
  "offline",
]);

const VALID_ROLE_SCOPES: ReadonlySet<AssistantRoleScope> = new Set([
  "public",
  "parent",
  "admin",
]);

const VALID_NAV_DECISIONS: ReadonlySet<
  NonNullable<AssistantMessage["navigationDecision"]>
> = new Set([
  "pending",
  "needs_child",
  "needs_reading_exit_confirm",
  "accepted",
  "declined",
]);

const SENSITIVE_TOKEN_RE =
  /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{16,}|sb_secret_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{16,})\b/;

function buildHistoryStorageKey(
  roleScope: AssistantRoleScope,
  userId: string | null,
): string {
  return `${HISTORY_STORAGE_PREFIX}${roleScope}:${userId ?? "guest"}`;
}

function isSafeInternalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 180 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("://")
  );
}

function containsSensitiveToken(value: unknown): boolean {
  return typeof value === "string" && SENSITIVE_TOKEN_RE.test(value);
}

function sanitizeMessageForStorage(
  raw: unknown,
  expectedRoleScope?: AssistantRoleScope,
): AssistantMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.id !== "string" ||
    obj.id.length === 0 ||
    obj.id.length > 128
  ) {
    return null;
  }
  if (obj.role !== "user" && obj.role !== "assistant") {
    return null;
  }
  if (
    typeof obj.content !== "string" ||
    obj.content.trim().length === 0 ||
    obj.content.length > 8000 ||
    containsSensitiveToken(obj.content)
  ) {
    return null;
  }

  let roleScope: AssistantRoleScope | undefined;
  if (obj.roleScope !== undefined) {
    if (
      typeof obj.roleScope !== "string" ||
      !VALID_ROLE_SCOPES.has(obj.roleScope as AssistantRoleScope)
    ) {
      return null;
    }
    roleScope = obj.roleScope as AssistantRoleScope;
    if (
      expectedRoleScope &&
      obj.role === "assistant" &&
      roleScope !== expectedRoleScope
    ) {
      return null;
    }
  }

  const messagePath = isSafeInternalPath(obj.messagePath)
    ? obj.messagePath
    : undefined;

  const sourceTier =
    typeof obj.sourceTier === "string" &&
    VALID_SOURCE_TIERS.has(obj.sourceTier as AssistantSourceTier)
      ? (obj.sourceTier as AssistantSourceTier)
      : undefined;

  const providerId =
    typeof obj.providerId === "string" &&
    obj.providerId.length > 0 &&
    obj.providerId.length <= 64 &&
    !containsSensitiveToken(obj.providerId)
      ? obj.providerId
      : undefined;

  const modelId =
    obj.modelId === null
      ? null
      : typeof obj.modelId === "string" &&
          obj.modelId.length <= 128 &&
          !containsSensitiveToken(obj.modelId)
        ? obj.modelId
        : undefined;

  const latencyMs =
    typeof obj.latencyMs === "number" &&
    Number.isFinite(obj.latencyMs) &&
    obj.latencyMs >= 0
      ? obj.latencyMs
      : undefined;

  const cached = typeof obj.cached === "boolean" ? obj.cached : undefined;
  const liveGrounded =
    typeof obj.liveGrounded === "boolean" ? obj.liveGrounded : undefined;
  const feedback =
    obj.feedback === "up" || obj.feedback === "down" ? obj.feedback : undefined;

  let quickActions: AssistantQuickAction[] | undefined;
  if (Array.isArray(obj.quickActions)) {
    quickActions = obj.quickActions
      .filter(
        (item): item is AssistantQuickAction =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as AssistantQuickAction).label === "string" &&
          (item as AssistantQuickAction).label.trim().length > 0 &&
          (item as AssistantQuickAction).label.length <= 80 &&
          !containsSensitiveToken((item as AssistantQuickAction).label) &&
          isSafeInternalPath((item as AssistantQuickAction).href),
      )
      .slice(0, 3)
      .map((item) => ({ label: item.label, href: item.href }));
  }

  let suggestedPrompts: string[] | undefined;
  if (Array.isArray(obj.suggestedPrompts)) {
    suggestedPrompts = obj.suggestedPrompts
      .filter(
        (item): item is string =>
          typeof item === "string" &&
          item.trim().length > 0 &&
          item.length <= 240 &&
          !containsSensitiveToken(item),
      )
      .slice(0, 3);
  }

  let navigationOffer: AssistantNavigationOffer | null | undefined;
  if (obj.navigationOffer === null) {
    navigationOffer = null;
  } else if (
    obj.navigationOffer &&
    typeof obj.navigationOffer === "object" &&
    !Array.isArray(obj.navigationOffer)
  ) {
    const offer = obj.navigationOffer as Record<string, unknown>;
    if (
      typeof offer.label === "string" &&
      offer.label.trim().length > 0 &&
      offer.label.length <= 80 &&
      !containsSensitiveToken(offer.label) &&
      isSafeInternalPath(offer.href)
    ) {
      navigationOffer = {
        label: offer.label,
        href: offer.href,
        ...(typeof offer.reason === "string" &&
        offer.reason.length <= 160 &&
        !containsSensitiveToken(offer.reason)
          ? { reason: offer.reason }
          : offer.reason === null
            ? { reason: null }
            : {}),
        ...(typeof offer.requires_child_selection === "boolean"
          ? { requires_child_selection: offer.requires_child_selection }
          : {}),
        ...(typeof offer.scenario_id === "string" &&
        offer.scenario_id.length <= 64
          ? { scenario_id: offer.scenario_id }
          : offer.scenario_id === null
            ? { scenario_id: null }
            : {}),
      };
    }
  }

  const navigationDecision =
    typeof obj.navigationDecision === "string" &&
    VALID_NAV_DECISIONS.has(
      obj.navigationDecision as NonNullable<
        AssistantMessage["navigationDecision"]
      >,
    )
      ? (obj.navigationDecision as AssistantMessage["navigationDecision"])
      : undefined;

  const canDeepenWithAi =
    typeof obj.canDeepenWithAi === "boolean" ? obj.canDeepenWithAi : undefined;
  const canRetryOnline =
    typeof obj.canRetryOnline === "boolean" ? obj.canRetryOnline : undefined;
  const sourcePrompt =
    typeof obj.sourcePrompt === "string" &&
    obj.sourcePrompt.trim().length > 0 &&
    obj.sourcePrompt.length <= 1000 &&
    !containsSensitiveToken(obj.sourcePrompt)
      ? obj.sourcePrompt
      : undefined;

  return {
    id: obj.id,
    role: obj.role,
    content: obj.content,
    ...(messagePath !== undefined ? { messagePath } : {}),
    ...(sourceTier !== undefined ? { sourceTier } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(cached !== undefined ? { cached } : {}),
    ...(liveGrounded !== undefined ? { liveGrounded } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
    ...(roleScope !== undefined ? { roleScope } : {}),
    ...(quickActions !== undefined ? { quickActions } : {}),
    ...(suggestedPrompts !== undefined ? { suggestedPrompts } : {}),
    ...(navigationOffer !== undefined ? { navigationOffer } : {}),
    ...(navigationDecision !== undefined ? { navigationDecision } : {}),
    ...(canDeepenWithAi !== undefined ? { canDeepenWithAi } : {}),
    ...(canRetryOnline !== undefined ? { canRetryOnline } : {}),
    ...(sourcePrompt !== undefined ? { sourcePrompt } : {}),
  };
}

function removeStoredHistoryKey(key: string | null): void {
  if (!key || typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage errors (private browsing / restricted storage).
  }
}

function clearAllStoredHistoryKeys(): void {
  if (typeof window === "undefined") return;
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key && key.startsWith(HISTORY_STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore storage errors.
  }
}

function clearForeignUserHistoryKeys(activeUser: string | null): void {
  if (typeof window === "undefined") return;
  const expectedSuffix = `:${activeUser ?? "guest"}`;
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (
        key &&
        key.startsWith(HISTORY_STORAGE_PREFIX) &&
        !key.endsWith(expectedSuffix)
      ) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore storage errors.
  }
}

function readStoredHistory(
  key: string,
  expectedRoleScope: AssistantRoleScope,
): AssistantMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      removeStoredHistoryKey(key);
      return [];
    }
    const valid = parsed
      .map((item) => sanitizeMessageForStorage(item, expectedRoleScope))
      .filter((item): item is AssistantMessage => item !== null)
      .slice(-MAX_PERSISTED_MESSAGES);
    if (valid.length === 0) {
      removeStoredHistoryKey(key);
    }
    return valid;
  } catch {
    removeStoredHistoryKey(key);
    return [];
  }
}

function writeStoredHistory(
  key: string,
  messages: readonly AssistantMessage[],
  expectedRoleScope: AssistantRoleScope,
): void {
  if (typeof window === "undefined") return;
  const sanitized = messages
    .slice(-MAX_PERSISTED_MESSAGES)
    .map((item) => sanitizeMessageForStorage(item, expectedRoleScope))
    .filter((item): item is AssistantMessage => item !== null);
  if (sanitized.length === 0) {
    removeStoredHistoryKey(key);
    return;
  }
  try {
    window.sessionStorage.setItem(key, JSON.stringify(sanitized));
  } catch {
    // Ignore quota / private-browsing errors.
  }
}

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
  const [hydratedScopeKey, setHydratedScopeKey] = useState<string | null>(null);
  const shouldRetryOnRemountRef = useRef(false);

  const currentRoleScope = inferAssistantRoleScope(pathname);
  const prevRoleScopeRef = useRef<AssistantRoleScope>(currentRoleScope);
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  const activeScopeKeyRef = useRef<string | null>(null);
  const skipNextRestoreRef = useRef(false);

  const visibility: AssistantVisibilityState = isOpen
    ? "open"
    : storedVisibility;

  const isReadingRoute = isReadingSessionPath(pathname);
  const isAdminRoute = isAdminPath(pathname);
  const hasBottomNav = hasMobileBottomNavPath(pathname) && !isImmersiveEvent;

  useEffect(() => {
    let active = true;
    let authEventReceived = false;
    let subscription: { unsubscribe: () => void } | null = null;

    try {
      const supabase = createBrowserSupabaseClient();
      void supabase.auth
        .getSession()
        .then(({ data }) => {
          if (!active || authEventReceived) return;
          const initialUserId = data.session?.user?.id ?? null;
          if (
            prevUserIdRef.current !== undefined &&
            prevUserIdRef.current !== initialUserId
          ) {
            skipNextRestoreRef.current = true;
            clearAllStoredHistoryKeys();
            setMessages([]);
          } else {
            clearForeignUserHistoryKeys(initialUserId);
          }
          prevUserIdRef.current = initialUserId;
          setActiveUserId(initialUserId);
        })
        .catch(() => {
          if (!active || authEventReceived) return;
          clearForeignUserHistoryKeys(null);
          prevUserIdRef.current = null;
          setActiveUserId(null);
        });

      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (!active) return;
        authEventReceived = true;
        const nextUserId = session?.user?.id ?? null;
        const shouldResetHistory =
          event === "SIGNED_OUT" ||
          (prevUserIdRef.current !== undefined &&
            prevUserIdRef.current !== nextUserId);
        prevUserIdRef.current = nextUserId;
        if (shouldResetHistory) {
          skipNextRestoreRef.current = true;
          clearAllStoredHistoryKeys();
          setMessages([]);
        } else {
          clearForeignUserHistoryKeys(nextUserId);
        }
        setActiveUserId(nextUserId);
      });
      subscription = data.subscription;
    } catch {
      queueMicrotask(() => {
        if (active && !authEventReceived) {
          prevUserIdRef.current = null;
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
    const prevRoleScope = prevRoleScopeRef.current;
    const prevUserId = prevUserIdRef.current;
    const roleChanged = prevRoleScope !== currentRoleScope;
    const userChanged =
      activeUserId !== undefined &&
      prevUserId !== undefined &&
      prevUserId !== activeUserId;

    if (roleChanged) {
      prevRoleScopeRef.current = currentRoleScope;
    }
    if (activeUserId !== undefined) {
      prevUserIdRef.current = activeUserId;
    }

    if (activeUserId === undefined) {
      if (roleChanged) {
        removeStoredHistoryKey(activeScopeKeyRef.current);
        activeScopeKeyRef.current = null;
        setHydratedScopeKey(null);
        setMessages([]);
      }
      return;
    }

    const nextScopeKey = buildHistoryStorageKey(currentRoleScope, activeUserId);
    const previousScopeKey = activeScopeKeyRef.current;

    if (previousScopeKey === null) {
      activeScopeKeyRef.current = nextScopeKey;
      if (roleChanged || userChanged || skipNextRestoreRef.current) {
        skipNextRestoreRef.current = false;
        clearAllStoredHistoryKeys();
        setHydratedScopeKey(nextScopeKey);
        setMessages([]);
        return;
      }
      let active = true;
      const restored = readStoredHistory(nextScopeKey, currentRoleScope);
      queueMicrotask(() => {
        if (!active || activeScopeKeyRef.current !== nextScopeKey) return;
        setHydratedScopeKey(nextScopeKey);
        if (restored.length > 0) {
          setMessages((prev) => (prev.length > 0 ? prev : restored));
        }
      });
      return () => {
        active = false;
      };
    }

    if (
      roleChanged ||
      userChanged ||
      skipNextRestoreRef.current ||
      previousScopeKey !== nextScopeKey
    ) {
      removeStoredHistoryKey(previousScopeKey);
      if (userChanged || skipNextRestoreRef.current) {
        clearAllStoredHistoryKeys();
      }
      skipNextRestoreRef.current = false;
      activeScopeKeyRef.current = nextScopeKey;
      setHydratedScopeKey(nextScopeKey);
      setMessages([]);
    }
  }, [activeUserId, currentRoleScope]);

  useEffect(() => {
    if (activeUserId === undefined || hydratedScopeKey === null) {
      return;
    }
    const expectedScopeKey = buildHistoryStorageKey(
      currentRoleScope,
      activeUserId,
    );
    if (hydratedScopeKey !== expectedScopeKey) {
      return;
    }
    writeStoredHistory(expectedScopeKey, messages, currentRoleScope);
  }, [activeUserId, currentRoleScope, hydratedScopeKey, messages]);

  const handleClearMessages = useCallback(() => {
    setMessages([]);
    removeStoredHistoryKey(activeScopeKeyRef.current);
    if (activeUserId !== undefined) {
      removeStoredHistoryKey(
        buildHistoryStorageKey(currentRoleScope, activeUserId),
      );
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
          onClearMessages={handleClearMessages}
          onMessagesChange={setMessages}
          onUpdateVisibility={updateVisibility}
          pathname={pathname}
        />
      </AssistantPanelErrorBoundary>
    </AssistantDynamicFallbackContext.Provider>
  );
}
