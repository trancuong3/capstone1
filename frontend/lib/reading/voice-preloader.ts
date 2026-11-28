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
} from "@/lib/reading/browser-wasm-tts";
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
  isPermanentlyHostedLocalUnconfigured,
  mapLocalVoiceToGoogleBackup,
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

function updateState(patch: Partial<VoicePreloadState>): void {
  const next: VoicePreloadState = { ...state, ...patch };
  if (
    next.sttStatus === state.sttStatus &&
    next.ttsStatus === state.ttsStatus &&
    next.sttEngineLabel === state.sttEngineLabel &&
    next.sttProgressStage === state.sttProgressStage &&
    next.startedAt === state.startedAt &&
    next.readyAt === state.readyAt
  ) {
    return;
  }
  state = next;
  listeners.forEach((fn) => fn());
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
    updateState({
      sttStatus: "ready",
      sttEngineLabel: "Offline (WASM)",
      sttProgressStage: "ready",
    });
    return Promise.resolve(true);
  }
  if (wasmInitPromise) {
    return wasmInitPromise;
  }
  updateState({
    sttStatus: "loading",
    sttEngineLabel: "Offline (WASM)",
    sttProgressStage: "loading",
  });
  wasmProgressUnsub?.();
  wasmProgressUnsub = wasmClient.subscribeProgress(
    (evt: WasmSttProgressEvent) => {
      updateState({
        sttStatus: evt.stage === "ready" ? "ready" : "loading",
        sttEngineLabel: "Offline (WASM)",
        sttProgressStage: evt.stage,
      });
    },
  );
  wasmInitPromise = wasmClient
    .init()
    .then(() => {
      updateState({
        sttStatus: "ready",
        sttEngineLabel: "Offline (WASM)",
        sttProgressStage: "ready",
      });
      return true;
    })
    .catch(() => {
      updateState({
        sttStatus: "degraded",
        sttProgressStage: "error",
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
    return Promise.resolve(true);
  }
  if (wasmTtsInitPromise && wasmTtsWarmGender === resolvedGender) {
    return wasmTtsInitPromise;
  }
  wasmTtsWarmGender = resolvedGender;
  const req = client
    .init({ gender: resolvedGender })
    .then(() => true)
    .catch(() => false)
    .finally(() => {
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

async function warmInitialTtsCues(
  options: PreloadReadingVoiceOptions,
  health: VoiceEngineHealthSnapshot | null = getFreshVoiceEngineHealth(),
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
      if (hasLiveServerTts(freshHealth)) {
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
    if (options.warmTts !== false && hasLiveServerTts(existingFreshHealth)) {
      return warmInitialTtsCues(options, existingFreshHealth);
    }
    return Promise.resolve();
  }

  const run = async (): Promise<void> => {
    const isAndroid = isAndroidNativeSpeechAvailable();
    const wasmSupported =
      !isAndroid &&
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
    if (hasLiveServerTts(health)) {
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
 * waits briefly (bounded by `maxWaitMs`) so the child's first spoken words are
 * NEVER dropped during WASM initialization.
 */
export async function awaitSttReadyBeforeListening(
  maxWaitMs = 5_000,
): Promise<boolean> {
  if (typeof window === "undefined") return true;
  if (isAndroidNativeSpeechAvailable()) {
    await getAndroidSpeechCapabilities().catch(() => null);
    return true;
  }
  const startedAt = Date.now();
  let health = getFreshVoiceEngineHealth();
  const permanentlyUnconfigured = isPermanentlyHostedLocalUnconfigured(health);
  if (!health && !permanentlyUnconfigured && maxWaitMs > 0) {
    const healthBudgetMs = Math.min(1_500, maxWaitMs);
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
  const remainingWaitMs = Math.max(0, maxWaitMs - (Date.now() - startedAt));
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

export function resetVoicePreloaderForTests(): void {
  state = INITIAL_STATE;
  activePreloadPromise = null;
  wasmInitPromise = null;
  wasmTtsInitPromise = null;
  wasmTtsWarmGender = null;
  wasmProgressUnsub?.();
  wasmProgressUnsub = null;
  pendingTtsWarmOptions = null;
  warmTtsAbortController?.abort();
  warmTtsAbortController = null;
  prefetchedTtsKeys.clear();
}
