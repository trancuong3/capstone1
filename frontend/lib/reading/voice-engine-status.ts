import {
  inferRegionFromVoiceId,
  type VoiceRegion,
} from "@/lib/reading/session-voice-lock";
import {
  resolveVoiceGender,
  type VoiceGender,
} from "@/lib/reading/voice-persona";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

export type VoiceEngineTier =
  "local_offline" | "google_cloud" | "browser_default" | "idle";

export interface VoiceEngineHealthSnapshot {
  readonly default_mode: string;
  readonly default_voice_id: string;
  readonly local: {
    readonly available: boolean;
    readonly stt_ready: boolean;
    readonly tts_ready: boolean;
    readonly stt_model_version?: string | null;
    readonly tts_model_version?: string | null;
  };
  readonly google: {
    readonly stt_configured: boolean;
    readonly tts_configured: boolean;
    readonly stt_cooldown: boolean;
    readonly tts_cooldown: boolean;
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
    provider: "local",
    engineLabel:
      kind === "stt" ? "Offline (Sherpa-ONNX)" : "Offline (VieNeu-TTS)",
    shortLabel: "Offline",
    fallbackUsed: false,
    fallbackReason: null,
    voiceId: null,
    voiceGender: null,
    updatedAt: 0,
  };
}

export const VOICE_HEALTH_FRESHNESS_MS = 60_000;

let state: VoiceEngineStatusState = {
  stt: createIdleSnapshot("stt"),
  tts: createIdleSnapshot("tts"),
};

let cachedHealth: VoiceEngineHealthSnapshot | null = null;
let cachedHealthFetchedAt = 0;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
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
  let engineLabel = isStt ? "Offline (Sherpa-ONNX)" : "Offline (VieNeu-TTS)";
  let shortLabel = "Offline";

  if (normalized === "google" || normalized.startsWith("google")) {
    tier = "google_cloud";
    engineLabel = "Google Cloud API";
    shortLabel = "Online (Google API)";
  } else if (
    normalized === "browser" ||
    normalized === "webspeech" ||
    normalized === "speechsynthesis"
  ) {
    tier = "browser_default";
    engineLabel = "Trình duyệt mặc định";
    shortLabel = "Online (Google/Trình duyệt)";
  }

  return {
    tier,
    provider: normalized || "local",
    engineLabel,
    shortLabel,
    fallbackUsed:
      Boolean(input.fallbackUsed) ||
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

export function setCachedVoiceEngineHealth(
  health: VoiceEngineHealthSnapshot | null,
  fetchedAt = Date.now(),
): void {
  cachedHealth = health;
  cachedHealthFetchedAt = health ? fetchedAt : 0;
}

export function resetVoiceEngineStatus(): void {
  cachedHealth = null;
  cachedHealthFetchedAt = 0;
  state = {
    stt: createIdleSnapshot("stt"),
    tts: createIdleSnapshot("tts"),
  };
  emit();
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

export async function fetchVoiceEngineHealth(
  signal?: AbortSignal,
): Promise<VoiceEngineHealthSnapshot | null> {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return null;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) return null;
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), 4_000);

  try {
    const supabase = createBrowserSupabaseClient();
    const { data, error } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (error || !token || controller.signal.aborted) return null;

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
    if (!localRaw || !googleRaw) return null;

    const snapshot: VoiceEngineHealthSnapshot = {
      default_mode:
        typeof rec.default_mode === "string" ? rec.default_mode : "local_only",
      default_voice_id:
        typeof rec.default_voice_id === "string"
          ? rec.default_voice_id
          : "local_north_truc_ly",
      local: {
        available: Boolean(localRaw.available),
        stt_ready: Boolean(localRaw.stt_ready),
        tts_ready: Boolean(localRaw.tts_ready),
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
    };
    setCachedVoiceEngineHealth(snapshot);
    return snapshot;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
