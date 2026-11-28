import { getBrowserAccessToken } from "@/lib/api/browser-auth";
import {
  getEffectiveVoiceId,
  getVoicePolicyPreferences,
  inferRegionFromVoiceId,
  subscribeVoicePolicy,
  type VoiceRegion,
} from "@/lib/reading/session-voice-lock";
import {
  resolveVoiceGender,
  type VoiceGender,
} from "@/lib/reading/voice-persona";
import { getApiBaseUrl } from "@/lib/supabase/config";

export type VoiceEngineTier =
  | "local_offline"
  | "catalog_cache"
  | "android_native"
  | "browser_wasm"
  | "elevenlabs_cloud"
  | "google_cloud"
  | "browser_default"
  | "idle";

export interface VoiceEngineHealthSnapshot {
  readonly default_mode: string;
  readonly default_voice_id: string;
  readonly local: {
    readonly configured?: boolean;
    readonly mode?: string | null;
    readonly available: boolean;
    readonly stt_ready: boolean;
    readonly tts_ready: boolean;
    readonly error_code?: string | null;
    readonly stt_error_code?: string | null;
    readonly tts_error_code?: string | null;
    readonly stt_model_version?: string | null;
    readonly tts_model_version?: string | null;
  };
  readonly google: {
    readonly stt_configured: boolean;
    readonly tts_configured: boolean;
    readonly stt_cooldown: boolean;
    readonly tts_cooldown: boolean;
  };
  readonly elevenlabs?: {
    readonly configured: boolean;
    readonly stt_configured: boolean;
    readonly tts_configured: boolean;
    readonly male_tts_configured?: boolean;
    readonly stt_cooldown?: boolean;
    readonly tts_cooldown?: boolean;
    readonly error_code?: string | null;
    readonly model_id?: string | null;
    readonly voice_id?: string | null;
  };
}

export interface EngineSourceSnapshot {
  tier: VoiceEngineTier;
  provider: string;
  engineLabel: string;
  shortLabel: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  voiceId: string | null;
  voiceGender: VoiceGender | null;
  updatedAt: number;
}

export interface VoiceEngineStatusState {
  stt: EngineSourceSnapshot;
  tts: EngineSourceSnapshot;
}

function createIdleSnapshot(kind: "stt" | "tts"): EngineSourceSnapshot {
  return {
    tier: "idle",
    provider: "idle",
    engineLabel:
      kind === "stt"
        ? "Đang kiểm tra nhận diện giọng nói…"
        : "Đang kiểm tra giọng đọc…",
    shortLabel: "Đang kiểm tra…",
    fallbackUsed: false,
    fallbackReason: null,
    voiceId: null,
    voiceGender: null,
    updatedAt: 0,
  };
}

export const VOICE_HEALTH_FRESHNESS_MS = 30_000;
export const VOICE_UNCONFIGURED_ROUTING_TTL_MS = 10 * 60_000;
export const VOICE_LOCAL_DOWN_ROUTING_TTL_MS = 2 * 60_000;

let state: VoiceEngineStatusState = {
  stt: createIdleSnapshot("stt"),
  tts: createIdleSnapshot("tts"),
};

let cachedHealth: VoiceEngineHealthSnapshot | null = null;
let cachedHealthFetchedAt = 0;
let inFlightHealthPromise: Promise<VoiceEngineHealthSnapshot | null> | null =
  null;
let permanentlyHostedLocalUnconfigured = false;

const listeners = new Set<() => void>();
const healthListeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function emitHealth(): void {
  for (const listener of healthListeners) {
    listener();
  }
}

export function isHostedLocalVoiceUnconfigured(
  health: VoiceEngineHealthSnapshot | null = cachedHealth,
): boolean {
  if (!health) return false;
  return (
    health.local.configured === false ||
    health.local.error_code === "LOCAL_VOICE_UNCONFIGURED"
  );
}

export function markHostedLocalUnconfigured(): void {
  if (permanentlyHostedLocalUnconfigured) return;
  permanentlyHostedLocalUnconfigured = true;
  emitHealth();
}

export function isPermanentlyHostedLocalUnconfigured(
  health: VoiceEngineHealthSnapshot | null = cachedHealth,
): boolean {
  return (
    permanentlyHostedLocalUnconfigured || isHostedLocalVoiceUnconfigured(health)
  );
}

export function subscribeVoiceEngineHealth(listener: () => void): () => void {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
}

export function getBrowserOnlineStatus(): boolean {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.onLine !== "boolean"
  ) {
    return true;
  }
  return navigator.onLine;
}

export function subscribeBrowserOnlineStatus(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function mapProviderToEngineSnapshot(input: {
  kind: "stt" | "tts";
  provider?: string | null;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  voiceId?: string | null;
  voiceGender?: VoiceGender | null;
}): EngineSourceSnapshot {
  const normalized = (input.provider ?? "").trim().toLowerCase();
  const isStt = input.kind === "stt";

  let tier: VoiceEngineTier = "local_offline";
  let engineLabel = isStt ? "Nhận diện ViRead" : "Giọng đọc ViRead";
  let shortLabel = "ViRead";

  if (
    normalized === "wasm" ||
    normalized === "browser_wasm" ||
    normalized === "wasm_tts"
  ) {
    tier = "browser_wasm";
    engineLabel = isStt ? "Offline (WASM trên máy)" : "Offline (WASM TTS)";
    shortLabel = isStt ? "Offline (WASM)" : "Offline (WASM TTS)";
  } else if (normalized === "precomputed_cache") {
    tier = "local_offline";
    engineLabel = "Giọng đọc chuẩn bị sẵn";
    shortLabel = "Chuẩn bị sẵn";
  } else if (normalized === "catalog_cache" || normalized === "precomputed") {
    tier = "catalog_cache";
    engineLabel = "Giọng đọc chuẩn";
    shortLabel = "Chuẩn";
  } else if (
    normalized === "android_native" ||
    normalized === "android" ||
    normalized === "native_android"
  ) {
    tier = "android_native";
    engineLabel = isStt ? "Android (vi-VN)" : "Android TTS (vi-VN)";
    shortLabel = "Android (vi-VN)";
  } else if (
    normalized === "elevenlabs" ||
    normalized.startsWith("elevenlabs")
  ) {
    tier = "elevenlabs_cloud";
    engineLabel = isStt ? "ElevenLabs Scribe v2" : "ElevenLabs Cloud";
    shortLabel = "ElevenLabs";
  } else if (normalized === "google" || normalized.startsWith("google")) {
    tier = "google_cloud";
    engineLabel = "Trực tuyến";
    shortLabel = "Trực tuyến";
  } else if (
    normalized === "browser" ||
    normalized === "webspeech" ||
    normalized === "speechsynthesis"
  ) {
    tier = "browser_default";
    engineLabel = "Trình duyệt mặc định";
    shortLabel = "Trình duyệt";
  }

  return {
    tier,
    provider: normalized || "local",
    engineLabel,
    shortLabel,
    fallbackUsed:
      Boolean(input.fallbackUsed) ||
      tier === "android_native" ||
      tier === "google_cloud" ||
      tier === "browser_default",
    fallbackReason: input.fallbackReason?.trim() || null,
    voiceId: input.voiceId ?? null,
    voiceGender: input.voiceGender ?? null,
    updatedAt: Date.now(),
  };
}

export function recordTtsEngineUsage(input: {
  provider?: string | null;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  voiceId?: string | null;
  voiceGender?: VoiceGender | null;
}): void {
  state = {
    ...state,
    tts: mapProviderToEngineSnapshot({
      kind: "tts",
      ...input,
    }),
  };
  emit();
}

export function recordSttEngineUsage(input: {
  provider?: string | null;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
}): void {
  state = {
    ...state,
    stt: mapProviderToEngineSnapshot({
      kind: "stt",
      ...input,
    }),
  };
  emit();
}

export function getVoiceEngineStatus(): VoiceEngineStatusState {
  return state;
}

export function subscribeVoiceEngineStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCachedVoiceEngineHealth(): VoiceEngineHealthSnapshot | null {
  return cachedHealth;
}

export function getFreshVoiceEngineHealth(
  maxAgeMs = VOICE_HEALTH_FRESHNESS_MS,
): VoiceEngineHealthSnapshot | null {
  if (!cachedHealth || cachedHealthFetchedAt <= 0) return null;
  if (Date.now() - cachedHealthFetchedAt > maxAgeMs) return null;
  return cachedHealth;
}

/**
 * Returns fresh voice health, or retains a confirmed `LOCAL_VOICE_UNCONFIGURED`
 * hosted-backend health snapshot for up to 10 minutes so mobile/web sessions do
 * not regress into doomed localhost-worker roundtrips after 30 seconds idle.
 */
function seedIdleStatusFromHealth(
  health: VoiceEngineHealthSnapshot,
  forceRefresh = false,
): void {
  const policy = getVoicePolicyPreferences();
  const allowCloudStt =
    policy.providerMode === "local_with_google_fallback" &&
    policy.allowGoogleSttFallback;
  const allowCloudTts =
    policy.providerMode === "local_with_google_fallback" &&
    policy.allowGoogleTtsFallback;
  const effectiveVoiceId = getEffectiveVoiceId();
  const effectiveGender = resolveVoiceGender(effectiveVoiceId);

  let changed = false;
  let nextStt = state.stt;
  let nextTts = state.tts;

  if (state.stt.tier === "idle" || forceRefresh) {
    const sttProvider =
      health.local.available && health.local.stt_ready
        ? "local"
        : allowCloudStt &&
            health.elevenlabs?.stt_configured &&
            !health.elevenlabs.stt_cooldown
          ? "elevenlabs"
          : allowCloudStt &&
              health.google.stt_configured &&
              !health.google.stt_cooldown
            ? "google"
            : "wasm";
    nextStt = mapProviderToEngineSnapshot({
      kind: "stt",
      provider: sttProvider,
      fallbackUsed: false,
      fallbackReason: null,
    });
    changed = true;
  }

  if (state.tts.tier === "idle" || forceRefresh) {
    const elevenLabsTtsUsable = Boolean(
      allowCloudTts &&
      health.elevenlabs?.tts_configured &&
      !health.elevenlabs.tts_cooldown &&
      (effectiveGender !== "male" ||
        health.elevenlabs.male_tts_configured === true),
    );
    const ttsProvider =
      health.local.available && health.local.tts_ready
        ? "local"
        : elevenLabsTtsUsable
          ? "elevenlabs"
          : allowCloudTts &&
              health.google.tts_configured &&
              !health.google.tts_cooldown
            ? "google"
            : "precomputed_cache";
    nextTts = mapProviderToEngineSnapshot({
      kind: "tts",
      provider: ttsProvider,
      fallbackUsed: false,
      fallbackReason: null,
      voiceId: effectiveVoiceId,
      voiceGender: effectiveGender,
    });
    changed = true;
  }

  if (changed) {
    state = { stt: nextStt, tts: nextTts };
    emit();
  }
}

subscribeVoicePolicy(() => {
  if (cachedHealth) {
    seedIdleStatusFromHealth(cachedHealth, state.stt.tier === "idle");
  }
});

export function getVoiceEngineHealthForRouting(
  maxAgeMs = VOICE_HEALTH_FRESHNESS_MS,
): VoiceEngineHealthSnapshot | null {
  const fresh = getFreshVoiceEngineHealth(maxAgeMs);
  if (fresh) return fresh;
  if (cachedHealth && cachedHealthFetchedAt > 0) {
    const age = Date.now() - cachedHealthFetchedAt;
    if (
      isHostedLocalVoiceUnconfigured(cachedHealth) &&
      age <= VOICE_UNCONFIGURED_ROUTING_TTL_MS
    ) {
      return cachedHealth;
    }
    if (
      !cachedHealth.local.available &&
      age <= VOICE_LOCAL_DOWN_ROUTING_TTL_MS
    ) {
      if (
        typeof window !== "undefined" &&
        process.env.NODE_ENV !== "test" &&
        !inFlightHealthPromise
      ) {
        void fetchVoiceEngineHealth().catch(() => null);
      }
      return cachedHealth;
    }
  }
  return null;
}

export function setCachedVoiceEngineHealth(
  health: VoiceEngineHealthSnapshot | null,
  fetchedAt = Date.now(),
): void {
  cachedHealth = health;
  cachedHealthFetchedAt = health ? fetchedAt : 0;
  if (health) {
    if (
      health.local.configured === false ||
      health.local.error_code === "LOCAL_VOICE_UNCONFIGURED"
    ) {
      permanentlyHostedLocalUnconfigured = true;
    } else if (health.local.configured === true && health.local.available) {
      permanentlyHostedLocalUnconfigured = false;
    }
    seedIdleStatusFromHealth(health);
  }
  emitHealth();
}

export function resetVoiceEngineStatus(): void {
  cachedHealth = null;
  cachedHealthFetchedAt = 0;
  inFlightHealthPromise = null;
  permanentlyHostedLocalUnconfigured = false;
  state = {
    stt: createIdleSnapshot("stt"),
    tts: createIdleSnapshot("tts"),
  };
  emit();
  emitHealth();
}

export function mapLocalVoiceToGoogleBackup(
  voiceId: string | null | undefined,
  regionHint?: VoiceRegion,
): string {
  const gender = resolveVoiceGender(voiceId);
  const region = inferRegionFromVoiceId(voiceId, regionHint ?? "north");
  if (region === "south") {
    return gender === "male"
      ? "google_vi_vn_wavenet_b"
      : "google_vi_vn_wavenet_c";
  }
  return gender === "male"
    ? "google_vi_vn_neural2_d"
    : "google_vi_vn_neural2_a";
}

async function performFetchVoiceEngineHealth(): Promise<VoiceEngineHealthSnapshot | null> {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return null;
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);

  try {
    let token: string;
    try {
      token = await getBrowserAccessToken({
        onUnauthorized: () => new Error("AUTH_REQUIRED"),
      });
    } catch {
      return null;
    }
    if (!token || controller.signal.aborted) return null;

    const response = await fetch(`${getApiBaseUrl()}/voice/status`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const localRaw = rec.local as Record<string, unknown> | undefined;
    const googleRaw = rec.google as Record<string, unknown> | undefined;
    const elevenlabsRaw =
      rec.elevenlabs && typeof rec.elevenlabs === "object"
        ? (rec.elevenlabs as Record<string, unknown>)
        : undefined;
    if (!localRaw || !googleRaw) return null;

    const snapshot: VoiceEngineHealthSnapshot = {
      default_mode:
        typeof rec.default_mode === "string" ? rec.default_mode : "local_only",
      default_voice_id:
        typeof rec.default_voice_id === "string"
          ? rec.default_voice_id
          : "local_north_truc_ly",
      local: {
        ...(typeof localRaw.configured === "boolean"
          ? { configured: localRaw.configured }
          : {}),
        ...(typeof localRaw.mode === "string" ? { mode: localRaw.mode } : {}),
        available: Boolean(localRaw.available),
        stt_ready: Boolean(localRaw.stt_ready),
        tts_ready: Boolean(localRaw.tts_ready),
        error_code:
          typeof localRaw.error_code === "string" ? localRaw.error_code : null,
        stt_error_code:
          typeof localRaw.stt_error_code === "string"
            ? localRaw.stt_error_code
            : null,
        tts_error_code:
          typeof localRaw.tts_error_code === "string"
            ? localRaw.tts_error_code
            : null,
        stt_model_version:
          typeof localRaw.stt_model_version === "string"
            ? localRaw.stt_model_version
            : null,
        tts_model_version:
          typeof localRaw.tts_model_version === "string"
            ? localRaw.tts_model_version
            : null,
      },
      google: {
        stt_configured: Boolean(googleRaw.stt_configured),
        tts_configured: Boolean(googleRaw.tts_configured),
        stt_cooldown: Boolean(googleRaw.stt_cooldown),
        tts_cooldown: Boolean(googleRaw.tts_cooldown),
      },
      ...(elevenlabsRaw
        ? {
            elevenlabs: {
              configured: Boolean(elevenlabsRaw.configured),
              stt_configured: Boolean(elevenlabsRaw.stt_configured),
              tts_configured: Boolean(elevenlabsRaw.tts_configured),
              ...(typeof elevenlabsRaw.male_tts_configured === "boolean"
                ? { male_tts_configured: elevenlabsRaw.male_tts_configured }
                : {}),
              ...(typeof elevenlabsRaw.stt_cooldown === "boolean"
                ? { stt_cooldown: elevenlabsRaw.stt_cooldown }
                : {}),
              ...(typeof elevenlabsRaw.tts_cooldown === "boolean"
                ? { tts_cooldown: elevenlabsRaw.tts_cooldown }
                : {}),
              ...(typeof elevenlabsRaw.error_code === "string" ||
              elevenlabsRaw.error_code === null
                ? {
                    error_code:
                      typeof elevenlabsRaw.error_code === "string"
                        ? elevenlabsRaw.error_code
                        : null,
                  }
                : {}),
              model_id:
                typeof elevenlabsRaw.model_id === "string"
                  ? elevenlabsRaw.model_id
                  : null,
              voice_id:
                typeof elevenlabsRaw.voice_id === "string"
                  ? elevenlabsRaw.voice_id
                  : null,
            },
          }
        : {}),
    };
    setCachedVoiceEngineHealth(snapshot);
    return snapshot;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchVoiceEngineHealth(
  signal?: AbortSignal,
): Promise<VoiceEngineHealthSnapshot | null> {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return null;
  }
  if (signal?.aborted) return null;

  if (!inFlightHealthPromise) {
    const req = performFetchVoiceEngineHealth().finally(() => {
      if (inFlightHealthPromise === req) {
        inFlightHealthPromise = null;
      }
    });
    inFlightHealthPromise = req;
  }

  const shared = inFlightHealthPromise;
  if (!signal) {
    return shared;
  }

  return new Promise<VoiceEngineHealthSnapshot | null>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void shared.then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
}
