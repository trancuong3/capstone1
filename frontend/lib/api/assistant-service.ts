"use client";

import { z } from "zod";

import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import { resolveOfflineAssistantReply } from "@/lib/assistant/page-guides";
import {
  inferAssistantRoleScope,
  isSafeAssistantNavigationHref,
  isSafeAssistantQuickActionHref,
} from "@/lib/assistant/route-helpers";
import { getApiBaseUrl } from "@/lib/supabase/config";
import type {
  AssistantChatRequest,
  AssistantChatResponse,
  BandwidthProfile,
  SendAssistantMessageInput,
} from "@/types/assistant";

const assistantQuickActionSchema = z.object({
  label: z.string().min(1).max(80),
  href: z
    .string()
    .min(1)
    .max(180)
    .refine(
      (value) =>
        value.startsWith("/") &&
        !value.startsWith("//") &&
        !value.includes("://"),
      { message: "Invalid internal path" },
    ),
});

const assistantNavigationOfferSchema = z.object({
  label: z.string().min(1).max(80),
  href: z
    .string()
    .min(1)
    .max(180)
    .refine(
      (value) =>
        value.startsWith("/") &&
        !value.startsWith("//") &&
        !value.includes("://"),
      { message: "Invalid internal path" },
    ),
  reason: z.string().max(160).nullable().optional().default(null),
  requires_child_selection: z.boolean().optional().default(false),
  scenario_id: z.string().max(64).nullable().optional().default(null),
});

const assistantChatResponseSchema = z.object({
  reply: z.string().min(1),
  source_tier: z.enum([
    "cache",
    "tier_0_kb",
    "tier_1_cloud",
    "tier_2_ollama",
    "tier_3_fallback",
  ]),
  provider_id: z.string().min(1),
  model_id: z.string().nullable().optional().default(null),
  bandwidth_applied: z.enum(["low", "medium", "high"]),
  latency_ms: z.number().int().min(0),
  cached: z.boolean().optional().default(false),
  live_grounded: z.boolean().optional().default(false),
  role_scope: z.enum(["public", "parent", "admin"]),
  quick_actions: z.array(assistantQuickActionSchema).max(3).default([]),
  suggested_prompts: z.array(z.string()).max(3).default([]),
  navigation_offer: assistantNavigationOfferSchema
    .nullable()
    .optional()
    .default(null),
});

const BANDWIDTH_CLIENT_TIMEOUT_MS: Record<BandwidthProfile, number> = {
  low: 34_000,
  medium: 40_000,
  high: 46_000,
};

export class AssistantRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "AssistantRateLimitError";
  }
}

async function getOptionalAccessToken(): Promise<string | null> {
  try {
    return await getBrowserAccessToken({
      onUnauthorized: () => new Error("UNAUTHENTICATED"),
    });
  } catch {
    return null;
  }
}

function getOptionalApiBaseUrl(): string | null {
  try {
    return getApiBaseUrl();
  } catch {
    return null;
  }
}

function waitAbortAware(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function buildOfflineAssistantReply(
  request: Pick<
    AssistantChatRequest,
    "message" | "current_path" | "locale" | "bandwidth_profile"
  >,
): AssistantChatResponse {
  const normalizedRoleScope = inferAssistantRoleScope(request.current_path);
  const offline = resolveOfflineAssistantReply(
    request.message,
    request.current_path,
    request.locale,
    request.bandwidth_profile,
  );
  return {
    ...offline,
    live_grounded: false,
    role_scope: normalizedRoleScope,
    quick_actions: offline.quick_actions.filter((action) =>
      isSafeAssistantQuickActionHref(
        action.href,
        request.current_path,
        normalizedRoleScope,
      ),
    ),
    navigation_offer: isSafeAssistantNavigationHref(
      offline.navigation_offer?.href,
      request.current_path,
      normalizedRoleScope,
    )
      ? offline.navigation_offer
      : null,
  };
}

export async function sendAssistantMessage(
  request: SendAssistantMessageInput,
  options?: {
    readonly signal?: AbortSignal;
    readonly online?: boolean;
    readonly selectedChildId?: string | null;
  },
): Promise<AssistantChatResponse> {
  const isOnline =
    options?.online !== undefined
      ? options.online
      : typeof navigator === "undefined" || navigator.onLine !== false;

  const apiBaseUrl = getOptionalApiBaseUrl();
  if (!isOnline || !apiBaseUrl) {
    return buildOfflineAssistantReply(request);
  }

  const normalizedRoleScope = inferAssistantRoleScope(request.current_path);
  const rawSelectedChildId =
    request.selectedChildId ??
    request.selected_child_id ??
    options?.selectedChildId ??
    null;
  const trimmedSelectedChildId =
    typeof rawSelectedChildId === "string" ? rawSelectedChildId.trim() : "";

  const wireBody: AssistantChatRequest = {
    message: request.message,
    current_path: request.current_path,
    locale: request.locale,
    bandwidth_profile: request.bandwidth_profile,
    history: request.history,
    ...(request.force_llm !== undefined
      ? { force_llm: request.force_llm }
      : {}),
    ...(normalizedRoleScope === "parent" && trimmedSelectedChildId.length > 0
      ? { selected_child_id: trimmedSelectedChildId }
      : {}),
  };

  let token = await getOptionalAccessToken();
  const timeoutMs = BANDWIDTH_CLIENT_TIMEOUT_MS[request.bandwidth_profile];
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const forwardAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", forwardAbort, { once: true });

  const executeAttempt = async (authToken: string | null) => {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    return fetch(`${apiBaseUrl}/assistant/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(wireBody),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
  };

  try {
    let response = await executeAttempt(token);

    if (response.status === 401 && token) {
      invalidateBrowserTokenCache();
      token = await getOptionalAccessToken();
      if (token && !controller.signal.aborted) {
        response = await executeAttempt(token);
      }
    } else if (
      (response.status === 502 ||
        response.status === 503 ||
        response.status === 504) &&
      timeoutMs - (Date.now() - startedAt) > 4_000
    ) {
      const okToRetry = await waitAbortAware(600, controller.signal);
      if (okToRetry) {
        response = await executeAttempt(token);
      }
    }

    if (response.status === 401) {
      invalidateBrowserTokenCache();
    }

    if (response.status === 429) {
      const retryRaw = response.headers.get("retry-after");
      const retryAfter =
        retryRaw && Number.isFinite(Number(retryRaw)) ? Number(retryRaw) : null;
      throw new AssistantRateLimitError("RATE_LIMITED", retryAfter);
    }

    if (!response.ok) {
      return buildOfflineAssistantReply(request);
    }

    const payload: unknown = await response.json();
    const parsed = assistantChatResponseSchema.safeParse(payload);
    if (!parsed.success) {
      return buildOfflineAssistantReply(request);
    }

    const data = parsed.data;
    const safeQuickActions = data.quick_actions.filter((action) =>
      isSafeAssistantQuickActionHref(
        action.href,
        request.current_path,
        normalizedRoleScope,
      ),
    );
    const safeOffer = isSafeAssistantNavigationHref(
      data.navigation_offer?.href,
      request.current_path,
      normalizedRoleScope,
    )
      ? data.navigation_offer
      : null;

    return {
      ...data,
      live_grounded: Boolean(data.live_grounded),
      role_scope: normalizedRoleScope,
      quick_actions: safeQuickActions,
      navigation_offer: safeOffer,
    };
  } catch (error) {
    if (error instanceof AssistantRateLimitError) {
      throw error;
    }
    if (options?.signal?.aborted) {
      throw error;
    }
    return buildOfflineAssistantReply(request);
  } finally {
    clearTimeout(timeoutId);
    options?.signal?.removeEventListener("abort", forwardAbort);
  }
}
