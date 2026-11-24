import type { VoiceGender } from "@/lib/reading/voice-persona";

export type VoiceEngineTier =
  "local_offline" | "google_cloud" | "browser_default" | "idle";

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

let state: VoiceEngineStatusState = {
  stt: createIdleSnapshot("stt"),
  tts: createIdleSnapshot("tts"),
};

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
    shortLabel = "Google API";
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

export function resetVoiceEngineStatus(): void {
  state = {
    stt: createIdleSnapshot("stt"),
    tts: createIdleSnapshot("tts"),
  };
  emit();
}
