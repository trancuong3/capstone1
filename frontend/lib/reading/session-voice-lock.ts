/**
 * Parent Voice Provider Policy (`Chỉ máy này` vs `Máy này + Google dự phòng`)
 * and "Một buổi, một giọng" (`SessionVoiceLock`) state manager.
 *
 * Guarantees:
 *  1. Default mode is `local_only` ("Chỉ máy này") so child audio stays offline
 *     by default, while parents can opt in to `local_with_google_fallback` at any time.
 *  2. Separate parent toggles for Speech Recognition (`allowGoogleSttFallback`) and
 *     Sample Reading (`allowGoogleTtsFallback`).
 *  3. Before a reading session starts, locks `(provider, voiceId, region, modelVersion, speed)`
 *     for that `sessionId` and persists in `sessionStorage` across reloads/resumes.
 *  4. Every utterance spoken during the session uses the exact locked voice and records
 *     an auditable trace proving 0 mid-session unintended voice switches.
 */

import {
  clampSpeed,
  DEFAULT_SPEED,
  getSpeechPreferences,
  getSpeechPreferencesMeta,
  resetSpeechPreferencesForActorSwitch,
  setSpeechPreferences,
  setSpeechPreferencesMeta,
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

export const REGION_GENDER_DEFAULT_VOICE_ID: Readonly<
  Record<VoiceRegion, Readonly<Record<VoiceGender, string>>>
> = {
  north: {
    female: "local_north_truc_ly",
    male: "local_north_thien_minh",
  },
  central: {
    female: "local_central_ngoc_tran",
    male: "local_central_quang_son",
  },
  south: {
    female: "local_south_thuc_doan",
    male: "local_south_thai_son",
  },
};

export const REGION_DEFAULT_MALE_VOICE_ID: Readonly<
  Record<VoiceRegion, string>
> = {
  north: "local_north_thien_minh",
  central: "local_central_quang_son",
  south: "local_south_thai_son",
};

export interface StaticLocalVoiceCatalogItem {
  readonly voice_id: string;
  readonly name: string;
  readonly provider: "local";
  readonly region: VoiceRegion;
  readonly region_label: string;
  readonly model_version: string;
  readonly category: string;
  readonly gender: VoiceGender;
  readonly accent: string;
  readonly use_case: string;
  readonly description: string;
  readonly preview_url: null;
  readonly is_default: boolean;
}

export const STATIC_LOCAL_VOICES: readonly StaticLocalVoiceCatalogItem[] = [
  {
    voice_id: "local_north_truc_ly",
    name: "Cô Trúc Ly",
    provider: "local",
    region: "north",
    region_label: "Miền Bắc",
    model_version: DEFAULT_LOCAL_TTS_MODEL_VERSION,
    category: "local_neural",
    gender: "female",
    accent: "Miền Bắc",
    use_case: "reading_coach",
    description: "Miền Bắc · Nữ · Tự nhiên, ấm áp",
    preview_url: null,
    is_default: true,
  },
  {
    voice_id: "local_north_ngoc_linh",
    name: "Cô Ngọc Linh",
    provider: "local",
    region: "north",
    region_label: "Miền Bắc",
    model_version: DEFAULT_LOCAL_TTS_MODEL_VERSION,
    category: "local_neural",
    gender: "female",
    accent: "Miền Bắc",
    use_case: "storytelling",
    description: "Miền Bắc · Nữ · Kể chuyện dịu dàng",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_north_thien_minh",
    name: "Thầy Thiện Minh",
    provider: "local",
    region: "north",
    region_label: "Miền Bắc",
    model_version: DEFAULT_LOCAL_TTS_MODEL_VERSION,
    category: "local_neural",
    gender: "male",
    accent: "Miền Bắc",
    use_case: "storytelling",
    description: "Miền Bắc · Nam · Kể chuyện truyền cảm",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_central_ngoc_tran",
    name: "Cô Ngọc Trân",
    provider: "local",
    region: "central",
    region_label: "Miền Trung",
    model_version: DEFAULT_LOCAL_TTS_MODEL_VERSION,
    category: "local_neural",
    gender: "female",
    accent: "Miền Trung",
    use_case: "reading_coach",
    description: "Miền Trung · Nữ · Tự nhiên, dịu dàng",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_central_quang_son",
    name: "Thầy Quang Sơn",
    provider: "local",
    region: "central",
    region_label: "Miền Trung",
    model_version: DEFAULT_LOCAL_TTS_MODEL_VERSION,
    category: "local_neural",
    gender: "male",
    accent: "Miền Trung",
    use_case: "reading_coach",
    description: "Miền Trung · Nam · Tự nhiên, rõ chữ",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_south_thuc_doan",
    name: "Cô Thục Đoan",
    provider: "local",
    region: "south",
    region_label: "Miền Nam",
    model_version: DEFAULT_LOCAL_TTS_MODEL_VERSION,
    category: "local_neural",
    gender: "female",
    accent: "Miền Nam",
    use_case: "storytelling",
    description: "Miền Nam · Nữ · Kể chuyện ấm áp",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_south_my_duyen",
    name: "Cô Mỹ Duyên",
    provider: "local",
    region: "south",
    region_label: "Miền Nam",
    model_version: DEFAULT_LOCAL_TTS_MODEL_VERSION,
    category: "local_neural",
    gender: "female",
    accent: "Miền Nam",
    use_case: "storytelling",
    description: "Miền Nam · Nữ · Đọc truyện thiếu nhi",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "local_south_thai_son",
    name: "Thầy Thái Sơn",
    provider: "local",
    region: "south",
    region_label: "Miền Nam",
    model_version: DEFAULT_LOCAL_TTS_MODEL_VERSION,
    category: "local_neural",
    gender: "male",
    accent: "Miền Nam",
    use_case: "storytelling",
    description: "Miền Nam · Nam · Kể chuyện rõ ràng",
    preview_url: null,
    is_default: false,
  },
];

export function getDefaultVoiceIdForRegionAndGender(
  region: VoiceRegion,
  gender: VoiceGender,
): string {
  return (
    REGION_GENDER_DEFAULT_VOICE_ID[region]?.[gender] ??
    (gender === "male" ? "local_north_thien_minh" : DEFAULT_LOCAL_VOICE_ID)
  );
}

export const getDefaultLocalVoiceIdForRegionAndGender =
  getDefaultVoiceIdForRegionAndGender;

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
  readonly voiceSwitched?: boolean;
}

/**
 * Returns true for client-only synthetic voice lock IDs (`practice_*`, `game_*`)
 * that coordinate in-page UI/audit state without a server reading session lock.
 */
export function isSyntheticClientVoiceSessionId(
  sessionId: string | null | undefined,
): boolean {
  const cleaned = (sessionId ?? "").trim();
  return Boolean(cleaned) && /^(?:practice_|game_)/i.test(cleaned);
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
  providerMode: "local_only",
  allowGoogleSttFallback: false,
  allowGoogleTtsFallback: false,
  modelVersion: DEFAULT_LOCAL_TTS_MODEL_VERSION,
};

type Listener = () => void;
const policyListeners = new Set<Listener>();
const lockListeners = new Set<Listener>();
const voiceCacheInvalidators = new Set<Listener>();
const voiceSwitchedSessions = new Set<string>();
let cachedPolicy: VoicePolicyPreferences | null = null;
let policyStorageSyncInstalled = false;
let activeSessionId: string | null = null;
const previousSessionIds: string[] = [];
const memoryLocks = new Map<string, SessionVoiceLock>();
const utteranceAudits = new Map<string, SessionUtteranceAuditEntry[]>();

function pushPreviousSessionId(prevId: string | null, nextId: string): void {
  if (!prevId || prevId === nextId) return;
  if (!memoryLocks.has(prevId)) return;
  const existingIdx = previousSessionIds.indexOf(prevId);
  if (existingIdx >= 0) {
    previousSessionIds.splice(existingIdx, 1);
  }
  previousSessionIds.push(prevId);
  if (previousSessionIds.length > 16) {
    previousSessionIds.shift();
  }
}

function removeFromPreviousSessionIds(sessionId: string): void {
  for (let i = previousSessionIds.length - 1; i >= 0; i -= 1) {
    if (previousSessionIds[i] === sessionId) {
      previousSessionIds.splice(i, 1);
    }
  }
}

export function registerVoiceCacheInvalidator(fn: Listener): () => void {
  voiceCacheInvalidators.add(fn);
  return () => {
    voiceCacheInvalidators.delete(fn);
  };
}

function invalidateRegisteredVoiceCaches(): void {
  voiceCacheInvalidators.forEach((fn) => {
    try {
      fn();
    } catch {
      // Isolate invalidator errors
    }
  });
}

function ensurePolicyStorageSync(): void {
  if (policyStorageSyncInstalled || typeof window === "undefined") return;
  policyStorageSyncInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== POLICY_STORAGE_KEY) return;
    cachedPolicy = event.newValue
      ? (() => {
          try {
            return sanitizePolicy(JSON.parse(event.newValue));
          } catch {
            return DEFAULT_POLICY;
          }
        })()
      : DEFAULT_POLICY;
    invalidateRegisteredVoiceCaches();
    notifyPolicyListeners();
  });
}

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
    rec.providerMode === "local_with_google_fallback"
      ? "local_with_google_fallback"
      : "local_only";
  const allowGoogleSttFallback =
    providerMode === "local_only" ? false : Boolean(rec.allowGoogleSttFallback);
  const allowGoogleTtsFallback =
    providerMode === "local_only" ? false : Boolean(rec.allowGoogleTtsFallback);
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

function notifyPolicyListeners(): void {
  policyListeners.forEach((fn) => fn());
}

function notifyLockListeners(): void {
  lockListeners.forEach((fn) => fn());
}

export function getDefaultVoicePolicyPreferences(): VoicePolicyPreferences {
  return DEFAULT_POLICY;
}

export function getVoicePolicyPreferences(): VoicePolicyPreferences {
  if (typeof window === "undefined") return DEFAULT_POLICY;
  ensurePolicyStorageSync();
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
  const current = getVoicePolicyPreferences();
  const next = sanitizePolicy({ ...current, ...update });
  const changed =
    current.region !== next.region ||
    current.providerMode !== next.providerMode ||
    current.allowGoogleSttFallback !== next.allowGoogleSttFallback ||
    current.allowGoogleTtsFallback !== next.allowGoogleTtsFallback ||
    current.modelVersion !== next.modelVersion;
  cachedPolicy = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // In-memory state still applies for this page view.
    }
  }
  if (changed) {
    notifyPolicyListeners();
  }
  return next;
}

export function subscribeVoicePolicy(listener: Listener): () => void {
  policyListeners.add(listener);
  return () => {
    policyListeners.delete(listener);
  };
}

export function subscribeVoiceLock(listener: Listener): () => void {
  lockListeners.add(listener);
  return () => {
    lockListeners.delete(listener);
  };
}

export function subscribeVoicePolicyPreferences(
  listener: Listener,
): () => void {
  policyListeners.add(listener);
  return () => {
    policyListeners.delete(listener);
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
  const lockedAt =
    typeof rec.lockedAt === "string" && rec.lockedAt
      ? rec.lockedAt
      : new Date().toISOString();
  const gender: VoiceGender =
    rec.gender === "male" || rec.gender === "female"
      ? rec.gender
      : resolveVoiceGender(rec.voiceId);

  return {
    sessionId: rec.sessionId.trim(),
    provider,
    voiceId: rec.voiceId,
    gender,
    region,
    modelVersion,
    speed,
    lockedAt,
    ...(rec.voiceSwitched === true ? { voiceSwitched: true } : {}),
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
      if (parsed.voiceSwitched) {
        voiceSwitchedSessions.add(parsed.sessionId);
      }
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
  const speechPrefs = getSpeechPreferences();
  const speechMeta = getSpeechPreferencesMeta();
  const policyPrefs = getVoicePolicyPreferences();
  const existingLockedAtMs = existing ? Date.parse(existing.lockedAt) : 0;
  const expectedGlobalVoiceId =
    speechPrefs.voiceId && !isLegacyExternalVoiceId(speechPrefs.voiceId)
      ? speechPrefs.voiceId
      : getDefaultVoiceIdForRegionAndGender(
          policyPrefs.region,
          speechMeta.gender,
        );
  const hasNewerGlobalPreference =
    Boolean(existing) &&
    speechMeta.globalSelectionUpdatedAt > 0 &&
    Number.isFinite(existingLockedAtMs) &&
    speechMeta.globalSelectionUpdatedAt > existingLockedAtMs &&
    (expectedGlobalVoiceId !== existing!.voiceId ||
      clampSpeed(speechPrefs.speed) !== clampSpeed(existing!.speed) ||
      speechMeta.gender !==
        (existing!.gender ?? resolveVoiceGender(existing!.voiceId)));

  if (
    existing &&
    !overrides?.forceUpdate &&
    !hasNewerGlobalPreference &&
    !isLegacyExternalVoiceId(existing.voiceId)
  ) {
    const changedActive = activeSessionId !== cleanSessionId;
    if (changedActive) {
      pushPreviousSessionId(activeSessionId, cleanSessionId);
      removeFromPreviousSessionIds(cleanSessionId);
    }
    activeSessionId = cleanSessionId;
    if (changedActive) {
      notifyLockListeners();
    }
    return existing;
  }

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
      : getDefaultVoiceIdForRegionAndGender(region, speechMeta.gender);

  // Enforce provider policy: never lock a Google voice when Google TTS is disabled,
  // while preserving the saved gender (male/female) and region!
  if (
    inferProviderFromVoiceId(resolvedVoiceId) === "google" &&
    (policyPrefs.providerMode !== "local_with_google_fallback" ||
      !policyPrefs.allowGoogleTtsFallback)
  ) {
    resolvedVoiceId = getDefaultVoiceIdForRegionAndGender(
      region,
      resolveVoiceGender(resolvedVoiceId, speechMeta.gender),
    );
  }

  const provider = inferProviderFromVoiceId(resolvedVoiceId);
  const modelVersion = inferModelVersionForVoiceId(
    resolvedVoiceId,
    overrides?.modelVersion ?? policyPrefs.modelVersion,
  );
  const speed = clampSpeed(overrides?.speed ?? speechPrefs.speed);

  const didSwitchVoice = Boolean(
    !isSyntheticClientVoiceSessionId(cleanSessionId) &&
    (voiceSwitchedSessions.has(cleanSessionId) ||
      (existing &&
        ((overrides?.forceUpdate && existing.voiceId !== resolvedVoiceId) ||
          hasNewerGlobalPreference ||
          existing.voiceSwitched === true))),
  );

  const lock: SessionVoiceLock = {
    sessionId: cleanSessionId,
    provider,
    voiceId: resolvedVoiceId,
    gender: resolveVoiceGender(resolvedVoiceId),
    region: inferRegionFromVoiceId(resolvedVoiceId, region),
    modelVersion,
    speed,
    lockedAt: new Date().toISOString(),
    ...(didSwitchVoice ? { voiceSwitched: true } : {}),
  };

  memoryLocks.set(cleanSessionId, lock);
  if (activeSessionId !== cleanSessionId) {
    pushPreviousSessionId(activeSessionId, cleanSessionId);
    removeFromPreviousSessionIds(cleanSessionId);
  }
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
  if (didSwitchVoice) {
    voiceSwitchedSessions.add(cleanSessionId);
  }
  notifyLockListeners();
  return lock;
}

export function setActiveVoiceSession(sessionId: string | null): void {
  const nextId = sessionId ? sessionId.trim() || null : null;
  if (nextId && activeSessionId && activeSessionId !== nextId) {
    pushPreviousSessionId(activeSessionId, nextId);
    removeFromPreviousSessionIds(nextId);
  }
  activeSessionId = nextId;
  notifyLockListeners();
}

export function getActiveSessionVoiceLock(): SessionVoiceLock | null {
  if (!activeSessionId) return null;
  return getSessionVoiceLock(activeSessionId);
}

export function releaseSessionVoiceLock(sessionId: string): void {
  const clean = sessionId.trim();
  memoryLocks.delete(clean);
  voiceSwitchedSessions.delete(clean);
  removeFromPreviousSessionIds(clean);
  if (activeSessionId === clean) {
    let restored: string | null = null;
    while (previousSessionIds.length > 0) {
      const candidate = previousSessionIds.pop()!;
      if (candidate !== clean && getSessionVoiceLock(candidate) !== null) {
        restored = candidate;
        break;
      }
    }
    activeSessionId = restored;
  }
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(`${LOCK_STORAGE_PREFIX}${clean}`);
    } catch {
      // Ignore
    }
  }
  notifyLockListeners();
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
  const prefs = getSpeechPreferences();
  const meta = getSpeechPreferencesMeta();
  const activeLockedAtMs = active ? Date.parse(active.lockedAt) : 0;
  const prefsNewerThanLock =
    Boolean(active) &&
    meta.globalSelectionUpdatedAt > 0 &&
    Number.isFinite(activeLockedAtMs) &&
    meta.globalSelectionUpdatedAt > activeLockedAtMs;

  if (
    active?.voiceId &&
    !prefsNewerThanLock &&
    !isLegacyExternalVoiceId(active.voiceId)
  ) {
    return active.voiceId;
  }
  if (prefs.voiceId && !isLegacyExternalVoiceId(prefs.voiceId)) {
    return prefs.voiceId;
  }
  const policy = getVoicePolicyPreferences();
  return getDefaultVoiceIdForRegionAndGender(policy.region, meta.gender);
}

/** Resolve the consistent Teacher Persona ("Cô giáo AI" vs "Thầy giáo AI") across ALL screens. */
export function getEffectiveTeacherPersona(): TeacherPersona {
  const active = getActiveSessionVoiceLock();
  const meta = getSpeechPreferencesMeta();
  const voiceId = getEffectiveVoiceId();
  const activeLockedAtMs = active ? Date.parse(active.lockedAt) : 0;
  const prefsNewerThanLock =
    Boolean(active) &&
    meta.globalSelectionUpdatedAt > 0 &&
    Number.isFinite(activeLockedAtMs) &&
    meta.globalSelectionUpdatedAt > activeLockedAtMs;
  const explicitGender =
    active && !prefsNewerThanLock ? (active.gender ?? null) : meta.gender;
  return getTeacherPersonaForVoice(voiceId, explicitGender);
}

export interface GlobalTeacherVoiceSelectionInput {
  readonly voiceId?: string | null;
  /** Optional explicit override stored in `SpeechPreferences.voiceId` (e.g. `null` when choosing server default). */
  readonly storedVoiceId?: string | null;
  readonly gender?: VoiceGender;
  readonly region?: VoiceRegion;
  readonly speed?: number;
  readonly modelVersion?: string;
  readonly updatedAt?: number;
  readonly childId?: string | null;
  readonly persistToBackend?: (
    childId: string,
    payload: {
      readonly voice_id: string;
      readonly gender: VoiceGender;
      readonly region: VoiceRegion;
      readonly speed: number;
      readonly updated_at: number;
    },
  ) => Promise<unknown>;
  readonly syncActiveServerSessionLock?: (input: {
    readonly sessionId: string;
    readonly voiceId: string;
  }) => Promise<unknown>;
}

export interface GlobalTeacherVoiceSelectionResult {
  readonly voiceId: string;
  readonly gender: VoiceGender;
  readonly region: VoiceRegion;
  readonly speed: number;
  readonly modelVersion: string;
  readonly updatedAt: number;
}

/**
 * Synchronizes EVERY cached & persisted SessionVoiceLock (both active in-memory
 * locks and any stored `viread.session-voice-lock.v1.*` entries in sessionStorage)
 * so resuming an older reading session never reverts to an outdated voice/gender.
 */
export function syncAllSessionVoiceLocks(input: {
  readonly voiceId: string;
  readonly gender: VoiceGender;
  readonly region: VoiceRegion;
  readonly speed: number;
  readonly modelVersion: string;
  readonly updatedAt?: number;
}): void {
  const sessionIds = new Set<string>(memoryLocks.keys());
  if (activeSessionId) {
    sessionIds.add(activeSessionId);
  }
  if (typeof window !== "undefined") {
    try {
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const key = window.sessionStorage.key(i);
        if (key && key.startsWith(LOCK_STORAGE_PREFIX)) {
          const sid = key.slice(LOCK_STORAGE_PREFIX.length).trim();
          if (sid) sessionIds.add(sid);
        }
      }
    } catch {
      // Ignore restricted sessionStorage
    }
  }

  const lockedAt = new Date(input.updatedAt ?? Date.now()).toISOString();
  const provider = inferProviderFromVoiceId(input.voiceId);
  for (const sid of sessionIds) {
    const isRealSession = !isSyntheticClientVoiceSessionId(sid);
    const updatedLock: SessionVoiceLock = {
      sessionId: sid,
      provider,
      voiceId: input.voiceId,
      gender: input.gender,
      region: input.region,
      modelVersion: input.modelVersion,
      speed: input.speed,
      lockedAt,
      ...(isRealSession ? { voiceSwitched: true } : {}),
    };
    memoryLocks.set(sid, updatedLock);
    if (isRealSession) {
      voiceSwitchedSessions.add(sid);
    }
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(
          `${LOCK_STORAGE_PREFIX}${sid}`,
          JSON.stringify(updatedLock),
        );
      } catch {
        // Ignore restricted sessionStorage
      }
    }
  }
  if (sessionIds.size > 0) {
    notifyLockListeners();
  }
}

/**
 * Single atomic entry point for changing the AI teacher voice/gender/region/speed
 * from ANY screen (Dashboard, Reading, Prep, Comprehension, Difficult Words).
 */
export function applyGlobalTeacherVoiceSelection(
  input: GlobalTeacherVoiceSelectionInput,
): GlobalTeacherVoiceSelectionResult {
  const currentPrefs = getSpeechPreferences();
  const currentPolicy = getVoicePolicyPreferences();
  const currentEffectiveVoiceId = getEffectiveVoiceId();

  const targetRegion: VoiceRegion =
    input.region ??
    (input.voiceId
      ? inferRegionFromVoiceId(input.voiceId, currentPolicy.region)
      : inferRegionFromVoiceId(currentEffectiveVoiceId, currentPolicy.region));

  let targetVoiceId: string;
  let targetGender: VoiceGender;

  if (
    typeof input.voiceId === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(input.voiceId)
  ) {
    targetVoiceId = input.voiceId;
    targetGender = resolveVoiceGender(targetVoiceId, input.gender ?? null);
  } else if (input.gender) {
    targetGender = input.gender;
    targetVoiceId = getDefaultVoiceIdForRegionAndGender(
      targetRegion,
      targetGender,
    );
  } else if (input.region) {
    targetGender = resolveVoiceGender(
      currentEffectiveVoiceId,
      getSpeechPreferencesMeta().gender,
    );
    const currentVoiceRegion = inferRegionFromVoiceId(
      currentEffectiveVoiceId,
      currentPolicy.region,
    );
    targetVoiceId =
      currentVoiceRegion === targetRegion
        ? currentEffectiveVoiceId
        : getDefaultVoiceIdForRegionAndGender(targetRegion, targetGender);
  } else {
    targetVoiceId = currentEffectiveVoiceId;
    targetGender = resolveVoiceGender(
      targetVoiceId,
      getSpeechPreferencesMeta().gender,
    );
  }

  // Enforce provider policy: never keep a Google voice if Google TTS fallback is disabled.
  if (
    inferProviderFromVoiceId(targetVoiceId) === "google" &&
    (currentPolicy.providerMode !== "local_with_google_fallback" ||
      !currentPolicy.allowGoogleTtsFallback)
  ) {
    targetVoiceId = getDefaultVoiceIdForRegionAndGender(
      targetRegion,
      targetGender,
    );
  }

  const finalRegion = inferRegionFromVoiceId(targetVoiceId, targetRegion);
  const finalSpeed = clampSpeed(input.speed ?? currentPrefs.speed);
  const finalModelVersion = inferModelVersionForVoiceId(
    targetVoiceId,
    input.modelVersion ?? currentPolicy.modelVersion,
  );
  const prevActiveLock = getActiveSessionVoiceLock();
  const prevActiveLockedAtMs = prevActiveLock
    ? Date.parse(prevActiveLock.lockedAt)
    : 0;
  const minMonotonicStamp = Math.max(
    getSpeechPreferencesMeta().globalSelectionUpdatedAt,
    Number.isFinite(prevActiveLockedAtMs) ? prevActiveLockedAtMs : 0,
  );
  const finalUpdatedAt =
    input.updatedAt ??
    Math.max(Date.now(), minMonotonicStamp > 0 ? minMonotonicStamp + 1 : 0);

  // 1. Update local preferences (notifies useSpeechPreferences, useTeacherPersona, TtsPlayback)
  const storedVoiceId =
    input.storedVoiceId !== undefined ? input.storedVoiceId : targetVoiceId;
  const resolvedChildId =
    input.childId !== undefined
      ? input.childId
      : (getSpeechPreferencesMeta().childId ?? null);
  setSpeechPreferences({
    voiceId: storedVoiceId,
    gender: targetGender,
    speed: finalSpeed,
    updatedAt: finalUpdatedAt,
    globalSelectionUpdatedAt: finalUpdatedAt,
    childId: resolvedChildId,
  });
  // Keep child hydration cache consistent so switching Child A -> Child B (change voice) -> Child A
  // always restores Child A's persisted voice instead of skipping due to a stale cache key.
  lastHydratedChildVoiceKey = resolvedChildId
    ? `${resolvedChildId}:${targetVoiceId}:${targetGender}:${finalRegion}:${finalSpeed}:${finalUpdatedAt}`
    : null;

  // 2. Update voice policy region & model version
  setVoicePolicyPreferences({
    region: finalRegion,
    modelVersion: finalModelVersion,
  });

  // 3. Synchronize ALL active & stored SessionVoiceLocks
  syncAllSessionVoiceLocks({
    voiceId: targetVoiceId,
    gender: targetGender,
    region: finalRegion,
    speed: finalSpeed,
    modelVersion: finalModelVersion,
    updatedAt: finalUpdatedAt,
  });

  // 4. Clear pinned browser voices & client TTS caches
  invalidateRegisteredVoiceCaches();

  // 5. Resync server-side SessionVoiceLock if an active reading session is locked
  if (
    prevActiveLock &&
    !isSyntheticClientVoiceSessionId(prevActiveLock.sessionId) &&
    prevActiveLock.voiceId !== targetVoiceId &&
    typeof input.syncActiveServerSessionLock === "function"
  ) {
    void Promise.resolve(
      input.syncActiveServerSessionLock({
        sessionId: prevActiveLock.sessionId,
        voiceId: targetVoiceId,
      }),
    )
      .then(() => {
        clearPendingSessionVoiceSwitch(prevActiveLock.sessionId);
      })
      .catch(() => undefined);
  }

  // 6. Persist to backend child profile settings (fire-and-forget safe)
  if (input.childId && typeof input.persistToBackend === "function") {
    void Promise.resolve(
      input.persistToBackend(input.childId, {
        voice_id: targetVoiceId,
        gender: targetGender,
        region: finalRegion,
        speed: finalSpeed,
        updated_at: finalUpdatedAt,
      }),
    ).catch(() => undefined);
  }

  return {
    voiceId: targetVoiceId,
    gender: targetGender,
    region: finalRegion,
    speed: finalSpeed,
    modelVersion: finalModelVersion,
    updatedAt: finalUpdatedAt,
  };
}

let lastHydratedChildVoiceKey: string | null = null;

/**
 * Hydrates the global AI teacher voice selection from a child's persisted
 * `settings.voice_preferences` (e.g., when switching child profiles or signing in
 * on another device). Does not trigger a redundant backend PATCH.
 */
export function hydrateTeacherVoiceFromChildProfile(
  child:
    | {
        readonly id: string;
        readonly settings?: Record<string, unknown> | null;
      }
    | null
    | undefined,
  options?: {
    readonly force?: boolean;
    readonly syncActiveServerSessionLock?: (input: {
      readonly sessionId: string;
      readonly voiceId: string;
    }) => Promise<unknown>;
  },
): GlobalTeacherVoiceSelectionResult | null {
  if (!child?.id) {
    lastHydratedChildVoiceKey = null;
    return null;
  }
  const raw =
    child.settings && typeof child.settings === "object"
      ? (child.settings as Record<string, unknown>).voice_preferences
      : undefined;
  const rec =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : undefined;
  const rawVoiceId =
    rec &&
    typeof rec.voice_id === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(rec.voice_id)
      ? rec.voice_id
      : null;

  const currentMeta = getSpeechPreferencesMeta();
  const isSiblingSwitch = Boolean(
    currentMeta.childId && currentMeta.childId !== child.id,
  );
  if (!rawVoiceId) {
    lastHydratedChildVoiceKey = null;
    // Prevent sibling voice leak: if the currently active voice explicitly belonged to
    // ANOTHER child profile, reset cleanly to the default female northern voice for this child.
    if (isSiblingSwitch) {
      const activeLock = getActiveSessionVoiceLock();
      const alreadyDefault =
        getEffectiveVoiceId() === DEFAULT_LOCAL_VOICE_ID &&
        getEffectiveTeacherPersona().gender === "female" &&
        getVoicePolicyPreferences().region === "north" &&
        getSpeechPreferences().speed === DEFAULT_SPEED &&
        (!activeLock ||
          (activeLock.voiceId === DEFAULT_LOCAL_VOICE_ID &&
            activeLock.gender === "female" &&
            activeLock.speed === DEFAULT_SPEED));
      if (alreadyDefault) {
        setSpeechPreferencesMeta({
          gender: "female",
          updatedAt: 0,
          globalSelectionUpdatedAt: 0,
          childId: child.id,
        });
        return {
          voiceId: DEFAULT_LOCAL_VOICE_ID,
          gender: "female",
          region: "north",
          speed: DEFAULT_SPEED,
          modelVersion: getVoicePolicyPreferences().modelVersion,
          updatedAt: 0,
        };
      }
      return applyGlobalTeacherVoiceSelection({
        voiceId: DEFAULT_LOCAL_VOICE_ID,
        storedVoiceId: null,
        gender: "female",
        region: "north",
        speed: DEFAULT_SPEED,
        childId: child.id,
        syncActiveServerSessionLock: options?.syncActiveServerSessionLock,
      });
    }
    return null;
  }

  const rawGender: VoiceGender =
    rec?.gender === "male" || rec?.gender === "female"
      ? rec.gender
      : resolveVoiceGender(rawVoiceId);
  const rawRegion: VoiceRegion =
    rec?.region === "north" ||
    rec?.region === "central" ||
    rec?.region === "south"
      ? rec.region
      : inferRegionFromVoiceId(rawVoiceId, "north");
  const rawSpeed =
    typeof rec?.speed === "number"
      ? clampSpeed(rec.speed)
      : isSiblingSwitch
        ? DEFAULT_SPEED
        : getSpeechPreferences().speed;
  const rawUpdatedAt =
    typeof rec?.updated_at === "number" &&
    Number.isFinite(rec.updated_at) &&
    rec.updated_at > 0
      ? Math.floor(rec.updated_at)
      : 0;

  const key = `${child.id}:${rawVoiceId}:${rawGender}:${rawRegion}:${rawSpeed}:${rawUpdatedAt}`;
  if (!options?.force && lastHydratedChildVoiceKey === key) {
    return null;
  }

  // Never overwrite a newer local selection for the SAME child (even when force=true on child card re-click).
  const sameChildPrefix = `${child.id}:`;
  const isSameChild =
    lastHydratedChildVoiceKey?.startsWith(sameChildPrefix) ||
    currentMeta.childId === child.id;
  if (
    isSameChild &&
    currentMeta.updatedAt > 0 &&
    (rawUpdatedAt === 0 || currentMeta.updatedAt > rawUpdatedAt)
  ) {
    return null;
  }

  const currentPolicy = getVoicePolicyPreferences();
  const effectiveTargetVoiceId =
    inferProviderFromVoiceId(rawVoiceId) === "google" &&
    (currentPolicy.providerMode !== "local_with_google_fallback" ||
      !currentPolicy.allowGoogleTtsFallback)
      ? getDefaultVoiceIdForRegionAndGender(rawRegion, rawGender)
      : rawVoiceId;
  const finalRegion = inferRegionFromVoiceId(effectiveTargetVoiceId, rawRegion);
  const finalModelVersion = inferModelVersionForVoiceId(
    effectiveTargetVoiceId,
    currentPolicy.modelVersion,
  );
  const effectiveUpdatedAt = rawUpdatedAt > 0 ? rawUpdatedAt : Date.now();
  const activeLock = getActiveSessionVoiceLock();
  const lockMatches =
    !activeLock ||
    (activeLock.voiceId === effectiveTargetVoiceId &&
      activeLock.gender === rawGender &&
      activeLock.region === finalRegion &&
      activeLock.speed === rawSpeed);
  const activeVoiceMatches =
    lockMatches &&
    getEffectiveVoiceId() === effectiveTargetVoiceId &&
    getEffectiveTeacherPersona().gender === rawGender &&
    currentPolicy.region === finalRegion &&
    getSpeechPreferences().speed === rawSpeed;

  // Avoid firing preference/policy change listeners (which call `TtsPlayback.stop()`)
  // when background hydration resolves for the exact voice/gender/region/speed already playing.
  if (activeVoiceMatches) {
    const nextStamp = Math.max(currentMeta.updatedAt, effectiveUpdatedAt);
    setSpeechPreferencesMeta({
      gender: rawGender,
      updatedAt: nextStamp,
      globalSelectionUpdatedAt: Math.max(
        currentMeta.globalSelectionUpdatedAt,
        nextStamp,
      ),
      childId: child.id,
    });
    lastHydratedChildVoiceKey = key;
    return {
      voiceId: effectiveTargetVoiceId,
      gender: rawGender,
      region: finalRegion,
      speed: rawSpeed,
      modelVersion: finalModelVersion,
      updatedAt: nextStamp,
    };
  }

  const applied = applyGlobalTeacherVoiceSelection({
    voiceId: rawVoiceId,
    gender: rawGender,
    region: rawRegion,
    speed: rawSpeed,
    updatedAt: effectiveUpdatedAt,
    childId: child.id,
    syncActiveServerSessionLock: options?.syncActiveServerSessionLock,
  });
  lastHydratedChildVoiceKey = key;
  return applied;
}

/**
 * Clears persisted teacher voice preferences and session voice locks on sign-out
 * or parent account switch so one family's voice selection never leaks to another account.
 */
export function resetTeacherVoiceForActorSwitch(): void {
  lastHydratedChildVoiceKey = null;
  activeSessionId = null;
  memoryLocks.clear();
  voiceSwitchedSessions.clear();
  utteranceAudits.clear();
  if (typeof window !== "undefined") {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const k = window.sessionStorage.key(i);
        if (k && k.startsWith(LOCK_STORAGE_PREFIX)) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        window.sessionStorage.removeItem(k);
      }
    } catch {
      // Ignore restricted sessionStorage
    }
  }
  resetSpeechPreferencesForActorSwitch();
  setVoicePolicyPreferences({
    region: DEFAULT_POLICY.region,
    modelVersion: DEFAULT_POLICY.modelVersion,
  });
  invalidateRegisteredVoiceCaches();
}

export function approveSessionVoiceSwitch(
  sessionId: string | null | undefined,
): void {
  const clean = (sessionId ?? "").trim();
  if (!clean || isSyntheticClientVoiceSessionId(clean)) return;
  voiceSwitchedSessions.add(clean);
  const existing = getSessionVoiceLock(clean);
  if (existing && !existing.voiceSwitched) {
    const next: SessionVoiceLock = { ...existing, voiceSwitched: true };
    memoryLocks.set(clean, next);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(
          `${LOCK_STORAGE_PREFIX}${clean}`,
          JSON.stringify(next),
        );
      } catch {
        // Ignore restricted sessionStorage
      }
    }
  }
}

export function clearPendingSessionVoiceSwitch(
  sessionId: string | null | undefined,
): void {
  const clean = (sessionId ?? "").trim();
  if (!clean) return;
  voiceSwitchedSessions.delete(clean);
  const existing = memoryLocks.get(clean);
  if (existing?.voiceSwitched) {
    const next: SessionVoiceLock = {
      sessionId: existing.sessionId,
      provider: existing.provider,
      voiceId: existing.voiceId,
      gender: existing.gender,
      region: existing.region,
      modelVersion: existing.modelVersion,
      speed: existing.speed,
      lockedAt: existing.lockedAt,
    };
    memoryLocks.set(clean, next);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(
          `${LOCK_STORAGE_PREFIX}${clean}`,
          JSON.stringify(next),
        );
      } catch {
        // Ignore restricted sessionStorage
      }
    }
  }
}

export function hasPendingSessionVoiceSwitch(
  sessionId: string | null | undefined,
): boolean {
  const clean = (sessionId ?? "").trim();
  if (!clean || isSyntheticClientVoiceSessionId(clean)) return false;
  if (voiceSwitchedSessions.has(clean)) return true;
  return Boolean(getSessionVoiceLock(clean)?.voiceSwitched);
}

export function resetVoiceLockAndPolicyForTests(): void {
  cachedPolicy = null;
  activeSessionId = null;
  previousSessionIds.length = 0;
  lastHydratedChildVoiceKey = null;
  memoryLocks.clear();
  voiceSwitchedSessions.clear();
  utteranceAudits.clear();
}
