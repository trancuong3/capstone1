/**
 * Parent Voice Provider Policy (`Chỉ máy này` vs `Máy này + Google dự phòng`)
 * and "Một buổi, một giọng" (`SessionVoiceLock`) state manager.
 *
 * Guarantees:
 *  1. Default mode is `local_with_google_fallback` ("Máy này + Google dự phòng") with
 *     automatic Online fallback ON for both STT and TTS, while parents can still switch
 *     to strict `local_only` ("Chỉ máy này") at any time.
 *  2. Separate parent toggles for Speech Recognition (`allowGoogleSttFallback`) and
 *     Sample Reading (`allowGoogleTtsFallback`).
 *  3. Before a reading session starts, locks `(provider, voiceId, region, modelVersion, speed)`
 *     for that `sessionId` and persists in `sessionStorage` across reloads/resumes.
 *  4. Every utterance spoken during the session uses the exact locked voice and records
 *     an auditable trace proving 0 mid-session unintended voice switches.
 */

import {
  clampSpeed,
  getSpeechPreferences,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import {
  getTeacherPersonaForVoice,
  resolveVoiceGender,
  type TeacherPersona,
  type VoiceGender,
} from "@/lib/reading/voice-persona";

export type VoiceRegion = "north" | "central" | "south";
export type VoiceProviderMode = "local_only" | "local_with_google_fallback";
export type VoiceProviderKind = "local" | "google";

export const DEFAULT_LOCAL_VOICE_ID = "local_north_truc_ly";
export const DEFAULT_LOCAL_TTS_MODEL_VERSION =
  "vieneu-v3-turbo-onnx-fp32-3.8.5";
export const GOOGLE_TTS_MODEL_VERSION = "google-cloud-tts-v1";

export const VOICE_REGION_LABELS: Readonly<Record<VoiceRegion, string>> = {
  north: "Miền Bắc",
  central: "Miền Trung",
  south: "Miền Nam",
};

export const REGION_DEFAULT_VOICE_ID: Readonly<Record<VoiceRegion, string>> = {
  north: "local_north_truc_ly",
  central: "local_central_ngoc_tran",
  south: "local_south_thuc_doan",
};

export interface VoicePolicyPreferences {
  readonly region: VoiceRegion;
  readonly providerMode: VoiceProviderMode;
  readonly allowGoogleSttFallback: boolean;
  readonly allowGoogleTtsFallback: boolean;
  readonly modelVersion: string;
}

export interface SessionVoiceLock {
  readonly sessionId: string;
  readonly provider: VoiceProviderKind;
  readonly voiceId: string;
  readonly gender?: VoiceGender;
  readonly region: VoiceRegion;
  readonly modelVersion: string;
  readonly speed: number;
  readonly lockedAt: string;
}

export interface SessionUtteranceAuditEntry {
  readonly index: number;
  readonly kind: string;
  readonly provider: VoiceProviderKind;
  readonly voiceId: string;
  readonly region: VoiceRegion;
  readonly modelVersion: string;
  readonly speed: number;
  readonly textPreview: string;
}

const POLICY_STORAGE_KEY = "viread.voice-policy.v2";
const LOCK_STORAGE_PREFIX = "viread.session-voice-lock.v1.";

const DEFAULT_POLICY: VoicePolicyPreferences = {
  region: "north",
  providerMode: "local_with_google_fallback",
  allowGoogleSttFallback: true,
  allowGoogleTtsFallback: true,
  modelVersion: DEFAULT_LOCAL_TTS_MODEL_VERSION,
};

type Listener = () => void;
const listeners = new Set<Listener>();
let cachedPolicy: VoicePolicyPreferences | null = null;
let activeSessionId: string | null = null;
const memoryLocks = new Map<string, SessionVoiceLock>();
const utteranceAudits = new Map<string, SessionUtteranceAuditEntry[]>();

export function inferRegionFromVoiceId(
  voiceId: string | null | undefined,
  fallback: VoiceRegion = "north",
): VoiceRegion {
  if (!voiceId) return fallback;
  const lower = voiceId.toLowerCase();
  if (lower.includes("central") || lower.includes("trung")) return "central";
  if (
    lower.includes("south") ||
    lower.includes("nam") ||
    lower.includes("wavenet_b") ||
    lower.includes("wavenet_c")
  ) {
    return "south";
  }
  if (lower.includes("north") || lower.includes("bac")) return "north";
  return fallback;
}

export function inferProviderFromVoiceId(
  voiceId: string | null | undefined,
): VoiceProviderKind {
  if (voiceId && voiceId.toLowerCase().startsWith("google_")) {
    return "google";
  }
  return "local";
}

export function inferModelVersionForVoiceId(
  voiceId: string | null | undefined,
  explicitVersion?: string | null,
): string {
  if (explicitVersion && explicitVersion.trim()) {
    return explicitVersion.trim();
  }
  return inferProviderFromVoiceId(voiceId) === "google"
    ? GOOGLE_TTS_MODEL_VERSION
    : DEFAULT_LOCAL_TTS_MODEL_VERSION;
}

function sanitizePolicy(raw: unknown): VoicePolicyPreferences {
  if (typeof raw !== "object" || raw === null) return DEFAULT_POLICY;
  const rec = raw as Record<string, unknown>;
  const region: VoiceRegion =
    rec.region === "north" || rec.region === "central" || rec.region === "south"
      ? rec.region
      : "north";
  const providerMode: VoiceProviderMode =
    rec.providerMode === "local_only"
      ? "local_only"
      : "local_with_google_fallback";
  const allowGoogleSttFallback =
    providerMode === "local_only"
      ? false
      : rec.allowGoogleSttFallback === undefined
        ? true
        : Boolean(rec.allowGoogleSttFallback);
  const allowGoogleTtsFallback =
    providerMode === "local_only"
      ? false
      : rec.allowGoogleTtsFallback === undefined
        ? true
        : Boolean(rec.allowGoogleTtsFallback);
  const modelVersion =
    typeof rec.modelVersion === "string" &&
    /^[A-Za-z0-9._-]{1,80}$/.test(rec.modelVersion)
      ? rec.modelVersion
      : DEFAULT_LOCAL_TTS_MODEL_VERSION;
  return {
    region,
    providerMode,
    allowGoogleSttFallback,
    allowGoogleTtsFallback,
    modelVersion,
  };
}

function notifyListeners(): void {
  listeners.forEach((fn) => fn());
}

export function getVoicePolicyPreferences(): VoicePolicyPreferences {
  if (typeof window === "undefined") return DEFAULT_POLICY;
  if (cachedPolicy !== null) return cachedPolicy;
  try {
    const raw = window.localStorage.getItem(POLICY_STORAGE_KEY);
    cachedPolicy = raw ? sanitizePolicy(JSON.parse(raw)) : DEFAULT_POLICY;
  } catch {
    cachedPolicy = DEFAULT_POLICY;
  }
  return cachedPolicy;
}

export function setVoicePolicyPreferences(
  update: Partial<VoicePolicyPreferences>,
): VoicePolicyPreferences {
  const next = sanitizePolicy({ ...getVoicePolicyPreferences(), ...update });
  cachedPolicy = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // In-memory state still applies for this page view.
    }
  }
  notifyListeners();
  return next;
}

export function subscribeVoicePolicy(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sanitizeSessionLock(raw: unknown): SessionVoiceLock | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.sessionId !== "string" ||
    !rec.sessionId.trim() ||
    typeof rec.voiceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(rec.voiceId)
  ) {
    return null;
  }
  const provider: VoiceProviderKind =
    rec.provider === "google" ? "google" : "local";
  const region: VoiceRegion =
    rec.region === "north" || rec.region === "central" || rec.region === "south"
      ? rec.region
      : inferRegionFromVoiceId(rec.voiceId);
  const modelVersion =
    typeof rec.modelVersion === "string" && rec.modelVersion.trim()
      ? rec.modelVersion.trim()
      : inferModelVersionForVoiceId(rec.voiceId);
  const speed = typeof rec.speed === "number" ? clampSpeed(rec.speed) : 0.9;
  const gender: VoiceGender =
    rec.gender === "male" || rec.gender === "female"
      ? rec.gender
      : resolveVoiceGender(rec.voiceId);
  const lockedAt =
    typeof rec.lockedAt === "string" && rec.lockedAt
      ? rec.lockedAt
      : new Date().toISOString();

  return {
    sessionId: rec.sessionId.trim(),
    provider,
    voiceId: rec.voiceId,
    gender,
    region,
    modelVersion,
    speed,
    lockedAt,
  };
}

function isLegacyExternalVoiceId(voiceId: string | null | undefined): boolean {
  const cleaned = (voiceId ?? "").trim();
  if (!cleaned) return false;
  if (cleaned.startsWith("local_") || cleaned.startsWith("google_")) {
    return false;
  }
  // Legacy ElevenLabs IDs saved in old browser localStorage are 18-28 mixed-case alphanumeric chars
  return /^[A-Za-z0-9]{18,28}$/.test(cleaned);
}

export function getSessionVoiceLock(
  sessionId: string,
): SessionVoiceLock | null {
  const key = sessionId.trim();
  if (!key) return null;
  const inMem = memoryLocks.get(key);
  if (inMem) return inMem;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`${LOCK_STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = sanitizeSessionLock(JSON.parse(raw));
    if (parsed) {
      memoryLocks.set(key, parsed);
      return parsed;
    }
  } catch {
    // Ignore blocked sessionStorage
  }
  return null;
}

export function lockSessionVoice(
  sessionId: string,
  overrides?: {
    readonly voiceId?: string | null;
    readonly speed?: number;
    readonly region?: VoiceRegion;
    readonly modelVersion?: string;
    readonly forceUpdate?: boolean;
  },
): SessionVoiceLock {
  const cleanSessionId = sessionId.trim();
  const existing = getSessionVoiceLock(cleanSessionId);
  if (
    existing &&
    !overrides?.forceUpdate &&
    !isLegacyExternalVoiceId(existing.voiceId)
  ) {
    activeSessionId = cleanSessionId;
    return existing;
  }

  const speechPrefs = getSpeechPreferences();
  const policyPrefs = getVoicePolicyPreferences();
  let requestedVoice = overrides?.voiceId ?? speechPrefs.voiceId;
  if (isLegacyExternalVoiceId(requestedVoice)) {
    requestedVoice = null;
    if (isLegacyExternalVoiceId(speechPrefs.voiceId)) {
      setSpeechPreferences({ voiceId: null });
    }
  }
  const region =
    overrides?.region ??
    inferRegionFromVoiceId(requestedVoice, policyPrefs.region);
  let resolvedVoiceId =
    requestedVoice && /^[A-Za-z0-9_-]{1,100}$/.test(requestedVoice)
      ? requestedVoice
      : (REGION_DEFAULT_VOICE_ID[region] ?? DEFAULT_LOCAL_VOICE_ID);

  // Enforce provider policy: never lock a Google voice when Google TTS is disabled!
  if (
    inferProviderFromVoiceId(resolvedVoiceId) === "google" &&
    (policyPrefs.providerMode !== "local_with_google_fallback" ||
      !policyPrefs.allowGoogleTtsFallback)
  ) {
    resolvedVoiceId = REGION_DEFAULT_VOICE_ID[region] ?? DEFAULT_LOCAL_VOICE_ID;
  }

  const provider = inferProviderFromVoiceId(resolvedVoiceId);
  const modelVersion = inferModelVersionForVoiceId(
    resolvedVoiceId,
    overrides?.modelVersion ?? policyPrefs.modelVersion,
  );
  const speed = clampSpeed(overrides?.speed ?? speechPrefs.speed);

  const lock: SessionVoiceLock = {
    sessionId: cleanSessionId,
    provider,
    voiceId: resolvedVoiceId,
    gender: resolveVoiceGender(resolvedVoiceId),
    region: inferRegionFromVoiceId(resolvedVoiceId, region),
    modelVersion,
    speed,
    lockedAt: new Date().toISOString(),
  };

  memoryLocks.set(cleanSessionId, lock);
  activeSessionId = cleanSessionId;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(
        `${LOCK_STORAGE_PREFIX}${cleanSessionId}`,
        JSON.stringify(lock),
      );
    } catch {
      // Keep in-memory lock active
    }
  }
  notifyListeners();
  return lock;
}

export function setActiveVoiceSession(sessionId: string | null): void {
  activeSessionId = sessionId ? sessionId.trim() || null : null;
  notifyListeners();
}

export function getActiveSessionVoiceLock(): SessionVoiceLock | null {
  if (!activeSessionId) return null;
  return getSessionVoiceLock(activeSessionId);
}

export function releaseSessionVoiceLock(sessionId: string): void {
  const clean = sessionId.trim();
  memoryLocks.delete(clean);
  if (activeSessionId === clean) {
    activeSessionId = null;
  }
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(`${LOCK_STORAGE_PREFIX}${clean}`);
    } catch {
      // Ignore
    }
  }
  notifyListeners();
}

export function recordSessionUtteranceVoice(
  entry: Omit<SessionUtteranceAuditEntry, "index">,
  sessionId?: string | null,
): void {
  const sid = (sessionId ?? activeSessionId ?? "__global__").trim();
  const list = utteranceAudits.get(sid) ?? [];
  list.push({
    ...entry,
    index: list.length,
    textPreview: entry.textPreview.slice(0, 80),
  });
  if (list.length > 250) {
    list.shift();
  }
  utteranceAudits.set(sid, list);
}

export function getSessionVoiceAudit(
  sessionId?: string | null,
): readonly SessionUtteranceAuditEntry[] {
  const sid = (sessionId ?? activeSessionId ?? "__global__").trim();
  return utteranceAudits.get(sid) ?? [];
}

/** Count how many times `(provider, voiceId, region, modelVersion)` switched unexpectedly in a session. */
export function countUnintendedVoiceSwitches(
  sessionId?: string | null,
): number {
  const entries = getSessionVoiceAudit(sessionId);
  if (entries.length <= 1) return 0;
  let switches = 0;
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const curr = entries[i];
    if (
      prev.provider !== curr.provider ||
      prev.voiceId !== curr.voiceId ||
      prev.region !== curr.region ||
      prev.modelVersion !== curr.modelVersion
    ) {
      switches += 1;
    }
  }
  return switches;
}

/** Resolve the single source of truth for the active/selected voice across ALL screens. */
export function getEffectiveVoiceId(): string {
  const active = getActiveSessionVoiceLock();
  if (active?.voiceId && !isLegacyExternalVoiceId(active.voiceId)) {
    return active.voiceId;
  }
  const prefs = getSpeechPreferences();
  if (prefs.voiceId && !isLegacyExternalVoiceId(prefs.voiceId)) {
    return prefs.voiceId;
  }
  const policy = getVoicePolicyPreferences();
  return REGION_DEFAULT_VOICE_ID[policy.region] ?? DEFAULT_LOCAL_VOICE_ID;
}

/** Resolve the consistent Teacher Persona ("Cô giáo AI" vs "Thầy giáo AI") across ALL screens. */
export function getEffectiveTeacherPersona(): TeacherPersona {
  const active = getActiveSessionVoiceLock();
  const voiceId = getEffectiveVoiceId();
  return getTeacherPersonaForVoice(voiceId, active?.gender ?? null);
}

export function resetVoiceLockAndPolicyForTests(): void {
  cachedPolicy = null;
  activeSessionId = null;
  memoryLocks.clear();
  utteranceAudits.clear();
}
