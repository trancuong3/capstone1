/**
 * Eager STT + TTS Preloader for ViRead (Web, Mobile Web, and Android WebView APK).
 *
 * Starts warming voice engines the moment the user taps "Chuẩn bị đọc" / enters
 * Reading Preparation, Reading Screen, or Difficult Words Practice — so STT
 * (especially 33.92 MB Browser WASM Sherpa-ONNX) and TTS (Backend / Android Native /
 * Browser SpeechSynthesis voices) are ALREADY initialized before the child speaks
 * the first word!
 */

import { getBrowserAccessToken } from "@/lib/api/browser-auth";
import { createSpeechService } from "@/lib/api/speech-service";
import * as androidAudioUnlock from "@/lib/reading/android-audio-unlock";
import {
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
  getWasmModelCacheStatus,
  type WasmSttProgressEvent,
} from "@/lib/reading/browser-wasm-stt";
import {
  detectBrowserWasmTtsSupport,
  getBrowserWasmTtsClient,
  type WasmTtsProgressEvent,
} from "@/lib/reading/browser-wasm-tts";
import { isInjectedTestSpeechRecognition } from "@/lib/reading/local-segment-speech-recognition";
import {
  getAndroidSpeechCapabilities,
  isAndroidNativeSpeechAvailable,
} from "@/lib/reading/native-speech-bridge";
import {
  getActiveSessionVoiceLock,
  getEffectiveVoiceId,
  getVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import { getSpeechPreferences } from "@/lib/reading/speech-preferences";
import { normalizeVietnameseWord } from "@/lib/reading/vietnamese-text";
import {
  fetchVoiceEngineHealth,
  getFreshVoiceEngineHealth,
  getVoiceEngineHealthForRouting,
  isPermanentlyHostedLocalUnconfigured,
  mapLocalVoiceToGoogleBackup,
  recordSttEngineUsage,
  recordTtsEngineUsage,
  type VoiceEngineHealthSnapshot,
} from "@/lib/reading/voice-engine-status";
import {
  resolveVoiceGender,
  type VoiceGender,
} from "@/lib/reading/voice-persona";

export type VoiceEnginePreloadStatus =
  "idle" | "loading" | "ready" | "degraded";

export interface VoicePreloadState {
  readonly sttStatus: VoiceEnginePreloadStatus;
  readonly ttsStatus: VoiceEnginePreloadStatus;
  readonly sttEngineLabel: string | null;
  readonly sttProgressStage: string | null;
  readonly ttsProgressStage: string | null;
  readonly wasmDownloadActive: boolean;
  readonly wasmDownloadPercent: number | null;
  readonly wasmDownloadFile: string | null;
  readonly startedAt: number | null;
  readonly readyAt: number | null;
}

export interface PreloadReadingVoiceOptions {
  readonly bookId?: string | null;
  readonly pageId?: string | null;
  readonly pageRevisionId?: string | null;
  readonly isPrivateBook?: boolean;
  readonly previewWords?: readonly string[];
  readonly warmWasmStt?: boolean;
  readonly warmTts?: boolean;
}

const INITIAL_STATE: VoicePreloadState = {
  sttStatus: "idle",
  ttsStatus: "idle",
  sttEngineLabel: null,
  sttProgressStage: null,
  ttsProgressStage: null,
  wasmDownloadActive: false,
  wasmDownloadPercent: null,
  wasmDownloadFile: null,
  startedAt: null,
  readyAt: null,
};

const listeners = new Set<() => void>();
let state: VoicePreloadState = INITIAL_STATE;
let activePreloadPromise: Promise<void> | null = null;
let wasmInitPromise: Promise<boolean> | null = null;
let wasmTtsInitPromise: Promise<boolean> | null = null;
let wasmTtsWarmGender: VoiceGender | null = null;
let wasmProgressUnsub: (() => void) | null = null;
let wasmTtsProgressUnsub: (() => void) | null = null;
let sttProgressFraction: number | null = null;
let ttsProgressFraction: number | null = null;
let pendingTtsWarmOptions: PreloadReadingVoiceOptions | null = null;
let warmTtsAbortController: AbortController | null = null;
const prefetchedTtsKeys = new Set<string>();

function warmAudioUnlockSafely(): void {
  if (typeof window === "undefined") return;
  try {
    androidAudioUnlock.installAndroidAudioUnlock();
    const maybeGetWarmCtx = (
      androidAudioUnlock as { getWarmAudioContext?: () => AudioContext | null }
    ).getWarmAudioContext;
    const warmCtx =
      typeof maybeGetWarmCtx === "function" ? maybeGetWarmCtx() : null;
    if (warmCtx && warmCtx.state === "suspended") {
      void warmCtx.resume().catch(() => undefined);
    }
  } catch {
    // Best-effort audio unlock warmup only; never fail preload.
  }
}

function computeAggregateWasmProgress(): {
  readonly active: boolean;
  readonly percent: number | null;
} {
  const parts: number[] = [];
  if (sttProgressFraction !== null) parts.push(sttProgressFraction);
  if (ttsProgressFraction !== null) parts.push(ttsProgressFraction);
  if (parts.length === 0) {
    return { active: false, percent: null };
  }
  const active = parts.some((p) => p < 1);
  if (!active) {
    return { active: false, percent: 100 };
  }
  const avg = parts.reduce((sum, p) => sum + p, 0) / parts.length;
  return {
    active: true,
    percent: Math.min(99, Math.max(1, Math.round(avg * 100))),
  };
}

function updateState(patch: Partial<VoicePreloadState>): void {
  const next: VoicePreloadState = { ...state, ...patch };
  if (
    next.sttStatus === state.sttStatus &&
    next.ttsStatus === state.ttsStatus &&
    next.sttEngineLabel === state.sttEngineLabel &&
    next.sttProgressStage === state.sttProgressStage &&
    next.ttsProgressStage === state.ttsProgressStage &&
    next.wasmDownloadActive === state.wasmDownloadActive &&
    next.wasmDownloadPercent === state.wasmDownloadPercent &&
    next.wasmDownloadFile === state.wasmDownloadFile &&
    next.startedAt === state.startedAt &&
    next.readyAt === state.readyAt
  ) {
    return;
  }
  state = next;
  listeners.forEach((fn) => fn());
}

function recordWasmSttBadgeIfOffline(): void {
  if (isAndroidNativeSpeechAvailable()) return;
  const health = getFreshVoiceEngineHealth();
  if (health?.local.available && health.local.stt_ready) return;
  const unconfigured = isPermanentlyHostedLocalUnconfigured(health);
  recordSttEngineUsage({
    provider: "wasm",
    fallbackUsed: !unconfigured && health?.local.configured !== false,
    fallbackReason:
      unconfigured || health?.local.configured === false
        ? null
        : "LOCAL_STT_UNAVAILABLE",
  });
}

function recordWasmTtsBadgeIfOffline(gender: VoiceGender): void {
  if (isAndroidNativeSpeechAvailable()) return;
  const health = getFreshVoiceEngineHealth();
  if (hasLiveServerTts(health)) return;
  const unconfigured = isPermanentlyHostedLocalUnconfigured(health);
  recordTtsEngineUsage({
    provider: "wasm_tts",
    fallbackUsed: !unconfigured && health?.local.configured !== false,
    fallbackReason:
      unconfigured || health?.local.configured === false
        ? null
        : "LOCAL_TTS_UNAVAILABLE",
    voiceId: getEffectiveVoiceId(),
    voiceGender: gender,
  });
}

export function getVoicePreloadState(): VoicePreloadState {
  return state;
}

export function subscribeVoicePreloadState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function warmBrowserSpeechVoices(): Promise<boolean> {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    typeof window.speechSynthesis?.getVoices !== "function"
  ) {
    return Promise.resolve(false);
  }
  try {
    const existing = window.speechSynthesis.getVoices() ?? [];
    if (existing.length > 0) {
      return Promise.resolve(true);
    }
    if (typeof window.speechSynthesis.addEventListener !== "function") {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try {
          window.speechSynthesis.removeEventListener?.(
            "voiceschanged",
            onVoicesChanged,
          );
        } catch {
          // Ignore cleanup errors
        }
        try {
          resolve((window.speechSynthesis.getVoices?.() ?? []).length > 0);
        } catch {
          resolve(false);
        }
      };
      const onVoicesChanged = () => done();
      try {
        window.speechSynthesis.addEventListener(
          "voiceschanged",
          onVoicesChanged,
        );
      } catch {
        done();
        return;
      }
      const timer = window.setTimeout(done, 800);
    });
  } catch {
    return Promise.resolve(false);
  }
}

function startWasmSttWarmup(): Promise<boolean> {
  const wasmClient = getBrowserWasmSttClient();
  if (wasmClient.isReady()) {
    sttProgressFraction = 1;
    const agg = computeAggregateWasmProgress();
    updateState({
      sttStatus: "ready",
      sttEngineLabel: "Offline (WASM)",
      sttProgressStage: "ready",
      wasmDownloadActive: agg.active,
      wasmDownloadPercent: agg.percent,
      wasmDownloadFile: agg.active ? state.wasmDownloadFile : null,
    });
    recordWasmSttBadgeIfOffline();
    return Promise.resolve(true);
  }
  if (wasmInitPromise) {
    return wasmInitPromise;
  }
  sttProgressFraction = 0.05;
  const initialAgg = computeAggregateWasmProgress();
  updateState({
    sttStatus: "loading",
    sttEngineLabel: "Offline (WASM)",
    sttProgressStage: "loading",
    wasmDownloadActive: initialAgg.active,
    wasmDownloadPercent: initialAgg.percent,
  });
  wasmProgressUnsub?.();
  wasmProgressUnsub = wasmClient.subscribeProgress(
    (evt: WasmSttProgressEvent) => {
      const evRecord = evt as {
        stage: string;
        file?: string;
        index?: number;
        total?: number;
      };
      if (
        typeof evRecord.index === "number" &&
        typeof evRecord.total === "number" &&
        evRecord.total > 0
      ) {
        sttProgressFraction = Math.min(
          0.98,
          Math.max(0.05, (evRecord.index + 0.5) / evRecord.total),
        );
      } else if (evRecord.stage === "ready") {
        sttProgressFraction = 1;
      }
      const agg = computeAggregateWasmProgress();
      updateState({
        sttStatus: evt.stage === "ready" ? "ready" : "loading",
        sttEngineLabel: "Offline (WASM)",
        sttProgressStage: evt.stage,
        wasmDownloadActive: agg.active,
        wasmDownloadPercent: agg.percent,
        wasmDownloadFile: agg.active
          ? (evRecord.file ?? state.wasmDownloadFile)
          : null,
      });
    },
  );
  wasmInitPromise = wasmClient
    .init()
    .then(() => {
      sttProgressFraction = 1;
      const agg = computeAggregateWasmProgress();
      updateState({
        sttStatus: "ready",
        sttEngineLabel: "Offline (WASM)",
        sttProgressStage: "ready",
        wasmDownloadActive: agg.active,
        wasmDownloadPercent: agg.percent,
        wasmDownloadFile: agg.active ? state.wasmDownloadFile : null,
      });
      recordWasmSttBadgeIfOffline();
      return true;
    })
    .catch(() => {
      sttProgressFraction = null;
      const agg = computeAggregateWasmProgress();
      updateState({
        sttStatus: "degraded",
        sttProgressStage: "error",
        wasmDownloadActive: agg.active,
        wasmDownloadPercent: agg.percent,
        wasmDownloadFile: agg.active ? state.wasmDownloadFile : null,
      });
      return false;
    })
    .finally(() => {
      wasmProgressUnsub?.();
      wasmProgressUnsub = null;
      if (!wasmClient.isReady()) {
        wasmInitPromise = null;
      }
    });
  return wasmInitPromise;
}

function startWasmTtsWarmup(gender?: VoiceGender): Promise<boolean> {
  const resolvedGender = gender ?? resolveVoiceGender(getEffectiveVoiceId());
  if (
    isAndroidNativeSpeechAvailable() ||
    !detectBrowserWasmTtsSupport().supported
  ) {
    return Promise.resolve(false);
  }
  const client = getBrowserWasmTtsClient();
  if (client.isReady(resolvedGender)) {
    ttsProgressFraction = 1;
    const agg = computeAggregateWasmProgress();
    updateState({
      ttsStatus: "ready",
      ttsProgressStage: "ready",
      wasmDownloadActive: agg.active,
      wasmDownloadPercent: agg.percent,
      wasmDownloadFile: agg.active ? state.wasmDownloadFile : null,
      readyAt: state.readyAt ?? Date.now(),
    });
    recordWasmTtsBadgeIfOffline(resolvedGender);
    return Promise.resolve(true);
  }
  if (wasmTtsInitPromise && wasmTtsWarmGender === resolvedGender) {
    return wasmTtsInitPromise;
  }
  wasmTtsWarmGender = resolvedGender;
  ttsProgressFraction = 0.05;
  const startAgg = computeAggregateWasmProgress();
  updateState({
    ttsStatus: "loading",
    ttsProgressStage: "loading-tts-model",
    wasmDownloadActive: startAgg.active,
    wasmDownloadPercent: startAgg.percent,
  });
  wasmTtsProgressUnsub?.();
  wasmTtsProgressUnsub = client.subscribeProgress(
    (evt: WasmTtsProgressEvent) => {
      if (
        typeof evt.index === "number" &&
        typeof evt.total === "number" &&
        evt.total > 0
      ) {
        ttsProgressFraction = Math.min(
          0.98,
          Math.max(0.05, (evt.index + 0.5) / evt.total),
        );
      }
      const agg = computeAggregateWasmProgress();
      updateState({
        ttsProgressStage: evt.stage,
        wasmDownloadActive: agg.active,
        wasmDownloadPercent: agg.percent,
        wasmDownloadFile: agg.active
          ? (evt.file ?? state.wasmDownloadFile)
          : null,
      });
    },
  );
  const req = client
    .init({ gender: resolvedGender })
    .then(() => {
      ttsProgressFraction = 1;
      const agg = computeAggregateWasmProgress();
      updateState({
        ttsStatus: "ready",
        ttsProgressStage: "ready",
        wasmDownloadActive: agg.active,
        wasmDownloadPercent: agg.percent,
        wasmDownloadFile: agg.active ? state.wasmDownloadFile : null,
        readyAt: Date.now(),
      });
      recordWasmTtsBadgeIfOffline(resolvedGender);
      return true;
    })
    .catch(() => {
      ttsProgressFraction = null;
      const agg = computeAggregateWasmProgress();
      updateState({
        ttsProgressStage: "error",
        wasmDownloadActive: agg.active,
        wasmDownloadPercent: agg.percent,
        wasmDownloadFile: agg.active ? state.wasmDownloadFile : null,
      });
      return false;
    })
    .finally(() => {
      wasmTtsProgressUnsub?.();
      wasmTtsProgressUnsub = null;
      if (wasmTtsInitPromise === req && !client.isReady(resolvedGender)) {
        wasmTtsInitPromise = null;
      }
    });
  wasmTtsInitPromise = req;
  return req;
}

function isHostedBrowserOrigin(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.location?.hostname) &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
  );
}

function isLocalMockedSpeechHarness(): boolean {
  if (typeof window === "undefined" || isHostedBrowserOrigin()) {
    return false;
  }
  const win = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  return isInjectedTestSpeechRecognition(ctor);
}

/**
 * Returns true only when browser WASM Vietnamese TTS actually needs warmup:
 * never on native Android WebView, and never on localhost/E2E when local or
 * permitted cloud server TTS is already healthy.
 */
export function shouldWarmWasmTts(
  health: VoiceEngineHealthSnapshot | null = getFreshVoiceEngineHealth(),
): boolean {
  if (
    isAndroidNativeSpeechAvailable() ||
    isLocalMockedSpeechHarness() ||
    !detectBrowserWasmTtsSupport().supported
  ) {
    return false;
  }
  if (health) {
    return !hasLiveServerTts(health);
  }
  if (isPermanentlyHostedLocalUnconfigured(null)) {
    return true;
  }
  return isHostedBrowserOrigin();
}

export function warmWasmTtsIfNeeded(
  gender?: VoiceGender,
  health?: VoiceEngineHealthSnapshot | null,
): Promise<boolean> {
  const resolvedHealth =
    health === undefined ? getFreshVoiceEngineHealth() : health;
  if (!shouldWarmWasmTts(resolvedHealth)) {
    return Promise.resolve(false);
  }
  return startWasmTtsWarmup(gender);
}

function hasLiveServerTts(health: VoiceEngineHealthSnapshot | null): boolean {
  if (!health) return false;
  const policy = getVoicePolicyPreferences();
  const cloudTtsAllowed =
    policy.providerMode === "local_with_google_fallback" &&
    policy.allowGoogleTtsFallback;
  const localTtsReady = Boolean(
    health.local.available && health.local.tts_ready,
  );
  return Boolean(
    localTtsReady ||
    (cloudTtsAllowed &&
      health.elevenlabs?.tts_configured &&
      !health.elevenlabs.tts_cooldown) ||
    (cloudTtsAllowed &&
      health.google.tts_configured &&
      !health.google.tts_cooldown),
  );
}

function hasBackendTtsCueWarmupTarget(
  health: VoiceEngineHealthSnapshot | null,
): boolean {
  if (!health) return false;
  return Boolean(
    hasLiveServerTts(health) ||
    (health.elevenlabs?.tts_configured && !health.elevenlabs.tts_cooldown),
  );
}

async function warmInitialTtsCues(
  options: PreloadReadingVoiceOptions,
  health: VoiceEngineHealthSnapshot | null = getVoiceEngineHealthForRouting(),
): Promise<void> {
  if (options.warmTts === false) return;
  warmTtsAbortController?.abort();
  const controller = new AbortController();
  warmTtsAbortController = controller;
  const onPageHide = () => {
    controller.abort();
  };
  if (
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function"
  ) {
    window.addEventListener("pagehide", onPageHide, { once: true });
  }
  try {
    const activeLock = getActiveSessionVoiceLock();
    const policy = getVoicePolicyPreferences();
    const localTtsReady = Boolean(
      health?.local.available && health.local.tts_ready,
    );
    const googleTtsActive = Boolean(
      !localTtsReady &&
      !(
        health?.elevenlabs?.tts_configured && !health.elevenlabs.tts_cooldown
      ) &&
      policy.providerMode === "local_with_google_fallback" &&
      policy.allowGoogleTtsFallback &&
      health?.google.tts_configured &&
      !health.google.tts_cooldown,
    );
    const rawVoiceId = activeLock?.voiceId ?? getEffectiveVoiceId();
    const voiceId =
      googleTtsActive && !(rawVoiceId ?? "").startsWith("google_")
        ? mapLocalVoiceToGoogleBackup(
            rawVoiceId,
            activeLock?.region ?? policy.region,
          )
        : rawVoiceId;
    const speed = activeLock?.speed ?? getSpeechPreferences().speed;
    const speechService = createSpeechService();
    const cues: Array<{ text: string; wordSample: boolean }> = [
      { text: "Đến lượt con đọc nhé.", wordSample: false },
    ];
    const sampleWords = Array.from(
      new Set(
        (options.previewWords ?? [])
          .map((w) => normalizeVietnameseWord(w))
          .filter(Boolean),
      ),
    ).slice(0, 3);
    for (const word of sampleWords) {
      cues.push({ text: word, wordSample: true });
    }
    for (const cue of cues) {
      if (controller.signal.aborted) break;
      const key = `${voiceId}::${speed}::${cue.wordSample ? "w" : "c"}::${cue.text}`;
      if (prefetchedTtsKeys.has(key)) continue;
      prefetchedTtsKeys.add(key);
      try {
        await speechService.synthesize(cue.text, {
          voiceId,
          speed,
          wordSample: cue.wordSample,
          bookId: cue.wordSample ? (options.bookId ?? null) : null,
          pageId: cue.wordSample ? (options.pageId ?? null) : null,
          pageRevisionId: cue.wordSample
            ? (options.pageRevisionId ?? null)
            : null,
          isPrivateBook: cue.wordSample ? options.isPrivateBook : false,
          cacheScope: cue.wordSample
            ? options.isPrivateBook
              ? "PRIVATE"
              : "CATALOG"
            : "COACHING",
          bypassSessionLock: true,
          timeoutMs: 8_000,
          signal: controller.signal,
        });
      } catch {
        // Best-effort preload only; never block reading flow.
        prefetchedTtsKeys.delete(key);
        break;
      }
      if (controller.signal.aborted) break;
    }
  } finally {
    if (
      typeof window !== "undefined" &&
      typeof window.removeEventListener === "function"
    ) {
      window.removeEventListener("pagehide", onPageHide);
    }
    if (warmTtsAbortController === controller) {
      warmTtsAbortController = null;
    }
  }
}

/**
 * Idempotently preloads STT & TTS engines in parallel across Web, Mobile Web,
 * and Android WebView APK. Safe to call repeatedly on click ("Chuẩn bị đọc"),
 * on preparation mount, and on reading/practice screen mount.
 */
export function preloadReadingVoiceEngines(
  options: PreloadReadingVoiceOptions = {},
): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  warmAudioUnlockSafely();

  const now = Date.now();
  if (state.startedAt === null) {
    updateState({
      startedAt: now,
      sttStatus: state.sttStatus === "ready" ? "ready" : "loading",
      ttsStatus: state.ttsStatus === "ready" ? "ready" : "loading",
    });
  }

  // If already preloading, queue/trigger incremental TTS cue warmup for new
  // previewWords or voice/speed changes without restarting STT/health probing.
  if (activePreloadPromise) {
    if (options.warmTts !== false) {
      pendingTtsWarmOptions = options;
      const freshHealth = getFreshVoiceEngineHealth();
      if (hasBackendTtsCueWarmupTarget(freshHealth)) {
        void warmInitialTtsCues(options, freshHealth);
      }
    }
    return activePreloadPromise;
  }

  // Incremental warmup after an earlier preload completed: if health is fresh
  // and STT is already ready, warm any new previewWords or newly selected
  // voice/speed without resetting STT readiness.
  const existingFreshHealth = getFreshVoiceEngineHealth();
  if (existingFreshHealth && state.sttStatus === "ready") {
    if (
      options.warmTts !== false &&
      hasBackendTtsCueWarmupTarget(existingFreshHealth)
    ) {
      return warmInitialTtsCues(options, existingFreshHealth);
    }
    return Promise.resolve();
  }

  const run = async (): Promise<void> => {
    const isAndroid = isAndroidNativeSpeechAvailable();
    const isMockedLocalHarness = isLocalMockedSpeechHarness();
    const wasmSupported =
      !isAndroid &&
      !isMockedLocalHarness &&
      options.warmWasmStt !== false &&
      detectBrowserWasmSttSupport().supported;

    // Kick off independent warmups in parallel immediately:
    // 1. Auth token cache
    // 2. Backend /voice/status health (wakes Render Free backend early!)
    // 3. Android native capabilities (warms Android TextToSpeech + SpeechRecognizer)
    // 4. Browser SpeechSynthesis voice list population
    // 5. IndexedDB WASM cache check (if already cached, boot WASM worker immediately!)
    const tokenPromise = getBrowserAccessToken({
      onUnauthorized: () => new Error("unauthorized"),
    }).catch(() => null);
    const healthPromise = fetchVoiceEngineHealth().catch(() => null);
    const androidCapsPromise = isAndroid
      ? getAndroidSpeechCapabilities().catch(() => null)
      : Promise.resolve(null);
    const browserVoicesPromise = !isAndroid
      ? warmBrowserSpeechVoices()
      : Promise.resolve(false);

    const wasmTtsSupported =
      !isAndroid &&
      !isMockedLocalHarness &&
      options.warmTts !== false &&
      detectBrowserWasmTtsSupport().supported;
    const isHostedOrigin = isHostedBrowserOrigin();
    const initialHealth = getFreshVoiceEngineHealth();
    const initialUnconfigured =
      isPermanentlyHostedLocalUnconfigured(initialHealth);

    let earlyWasmStarted = false;
    if (wasmSupported) {
      if (
        initialUnconfigured ||
        (initialHealth && !initialHealth.local.stt_ready) ||
        isHostedOrigin
      ) {
        earlyWasmStarted = true;
        void startWasmSttWarmup();
      } else {
        void getWasmModelCacheStatus()
          .then((cacheStatus) => {
            if (cacheStatus.ready && !earlyWasmStarted) {
              const currentHealth = getFreshVoiceEngineHealth();
              if (!currentHealth || !currentHealth.local.stt_ready) {
                earlyWasmStarted = true;
                void startWasmSttWarmup();
              }
            }
          })
          .catch(() => undefined);
      }
    }

    let earlyWasmTtsStarted = false;
    if (wasmTtsSupported && shouldWarmWasmTts(initialHealth)) {
      earlyWasmTtsStarted = true;
      void startWasmTtsWarmup(resolveVoiceGender(getEffectiveVoiceId()));
    }

    const [, fetchedHealth, androidCaps] = await Promise.all([
      tokenPromise,
      healthPromise,
      androidCapsPromise,
      browserVoicesPromise,
    ]);
    const health = fetchedHealth ?? getFreshVoiceEngineHealth();

    const policy = getVoicePolicyPreferences();
    const localSttReady = Boolean(
      health?.local.available && health.local.stt_ready,
    );
    const sttAllowsCloud =
      policy.providerMode === "local_with_google_fallback" &&
      policy.allowGoogleSttFallback;
    const googleSttReady = Boolean(
      sttAllowsCloud &&
      health?.google.stt_configured &&
      !health.google.stt_cooldown,
    );

    // 1. STT Readiness (Strict Offline-First: Local Worker -> Android Native /
    // Browser WASM -> Cloud Google / Browser Web Speech ONLY as last resort)
    if (localSttReady) {
      updateState({
        sttStatus: "ready",
        sttEngineLabel: "Offline",
        sttProgressStage: "ready",
      });
    } else if (isAndroid && (androidCaps?.sttAvailable ?? true)) {
      updateState({
        sttStatus: "ready",
        sttEngineLabel: "Android Native",
        sttProgressStage: "ready",
      });
    } else if (wasmSupported) {
      earlyWasmStarted = true;
      await startWasmSttWarmup();
    } else {
      updateState({
        sttStatus: "ready",
        sttEngineLabel: googleSttReady ? "Google STT" : "Trình duyệt",
        sttProgressStage: "ready",
      });
    }

    // 2. TTS Readiness
    const queuedTtsOptions = pendingTtsWarmOptions;
    pendingTtsWarmOptions = null;
    if (hasBackendTtsCueWarmupTarget(health)) {
      const mergedTtsOptions =
        queuedTtsOptions && queuedTtsOptions !== options
          ? {
              ...options,
              ...queuedTtsOptions,
              previewWords:
                queuedTtsOptions.previewWords ?? options.previewWords,
            }
          : options;
      void warmInitialTtsCues(mergedTtsOptions, health);
    }
    if (hasLiveServerTts(health)) {
      updateState({ ttsStatus: "ready", readyAt: Date.now() });
    } else if (wasmTtsSupported) {
      earlyWasmTtsStarted = true;
      void startWasmTtsWarmup(resolveVoiceGender(getEffectiveVoiceId())).then(
        () => {
          updateState({ ttsStatus: "ready", readyAt: Date.now() });
        },
      );
      if (
        getBrowserWasmTtsClient().isReady(
          resolveVoiceGender(getEffectiveVoiceId()),
        )
      ) {
        updateState({ ttsStatus: "ready", readyAt: Date.now() });
      }
    } else {
      // Hosted on-device TTS (Android Native or Browser SpeechSynthesis):
      // already warmed via getAndroidSpeechCapabilities() / warmBrowserSpeechVoices().
      updateState({ ttsStatus: "ready", readyAt: Date.now() });
    }
    void earlyWasmTtsStarted;
  };

  activePreloadPromise = run().finally(() => {
    activePreloadPromise = null;
  });
  return activePreloadPromise;
}

/**
 * Called right before opening the microphone in ReadingScreen / PracticePanel:
 * if Browser WASM STT is the selected engine and is still finishing its preload,
 * waits briefly (bounded to <= 1_500ms) so the child's first spoken words are
 * not dropped during WASM initialization without ever stalling the mic start.
 */
export async function awaitSttReadyBeforeListening(
  maxWaitMs = 1_500,
): Promise<boolean> {
  if (typeof window === "undefined") return true;
  if (isAndroidNativeSpeechAvailable()) {
    await getAndroidSpeechCapabilities().catch(() => null);
    return true;
  }
  const startedAt = Date.now();
  let health = getVoiceEngineHealthForRouting();
  const permanentlyUnconfigured = isPermanentlyHostedLocalUnconfigured(health);
  if (
    !permanentlyUnconfigured &&
    health?.local.available &&
    health.local.stt_ready
  ) {
    return true;
  }
  if (!health && !permanentlyUnconfigured && maxWaitMs > 0) {
    const healthBudgetMs = Math.min(1_200, maxWaitMs);
    health = await new Promise<VoiceEngineHealthSnapshot | null>((resolve) => {
      let settled = false;
      const finish = (snap: VoiceEngineHealthSnapshot | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(snap);
      };
      const timer = window.setTimeout(() => finish(null), healthBudgetMs);
      fetchVoiceEngineHealth().then(
        (snap) => finish(snap),
        () => finish(null),
      );
    });
  }
  if (
    !permanentlyUnconfigured &&
    health?.local.available &&
    health.local.stt_ready
  ) {
    return true;
  }
  if (!detectBrowserWasmSttSupport().supported) {
    return true;
  }
  const wasmClient = getBrowserWasmSttClient();
  if (wasmClient.isReady()) {
    return true;
  }
  const pending = wasmInitPromise ?? startWasmSttWarmup();
  const remainingWaitMs = Math.min(
    1_500,
    Math.max(0, maxWaitMs - (Date.now() - startedAt)),
  );
  if (remainingWaitMs <= 0) return wasmClient.isReady();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(ok);
    };
    const timer = window.setTimeout(
      () => finish(wasmClient.isReady()),
      remainingWaitMs,
    );
    pending.then(
      (ok) => finish(ok),
      () => finish(false),
    );
  });
}

export async function awaitVoiceEnginesReadyBeforeListening(
  maxWaitMs = 2_800,
): Promise<{ readonly sttReady: boolean; readonly ttsReady: boolean }> {
  if (typeof window === "undefined") {
    return { sttReady: true, ttsReady: true };
  }
  if (isAndroidNativeSpeechAvailable()) {
    await getAndroidSpeechCapabilities().catch(() => null);
    return { sttReady: true, ttsReady: true };
  }
  const health = getFreshVoiceEngineHealth();
  const needWasmTts =
    detectBrowserWasmTtsSupport().supported &&
    (!health ||
      !hasLiveServerTts(health) ||
      isPermanentlyHostedLocalUnconfigured(health));
  const gender = resolveVoiceGender(getEffectiveVoiceId());
  const ttsPromise: Promise<boolean> = needWasmTts
    ? new Promise<boolean>((resolve) => {
        const client = getBrowserWasmTtsClient();
        if (client.isReady(gender)) {
          resolve(true);
          return;
        }
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(ok);
        };
        const timer = window.setTimeout(
          () => finish(client.isReady(gender)),
          maxWaitMs,
        );
        startWasmTtsWarmup(gender).then(
          (ok) => finish(ok),
          () => finish(false),
        );
      })
    : Promise.resolve(true);

  const [sttReady, ttsReady] = await Promise.all([
    awaitSttReadyBeforeListening(maxWaitMs),
    ttsPromise,
  ]);
  return { sttReady, ttsReady };
}

export function shouldPreferWarmWasmBatchStt(): boolean {
  if (
    isAndroidNativeSpeechAvailable() ||
    !detectBrowserWasmSttSupport().supported ||
    !getBrowserWasmSttClient().isReady()
  ) {
    return false;
  }
  const health = getFreshVoiceEngineHealth();
  const permanentlyUnconfigured = isPermanentlyHostedLocalUnconfigured(health);
  if (!permanentlyUnconfigured) {
    if (!health) return false;
    if (health.local.available && health.local.stt_ready) return false;
  }
  const policy = getVoicePolicyPreferences();
  const cloudAllowed =
    policy.providerMode === "local_with_google_fallback" &&
    policy.allowGoogleSttFallback;
  const liveCloudStt = Boolean(
    cloudAllowed &&
    ((health?.google.stt_configured && !health.google.stt_cooldown) ||
      (health?.elevenlabs?.stt_configured && !health.elevenlabs.stt_cooldown)),
  );
  return !liveCloudStt;
}

export function resetVoicePreloaderForTests(): void {
  state = INITIAL_STATE;
  activePreloadPromise = null;
  wasmInitPromise = null;
  wasmTtsInitPromise = null;
  wasmTtsWarmGender = null;
  wasmProgressUnsub?.();
  wasmProgressUnsub = null;
  wasmTtsProgressUnsub?.();
  wasmTtsProgressUnsub = null;
  sttProgressFraction = null;
  ttsProgressFraction = null;
  pendingTtsWarmOptions = null;
  warmTtsAbortController?.abort();
  warmTtsAbortController = null;
  prefetchedTtsKeys.clear();
}
