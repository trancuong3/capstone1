"use client";

import {
  ArrowUpRight,
  Bot,
  Check,
  EyeOff,
  Loader2,
  Minus,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";

import { useI18n } from "@/hooks/use-i18n";
import {
  AssistantRateLimitError,
  sendAssistantMessage,
} from "@/lib/api/assistant-service";
import {
  detectNetworkBandwidth,
  getNavigatorConnection,
  resolveEffectiveBandwidth,
  resolveOfflineAssistantReply,
  resolvePageGuide,
} from "@/lib/assistant/page-guides";
import {
  isSafeAssistantNavigationHref,
  isSafeAssistantQuickActionHref,
} from "@/lib/assistant/route-helpers";
import { cn } from "@/lib/utils/cn";
import type {
  AssistantMessage,
  AssistantSourceTier,
  AssistantVisibilityState,
  BandwidthPreference,
  DetectedNetworkInfo,
} from "@/types/assistant";

const BANDWIDTH_STORAGE_KEY = "viread:assistant:bandwidth";
const PREFS_CHANGE_EVENT = "viread:assistant:prefs-changed";
const DEFAULT_NETWORK_SNAPSHOT = "1|high||0|";

function readStoredBandwidthSnapshot(): BandwidthPreference {
  try {
    const raw = window.localStorage.getItem(BANDWIDTH_STORAGE_KEY);
    if (raw === "auto" || raw === "low" || raw === "high") {
      return raw;
    }
    return "auto";
  } catch {
    return "auto";
  }
}

function writeStoredBandwidthPreference(pref: BandwidthPreference): void {
  try {
    window.localStorage.setItem(BANDWIDTH_STORAGE_KEY, pref);
    window.dispatchEvent(new CustomEvent(PREFS_CHANGE_EVENT));
  } catch {
    // Ignore storage errors.
  }
}

function subscribeBandwidthStore(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === BANDWIDTH_STORAGE_KEY) {
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

function readNetworkSnapshot(): string {
  const info = detectNetworkBandwidth();
  return `${info.online ? "1" : "0"}|${info.profile}|${info.effectiveType ?? ""}|${info.saveData ? "1" : "0"}|${info.rtt ?? ""}`;
}

function parseNetworkSnapshot(snapshot: string): DetectedNetworkInfo {
  const [onlineRaw, profileRaw, effectiveTypeRaw, saveDataRaw, rttRaw] =
    snapshot.split("|");
  const profile =
    profileRaw === "low" || profileRaw === "medium" || profileRaw === "high"
      ? profileRaw
      : "high";
  const parsedRtt = rttRaw ? Number(rttRaw) : NaN;
  return {
    online: onlineRaw !== "0",
    profile,
    effectiveType: effectiveTypeRaw || null,
    saveData: saveDataRaw === "1",
    rtt: Number.isFinite(parsedRtt) && parsedRtt > 0 ? parsedRtt : null,
  };
}

function subscribeNetworkStore(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  const conn = getNavigatorConnection();
  conn?.addEventListener?.("change", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
    conn?.removeEventListener?.("change", onStoreChange);
  };
}

const INLINE_MD_TOKEN_RE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode {
  const parts = text.split(INLINE_MD_TOKEN_RE);
  if (parts.length === 1) return text;
  return parts.map((segment, index) => {
    if (!segment) return null;
    if (
      segment.length > 4 &&
      segment.startsWith("**") &&
      segment.endsWith("**")
    ) {
      return (
        <strong className="font-bold text-ink" key={`${keyPrefix}-b-${index}`}>
          {segment.slice(2, -2)}
        </strong>
      );
    }
    if (
      segment.length > 2 &&
      segment.startsWith("`") &&
      segment.endsWith("`")
    ) {
      return (
        <code
          className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px] font-semibold text-primary-hover"
          key={`${keyPrefix}-c-${index}`}
        >
          {segment.slice(1, -1)}
        </code>
      );
    }
    if (
      segment.length > 2 &&
      segment.startsWith("*") &&
      segment.endsWith("*") &&
      !segment.startsWith("**")
    ) {
      return (
        <em className="italic" key={`${keyPrefix}-i-${index}`}>
          {segment.slice(1, -1)}
        </em>
      );
    }
    return segment;
  });
}

function renderFormattedReply(content: string): ReactNode {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  return (
    <div className="space-y-1">
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        const headingMatch = /^#{1,4}\s+(.+)$/.exec(trimmed);
        if (headingMatch) {
          return (
            <p className="font-bold text-ink break-words" key={idx}>
              {renderInlineMarkdown(headingMatch[1], `h-${idx}`)}
            </p>
          );
        }
        const isBullet =
          trimmed.startsWith("•") ||
          trimmed.startsWith("- ") ||
          trimmed.startsWith("* ");
        const cleanText = isBullet
          ? trimmed.replace(/^[•\-*]\s*/, "")
          : trimmed;
        if (isBullet) {
          return (
            <div className="flex items-start gap-1.5" key={idx}>
              <span
                aria-hidden="true"
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/70"
              />
              <span className="min-w-0 break-words">
                {renderInlineMarkdown(cleanText, `li-${idx}`)}
              </span>
            </div>
          );
        }
        return (
          <p className="break-words" key={idx}>
            {renderInlineMarkdown(cleanText, `p-${idx}`)}
          </p>
        );
      })}
    </div>
  );
}

function nextBandwidthPreference(
  current: BandwidthPreference,
): BandwidthPreference {
  if (current === "auto") return "low";
  if (current === "low") return "high";
  return "auto";
}

function formatLatency(latencyMs: number): string {
  if (latencyMs < 1000) {
    return `${Math.max(1, Math.round(latencyMs))}ms`;
  }
  return `${(latencyMs / 1000).toFixed(1)}s`;
}

export interface ViReadAssistantPanelProps {
  readonly pathname: string;
  readonly isReadingRoute: boolean;
  readonly isAdminRoute: boolean;
  readonly hasBottomNav: boolean;
  readonly messages: AssistantMessage[];
  readonly onMessagesChange: Dispatch<SetStateAction<AssistantMessage[]>>;
  readonly onUpdateVisibility: (next: AssistantVisibilityState) => void;
  readonly autoFocusTrigger: number;
}

export function ViReadAssistantPanel({
  pathname,
  isReadingRoute,
  isAdminRoute,
  hasBottomNav,
  messages,
  onMessagesChange,
  onUpdateVisibility,
  autoFocusTrigger,
}: ViReadAssistantPanelProps) {
  const { locale, t } = useI18n();
  const router = useRouter();

  const bandwidthPref = useSyncExternalStore<BandwidthPreference>(
    subscribeBandwidthStore,
    readStoredBandwidthSnapshot,
    () => "auto",
  );
  const networkSnapshot = useSyncExternalStore(
    subscribeNetworkStore,
    readNetworkSnapshot,
    () => DEFAULT_NETWORK_SNAPSHOT,
  );
  const networkInfo = useMemo(
    () => parseNetworkSnapshot(networkSnapshot),
    [networkSnapshot],
  );

  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendingElapsedSeconds, setSendingElapsedSeconds] = useState(0);
  const [sendingForceLlm, setSendingForceLlm] = useState(false);
  const [rateLimitState, setRateLimitState] = useState<{
    readonly message: string;
    readonly retryPrompt: string;
    readonly retryForceLlm: boolean;
  } | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingPromptRef = useRef<{
    readonly prompt: string;
    readonly forceLlm: boolean;
  } | null>(null);

  useEffect(() => {
    if (!isSending) {
      return;
    }
    const interval = window.setInterval(() => {
      setSendingElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [isSending]);

  const effectiveBandwidth = useMemo(
    () => resolveEffectiveBandwidth(bandwidthPref, networkInfo),
    [bandwidthPref, networkInfo],
  );

  const pageGuide = useMemo(
    () => resolvePageGuide(pathname, locale),
    [pathname, locale],
  );

  useEffect(() => {
    if (autoFocusTrigger <= 0) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [autoFocusTrigger]);

  // Scroll to newest reply whenever thread updates.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isSending]);

  // Allow Escape to minimize cleanly when expanded.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onUpdateVisibility("minimized");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onUpdateVisibility]);

  // Abort in-flight request on unmount.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const cycleBandwidthMode = useCallback(() => {
    const next = nextBandwidthPreference(bandwidthPref);
    writeStoredBandwidthPreference(next);
  }, [bandwidthPref]);

  const tierLabel = useCallback(
    (tier?: AssistantSourceTier, providerId?: string): string => {
      switch (tier) {
        case "cache":
          return t("common.assistant.tierCache");
        case "tier_0_kb":
          return t("common.assistant.tierKb");
        case "tier_1_cloud":
          if (providerId?.startsWith("groq")) {
            return t("common.assistant.tierCloudGroq");
          }
          return t("common.assistant.tierCloudGemini");
        case "tier_2_ollama":
          return t("common.assistant.tierOllama");
        case "tier_3_fallback":
          return t("common.assistant.tierFallback");
        case "offline":
        default:
          return t("common.assistant.tierOffline");
      }
    },
    [t],
  );

  const bandwidthChipLabel = useMemo(() => {
    if (!networkInfo.online) {
      return t("common.assistant.bandwidthOffline");
    }
    if (bandwidthPref === "low") {
      return t("common.assistant.bandwidthSaver");
    }
    if (bandwidthPref === "high") {
      return t("common.assistant.bandwidthFull");
    }
    if (effectiveBandwidth === "low") {
      return t("common.assistant.bandwidthAutoLow");
    }
    if (effectiveBandwidth === "medium") {
      return t("common.assistant.bandwidthAutoMedium");
    }
    return t("common.assistant.bandwidthAutoHigh");
  }, [bandwidthPref, effectiveBandwidth, networkInfo.online, t]);

  const sendPrompt = useCallback(
    async (
      rawText: string,
      options?: {
        readonly forceLlm?: boolean;
        readonly clearInput?: boolean;
        readonly skipUserEcho?: boolean;
      },
    ) => {
      const trimmed = rawText.trim();
      if (!trimmed || isSending) return;

      const forceLlm = Boolean(options?.forceLlm);
      const skipUserEcho = Boolean(options?.skipUserEcho) || forceLlm;
      setRateLimitState(null);
      if (options?.clearInput) {
        setInputValue("");
      }

      const historyLimit =
        effectiveBandwidth === "low"
          ? 2
          : effectiveBandwidth === "medium"
            ? 4
            : 6;
      const historyPayload = messages.slice(-historyLimit).map((item) => ({
        role: item.role,
        content: item.content.slice(0, 950),
      }));

      if (!skipUserEcho) {
        const userMessage: AssistantMessage = {
          id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "user",
          content: trimmed,
          messagePath: pathname,
        };
        onMessagesChange((prev) => [...prev.slice(-20), userMessage]);
      }

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      pendingPromptRef.current = { prompt: trimmed, forceLlm };
      setSendingElapsedSeconds(0);
      setSendingForceLlm(forceLlm);
      setIsSending(true);

      try {
        const result = await sendAssistantMessage(
          {
            message: trimmed,
            current_path: pathname,
            locale,
            bandwidth_profile: effectiveBandwidth,
            history: forceLlm ? [] : historyPayload,
            force_llm: forceLlm,
          },
          {
            signal: controller.signal,
            online: networkInfo.online,
          },
        );

        const isKbOrigin =
          result.source_tier === "tier_0_kb" ||
          (result.source_tier === "cache" &&
            result.provider_id === "viread_kb");
        const canRetryOnline =
          !forceLlm &&
          networkInfo.online &&
          result.provider_id !== "viread_scope_guard" &&
          (result.source_tier === "offline" ||
            result.source_tier === "tier_3_fallback");

        const safeNavigationOffer = isSafeAssistantNavigationHref(
          result.navigation_offer?.href,
          pathname,
          result.role_scope,
        )
          ? result.navigation_offer
          : null;

        const botMessage: AssistantMessage = {
          id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "assistant",
          content: result.reply,
          messagePath: pathname,
          sourceTier: result.source_tier,
          providerId: result.provider_id,
          modelId: result.model_id,
          latencyMs: result.latency_ms,
          cached: result.cached,
          roleScope: result.role_scope,
          quickActions: result.quick_actions,
          suggestedPrompts: result.suggested_prompts,
          navigationOffer: safeNavigationOffer,
          navigationDecision: safeNavigationOffer ? "pending" : undefined,
          canDeepenWithAi:
            !forceLlm &&
            networkInfo.online &&
            isKbOrigin &&
            result.provider_id !== "viread_scope_guard",
          canRetryOnline,
          sourcePrompt: trimmed,
        };
        onMessagesChange((prev) => [...prev.slice(-20), botMessage]);
      } catch (error) {
        if (error instanceof AssistantRateLimitError) {
          const message =
            typeof error.retryAfterSeconds === "number" &&
            error.retryAfterSeconds > 0
              ? t("common.assistant.rateLimitedWait", {
                  seconds: error.retryAfterSeconds,
                })
              : t("common.assistant.rateLimited");
          setRateLimitState({
            message,
            retryPrompt: trimmed,
            retryForceLlm: forceLlm,
          });
        } else if (!controller.signal.aborted) {
          const fallback = resolveOfflineAssistantReply(
            trimmed,
            pathname,
            locale,
            effectiveBandwidth,
          );
          const safeFallbackOffer = isSafeAssistantNavigationHref(
            fallback.navigation_offer?.href,
            pathname,
            fallback.role_scope,
          )
            ? fallback.navigation_offer
            : null;
          onMessagesChange((prev) => [
            ...prev.slice(-20),
            {
              id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role: "assistant",
              content: fallback.reply,
              messagePath: pathname,
              sourceTier: fallback.source_tier,
              providerId: fallback.provider_id,
              latencyMs: fallback.latency_ms,
              roleScope: fallback.role_scope,
              quickActions: fallback.quick_actions,
              suggestedPrompts: fallback.suggested_prompts,
              navigationOffer: safeFallbackOffer,
              navigationDecision: safeFallbackOffer ? "pending" : undefined,
              canRetryOnline:
                !forceLlm &&
                networkInfo.online &&
                fallback.provider_id !== "viread_scope_guard",
              sourcePrompt: trimmed,
            },
          ]);
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        pendingPromptRef.current = null;
        setSendingElapsedSeconds(0);
        setSendingForceLlm(false);
        setIsSending(false);
      }
    },
    [
      effectiveBandwidth,
      isSending,
      locale,
      messages,
      networkInfo.online,
      onMessagesChange,
      pathname,
      t,
    ],
  );

  const handleCancelSending = useCallback(() => {
    const pending = pendingPromptRef.current;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    pendingPromptRef.current = null;
    setIsSending(false);
    setSendingElapsedSeconds(0);
    setSendingForceLlm(false);
    if (pending && !pending.forceLlm) {
      setInputValue(pending.prompt);
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 30);
    }
  }, []);

  const handleUseQuickGuideNow = useCallback(
    (prompt: string) => {
      const offlineGuide = resolveOfflineAssistantReply(
        prompt,
        pathname,
        locale,
        effectiveBandwidth,
      );
      const safeOffer = isSafeAssistantNavigationHref(
        offlineGuide.navigation_offer?.href,
        pathname,
        offlineGuide.role_scope,
      )
        ? offlineGuide.navigation_offer
        : null;
      setRateLimitState(null);
      onMessagesChange((prev) => [
        ...prev.slice(-20),
        {
          id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "assistant",
          content: offlineGuide.reply,
          messagePath: pathname,
          sourceTier: offlineGuide.source_tier,
          providerId: offlineGuide.provider_id,
          latencyMs: offlineGuide.latency_ms,
          roleScope: offlineGuide.role_scope,
          quickActions: offlineGuide.quick_actions,
          suggestedPrompts: offlineGuide.suggested_prompts,
          navigationOffer: safeOffer,
          navigationDecision: safeOffer ? "pending" : undefined,
          canRetryOnline: offlineGuide.provider_id !== "viread_scope_guard",
          sourcePrompt: prompt,
        },
      ]);
    },
    [effectiveBandwidth, locale, onMessagesChange, pathname],
  );

  const handleNavigationDecision = useCallback(
    (messageId: string, decision: "accepted" | "declined") => {
      const targetMsg = messages.find((item) => item.id === messageId);
      const offerHref = targetMsg?.navigationOffer?.href;
      const canNavigate =
        decision === "accepted" &&
        isSafeAssistantNavigationHref(
          offerHref,
          pathname,
          targetMsg?.roleScope,
        );

      onMessagesChange((prev) =>
        prev.map((item) =>
          item.id === messageId
            ? {
                ...item,
                navigationDecision: decision,
              }
            : item,
        ),
      );
      if (canNavigate && offerHref) {
        router.push(offerHref);
      }
    },
    [messages, onMessagesChange, pathname, router],
  );

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendPrompt(inputValue, { clearInput: true });
  }

  const clearConversation = useCallback(() => {
    abortControllerRef.current?.abort();
    pendingPromptRef.current = null;
    onMessagesChange([]);
    setRateLimitState(null);
    setSendingElapsedSeconds(0);
    setSendingForceLlm(false);
    setIsSending(false);
  }, [onMessagesChange]);

  const panelPositionClass = isReadingRoute
    ? "top-[7.25rem] end-2 sm:end-4"
    : hasBottomNav
      ? isAdminRoute
        ? "bottom-[calc(4.75rem+env(safe-area-inset-bottom))] end-3 lg:bottom-4 lg:end-4"
        : "bottom-[calc(4.75rem+env(safe-area-inset-bottom))] end-3 xl:bottom-4 xl:end-4"
      : "bottom-4 end-4";

  const lastMessage =
    messages.length > 0 ? messages[messages.length - 1] : null;
  const activeSuggestions =
    lastMessage &&
    lastMessage.role === "assistant" &&
    lastMessage.messagePath === pathname &&
    (lastMessage.suggestedPrompts?.length ?? 0) > 0
      ? lastMessage.suggestedPrompts!
      : pageGuide.prompts;

  return (
    <aside
      aria-label={t("common.assistant.panelAria")}
      className={cn(
        "fixed z-[46] flex w-[min(352px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-card border border-border bg-white shadow-xl",
        isReadingRoute
          ? "h-[min(360px,calc(100dvh-8.5rem))]"
          : hasBottomNav
            ? "h-[min(420px,calc(100dvh-7.5rem))] xl:h-[min(448px,calc(100dvh-6rem))]"
            : "h-[min(448px,calc(100dvh-6rem))]",
        panelPositionClass,
      )}
      data-testid="viread-assistant-panel"
      role="complementary"
    >
      {/* Compact Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 bg-primary px-3 py-2 text-white">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/15"
          >
            <Bot className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-extrabold leading-tight">
              {t("common.assistant.title")}
            </p>
            <p className="truncate text-[10px] leading-tight text-white/80">
              {pageGuide.title}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            aria-label={t("common.assistant.bandwidthToggleAria", {
              mode: bandwidthChipLabel,
            })}
            className="inline-flex h-6 items-center gap-1 rounded-full bg-white/15 px-2 text-[10px] font-bold text-white transition-colors hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-white"
            data-testid="viread-assistant-bandwidth-btn"
            onClick={cycleBandwidthMode}
            title={t("common.assistant.bandwidthTooltip")}
            type="button"
          >
            {!networkInfo.online ? (
              <WifiOff aria-hidden="true" className="size-3" />
            ) : effectiveBandwidth === "low" ? (
              <Zap aria-hidden="true" className="size-3" />
            ) : (
              <Wifi aria-hidden="true" className="size-3" />
            )}
            <span className="max-w-[78px] truncate">{bandwidthChipLabel}</span>
          </button>

          {messages.length > 0 ? (
            <button
              aria-label={t("common.assistant.clearAria")}
              className="flex size-6 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              data-testid="viread-assistant-clear"
              onClick={clearConversation}
              title={t("common.assistant.clearTitle")}
              type="button"
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}

          <button
            aria-label={t("common.assistant.hideButtonAria")}
            className="flex size-6 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
            data-testid="viread-assistant-hide"
            onClick={() => onUpdateVisibility("hidden")}
            title={t("common.assistant.hideTooltip")}
            type="button"
          >
            <EyeOff aria-hidden="true" className="size-3.5" />
          </button>

          <button
            aria-label={t("common.assistant.minimizeAria")}
            className="flex size-6 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
            data-testid="viread-assistant-minimize"
            onClick={() => onUpdateVisibility("minimized")}
            title={t("common.assistant.minimizeTitle")}
            type="button"
          >
            <Minus aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Scrollable Compact Thread */}
      <div
        aria-live="polite"
        className="flex-1 space-y-2.5 overflow-y-auto bg-canvas/75 px-3 py-2.5 text-[12.5px] leading-5 text-ink"
        ref={scrollContainerRef}
      >
        {/* Welcome / Page Context Bubble */}
        <div className="rounded-control border border-border/80 bg-white px-2.5 py-2 shadow-2xs">
          <p className="text-[12.5px] font-medium text-ink">
            {pageGuide.greeting}
          </p>
          {messages.length === 0 && pageGuide.actions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {pageGuide.actions.slice(0, 2).map((action) => (
                <Link
                  className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-sky/60 px-2 py-0.5 text-[11px] font-bold text-primary-hover transition-colors hover:bg-sky"
                  href={action.href}
                  key={action.href}
                >
                  <span>{action.label}</span>
                  <ArrowUpRight aria-hidden="true" className="size-3" />
                </Link>
              ))}
            </div>
          ) : null}
        </div>

        {/* Conversation Messages */}
        {messages.map((msg) => {
          const isUser = msg.role === "user";
          const safeNavigationOffer =
            !isUser &&
            isSafeAssistantNavigationHref(
              msg.navigationOffer?.href,
              pathname,
              msg.roleScope,
            )
              ? msg.navigationOffer
              : null;

          return (
            <div
              className={cn(
                "flex flex-col",
                isUser ? "items-end" : "items-start",
              )}
              key={msg.id}
            >
              <div
                className={cn(
                  "max-w-[90%] rounded-control px-2.5 py-2 shadow-2xs",
                  isUser
                    ? "bg-primary text-white"
                    : "border border-border/80 bg-white text-ink",
                )}
              >
                {isUser ? (
                  <p className="break-words">{msg.content}</p>
                ) : (
                  renderFormattedReply(msg.content)
                )}

                {safeNavigationOffer ? (
                  <div
                    className="mt-2 rounded-control border border-primary/25 bg-sky/35 p-2 text-[11.5px]"
                    data-testid="viread-assistant-nav-card"
                  >
                    <p className="font-bold text-ink">
                      {safeNavigationOffer.label}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">
                      {safeNavigationOffer.reason ||
                        t("common.assistant.navConfirmPrompt")}
                    </p>
                    {msg.navigationDecision === "accepted" ? (
                      <p
                        className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold text-primary-hover"
                        data-testid="viread-assistant-nav-status"
                      >
                        <Check aria-hidden="true" className="size-3" />
                        <span>{t("common.assistant.navConfirmedStatus")}</span>
                      </p>
                    ) : msg.navigationDecision === "declined" ? (
                      <p
                        className="mt-1.5 text-[11px] font-medium text-muted"
                        data-testid="viread-assistant-nav-status"
                      >
                        {t("common.assistant.navDeclinedStatus")}
                      </p>
                    ) : (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <button
                          className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[11px] font-bold text-white transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                          data-testid="viread-assistant-nav-yes"
                          onClick={() =>
                            handleNavigationDecision(msg.id, "accepted")
                          }
                          type="button"
                        >
                          <Check aria-hidden="true" className="size-3" />
                          <span>{t("common.assistant.navConfirmYes")}</span>
                        </button>
                        <button
                          className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-3 py-1 text-[11px] font-semibold text-ink transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                          data-testid="viread-assistant-nav-no"
                          onClick={() =>
                            handleNavigationDecision(msg.id, "declined")
                          }
                          type="button"
                        >
                          <X aria-hidden="true" className="size-3" />
                          <span>{t("common.assistant.navConfirmNo")}</span>
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}

                {(() => {
                  const safeActions = !isUser
                    ? (msg.quickActions ?? []).filter((action) =>
                        isSafeAssistantQuickActionHref(
                          action.href,
                          pathname,
                          msg.roleScope,
                        ),
                      )
                    : [];
                  if (safeActions.length === 0) return null;
                  return (
                    <div className="mt-2 flex flex-wrap gap-1 border-t border-border/60 pt-1.5">
                      {safeActions.map((action) => (
                        <Link
                          className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-sky/60 px-2 py-0.5 text-[11px] font-bold text-primary-hover transition-colors hover:bg-sky"
                          href={action.href}
                          key={action.href}
                        >
                          <span>{action.label}</span>
                          <ArrowUpRight aria-hidden="true" className="size-3" />
                        </Link>
                      ))}
                    </div>
                  );
                })()}
              </div>

              {!isUser && msg.sourceTier ? (
                <div className="mt-1 flex flex-wrap items-center gap-2 px-0.5 text-[10px] text-muted">
                  <span data-testid="viread-assistant-source-meta">
                    {tierLabel(msg.sourceTier, msg.providerId)}
                    {typeof msg.latencyMs === "number"
                      ? ` · ${formatLatency(msg.latencyMs)}`
                      : ""}
                  </span>
                  {msg.canDeepenWithAi && msg.sourcePrompt ? (
                    <button
                      className="inline-flex items-center gap-0.5 font-bold text-primary underline-offset-2 hover:underline disabled:opacity-50"
                      disabled={isSending}
                      onClick={() =>
                        void sendPrompt(msg.sourcePrompt!, { forceLlm: true })
                      }
                      type="button"
                    >
                      <Sparkles aria-hidden="true" className="size-2.5" />
                      {t("common.assistant.askAiDeeper")}
                    </button>
                  ) : null}
                  {msg.canRetryOnline && msg.sourcePrompt ? (
                    <button
                      className="inline-flex items-center gap-0.5 font-bold text-primary underline-offset-2 hover:underline disabled:opacity-50"
                      data-testid="viread-assistant-retry-ai"
                      disabled={isSending}
                      onClick={() =>
                        void sendPrompt(msg.sourcePrompt!, {
                          skipUserEcho: true,
                        })
                      }
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" className="size-2.5" />
                      {t("common.assistant.retryWithAi")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}

        {isSending ? (
          <div
            aria-busy="true"
            className="rounded-control border border-primary/20 bg-white px-2.5 py-2 text-xs shadow-2xs"
            data-testid="viread-assistant-loading-card"
            role="status"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Loader2
                  aria-hidden="true"
                  className="size-3.5 shrink-0 animate-spin text-primary"
                />
                <span className="font-semibold text-ink">
                  {sendingForceLlm && sendingElapsedSeconds < 3
                    ? t("common.assistant.thinkingDeep")
                    : sendingElapsedSeconds < 2
                      ? t("common.assistant.thinking")
                      : sendingElapsedSeconds < 6
                        ? t("common.assistant.thinkingConnectAi")
                        : sendingElapsedSeconds < 12
                          ? t("common.assistant.thinkingSynthesizing")
                          : t("common.assistant.thinkingSlowReassure")}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {sendingElapsedSeconds >= 1 ? (
                  <span
                    className="rounded-full bg-canvas px-1.5 py-0.5 text-[10px] font-bold text-muted"
                    data-testid="viread-assistant-elapsed"
                  >
                    {t("common.assistant.elapsedSeconds", {
                      seconds: sendingElapsedSeconds,
                    })}
                  </span>
                ) : null}
                <button
                  aria-label={t("common.assistant.cancelAria")}
                  className="rounded-full border border-border px-2 py-0.5 text-[10px] font-bold text-ink transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:outline-primary"
                  data-testid="viread-assistant-cancel"
                  onClick={handleCancelSending}
                  type="button"
                >
                  {t("common.assistant.cancelRequest")}
                </button>
              </div>
            </div>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-canvas">
              <div className="h-full w-2/3 animate-pulse rounded-full bg-primary/70" />
            </div>
          </div>
        ) : null}

        {rateLimitState ? (
          <div
            className="space-y-1.5 rounded-control border border-danger/30 bg-danger-surface px-2.5 py-2 text-[11px]"
            data-testid="viread-assistant-rate-limit"
            role="alert"
          >
            <p className="font-semibold text-danger">
              {rateLimitState.message}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                className="rounded-full border border-danger/30 bg-white px-2.5 py-0.5 text-[10px] font-bold text-danger transition-colors hover:bg-canvas"
                onClick={() =>
                  void sendPrompt(rateLimitState.retryPrompt, {
                    forceLlm: rateLimitState.retryForceLlm,
                    skipUserEcho: true,
                  })
                }
                type="button"
              >
                {t("common.assistant.retryTurn")}
              </button>
              <button
                className="rounded-full border border-border bg-white px-2.5 py-0.5 text-[10px] font-bold text-ink transition-colors hover:bg-canvas"
                onClick={() =>
                  handleUseQuickGuideNow(rateLimitState.retryPrompt)
                }
                type="button"
              >
                {t("common.assistant.useQuickGuideNow")}
              </button>
            </div>
          </div>
        ) : null}

        {/* Contextual Quick Suggestion Chips */}
        {!isSending && activeSuggestions.length > 0 ? (
          <div className="space-y-1 pt-0.5">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted">
              {t("common.assistant.quickGuidesLabel")}
            </p>
            <div className="flex flex-wrap gap-1">
              {activeSuggestions.slice(0, 3).map((prompt) => (
                <button
                  className="rounded-full border border-border bg-white px-2.5 py-1 text-start text-[11px] font-semibold text-ink transition-colors hover:border-primary/40 hover:bg-sky/50 hover:text-primary-hover focus-visible:outline-2 focus-visible:outline-primary"
                  key={prompt}
                  onClick={() => void sendPrompt(prompt)}
                  type="button"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Compact Input Bar */}
      <form
        className="flex shrink-0 items-center gap-1.5 border-t border-border bg-white px-2.5 py-2"
        onSubmit={handleFormSubmit}
      >
        <input
          aria-label={t("common.assistant.inputAria")}
          className="min-w-0 flex-1 rounded-full border border-border bg-canvas/50 px-3 py-1.5 text-xs text-ink outline-none placeholder:text-muted/80 focus:border-primary focus:bg-white"
          disabled={isSending}
          maxLength={800}
          onChange={(event) => setInputValue(event.target.value)}
          placeholder={
            isSending
              ? t("common.assistant.inputWaitingPlaceholder")
              : t("common.assistant.inputPlaceholder")
          }
          ref={inputRef}
          type="text"
          value={inputValue}
        />
        <button
          aria-label={t("common.assistant.sendAria")}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-white transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45"
          disabled={isSending || !inputValue.trim()}
          type="submit"
        >
          <SendHorizontal
            aria-hidden="true"
            className="size-3.5 viread-rtl-flip"
          />
        </button>
      </form>
    </aside>
  );
}
